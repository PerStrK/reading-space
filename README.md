# 阅读空间 · Reading Space

一个自用的英文原版书阅读站：**书架 + EPUB / PDF 阅读器 + 划词翻译 + 生词本 + 云端阅读进度**。
整套跑在 Cloudflare Pages 上（免费额度足够家庭使用），数据存 Cloudflare D1，翻译走 OpenRouter。

> 定位是「给自己或孩子用的私人书房」——默认全站需要登录才能访问，不是公开的内容站。

---

## 功能

**书架**
- 自动扫描书目录，读取 EPUB 元数据，挑封面并生成缩略图
- 显示每本书的阅读进度、章节数 / 页数
- PDF 与 EPUB 混排，同一套封面卡片

**EPUB 阅读器**
- 字号、底色（纸白 / 米黄 / 夜间）可调
- 两种翻页方式：**左右翻页**、**连续滚动**
- 目录跳转、书签、进度条
- 由 epub.js 渲染

**PDF 阅读器**
- pdf.js 渲染 + 透明文字层，固定版式也能选词
- 同样支持左右翻页 / 连续滚动（自己实现的窗口化渲染，只画视口附近的页，几百页也不卡）
- 缩放、适宽、页码跳转、书签
- 大 PDF 超过 Pages 单文件 25 MiB 上限时，用脚本切成上下册

**划词翻译**
- 选中即出气泡：单词给 **IPA 音标 + 词性 + 释义 + 例句**，整句给译文
- 译文按 hash 缓存进 D1，同一个词只花一次 API 费用
- 主模型不可用时自动切换备用模型

**生词本**
- 划过的词按书归拢，带原句和位置（点一下能跳回去）
- 「自动入库」开关：开了之后点翻译就顺带存词并高亮
- 导出 JSON / CSV / Markdown

**阅读进度与书签**
- 按账号 + 书存 D1，换设备接着读
- localStorage 只作离线兜底

**登录鉴权**
- Cloudflare Pages Functions（Advanced Mode）做全站闸门
- 账号密码、签名密钥全部走环境变量，不写在代码里
- Cookie 里只放用户名，角色由服务端查表决定——客户端无法自称管理员
- 登录失败按 IP 限流

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 托管 | Cloudflare Pages | 静态资源 + Functions，免费额度够用 |
| 服务端 | Pages Functions（`_worker.js`，Advanced Mode） | 单文件 Worker，手写路由，无框架 |
| 数据库 | Cloudflare D1（SQLite） | 进度、书签、生词、翻译缓存、登录限流 |
| EPUB 渲染 | [epub.js](https://github.com/futurepress/epub.js) | 左右翻页 / 连续滚动 |
| PDF 渲染 | [pdf.js](https://mozilla.github.io/pdf.js/) | Canvas + TextLayer |
| 翻译 | [OpenRouter](https://openrouter.ai/) | OpenAI 兼容接口，可自由换模型 |
| 构建 | Python 3.10+ / PyMuPDF / Pillow | 生成书架页、阅读器页、封面缩略图 |

前端没有构建步骤：`library.html` / `reader.html` / `pdf.html` 由 Python 脚本用模板生成，产物直接就是静态文件。

---

## 目录结构

```
reading-space/
├── public/                    # ← Cloudflare Pages 的发布目录
│   ├── _worker.js             # 全站闸门 + 全部 API（Pages Functions, Advanced Mode）
│   ├── index.html             # 首页（手写）
│   ├── library.html           # 书架页（生成）
│   ├── reader.html            # EPUB 阅读器（生成）
│   ├── pdf.html               # PDF 阅读器（生成）
│   ├── 404.html
│   ├── books.json             # 书目索引（由 tools/build_books.py 生成）
│   ├── assets/
│   │   ├── site.css           # 全站样式
│   │   ├── account.js         # 右上角账号标记
│   │   ├── library.js         # 书架渲染 / 进度
│   │   ├── reader.js          # EPUB 阅读器逻辑
│   │   ├── pdf-reader.js      # PDF 阅读器逻辑
│   │   └── vendor/            # epub.min.js / jszip.min.js / pdf.min.mjs / pdf.worker.min.mjs
│   └── books/                 # ← 电子书放这里（不进仓库，见 .gitignore）
│       ├── *.epub
│       ├── *.pdf
│       └── covers/            # 自动生成的封面缩略图
├── tools/
│   ├── build_books.py         # 扫 books/，生成 books.json + 封面
│   ├── build_reader.py        # 生成 library.html / reader.html
│   ├── build_pdf_reader.py    # 生成 pdf.html
│   ├── split_pdf.py           # 把超大 PDF 切成上下册
│   └── requirements.txt
├── schema/
│   └── schema.sql             # D1 建表语句
├── books-src/                 # 原始整本 PDF（不进仓库）
├── VERSION                    # 静态资源版本号，改完页面递增可刷新缓存
├── wrangler.toml.example      # 配置模板，复制成 wrangler.toml 再改
├── package.json
└── README.md
```

---

## 环境要求

- **Node.js** ≥ 18（推荐 20+），用于运行 wrangler
- **Python** ≥ 3.10，只在「加书 / 改页面模板」时需要
- 一个 **Cloudflare 账号**（免费版即可）
- 一个 **OpenRouter API Key**（用划词翻译才需要，[在这里申请](https://openrouter.ai/keys)）

```bash
npm install                                    # 装 wrangler
pip install -r tools/requirements.txt          # 装 PyMuPDF / Pillow
```

---

## 本地开发

### 1. 准备配置

```bash
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` 已被 `.gitignore` 忽略，随便改。里面 `database_id` 先留占位值，本地开发用不到真实 id。

### 2. 建本地数据库

```bash
npx wrangler d1 execute reading-space --local --file=schema/schema.sql
```

本地数据落在 `.wrangler/state/` 下，删掉这个目录就等于重置。

### 3. 配置本地密钥

新建 `.dev.vars`（同样被忽略，不会提交）：

```ini
READER_USER=reader
READER_PASS=devpass123
ADMIN_USER=admin
ADMIN_PASS=adminpass123
AUTH_SECRET=换成一段32字节以上的随机串
OPENROUTER_KEY=sk-or-v1-你的key
```

生成随机串：`openssl rand -base64 32`

### 4. 放书（可选）

把 `.epub` 或 `.pdf` 丢进 `public/books/`，然后重建书目：

```bash
npm run build
```

> 不放书也能跑，只是书架是空的。仓库里**不含任何电子书**，请自备有合法使用权的文件。

### 5. 启动

```bash
npm run dev
```

打开 http://localhost:8788 ，用上面配的账号登录。

---

## 生产部署

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

### 2. 建 D1 数据库

```bash
npx wrangler d1 create reading-space
```

输出里会有一行 `database_id = "xxxx-..."`，把它填进 `wrangler.toml` 的 `[[d1_databases]]`。

### 3. 建表

```bash
npx wrangler d1 execute reading-space --remote --file=schema/schema.sql
```

### 4. 建 Pages 项目

```bash
npx wrangler pages project create reading-space --production-branch=main
```

### 5. 先部署一次

```bash
npm run deploy
```

第一次会问要不要创建项目，选是即可。

### 6. 配环境变量与密钥

**能用明文变量的**（账号名、称呼）写在 `wrangler.toml` 的 `[vars]` 里，部署时自动带上：

```toml
[vars]
READER_USER = "reader"
ADMIN_USER = "admin"
CHILD_NAME = "小朋友"
```

**所有密码必须用 Secret**，不要写进 `wrangler.toml`：

```bash
npx wrangler pages secret put READER_PASS  --project-name reading-space
npx wrangler pages secret put ADMIN_PASS   --project-name reading-space
npx wrangler pages secret put AUTH_SECRET  --project-name reading-space
npx wrangler pages secret put OPENROUTER_KEY --project-name reading-space
```

> ⚠️ **重要**：带着 `wrangler.toml` 部署时，wrangler 会用文件里的 `[vars]` **覆盖线上同名明文变量**（文件里没写的会被删掉），但 Secret 不受影响。所以密码放 Secret、账号名放 `[vars]`，各就各位。
>
> 另外：**改完环境变量必须重新部署一次才生效**（Pages 直传项目没有「重启」按钮）。

### 7. 再部署一次让变量生效

```bash
npm run deploy
```

访问 `https://<项目名>.pages.dev` 即可。想绑自己的域名，在 Pages 项目 → Custom domains 里加。

---

## 环境变量

| 变量 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `READER_USER` | ✅ | 明文 | 阅读者登录名（也接受旧名 `AUTH_USER`） |
| `READER_PASS` | ✅ | **Secret** | 阅读者密码（也接受旧名 `AUTH_PASS`） |
| `ADMIN_USER` | — | 明文 | 管理员登录名，留空则无管理员 |
| `ADMIN_PASS` | — | **Secret** | 管理员密码，与 `ADMIN_USER` 同时给才生效 |
| `CHILD_NAME` | — | 明文 | 页面上显示的称呼，默认「孩子」 |
| `AUTH_SECRET` | 建议 | **Secret** | 会话签名密钥，32 字节以上随机串。不填则退化为用密码派生（改密码会让所有会话失效） |
| `AUTH_VER` | — | 明文 | 会话版本号。改密码后 +1 可让已发出的 Cookie 立即失效 |
| `OPENROUTER_KEY` | 翻译需要 | **Secret** | OpenRouter API Key，不填则翻译接口返回 501 |
| `TRANSLATE_MODEL` | — | 明文 | 主翻译模型，默认 `nvidia/nemotron-3.5-super-vl:free` |
| `TRANSLATE_FALLBACK` | — | 明文 | 备用模型，主模型失败时自动切，默认 `~deepseek/deepseek-flash-latest` |
| `SITE_URL` | — | 明文 | 你的站点地址，会作为 `HTTP-Referer` 发给 OpenRouter（仅用于用量归因） |
| `TEST_USER` / `TEST_PASS` | — | 明文 / Secret | 可选的第三个「试用」账号，数据独立 |

D1 绑定名必须是 **`DB`**。

### 换翻译模型

默认模型是免费的，速度和效果一般。想换成更好的（收费），改 `TRANSLATE_MODEL` 即可，只要 OpenRouter 支持的模型 id 都行，例如：

```ini
TRANSLATE_MODEL=openai/gpt-4o-mini
TRANSLATE_FALLBACK=deepseek/deepseek-chat
```

> 翻译结果按 `hash(版本前缀 + 原文)` 缓存。如果调整了提示词想让旧缓存失效，在 `_worker.js` 里把 `sha256hex("zh4|" + text)` 的 `zh4` 改成新版本号即可。

---

## 加书

### EPUB

直接丢进 `public/books/`，跑 `npm run build`。
元数据（书名 / 作者）从 OPF 里读；想覆盖显示信息，改 `tools/build_books.py` 里的 `OVERRIDES`。

### PDF

小于 25 MiB 的直接丢进 `public/books/`，跑 `npm run build`。

**超过 25 MiB** 的必须切开（Pages 单文件上限），否则部署会失败：

```bash
python3 tools/split_pdf.py ~/Downloads/某本大书.pdf
```

它会在 `public/books/` 生成 `...-vol1.pdf` / `...-vol2.pdf` 两册，各带一张自制分册封面，然后 `npm run build` 收录。

> 脚本里的分册点是按某本年鉴的章节位置写死的（`tools/split_pdf.py` 的 `VOLUMES`），换书时改一下页码范围即可。

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` | 登录（表单 `u` / `p` / `next`） |
| GET | `/logout` | 退出 |
| GET | `/api/me` | 当前账号 `{user, role, name, label}` |
| GET / POST | `/api/reading/progress` | 读 / 写阅读进度（`{book, cfi, percent}`） |
| GET / POST / DELETE | `/api/reading/bookmarks` | 书签列表 / 新增 / 删除 |
| POST | `/api/translate` | 翻译（`{text}` → `{ok, text, ipa, cached}`） |
| GET / POST / DELETE | `/api/vocab` | 生词本 |
| GET | `/api/vocab/export?format=json\|csv\|md` | 导出 |
| GET / POST | `/api/settings` | 账号偏好（`auto_vocab`） |

除 `/login`、`/logout` 外都需要登录 Cookie。

---

## 常见问题排查

**打开只看到「还差一步 / 未设置登录账号」**
`READER_USER` 没读到。检查变量是否配在正确的 Pages 项目上，以及**配完有没有重新部署**。

**登录后一直转圈 / 接口 500**
多数是 D1 没绑定或没建表。确认 `wrangler.toml` 里绑定名是 `DB`，并在线上执行过 `schema/schema.sql`：
```bash
npx wrangler d1 execute reading-space --remote --file=schema/schema.sql
```

**书架是空的**
- `public/books/` 里没书，或
- 没跑 `npm run build`（`books.json` 还是 `[]`）

打开浏览器控制台看 `books.json` 请求是否 200。

**点翻译提示「还没在后台配置 OPENROUTER_KEY」**
Secret 没配或没重新部署。补上 `OPENROUTER_KEY` 后再 deploy 一次。

**翻译一直停在「翻译中…」**
上游模型限流、额度用尽或模型名写错。接口会返回 `hint` 字段，直接在控制台看 `/api/translate` 的响应。换个 `TRANSLATE_MODEL` 通常就好。

**部署报文件过大（>25 MiB）**
用 `tools/split_pdf.py` 切分后再部署。

**改了环境变量不生效**
Pages 直传项目改完变量**必须重新 `npm run deploy`**，没有「重启」按钮。

**PDF 打开很慢**
大 PDF 首次打开需要下载，几万字节的分片请求会持续一会儿，属正常现象。第二次打开有浏览器缓存会快很多。

**页码 / 进度乱了**
进度按「书 id + 账号」存。同一本书换文件名会被当成新书。确认 `books.json` 里 `id` 稳定。

**本地数据库想重置**
删掉 `.wrangler/state/` 再执行一次 `npm run db:init:local`。

---

## 数据与隐私

- 仓库里**不含任何电子书、不含任何真实用户数据**。`public/books/` 与 `books-src/` 都在 `.gitignore` 里。
- 所有密码只通过 Cloudflare Secret 注入，代码里没有任何硬编码凭据。
- 登录 Cookie 为 `HttpOnly; Secure; SameSite=Lax`，内容只有用户名 + 过期时间 + HMAC 签名。
- 翻译会把选中的文本发给 OpenRouter 及其背后的模型提供方。如果是给孩子用的私人读物，这一点需要自行权衡。
- 建议给自己的书房设一个强 `AUTH_SECRET`，并定期更换（换完把 `AUTH_VER` +1，旧会话立即失效）。

---

## 许可

[MIT](LICENSE)

第三方资源遵循各自许可：epub.js（BSD-2-Clause）、pdf.js（Apache-2.0）、jszip（MIT / GPLv3 双许可）。
