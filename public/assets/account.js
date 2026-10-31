/* 阅读空间 · 当前登录账号标记
 *
 * 静态页面拿不到账号，向后端 /api/me 取一次身份，把右上角的
 * <span class="acct" id="acct" hidden></span> 填上。
 * 后端渲染的页面（/my、/admin）直接写死，不依赖这里。
 */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  var el = document.getElementById("acct");
  if (!el) return;
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    })
    .then(function (d) {
      if (!d || !d.user) return;
      el.textContent = d.label + " · " + d.user;
      el.className = "acct " + (d.role === "admin" ? "acct-admin" : "acct-child");
      el.hidden = false;
    })
    .catch(function () {});
})();
