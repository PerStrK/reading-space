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
        var sn = document.createElement("a");
        sn.href = "/sentences.html";
        sn.textContent = "句子表";
        sn.style.cssText = "color:inherit;margin-right:12px";
        nav.appendChild(sn);
        var up = document.createElement("a");
        up.href = "/upload.html";
        up.textContent = "上传书籍";
        up.style.cssText = "color:inherit;margin-right:12px";
        nav.appendChild(up);
        var pw = document.createElement("a");
        pw.href = "#";
        pw.textContent = "改密码";
        pw.style.cssText = "color:inherit;margin-right:12px";
        pw.addEventListener("click", function (ev) { ev.preventDefault(); openPwDialog(); });
        nav.appendChild(pw);
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

  /* 自助改密码弹窗（2026-11-04）：所有登录账号可用。验旧密码后设置
     新密码；改完其他设备的登录失效，本机自动续上新会话不掉线。 */
  function openPwDialog() {
    if (document.getElementById("pwMask")) return;
    var mask = document.createElement("div");
    mask.id = "pwMask";
    mask.style.cssText = "position:fixed;inset:0;background:rgba(30,25,15,.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:18px";
    mask.innerHTML =
      '<div style="background:#fffdf9;border-radius:16px;padding:22px 20px;max-width:340px;width:100%;box-shadow:0 18px 44px rgba(0,0,0,.3)">' +
      '<h3 style="margin:0 0 4px;font-size:17px">修改密码</h3>' +
      '<p style="margin:0 0 14px;font-size:12.5px;color:#6b6459">改完后，其他设备上这个账号的登录会失效，要用新密码重新登录。</p>' +
      '<label style="display:block;font-size:13px;margin-bottom:10px">旧密码<input id="pwOld" type="password" autocomplete="current-password" style="display:block;width:100%;margin-top:4px;padding:9px 10px;font-size:14px;border:1px solid #e4d9c5;border-radius:8px;background:#fff;box-sizing:border-box"></label>' +
      '<label style="display:block;font-size:13px;margin-bottom:10px">新密码（至少 4 位）<input id="pwNew" type="password" autocomplete="new-password" style="display:block;width:100%;margin-top:4px;padding:9px 10px;font-size:14px;border:1px solid #e4d9c5;border-radius:8px;background:#fff;box-sizing:border-box"></label>' +
      '<label style="display:block;font-size:13px">再输一次新密码<input id="pwNew2" type="password" autocomplete="new-password" style="display:block;width:100%;margin-top:4px;padding:9px 10px;font-size:14px;border:1px solid #e4d9c5;border-radius:8px;background:#fff;box-sizing:border-box"></label>' +
      '<p id="pwMsg" style="min-height:20px;font-size:13px;color:#a3312a;margin:10px 0 6px"></p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button id="pwCancel" style="font-size:13.5px;padding:8px 16px;border-radius:8px;border:1px solid #e4d9c5;background:#fff;cursor:pointer">取消</button>' +
      '<button id="pwGo" style="font-size:13.5px;padding:8px 16px;border-radius:8px;border:1px solid #22262b;background:#22262b;color:#fff;cursor:pointer">确认修改</button>' +
      "</div></div>";
    document.body.appendChild(mask);
    var msg = mask.querySelector("#pwMsg");
    function close() { mask.remove(); }
    mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
    mask.querySelector("#pwCancel").addEventListener("click", close);
    mask.querySelector("#pwOld").focus();
    mask.querySelector("#pwGo").addEventListener("click", function () {
      var o = mask.querySelector("#pwOld").value;
      var n = mask.querySelector("#pwNew").value;
      var n2 = mask.querySelector("#pwNew2").value;
      if (!o) { msg.textContent = "先填旧密码。"; return; }
      if (n.length < 4) { msg.textContent = "新密码至少 4 位。"; return; }
      if (n !== n2) { msg.textContent = "两次输入的新密码不一致。"; return; }
      msg.textContent = "正在修改…";
      fetch("/api/me/password", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ old_password: o, new_password: n })
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j.ok) {
            msg.style.color = "#0f6e56";
            msg.textContent = "改好了。下次登录用新密码。";
            setTimeout(close, 1200);
          } else {
            msg.textContent = j.error || "修改失败，再试一次。";
          }
        })
        .catch(function () { msg.textContent = "网络不太顺，再试一次。"; });
    });
  }
})();
