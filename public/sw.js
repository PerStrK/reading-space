/* 阅读空间 Service Worker：让重复打开接近秒开。
   策略：页面外壳 / 静态资源 / 封面 / 书文件用「先出缓存、后台更新」（stale-while-revalidate）；
   /books.json 网络优先（保证书架数据新鲜），断网时回退缓存；/api/ 一律不缓存。
   缓存的都是当前登录用户自己的内容，存在自己浏览器里；登录跳转（/login）永不写入缓存。 */
const VERSION = "rs-v11";
const PRECACHE = [
  "/library", "/reader", "/pdf", "/vocab", "/sentences", "/upload",
  "/assets/site.css", "/assets/library.js", "/assets/account.js",
  "/assets/reader.js", "/assets/pdf-reader.js",
  "/assets/vendor/jszip.min.js", "/assets/vendor/epub.min.js",
  "/assets/vendor/pdf.min.mjs", "/assets/vendor/pdf.worker.min.mjs",
  "/apple-touch-icon.png", "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isLoginRedirect(request, response) {
  try {
    const reqPath = new URL(request.url).pathname;
    const resPath = new URL(response.url).pathname;
    return resPath === "/login" && reqPath !== "/login";
  } catch (err) {
    return false;
  }
}

/* 关键：导航请求的 redirect 模式是 manual，直接 fetch(request) 会把
   /reader.html 的 308 跳转原样交回浏览器、导致导航失败（rs-v1 的教训）。
   一律用同 URL 新构造的请求抓取（默认 follow），拿到最终页面再返回/缓存。 */
/* 站点把 /xxx.html 308 跳到无后缀的 /xxx。Safari 只要发现 SW 交回的
   导航响应「经历过重定向」就整页拒绝（"Response served by service worker
   has redirections"，用户实测截图确认）。所以从源头绕开：抓取前先把
   .html 地址改成无后缀地址，让这次抓取本身就不产生重定向。 */
function mapUrl(u) {
  const url = new URL(u);
  if (url.pathname.endsWith(".html")) url.pathname = url.pathname.slice(0, -5);
  return url.href;
}

function fetchFollow(request) {
  return fetch(new Request(mapUrl(request.url), { credentials: "same-origin" }));
}

/* iOS Safari 不接受 SW 把「跟随过重定向」的响应直接交回给导航：
   首次打开新页面必报错，刷新时走缓存（存好的副本没有重定向标记）才正常（rs-v3 的教训）。
   返回前把这类响应重建成一个干净的同内容响应。 */
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function swr(request) {
  const cache = await caches.open(VERSION);
  const hit = (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(mapUrl(request.url), { ignoreSearch: true }));
  const network = fetchFollow(request)
    .then((res) => {
      if (res && res.ok && !isLoginRedirect(request, res)) {
        cache.put(request, res.clone()).catch(() => {});
        const mapped = mapUrl(request.url);
        if (mapped !== request.url) cache.put(mapped, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await network;
  if (res) return clean(res);
  return new Response("offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetchFollow(request);
    if (res && res.ok && !isLoginRedirect(request, res)) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return clean(res);
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const request = e.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/")) return;                    // 接口永远走网络
  if (p === "/books.json") { e.respondWith(networkFirst(request)); return; }
  if (p === "/sw.js") return;
  if (p.startsWith("/bookfile/")) return;               // 书文件不经缓存层：直连网络（大文件经 SW 克隆转发在 iOS 上首读易坏，刷新走缓存才正常——rs-v3 教训）
  if (
    request.mode === "navigate" ||
    p.endsWith(".html") || p === "/" ||
    p.startsWith("/assets/") ||
    p.startsWith("/bookcover/") ||
    p === "/apple-touch-icon.png" || p === "/icon-512.png"
  ) {
    e.respondWith(swr(request));
  }
});
