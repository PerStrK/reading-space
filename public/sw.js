/* 阅读空间 Service Worker：让重复打开接近秒开。
   策略：页面外壳 / 静态资源 / 封面 / 书文件用「先出缓存、后台更新」（stale-while-revalidate）；
   /books.json 网络优先（保证书架数据新鲜），断网时回退缓存；/api/ 一律不缓存。
   缓存的都是当前登录用户自己的内容，存在自己浏览器里；登录跳转（/login）永不写入缓存。 */
const VERSION = "rs-v1";
const PRECACHE = [
  "/library.html", "/reader.html", "/pdf.html", "/vocab.html", "/sentences.html", "/upload.html",
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

async function swr(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok && !isLoginRedirect(request, res)) {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await network;
  if (res) return res;
  return new Response("offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res && res.ok && !isLoginRedirect(request, res)) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
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
  if (
    request.mode === "navigate" ||
    p.endsWith(".html") || p === "/" ||
    p.startsWith("/assets/") ||
    p.startsWith("/bookcover/") ||
    p.startsWith("/bookfile/") ||
    p === "/apple-touch-icon.png" || p === "/icon-512.png"
  ) {
    e.respondWith(swr(request));
  }
});
