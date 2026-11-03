#!/usr/bin/env python3
"""Reading-space cache prewarm, run in the background on the box.

For every book that has no finished prewarm, slowly build its cache index:
words beyond the common 800 (google-10000 frequency list), excluding
proper nouns (only ever capitalized) and fragments. For each target word,
the global word store gets its dictionary entry (meaning + IPA line +
example), the sentence cache gets the translation of the word's first
sentence in the book, and book_words records word -> first sentence.

After this, tapping the word while reading is a pure cache hit. Batches
are small and resumable (progress lives in book_prewarm / book_words);
the scheduler re-runs this every ~10 minutes, same as enrich_vocab.py.

Run with the word-atlas venv python:
  /data/work/word-atlas-g7/venv/bin/python prewarm_books.py
"""
import fcntl
import html as htmlmod
import io
import re
import sqlite3
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, "/data/work/readspace")
import enrich_vocab as E  # llm/translate/cache helpers + DB path

HERE = Path("/data/work/readspace")
WORDLIST = HERE / "tools" / "google-10000.txt"
BATCH_WORDS = 60
TIMEBOX_S = 400

DDL = [
    "CREATE TABLE IF NOT EXISTS word_store ("
    "word TEXT PRIMARY KEY, def TEXT, example TEXT, example_zh TEXT, "
    "uk_ipa TEXT, us_ipa TEXT, senses TEXT, updated_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS book_words ("
    "book TEXT NOT NULL, word TEXT NOT NULL, sentence TEXT, "
    "PRIMARY KEY (book, word, sentence))",
    "CREATE TABLE IF NOT EXISTS book_prewarm ("
    "book TEXT PRIMARY KEY, total INTEGER, done INTEGER, status TEXT, updated_at INTEGER)",
]


def top800():
    words = [w.strip() for w in WORDLIST.read_text(encoding="utf-8").splitlines() if w.strip()]
    return set(words[:800])


def book_bytes(conn, book):
    rows = conn.execute("SELECT data FROM book_chunks WHERE book_id = ? ORDER BY seq",
                        (book,)).fetchall()
    return b"".join(r[0] for r in rows)


def extract_text(conn, book, fmt):
    raw = book_bytes(conn, book)
    if fmt == "epub":
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except Exception:
            return ""
        parts = []
        for name in sorted(zf.namelist()):
            if not re.search(r"\.(x?html?|xml)$", name, re.I):
                continue
            if re.search(r"(toc|nav|cover|copyright)", name, re.I):
                continue
            try:
                doc = zf.read(name).decode("utf-8", "ignore")
            except Exception:
                continue
            doc = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", doc)
            doc = re.sub(r"(?s)<[^>]+>", " ", doc)
            parts.append(htmlmod.unescape(doc))
        return " ".join(parts)
    if fmt == "pdf":
        try:
            import fitz
        except Exception:
            return None  # caller marks skip-pdf
        doc = fitz.open(stream=raw, filetype="pdf")
        return " ".join(page.get_text() for page in doc)
    return ""


def split_sentences(text):
    text = re.sub(r"\s+", " ", text)
    pieces = re.split(r"(?<=[.!?…])[\"'”’)]?\s+", text)
    return [p.strip() for p in pieces if 8 <= len(p.strip()) <= 400]


def target_words(text, common):
    """lowercase word -> first-occurrence index, beyond-common-800 only."""
    total = {}
    capped = {}
    first = {}
    for i, m in enumerate(re.finditer(r"[A-Za-z]+(?:'[A-Za-z]+)?", text)):
        form = m.group(0)
        w = form.lower()
        if w.endswith("'s"):
            w = w[:-2]
        w = w.strip("'")
        if len(w) < 3 or not w.isalpha():
            continue
        total[w] = total.get(w, 0) + 1
        if form[0].isupper():
            capped[w] = capped.get(w, 0) + 1
        if w not in first:
            first[w] = i
    out = [w for w in total
           if w not in common and capped.get(w, 0) < total[w]]
    out.sort(key=lambda w: first[w])
    return out


def first_sentence(sentences, word):
    got = first_sentences(sentences, word, 1)
    return got[0] if got else ""


def first_sentences(sentences, word, limit=3):
    """Up to `limit` distinct sentences containing the word (the cache
    library keeps several contexts per word, each translated)."""
    pat = re.compile(r"\b" + re.escape(word) + r"(?:'s)?\b", re.I)
    out = []
    for s in sentences:
        if pat.search(s) and s not in out:
            out.append(s)
            if len(out) >= limit:
                break
    return out


def seed_store_from_text(conn, word, text3):
    lines = [x.strip() for x in (text3 or "").split("\n") if x.strip()]
    if not lines:
        return False
    conn.execute(
        "INSERT INTO word_store (word, def, example, example_zh, updated_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(word) DO UPDATE SET "
        "def = COALESCE(NULLIF(word_store.def,''), excluded.def), "
        "example = COALESCE(NULLIF(word_store.example,''), excluded.example), "
        "example_zh = COALESCE(NULLIF(word_store.example_zh,''), excluded.example_zh), "
        "updated_at = excluded.updated_at",
        (word, lines[0], lines[1] if len(lines) > 1 else "",
         lines[2] if len(lines) > 2 else "", int(time.time() * 1000)))
    conn.commit()
    return True


def main():
    lock = open("/tmp/prewarm_books.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another run in progress, skip", flush=True)
        return
    if not E.DB.exists() or not WORDLIST.exists():
        print("db or wordlist missing", flush=True)
        return
    conn = sqlite3.connect(str(E.DB), timeout=15)
    conn.row_factory = sqlite3.Row
    for ddl in DDL:
        conn.execute(ddl)
    try:
        conn.execute("ALTER TABLE word_store ADD COLUMN senses TEXT")
    except Exception:
        pass
    # book_words used to key one sentence per (book, word); the cache now
    # keeps up to 3 sentences per word, so the PK grew a sentence column.
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'book_words'").fetchone()
    if row and "PRIMARY KEY (book, word))" in (row[0] or ""):
        conn.execute("ALTER TABLE book_words RENAME TO book_words_mig")
        conn.execute(DDL[1])
        conn.execute("INSERT OR IGNORE INTO book_words (book, word, sentence) SELECT book, word, sentence FROM book_words_mig")
        conn.execute("DROP TABLE book_words_mig")
    conn.commit()
    common = top800()
    started = time.time()
    budget = [BATCH_WORDS]  # model-call words left for this whole run
    books = conn.execute("SELECT id, format FROM books ORDER BY created_at DESC").fetchall()
    for b in books:
        if time.time() - started > TIMEBOX_S:
            break
        book, fmt = b["id"], b["format"]
        prog = conn.execute("SELECT * FROM book_prewarm WHERE book = ?", (book,)).fetchone()
        if prog and prog["status"] in ("complete", "skip-pdf"):
            continue
        text = extract_text(conn, book, fmt)
        if text is None:
            conn.execute("INSERT OR REPLACE INTO book_prewarm (book, total, done, status, updated_at) "
                         "VALUES (?,?,?, 'skip-pdf', ?)", (book, 0, 0, int(time.time() * 1000)))
            conn.commit()
            print(f"{book[:8]}: skip-pdf (no fitz)", flush=True)
            continue
        if not text:
            continue
        targets = target_words(text, common)
        done_words = {r[0] for r in conn.execute(
            "SELECT word FROM book_words WHERE book = ?", (book,)).fetchall()}
        todo = [w for w in targets if w not in done_words]
        conn.execute(
            "INSERT OR REPLACE INTO book_prewarm (book, total, done, status, updated_at) VALUES (?,?,?,?,?)",
            (book, len(targets), len(done_words),
             "complete" if not todo else "running", int(time.time() * 1000)))
        conn.commit()
        if not todo:
            print(f"{book[:8]}: complete ({len(targets)} words)", flush=True)
            continue
        sentences = split_sentences(text)
        made = 0
        for w in todo:
            if time.time() - started > TIMEBOX_S:
                break
            # Prewarm is FREE-MODELS-ONLY (user rule): every lookup below
            # goes through E.word_entry_free / E.translate_free, which
            # never touch the paid fallback.
            store = conn.execute("SELECT def FROM word_store WHERE word = ?", (w,)).fetchone()
            sents = first_sentences(sentences, w, 3)
            uncached = [s for s in sents if not E.cached(conn, s)]
            costly = not (store and store["def"]) or bool(uncached)
            if costly and budget[0] <= 0:
                break
            if costly:
                budget[0] -= 1
            if not (store and store["def"]):
                entry, _used = E.word_entry_free(conn, w, timeout=20)
                if entry:
                    E.seed_store_full(conn, w, entry)
                    if not entry.get("us_ipa"):
                        pair = E.ipa_from_structured(E.STRICT_FREE_MODEL, w, timeout=20) \
                            or E.ipa_from_structured(E.STRICT_FREE_MODEL2, w, timeout=20)
                        if pair:
                            with conn:
                                conn.execute(
                                    "UPDATE word_store SET uk_ipa = COALESCE(NULLIF(uk_ipa,''), ?), "
                                    "us_ipa = COALESCE(NULLIF(us_ipa,''), ?) WHERE word = ?",
                                    (pair[0], pair[1], w))
            for s in uncached:
                E.translate_free(conn, s, False, timeout=20)
            have = conn.execute("SELECT def FROM word_store WHERE word = ?", (w,)).fetchone()
            if not (have and have["def"]):
                continue  # no definition yet; leave the word for a later run
            with conn:
                for s in (sents or [""]):
                    conn.execute("INSERT OR IGNORE INTO book_words (book, word, sentence) VALUES (?,?,?)",
                                 (book, w, s))
            made += 1
        done_now = conn.execute("SELECT COUNT(DISTINCT word) FROM book_words WHERE book = ?",
                                (book,)).fetchone()[0]
        status = "complete" if done_now >= len(targets) else "running"
        conn.execute("UPDATE book_prewarm SET done = ?, status = ?, updated_at = ? WHERE book = ?",
                     (done_now, status, int(time.time() * 1000), book))
        conn.commit()
        print(f"{book[:8]}: {done_now}/{len(targets)} ({status})", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
