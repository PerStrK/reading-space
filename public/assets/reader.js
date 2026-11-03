/* 阅读空间 · 阅读器
 *
 * 进度与书签优先存云端（/api/reading/*），接口不可用时自动退回 localStorage，
 * 所以本地静态预览也能正常读。
 * 高亮（划线）先存本机，第二步接生词表时再上云。
 * 翻页支持两种模式：左右翻页（paginated）/ 连续滚动（scrolled + continuous）。
 */
(function () {
  var qs = new URLSearchParams(location.search);
  var BID = qs.get("b") || "";
  var LS_P = "rs_rd_progress", LS_B = "rs_rd_bookmarks", LS_H = "rs_rd_highlights";
  var LS_FS = "rs_rd_fontsize", LS_BG = "rs_rd_bg", LS_FLOW = "rs_rd_flow";

  var $ = function (id) { return document.getElementById(id); };
  var pop = $("pop"), toast = $("toast");
  var rendition, book, meta = null, curCfi = "", curPct = 0, saveTimer = null;
  var FLOW = ls(LS_FLOW, "scrolled");
  var LS_VOCAB = "rs_rd_auto_vocab";
  var AUTO_VOCAB = ls(LS_VOCAB, false) === true;   // 划词/高亮后是否自动进生词本
  var CAN_CONTROL = true;   // 「自动入库」全站开关只有管理员能改，服务端 /api/settings 下发

  function ls(key, def) {
    try { var v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function tip(msg) {
    toast.textContent = msg;
    // 气泡在底部时，提示条改到顶部，别压住按钮
    if (pop && pop.classList.contains("on")) {
      toast.style.top = "58px";
      toast.style.bottom = "auto";
    } else {
      toast.style.top = "";
      toast.style.bottom = "";
    }
    toast.classList.add("on");
    clearTimeout(tip._t);
    tip._t = setTimeout(function () { toast.classList.remove("on"); }, 1600);
  }
  function api(url, opt) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}))
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }

  /* ---------- 进度 ---------- */
  function saveProgress(cfi, pct) {
    if (!cfi) return;
    var map = ls(LS_P, {});
    map[BID] = { book: BID, cfi: cfi, percent: pct || 0, updated_at: Date.now() };
    lsSet(LS_P, map);
    api("/api/reading/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: BID, cfi: cfi, percent: pct || 0 })
    }).catch(function () { });
  }

  function loadProgress() {
    var local = (ls(LS_P, {})[BID] || {}).cfi || "";
    return api("/api/reading/progress?book=" + encodeURIComponent(BID))
      .then(function (j) { return (j && j.cfi) || local; })
      .catch(function () { return local; });
  }

  /* ---------- 书签 ---------- */
  function loadBookmarks() {
    return api("/api/reading/bookmarks?book=" + encodeURIComponent(BID))
      .then(function (j) { return j.items || []; })
      .catch(function () { return (ls(LS_B, {})[BID] || []); });
  }
  function addBookmark(cfi, label, pct) {
    var item = { cfi: cfi, label: label, percent: pct, created_at: Date.now() };
    var all = ls(LS_B, {});
    all[BID] = (all[BID] || []).concat([item]);
    lsSet(LS_B, all);
    api("/api/reading/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: BID, cfi: cfi, label: label, percent: pct })
    }).catch(function () { });
    return item;
  }
  function delBookmark(id, cfi) {
    var all = ls(LS_B, {});
    all[BID] = (all[BID] || []).filter(function (x) { return (id ? x.id !== id : x.cfi !== cfi); });
    lsSet(LS_B, all);
    if (id) {
      api("/api/reading/bookmarks?id=" + encodeURIComponent(id), { method: "DELETE" }).catch(function () { });
    }
  }

  /* ---------- 高亮（本机） ---------- */
  function hlAll() { return ls(LS_H, {}); }
  function hlOf() { return hlAll()[BID] || []; }
  // epub.js 这个构建里的 annotations 只存不画（Contents 没有 highlight 方法），
  // 所以高亮改成自己铺一层绝对定位的色块，按 Range 的每一行矩形来放。
  var hlLayers = [];

  function hlLayer(doc) {
    var layer = doc.getElementById("rs-hl-layer");
    if (!layer) {
      layer = doc.createElement("div");
      layer.id = "rs-hl-layer";
      layer.setAttribute("style", "position:absolute; left:0; top:0; width:0; height:0; " +
        "pointer-events:none; z-index:1");
      layer.__hl = {};
      (doc.body || doc.documentElement).appendChild(layer);
      hlLayers.push(layer);
    }
    return layer;
  }

  function paintHl(cfi) {
    if (!cfi || !rendition) return;
    var range = rangeOf(cfi);
    if (!range || range.collapsed) return;
    var doc = range.startContainer.ownerDocument;
    var layer = hlLayer(doc);
    var win = doc.defaultView || window;
    var sx = win.scrollX || 0, sy = win.scrollY || 0;
    var rects = range.getClientRects();
    if (!rects || !rects.length) return;
    unpaintHl(cfi);
    var nodes = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width < 1 || r.height < 1) continue;
      var d = doc.createElement("div");
      d.setAttribute("class", "rs-hl");
      d.style.cssText = "position:absolute; pointer-events:none; border-radius:2px; " +
        "background:rgba(255,205,60,.42); left:" + (r.left + sx) + "px; top:" + (r.top + sy) + "px; " +
        "width:" + r.width + "px; height:" + r.height + "px";
      layer.appendChild(d);
      nodes.push(d);
    }
    layer.__hl[cfi] = nodes;
  }

  function unpaintHl(cfi) {
    hlLayers.forEach(function (layer) {
      var nodes = layer.__hl && layer.__hl[cfi];
      if (!nodes) return;
      nodes.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
      delete layer.__hl[cfi];
    });
  }

  function paintAllHl() {
    hlLayers = hlLayers.filter(function (l) { return l.isConnected; });  // 旧文档被替换掉就丢弃
    hlOf().forEach(function (h) { paintHl(h.cfi); });
  }

  function hlAdd(cfi, text) {
    if (!cfi) return;
    var all = hlAll();
    var list = hlOf().filter(function (h) { return h.cfi !== cfi; });
    all[BID] = list.concat([{ cfi: cfi, text: (text || "").slice(0, 120) }]);
    lsSet(LS_H, all);
    paintHl(cfi);
  }

  function markHighlight(cfi, text) {
    hlAdd(cfi, text);
    popState.mark = cfi;
    var btn = pop.querySelector('[data-act="hl"]');
    if (btn) {
      // 原地换文案，不重开气泡，已经翻好的译文不会丢
      btn.setAttribute("data-act", "unhl");
      btn.textContent = "取消高亮";
    }
  }

  function hlRemove(cfi) {
    if (!cfi) return;
    var all = hlAll();
    var list = hlOf().filter(function (h) { return h.cfi !== cfi; });
    if (list.length) all[BID] = list; else delete all[BID];
    lsSet(LS_H, all);
    unpaintHl(cfi);
  }

  // 选区对应的 cfi 是否已有高亮：先精确匹配，再按范围求交集（同一篇内）
  function hlHit(cfi) {
    if (!cfi) return "";
    var list = hlOf();
    for (var i = 0; i < list.length; i++) if (list[i].cfi === cfi) return cfi;
    if (!rendition) return "";
    var cur = rangeOf(cfi);
    if (!cur) return "";
    for (var j = 0; j < list.length; j++) {
      var r = rangeOf(list[j].cfi);
      if (!r || r.startContainer.ownerDocument !== cur.startContainer.ownerDocument) continue;
      try {
        var aStartBeforeBEnd = cur.compareBoundaryPoints(Range.START_TO_END, r) < 0;
        var aEndAfterBStart = cur.compareBoundaryPoints(Range.END_TO_START, r) > 0;
        if (aStartBeforeBEnd && aEndAfterBStart) return list[j].cfi;
      } catch (e) {}
    }
    return "";
  }

  function rangeOf(cfi) {
    try { return rendition.getRange(cfi) || null; } catch (e) { return null; }
  }

  /* ---------- 面板 ---------- */
  function openPanel(id) {
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("on"); });
    $(id).classList.add("on");
    $("mask").classList.add("on");
  }
  function closePanels() {
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("on"); });
    $("mask").classList.remove("on");
    pop.classList.remove("on");
  }

  function renderBookmarks(items) {
    var box = $("bmList");
    if (!items.length) {
      box.innerHTML = '<div style="padding:14px 16px;color:#9a917f;font-size:12.5px">还没有书签。读到想记住的地方，点右上角的书签图标。</div>';
      return;
    }
    box.innerHTML = items.map(function (b) {
      return '<div class="row" style="display:flex;gap:8px;align-items:center">' +
        '<span style="flex:1" data-go="' + b.cfi + '">' + (b.label || ("位置 " + Math.round((b.percent || 0) * 100) + "%")) +
        '<small>' + (b.created_at ? new Date(b.created_at).toLocaleDateString("zh-CN") : "") + "</small></span>" +
        '<span data-del="' + (b.id || "") + '" data-cfi="' + b.cfi + '" style="color:#c2352b;font-size:12px;cursor:pointer;padding:4px 6px">删</span>' +
        "</div>";
    }).join("");
  }
  function renderBookmarksLater() {
    loadBookmarks().then(renderBookmarks).catch(function () { renderBookmarks(ls(LS_B, {})[BID] || []); });
  }

  /* ---------- 划词气泡 ---------- */
  var popState = { cfi: "", text: "", trans: "", mark: "", sentence: "" };
  var popLock = 0;   // 最近一次在气泡里按下/触摸的时间

  // 把选区扩展到所在的完整句子：在整段文字里按句末标点切分，取包含选区的那一句
  function expandSentence(full, selText) {
    var norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim(); };
    var text = norm(full), sel = norm(selText);
    if (!text || !sel) return "";
    var at = text.indexOf(sel);
    if (at < 0) return "";
    var start = 0, end = text.length;
    var lm = text.slice(0, at).match(/^[\s\S]*[.!?。！？…]+(?:["'"'”’)\]]+)?\s+/);
    if (lm) start = lm[0].length;
    var rm = text.slice(at + sel.length).match(/[.!?。！？…]+(?:["'"'”’)\]]+)?/);
    if (rm) end = at + sel.length + rm.index + rm[0].length;
    var out = text.slice(start, end).trim();
    return out.length >= sel.length ? out : "";
  }
  // EPUB：从选区所在段落的文字里取完整句
  function sentenceAround(range, selText) {
    try {
      var node = range && range.startContainer;
      var block = node && node.nodeType === 3 ? node.parentElement : node;
      while (block && !/^(P|DIV|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|TD|DD|DT)$/.test(block.tagName || "")) block = block.parentElement;
      if (!block) return "";
      return expandSentence(String(block.textContent || ""), selText);
    } catch (e) { return ""; }
  }

  function showPop(text, cfiRange, sentence) {
    var markCfi = hlHit(cfiRange);
    popState = { cfi: cfiRange, text: text, trans: "", mark: markCfi, sentence: sentence || "", extra: null };
    pop.innerHTML =
      '<div class="hd">' +
        '<div class="w"></div>' +
        '<button class="x" data-act="close" aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="acts">' +
        '<button class="primary" data-act="tr">翻译</button>' +
        '<button data-act="vocab">存生词</button>' +
        (markCfi
          ? '<button data-act="unhl">取消高亮</button>'
          : '<button data-act="hl">高亮</button>') +
      "</div>" +
      '<div class="tr"></div>' +
      '<div class="more"><button data-act="expand">展开全文</button></div>';
    pop.querySelector(".w").textContent = text.length > 90 ? text.slice(0, 90) + "…" : text;
    pop.classList.add("on");
  }

  function refreshClamp() {
    var box = pop.querySelector(".tr");
    var more = pop.querySelector(".more");
    if (!box || !more) return;
    box.classList.remove("full");
    requestAnimationFrame(function () {
      var clipped = box.scrollHeight > box.clientHeight + 4;
      box.classList.toggle("clipped", clipped);
      more.classList.toggle("on", clipped);
      var b = more.querySelector("button");
      if (b) b.textContent = "展开全文";
    });
  }

  // 译文里的 /音标/ 单独套个样式，看着像词典；模型输出一律先转义再插入
  function fmtTrans(s) {
    var esc = String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(/(^|\n)([ \t]*)(\/[^\/\n]{1,40}\/)/, "$1$2<span class=\"ipa\">$3</span>");
  }
  function showTrans(msg, waiting) {
    var box = pop.querySelector(".tr");
    if (!box) return;
    box.innerHTML = fmtTrans(msg);
    box.classList.remove("full");
    box.classList.add("on");
    box.classList.toggle("wait", !!waiting);
    var more = pop.querySelector(".more");
    if (waiting) { if (more) more.classList.remove("on"); }
    else refreshClamp();
  }

  // 服务端已经清洗过一遍；这里再兜一层，防止旧缓存或模型偶发把思考过程带回来
  var COT = /(thinking process|思考过程|analyze the request|output format|draft\s*[:：]|task\s*[:：]|input\s*[:：]|step\s*\d)/i;
  function cleanTrans(s) {
    s = String(s || "").trim();
    if (!COT.test(s)) return s;
    var keep = s.split(/\n+/).map(function (x) { return x.trim(); }).filter(function (l) {
      return l && !COT.test(l) && /[\u4e00-\u9fa5]/.test(l) && l.length <= 120;
    });
    return keep.slice(-2).join("\n") || "这段没拿到干净的译文，再点一次「翻译」试试。";
  }

  function translateOnce(text) {
    return api("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text, sentence: popState.sentence || "" })
    }).then(function (j) {
      if (!j.ok) throw new Error(j.hint || j.error || "翻译失败");
      return j;
    });
  }
  function translate(text) {
    showTrans("翻译中…", true);
    return translateOnce(text).catch(function () {
      // 慢请求可能被网关先掐断，但服务端常已算完并存入缓存，重试一次多半秒回
      showTrans("翻译中…（再试一次）", true);
      return new Promise(function (res) { setTimeout(res, 2500); })
        .then(function () { return translateOnce(text); });
    }).then(function (j) {
      var out;
      if (j.is_word) {
        // 单词：释义 + 例句（带译文）+ 所在原句（带译文），分块展示
        var def = cleanTrans(String(j.text || "").split(/\n+/)[0] || "");
        popState.extra = { def: def, example: j.example || "", exampleZh: j.example_zh || "", sentenceZh: j.sentence_zh || "" };
        out = def;
        if (j.example) out += "\n例句：" + j.example + (j.example_zh ? "\n" + j.example_zh : "");
        if (popState.sentence) out += "\n原句：" + popState.sentence + (j.sentence_zh ? "\n" + j.sentence_zh : "");
      } else {
        popState.extra = null;
        out = cleanTrans(j.text);
      }
      showTrans(out, false);
      popState.trans = out;
      return out;
    }).catch(function (e) {
      showTrans("翻译没成功：" + e.message, false);
      throw e;
    });
  }

  function saveVocab(text, translation, fill) {
    var ex = popState.extra || {};
    return api("/api/vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        word: text.slice(0, 60),
        book: BID,
        cfi: popState.cfi,
        sentence: (popState.sentence || text).slice(0, 300),
        translation: ex.def || translation || "",
        sentence_zh: ex.sentenceZh || "",
        example: ex.example || "",
        example_zh: ex.exampleZh || "",
        src: "reading",
        fill: !!fill
      })
    });
  }

  ["mousedown", "touchstart", "pointerdown"].forEach(function (t) {
    pop.addEventListener(t, function () { popLock = Date.now(); }, { passive: true });
  });

  pop.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    var act = b.getAttribute("data-act");
    var cfi = popState.cfi, text = popState.text || "";
    if (act === "close") { pop.classList.remove("on"); return; }
    if (act === "expand") {
      var box = pop.querySelector(".tr");
      var full = box.classList.toggle("full");
      box.classList.toggle("clipped", !full);
      b.textContent = full ? "收起" : "展开全文";
      return;
    }
    if (act === "tr") {
      translate(text).then(function (tr) {
        // 自动模式：点「翻译」= 翻译 + 存入生词本 + 顺手高亮，一次做完
        if (!AUTO_VOCAB) return;
        saveVocab(text, tr).then(function (j) {
          tip(j && j.item && j.item.hits > 1 ? "译文已出，生词再记一次（第 " + j.item.hits + " 次）" : "译文已出，已存入生词本");
        }).catch(function () {});
        if (!popState.mark) markHighlight(cfi, text);
      }).catch(function () {});
    }
    if (act === "hl") {
      markHighlight(cfi, text);
      tip("已高亮");
    }
    if (act === "unhl") {
      hlRemove(popState.mark || cfi);
      popState.mark = "";
      tip("已取消高亮");
      b.setAttribute("data-act", "hl");
      b.textContent = "高亮";
    }
    if (act === "vocab") {
      b.disabled = true;
      var done = function (tr) {
        saveVocab(text, tr).then(function (j) {
          tip(j && j.item && j.item.hits > 1 ? "生词已记下（第 " + j.item.hits + " 次）" : "已存入生词本");
        }).catch(function () { tip("存失败了，稍后再试"); })
          .then(function () { b.disabled = false; });
      };
      if (popState.trans) done(popState.trans);
      else translate(text).then(done).catch(function () { b.disabled = false; });
    }
  });
  document.addEventListener("click", function (e) {
    if (!pop.contains(e.target) && !e.target.closest("#viewer")) pop.classList.remove("on");
  });

  /* ---------- 进度条 / 翻页 ---------- */
  function setPct(p) {
    curPct = p || 0;
    $("pbar").style.width = Math.round(curPct * 100) + "%";
    $("pct").innerHTML = "<b>" + Math.round(curPct * 100) + "</b>%";
  }
  $("prevBtn").onclick = function () { rendition && rendition.prev(); };
  $("nextBtn").onclick = function () { rendition && rendition.next(); };
  document.addEventListener("keydown", function (e) {
    if (!rendition || FLOW !== "paginated") return;
    if (e.key === "ArrowLeft") rendition.prev();
    if (e.key === "ArrowRight") rendition.next();
  });

  /* ---------- 排版 / 事件绑定 ---------- */
  function applyTheme() {
    rendition.themes.default({
      "body": {
        "font-family": 'Georgia, "Songti SC", "Times New Roman", serif',
        "line-height": "1.78",
        "padding": "0 6px"
      },
      "p": { "margin": "0 0 .85em" },
      "img": { "max-width": "100%", "height": "auto" },
      "::selection": { "background": "rgba(255,200,80,.55)" },
      ".hl": { "fill": "#ffd75e", "fill-opacity": ".42" }
    });
    rendition.themes.fontSize(ls(LS_FS, 100) + "%");
  }

  function bindRendition() {
    rendition.on("relocated", function (loc) {
      if (!loc || !loc.start) return;
      curCfi = loc.start.cfi;
      var p = loc.start.percentage;
      if ((typeof p !== "number" || p <= 0) && book.locations && book.locations.length()) {
        try { p = book.locations.percentageFromCfi(curCfi); } catch (e) {}
      }
      if (typeof p === "number" && p > 0) setPct(p);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveProgress(curCfi, curPct); }, 1200);
    });

    rendition.on("selected", function (cfiRange) {
      // 点气泡按钮时浏览器会把 iframe 里的选区清掉/改动，会再触发一次 selected。
      // 这会把刚切好的按钮状态（取消高亮）和译文冲掉，所以两个闸口都要拦。
      if (Date.now() - popLock < 700) return;
      if (pop.classList.contains("on") && popState.cfi === cfiRange) return;
      var text = "";
      var range = null;
      try { range = rendition.getRange(cfiRange); text = range.toString(); } catch (e) {}
      if (!text || !text.trim()) return;
      showPop(text.trim(), cfiRange, sentenceAround(range, text.trim()));
    });

    // 点击左右两侧翻页（只在分页模式；滚动模式下不拦点击）
    //
    // 这里有个容易踩的坑：epub.js 分页时会把 iframe 撑成「所有栏位之和」，
    // 比如屏宽 390 的一章有 10 页，iframe 就是 3900 宽、整体左移显示其中一屏，
    // 而点击事件里的 clientX 是相对这 3900 的文档坐标。
    // 如果拿 documentElement 的宽度当分母，阈值会变成 0.28×3900≈1092，
    // 屏幕右侧（clientX 只有几百）反而落进"左区"，点下一页就跳回上一页。
    // 正确做法：用 iframe 元素在父页面里的位置换算出"可见窗口"的宽度再比。
    function tapTurn(e, doc) {
      var win = doc.defaultView || window;
      var fe = win.frameElement;
      var ratio = -1;
      try {
        var pdoc = win.parent.document;
        var viewRect = pdoc.getElementById("viewer").getBoundingClientRect();
        var rect = fe.getBoundingClientRect();
        // iframe 坐标 → 父页面坐标：iframe 被整体左移，坐标要补上 rect.left
        var px = rect.left + e.clientX;
        if (viewRect.width > 0) ratio = (px - viewRect.left) / viewRect.width;
      } catch (err) {}
      if (!(ratio >= 0)) ratio = e.clientX / (win.innerWidth || 1);
      if (ratio < 0.3) rendition.prev();
      else if (ratio > 0.7) rendition.next();
    }

    rendition.on("rendered", function (section, view) {
      var doc = view && view.document;
      if (!doc || doc.__rsTapBound) return;
      doc.__rsTapBound = true;   // 同一篇可能被重复渲染，别叠多个监听
      setTimeout(paintAllHl, 60);   // 新文档起来后把已存的高亮铺回去
      doc.addEventListener("click", function (e) {
        if (FLOW !== "paginated") return;
        if (e.target.closest("a")) return;
        // 气泡开着时，第一次点正文只负责收气泡，别顺手翻页
        if (pop.classList.contains("on")) { pop.classList.remove("on"); return; }
        var sel = doc.getSelection();
        if (sel && String(sel).trim()) return;
        tapTurn(e, doc);
      });
    });
  }

  /* ---------- 挂载 / 切换翻页方式 ---------- */
  function mount(cfi) {
    if (rendition) {
      try { rendition.destroy(); } catch (e) {}
      rendition = null;
    }
    var scrolled = FLOW === "scrolled";
    rendition = book.renderTo("viewer", {
      width: "100%",
      height: "100%",
      flow: scrolled ? "scrolled" : "paginated",
      manager: scrolled ? "continuous" : "default",
      spread: "none",
      allowScriptedContent: true
    });
    applyTheme();
    bindRendition();
    document.body.classList.toggle("scrolled", scrolled);
    markFlowButtons();
    rendition.display(cfi || undefined);

    // 高亮随 rendition 重建后重新铺（等首页渲染完再铺，Range 才取得出矩形）
    setTimeout(paintAllHl, 300);
  }

  function markFlowButtons() {
    var a = $("flowPage"), b = $("flowScroll");
    if (!a || !b) return;
    var on = "background:#fdf3f1;color:#c2352b;border-color:#f0c9c2";
    var off = "background:none;color:#3a342a;border-color:#e4d9c5";
    a.style.cssText = a.style.cssText.replace(/(background|color|border-color):[^;]*;?/g, "");
    b.style.cssText = b.style.cssText.replace(/(background|color|border-color):[^;]*;?/g, "");
    a.style.cssText += ";" + (FLOW === "paginated" ? on : off);
    b.style.cssText += ";" + (FLOW === "scrolled" ? on : off);
  }

  function loadSettings() {
    return api("/api/settings")
      .then(function (j) {
        if (j && typeof j.auto_vocab === "boolean") {
          AUTO_VOCAB = j.auto_vocab;
          lsSet(LS_VOCAB, AUTO_VOCAB);
        }
        if (j && typeof j.can_control === "boolean") CAN_CONTROL = j.can_control;
      })
      .catch(function () {})
      .then(markVocabButtons);
  }

  function saveAutoVocab(on) {
    if (!CAN_CONTROL) { tip("「自动入库」由管理员统一控制"); markVocabButtons(); return; }
    AUTO_VOCAB = !!on;
    lsSet(LS_VOCAB, AUTO_VOCAB);
    markVocabButtons();
    api("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auto_vocab: AUTO_VOCAB })
    }).catch(function () {});
    tip(AUTO_VOCAB ? "以后划词/高亮自动进生词本" : "改为手动：点「存生词」才记");
  }

  function markVocabButtons() {
    var a = $("vocabManual"), b = $("vocabAuto");
    if (!a || !b) return;
    var on = "background:#fdf3f1;color:#c2352b;border-color:#f0c9c2";
    var off = "background:none;color:#3a342a;border-color:#e4d9c5";
    a.style.cssText = a.style.cssText.replace(/(background|color|border-color):[^;]*;?/g, "");
    b.style.cssText = b.style.cssText.replace(/(background|color|border-color):[^;]*;?/g, "");
    a.style.cssText += ";" + (AUTO_VOCAB ? off : on);
    b.style.cssText += ";" + (AUTO_VOCAB ? on : off);
  }

  function setFlow(f) {
    if (f === FLOW) return;
    FLOW = f;
    lsSet(LS_FLOW, f);
    mount(curCfi || undefined);
    tip(f === "scrolled" ? "已切换：连续滚动" : "已切换：左右翻页");
    closePanels();
  }

  /* ---------- 打开书 ---------- */
  fetch("books.json", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (list) {
      meta = (list || []).filter(function (b) { return b.id === BID; })[0];
      if (!meta) throw new Error("没有这本书");
      $("ttl").textContent = meta.title;
      document.title = meta.title + " · 阅读";
      var bg = ls(LS_BG, "day");
      document.body.className = (bg === "day" ? "" : bg);

      book = ePub(meta.file);

      book.loaded.navigation.then(function (nav) {
        $("tocBody").innerHTML = (nav.toc || []).map(function (c) {
          return '<button class="row" data-href="' + c.href + '">' + (c.label || "").trim() +
            (c.sub && c.sub.length ? "<small>" + c.sub.length + " 个小节</small>" : "") + "</button>";
        }).join("") || '<div style="padding:14px 16px;color:#9a917f">这本书没有目录。</div>';
      });

      loadSettings();
      book.ready.then(function () {
        return loadProgress().then(function (cfi) {
          $("hint").style.display = "none";
          mount(cfi || undefined);
          // 生成全书定位表：进度百分比靠它才准，大书会花一两秒，后台跑
          return book.locations.generate(1100).then(function () {
            if (curCfi) {
              try { setPct(book.locations.percentageFromCfi(curCfi)); } catch (e) {}
              saveProgress(curCfi, curPct);
            }
          }).catch(function () {});
        });
      }).catch(function (e) {
        $("hint").textContent = "这本书打不开：" + (e && e.message || e);
        $("hint").style.display = "block";
      });
    })
    .catch(function (e) {
      $("hint").textContent = "这本书打不开：" + (e && e.message || e);
      $("hint").style.display = "block";
    });

  /* ---------- 顶栏与面板按钮 ---------- */
  $("tocBtn").onclick = function () { openPanel("tocPanel"); };
  $("listBtn").onclick = function () { renderBookmarksLater(); markFlowButtons(); openPanel("listPanel"); };
  $("bmBtn").onclick = function () {
    if (!curCfi) return;
    addBookmark(curCfi, (meta ? meta.title : "阅读") + " · " + Math.round(curPct * 100) + "%", curPct);
    renderBookmarksLater();
    tip("已加书签");
  };
  $("mask").onclick = closePanels;
  document.querySelectorAll("[data-close]").forEach(function (el) { el.onclick = closePanels; });
  $("flowPage").onclick = function () { setFlow("paginated"); };
  $("flowScroll").onclick = function () { setFlow("scrolled"); };
  $("vocabManual").onclick = function () { saveAutoVocab(false); };
  $("vocabAuto").onclick = function () { saveAutoVocab(true); };

  document.addEventListener("click", function (e) {
    var h = e.target.closest("[data-href]");
    if (h) { closePanels(); rendition.display(h.getAttribute("data-href")); return; }
    var go = e.target.closest("[data-go]");
    if (go) { closePanels(); rendition.display(go.getAttribute("data-go")); return; }
    var del = e.target.closest("[data-del]");
    if (del) {
      delBookmark(del.getAttribute("data-del"), del.getAttribute("data-cfi"));
      renderBookmarksLater();
      tip("已删除");
      return;
    }
    var fsBtn = e.target.closest("[data-fs]");
    if (fsBtn) {
      var fs = ls(LS_FS, 100) + (fsBtn.getAttribute("data-fs") === "+" ? 10 : -10);
      fs = Math.max(70, Math.min(180, fs));
      lsSet(LS_FS, fs);
      rendition.themes.fontSize(fs + "%");
      setTimeout(paintAllHl, 320);
      tip("字号 " + fs + "%");
      return;
    }
    var bgBtn = e.target.closest("[data-bg]");
    if (bgBtn) {
      var b = bgBtn.getAttribute("data-bg");
      lsSet(LS_BG, b);
      document.body.className = (b === "day" ? "" : b) + (FLOW === "scrolled" ? " scrolled" : "");
      tip({ day: "纸白", sepia: "米黄", night: "夜间" }[b]);
    }
  });

  window.addEventListener("pagehide", function () {
    if (curCfi) saveProgress(curCfi, curPct);
  });

  // 调试入口：只在 ?debug=1 时挂出来，方便本地验证气泡与翻译，不影响正常使用
  if (/[?&]debug=1/.test(location.search)) {
    window.__rd = {
      showPop: showPop,
      translate: translate,
      refresh: refreshClamp,
      setFlow: setFlow,
      hlAdd: hlAdd,
      hlRemove: hlRemove,
      hlHit: hlHit,
      rendition: function () { return rendition; }
    };
  }
})();
