#!/usr/bin/env python3
"""Reading-space vocab enrichment, run in the background on the box.

Slowly fills in everything a saved vocab word still lacks, so the vocab
library (reading-space page + Word Atlas 生词本) ends up complete:
  1. legacy backfill: vocab.sentence rows get a vocab_contexts row
  2. missing 释义 (translation) for a word  -> zh5 three-line dictionary call
  3. missing sentence_zh for a context    -> sentence translation
  4. missing uk_ipa / us_ipa for a word   -> one dual-IPA call
  5. missing sentence audio (uk + us)     -> edge-tts into sentence_audio

Translations reuse the worker's own cache table (hash "zh5|" + text), so a
sentence enriched here is a cache hit when the reader taps it later, and
vice versa. Models: free OpenRouter first, DeepSeek flash last (same chain
as the worker). Each run takes only a small batch; a scheduler re-runs it
every ~10 minutes. Idempotent; safe to run any time.

Run with the word-atlas venv python (it has edge_tts):
  /data/work/word-atlas-g7/venv/bin/python enrich_vocab.py
"""
import asyncio
import fcntl
import hashlib
import json
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path("/data/work/readspace")
DB = (HERE / ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/"
      "9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite")
DEV_VARS = HERE / ".dev.vars"

MODELS = ["nvidia/nemotron-3-ultra-550b-a55b:free",
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
          "~deepseek/deepseek-flash-latest"]

WORD_SYS = ("英汉词典。只输出三行，不要思考过程、不要步骤、不要 Markdown、不要加粗。"
            "第一行：「/国际音标/ 词性 中文释义」，音标两侧必须加斜杠，例如 /ˈmɪərkæt/ n. 猫鼬；"
            "第二行：一句简短英文例句；第三行：第二行例句的中文翻译。中文释义不超过 40 字。")
SENT_SYS = ("英汉词典。直接给出最终答案，不要思考过程、不要步骤、不要 Markdown。"
            "词组：第一行写词性 + 中文释义，第二行给一句简短英文例句，第三行给例句的中文翻译；"
            "句子：只给译文。中文不超过 60 字。")
IPA_SYS = ("英汉词典。只输出一行，不要解释、不要 Markdown，格式严格如下："
           "UK: /英式音标/ US: /美式音标/")

BATCH_DEF, BATCH_ZH, BATCH_IPA, BATCH_AUDIO = 3, 4, 3, 4


def openrouter_key():
    for line in DEV_VARS.read_text(encoding="utf-8").splitlines():
        if line.startswith("OPENROUTER_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


KEY = openrouter_key()


def llm(sys_prompt, user_text, max_tokens=500, need_zh=True):
    """First usable answer from the model chain, else "".

    need_zh guards against reasoning junk for translation calls; IPA answers
    contain no Chinese at all, so they must opt out of that check.
    """
    if not KEY:
        return ""
    for model in MODELS:
        body = {"model": model,
                "messages": [{"role": "system", "content": sys_prompt},
                             {"role": "user", "content": user_text}],
                "max_tokens": max_tokens, "temperature": 0,
                "reasoning": {"exclude": True}}
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json",
                     "authorization": "Bearer " + KEY,
                     "X-Title": "reading-space-enrich"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                j = json.loads(r.read().decode())
            got = (((j.get("choices") or [{}])[0].get("message") or {})
                   .get("content") or "").strip()
            got = re.sub(r"```[a-z]*|```", "", got).replace("**", "").strip()
            if got and (not need_zh or re.search(r"[\u4e00-\u9fa5]", got)):
                return got
        except Exception as ex:
            print(f"  llm {model} failed: {ex}", flush=True)
    return ""


def zh5(text):
    return hashlib.sha256(("zh5|" + text).encode()).hexdigest()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def cached(conn, text):
    row = conn.execute("SELECT dst FROM translations WHERE hash = ?",
                       (zh5(text),)).fetchone()
    return row[0] if row and row[0] else ""


def cache_put(conn, text, dst, model="enrich"):
    conn.execute("INSERT OR REPLACE INTO translations (hash, src, dst, model, created_at) "
                 "VALUES (?,?,?,?,?)", (zh5(text), text[:300], dst[:1200], model, int(time.time() * 1000)))


def translate(conn, text, is_word):
    hit = cached(conn, text)
    if hit:
        return hit
    out = llm(WORD_SYS if is_word else SENT_SYS, text, 500 if is_word else 300)
    if out:
        cache_put(conn, text, out)
    return out


def is_single_word(t):
    s = (t or "").strip()
    return bool(s) and len(s) <= 28 and re.fullmatch(r"[A-Za-z][A-Za-z'’\-]*", s) is not None


async def tts(sentence, voice):
    import edge_tts
    import tempfile, os
    fd, path = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        await edge_tts.Communicate(sentence, voice).save(path)
        data = Path(path).read_bytes()
        return data if len(data) > 800 else b""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    lock = open("/tmp/enrich_vocab.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another run in progress, skip", flush=True)
        return
    if not DB.exists():
        print("db not found", flush=True)
        return
    conn = sqlite3.connect(str(DB), timeout=15)
    conn.row_factory = sqlite3.Row
    # The worker creates these lazily too; whoever runs first wins, and the
    # scheduler may well beat the first vocab request after a fresh deploy.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS vocab_contexts ("
        "user TEXT NOT NULL, word TEXT NOT NULL, book TEXT NOT NULL, sentence TEXT NOT NULL, "
        "sentence_zh TEXT, first_at INTEGER, last_at INTEGER, hits INTEGER NOT NULL DEFAULT 1, "
        "PRIMARY KEY (user, word, book, sentence))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sentence_audio ("
        "hash TEXT NOT NULL, accent TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER, "
        "PRIMARY KEY (hash, accent))")
    conn.commit()
    done = []

    # 1) legacy backfill: vocab.sentence -> contexts
    try:
        n = conn.execute(
            "INSERT OR IGNORE INTO vocab_contexts (user, word, book, sentence, sentence_zh, first_at, last_at, hits) "
            "SELECT user, word, book, sentence, sentence_zh, first_at, last_at, 1 FROM vocab "
            "WHERE sentence IS NOT NULL AND sentence != ''").rowcount
        conn.commit()
        if n:
            done.append(f"backfill contexts {n}")
    except Exception as ex:
        print(f"backfill failed: {ex}", flush=True)

    # 1b) legacy rows: translation still holds the old multi-line format
    #     (def / example / example-zh on separate lines) -> split it into
    #     the dedicated columns so every consumer sees a clean definition.
    try:
        rows = conn.execute(
            "SELECT user, word, book, translation, example, example_zh FROM vocab "
            "WHERE translation LIKE '%\n%' LIMIT 20").fetchall()
        for r in rows:
            parts = [x.strip() for x in (r["translation"] or "").split("\n") if x.strip()]
            if not parts:
                continue
            with conn:
                conn.execute(
                    "UPDATE vocab SET translation = ? WHERE user = ? AND word = ? AND book = ?",
                    (parts[0], r["user"], r["word"], r["book"]))
                if len(parts) >= 2 and not r["example"]:
                    conn.execute(
                        "UPDATE vocab SET example = ? WHERE user = ? AND word = ? AND book = ?",
                        (parts[1], r["user"], r["word"], r["book"]))
                if len(parts) >= 3 and not r["example_zh"]:
                    conn.execute(
                        "UPDATE vocab SET example_zh = ? WHERE user = ? AND word = ? AND book = ?",
                        (parts[2], r["user"], r["word"], r["book"]))
            done.append(f"split {r['word']}")
    except Exception as ex:
        print(f"split failed: {ex}", flush=True)

    # 2) missing definitions
    rows = conn.execute(
        "SELECT user, word, book FROM vocab WHERE translation IS NULL OR translation = '' "
        "LIMIT ?", (BATCH_DEF,)).fetchall()
    for r in rows:
        out = translate(conn, r["word"], is_single_word(r["word"]))
        if not out:
            continue
        lines = [x.strip() for x in out.split("\n") if x.strip()]
        with conn:
            conn.execute(
                "UPDATE vocab SET translation = ? WHERE user = ? AND word = ? AND book = ?",
                (lines[0] if lines else out, r["user"], r["word"], r["book"]))
            if len(lines) >= 2:
                conn.execute(
                    "UPDATE vocab SET example = ? WHERE user = ? AND word = ? AND book = ? "
                    "AND (example IS NULL OR example = '')",
                    (lines[1], r["user"], r["word"], r["book"]))
            if len(lines) >= 3:
                conn.execute(
                    "UPDATE vocab SET example_zh = ? WHERE user = ? AND word = ? AND book = ? "
                    "AND (example_zh IS NULL OR example_zh = '')",
                    (lines[2], r["user"], r["word"], r["book"]))
        done.append(f"def {r['word']}")

    # 3) missing context translations
    rows = conn.execute(
        "SELECT user, word, book, sentence FROM vocab_contexts "
        "WHERE sentence_zh IS NULL OR sentence_zh = '' LIMIT ?", (BATCH_ZH,)).fetchall()
    for r in rows:
        out = translate(conn, r["sentence"], False)
        if not out:
            continue
        with conn:
            conn.execute(
                "UPDATE vocab_contexts SET sentence_zh = ? WHERE user = ? AND word = ? AND book = ? AND sentence = ?",
                (out, r["user"], r["word"], r["book"], r["sentence"]))
        done.append(f"ctx-zh {r['word']}")

    # 4) missing dual IPA
    rows = conn.execute(
        "SELECT DISTINCT word FROM vocab WHERE (uk_ipa IS NULL OR uk_ipa = '' OR us_ipa IS NULL OR us_ipa = '') "
        "LIMIT ?", (BATCH_IPA,)).fetchall()
    for r in rows:
        out = llm(IPA_SYS, r["word"], 120, need_zh=False)
        ipas = re.findall(r"/([^/\n]{1,40})/", out or "")
        if len(ipas) >= 2:
            uk, us = "/" + ipas[0] + "/", "/" + ipas[1] + "/"
        elif len(ipas) == 1:
            uk, us = "/" + ipas[0] + "/", None
        else:
            continue
        with conn:
            if us:
                conn.execute("UPDATE vocab SET uk_ipa = ?, us_ipa = ? WHERE word = ?",
                             (uk, us, r["word"]))
            else:
                conn.execute("UPDATE vocab SET uk_ipa = ? WHERE word = ? AND (uk_ipa IS NULL OR uk_ipa = '')",
                             (uk, r["word"]))
        done.append(f"ipa {r['word']}")

    # 5) missing sentence audio
    rows = conn.execute("SELECT DISTINCT sentence FROM vocab_contexts LIMIT 200").fetchall()
    made = 0
    for r in rows:
        if made >= BATCH_AUDIO:
            break
        s = r["sentence"]
        if not s or len(s) > 400:
            continue
        h = sha(s)
        have = {x[0] for x in conn.execute(
            "SELECT accent FROM sentence_audio WHERE hash = ?", (h,)).fetchall()}
        for accent, voice in (("uk", "en-GB-SoniaNeural"), ("us", "en-US-AriaNeural")):
            if accent in have:
                continue
            try:
                data = asyncio.run(tts(s, voice))
            except Exception as ex:
                print(f"  tts failed ({accent}): {ex}", flush=True)
                data = b""
            if data:
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO sentence_audio (hash, accent, data, created_at) VALUES (?,?,?,?)",
                        (h, accent, data, int(time.time() * 1000)))
                made += 1
                done.append(f"audio {accent} {s[:24]}")
    conn.close()
    print(time.strftime("%F %T"), "done:", "; ".join(done) if done else "nothing pending", flush=True)


if __name__ == "__main__":
    main()
