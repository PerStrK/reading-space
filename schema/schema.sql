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
  PRIMARY KEY (user, word, book)
);

CREATE INDEX IF NOT EXISTS idx_vocab_last ON vocab(user, last_at DESC);

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
  PRIMARY KEY (user, book_id)
);

CREATE INDEX IF NOT EXISTS idx_user_books_book ON user_books(book_id);
