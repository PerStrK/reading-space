/* 阅读空间 · 书架
 * 读 books.json 出书卡；进度优先问 /api/reading/progress，接口不在时用 localStorage 兜底。
 */
(function () {
  var shelf = document.getElementById("shelf");
  var LS_KEY = "rs_reading_local_progress";

  function localProgress() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { return {}; }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function paint(books, prog) {
    if (!books.length) {
      shelf.innerHTML = '<p class="empty">书架还是空的。点右上角「上传书籍」，就能把 EPUB / PDF 放进来。</p>';
      return;
    }
    // 有进度的排前面，其次按加入顺序
    books.sort(function (a, b) {
      var pa = (prog[a.id] || {}).percent || 0, pb = (prog[b.id] || {}).percent || 0;
      return pb - pa;
    });
    shelf.innerHTML = books.map(function (b) {
      var p = prog[b.id] || {};
      var pct = Math.round((p.percent || 0) * 100);
      var label = pct > 0 ? "读到 " + pct + "%" : "未开始";
      var href = b.url || ("reader.html?b=" + encodeURIComponent(b.id));
      var unit = b.format === "pdf" ? ((b.pages || b.chapters || "") + " 页") : ((b.chapters || "") + " 节");
      return '<a class="bk" href="' + href + '">' +
        '<div class="cv">' +
        '<img src="' + esc(b.cover) + '" alt="' + esc(b.title) + '" loading="lazy">' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="badge"><span>' + label + "</span><span>" + unit + "</span></div>" +
        "</div>" +
        "<h3>" + esc(b.title) + "</h3>" +
        '<div class="au">' + esc(b.author || "未知作者") + "</div>" +
        (b.level ? '<div class="lv">' + esc(b.level) + "</div>" : "") +
        "</a>";
    }).join("");
  }

  fetch("books.json", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (books) {
      fetch("/api/reading/progress?all=1", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (j) {
          var prog = {};
          (j.items || []).forEach(function (it) { prog[it.book] = it; });
          paint(books, Object.keys(prog).length ? prog : localProgress());
        })
        .catch(function () { paint(books, localProgress()); });
    })
    .catch(function () {
      shelf.innerHTML = '<p class="empty">书目读不出来，刷新试试。</p>';
    });
})();
