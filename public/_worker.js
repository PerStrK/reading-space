/**
 * 阅读空间 · 登录鉴权 + 阅读进度 / 书签 / 划词翻译 / 生词本
 * Cloudflare Pages Functions（Advanced Mode，文件放在站点根目录）
 *
 * 账号密码、签名密钥都不写在这里，全部读后台环境变量：
 *   READER_USER / READER_PASS   孩子账号（兼容旧的 AUTH_USER / AUTH_PASS）
 *   ADMIN_USER / ADMIN_PASS     管理员账号
 *   CHILD_NAME                  页面上显示的称呼，默认「孩子」
 *   AUTH_SECRET                 签名密钥，32 字节以上随机串（不给则退化为用密码派生）
 *   AUTH_VER                    会话版本号，改密码后 +1 可让旧 Cookie 立即失效
 *   OPENROUTER_KEY              OpenRouter 的 API Key，划词翻译要用
 *   TRANSLATE_MODEL             可选，主翻译模型
 *   TRANSLATE_FALLBACK          可选，备用翻译模型
 *   TRANSLATE_FALLBACK2         可选，第二备用翻译模型
 *   DB                          D1 绑定名
 *
 * Cookie 只带 sub（用户名），角色在服务端按账号查——客户端无法自称 admin。
 */

const COOKIE = "rs_auth";
const TTL = 7 * 24 * 60 * 60;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LIMIT_FAILS = 8;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const accts = accounts(env);

    // 数据库账号：环境变量账号首次运行时播种进 users 表，之后以后台为准
    await ensureSeed(env, accts);
    if (!accts.length && !(await anyDbUser(env))) return html(setupHtml(), 200);

    const secret = await sessionSecret(env);

    if (path === "/login") {
      if (request.method === "POST") return handleLogin(request, url, secret, env);
      const regOpen = (await getAppSetting(env, "register_open")) === "1";
      return html(loginHtml(safeNext(url.searchParams.get("next")), "", regOpen), 200);
    }

    if (path === "/register") {
      if (request.method === "POST") return handleRegister(request, secret, env);
      return html(await registerHtml(env, ""), 200);
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/login",
          "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          "cache-control": "no-store",
        },
      });
    }

    // 站点图标公开放行：iOS「添加到主屏幕」取图标时不带登录态，被挡去登录页就拿不到图标
    // /sw.js 同理：Service Worker 的更新检查不一定带登录态，挡了会直坏缓存更新
    if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png" || path === "/icon-512.png" || path === "/sw.js") {
      return env.ASSETS.fetch(request);
    }

    const me = await session(request, secret, env);
    if (!me) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/login?next=" + encodeURIComponent(path + url.search),
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/api/me") return json({ user: me.user, role: me.role, name: me.name, label: me.label });

    // ---- 阅读空间：进度与书签 ----
    if (path === "/api/reading/progress") {
      if (request.method === "POST") return saveReadingProgress(request, env, me);
      return getReadingProgress(url, env, me);
    }
    if (path === "/api/reading/bookmarks") {
      if (request.method === "POST") return addReadingBookmark(request, env, me);
      if (request.method === "DELETE") return delReadingBookmark(url, env, me);
      return listReadingBookmarks(url, env, me);
    }

    // ---- 划词翻译 + 生词本 ----
    if (path === "/api/translate") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      return handleTranslate(request, env, me);
    }
    if (path === "/api/vocab") {
      if (request.method === "POST") return addVocab(request, env, me);
      if (request.method === "DELETE") return delVocab(url, env, me);
      return listVocab(url, env, me);
    }
    if (path === "/api/vocab/export") return exportVocab(url, env, me);
    if (path === "/api/vocab/users") return listVocabUsers(env, me);
    if (path === "/api/vocab/master") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      return setVocabMastered(request, env, me);
    }
    if (path === "/api/sentences") {
      if (request.method === "DELETE") return delSentence(url, env, me);
      return listSentences(url, env, me);
    }
    if (path === "/api/sent-audio") return serveSentAudio(url, env, me);
    if (path === "/api/word-audio") return serveWordAudio(url, env, me);
    if (path === "/api/sentences/users") return listSentenceUsers(env, me);

    // ---- 账号偏好（按账号分开存）----
    if (path === "/api/settings") {
      if (request.method === "POST") return saveSettings(request, env, me);
      return getSettings(env, me);
    }

    // ---- 上传的书：列表 / 上传 / 从我的书架移除 ----
    if (path === "/api/books") return listDbBooks(env, me);
    if (path === "/api/books/upload") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      return handleUpload(request, env, me);
    }
    if (path === "/api/books/remove") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      return removeMyBook(request, env, me);
    }
    if (path === "/api/books/opened") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      return markBookOpened(request, env, me);
    }

    // ---- 上传书的文件与封面（按账号可见性把关）----
    if (path.startsWith("/bookfile/")) return serveBookFile(request, env, me, path.slice(10), url);
    if (path.startsWith("/bookcover/")) return serveBookCover(env, me, path.slice(11));

    // ---- 管理员后台 ----
    if (path === "/admin") {
      if (me.role !== "admin") return html(forbiddenHtml(), 403);
      return html(await adminHtml(env), 200);
    }
    if (path.startsWith("/api/admin/")) {
      if (me.role !== "admin") return json({ ok: false, error: "admin only" }, 403);
      return adminApi(request, url, env, me, path);
    }

    // ---- 书架：静态 books.json 与数据库里的书合并（按账号过滤）----
    if (path === "/books.json") return mergedBooksJson(request, env, me);

    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ 账号 */

function accounts(env) {
  const out = [];
  const lu = env.READER_USER || env.AUTH_USER || "";
  const lp = env.READER_PASS || env.AUTH_PASS || "";
  const au = env.ADMIN_USER || "";
  const ap = env.ADMIN_PASS || "";

  if (lu) out.push({ user: lu, pass: lp, role: "child", name: env.CHILD_NAME || "孩子", label: "孩子" });
  if (au && ap) {
    if (au === lu) out[0].role = "admin";
    else out.push({ user: au, pass: ap, role: "admin", name: "管理员", label: "管理员" });
  }
  // 第三个账号：试用/体验用，数据独立、不计入学生统计
  const tu = env.TEST_USER || "";
  const tp = env.TEST_PASS || "";
  if (tu && tp && !out.some((a) => a.user === tu)) {
    out.push({ user: tu, pass: tp, role: "test", name: "试用", label: "试用" });
  }
  return out;
}

async function sessionSecret(env) {
  if (env.AUTH_SECRET) return "v1::" + env.AUTH_SECRET;
  return "fallback::" + (env.READER_PASS || env.AUTH_PASS || "no-secret");
}

function ver(env) {
  return String(env.AUTH_VER || "1");
}

async function issueCookie(user, secret, env, location) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const sig = await sign(secret, `${user}|${exp}|${ver(env)}`);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": `${COOKIE}=${b64url(user)}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`,
      "cache-control": "no-store",
    },
  });
}

async function handleLogin(request, url, secret, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return html(loginHtml("/", "提交的内容读不出来，请再试一次。", false), 400);
  }
  const u = String(form.get("u") || "").trim();
  const p = String(form.get("p") || "");
  const next = safeNext(form.get("next"));
  const ip = await ipKey(request, env);
  const regOpen = (await getAppSetting(env, "register_open")) === "1";

  if (await tooManyFails(env, ip)) {
    return html(loginHtml(next, "尝试次数过多，请 15 分钟后再试。", regOpen), 429);
  }

  const hit = await authenticate(env, u, p);
  if (hit) {
    await clearFails(env, ip);
    return issueCookie(hit.user, secret, env, next);
  }
  await noteFail(env, ip);
  return html(loginHtml(next, "用户名或密码不对，请再试一次。", regOpen), 401);
}

async function session(request, secret, env) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 3) return null;
  const [sub, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  let user;
  try {
    user = atobUrl(sub);
  } catch (e) {
    return null;
  }
  const want = await sign(secret, `${user}|${exp}|${ver(env)}`);
  if (!eq(sig, want)) return null;
  return resolveIdentity(env, user);
}

async function sign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlBytes(new Uint8Array(mac));
}

function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function atobUrl(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function eq(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

function safeNext(v) {
  const s = String(v || "/library.html");
  if (!s.startsWith("/") || s.startsWith("//")) return "/library.html";
  if (s === "/logout") return "/library.html";
  return s;
}

/* -------------------------------------------------------------- 限流/IP */

async function ipKey(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  const mac = await sign("ip::" + (env.AUTH_SECRET || "x"), ip);
  return mac.slice(0, 24);
}

async function tooManyFails(env, ip) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?")
      .bind(ip, Date.now() - LIMIT_WINDOW_MS)
      .first();
    return (r && r.n ? r.n : 0) >= LIMIT_FAILS;
  } catch (e) {
    return false;
  }
}

async function noteFail(env, ip) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO login_fails (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();
    await env.DB.prepare("DELETE FROM login_fails WHERE ts < ?").bind(Date.now() - 7 * 24 * 3600e3).run();
  } catch (e) {}
}

async function clearFails(env, ip) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("DELETE FROM login_fails WHERE ip = ?").bind(ip).run();
  } catch (e) {}
}

/* ------------------------------------------------------------ 写入记录 */

function loginHtml(next, err, regOpen) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 阅读空间</title>
<meta name="robots" content="noindex"><style>${LOGIN_CSS}</style></head><body>
<form class="card" method="POST" action="/login">
  <div class="mark">阅</div>
  <h1>阅读空间</h1>
  <p class="sub">请先登录</p>
  ${err ? `<p class="err">${err}</p>` : ""}
  <div class="row"><label for="u">用户名</label>
    <input id="u" name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div>
  <div class="row"><label for="p">密码</label>
    <input id="p" name="p" type="password" autocomplete="current-password" required></div>
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <button type="submit">进入</button>
  ${regOpen ? `<p class="foot">没有账号？<a href="/register" style="color:#c2352b">注册一个</a></p>` : ""}
  <p class="foot">家庭自用 · 登录状态保留 7 天</p>
</form></body></html>`;
}

const LOGIN_CSS = `
  :root{--paper:#f5f0e7;--ink:#22262b;--muted:#6b6459;--line:#e4d9c5;--red:#c2352b}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    background:var(--paper);color:var(--ink);
    font:16px/1.7 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
    background-image:radial-gradient(circle at 16% 6%,rgba(194,53,43,.07),transparent 42%),
                     radial-gradient(circle at 88% 92%,rgba(44,122,123,.06),transparent 44%);
    background-repeat:no-repeat}
  .card{width:100%;max-width:380px;background:#fffdf9;border:1px solid var(--line);
    border-radius:20px;padding:30px 28px 26px;box-shadow:0 2px 6px rgba(60,45,25,.06),0 22px 52px rgba(60,45,25,.12)}
  .mark{width:44px;height:44px;border-radius:50%;background:var(--red);color:#fff;display:grid;
    place-items:center;font-family:Georgia,"Songti SC",serif;font-size:22px;font-weight:700;
    margin:0 auto 14px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.5),0 4px 12px rgba(194,53,43,.3)}
  h1{font-family:Georgia,"Songti SC",serif;font-size:21px;letter-spacing:.06em;text-align:center;margin:0 0 4px}
  .sub{text-align:center;font-size:12.5px;color:var(--muted);letter-spacing:.1em;margin:0 0 22px}
  label{display:block;font-size:12.5px;color:var(--muted);margin:0 0 6px;letter-spacing:.08em}
  input{width:100%;font:inherit;font-size:15px;padding:11px 13px;border:1px solid var(--line);
    border-radius:10px;background:#fff;color:var(--ink);outline:none;transition:.16s}
  input:focus{border-color:var(--red);box-shadow:0 0 0 3px rgba(194,53,43,.12)}
  .row{margin-bottom:14px}
  button{width:100%;font:inherit;font-size:15px;font-weight:600;padding:12px;border:none;
    border-radius:10px;background:var(--ink);color:#fff;cursor:pointer;margin-top:6px;transition:.16s}
  button:hover{background:var(--red)}
  .err{margin:0 0 14px;padding:9px 12px;border-radius:8px;background:#fdeeec;color:#a3312a;
    font-size:13px;border-left:3px solid var(--red)}
  .foot{margin-top:18px;text-align:center;font-size:11.5px;color:#9a9184;line-height:1.6}
`;

function setupHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>待配置 · 阅读空间</title>
<meta name="robots" content="noindex"><style>${LOGIN_CSS}</style></head><body>
<div class="card">
  <div class="mark">阅</div>
  <h1>还差一步</h1>
  <p class="sub">未设置登录账号，内容已锁定</p>
  <p style="font-size:13.5px;color:#4b4335;margin:0">到 Cloudflare 后台添加环境变量，页面就能用了：</p>
  <ol style="padding-left:18px;margin:10px 0 0;font-size:13px;color:#4b4335">
    <li>Workers &amp; Pages → 你的项目 → Settings</li>
    <li>Variables and Secrets 里加 <code>READER_USER</code>（阅读者账号）</li>
    <li>再加 <code>READER_PASS</code>（密码，类型选 Secret）</li>
    <li>需要管理员时加 <code>ADMIN_USER</code> / <code>ADMIN_PASS</code></li>
    <li>强烈建议加 <code>AUTH_SECRET</code>（32 字节以上随机串），签名密钥不再依赖密码</li>
    <li>划词翻译需要 <code>OPENROUTER_KEY</code></li>
    <li>改完变量要重新部署一次才生效</li>
  </ol>
</div></body></html>`;
}

/* ------------------------------------------------------------ 工具 */

function html(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ---------- 阅读空间 ---------- */

async function saveReadingProgress(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const book = String(b.book || "").slice(0, 60);
  const cfi = String(b.cfi || "").slice(0, 400);
  const pct = Math.max(0, Math.min(1, Number(b.percent) || 0));
  if (!book || !cfi) return json({ ok: false, error: "missing" }, 400);
  await env.DB.prepare(
    "INSERT INTO reading_progress (user, book, cfi, percent, updated_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(user, book) DO UPDATE SET cfi=excluded.cfi, percent=excluded.percent, updated_at=excluded.updated_at"
  ).bind(me.user, book, cfi, pct, Date.now()).run();
  return json({ ok: true });
}

async function getReadingProgress(url, env, me) {
  if (url.searchParams.get("all")) {
    const r = await env.DB.prepare(
      "SELECT book, cfi, percent, updated_at FROM reading_progress WHERE user = ? ORDER BY updated_at DESC"
    ).bind(me.user).all();
    return json({ items: r.results || [] });
  }
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  if (!book) return json({ ok: false, error: "missing book" }, 400);
  const row = await env.DB.prepare(
    "SELECT book, cfi, percent, updated_at FROM reading_progress WHERE user = ? AND book = ?"
  ).bind(me.user, book).first();
  return json(row || {});
}

async function listReadingBookmarks(url, env, me) {
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  const cols = "SELECT id, book, cfi, label, percent, created_at FROM reading_bookmarks WHERE user = ?";
  const r = book
    ? await env.DB.prepare(cols + " AND book = ? ORDER BY created_at DESC").bind(me.user, book).all()
    : await env.DB.prepare(cols + " ORDER BY created_at DESC").bind(me.user).all();
  return json({ items: r.results || [] });
}

async function addReadingBookmark(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const book = String(b.book || "").slice(0, 60);
  const cfi = String(b.cfi || "").slice(0, 400);
  if (!book || !cfi) return json({ ok: false, error: "missing" }, 400);
  const id = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : "b" + Date.now();
  await env.DB.prepare(
    "INSERT INTO reading_bookmarks (id, user, book, cfi, label, percent, created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, me.user, book, cfi, String(b.label || "").slice(0, 80),
         Math.max(0, Math.min(1, Number(b.percent) || 0)), Date.now()).run();
  return json({ ok: true, id });
}

async function delReadingBookmark(url, env, me) {
  const id = String(url.searchParams.get("id") || "");
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  await env.DB.prepare("DELETE FROM reading_bookmarks WHERE id = ? AND user = ?").bind(id, me.user).run();
  return json({ ok: true });
}

/* ---------- 翻译与生词 ---------- */

// 翻译链（2026-11-03 定版，用户规则）：阅读中查词缓存未命中时优先
// DeepSeek flash（先严格模板、后软约束），免费三路对冲（ultra 软约束、
// dots 严格模板、nano 软约束）只作兜底；后台预热严格只用免费模型
// （见 prewarm_books.py / enrich_vocab.py 的 translate_free）。
const TR_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const TR_FALLBACK_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const TR_FALLBACK2_MODEL = "~deepseek/deepseek-flash-latest";

/* Structured Outputs（严格模板）：不是所有模型都支持——2026-11-03 实测
   dots-3-note 免费档与 DeepSeek flash 支持，ultra / nano 不支持（强加
   response_format + require_parameters 会直接 404）。支持的 super-vl 免费
   档实测回空太多（多次 0 成功），故免费严格位用 dots（约半数一次合格，
   失败就当没这回事）。严格版只用在 dots 对冲与 DeepSeek 兜底上，中间仍
   走软约束链。拿到 JSON 后统一拼回现有三行文本，下游缓存/生词本都不用改。 */
const TR_STRICT_MODEL = "dots-studio/dots-3-note-preview:free";
/* 单词严格模板用扁平字段：2026-11-03 实测 DeepSeek 的 structured 端点
   对嵌套数组 schema 一律回空，扁平的 senses_text（"n. 义一；v. 义二"）
   则稳定返回，拿到后在本地拆成义项数组。 */
const WORD_SCHEMA = {
  type: "object",
  properties: {
    uk_ipa: { type: "string", description: "英式国际音标，两侧带斜杠，如 /ˈmɪərkæt/" },
    us_ipa: { type: "string", description: "美式国际音标，两侧带斜杠" },
    senses_text: { type: "string", description: "前三个常用义项，用；分隔。每项：词性缩写 中文义 | 简单英文例句(≤12词) | 例句中译。如：n. 魔杖 | The witch waves her wand. | 女巫挥舞她的魔杖" },
    example_en: { type: "string", description: "第一个义项的例句（与 senses_text 里第一个义项的例句相同）" },
    example_zh: { type: "string", description: "上面例句的中文翻译" },
  },
  required: ["uk_ipa", "us_ipa", "senses_text"],
  additionalProperties: false,
};
const PHRASE_SCHEMA = {
  type: "object",
  properties: {
    pos: { type: "string", description: "词性或短语类型，如 v. phr." },
    def_zh: { type: "string", description: "中文释义，不超过 40 字" },
    example_en: { type: "string", description: "一句简短英文例句" },
    example_zh: { type: "string", description: "上面例句的中文翻译" },
  },
  required: ["pos", "def_zh", "example_en", "example_zh"],
  additionalProperties: false,
};
const SENT_SCHEMA = {
  type: "object",
  properties: {
    translation_zh: { type: "string", description: "整句的中文译文" },
  },
  required: ["translation_zh"],
  additionalProperties: false,
};

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normWord(w) {
  return String(w == null ? "" : w)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’\(\[\{]+|[\s"'“”‘’\)\]\}\,.;:!?]+$/g, "")
    .trim()
    .slice(0, 80);
}

/* 是不是"一个单词"（单词才要音标；短语和整句不要） */
function isSingleWord(t) {
  const s = String(t || "").trim();
  if (!s || s.length > 28) return false;
  // 只认纯字母（可带连字符、撇号），像 meerkats / well-known / don't
  return /^[A-Za-z][A-Za-z'’\-]*$/.test(s);
}

/* 从译文里抠出 /.../ 形式的音标，没有就返回空串 */
function pickIpa(s) {
  const m = /(?:^|\n)[ \t]*(\/[^\/\n]{1,40}\/)/.exec(String(s || ""));
  return m ? m[1] : "";
}

/* 单词译文是三行：释义 / 英文例句 / 例句中文翻译，拆开给前端分块展示 */
function splitWordText(t) {
  const lines = String(t || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return { def: "", example: "", exampleZh: "" };
  // Models sometimes split the gloss itself across lines (noun senses on
  // line 1, verb senses on line 2, ...). Blindly taking line 2 as the
  // example then shifts everything -- the "example" shows a gloss and
  // the real example lands in the translation slot. Walk the lines:
  // Chinese gloss lines merge into the definition until the first line
  // that reads as an English sentence; that line is the example and the
  // next one its translation.
  const hasZh = (l) => /[\u4e00-\u9fff]/.test(l);
  const looksEnSentence = (l) => !hasZh(l) && /[A-Za-z]/.test(l) && l.split(/\s+/).length >= 3;
  const defParts = [lines[0]];
  let i = 1;
  while (i < lines.length && hasZh(lines[i])) { defParts.push(lines[i]); i++; }
  if (i < lines.length && looksEnSentence(lines[i])) {
    return { def: defParts.join("\n"), example: lines[i], exampleZh: lines[i + 1] || "" };
  }
  return { def: lines[0] || "", example: lines[1] || "", exampleZh: lines[2] || "" };
}

/* 模型偶尔会把思考过程写进正文（尤其实时推理类模型），这里做一次兜底清洗 */
const COT_TELL = /(thinking process|思考过程|analyze the request|output format|draft\s*[:：]|task\s*[:：]|input\s*[:：]|step\s*\d)/i;

function looksLikeThinking(s) {
  return COT_TELL.test(String(s || ""));
}

function salvageAnswer(raw) {
  const lines = String(raw || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const keep = lines.filter(
    (l) => !COT_TELL.test(l) && !/^#+\s/.test(l) && /[\u4e00-\u9fa5]/.test(l) && l.length <= 120
  );
  // 模型一般把结论放在最后，取末尾两行
  return keep.slice(-2).join("\n");
}

/* 词典语体标记（〈口〉=口语、〈正式〉、〈俚〉等）是词典编纂符号，
   模型会原样写进释义（有时还写成 ASCII 的 <口>），对读者没有意义，
   统一剥掉。只剥短小的尖括号标签，不动正文里的引文与例句。 */
function stripLabels(s) {
  return String(s || "")
    .replace(/[<〈][^>〉\n]{0,4}?(口|正式|俚|俗|方|旧|书面|文言|喻|婉|贬|褒|敬|谦|儿)[^>〉\n]{0,3}?[>〉]/g, "")
    .replace(/\s{2,}/g, " ");
}

function polishTranslation(raw) {
  let s = stripLabels(String(raw || "").replace(/\r/g, "")).trim();
  if (!s) return "";
  s = s.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
  if (looksLikeThinking(s)) s = salvageAnswer(s);
  s = s.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").trim();
  s = s.replace(/^(译文|翻译|中文|答案)\s*[:：]\s*/i, "").trim();
  return s.slice(0, 600).trim();
}

function usableTranslation(s) {
  return !!s && /[\u4e00-\u9fa5]/.test(s) && !looksLikeThinking(s) && s.length <= 500;
}

async function handleTranslate(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const text = String(b.text || "").trim().slice(0, 600);
  if (!text) return json({ ok: false, error: "empty" }, 400);
  if (!env.OPENROUTER_KEY) {
    return json({ ok: false, error: "no_key", hint: "还没在后台配置 OPENROUTER_KEY" }, 501);
  }
  const r = await translateCore(env, me, text);
  if (!r.ok) return json({ ok: false, error: r.error, hint: r.hint }, r.status || 502);
  const out = { ok: true, text: r.text, ipa: r.ipa, cached: r.cached, is_word: isSingleWord(text) };
  if (out.is_word) {
    const p = splitWordText(r.text);
    out.example = p.example;
    out.example_zh = p.exampleZh;
    // 双音标与结构化义项（前三义）从全局单词库附带返回，供阅读器展示
    try {
      await ensureWordStore(env);
      const ws = await env.DB.prepare(
        "SELECT uk_ipa, us_ipa, senses FROM word_store WHERE word = ?"
      ).bind(normWord(text)).first();
      if (ws) {
        if (ws.uk_ipa) out.uk_ipa = ws.uk_ipa;
        if (ws.us_ipa) out.us_ipa = ws.us_ipa;
        if (ws.senses) {
          try {
            const ss = JSON.parse(ws.senses);
            if (Array.isArray(ss) && ss.length) {
              out.senses = ss;
              // 例句优先用义项自带的（结构化数据），不依赖文本拆行
              if (ss[0] && ss[0].ex_en) {
                out.example = ss[0].ex_en;
                if (ss[0].ex_zh) out.example_zh = ss[0].ex_zh;
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    // 查词时把所在原句也翻出来，前端连原句带译文一起展示
    const sentence = String(b.sentence || "").trim().slice(0, 400);
    if (sentence && sentence !== text) {
      try {
        const sr = await translateCore(env, me, sentence);
        if (sr.ok) out.sentence_zh = sr.text;
      } catch (e) { /* 原句翻译拿不到，不影响单词本身 */ }
    }
  }
  return json(out);
}

/* 翻译主体：查缓存 → 免费模型对冲 → DeepSeek 兜底 → 存缓存。
   返回 { ok, text, ipa, cached } 或 { ok:false, status, error, hint }。 */
async function translateCore(env, me, text) {
  const isWord = isSingleWord(text);
  // 版本前缀：zh5 起单词例句要带中文翻译，旧缓存自动失效
  const hash = await sha256hex("zh5|" + text);
  const hit = await env.DB.prepare("SELECT dst FROM translations WHERE hash = ?").bind(hash).first();
  if (hit && hit.dst) {
    await recordSentence(env, me, text, hit.dst);
    return { ok: true, text: hit.dst, ipa: pickIpa(hit.dst), cached: true };
  }
  // 全局单词库：别的账户/预热已经查过的词，直接拼装返回，不再问模型
  if (isWord && env.DB) {
    try {
      await ensureWordStore(env);
      const ws = await env.DB.prepare(
        "SELECT def, example, example_zh FROM word_store WHERE word = ?"
      ).bind(normWord(text)).first();
      if (ws && ws.def) {
        const joined = [ws.def, ws.example, ws.example_zh].filter(Boolean).join("\n");
        return { ok: true, text: joined, ipa: pickIpa(joined), cached: true };
      }
    } catch (e) {}
  }

  // 主模型出不来可用结果（空、报错、把思考过程当答案）就换备用模型再试
  const plans = [
    { model: env.TRANSLATE_MODEL || TR_DEFAULT_MODEL, max: 500 },
    { model: env.TRANSLATE_FALLBACK || TR_FALLBACK_MODEL, max: 900 },
    { model: env.TRANSLATE_FALLBACK2 || TR_FALLBACK2_MODEL, max: 1400 },
  ];
  const SYS = isWord
    ? "英汉词典。只输出三行，不要思考过程、不要步骤、不要 Markdown、不要加粗。" +
      "第一行：「/国际音标/ 词性 中文释义」，音标两侧必须加斜杠，例如 /ˈmɪərkæt/ n. 猫鼬；" +
      "第二行：一句简短英文例句；第三行：第二行例句的中文翻译。中文释义不超过 40 字。"
    : "英汉词典。直接给出最终答案，不要思考过程、不要步骤、不要 Markdown。" +
      "词组：第一行写词性 + 中文释义，第二行给一句简短英文例句，第三行给例句的中文翻译；句子：只给译文。中文不超过 60 字。";
  let clean = "";          // 最终采用
  let noIpa = "";          // 备胎：有中文释义但没音标（单词才会用到）
  let noIpaModel = "";
  let lastErr = "";
  let usedModel = "";

  // 单次尝试，带时间盒：免费大模型在 OpenRouter 排队时能磨一分钟以上，
  // 没有超时的话它会吃掉全部时间，后面的备选永远轮不上，网关先把连接掐了。
  // 单词要求必须带音标：没有音标就当"还不够好"，先留作备胎，换备用模型再试；
  // 但都没音标也不会报错，返回有释义的版本就行。
  async function tryPlan(plan, timeoutMs) {
    const body = {
      model: plan.model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: text },
      ],
      max_tokens: plan.max,
      temperature: 0,
      reasoning: { exclude: true },   // 思考过程别回传，省得混进正文
    };
    const hdrs = {
      "content-type": "application/json",
      authorization: "Bearer " + env.OPENROUTER_KEY,
      // OpenRouter 用它做用量归因，可选
      "X-Title": "reading-space",
    };
    if (env.SITE_URL) hdrs["HTTP-Referer"] = env.SITE_URL;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { kind: "fail", err: "network" };
    }
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { kind: "fail", err: "upstream " + r.status + " " + t.slice(0, 120) };
    }
    const j = await r.json().catch(() => null);
    const msg = (((j || {}).choices || [])[0] || {}).message || {};
    // 只认 content；reasoning 一律不用（它装的是模型的思考草稿，不是译文）
    const got = polishTranslation(msg.content || "");
    if (!usableTranslation(got)) {
      return { kind: "fail", err: "unusable (" + ((j || {}).model || "?") + ")", model: plan.model };
    }
    if (!isWord) return { kind: "clean", text: got, model: plan.model };
    if (pickIpa(got) && splitWordText(got).example) return { kind: "clean", text: got, model: plan.model };  // 够好，收下
    return { kind: "noipa", text: got, model: plan.model };   // 有释义但缺音标/例句，先留作备胎
  }

  /* 短语与整句分流：短语（≤4 个词、无句末标点）要释义+例句，整句只要译文 */
  const isPhrase = !isWord && text.split(/\s+/).filter(Boolean).length <= 4 && !/[.!?。！？]/.test(text);

  /* 严格模板单次尝试：response_format=json_schema + require_parameters。
     只喂给支持 structured_outputs 的模型（dots / DeepSeek）；不支持的
     供应商会被 OpenRouter 直接挡下（404），不会瞎编格式。拿到 JSON 后做
     字段与中文校验，再拼回现有三行文本，缓存与下游格式完全不变。 */
  async function tryStrictPlan(model, timeoutMs) {
    const schema = isWord ? WORD_SCHEMA : (isPhrase ? PHRASE_SCHEMA : SENT_SCHEMA);
    const name = isWord ? "word_translation" : (isPhrase ? "phrase_translation" : "sentence_translation");
    const body = {
      model,
      messages: [
        { role: "system", content: "英汉词典。严格按给定 JSON 模板输出，不要输出模板以外的任何内容。" },
        { role: "user", content: text },
      ],
      max_tokens: 700,
      temperature: 0,
      reasoning: { exclude: true },
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      provider: { require_parameters: true },
    };
    const hdrs = {
      "content-type": "application/json",
      authorization: "Bearer " + env.OPENROUTER_KEY,
      "X-Title": "reading-space",
    };
    if (env.SITE_URL) hdrs["HTTP-Referer"] = env.SITE_URL;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { kind: "fail", err: "strict network" };
    }
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { kind: "fail", err: "strict upstream " + r.status + " " + t.slice(0, 120) };
    }
    try {
      const j = await r.json().catch(() => null);
      const msg = (((j || {}).choices || [])[0] || {}).message || {};
      const raw = String(msg.content || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
      const d = JSON.parse(raw);
      const S = (v) => String(v == null ? "" : v).trim();
      const hasZh = (v) => /[\u4e00-\u9fa5]/.test(v);
      /* 严格模型偶尔把词性写全称、把词性混进释义、或在音标里夹杂符号，统一收拾 */
      const POS_MAP = { noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", preposition: "prep.", conjunction: "conj.", pronoun: "pron.", interjection: "int.", article: "art.", auxiliary: "aux." };
      const normPos = (p) => {
        const low = p.toLowerCase().replace(/\.$/, "");
        if (POS_MAP[low]) return POS_MAP[low];
        if (/^(n|v|adj|adv|prep|conj|pron|int|art|aux)$/.test(low)) return low + ".";
        return p;
      };
      const cleanDef = (defZh, pos) => {
        let t = stripLabels(defZh).replace(/^(及物动词|不及物动词|形容词|名词|动词|副词|介词|连词|代词|感叹词|数词|冠词)\s*/, "");
        const pl = pos.toLowerCase().replace(/\.$/, "");
        if (pl && t.toLowerCase().startsWith(pl)) t = t.slice(pl.length).replace(/^[.、，,：:\s]+/, "");
        return t.trim();
      };
      let got = "";
      let entry = null;
      if (isWord) {
        const slashIpa = (v) => {
          const t = S(v).replace(/^\/+|\/+$/g, "").replace(/^[\[\]:\s]+|[\[\]:\s]+$/g, "");
          return t ? "/" + t + "/" : "";
        };
        let senses = [];
        if (typeof d.senses_text === "string" && d.senses_text) {
          // v2 segment: "n. 义 | Simple example. | 例句译" — a segment
          // starting with a POS token opens a new sense carrying its own
          // simple example; bare segments continue the previous gloss.
          for (const seg of d.senses_text.split(/[;；]/)) {
            const raw = seg.trim();
            if (!raw) continue;
            const parts = raw.split(/[|｜]/).map((x) => x.trim());
            const t = parts[0];
            const exEn = (parts[1] || "").slice(0, 200);
            const exZh = (parts[2] || "").slice(0, 120);
            const pm = t.match(/^([A-Za-z]+\.?|名词|动词|形容词|副词|介词|连词|代词|感叹词|数词|冠词)\s+(.+)$/);
            if (pm && hasZh(pm[2])) {
              if (senses.length < 3) senses.push({ pos: normPos(pm[1]), zh: cleanDef(pm[2], normPos(pm[1])).slice(0, 60), ex_en: exEn, ex_zh: exZh });
              else if (senses.length) senses[senses.length - 1].zh += ";" + t;
            } else if (senses.length && exEn && !senses[senses.length - 1].ex_en) {
              senses[senses.length - 1].ex_en = exEn;
              senses[senses.length - 1].ex_zh = exZh;
            } else if (senses.length && hasZh(t)) {
              senses[senses.length - 1].zh += ";" + t;
            } else if (hasZh(t)) {
              senses.push({ pos: "", zh: t.slice(0, 60), ex_en: exEn, ex_zh: exZh });
            }
          }
        }
        let ukIpa = slashIpa(d.uk_ipa), usIpa = slashIpa(d.us_ipa);
        if (!senses.length && d.def_zh) {
          // tolerate the old single-sense shape
          const pos = normPos(S(d.pos));
          const zh = cleanDef(S(d.def_zh), pos);
          if (zh && hasZh(zh)) senses = [{ pos, zh }];
          ukIpa = ukIpa || slashIpa(d.ipa);
          usIpa = usIpa || ukIpa;
        }
        let ex = S(d.example_en), exZh = S(d.example_zh);
        if (senses.length && senses[0].ex_en) { ex = senses[0].ex_en; exZh = senses[0].ex_zh || exZh; }
        if (senses.length && ex && !senses[0].ex_en) { senses[0].ex_en = ex; senses[0].ex_zh = exZh; }
        if (!senses.length || !ukIpa || !ex || !exZh || !hasZh(exZh)) {
          return { kind: "fail", err: "strict invalid fields", model };
        }
        entry = { uk_ipa: ukIpa, us_ipa: usIpa, senses, example_en: ex, example_zh: exZh };
        const defLine = senses.map((s, i) =>
          (i === 0 ? ukIpa + " " : "") + [s.pos, s.zh].filter(Boolean).join(" ")).join("; ");
        got = defLine + "\n" + ex + "\n" + exZh;
      } else if (isPhrase) {
        const pos = normPos(S(d.pos));
        const defZh = cleanDef(S(d.def_zh), pos);
        const ex = S(d.example_en), exZh = S(d.example_zh);
        if (!defZh || !ex || !exZh || !hasZh(defZh) || !hasZh(exZh)) {
          return { kind: "fail", err: "strict invalid fields", model };
        }
        got = [pos, defZh].filter(Boolean).join(" ") + "\n" + ex + "\n" + exZh;
      } else {
        got = S(d.translation_zh);
        if (!hasZh(got)) return { kind: "fail", err: "strict invalid fields", model };
      }
      got = polishTranslation(got);
      if (!usableTranslation(got)) return { kind: "fail", err: "strict unusable", model };
      if (isWord && !pickIpa(got)) return { kind: "fail", err: "strict no ipa", model };
      return { kind: "clean", text: got, model, entry };
    } catch (e) {
      return { kind: "fail", err: "strict parse", model };
    }
  }

  let cleanEntry = null;
  function absorb(res) {
    if (!res) return;
    if (res.kind === "clean" && !clean) {
      clean = res.text;
      usedModel = res.model;
      if (res.entry) cleanEntry = res.entry;
    } else if (res.kind === "noipa" && !noIpa) {
      noIpa = res.text;
      noIpaModel = res.model;
    } else if (res.err) {
      lastErr = res.err;
    }
  }

  // 阅读中查词、缓存未命中时优先 DeepSeek（用户规则）：先严格模板
  // （双音标 + 前三义），不成再软约束；DeepSeek 都没出可用结果时，
  // 才轮到下面的免费三路对冲兜底。
  absorb(await tryStrictPlan(plans[2].model, 25000));
  if (!clean) absorb(await tryPlan(plans[2], 25000));

  // 免费三路对冲：ultra 软约束（质量主力）→ dots 严格模板 → nano 软约束。
  // 先发第一个；它先结束却没出最终答案就立刻发下一个，6 秒还没结束也把
  // 下一个发出去——谁先给出够好的答案就用谁。
  const freeAttempts = [
    () => tryPlan(plans[0], 25000),
    () => tryStrictPlan(env.TRANSLATE_STRICT || TR_STRICT_MODEL, 15000),
    () => tryPlan(plans[1], 25000),
  ];
  if (!clean) await new Promise((resolve) => {
    const launched = new Set();
    let settled = 0, finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    const nextIdx = () => {
      for (let i = 0; i < freeAttempts.length; i++) if (!launched.has(i)) return i;
      return -1;
    };
    const launch = (idx) => {
      if (idx < 0 || finished || launched.has(idx)) return;
      launched.add(idx);
      freeAttempts[idx]().then((res) => {
        absorb(res);
        settled++;
        if (clean) return done();
        const n = nextIdx();
        if (n >= 0) launch(n);
        if (settled >= freeAttempts.length) done();
      });
    };
    launch(0);
    setTimeout(() => { if (!finished && !clean) { const n = nextIdx(); if (n >= 0) launch(n); } }, 6000);
  });
  if (!clean && noIpa) usedModel = noIpaModel;
  if (!clean) clean = noIpa;             // 音标没要到，至少把释义给出来
  if (!usableTranslation(clean)) {
    return { ok: false, status: 502, error: lastErr || "translate failed", hint: "翻译服务暂时不可用，稍后再试" };
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO translations (hash, src, dst, model, created_at) VALUES (?,?,?,?,?)"
  ).bind(hash, text.slice(0, 300), clean.slice(0, 1200), usedModel, Date.now()).run();
  if (isWord) {
    try {
      if (cleanEntry) {
        const parts = splitWordText(clean);
        await upsertWordStore(env, normWord(text), {
          def: parts.def, example: cleanEntry.example_en || parts.example,
          exampleZh: cleanEntry.example_zh || parts.exampleZh,
          ukIpa: cleanEntry.uk_ipa || "", usIpa: cleanEntry.us_ipa || "",
          senses: cleanEntry.senses || null,
        });
      } else {
        await upsertWordStore(env, normWord(text), splitWordText(clean));
      }
    } catch (e) {}
  }
  await recordSentence(env, me, text, clean);

  return { ok: true, text: clean, ipa: pickIpa(clean), cached: false };
}

/* ---------- 账号偏好 ---------- */

async function getSettings(env, me) {
  // 「划词自动入库」是全站开关，由管理员控制（后台管理页或管理员在阅读器里切换）；
  // 存 app_settings.auto_vocab，只有管理员能改；没有设置过时默认开启
  const out = { ok: true, auto_vocab: true, can_control: me.role === "admin", user: me.user, role: me.role };
  if (!env.DB) return json(out);
  out.auto_vocab = (await getAppSetting(env, "auto_vocab")) !== "0";
  return json(out);
}

async function saveSettings(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  if (!env.DB) return json({ ok: true, auto_vocab: !!b.auto_vocab, can_control: me.role === "admin", note: "no_db" });
  if (me.role !== "admin") {
    // 普通账号改不动：回当前全站状态，让阅读器把按钮恢复原样
    const cur = (await getAppSetting(env, "auto_vocab")) !== "0";
    return json({ ok: true, auto_vocab: cur, can_control: false, note: "admin_only" });
  }
  await setAppSetting(env, "auto_vocab", b.auto_vocab ? "1" : "0");
  return json({ ok: true, auto_vocab: !!b.auto_vocab, can_control: true });
}

let _vocabColsOk = false;
async function ensureVocabCols(env) {
  // 老库缺哪列补哪列，逐列探（新库 schema.sql 已带全部列）
  if (_vocabColsOk || !env.DB) return;
  const want = [
    ["mastered", "INTEGER NOT NULL DEFAULT 0"],
    ["mastered_at", "INTEGER"],
    ["sentence_zh", "TEXT"],
    ["example", "TEXT"],
    ["example_zh", "TEXT"],
    ["uk_ipa", "TEXT"],
    ["us_ipa", "TEXT"],
  ];
  for (const [col, type] of want) {
    try { await env.DB.prepare("SELECT " + col + " FROM vocab LIMIT 1").all(); }
    catch (e) {
      try { await env.DB.prepare("ALTER TABLE vocab ADD COLUMN " + col + " " + type).run(); } catch (e2) {}
    }
  }
  _vocabColsOk = true;
}

let _vocabTablesOk = false;
async function ensureVocabTables(env) {
  // vocab_contexts：一个生词在多处被划到时，每个原句各存一行（带书名与译文）。
  // sentence_audio：原句的英/美两版录音，后台慢慢生成，按句子哈希共享。
  if (_vocabTablesOk || !env.DB) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS vocab_contexts (" +
      "user TEXT NOT NULL, word TEXT NOT NULL, book TEXT NOT NULL, sentence TEXT NOT NULL, " +
      "sentence_zh TEXT, first_at INTEGER, last_at INTEGER, hits INTEGER NOT NULL DEFAULT 1, " +
      "PRIMARY KEY (user, word, book, sentence))"
    ).run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS sentence_audio (" +
      "hash TEXT NOT NULL, accent TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER, " +
      "PRIMARY KEY (hash, accent))"
    ).run();
  } catch (e) {}
  _vocabTablesOk = true;
}

let _wordStoreOk = false;
async function ensureWordStore(env) {
  // 全局单词库：词的内容（释义/例句/双音标/单词录音）只存一份，各账户共用；
  // vocab 行只记「谁在哪本书遇见过这个词」的关系。book_words 是缓存库的
  // 书-词索引（预热产出：每本书里 800 常用词外的词 + 它在书里的第一个原句）。
  if (_wordStoreOk || !env.DB) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS word_store (" +
      "word TEXT PRIMARY KEY, def TEXT, example TEXT, example_zh TEXT, " +
      "uk_ipa TEXT, us_ipa TEXT, senses TEXT, updated_at INTEGER)"
    ).run();
    try { await env.DB.prepare("SELECT senses FROM word_store LIMIT 1").all(); }
    catch (e) {
      try { await env.DB.prepare("ALTER TABLE word_store ADD COLUMN senses TEXT").run(); } catch (e2) {}
    }
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS word_audio (" +
      "word TEXT NOT NULL, accent TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER, " +
      "PRIMARY KEY (word, accent))"
    ).run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS book_words (" +
      "book TEXT NOT NULL, word TEXT NOT NULL, sentence TEXT, " +
      "PRIMARY KEY (book, word, sentence))"
    ).run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS book_prewarm (" +
      "book TEXT PRIMARY KEY, total INTEGER, done INTEGER, status TEXT, updated_at INTEGER)"
    ).run();
  } catch (e) {}
  _wordStoreOk = true;
}

function mergeSenses(oldList, newList) {
  // Union by (pos, zh): a stored sense keeps its place and only gains a
  // missing example; a genuinely new sense appends with its own simple
  // example (user rule: same meaning/usage -> one example; a different
  // sense -> a new example). Cap 5.
  const out = [];
  const seen = new Set();
  for (const s of [...(oldList || []), ...(newList || [])]) {
    if (!s || typeof s !== "object") continue;
    const zh = String(s.zh || "").trim();
    if (!zh) continue;
    const key = String(s.pos || "") + "|" + zh;
    if (seen.has(key)) {
      const cur = out.find((x) => (String(x.pos || "") + "|" + String(x.zh || "").trim()) === key);
      if (cur && !cur.ex_en && s.ex_en) { cur.ex_en = s.ex_en; cur.ex_zh = s.ex_zh || ""; }
      continue;
    }
    seen.add(key);
    out.push({ pos: s.pos || "", zh, ex_en: s.ex_en || "", ex_zh: s.ex_zh || "" });
  }
  return out.slice(0, 5);
}

async function upsertWordStore(env, word, p) {
  // 标量字段只填空缺；义项按并集合并（同义项不重复、例句互补，
  // 新义项追加并自带例句），不再被"先到先得"冻住。
  if (!word || !p || !p.def) return;
  await ensureWordStore(env);
  let merged = null;
  if (Array.isArray(p.senses) && p.senses.length) {
    let oldSenses = [];
    try {
      const row = await env.DB.prepare("SELECT senses FROM word_store WHERE word = ?").bind(word).first();
      if (row && row.senses) oldSenses = JSON.parse(row.senses) || [];
    } catch (e) {}
    merged = mergeSenses(oldSenses, p.senses);
    if (merged.length && !p.example && merged[0].ex_en) {
      p = { ...p, example: merged[0].ex_en, exampleZh: merged[0].ex_zh || p.exampleZh || "" };
    }
  }
  const sensesJson = merged && merged.length ? JSON.stringify(merged) : "";
  await env.DB.prepare(
    "INSERT INTO word_store (word, def, example, example_zh, uk_ipa, us_ipa, senses, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(word) DO UPDATE SET " +
    "def = COALESCE(NULLIF(word_store.def,''), excluded.def), " +
    "example = COALESCE(NULLIF(word_store.example,''), excluded.example), " +
    "example_zh = COALESCE(NULLIF(word_store.example_zh,''), excluded.example_zh), " +
    "uk_ipa = COALESCE(NULLIF(word_store.uk_ipa,''), excluded.uk_ipa), " +
    "us_ipa = COALESCE(NULLIF(word_store.us_ipa,''), excluded.us_ipa), " +
    "senses = CASE WHEN excluded.senses = '' THEN word_store.senses ELSE excluded.senses END, " +
    "updated_at = excluded.updated_at"
  ).bind(word, p.def || "", p.example || "", p.exampleZh || "",
         p.ukIpa || "", p.usIpa || "", sensesJson, Date.now()).run();
}

async function serveWordAudio(url, env, me) {
  const w = normWord(url.searchParams.get("w") || "");
  const a = String(url.searchParams.get("a") || "");
  if (!w || (a !== "uk" && a !== "us")) return new Response("not found", { status: 404 });
  await ensureWordStore(env);
  const row = await env.DB.prepare("SELECT data FROM word_audio WHERE word = ? AND accent = ?").bind(w, a).first();
  if (!row || !row.data) return new Response("not found", { status: 404 });
  return new Response(blobBytes(row.data), {
    headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=31536000, immutable" },
  });
}

async function serveSentAudio(url, env, me) {
  const h = String(url.searchParams.get("h") || "");
  const a = String(url.searchParams.get("a") || "");
  if (!/^[0-9a-f]{64}$/.test(h) || (a !== "uk" && a !== "us")) return new Response("not found", { status: 404 });
  await ensureVocabTables(env);
  const row = await env.DB.prepare("SELECT data FROM sentence_audio WHERE hash = ? AND accent = ?").bind(h, a).first();
  if (!row || !row.data) return new Response("not found", { status: 404 });
  return new Response(blobBytes(row.data), {
    headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=31536000, immutable" },
  });
}

let _ubColsOk = false;
async function ensureUserBooksCols(env) {
  // user_books.last_open：最近打开时间，书架按它排序
  if (_ubColsOk || !env.DB) return;
  try { await env.DB.prepare("SELECT last_open FROM user_books LIMIT 1").all(); _ubColsOk = true; return; } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE user_books ADD COLUMN last_open INTEGER").run(); } catch (e) {}
  _ubColsOk = true;
}

/* 记一次「打开这本书」：只更新已有书架行，不授予可见性 */
async function touchBookOpen(env, me, id) {
  try {
    await ensureUserBooksCols(env);
    await env.DB.prepare(
      "UPDATE user_books SET last_open = ? WHERE user = ? AND book_id = ?"
    ).bind(Date.now(), me.user, id).run();
  } catch (e) {}
}

const _openTouchAt = new Map();
async function touchBookOpenThrottled(env, me, id) {
  const k = me.user + "|" + id;
  const now = Date.now();
  if (now - (_openTouchAt.get(k) || 0) < 60000) return;
  _openTouchAt.set(k, now);
  await touchBookOpen(env, me, id);
}

async function markBookOpened(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const id = String(b.id || "");
  if (!/^[0-9a-f]{16}$/.test(id)) return json({ ok: false, error: "bad id" }, 400);
  await touchBookOpen(env, me, id);
  return json({ ok: true });
}

async function setVocabMastered(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const word = normWord(b.word);
  const book = String(b.book || "").slice(0, 60);
  if (!word || !book) return json({ ok: false, error: "missing" }, 400);
  await ensureVocabCols(env);
  const m = b.mastered ? 1 : 0;
  await env.DB.prepare(
    "UPDATE vocab SET mastered = ?, mastered_at = ? WHERE user = ? AND word = ? AND book = ?"
  ).bind(m, m ? Date.now() : null, me.user, word, book).run();
  return json({ ok: true, mastered: !!m });
}

async function addVocab(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const word = normWord(b.word);
  const book = String(b.book || "").slice(0, 60);
  if (!word || !book) return json({ ok: false, error: "missing" }, 400);
  const now = Date.now();
  await ensureVocabCols(env);
  const sentenceZh = String(b.sentence_zh || "").slice(0, 600);
  const example = String(b.example || "").slice(0, 400);
  const exampleZh = String(b.example_zh || "").slice(0, 600);

  // fill=true：只是后台把译文补上，不算一次新的划词，hits 不动
  if (b.fill) {
    const tr = String(b.translation || "").slice(0, 600);
    if (tr) {
      await env.DB.prepare(
        "UPDATE vocab SET translation = ? WHERE user = ? AND word = ? AND book = ? AND (translation IS NULL OR translation = '')"
      ).bind(tr, me.user, word, book).run();
    }
    const extra = [["sentence_zh", sentenceZh], ["example", example], ["example_zh", exampleZh]];
    for (const [col, val] of extra) {
      if (!val) continue;
      await env.DB.prepare(
        "UPDATE vocab SET " + col + " = ? WHERE user = ? AND word = ? AND book = ? AND (" + col + " IS NULL OR " + col + " = '')"
      ).bind(val, me.user, word, book).run();
    }
    const row = await env.DB.prepare(
      "SELECT word, book, hits, translation FROM vocab WHERE user = ? AND word = ? AND book = ?"
    ).bind(me.user, word, book).first();
    return json({ ok: true, item: row || null, fill: true });
  }
  await env.DB.prepare(
    "INSERT INTO vocab (user, word, book, cfi, sentence, translation, note, hits, first_at, last_at, src, sentence_zh, example, example_zh) " +
    "VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?) " +
    "ON CONFLICT(user, word, book) DO UPDATE SET " +
    "hits = vocab.hits + 1, last_at = excluded.last_at, cfi = excluded.cfi, " +
    "sentence = COALESCE(NULLIF(excluded.sentence,''), vocab.sentence), " +
    "translation = COALESCE(NULLIF(excluded.translation,''), vocab.translation), " +
    "sentence_zh = COALESCE(NULLIF(excluded.sentence_zh,''), vocab.sentence_zh), " +
    "example = COALESCE(NULLIF(excluded.example,''), vocab.example), " +
    "example_zh = COALESCE(NULLIF(excluded.example_zh,''), vocab.example_zh)"
  ).bind(
    me.user, word, book,
    String(b.cfi || "").slice(0, 400),
    "",  // v2: the original sentence is no longer persisted (see below)
    String(b.translation || "").slice(0, 600),
    String(b.note || "").slice(0, 200),
    now, now, String(b.src || "reading").slice(0, 20),
    sentenceZh, example, exampleZh
  ).run();
  // v2（用户定版）：不再保存原句。生词本只记「谁在哪本书遇见过这个词」
  // 的关系与时间/次数；长期保存的是按义项存的简单例句（在 word_store
  // 的 senses 里）。旧 vocab_contexts 数据保留但不再新增。
  // 这次查到的词义顺手沉淀进全局单词库（只填空缺），所有账户共同复用
  try {
    if (trans) {
      const p0 = splitWordText(trans);
      await upsertWordStore(env, word, {
        def: p0.def,
        example: example || p0.example,
        exampleZh: exampleZh || p0.exampleZh,
        ukIpa: String(b.uk_ipa || "").slice(0, 60),
        usIpa: String(b.us_ipa || "").slice(0, 60),
        senses: Array.isArray(b.senses) ? b.senses : null,
      });
    }
  } catch (e) {}
  const row = await env.DB.prepare(
    "SELECT word, book, hits, translation FROM vocab WHERE user = ? AND word = ? AND book = ?"
  ).bind(me.user, word, book).first();
  return json({ ok: true, item: row || null });
}

async function listVocab(url, env, me) {
  // 管理员带 ?user=<账号> 时看那个账号的生词本；其余情况一律只看自己的
  const asUser = String(url.searchParams.get("user") || "").slice(0, 40);
  const target = me.role === "admin" && asUser ? asUser : me.user;
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  await ensureVocabCols(env);
  const cols = "SELECT word, book, cfi, sentence, translation, note, hits, first_at, last_at, src, mastered, mastered_at, sentence_zh, example, example_zh, uk_ipa, us_ipa FROM vocab WHERE user = ?";
  // 按加入顺序排：新加入的在最前（first_at 倒序，老数据没有 first_at 时退回 last_at）
  const ord = " ORDER BY COALESCE(first_at, last_at) DESC, last_at DESC";
  const r = book
    ? await env.DB.prepare(cols + " AND book = ?" + ord).bind(target, book).all()
    : await env.DB.prepare(cols + ord).bind(target).all();
  // 附上全部原句（contexts）：书名解析成书名文本，录音有无一并带出
  await ensureVocabTables(env);
  const titles = {};
  try {
    const br = await env.DB.prepare("SELECT id, title FROM books").all();
    for (const b2 of br.results || []) titles[b2.id] = b2.title || b2.id;
  } catch (e) {}
  const audioSet = new Set();
  try {
    const ar = await env.DB.prepare("SELECT hash, accent FROM sentence_audio").all();
    for (const a2 of ar.results || []) audioSet.add(a2.hash + "|" + a2.accent);
  } catch (e) {}
  const ctxMap = new Map();
  try {
    const cr = await env.DB.prepare(
      "SELECT word, book, sentence, sentence_zh FROM vocab_contexts WHERE user = ? ORDER BY first_at ASC"
    ).bind(target).all();
    for (const c of cr.results || []) {
      const h = await sha256hex(c.sentence);
      const key = c.word + "\n" + c.book;
      if (!ctxMap.has(key)) ctxMap.set(key, []);
      ctxMap.get(key).push({
        sentence: c.sentence, sentence_zh: c.sentence_zh || "",
        book: c.book, book_title: titles[c.book] || "",
        h, audio_uk: audioSet.has(h + "|uk"), audio_us: audioSet.has(h + "|us"),
      });
    }
  } catch (e) {}
  // 内容从全局单词库拼装：生词行只存关系，词义/例句/双音标/单词录音都查全局库
  await ensureWordStore(env);
  const storeMap = new Map();
  const sensesMap = new Map();
  try {
    const sr = await env.DB.prepare("SELECT word, def, example, example_zh, uk_ipa, us_ipa, senses FROM word_store").all();
    for (const s of sr.results || []) {
      storeMap.set(s.word, s);
      try {
        const ss = JSON.parse(s.senses || "null");
        if (Array.isArray(ss) && ss.length) {
          const enr = [];
          for (const x of ss) {
            const o = { ...x };
            if (o.ex_en) {
              o.ex_h = await sha256hex(o.ex_en);
              o.audio_uk = audioSet.has(o.ex_h + "|uk");
              o.audio_us = audioSet.has(o.ex_h + "|us");
            }
            enr.push(o);
          }
          sensesMap.set(s.word, enr);
        }
      } catch (e) {}
    }
  } catch (e) {}
  const wAudioSet = new Set();
  try {
    const wr = await env.DB.prepare("SELECT word, accent FROM word_audio").all();
    for (const x of wr.results || []) wAudioSet.add(x.word + "|" + x.accent);
  } catch (e) {}
  const items = (r.results || []).map((it) => {
    const ws = storeMap.get(it.word) || {};
    const merged = {
      ...it,
      translation: ws.def || it.translation || "",
      example: it.example || ws.example || "",
      example_zh: it.example_zh || ws.example_zh || "",
      uk_ipa: ws.uk_ipa || it.uk_ipa || "",
      us_ipa: ws.us_ipa || it.us_ipa || "",
      senses: sensesMap.get(it.word) || null,
      word_audio_uk: wAudioSet.has(it.word + "|uk"),
      word_audio_us: wAudioSet.has(it.word + "|us"),
    };
    return {
      ...merged,
      ipa: pickIpa(merged.translation || ""),
      book_title: titles[it.book] || "",
      contexts: ctxMap.get(it.word + "\n" + it.book) || [],
    };
  });
  return json({ items, user: target, self: me.user, role: me.role });
}

let _sentOk = false;
async function ensureSentences(env) {
  if (_sentOk || !env.DB) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS sentences (user TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, " +
      "book TEXT NOT NULL DEFAULT '', first_at INTEGER, last_at INTEGER, PRIMARY KEY (user, src))"
    ).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sentences_user ON sentences(user, first_at DESC)").run();
  } catch (e) {}
  _sentOk = true;
}

async function recordSentence(env, me, src, dst) {
  // 整句/整段翻译自动进「句子表」：按账号存原句+译文；同一句再翻只更新译文，不挪位置。
  // 失败绝不影响翻译本身，所以全程吞掉异常。
  try {
    if (!env.DB || !me || !me.user) return;
    if (isSingleWord(src)) return;
    await ensureSentences(env);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sentences (user, src, dst, book, first_at, last_at) VALUES (?,?,?,'',?,?) " +
      "ON CONFLICT(user, src) DO UPDATE SET dst = excluded.dst, last_at = excluded.last_at"
    ).bind(me.user, String(src).slice(0, 600), String(dst).slice(0, 1200), now, now).run();
  } catch (e) {}
}

async function listSentences(url, env, me) {
  await ensureSentences(env);
  const asUser = String(url.searchParams.get("user") || "").slice(0, 40);
  const target = me.role === "admin" && asUser ? asUser : me.user;
  const r = await env.DB.prepare(
    "SELECT src, dst, book, first_at, last_at FROM sentences WHERE user = ? ORDER BY COALESCE(first_at, last_at) DESC, last_at DESC"
  ).bind(target).all();
  return json({ items: r.results || [], user: target, self: me.user, role: me.role });
}

async function delSentence(url, env, me) {
  await ensureSentences(env);
  const src = String(url.searchParams.get("src") || "").slice(0, 600);
  if (!src) return json({ ok: false, error: "missing src" }, 400);
  await env.DB.prepare("DELETE FROM sentences WHERE user = ? AND src = ?").bind(me.user, src).run();
  return json({ ok: true });
}

async function listSentenceUsers(env, me) {
  if (me.role !== "admin") return json({ ok: false, error: "admin only" }, 403);
  await ensureSentences(env);
  const r = await env.DB.prepare(
    "SELECT user, COUNT(*) AS n FROM sentences GROUP BY user ORDER BY n DESC, user ASC"
  ).all();
  return json({ ok: true, users: r.results || [] });
}

async function listVocabUsers(env, me) {
  if (me.role !== "admin") return json({ ok: false, error: "admin only" }, 403);
  const r = await env.DB.prepare(
    "SELECT user, COUNT(*) AS n FROM vocab GROUP BY user ORDER BY n DESC, user ASC"
  ).all();
  return json({ ok: true, users: r.results || [] });
}

async function delVocab(url, env, me) {
  const word = normWord(url.searchParams.get("word"));
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  if (!word) return json({ ok: false, error: "missing word" }, 400);
  if (book) {
    await env.DB.prepare("DELETE FROM vocab WHERE user = ? AND word = ? AND book = ?").bind(me.user, word, book).run();
    await env.DB.prepare("DELETE FROM vocab_contexts WHERE user = ? AND word = ? AND book = ?").bind(me.user, word, book).run();
  } else {
    await env.DB.prepare("DELETE FROM vocab WHERE user = ? AND word = ?").bind(me.user, word).run();
    await env.DB.prepare("DELETE FROM vocab_contexts WHERE user = ? AND word = ?").bind(me.user, word).run();
  }
  return json({ ok: true });
}

async function exportVocab(url, env, me) {
  const fmt = (url.searchParams.get("format") || "json").toLowerCase();
  const r = await env.DB.prepare(
    "SELECT word, book, cfi, sentence, translation, note, hits, first_at, last_at, src FROM vocab WHERE user = ? ORDER BY COALESCE(first_at, last_at) DESC, last_at DESC"
  ).bind(me.user).all();
  const items = r.results || [];

  if (fmt === "md") {
    const when = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const lines = ["# 生词本", "", "> 导出时间 " + when + " · 共 " + items.length + " 条", ""];
    let lastBook = "";
    items.forEach((it) => {
      if (it.book !== lastBook) { lines.push("", "## " + it.book, ""); lastBook = it.book; }
      const tr = it.translation ? " — " + it.translation.replace(/\s+/g, " ").slice(0, 60) : "";
      lines.push("- " + it.word + tr + (it.hits > 1 ? "（划了 " + it.hits + " 次）" : ""));
    });
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (fmt === "csv") {
    const head = "word,book,hits,translation,sentence,last_at";
    const rows = items.map((it) => [it.word, it.book, it.hits, it.translation || "", it.sentence || "",
      new Date(it.last_at || 0).toISOString()]
      .map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(","));
    return new Response([head].concat(rows).join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return json({ ok: true, user: me.user, count: items.length, items });
}


/* ================================================================
   账号系统（数据库版）+ 自主注册 + 管理员后台 + 书籍上传
   ---------------------------------------------------------------
   - users 表是账号的权威来源；环境变量账号只在首次运行时播种，
     且同名 DB 账号存在时环境变量不再兜底（保证「删除」真的有效，
     删除 = disabled 置 1，账号立刻登不进来，管理员可恢复）。
   - 密码一律 PBKDF2-SHA256 加盐哈希存储，不存明文。
   - 上传的书按内容 sha256 去重：一本书只存一份（book_chunks），
     谁上传/重复上传只多一行 user_books。可见性：上传者 + 管理员。
   ================================================================ */

const PBKDF2_ITERS = 100000;
const CHUNK_SIZE = 512 * 1024;              // 避开 D1 单值 1MB 上限
const MAX_UPLOAD = 64 * 1024 * 1024;        // 单本上限 64MB
const MAX_COVER = 990000;                   // 封面上限：D1 单值 1,000,000 字节是硬顶，留一点余量（原 900KB 曾误伤 968KB 的 PNG 封面）

function labelFor(role) {
  return { admin: "管理员", test: "试用", user: "读者", child: "孩子" }[role] || "读者";
}

function validUsername(u) {
  return /^[A-Za-z0-9_.\-]{2,24}$/.test(u);
}

/* ---------- 密码哈希 ---------- */

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(pw, salt, PBKDF2_ITERS);
  return "pbkdf2$" + PBKDF2_ITERS + "$" + b64urlBytes(salt) + "$" + b64urlBytes(new Uint8Array(bits));
}

async function pbkdf2(pw, salt, iters) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, key, 256);
}

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const bits = await pbkdf2(pw, b64urlToBytes(parts[2]), Number(parts[1]) || PBKDF2_ITERS);
    return eq(b64urlBytes(new Uint8Array(bits)), parts[3]);
  } catch (e) {
    return false;
  }
}

/* ---------- 账号存取 ---------- */

async function getUserRow(env, username) {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(
      "SELECT username, pass_hash, role, name, label, disabled, created_at, created_by FROM users WHERE username = ?"
    ).bind(username).first();
  } catch (e) {
    return null;   // users 表还没建（未跑新版 schema）时退化为纯环境变量账号
  }
}

async function anyDbUser(env) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return !!(r && r.n);
  } catch (e) {
    return false;
  }
}

async function getAppSetting(env, key) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first();
    return r ? r.value : null;
  } catch (e) {
    return null;
  }
}

async function setAppSetting(env, key, value) {
  if (!env.DB) return;
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

/* 环境变量账号播种：只在 users 表为空时跑一次，之后以后台数据为准 */
let seedDone = false;
async function ensureSeed(env, accts) {
  if (seedDone || !env.DB) return;
  seedDone = true;
  try {
    if (await anyDbUser(env)) return;
    for (const a of accts) {
      if (!a.pass) continue;
      const role = a.role === "child" ? "user" : a.role;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users (username, pass_hash, role, name, label, disabled, created_at, created_by) VALUES (?,?,?,?,?,0,?,?)"
      ).bind(a.user, await hashPassword(a.pass), role, a.name || a.user, a.label || labelFor(role),
             Date.now(), "env-seed").run();
    }
  } catch (e) { /* 表不存在等情况：静默退化为环境变量账号 */ }
}

/* Cookie 里的用户名 → 身份。DB 账号优先（含禁用判断），其次环境变量账号 */
async function resolveIdentity(env, username) {
  const row = await getUserRow(env, username);
  if (row) {
    if (row.disabled) return null;
    return { user: row.username, role: row.role, name: row.name || row.username, label: row.label || labelFor(row.role) };
  }
  const acct = accounts(env).find((a) => a.user === username);
  if (!acct) return null;
  return { user: acct.user, role: acct.role, name: acct.name, label: acct.label };
}

/* 登录校验：DB 账号（哈希比对）→ 环境变量账号（明文比对，仅未播种时兜底） */
async function authenticate(env, u, p) {
  const row = await getUserRow(env, u);
  if (row) {
    if (row.disabled) return null;
    if (await verifyPassword(p, row.pass_hash)) {
      return { user: row.username, role: row.role, name: row.name || row.username, label: row.label || labelFor(row.role) };
    }
    return null;
  }
  const acct = accounts(env).find((a) => a.user === u && a.pass);
  if (acct && eq(p, acct.pass)) {
    return { user: acct.user, role: acct.role, name: acct.name, label: acct.label };
  }
  return null;
}

async function usernameTaken(env, u) {
  if (await getUserRow(env, u)) return true;
  return accounts(env).some((a) => a.user === u);
}

async function createUser(env, username, password, role, createdBy, name, label) {
  await env.DB.prepare(
    "INSERT INTO users (username, pass_hash, role, name, label, disabled, created_at, created_by) VALUES (?,?,?,?,?,0,?,?)"
  ).bind(username, await hashPassword(password), role, name || username, label || labelFor(role),
         Date.now(), createdBy || "").run();
}

/* ---------- 自主注册 ---------- */

async function registerHtml(env, err) {
  const open = (await getAppSetting(env, "register_open")) === "1";
  const body = open
    ? `<form class="card" method="POST" action="/register">
    <div class="mark">阅</div>
    <h1>注册账号</h1>
    <p class="sub">注册后就能上传自己的书</p>
    ${err ? `<p class="err">${err}</p>` : ""}
    <div class="row"><label for="u">用户名</label>
      <input id="u" name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus
             placeholder="2-24 位字母、数字或 _ . -"></div>
    <div class="row"><label for="p">密码</label>
      <input id="p" name="p" type="password" autocomplete="new-password" required placeholder="至少 6 位"></div>
    <div class="row"><label for="p2">再输一次密码</label>
      <input id="p2" name="p2" type="password" autocomplete="new-password" required></div>
    <button type="submit">注册并进入</button>
    <p class="foot">已有账号？<a href="/login" style="color:#c2352b">去登录</a></p>
  </form>`
    : `<div class="card">
    <div class="mark">阅</div>
    <h1>注册未开放</h1>
    <p class="sub">本站暂时关闭自主注册</p>
    <p style="font-size:13.5px;color:#4b4335;margin:0">需要账号请联系管理员添加；管理员也可以在后台打开自主注册开关。</p>
    <p class="foot"><a href="/login" style="color:#c2352b">← 回登录页</a></p>
  </div>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>注册 · 阅读空间</title>
<meta name="robots" content="noindex"><style>${LOGIN_CSS}</style></head><body>${body}</body></html>`;
}

async function handleRegister(request, secret, env) {
  if ((await getAppSetting(env, "register_open")) !== "1") {
    return html(await registerHtml(env, ""), 403);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return html(await registerHtml(env, "提交的内容读不出来，请再试一次。"), 400);
  }
  const u = String(form.get("u") || "").trim();
  const p = String(form.get("p") || "");
  const p2 = String(form.get("p2") || "");
  const ip = await ipKey(request, env);
  if (await tooManyFails(env, ip)) {
    return html(await registerHtml(env, "尝试次数过多，请 15 分钟后再试。"), 429);
  }
  const fail = async (msg) => {
    await noteFail(env, ip);
    return html(await registerHtml(env, msg), 400);
  };
  if (!validUsername(u)) return fail("用户名要用 2-24 位字母、数字或 _ . - 组成。");
  if (p.length < 6) return fail("密码至少 6 位。");
  if (p !== p2) return fail("两次输入的密码不一致。");
  if (!env.DB) return fail("本站还没有接数据库，暂时注册不了。");
  if (await usernameTaken(env, u)) return fail("这个用户名已经被占用了，换一个试试。");
  try {
    await createUser(env, u, p, "user", "self-register");
  } catch (e) {
    return fail("注册失败，请再试一次。");
  }
  await clearFails(env, ip);
  return issueCookie(u, secret, env, "/");
}


/* ================================================================
   书籍上传与存储
   ================================================================ */

function blobBytes(v) {
  // D1/miniflare 读回的 BLOB 可能是 ArrayBuffer、Uint8Array 或数字数组，统一成 Uint8Array
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (typeof v === "object") {
    const n = Object.keys(v).length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = v[i];
    return out;
  }
  return new Uint8Array(0);
}

async function visibleBookRows(env, me) {
  if (!env.DB) return [];
  await ensureUserBooksCols(env);
  try {
    if (me.role === "admin") {
      const r = await env.DB.prepare(
        "SELECT b.*, (SELECT COUNT(*) FROM user_books ub WHERE ub.book_id = b.id) AS owners, " +
        "(SELECT ub2.last_open FROM user_books ub2 WHERE ub2.book_id = b.id AND ub2.user = ?) AS last_open " +
        "FROM books b ORDER BY b.created_at DESC"
      ).bind(me.user).all();
      return r.results || [];
    }
    const r = await env.DB.prepare(
      "SELECT b.*, 1 AS owners, ub.last_open AS last_open FROM books b JOIN user_books ub ON ub.book_id = b.id " +
      "WHERE ub.user = ? ORDER BY ub.added_at DESC"
    ).bind(me.user).all();
    return r.results || [];
  } catch (e) {
    return [];
  }
}

function bookToEntry(b, me) {
  const isPdf = b.format === "pdf";
  return {
    id: b.id,
    title: b.title || b.id,
    author: b.author || "",
    lang: "en",
    desc: "",
    level: "",
    format: b.format,
    chapters: b.chapters || 0,
    pages: b.pages || 0,
    file: "/bookfile/" + b.id + "." + b.format,
    url: (isPdf ? "pdf.html?b=" : "reader.html?b=") + b.id,
    cover: "bookcover/" + b.id,
    size: b.size,
    added: b.created_at ? new Date(b.created_at).toISOString().slice(0, 10) : "",
    lastOpen: b.last_open || 0,
    uploaded: true,
    uploader: b.uploader || "",
    owners: b.owners == null ? undefined : b.owners,
    mine: !!me && b.uploader === me.user,
  };
}

/* 书架数据源：静态 books.json + 当前账号能看到的数据库书籍 */
async function mergedBooksJson(request, env, me) {
  let statics = [];
  try {
    const r = await env.ASSETS.fetch(new URL("/books.json", request.url));
    if (r.ok) statics = await r.json();
    if (!Array.isArray(statics)) statics = [];
  } catch (e) { /* 静态书目读不到时只给数据库的书 */ }
  // 静态书的文件路径改成站点绝对路径：阅读器内部的相对路径解析在无扩展名页面下会拼错目录
  for (const b of statics) {
    if (b && typeof b.file === "string" && b.file && !b.file.startsWith("/") && !/^https?:/i.test(b.file)) {
      b.file = "/" + b.file;
    }
  }
  const mine = (await visibleBookRows(env, me)).map((b) => bookToEntry(b, me));
  const seen = new Set(statics.map((b) => b.id));
  return json(statics.concat(mine.filter((b) => !seen.has(b.id))));
}

async function listDbBooks(env, me) {
  const rows = await visibleBookRows(env, me);
  return json({ ok: true, items: rows.map((b) => bookToEntry(b, me)) });
}

async function linkBook(env, user, bookId) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_books (user, book_id, added_at) VALUES (?,?,?)"
  ).bind(user, bookId, Date.now()).run();
}

/* 没有任何人拥有时，连文件块和封面一起清掉 */
async function cleanupBookIfOrphan(env, bookId) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_books WHERE book_id = ?").bind(bookId).first();
  if (r && r.n === 0) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM book_chunks WHERE book_id = ?").bind(bookId),
      env.DB.prepare("DELETE FROM book_covers WHERE book_id = ?").bind(bookId),
      env.DB.prepare("DELETE FROM books WHERE id = ?").bind(bookId),
    ]);
    return true;
  }
  return false;
}

async function removeMyBook(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const id = String(b.id || "");
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  await env.DB.prepare("DELETE FROM user_books WHERE user = ? AND book_id = ?").bind(me.user, id).run();
  const gone = await cleanupBookIfOrphan(env, id);
  return json({ ok: true, deleted: gone });
}

async function handleUpload(request, env, me) {
  if (!env.DB) return json({ ok: false, error: "本站还没有接数据库，上传不了" }, 501);
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, error: "提交的内容读不出来" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ ok: false, error: "没有收到文件" }, 400);
  }
  const name = String(file.name || "book");
  if (file.size > MAX_UPLOAD) {
    return json({ ok: false, error: "文件超过 64MB 上限" }, 413);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 4) return json({ ok: false, error: "文件太小，不像一本书" }, 400);

  let format = "";
  if (buf[0] === 0x50 && buf[1] === 0x4b) format = "epub";                    // PK.. zip
  else if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) format = "pdf";  // %PDF
  if (!format || (format === "epub" && !/\.epub$/i.test(name)) || (format === "pdf" && !/\.pdf$/i.test(name))) {
    return json({ ok: false, error: "只收 EPUB 和 PDF 文件" }, 400);
  }

  const shaBuf = await crypto.subtle.digest("SHA-256", buf);
  const sha = Array.from(new Uint8Array(shaBuf)).map((x) => x.toString(16).padStart(2, "0")).join("");
  const id = sha.slice(0, 16);

  // 去重：内容已在库里，只补一行「我的书架」，文件不重复存
  const existing = await env.DB.prepare("SELECT * FROM books WHERE sha256 = ?").bind(sha).first();
  if (existing) {
    await linkBook(env, me.user, existing.id);
    return json({ ok: true, existed: true, book: bookToEntry(existing, me) });
  }

  const fallbackTitle = name.replace(/\.(epub|pdf)$/i, "");
  let meta = { title: fallbackTitle, author: "", chapters: 0, pages: 0 };
  let cover = null;
  try {
    meta = format === "epub" ? await epubMeta(buf, fallbackTitle) : pdfMeta(buf, fallbackTitle);
    if (format === "epub") cover = meta.cover || null;
  } catch (e) { /* 元数据抽不到就用文件名，不挡上传 */ }

  const stmts = [];
  stmts.push(env.DB.prepare(
    "INSERT INTO books (id, sha256, title, author, format, size, pages, chapters, has_cover, uploader, created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, sha, String(meta.title || fallbackTitle).slice(0, 200), String(meta.author || "").slice(0, 120),
         format, buf.length, meta.pages || 0, meta.chapters || 0, cover ? 1 : 0, me.user, Date.now()));
  const nChunks = Math.ceil(buf.length / CHUNK_SIZE);
  for (let i = 0; i < nChunks; i++) {
    // 用 slice 拷贝而不是 subarray 视图：D1 对视图的序列化在本地实现里不可靠
    stmts.push(env.DB.prepare("INSERT INTO book_chunks (book_id, seq, data) VALUES (?,?,?)")
      .bind(id, i, buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
  }
  if (cover) {
    stmts.push(env.DB.prepare("INSERT INTO book_covers (book_id, type, data) VALUES (?,?,?)")
      .bind(id, cover.type, cover.data));
  }
  stmts.push(env.DB.prepare(
    "INSERT OR IGNORE INTO user_books (user, book_id, added_at) VALUES (?,?,?)"
  ).bind(me.user, id, Date.now()));
  await env.DB.batch(stmts);

  const row = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  return json({ ok: true, existed: false, book: bookToEntry(row, me) });
}

async function canSeeBook(env, me, id) {
  if (me.role === "admin") {
    const r = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(id).first();
    return !!r;
  }
  const r = await env.DB.prepare(
    "SELECT book_id FROM user_books WHERE user = ? AND book_id = ?"
  ).bind(me.user, id).first();
  return !!r;
}

async function serveBookFile(request, env, me, rawId, url) {
  const id = String(rawId || "").replace(/\.(epub|pdf)$/i, "");
  if (!env.DB || !/^[0-9a-f]{16}$/.test(id)) return new Response("not found", { status: 404 });
  const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  if (!book) return new Response("not found", { status: 404 });
  if (!(await canSeeBook(env, me, id))) return new Response("forbidden", { status: 403 });
  // 打开文件即记一次「最近打开」（书架排序用）；分片请求 60 秒内不重复写库
  await touchBookOpenThrottled(env, me, id);

  const total = book.size;
  const type = book.format === "pdf" ? "application/pdf" : "application/epub+zip";
  const fname = encodeURIComponent((book.title || id) + "." + book.format);
  const base = {
    "content-type": type,
    "content-disposition": "inline; filename*=UTF-8''" + fname,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  };

  let start = 0, end = total - 1, status = 200;
  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      if (m[1] === "" && m[2] !== "") {           // bytes=-N：最后 N 字节
        start = Math.max(0, total - Number(m[2]));
      } else {
        start = Number(m[1] || 0);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (start > end || start >= total) {
        return new Response(null, { status: 416, headers: { "content-range": "bytes */" + total } });
      }
      status = 206;
    }
  }

  const firstChunk = Math.floor(start / CHUNK_SIZE);
  const lastChunk = Math.floor(end / CHUNK_SIZE);
  const r = await env.DB.prepare(
    "SELECT seq, data FROM book_chunks WHERE book_id = ? AND seq >= ? AND seq <= ? ORDER BY seq"
  ).bind(id, firstChunk, lastChunk).all();
  const rows = (r.results || []).map((x) => ({ seq: x.seq, bytes: blobBytes(x.data) }));
  const joined = new Uint8Array(rows.reduce((n, x) => n + x.bytes.byteLength, 0));
  let off = 0;
  for (const row of rows) {
    joined.set(row.bytes, off);
    off += row.bytes.byteLength;
  }
  const slice = joined.subarray(start - firstChunk * CHUNK_SIZE, end - firstChunk * CHUNK_SIZE + 1);

  const headers = { ...base, "content-length": String(slice.byteLength) };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${total}`;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(slice, { status, headers });
}

async function serveBookCover(env, me, id) {
  if (!env.DB || !/^[0-9a-f]{16}$/.test(id)) return new Response("not found", { status: 404 });
  const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  if (!book) return new Response("not found", { status: 404 });
  if (!(await canSeeBook(env, me, id))) return new Response("forbidden", { status: 403 });
  if (book.has_cover) {
    const c = await env.DB.prepare("SELECT type, data FROM book_covers WHERE book_id = ?").bind(id).first();
    if (c && c.data) {
      return new Response(blobBytes(c.data), {
        // 书 id 是内容哈希，封面永不变：长缓存（浏览器与 SW 都可放心存）
        headers: { "content-type": c.type || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
      });
    }
  }
  // 没有抽到封面：现画一张 SVG 占位（纸色底 + 红线 + 书名）
  const t = String(book.title || "未命名").replace(/[<>&"]/g, "");
  const short = t.length > 24 ? t.slice(0, 24) + "…" : t;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">` +
    `<rect width="480" height="640" fill="#f5f0e7"/><rect width="480" height="10" fill="#c2352b"/>` +
    `<text x="240" y="310" font-size="30" fill="#22262b" text-anchor="middle" font-family="Georgia,serif">${short}</text>` +
    `<text x="240" y="356" font-size="17" fill="#6b6459" text-anchor="middle">${book.format === "pdf" ? "PDF" : "EPUB"}</text></svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, max-age=86400" },
  });
}

/* ---------- EPUB 元数据：极简 ZIP 读取（只认 OPF 与封面） ---------- */

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function zipEntries(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no eocd");
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const map = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(buf, off) !== 0x02014b50) break;
    const method = u16(buf, off + 10);
    const compSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOff = u32(buf, off + 42);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    map.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

async function zipRead(buf, entry) {
  const lo = entry.localOff;
  if (u32(buf, lo) !== 0x04034b50) throw new Error("bad local header");
  const nameLen = u16(buf, lo + 26);
  const extraLen = u16(buf, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return new Uint8Array(raw);
  if (entry.method === 8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("unsupported zip method " + entry.method);
}

async function epubMeta(buf, fallbackTitle) {
  const out = { title: fallbackTitle, author: "", chapters: 0, pages: 0, cover: null };
  const entries = zipEntries(buf);
  const get = async (name) => {
    const e = entries.get(name);
    return e ? zipRead(buf, e) : null;
  };
  let opfPath = null;
  const container = await get("META-INF/container.xml");
  if (container) {
    const m = /full-path="([^"]+)"/.exec(new TextDecoder().decode(container));
    if (m) opfPath = m[1];
  }
  if (!opfPath) {
    for (const name of entries.keys()) {
      if (name.toLowerCase().endsWith(".opf")) { opfPath = name; break; }
    }
  }
  if (!opfPath) return out;
  const opfBytes = await get(opfPath);
  if (!opfBytes) return out;
  const opf = new TextDecoder().decode(opfBytes);
  const pick = (re) => {
    const m = re.exec(opf);
    return m ? m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim() : "";
  };
  out.title = pick(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/) || fallbackTitle;
  out.author = pick(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/);
  out.chapters = (opf.match(/media-type="application\/xhtml\+xml"/g) || []).length;

  // 封面：meta name=cover → item href（与 build_books.py 同一套路，简化版）
  try {
    const cm = /<meta[^>]+name="cover"[^>]+content="([^"]+)"/.exec(opf);
    let href = null;
    if (cm) {
      const re1 = new RegExp('<item[^>]+id="' + cm[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]+href="([^"]+)"');
      const re2 = new RegExp('<item[^>]+href="([^"]+)"[^>]+id="' + cm[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"');
      const hit = re1.exec(opf) || re2.exec(opf);
      if (hit) href = hit[1];
    }
    if (!href) {
      for (const name of entries.keys()) {
        if (/cover\.(jpe?g|png)$/i.test(name)) { href = name; break; }
      }
    }
    if (href) {
      const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
      const full = href.startsWith("/") ? href.slice(1) : dir + href;
      const parts = [];
      for (const seg of full.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      const coverEntry = entries.get(parts.join("/")) || entries.get(href);
      if (coverEntry) {
        const data = await zipRead(buf, coverEntry);
        if (data && data.byteLength > 0 && data.byteLength <= MAX_COVER) {
          out.cover = {
            type: /\.png$/i.test(href) ? "image/png" : "image/jpeg",
            data,
          };
        }
      }
    }
  } catch (e) { /* 封面抽不到无所谓，占位图兜底 */ }
  return out;
}

/* ---------- PDF 元数据：只挖标题与大致页数 ---------- */

function pdfMeta(buf, fallbackTitle) {
  const out = { title: fallbackTitle, author: "", chapters: 0, pages: 0, cover: null };
  const tail = new TextDecoder("latin1").decode(buf.subarray(0, Math.min(buf.length, 1 << 20)));
  const head2 = new TextDecoder("latin1").decode(buf.subarray(Math.max(0, buf.length - (1 << 20))));
  const scan = tail + head2;
  const tm = /\/Title\s*\(((?:\\.|[^()\\])*)\)/.exec(scan);
  if (tm) {
    out.title = tm[1].replace(/\\([()\\])/g, "$1").trim() || fallbackTitle;
  } else {
    const hm = /\/Title\s*<([0-9A-Fa-f\s]+)>/.exec(scan);
    if (hm) {
      try {
        const hex = hm[1].replace(/\s/g, "");
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          out.title = new TextDecoder("utf-16be").decode(bytes.subarray(2)).trim() || fallbackTitle;
        }
      } catch (e) { /* 解不出就用文件名 */ }
    }
  }
  const whole = new TextDecoder("latin1").decode(buf);
  out.pages = (whole.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  out.chapters = out.pages;
  return out;
}


/* ================================================================
   管理员后台
   ================================================================ */

function forbiddenHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>没有权限 · 阅读空间</title>
<meta name="robots" content="noindex"><style>${LOGIN_CSS}</style></head><body>
<div class="card">
  <div class="mark">阅</div>
  <h1>没有权限</h1>
  <p class="sub">这个页面只有管理员能看</p>
  <p class="foot"><a href="/" style="color:#c2352b">← 回主页</a></p>
</div></body></html>`;
}

async function adminData(env) {
  const data = { register_open: (await getAppSetting(env, "register_open")) === "1",
    auto_vocab: (await getAppSetting(env, "auto_vocab")) !== "0", users: [], books: [] };
  if (!env.DB) return data;
  try {
    const u = await env.DB.prepare(
      "SELECT username, role, label, disabled, created_at, created_by FROM users ORDER BY created_at"
    ).all();
    data.users = u.results || [];
  } catch (e) {}
  try {
    const b = await env.DB.prepare(
      "SELECT b.id, b.title, b.author, b.format, b.size, b.uploader, b.created_at, " +
      "(SELECT GROUP_CONCAT(ub.user) FROM user_books ub WHERE ub.book_id = b.id) AS owners " +
      "FROM books b ORDER BY b.created_at DESC"
    ).all();
    data.books = b.results || [];
  } catch (e) {}
  return data;
}

async function adminApi(request, url, env, me, path) {
  if (!env.DB) return json({ ok: false, error: "no db" }, 501);
  if (path === "/api/admin/overview") {
    return json({ ok: true, ...(await adminData(env)) });
  }
  let b = {};
  if (request.method === "POST") {
    try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  }

  if (path === "/api/admin/users" && request.method === "POST") {
    const u = String(b.username || "").trim();
    const p = String(b.password || "");
    const role = ["user", "test", "admin"].includes(b.role) ? b.role : "user";
    if (!validUsername(u)) return json({ ok: false, error: "用户名要用 2-24 位字母、数字或 _ . - 组成" }, 400);
    if (p.length < 4) return json({ ok: false, error: "密码至少 4 位" }, 400);
    if (await usernameTaken(env, u)) return json({ ok: false, error: "用户名已被占用" }, 400);
    await createUser(env, u, p, role, me.user);
    return json({ ok: true });
  }

  if (path === "/api/admin/users/delete" && request.method === "POST") {
    const u = String(b.username || "");
    if (!u) return json({ ok: false, error: "missing username" }, 400);
    if (u === me.user) return json({ ok: false, error: "不能删除自己" }, 400);
    await env.DB.prepare("UPDATE users SET disabled = 1 WHERE username = ?").bind(u).run();
    // 他书架上的书一并摘下；没人拥有的书连文件一起清掉
    const mine = await env.DB.prepare("SELECT book_id FROM user_books WHERE user = ?").bind(u).all();
    await env.DB.prepare("DELETE FROM user_books WHERE user = ?").bind(u).run();
    for (const row of mine.results || []) await cleanupBookIfOrphan(env, row.book_id);
    return json({ ok: true });
  }

  if (path === "/api/admin/users/restore" && request.method === "POST") {
    const u = String(b.username || "");
    if (!u) return json({ ok: false, error: "missing username" }, 400);
    await env.DB.prepare("UPDATE users SET disabled = 0 WHERE username = ?").bind(u).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/settings" && request.method === "POST") {
    const out = { ok: true };
    if (Object.prototype.hasOwnProperty.call(b, "register_open")) {
      await setAppSetting(env, "register_open", b.register_open ? "1" : "0");
      out.register_open = !!b.register_open;
    }
    if (Object.prototype.hasOwnProperty.call(b, "auto_vocab")) {
      await setAppSetting(env, "auto_vocab", b.auto_vocab ? "1" : "0");
      out.auto_vocab = !!b.auto_vocab;
    }
    return json(out);
  }

  if (path === "/api/admin/books/share" && request.method === "POST") {
    const id = String(b.id || "");
    const u = String(b.username || "");
    if (!id || !u) return json({ ok: false, error: "missing id/username" }, 400);
    const book = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(id).first();
    if (!book) return json({ ok: false, error: "没有这本书" }, 404);
    const usr = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(u).first();
    if (!usr) return json({ ok: false, error: "没有这个账号" }, 404);
    if (b.on) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_books (user, book_id, added_at) VALUES (?,?,?)")
        .bind(u, id, Date.now()).run();
    } else {
      // 摘展示不删文件：之后还能再勾回来；真删书走 books/delete
      await env.DB.prepare("DELETE FROM user_books WHERE user = ? AND book_id = ?").bind(u, id).run();
    }
    return json({ ok: true });
  }

  if (path === "/api/admin/books/delete" && request.method === "POST") {
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "missing id" }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_books WHERE book_id = ?").bind(id),
      env.DB.prepare("DELETE FROM book_chunks WHERE book_id = ?").bind(id),
      env.DB.prepare("DELETE FROM book_covers WHERE book_id = ?").bind(id),
      env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown admin api" }, 404);
}

async function adminHtml(env) {
  const d = await adminData(env);
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const when = (ts) => ts ? new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "";
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";

  const userRows = d.users.map((u) => `
    <tr class="${u.disabled ? "off" : ""}">
      <td><b>${esc(u.username)}</b>${u.disabled ? ' <span class="tag">已删除</span>' : ""}</td>
      <td>${esc(u.label || labelFor(u.role))}</td>
      <td>${esc(u.created_by || "")}</td>
      <td>${when(u.created_at)}</td>
      <td>${u.disabled
        ? `<button data-restore="${esc(u.username)}">恢复</button>`
        : `<button data-del="${esc(u.username)}">删除</button>`}</td>
    </tr>`).join("");

  const bookRows = d.books.map((b) => {
    const ownerSet = new Set(String(b.owners || "").split(",").filter(Boolean));
    const chips = d.users
      .filter((u) => !u.disabled && u.role !== "admin")
      .map((u) => `<label style="display:inline-block;margin:0 8px 5px 0;white-space:nowrap"><input type="checkbox" data-share="${esc(b.id)}" data-user="${esc(u.username)}"${ownerSet.has(u.username) ? " checked" : ""}> ${esc(u.username)}${u.username === b.uploader ? "（传）" : ""}</label>`)
      .join("");
    return `
    <tr>
      <td><b>${esc(b.title || b.id)}</b><br><small>${esc(b.author || "")}</small></td>
      <td>${b.format.toUpperCase()}</td>
      <td>${mb(b.size)}</td>
      <td>${esc(b.uploader || "")}</td>
      <td>${chips || "（无可展示的账号）"}</td>
      <td>${when(b.created_at)}</td>
      <td><button data-delbook="${esc(b.id)}">删除</button></td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>后台管理 · 阅读空间</title>
<meta name="robots" content="noindex"><style>
  :root{--paper:#f5f0e7;--ink:#22262b;--muted:#6b6459;--line:#e4d9c5;--red:#c2352b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);padding:22px 16px 60px;
    font:15px/1.65 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:920px;margin:0 auto}
  h1{font-family:Georgia,"Songti SC",serif;font-size:22px;margin:4px 0 2px}
  h2{font-size:16.5px;margin:30px 0 10px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 8px}
  .card{background:#fffdf9;border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:14px}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600}
  tr.off td{color:#a39a89;text-decoration:line-through}
  tr.off td .tag{text-decoration:none}
  .tag{background:#f3e2df;color:#a3312a;border-radius:6px;padding:1px 7px;font-size:11.5px}
  button{font:inherit;font-size:13px;padding:6px 13px;border-radius:8px;border:1px solid var(--line);
    background:#fff;cursor:pointer}
  button:hover{border-color:var(--red);color:var(--red)}
  button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
  button.primary:hover{background:var(--red);color:#fff}
  input,select{font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .msg{font-size:13px;color:#a3312a;min-height:20px}
  a{color:var(--red)}
  .switch{display:flex;gap:10px;align-items:center}
</style></head><body><div class="wrap">
  <p class="sub"><a href="/">← 回主页</a> · <a href="/library">书架</a></p>
  <h1>后台管理</h1>
  <p class="sub">账号与全站书籍都在这里。删除账号是「停用」：对方立刻登不进来，随时能恢复。</p>

  <div class="card">
    <h2 style="margin-top:0">自主注册</h2>
    <div class="switch">
      <span>访客自主注册：<b id="regState">${d.register_open ? "已开放" : "已关闭"}</b></span>
      <button id="regToggle">${d.register_open ? "关闭注册" : "开放注册"}</button>
    </div>
    <p class="sub" style="margin-top:8px">开放后，任何人打开 /register 都能自助注册账号（角色为读者）。</p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">划词自动入库</h2>
    <div class="switch">
      <span>翻译单词自动进生词本：<b id="avState">${d.auto_vocab ? "已开启" : "已关闭"}</b></span>
      <button id="avToggle">${d.auto_vocab ? "关闭" : "开启"}</button>
    </div>
    <p class="sub" style="margin-top:8px">开启后，任何人划词翻译，单词都会自动存进各自的生词本并在书里高亮；关闭后只能在阅读器里手动点「存生词」。这个开关由管理员统一控制，普通账号在阅读器里改不了。</p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">账号（${d.users.length}）</h2>
    <table><tr><th>用户名</th><th>身份</th><th>来源</th><th>创建时间</th><th></th></tr>${userRows || '<tr><td colspan="5">还没有数据库账号</td></tr>'}</table>
    <h2>新增账号</h2>
    <div class="row">
      <input id="nu" placeholder="用户名" autocapitalize="none" spellcheck="false">
      <input id="np" type="text" placeholder="密码（至少 4 位）">
      <select id="nr"><option value="user">读者</option><option value="test">试用</option><option value="admin">管理员</option></select>
      <button class="primary" id="addUser">新增</button>
    </div>
    <p class="msg" id="umsg"></p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">全部书籍（${d.books.length}）</h2>
    <table><tr><th>书名</th><th>格式</th><th>大小</th><th>首传者</th><th>在谁的书架上</th><th>上传时间</th><th></th></tr>${bookRows || '<tr><td colspan="7">还没有人上传过书</td></tr>'}</table>
  </div>

</div>
<script>
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || ("http " + r.status));
    return j;
  }
  document.getElementById("avToggle").addEventListener("click", async () => {
    const now = document.getElementById("avState").textContent.includes("已开启");
    try { await post("/api/admin/settings", { auto_vocab: !now }); location.reload(); }
    catch (e) { alert(e.message); }
  });
  document.getElementById("regToggle").addEventListener("click", async () => {
    const now = document.getElementById("regState").textContent.includes("已开放");
    try { await post("/api/admin/settings", { register_open: !now }); location.reload(); }
    catch (e) { alert(e.message); }
  });
  document.getElementById("addUser").addEventListener("click", async () => {
    const msg = document.getElementById("umsg");
    try {
      await post("/api/admin/users", {
        username: document.getElementById("nu").value.trim(),
        password: document.getElementById("np").value,
        role: document.getElementById("nr").value,
      });
      location.reload();
    } catch (e) { msg.textContent = e.message; }
  });
  document.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("删除账号 " + el.dataset.del + "？对方将无法登录（可恢复）。")) return;
    try { await post("/api/admin/users/delete", { username: el.dataset.del }); location.reload(); }
    catch (e) { alert(e.message); }
  }));
  document.querySelectorAll("[data-restore]").forEach((el) => el.addEventListener("click", async () => {
    try { await post("/api/admin/users/restore", { username: el.dataset.restore }); location.reload(); }
    catch (e) { alert(e.message); }
  }));
  document.querySelectorAll("[data-delbook]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("删除这本书？所有人的书架上都会消失，文件也会清掉。")) return;
    try { await post("/api/admin/books/delete", { id: el.dataset.delbook }); location.reload(); }
    catch (e) { alert(e.message); }
  }));
  document.querySelectorAll("[data-share]").forEach((el) => el.addEventListener("change", async () => {
    try {
      await post("/api/admin/books/share", { id: el.dataset.share, username: el.dataset.user, on: el.checked });
    } catch (e) { el.checked = !el.checked; alert(e.message); }
  }));
</script>
</body></html>`;
}
