-- 阅读空间 · 数据库结构（Cloudflare D1 / SQLite）
--
-- 应用方式：
--   本地  npx wrangler d1 execute reading-space --local  --file=schema/schema.sql
--   线上  npx wrangler d1 execute reading-space --remote --file=schema/schema.sql
--
-- 全部使用 CREATE TABLE IF NOT EXISTS，重复执行安全。

-- 登录失败计数（按 IP 限流的原料）
CREATE TABLE IF NOT EXISTS login_fails (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fails ON login_fails(ip, ts);

-- 阅读进度：一个账号一本书一条
--   EPUB 存 epub.js 的 CFI（如 epubcfi(/6/14!/4/2/2)）
--   PDF  存页码（如 pdf:p42）
CREATE TABLE IF NOT EXISTS reading_progress (
  user       TEXT NOT NULL,
  book       TEXT NOT NULL,          -- books.json 里的 id
  cfi        TEXT NOT NULL,
  percent    REAL NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user, book)
);

-- 书签
CREATE TABLE IF NOT EXISTS reading_bookmarks (
  id         TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  book       TEXT NOT NULL,
  cfi        TEXT NOT NULL,
  label      TEXT,                   -- 章节名，或「第 N 页」
  percent    REAL DEFAULT 0,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rb_user_book ON reading_bookmarks(user, book);

-- 翻译缓存：同一个词/句只花一次 API 钱
CREATE TABLE IF NOT EXISTS translations (
  hash       TEXT PRIMARY KEY,       -- sha256(版本前缀 + 原文)
  src        TEXT,                   -- 原文（截断保存，便于排查）
  dst        TEXT NOT NULL,          -- 译文
  model      TEXT,
  created_at INTEGER
);

-- 生词本
CREATE TABLE IF NOT EXISTS vocab (
  user        TEXT NOT NULL,
  word        TEXT NOT NULL,         -- 归一化后的词或短语（小写、去首尾标点、压缩空白）
  book        TEXT NOT NULL,
  cfi         TEXT,                  -- 在书里的位置，点一下能跳回去
  sentence    TEXT,                  -- 原句
  translation TEXT,                  -- 释义/译文（可能为空，后补）
  note        TEXT,                  -- 自己加的备注
  hits        INTEGER NOT NULL DEFAULT 1,   -- 划了几次
  first_at    INTEGER,
  last_at     INTEGER,
  src         TEXT,                  -- reading | manual | local
  mastered    INTEGER NOT NULL DEFAULT 0,   -- 1 = 已标记「已掌握」，页面上归到已掌握区
  mastered_at INTEGER,
  sentence_zh TEXT,                  -- 原句的中文翻译
  example     TEXT,                  -- 词典例句（英文）
  example_zh  TEXT,                  -- 例句的中文翻译
  uk_ipa      TEXT,                  -- 英式音标（后台补全）
  us_ipa      TEXT                   -- 美式音标（后台补全）
  PRIMARY KEY (user, word, book)
);

CREATE INDEX IF NOT EXISTS idx_vocab_last ON vocab(user, last_at DESC);

-- 生词的全部原句：同一词在不同句子/书里被划到时各存一行，带各自译文
CREATE TABLE IF NOT EXISTS vocab_contexts (
  user        TEXT NOT NULL,
  word        TEXT NOT NULL,
  book        TEXT NOT NULL,
  sentence    TEXT NOT NULL,         -- 原句
  sentence_zh TEXT,                  -- 原句翻译
  first_at    INTEGER,
  last_at     INTEGER,
  hits        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user, word, book, sentence)
);

-- 原句录音：英/美两版，按句子 sha256 哈希共享，后台用 TTS 慢慢生成
CREATE TABLE IF NOT EXISTS sentence_audio (
  hash       TEXT NOT NULL,          -- sha256(原句)
  accent     TEXT NOT NULL,          -- uk | us
  data       BLOB NOT NULL,          -- mp3
  created_at INTEGER,
  PRIMARY KEY (hash, accent)
);

-- 全局单词库：词的内容只存一份，所有账户共用；vocab 行只记账户与词的关系
CREATE TABLE IF NOT EXISTS word_store (
  word       TEXT PRIMARY KEY,       -- 规范化词形
  def        TEXT,                   -- 词义行（/音标/ 词性 中文释义）
  example    TEXT,                   -- 词典例句（英文）
  example_zh TEXT,                   -- 例句中文翻译
  uk_ipa     TEXT,                   -- 英式音标（后台补全）
  us_ipa     TEXT,                   -- 美式音标（后台补全）
  senses     TEXT,                   -- 结构化义项 JSON [{pos, zh}]，最常用的前三个
  updated_at INTEGER
);

-- 单词录音：英/美两版，按词共享，后台用 TTS 慢慢生成
CREATE TABLE IF NOT EXISTS word_audio (
  word       TEXT NOT NULL,
  accent     TEXT NOT NULL,          -- uk | us
  data       BLOB NOT NULL,          -- mp3
  created_at INTEGER,
  PRIMARY KEY (word, accent)
);

-- 缓存库的书-词索引：上传后后台预热产出（800 常用词之外的词 + 书中原句，每词最多 3 句）
CREATE TABLE IF NOT EXISTS book_words (
  book     TEXT NOT NULL,
  word     TEXT NOT NULL,
  sentence TEXT,                     -- 该词在书里出现的原句（译文查 translations 缓存）
  PRIMARY KEY (book, word, sentence)
);

-- 每本书的预热进度
CREATE TABLE IF NOT EXISTS book_prewarm (
  book       TEXT PRIMARY KEY,
  total      INTEGER,
  done       INTEGER,
  status     TEXT,                   -- running | complete | skip-pdf
  updated_at INTEGER
);

-- 句子表：整句/整段翻译时自动收进来的原句+译文，按账号分开
-- （老库没有这两列/这张表也没关系：worker 首次用到时会自动补建，见 ensureVocabCols / ensureSentences）
CREATE TABLE IF NOT EXISTS sentences (
  user     TEXT NOT NULL,
  src      TEXT NOT NULL,            -- 原句（英文）
  dst      TEXT NOT NULL,            -- 译文
  book     TEXT NOT NULL DEFAULT '',
  first_at INTEGER,
  last_at  INTEGER,
  PRIMARY KEY (user, src)
);

CREATE INDEX IF NOT EXISTS idx_sentences_user ON sentences(user, first_at DESC);

-- 账号偏好（旧表，保留兼容）：「划词自动入库」已改为 app_settings 里的全站开关，由管理员控制
CREATE TABLE IF NOT EXISTS user_settings (
  user        TEXT PRIMARY KEY,
  auto_vocab  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- 账号（数据库版）：环境变量账号在首次运行时播种进来，之后以后台为准
--   pass_hash 格式 pbkdf2$迭代次数$盐$哈希（均为 base64）
--   disabled=1 表示已被管理员删除：不能登录，且同名环境变量账号也不再兜底
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',   -- admin | user | test
  name       TEXT,                            -- 页面称呼
  label      TEXT,                            -- 账号角标文案
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  created_by TEXT
);

-- 全站设置（键值）：register_open = '1' 时开放访客自主注册，默认关闭
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 上传的书：一本书只存一份，按内容 sha256 去重
CREATE TABLE IF NOT EXISTS books (
  id         TEXT PRIMARY KEY,          -- sha256 前 16 位，进 URL 和进度表
  sha256     TEXT NOT NULL UNIQUE,      -- 全量哈希，去重键
  title      TEXT,
  author     TEXT,
  format     TEXT NOT NULL,             -- epub | pdf
  size       INTEGER NOT NULL,
  pages      INTEGER,                   -- PDF 页数（估算）
  chapters   INTEGER,                   -- EPUB 章节数（估算）
  has_cover  INTEGER NOT NULL DEFAULT 0,
  uploader   TEXT,                      -- 第一个上传者
  created_at INTEGER
);

-- 书的文件内容：512KB 一块（避开 D1 单值 1MB 上限），按 seq 拼回去
CREATE TABLE IF NOT EXISTS book_chunks (
  book_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  data    BLOB NOT NULL,
  PRIMARY KEY (book_id, seq)
);

-- 封面原图（从 EPUB 里抽出来的，限 900KB 以内；没有就走占位图）
CREATE TABLE IF NOT EXISTS book_covers (
  book_id TEXT PRIMARY KEY,
  type    TEXT,
  data    BLOB NOT NULL
);

-- 谁的书架上有这本书：上传、以及重复上传同一本书时各记一行
CREATE TABLE IF NOT EXISTS user_books (
  user     TEXT NOT NULL,
  book_id  TEXT NOT NULL,
  added_at INTEGER,
  last_open INTEGER,                 -- 最近打开时间（毫秒），书架按它倒序
  PRIMARY KEY (user, book_id)
);

CREATE INDEX IF NOT EXISTS idx_user_books_book ON user_books(book_id);

-- Global sentence library (2026-11-03): context sentences collected at
-- word-lookup time; content stored once, associations in sentence_refs.
CREATE TABLE IF NOT EXISTS sentence_lib (
  hash TEXT PRIMARY KEY, text TEXT NOT NULL, zh TEXT NOT NULL DEFAULT '',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS sentence_refs (
  hash TEXT NOT NULL, book TEXT NOT NULL DEFAULT '', word TEXT NOT NULL DEFAULT '',
  user TEXT NOT NULL DEFAULT '', first_at INTEGER, last_at INTEGER,
  hits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (hash, book, word, user)
);
CREATE INDEX IF NOT EXISTS idx_sentence_refs_book ON sentence_refs(book, last_at DESC);
