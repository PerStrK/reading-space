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

    if (!accts.length) return html(setupHtml(), 200);

    const secret = await sessionSecret(env);
    const open = accts.filter((a) => a.pass);

    if (path === "/login") {
      if (request.method === "POST") return handleLogin(request, url, open, secret, env);
      return html(loginHtml(safeNext(url.searchParams.get("next")), ""), 200);
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

    const me = await session(request, open, secret, env);
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

    // ---- 账号偏好（按账号分开存）----
    if (path === "/api/settings") {
      if (request.method === "POST") return saveSettings(request, env, me);
      return getSettings(env, me);
    }

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

async function handleLogin(request, url, accts, secret, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return html(loginHtml("/", "提交的内容读不出来，请再试一次。"), 400);
  }
  const u = String(form.get("u") || "").trim();
  const p = String(form.get("p") || "");
  const next = safeNext(String(form.get("next") || "/"));
  const ip = await ipKey(request, env);

  if (await tooManyFails(env, ip)) {
    return html(loginHtml(next, "尝试次数过多，请 15 分钟后再试。"), 429);
  }

  const hit = accts.find((a) => eq(u, a.user) && eq(p, a.pass));
  if (hit) {
    await clearFails(env, ip);
    const exp = Math.floor(Date.now() / 1000) + TTL;
    const sig = await sign(secret, `${hit.user}|${exp}|${ver(env)}`);
    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        "set-cookie": `${COOKIE}=${b64url(hit.user)}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`,
        "cache-control": "no-store",
      },
    });
  }
  await noteFail(env, ip);
  return html(loginHtml(next, "用户名或密码不对，请再试一次。"), 401);
}

async function session(request, accts, secret, env) {
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
  const acct = accts.find((a) => a.user === user);
  if (!acct) return null;
  const want = await sign(secret, `${user}|${exp}|${ver(env)}`);
  if (!eq(sig, want)) return null;
  return { user: acct.user, role: acct.role, name: acct.name, label: acct.label };
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
  const s = String(v || "/");
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
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

function loginHtml(next, err) {
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

// 主模型：nemotron-3.5-super-vl 免费档，实测中位 2.9 秒、6 次里成功 5 次，
//       输出格式最标准（词性+释义+英文例句+中文翻译），日常零成本。
// 备用：DeepSeek flash 最便宜的一档（约 $0.0001/次），免费档限流 429 时顶上。
const TR_DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const TR_FALLBACK_MODEL = "~deepseek/deepseek-flash-latest";

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

function polishTranslation(raw) {
  let s = String(raw || "").replace(/\r/g, "").trim();
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

  const isWord = isSingleWord(text);
  // 版本前缀：zh4 起单词要多给音标，旧的（没音标的）缓存自动失效
  const hash = await sha256hex("zh4|" + text);
  const hit = await env.DB.prepare("SELECT dst FROM translations WHERE hash = ?").bind(hash).first();
  if (hit && hit.dst) return json({ ok: true, text: hit.dst, ipa: pickIpa(hit.dst), cached: true });

  // 主模型出不来可用结果（空、报错、把思考过程当答案）就换备用模型再试
  const plans = [
    { model: env.TRANSLATE_MODEL || TR_DEFAULT_MODEL, max: 500 },
    { model: env.TRANSLATE_FALLBACK || TR_FALLBACK_MODEL, max: 1400 },
  ];
  const SYS = isWord
    ? "英汉词典。只输出两行，不要思考过程、不要步骤、不要 Markdown、不要加粗。" +
      "第一行：「/国际音标/ 词性 中文释义」，音标两侧必须加斜杠，例如 /ˈmɪərkæt/ n. 猫鼬；" +
      "第二行：一句简短英文例句（只写例句，不写译文）。中文释义不超过 40 字。"
    : "英汉词典。直接给出最终答案，不要思考过程、不要步骤、不要 Markdown。" +
      "单词：第一行写词性 + 中文释义，第二行给一句简短英文例句；句子：只给译文。中文不超过 60 字。";
  let clean = "";          // 最终采用
  let noIpa = "";          // 备胎：有中文释义但没音标（单词才会用到）
  let lastErr = "";
  let usedModel = "";
  // 单词要求必须带音标：没有音标就当"还不够好"，换备用模型再试一次；
  // 但两次都没音标也不会报错，返回有释义的版本就行。
  for (let attempt = 0; attempt < plans.length && !clean; attempt++) {
    const plan = plans[attempt];
    usedModel = plan.model;
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
    let r;
    try {
      const hdrs = {
        "content-type": "application/json",
        authorization: "Bearer " + env.OPENROUTER_KEY,
        // OpenRouter 用它做用量归因，可选
        "X-Title": "reading-space",
      };
      if (env.SITE_URL) hdrs["HTTP-Referer"] = env.SITE_URL;
      r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = "network";
      continue;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      lastErr = "upstream " + r.status + " " + t.slice(0, 120);
      continue;
    }
    const j = await r.json().catch(() => null);
    const msg = (((j || {}).choices || [])[0] || {}).message || {};
    // 只认 content；reasoning 一律不用（它装的是模型的思考草稿，不是译文）
    const got = polishTranslation(msg.content || "");
    if (!usableTranslation(got)) {
      lastErr = "unusable (" + ((j || {}).model || "?") + ")";
    } else if (!isWord || pickIpa(got)) {
      clean = got;                       // 够好，收下
    } else if (!noIpa) {
      noIpa = got;                       // 有释义但缺音标，先留住
    }
  }
  if (!clean) clean = noIpa;             // 音标没要到，至少把释义给出来
  if (!usableTranslation(clean)) {
    return json({ ok: false, error: lastErr || "translate failed", hint: "翻译服务暂时不可用，稍后再试" }, 502);
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO translations (hash, src, dst, model, created_at) VALUES (?,?,?,?,?)"
  ).bind(hash, text.slice(0, 300), clean.slice(0, 1200), usedModel, Date.now()).run();

  return json({ ok: true, text: clean, ipa: pickIpa(clean), cached: false });
}

/* ---------- 账号偏好 ---------- */

async function getSettings(env, me) {
  const out = { ok: true, auto_vocab: false, user: me.user, role: me.role };
  if (!env.DB) return json(out);
  try {
    const row = await env.DB.prepare("SELECT auto_vocab FROM user_settings WHERE user = ?")
      .bind(me.user).first();
    out.auto_vocab = !!(row && row.auto_vocab);
  } catch (e) {
    out.note = "settings_table_missing";
  }
  return json(out);
}

async function saveSettings(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const auto = b.auto_vocab ? 1 : 0;
  if (!env.DB) return json({ ok: true, auto_vocab: !!auto, note: "no_db" });
  try {
    await env.DB.prepare(
      "INSERT INTO user_settings (user, auto_vocab, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(user) DO UPDATE SET auto_vocab = excluded.auto_vocab, updated_at = excluded.updated_at"
    ).bind(me.user, auto, Date.now()).run();
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 120) }, 500);
  }
  return json({ ok: true, auto_vocab: !!auto });
}

async function addVocab(request, env, me) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const word = normWord(b.word);
  const book = String(b.book || "").slice(0, 60);
  if (!word || !book) return json({ ok: false, error: "missing" }, 400);
  const now = Date.now();

  // fill=true：只是后台把译文补上，不算一次新的划词，hits 不动
  if (b.fill) {
    const tr = String(b.translation || "").slice(0, 600);
    if (tr) {
      await env.DB.prepare(
        "UPDATE vocab SET translation = ? WHERE user = ? AND word = ? AND book = ? AND (translation IS NULL OR translation = '')"
      ).bind(tr, me.user, word, book).run();
    }
    const row = await env.DB.prepare(
      "SELECT word, book, hits, translation FROM vocab WHERE user = ? AND word = ? AND book = ?"
    ).bind(me.user, word, book).first();
    return json({ ok: true, item: row || null, fill: true });
  }
  await env.DB.prepare(
    "INSERT INTO vocab (user, word, book, cfi, sentence, translation, note, hits, first_at, last_at, src) " +
    "VALUES (?,?,?,?,?,?,?,1,?,?,?) " +
    "ON CONFLICT(user, word, book) DO UPDATE SET " +
    "hits = vocab.hits + 1, last_at = excluded.last_at, cfi = excluded.cfi, " +
    "sentence = COALESCE(NULLIF(excluded.sentence,''), vocab.sentence), " +
    "translation = COALESCE(NULLIF(excluded.translation,''), vocab.translation)"
  ).bind(
    me.user, word, book,
    String(b.cfi || "").slice(0, 400),
    String(b.sentence || "").slice(0, 400),
    String(b.translation || "").slice(0, 600),
    String(b.note || "").slice(0, 200),
    now, now, String(b.src || "reading").slice(0, 20)
  ).run();
  const row = await env.DB.prepare(
    "SELECT word, book, hits, translation FROM vocab WHERE user = ? AND word = ? AND book = ?"
  ).bind(me.user, word, book).first();
  return json({ ok: true, item: row || null });
}

async function listVocab(url, env, me) {
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  const cols = "SELECT word, book, cfi, sentence, translation, note, hits, first_at, last_at, src FROM vocab WHERE user = ?";
  const r = book
    ? await env.DB.prepare(cols + " AND book = ? ORDER BY last_at DESC").bind(me.user, book).all()
    : await env.DB.prepare(cols + " ORDER BY last_at DESC").bind(me.user).all();
  return json({ items: r.results || [] });
}

async function delVocab(url, env, me) {
  const word = normWord(url.searchParams.get("word"));
  const book = String(url.searchParams.get("book") || "").slice(0, 60);
  if (!word) return json({ ok: false, error: "missing word" }, 400);
  if (book) {
    await env.DB.prepare("DELETE FROM vocab WHERE user = ? AND word = ? AND book = ?").bind(me.user, word, book).run();
  } else {
    await env.DB.prepare("DELETE FROM vocab WHERE user = ? AND word = ?").bind(me.user, word).run();
  }
  return json({ ok: true });
}

async function exportVocab(url, env, me) {
  const fmt = (url.searchParams.get("format") || "json").toLowerCase();
  const r = await env.DB.prepare(
    "SELECT word, book, cfi, sentence, translation, note, hits, first_at, last_at, src FROM vocab WHERE user = ? ORDER BY last_at DESC"
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
