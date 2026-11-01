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
      // 账号标记后面顺手挂两个入口：上传书籍（所有人）、后台管理（仅管理员）
      try {
        var nav = document.createElement("span");
        nav.style.cssText = "margin-left:10px;font-size:12.5px;white-space:nowrap";
        var vb = document.createElement("a");
        vb.href = "/vocab.html";
        vb.textContent = "生词本";
        vb.style.cssText = "color:inherit;margin-right:12px";
        nav.appendChild(vb);
        var up = document.createElement("a");
        up.href = "/upload.html";
        up.textContent = "上传书籍";
        up.style.cssText = "color:inherit;margin-right:12px";
        nav.appendChild(up);
        if (d.role === "admin") {
          var ad = document.createElement("a");
          ad.href = "/admin";
          ad.textContent = "后台管理";
          ad.style.cssText = "color:inherit";
          nav.appendChild(ad);
        }
        el.parentNode.insertBefore(nav, el.nextSibling);
      } catch (e) {}
    })
    .catch(function () {});
})();
