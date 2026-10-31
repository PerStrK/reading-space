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
  PRIMARY KEY (user, word, book)
);

CREATE INDEX IF NOT EXISTS idx_vocab_last ON vocab(user, last_at DESC);

-- 账号偏好：目前只有「划词自动入库」一个开关，按账号分开存
CREATE TABLE IF NOT EXISTS user_settings (
  user        TEXT PRIMARY KEY,
  auto_vocab  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
