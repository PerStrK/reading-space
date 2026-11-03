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

# Structured Outputs (strict JSON schema): only some models support it
# (verified 2026-11-03: dots-3-note free, super-vl free and DeepSeek flash
# do; ultra / nano return 404 when require_parameters is set). The free
# strict models are flaky (frequent empty answers; dots hits roughly half
# the time, super-vl less), so strict is only ever an opportunistic first
# attempt. Results are validated field by field and reassembled into the
# same three-line text the soft chain produces, so caches and consumers
# see no format change.
STRICT_FREE_MODEL = "dots-studio/dots-3-note-preview:free"
STRICT_FREE_MODEL2 = "nvidia/nemotron-3.5-super-vl:free"
WORD_SCHEMA = {"type": "object",
               "properties": {
                   "ipa": {"type": "string", "description": "IPA wrapped in slashes, e.g. /ˈmɪərkæt/"},
                   "pos": {"type": "string", "description": "Part of speech, e.g. n. / v. / adj."},
                   "def_zh": {"type": "string", "description": "Chinese meaning, <= 40 chars"},
                   "example_en": {"type": "string", "description": "One short English example sentence"},
                   "example_zh": {"type": "string", "description": "Chinese translation of the example"}},
               "required": ["ipa", "pos", "def_zh", "example_en", "example_zh"],
               "additionalProperties": False}
SENT_SCHEMA = {"type": "object",
               "properties": {"translation_zh": {"type": "string", "description": "Chinese translation of the whole sentence"}},
               "required": ["translation_zh"],
               "additionalProperties": False}
IPA_SCHEMA = {"type": "object",
              "properties": {
                  "uk_ipa": {"type": "string", "description": "British IPA wrapped in slashes"},
                  "us_ipa": {"type": "string", "description": "American IPA wrapped in slashes"}},
              "required": ["uk_ipa", "us_ipa"],
              "additionalProperties": False}

WORD2_SCHEMA = {"type": "object",
                "properties": {
                    "uk_ipa": {"type": "string", "description": "British IPA wrapped in slashes"},
                    "us_ipa": {"type": "string", "description": "American IPA wrapped in slashes"},
                    "senses_text": {"type": "string", "description": "Up to 3 most common senses, separated by Chinese semicolons. Each sense: POS abbreviation + Chinese meaning + ' | ' + ONE SHORT SIMPLE English example for THAT sense (<=12 everyday words) + ' | ' + its Chinese translation, e.g. 'n. \u9b54\u6756 | The witch waves her wand. | \u5973\u5deb\u6325\u821e\u5979\u7684\u9b54\u6756'"},
                    "example_en": {"type": "string", "description": "One short English example sentence"},
                    "example_zh": {"type": "string", "description": "Chinese translation of the example"}},
                "required": ["uk_ipa", "us_ipa", "senses_text", "example_en", "example_zh"],
                "additionalProperties": False}
# NOTE: flat fields on purpose -- DeepSeek's structured endpoint returns
# empty content for nested-array schemas (verified 2026-11-03), while the
# flat senses_text form answers reliably; it is split locally.

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


def llm(sys_prompt, user_text, max_tokens=500, need_zh=True, timeout=45, models=None):
    """First usable answer from the model chain, else "".

    need_zh guards against reasoning junk for translation calls; IPA answers
    contain no Chinese at all, so they must opt out of that check.
    """
    if not KEY:
        return ""
    for model in (models or MODELS):
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
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.loads(r.read().decode())
            got = (((j.get("choices") or [{}])[0].get("message") or {})
                   .get("content") or "").strip()
            got = re.sub(r"```[a-z]*|```", "", got).replace("**", "").strip()
            if got and (not need_zh or re.search(r"[\u4e00-\u9fa5]", got)):
                return got
        except Exception as ex:
            print(f"  llm {model} failed: {ex}", flush=True)
    return ""


def llm_structured(model, name, schema, user_text, max_tokens=500, timeout=45):
    """One strict-schema call; parsed dict on success, else None."""
    if not KEY:
        return None
    body = {"model": model,
            "messages": [{"role": "system", "content": "英汉词典。严格按给定 JSON 模板输出，不要输出模板以外的任何内容。"},
                         {"role": "user", "content": user_text}],
            "max_tokens": max_tokens, "temperature": 0,
            "reasoning": {"exclude": True},
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": name, "strict": True, "schema": schema}},
            "provider": {"require_parameters": True}}
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "authorization": "Bearer " + KEY,
                 "X-Title": "reading-space-enrich"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode())
        got = (((j.get("choices") or [{}])[0].get("message") or {})
               .get("content") or "").strip()
        got = re.sub(r"```[a-z]*|```", "", got).strip()
        return json.loads(got)
    except Exception as ex:
        print(f"  llm_structured {model} failed: {ex}", flush=True)
        return None


def _slash_ipa(v):
    v = (v or "").strip().strip("/")
    v = v.strip("[]: ").strip()
    return "/" + v + "/" if v else ""


_POS_MAP = {"noun": "n.", "verb": "v.", "adjective": "adj.", "adverb": "adv.",
            "preposition": "prep.", "conjunction": "conj.", "pronoun": "pron.",
            "interjection": "int.", "article": "art.", "auxiliary": "aux."}


def _norm_pos(p):
    low = (p or "").strip().lower().rstrip(".")
    if low in _POS_MAP:
        return _POS_MAP[low]
    if re.fullmatch(r"n|v|adj|adv|prep|conj|pron|int|art|aux", low):
        return low + "."
    return (p or "").strip()


def _clean_def(def_zh, pos):
    t = re.sub(r"^(及物动词|不及物动词|形容词|名词|动词|副词|介词|连词|代词|感叹词|数词|冠词)\s*", "", (def_zh or "").strip())
    pl = (pos or "").lower().rstrip(".")
    if pl and t.lower().startswith(pl):
        t = re.sub(r"^[.、，,：:\s]+", "", t[len(pl):])
    return t.strip()


def word_from_structured(model, word, timeout=45):
    """Strict word entry -> the usual three-line text, or ""."""
    d = llm_structured(model, "word_translation", WORD_SCHEMA, word, timeout=timeout)
    if not d:
        return ""
    ipa = _slash_ipa(str(d.get("ipa") or ""))
    pos = _norm_pos(str(d.get("pos") or ""))
    def_zh = _clean_def(str(d.get("def_zh") or ""), pos)
    ex = str(d.get("example_en") or "").strip()
    ex_zh = str(d.get("example_zh") or "").strip()
    if not ipa or not def_zh or not ex or not ex_zh:
        return ""
    if not re.search(r"[\u4e00-\u9fa5]", def_zh) or not re.search(r"[\u4e00-\u9fa5]", ex_zh):
        return ""
    return "\n".join([" ".join(x for x in (ipa, pos, def_zh) if x), ex, ex_zh])


def sent_from_structured(model, text, timeout=45):
    """Strict sentence translation -> just the Chinese text, or ""."""
    d = llm_structured(model, "sentence_translation", SENT_SCHEMA, text, timeout=timeout)
    if not d:
        return ""
    zh = str(d.get("translation_zh") or "").strip()
    return zh if re.search(r"[\u4e00-\u9fa5]", zh) else ""


def ipa_from_structured(model, word, timeout=45):
    """Strict dual IPA -> (uk, us) with slashes, or None."""
    d = llm_structured(model, "dual_ipa", IPA_SCHEMA, word, max_tokens=200, timeout=timeout)
    if not d:
        return None
    uk = _slash_ipa(str(d.get("uk_ipa") or ""))
    us = _slash_ipa(str(d.get("us_ipa") or ""))
    return (uk, us) if uk and us else None


def zh5(text):
    return hashlib.sha256(("zh5|" + text).encode()).hexdigest()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def cached(conn, text):
    row = conn.execute("SELECT dst FROM translations WHERE hash = ?",
                       (zh5(text),)).fetchone()
    return row[0] if row and row[0] else ""


def cache_put(conn, text, dst, model="enrich"):
    dst = strip_labels(dst) if isinstance(dst, str) else dst
    conn.execute("INSERT OR REPLACE INTO translations (hash, src, dst, model, created_at) "
                 "VALUES (?,?,?,?,?)", (zh5(text), text[:300], dst[:1200], model, int(time.time() * 1000)))


def translate(conn, text, is_word, timeout=45):
    hit = cached(conn, text)
    if hit:
        return hit
    # Order (free first, paid last): dots strict -> super-vl strict ->
    # ultra/nano soft -> DeepSeek strict -> DeepSeek soft.
    strict_fn = word_from_structured if is_word else sent_from_structured
    out = strict_fn(STRICT_FREE_MODEL, text, timeout=timeout)
    if not out:
        out = strict_fn(STRICT_FREE_MODEL2, text, timeout=timeout)
    if not out:
        out = llm(WORD_SYS if is_word else SENT_SYS, text,
                  500 if is_word else 300, timeout=timeout, models=MODELS[:2])
    if not out:
        out = strict_fn(MODELS[2], text, timeout=timeout)
    if not out:
        out = llm(WORD_SYS if is_word else SENT_SYS, text,
                  500 if is_word else 300, timeout=timeout, models=MODELS[2:])
    if out:
        cache_put(conn, text, out)
    return out


_LABEL_RE = re.compile(r"[<\u3008][^>\u3009\n]{0,4}?(\u53e3|\u6b63\u5f0f|\u4fda|\u4fd7|\u65b9|\u65e7|\u4e66\u9762|\u6587\u8a00|\u55bb|\u5a49|\u8d2c|\u8912|\u656c|\u8c26|\u513f)[^>\u3009\n]{0,3}?[>\u3009]")


def strip_labels(s):
    """Drop dictionary register labels (e.g. the 'colloquial' mark written
    as <\u53e3> or with full-width brackets); they are lexicographic
    symbols, meaningless to the reader."""
    if not s:
        return s
    return re.sub(r"\s{2,}", " ", _LABEL_RE.sub("", str(s)))


def word2_from_structured(model, word, timeout=45):
    """Strict rich word entry -> validated dict or None. Fields: uk_ipa,
    us_ipa, senses (<=3 of {pos, zh}), example_en, example_zh."""
    d = llm_structured(model, "word_entry", WORD2_SCHEMA, word, max_tokens=600, timeout=timeout)
    if not d:
        return None
    senses = []
    for seg in re.split(r"[;\uFF1B]", str(d.get("senses_text") or "")):
        t = seg.strip()
        if not t:
            continue
        # v2 segment shape: "pos. zh | simple example en | example zh"
        parts = [p.strip() for p in re.split(r"[|\uFF5C]", t)]
        head = parts[0]
        ex_en = parts[1] if len(parts) > 1 else ""
        ex_zh = parts[2] if len(parts) > 2 else ""
        pm = re.match(r"^([A-Za-z]+\.?|\u540d\u8bcd|\u52a8\u8bcd|\u5f62\u5bb9\u8bcd|\u526f\u8bcd|\u4ecb\u8bcd|\u8fde\u8bcd|\u4ee3\u8bcd|\u611f\u53f9\u8bcd|\u6570\u8bcd|\u51a0\u8bcd)\s+(.+)$", head)
        if pm and re.search(r"[\u4e00-\u9fff]", pm.group(2)):
            if len(senses) < 3:
                senses.append({"pos": _norm_pos(pm.group(1)), "zh": strip_labels(pm.group(2).strip())[:60],
                               "ex_en": ex_en[:200], "ex_zh": ex_zh[:120]})
            elif senses:
                senses[-1]["zh"] += ";" + head
        elif senses and ex_en and not senses[-1].get("ex_en"):
            senses[-1]["ex_en"] = ex_en[:200]
            senses[-1]["ex_zh"] = ex_zh[:120]
        elif senses and re.search(r"[\u4e00-\u9fff]", head):
            senses[-1]["zh"] += ";" + head
        elif re.search(r"[\u4e00-\u9fff]", head):
            senses.append({"pos": "", "zh": strip_labels(head)[:60], "ex_en": ex_en[:200], "ex_zh": ex_zh[:120]})
    if not senses:
        return None
    uk = _slash_ipa(str(d.get("uk_ipa") or ""))
    us = _slash_ipa(str(d.get("us_ipa") or ""))
    ex_en = senses[0].get("ex_en") or str(d.get("example_en") or "").strip()
    ex_zh = senses[0].get("ex_zh") or str(d.get("example_zh") or "").strip()
    if ex_en and not senses[0].get("ex_en"):
        senses[0]["ex_en"], senses[0]["ex_zh"] = ex_en[:200], ex_zh[:120]
    return {"uk_ipa": uk, "us_ipa": us, "senses": senses,
            "example_en": ex_en, "example_zh": ex_zh}


def compose_def_line(entry):
    """'/uk ipa/ pos1 zh1; pos2 zh2' from a rich entry (legacy one-line def)."""
    senses = entry.get("senses") or []
    if not senses:
        return ""
    ipa = entry.get("uk_ipa") or entry.get("us_ipa") or ""
    parts = []
    for i, s in enumerate(senses):
        seg = ((s.get("pos") or "") + " " + (s.get("zh") or "")).strip()
        if i == 0 and ipa:
            seg = ipa + " " + seg
        parts.append(seg)
    return "; ".join(parts)[:300]


def entry_text(entry):
    """Rich entry -> the legacy three-line text (def / example / example zh)."""
    lines = [compose_def_line(entry)]
    if entry.get("example_en"):
        lines.append(entry["example_en"])
    if entry.get("example_zh"):
        lines.append(entry["example_zh"])
    return "\n".join([l for l in lines if l])


def entry_from_text(text):
    """Legacy three-line text -> single-sense rich entry (best effort)."""
    lines = [l.strip() for l in (text or "").split("\n") if l.strip()]
    if not lines:
        return None
    first = lines[0]
    m = re.match(r"^(/[^/]{1,40}/)\s*(.*)$", first)
    ipa = m.group(1) if m else ""
    rest = m.group(2) if m else first
    pm = re.match(r"^([A-Za-z]+\.)\s*(.*)$", rest)
    pos = _norm_pos(pm.group(1)) if pm else ""
    zh = pm.group(2) if pm else rest
    ex_en = lines[1] if len(lines) > 1 else ""
    ex_zh = lines[2] if len(lines) > 2 else ""
    return {"uk_ipa": ipa, "us_ipa": "",
            "senses": [{"pos": pos, "zh": strip_labels(zh)[:60], "ex_en": ex_en[:200], "ex_zh": ex_zh[:120]}],
            "example_en": ex_en, "example_zh": ex_zh}


def translate_free(conn, text, is_word, timeout=20):
    """PREWARM ONLY: free models exclusively, never the paid fallback.
    dots strict -> super-vl strict -> ultra/nano soft."""
    hit = cached(conn, text)
    if hit:
        return hit
    strict_fn = word_from_structured if is_word else sent_from_structured
    out = strict_fn(STRICT_FREE_MODEL, text, timeout=timeout)
    if not out:
        out = strict_fn(STRICT_FREE_MODEL2, text, timeout=timeout)
    if not out:
        out = llm(WORD_SYS if is_word else SENT_SYS, text,
                  500 if is_word else 300, timeout=timeout, models=MODELS[:2])
    if out:
        cache_put(conn, text, out)
    return out


def word_entry_free(conn, word, timeout=20):
    """Rich entry for a word using FREE models only (prewarm). Returns
    (entry, used_llm). Falls back to cached/soft three-line results."""
    hit = cached(conn, word)
    if hit:
        return entry_from_text(hit), False
    entry = word2_from_structured(STRICT_FREE_MODEL, word, timeout=timeout) \
        or word2_from_structured(STRICT_FREE_MODEL2, word, timeout=timeout)
    used = True
    if entry:
        cache_put(conn, word, entry_text(entry))
        return entry, used
    out = llm(WORD_SYS, word, 500, timeout=timeout, models=MODELS[:2])
    if out:
        cache_put(conn, word, out)
        return entry_from_text(out), used
    return None, used


def merge_senses(old, new):
    """Union of stored senses and a fresh entry's senses, keyed by
    (pos, zh): known senses keep their place and only gain a missing
    example; genuinely new senses append. Cap 5."""
    out = []
    seen = set()
    for s in list(old or []) + list(new or []):
        if not isinstance(s, dict):
            continue
        key = ((s.get("pos") or ""), (s.get("zh") or "").strip())
        if not key[1]:
            continue
        if key in seen:
            cur = next(x for x in out if ((x.get("pos") or ""), (x.get("zh") or "").strip()) == key)
            if not cur.get("ex_en") and s.get("ex_en"):
                cur["ex_en"], cur["ex_zh"] = s["ex_en"], s.get("ex_zh") or ""
            continue
        seen.add(key)
        out.append({"pos": s.get("pos") or "", "zh": s["zh"],
                    "ex_en": s.get("ex_en") or "", "ex_zh": s.get("ex_zh") or ""})
    return out[:5]


def seed_store_full(conn, word, entry):
    """Write a rich entry into word_store: scalar fields fill only when
    empty; senses are UNION-merged (a sense already stored is never
    duplicated, a new sense is appended with its own simple example)."""
    if not entry:
        return
    d = compose_def_line(entry)
    old = []
    row = conn.execute("SELECT senses FROM word_store WHERE word = ?", (word,)).fetchone()
    if row and row[0]:
        try:
            old = json.loads(row[0]) or []
        except Exception:
            old = []
    merged = merge_senses(old, entry.get("senses") or [])
    if merged:
        entry = dict(entry)
        entry["senses"] = merged
        if not entry.get("example_en") and merged[0].get("ex_en"):
            entry["example_en"] = merged[0]["ex_en"]
            entry["example_zh"] = merged[0].get("ex_zh") or ""
        d = compose_def_line(entry)
    senses_json = json.dumps(merged, ensure_ascii=False) if merged else ""
    conn.execute(
        "INSERT INTO word_store (word, def, example, example_zh, uk_ipa, us_ipa, senses, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(word) DO UPDATE SET "
        "def = COALESCE(NULLIF(word_store.def,''), excluded.def), "
        "example = COALESCE(NULLIF(word_store.example,''), excluded.example), "
        "example_zh = COALESCE(NULLIF(word_store.example_zh,''), excluded.example_zh), "
        "uk_ipa = COALESCE(NULLIF(word_store.uk_ipa,''), excluded.uk_ipa), "
        "us_ipa = COALESCE(NULLIF(word_store.us_ipa,''), excluded.us_ipa), "
        "senses = CASE WHEN excluded.senses = '' THEN word_store.senses ELSE excluded.senses END, "
        "updated_at = excluded.updated_at",
        (word, d, entry.get("example_en") or "", entry.get("example_zh") or "",
         entry.get("uk_ipa") or "", entry.get("us_ipa") or "", senses_json,
         int(time.time() * 1000)))
    conn.commit()


def seed_store(conn, word, d, ex, exzh):
    """Write word content into the global store, filling only empty fields."""
    conn.execute(
        "INSERT INTO word_store (word, def, example, example_zh, updated_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(word) DO UPDATE SET "
        "def = COALESCE(NULLIF(word_store.def,''), excluded.def), "
        "example = COALESCE(NULLIF(word_store.example,''), excluded.example), "
        "example_zh = COALESCE(NULLIF(word_store.example_zh,''), excluded.example_zh), "
        "updated_at = excluded.updated_at",
        (word, d or "", ex or "", exzh or "", int(time.time() * 1000)))
    conn.commit()


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
    conn.execute(
        "CREATE TABLE IF NOT EXISTS word_store ("
        "word TEXT PRIMARY KEY, def TEXT, example TEXT, example_zh TEXT, "
        "uk_ipa TEXT, us_ipa TEXT, senses TEXT, updated_at INTEGER)")
    try:
        conn.execute("ALTER TABLE word_store ADD COLUMN senses TEXT")
    except Exception:
        pass
    conn.execute(
        "CREATE TABLE IF NOT EXISTS word_audio ("
        "word TEXT NOT NULL, accent TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER, "
        "PRIMARY KEY (word, accent))")
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
            seed_store(conn, r["word"], parts[0],
                       parts[1] if len(parts) > 1 else "",
                       parts[2] if len(parts) > 2 else "")
            done.append(f"split {r['word']}")
    except Exception as ex:
        print(f"split failed: {ex}", flush=True)

    # 2) missing definitions -> global word store (content lives there once;
    #    vocab rows stay slim relationship records)
    rows = conn.execute(
        "SELECT DISTINCT v.word FROM vocab v LEFT JOIN word_store s ON s.word = v.word "
        "WHERE s.word IS NULL OR s.def IS NULL OR s.def = '' LIMIT ?", (BATCH_DEF,)).fetchall()
    for r in rows:
        w = r["word"]
        seeded = False
        vr = conn.execute(
            "SELECT translation FROM vocab WHERE word = ? AND translation IS NOT NULL "
            "AND translation != '' LIMIT 1", (w,)).fetchone()
        if vr:
            parts = [x.strip() for x in vr["translation"].split("\n") if x.strip()]
            if parts:
                seed_store(conn, w, parts[0],
                           parts[1] if len(parts) > 1 else "",
                           parts[2] if len(parts) > 2 else "")
                seeded = True
        if not seeded:
            out = translate(conn, w, is_single_word(w))
            if out:
                lines = [x.strip() for x in out.split("\n") if x.strip()]
                if lines:
                    seed_store(conn, w, lines[0],
                               lines[1] if len(lines) > 1 else "",
                               lines[2] if len(lines) > 2 else "")
                    seeded = True
        if seeded:
            done.append(f"def {w}")

    # 2b) senses fill: vocab words whose store row lacks the structured
    #     senses (top-3 with POS). dots strict -> super-vl strict ->
    #     DeepSeek strict (enrichment serves post-reading entries, where
    #     the paid fallback is allowed; only prewarm is free-only).
    try:
        rows = conn.execute(
            "SELECT DISTINCT v.word FROM vocab v LEFT JOIN word_store s ON s.word = v.word "
            "WHERE s.senses IS NULL OR s.senses = '' OR s.senses = '[]' "
            "OR s.senses NOT LIKE '%ex_en%' LIMIT 2").fetchall()
        for r in rows:
            w = r["word"]
            entry = word2_from_structured(STRICT_FREE_MODEL, w, timeout=20) \
                or word2_from_structured(STRICT_FREE_MODEL2, w, timeout=20) \
                or word2_from_structured(MODELS[2], w, timeout=20)
            if entry:
                seed_store_full(conn, w, entry)
                done.append(f"senses {w}")
    except Exception as ex:
        print(f"senses job failed: {ex}", flush=True)

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

    # 4) missing dual IPA -> global word store
    rows = conn.execute(
        "SELECT DISTINCT v.word FROM vocab v LEFT JOIN word_store s ON s.word = v.word "
        "WHERE s.uk_ipa IS NULL OR s.uk_ipa = '' OR s.us_ipa IS NULL OR s.us_ipa = '' "
        "LIMIT ?", (BATCH_IPA,)).fetchall()
    for r in rows:
        w = r["word"]
        pair = ipa_from_structured(STRICT_FREE_MODEL, w) or ipa_from_structured(STRICT_FREE_MODEL2, w)
        if pair:
            out = "UK: %s US: %s" % pair
        else:
            out = llm(IPA_SYS, w, 120, need_zh=False)
        ipas = re.findall(r"/([^/\n]{1,40})/", out or "")
        if len(ipas) >= 2:
            uk, us = "/" + ipas[0] + "/", "/" + ipas[1] + "/"
        elif len(ipas) == 1:
            uk, us = "/" + ipas[0] + "/", None
        else:
            continue
        with conn:
            if us:
                conn.execute(
                    "INSERT INTO word_store (word, uk_ipa, us_ipa, updated_at) VALUES (?,?,?,?) "
                    "ON CONFLICT(word) DO UPDATE SET uk_ipa = excluded.uk_ipa, "
                    "us_ipa = excluded.us_ipa, updated_at = excluded.updated_at",
                    (w, uk, us, int(time.time() * 1000)))
            else:
                conn.execute(
                    "INSERT INTO word_store (word, uk_ipa, updated_at) VALUES (?,?,?) "
                    "ON CONFLICT(word) DO UPDATE SET "
                    "uk_ipa = COALESCE(NULLIF(word_store.uk_ipa,''), excluded.uk_ipa), "
                    "updated_at = excluded.updated_at",
                    (w, uk, int(time.time() * 1000)))
        done.append(f"ipa {w}")

    # 4b) missing word audio (the word itself, both accents; vocab words only)
    rows = conn.execute("SELECT DISTINCT word FROM vocab").fetchall()
    made_w = 0
    for r in rows:
        if made_w >= 4:
            break
        w = r["word"]
        if not is_single_word(w):
            continue
        have = {x[0] for x in conn.execute(
            "SELECT accent FROM word_audio WHERE word = ?", (w,)).fetchall()}
        for accent, voice in (("uk", "en-GB-SoniaNeural"), ("us", "en-US-AriaNeural")):
            if accent in have or made_w >= 4:
                continue
            try:
                data = asyncio.run(tts(w, voice))
            except Exception as ex:
                print(f"  word tts failed ({accent} {w}): {ex}", flush=True)
                data = b""
            if data:
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO word_audio (word, accent, data, created_at) VALUES (?,?,?,?)",
                        (w, accent, data, int(time.time() * 1000)))
                made_w += 1
                done.append(f"word-audio {accent} {w}")

    # 5) missing sentence audio
    rows = conn.execute("SELECT DISTINCT sentence FROM vocab_contexts LIMIT 200").fetchall()
    # v2: the per-sense simple examples of vocab words are sentences too --
    # their UK/US readings are generated the same way (keyed by text hash).
    try:
        vrows = conn.execute(
            "SELECT s.senses FROM word_store s JOIN vocab v ON v.word = s.word "
            "WHERE s.senses IS NOT NULL AND s.senses <> ''").fetchall()
        extra = []
        for vr in vrows:
            try:
                for s in json.loads(vr[0]) or []:
                    ex = (s.get("ex_en") or "").strip()
                    if ex:
                        extra.append({"sentence": ex})
            except Exception:
                pass
        rows = rows + extra
    except Exception:
        pass
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
    # 6) global sentence library: translate queued context sentences
    #    with FREE models only (word lookups never wait on these; the
    #    translations also land in the zh5 cache for other lookups)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sentence_lib (hash TEXT PRIMARY KEY, "
            "text TEXT NOT NULL, zh TEXT NOT NULL DEFAULT '', created_at INTEGER, updated_at INTEGER)")
        srows = conn.execute(
            "SELECT hash, text FROM sentence_lib WHERE zh = '' "
            "AND length(text) BETWEEN 10 AND 300 ORDER BY created_at ASC LIMIT 4").fetchall()
        for sr in srows:
            zh = translate_free(conn, sr["text"], False)
            if zh:
                with conn:
                    conn.execute("UPDATE sentence_lib SET zh = ?, updated_at = ? WHERE hash = ?",
                                 (strip_labels(zh)[:1200], int(time.time() * 1000), sr["hash"]))
                cache_put(conn, sr["text"], zh, model="enrich-sentences")
                done.append(f"sentence-lib {sr['text'][:24]}")
    except Exception as ex:
        print(f"sentence-lib failed: {ex}", flush=True)
    conn.close()
    print(time.strftime("%F %T"), "done:", "; ".join(done) if done else "nothing pending", flush=True)


if __name__ == "__main__":
    main()
