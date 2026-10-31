/* 阅读空间 · PDF 阅读器
 *
 * 和 EPUB 阅读器共用同一套后端：进度 / 书签 / 翻译 / 生词本 / 偏好。
 * 区别在渲染：pdf.js 画 canvas，再铺一层透明文字层用来选词。
 * 高亮自己画色块（用 PDF 坐标归一化存，缩放、换页都能复原）。
 *
 * 两种翻页方式：
 *   左右翻页（paginated）——一次一页，跟翻书一样。
 *   连续滚动（scrolled）——一页接一页往下滚。
 *     滚动模式用「窗口化」渲染：全书每一页先占好位置（滚动条长度稳定），
 *     但只把视口附近的页真正画出来，远处��只留空壳，滚回来再画。
 */
(function () {
  var qs = new URLSearchParams(location.search);
  var BID = qs.get("b") || "";
  var LS_P = "rs_rd_progress", LS_B = "rs_rd_bookmarks", LS_VOCAB = "rs_rd_auto_vocab";
  var LS_HL = "rs_pdf_hl_" + BID;
  // 翻页方式：和 EPUB 阅读器共用（rs_rd_flow），任一边切换另一边同步
  var LS_FLOW = "rs_rd_flow";

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("cv"), ctx = canvas.getContext("2d");
  var stage = $("stage"), viewer = $("viewer"), pageBox = $("page"), flowBox = $("flow");
  var tlDiv = $("tl"), hlLayer = $("hlLayer");
  var pop = $("pop"), toast = $("toast");

  var book = null, doc = null, numPages = 0;
  // pageNo    = 当前显示的页
  // wantPage  = 想去的页（用户意图，连点时在这里累加）
  // targetPage= 本轮要渲染的页
  // pendingPage = 渲染中又收到的新目标，画完接着渲
  var pageNo = 1, scale = 1, fitWidth = true, renderTask = null, rendering = false,
      pendingPage = 0, targetPage = 0, wantPage = 1, userPicked = false;
  var curPct = 0, saveTimer = null, popState = { text: "", rects: [], page: 0, hl: -1 };
  var AUTO_VOCAB = ls(LS_VOCAB, false) === true;
  var popLock = 0;

  // ---- 翻页方式 ----
  // 和 EPUB 阅读器共用同一个偏好键（rs_rd_flow），在任一边切换另一边也跟着变
  var FLOW = ls(LS_FLOW, "scrolled");   // paginated | scrolled
  // ---- 滚动模式状态 ----
  var SCROLL_PAGES = [];   // 每页一个 {el, canvas, tl, hl, pn} —— 已建壳的页
  var SCROLL_INDEX = {};   // 页码 -> 该页的壳
  var scrollObserver = null;
  var scrollRaf = 0;
  var pageSizes = [];      // 每页的 {w,h}（PDF 点尺寸），用来算占位高度

  function ls(key, def) {
    try { var v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function tip(msg) {
    toast.textContent = msg;
    if (pop && pop.classList.contains("on")) { toast.style.top = "58px"; toast.style.bottom = "auto"; }
    else { toast.style.top = ""; toast.style.bottom = ""; }
    toast.classList.add("on");
    clearTimeout(tip._t);
    tip._t = setTimeout(function () { toast.classList.remove("on"); }, 1600);
  }
  function api(url, opt) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}))
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }

  /* ---------- 进度 / 书签 / 偏好 ---------- */
  function saveProgress() {
    if (!numPages) return;
    var cfi = "pdf:p" + pageNo;
    var map = ls(LS_P, {});
    map[BID] = { book: BID, cfi: cfi, percent: curPct, updated_at: Date.now() };
    lsSet(LS_P, map);
    api("/api/reading/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: BID, cfi: cfi, percent: curPct })
    }).catch(function () {});
  }
  function loadProgress() {
    var local = (ls(LS_P, {})[BID] || {}).cfi || "";
    return api("/api/reading/progress?book=" + encodeURIComponent(BID))
      .then(function (j) { return (j && j.cfi) || local; })
      .catch(function () { return local; });
  }
  function pageFromCfi(cfi) {
    var m = /pdf:p(\d+)/.exec(cfi || "");
    return m ? Math.max(1, parseInt(m[1], 10)) : 0;
  }

  function loadSettings() {
    return api("/api/settings").then(function (j) {
      if (j && typeof j.auto_vocab === "boolean") { AUTO_VOCAB = j.auto_vocab; lsSet(LS_VOCAB, AUTO_VOCAB); }
    }).catch(function () {}).then(markVocabButtons);
  }
  function saveAutoVocab(on) {
    AUTO_VOCAB = !!on;
    lsSet(LS_VOCAB, AUTO_VOCAB);
    markVocabButtons();
    api("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auto_vocab: AUTO_VOCAB })
    }).catch(function () {});
    tip(AUTO_VOCAB ? "以后点「翻译」自动入库并高亮" : "改为手动：点「存生词」才记");
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

  function loadBookmarks() {
    return api("/api/reading/bookmarks?book=" + encodeURIComponent(BID))
      .then(function (j) { return j.items || []; })
      .catch(function () { return (ls(LS_B, {})[BID] || []); });
  }
  function addBookmark(label) {
    var cfi = "pdf:p" + pageNo;
    var local = ls(LS_B, {});
    (local[BID] = local[BID] || []).unshift({
      id: "local-" + Date.now(), book: BID, cfi: cfi, label: label, percent: curPct, created_at: Date.now()
    });
    lsSet(LS_B, local);
    return api("/api/reading/bookmarks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: BID, cfi: cfi, label: label, percent: curPct })
    }).catch(function () {});
  }
  function delBookmark(id, cfi) {
    var local = ls(LS_B, {});
    local[BID] = (local[BID] || []).filter(function (b) {
      return b.cfi !== cfi && b.id !== id;
    });
    lsSet(LS_B, local);
    return api("/api/reading/bookmarks?id=" + encodeURIComponent(id), { method: "DELETE" })
      .catch(function () {});
  }
  function renderBookmarks(items) {
    var box = $("bmList");
    if (!items.length) {
      box.innerHTML = '<div style="padding:14px 16px;color:#9a917f;font-size:12.5px">还没有书签。点右上角的书签图标，记住当前页。</div>';
      return;
    }
    box.innerHTML = items.map(function (b) {
      var p = pageFromCfi(b.cfi);
      return '<div class="row" style="display:flex;gap:8px;align-items:center">' +
        '<span style="flex:1" data-go="' + p + '">' + (b.label || ("第 " + p + " 页")) +
        '<small>' + (b.created_at ? new Date(b.created_at).toLocaleDateString("zh-CN") : "") + "</small></span>" +
        '<span data-del="' + (b.id || b.cfi) + '" data-cfi="' + b.cfi + '" style="color:#c2352b;font-size:12px;cursor:pointer;padding:4px 6px">删</span>' +
        "</div>";
    }).join("");
  }
  function refreshBookmarks() {
    loadBookmarks().then(renderBookmarks).catch(function () { renderBookmarks(ls(LS_B, {})[BID] || []); });
  }

  /* ---------- 渲染 ---------- */
  function baseViewport(pg) {
    return pg.getViewport({ scale: 1 });
  }

  function computeScale(pg) {
    var base = baseViewport(pg);
    var pad = 0;
    var w = stage.clientWidth - pad, h = stage.clientHeight - pad;
    if (fitWidth) return w / base.width;
    return Math.min(scale, w / base.width) || scale;
  }

  // 滚动模式统一缩放比：按正文页的典型宽度算（不是最宽那页），
  // 否则封面页会把整本书缩小，留出大片空白。
  function scrollScale() {
    if (fitWidth) {
      var counts = {};
      for (var i = 0; i < pageSizes.length; i++) {
        var w = pageSizes[i] && pageSizes[i].w;
        if (!w) continue;
        var k = Math.round(w);
        counts[k] = (counts[k] || 0) + 1;
      }
      // 取出现次数最多的宽度；没有统计就用最大宽
      var best = 0, bestN = 0, maxW = 1;
      for (var k2 in counts) {
        if (counts[k2] > bestN) { bestN = counts[k2]; best = +k2; }
        if (+k2 > maxW) maxW = +k2;
      }
      var ref = best || maxW;
      // 减掉页容器的左右 margin，否则最宽那页会超出视口被裁掉
      var avail = (viewer.clientWidth || stage.clientWidth) - 24;
      return avail / ref;
    }
    return scale;
  }

  function render() {
    if (!doc) return;
    // 正在渲染时又收到新目标：记下来，画完接着渲
    if (rendering) { pendingPage = targetPage || wantPage; return; }
    rendering = true;
    var target = targetPage || wantPage;
    targetPage = 0;
    pageNo = target;
    doc.getPage(target).then(function (pg) {
      var s = computeScale(pg);
      scale = s;
      var vp = pg.getViewport({ scale: s });
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(vp.width * dpr);
      canvas.height = Math.round(vp.height * dpr);
      canvas.style.width = Math.round(vp.width) + "px";
      canvas.style.height = Math.round(vp.height) + "px";
      pageBox.style.width = Math.round(vp.width) + "px";
      pageBox.style.height = Math.round(vp.height) + "px";

      if (renderTask) { try { renderTask.cancel(); } catch (e) {} }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      renderTask = pg.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });

      return renderTask.promise.then(function () {
        return pg.getTextContent();
      }).then(function (tc) {
        tlDiv.innerHTML = "";
        tlDiv.style.setProperty("--scale-factor", vp.scale);
        tlDiv.style.width = Math.round(vp.width) + "px";
        tlDiv.style.height = Math.round(vp.height) + "px";
        var TL = pdfjsLib.TextLayer;
        if (TL) {
          var layer = new TL({ textContentSource: tc, container: tlDiv, viewport: vp });
          return layer.render();
        }
        return null;
      }).then(function () {
        // 画的是 target，页码以 target 为准（render() 开头已同步）
        paintHighlights();
        updatePct();
        fitPage();
        rendering = false;
        if (pendingPage && pendingPage !== target) {
          // 画的过程中又翻了几页，接着画到最新的目标
          targetPage = pendingPage;
          pendingPage = 0;
          render();
        } else {
          pendingPage = 0;
        }
      });
    }).catch(function (e) {
      rendering = false;
      if (e && e.name === "RenderingCancelledException") return;
      $("hint").textContent = "这一页没渲染出来：" + (e && e.message || e);
      $("hint").style.display = "block";
    });
  }

  // 让页面在可视区水平居中
  function fitPage() {
    var w = pageBox.offsetWidth, h = pageBox.offsetHeight;
    pageBox.style.margin = "12px auto";
    viewer.style.minHeight = (h + 24) + "px";
  }

  /* ================================================================
   * 连续滚动模式
   * ================================================================ */

  // 视口高度：能放下几页（用来决定渲染窗口大小）
  function visibleCount() {
    var h = stage.clientHeight || 800;
    // 用真实页高算，别用 scale*634 估——各页尺寸不同，估错了窗口会太小
    var pageH = 0;
    for (var i = 0; i < pageSizes.length; i++) {
      if (!pageSizes[i]) continue;
      var s = pageScaleOf(pageSizes[i]);
      var ph = Math.round(pageSizes[i].h * s);
      if (ph > pageH) pageH = ph;
    }
    if (!pageH) pageH = Math.round(634 * scale);
    return Math.max(2, Math.min(8, Math.ceil(h / pageH) + 2));
  }

  // 某页实际用的缩放：适宽时若这页特别宽（如封面），单独收窄免得被裁
  function pageScaleOf(sz) {
    if (!fitWidth) return scale;
    var avail = (viewer.clientWidth || stage.clientWidth) - 24;
    var s = scale;
    if (sz && sz.w && sz.w * s > avail) s = avail / sz.w;
    return s;
  }

  // 画一页到它的壳里
  function drawScrollPage(rec) {
    if (!doc || rec.task) return;   // 已经在画了就别重复发起
    var pn = rec.pn;
    rec.drawn = false;
    // 先占位：getPage 是异步的，这期间必须挡住重复调用，否则会画好几次
    rec.task = { pending: true };
    doc.getPage(pn).then(function (pg) {
      var s = rec.pscale || scale;
      var vp = pg.getViewport({ scale: s });
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 到这一步才建 canvas 和文字层（不能给全书每页都建）
      var cv = document.createElement("canvas");
      var hl = document.createElement("div"); hl.className = "hl";
      var tl = document.createElement("div"); tl.className = "tl";
      var badge = document.createElement("span"); badge.className = "pn"; badge.textContent = pn;
      rec.el.appendChild(cv); rec.el.appendChild(hl); rec.el.appendChild(tl); rec.el.appendChild(badge);
      rec.canvas = cv; rec.ctx = cv.getContext("2d"); rec.hl = hl; rec.tl = tl;
      cv.width = Math.round(vp.width * dpr);
      cv.height = Math.round(vp.height * dpr);
      cv.style.width = Math.round(vp.width) + "px";
      cv.style.height = Math.round(vp.height) + "px";
      rec.el.style.width = Math.round(vp.width) + "px";
      rec.el.style.height = Math.round(vp.height) + "px";
      rec.ctx.setTransform(1, 0, 0, 1, 0, 0);
      rec.ctx.clearRect(0, 0, cv.width, cv.height);
      rec.task = pg.render({
        canvasContext: rec.ctx, viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      });
      return rec.task.promise.then(function () {
        return pg.getTextContent();
      }).then(function (tc) {
        rec.tl.innerHTML = "";
        rec.tl.style.setProperty("--scale-factor", vp.scale);
        rec.tl.style.width = Math.round(vp.width) + "px";
        rec.tl.style.height = Math.round(vp.height) + "px";
        var TL = pdfjsLib.TextLayer;
        if (TL) {
          var layer = new TL({ textContentSource: tc, container: rec.tl, viewport: vp });
          return layer.render();
        }
        return null;
      }).then(function () {
        rec.task = null;
        rec.drawn = true;
        paintScrollHl(rec);
        // 腾出位置了，接着画下一张（并发数被限制在 2，得排队）
        if (FLOW === "scrolled") drawVisiblePages();
      });
    }).catch(function (e) {
      rec.task = null;
      if (e && e.name === "RenderingCancelledException") return;
      console.warn("第 " + pn + " 页没画出来", e);
    });
  }

  // 释放远处页的画布，腾出内存（壳和高度留着，滚动条长度不变）
  function releaseFar() {
    var keep = visibleCount() + 2;
    var center = pageNo;
    SCROLL_PAGES.forEach(function (r) {
      if (!r.drawn) return;
      if (Math.abs(r.pn - center) <= keep) return;
      if (r.task && r.task.cancel) { try { r.task.cancel(); } catch (e) {} }
      r.task = null;
      r.drawn = false;
      // 把 canvas 整个从 DOM 摘掉，真正释放上下文和显存；文字层和高亮层也一起清
      if (r.canvas) {
        r.canvas.width = 0;
        r.canvas.height = 0;
        if (r.canvas.parentNode) r.canvas.parentNode.removeChild(r.canvas);
        r.canvas = null; r.ctx = null;
      }
      if (r.tl) { r.tl.innerHTML = ""; if (r.tl.parentNode) r.tl.parentNode.removeChild(r.tl); r.tl = null; }
      if (r.hl) { r.hl.innerHTML = ""; if (r.hl.parentNode) r.hl.parentNode.removeChild(r.hl); r.hl = null; }
    });
  }

  // 给某页画高亮
  function paintScrollHl(rec) {
    if (!rec.hl) return;
    rec.hl.innerHTML = "";
    var box = rec.el.getBoundingClientRect();
    if (!box.width) return;
    hlOnPage(rec.pn).forEach(function (h, hi) {
      h.rects.forEach(function (r) {
        var d = document.createElement("div");
        d.className = "pd-hl";
        d.setAttribute("data-hi", hi);
        d.style.cssText = "position:absolute; pointer-events:none; border-radius:2px; background:rgba(255,205,60,.42);" +
          "left:" + (r.x * box.width) + "px; top:" + (r.y * box.height) + "px;" +
          "width:" + (r.w * box.width) + "px; height:" + (r.h * box.height) + "px";
        rec.hl.appendChild(d);
      });
    });
  }

  // 滚到某页：把它放到视口顶部附近
  function scrollToPage(pn, smooth) {
    var rec = SCROLL_INDEX[pn];
    if (!rec) return;
    // 用 rect 差值算，避免 offsetTop 的参照系不一致（#viewer 是 absolute）
    var vr = viewer.getBoundingClientRect();
    var br = rec.el.getBoundingClientRect();
    var top = viewer.scrollTop + (br.top - vr.top) - 12;
    if (top < 0) top = 0;
    if (smooth) viewer.scrollTo({ top: top, behavior: "smooth" });
    else viewer.scrollTop = top;
  }

  // 画视口附近的页（上下各多留一屏，滚起来不卡）
  function drawVisiblePages() {
    var top = viewer.getBoundingClientRect().top;
    var mid = top + (stage.clientHeight || 800) / 2;
    var vh = stage.clientHeight || 800;
    // 按"离视口中心多近"排序，先画最该看见的页。
    // 不排序的话会按页码顺序画，视口内的页反而排在最后，白等半天。
    var todo = [];
    SCROLL_PAGES.forEach(function (r) {
      if (r.drawn || r.task) return;
      var b = r.el.getBoundingClientRect();
      if (b.bottom > top - vh && b.top < top + vh * 2) {
        todo.push({ r: r, d: Math.abs((b.top + b.bottom) / 2 - mid) });
      }
    });
    todo.sort(function (a, b) { return a.d - b.d; });
    // 同时最多画 2 页：网络慢时并发太多会互相抢带宽，反而都慢
    var budget = 2 - SCROLL_PAGES.filter(function (r) { return r.task; }).length;
    todo.forEach(function (x) {
      if (budget <= 0) return;
      drawScrollPage(x.r);
      budget--;
    });
  }

  // 滚动时：判断当前页（视口顶部那一页），渲染附近的，释放远处的
  function onScroll() {
    if (FLOW !== "scrolled") return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      var top = viewer.getBoundingClientRect().top;
      // 当前页 = 跨过视口上沿的那一页。
      // 用二分找"顶边已经滚到视口上沿之上"的最后一页——页面按顺序堆叠，位置单调。
      // 文档位置 = scrollTop + (页顶屏幕坐标 - 视口顶屏幕坐标)，和 offsetTop 等价。
      var cur = pageNo;
      var st = viewer.scrollTop;
      var lo = 0, hi = SCROLL_PAGES.length - 1, found = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        var br = SCROLL_PAGES[mid].el.getBoundingClientRect();
        var docPos = st + (br.top - top);   // 该页顶边在文档里的位置
        if (docPos <= st + 4) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (SCROLL_PAGES[found]) cur = SCROLL_PAGES[found].pn;
      if (cur !== pageNo) {
        pageNo = cur;
        wantPage = cur;
        updatePct();
      }
      drawVisiblePages();
      releaseFar();
      // 释放之后可能又腾出了位置，补画一次（否则远处的页会一直是空白）
      drawVisiblePages();
    });
  }

  // 切换到滚动模式：建好壳、定位到当前页
  function enterScrollMode() {
    document.body.classList.add("scrollmode");
    // 取每页尺寸。注意：不能对全书 174 页并发 getPage —— pdf.js worker 一次收到
    // 174 个请求，图像解码队列会被占满，真正的 render 永远排不上（实测 promise 挂死）。
    // 只取开头几页量出典型尺寸，其余按典型尺寸占位（各页差异 <5%，看不出差别）。
    var probe = Math.min(numPages, 6);
    var proms = [];
    for (var i = 1; i <= probe; i++) {
      proms.push(doc.getPage(i).then(function (pg) {
        var vp = pg.getViewport({ scale: 1 });
        pageSizes[pg.pageNumber - 1] = { w: vp.width, h: vp.height };
      }).catch(function () {}));
    }
    return Promise.all(proms).then(function () {
      // 典型尺寸：取探测到的页里最常见的高度，宽度按各自比例算
      var typical = null;
      for (var j = 0; j < pageSizes.length; j++) {
        if (pageSizes[j]) { typical = pageSizes[j]; break; }
      }
      typical = typical || { w: 400, h: 634 };
      for (var k = 0; k < numPages; k++) {
        if (pageSizes[k]) continue;
        // 未知尺寸的页按典型页的比例缩放（宽度按高度推）
        pageSizes[k] = { w: typical.w, h: typical.h };
      }
      scale = scrollScale();
      SCROLL_PAGES = [];
      SCROLL_INDEX = {};
      flowBox.innerHTML = "";
      for (var pn = 1; pn <= numPages; pn++) {
        var sz = pageSizes[pn - 1] || typical;
        var ps = pageScaleOf(sz);
        var el = document.createElement("div");
        el.className = "pg";
        el.setAttribute("data-pn", pn);
        el.style.width = Math.round(sz.w * ps) + "px";
        el.style.height = Math.round(sz.h * ps) + "px";
        // 注意：canvas / 文字层 / 高亮层不能在这里建！
        // 一本书 174 页，全建出来会开 174 个 canvas 上下文，浏览器扛不住。
        // 要等真的画这页时再建。
        var rec = { el: el, canvas: null, ctx: null, tl: null, hl: null, pn: pn, task: null, drawn: false, pscale: ps };
        SCROLL_INDEX[pn] = rec;
        SCROLL_PAGES.push(rec);
        flowBox.appendChild(el);
      }
      scrollToPage(wantPage || pageNo, false);
      pageNo = wantPage || pageNo;
      updatePct();
      drawVisiblePages();
      viewer.addEventListener("scroll", onScroll, { passive: true });
    });
  }

  // 切回左右翻页
  function exitScrollMode() {
    document.body.classList.remove("scrollmode");
    viewer.removeEventListener("scroll", onScroll);
    flowBox.innerHTML = "";
    SCROLL_PAGES = [];
    SCROLL_INDEX = {};
    pageSizes = [];
    targetPage = wantPage || pageNo;
    render();
  }

  function setFlow(f) {
    if (f === FLOW) return;
    FLOW = f;
    lsSet(LS_FLOW, f);
    document.body.classList.toggle("scrollmode", f === "scrolled");
    markFlowButtons();
    if (f === "scrolled") {
      enterScrollMode();
    } else {
      exitScrollMode();
    }
    tip(f === "scrolled" ? "已切换：连续滚动" : "已切换：左右翻页");
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

  function updatePct() {
    curPct = numPages ? Math.min(1, pageNo / numPages) : 0;
    $("pbar").style.width = Math.round(curPct * 100) + "%";
    $("pinfo").innerHTML = "<b>" + pageNo + "</b> / " + numPages;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 800);
  }

  function go(n, keepScale) {
    // 文档还没打开时不知道总页数，只夹下界，保留用户的跳转意图；
    // 否则 numPages=0 会把目标页压成 1，"打开后跳到第 50 页"就失效了。
    n = Math.max(1, numPages ? Math.min(numPages, n) : n);
    userPicked = true;         // 用户明确指定了页码，别被"恢复上次进度"覆盖
    // wantPage 是用户意图（连点时在这里累加），pageNo 只是已显示的页；
    // 翻页按钮必须基于 wantPage 递增，否则渲染中连点会一直指向同一页。
    if (n === wantPage && !keepScale) return;
    wantPage = n;
    targetPage = n;
    pop.classList.remove("on");
    if (!doc) return;          // 文档加载完会按 wantPage 渲染
    if (FLOW === "scrolled") {
      pageNo = n;
      updatePct();
      scrollToPage(n, true);
      return;
    }
    if (rendering) { pendingPage = n; return; }
    render();
    stage.scrollTop = 0;
  }

  // 相对当前意图页翻一步：渲染中连点也能一页一页累加
  function step(d) {
    go((wantPage || pageNo) + d);
  }

  /* ---------- 高亮 ---------- */
  function hlAll() { return ls(LS_HL, []); }
  function hlSet(list) { lsSet(LS_HL, list); }
  function hlOnPage(p) { return hlAll().filter(function (h) { return h.page === p; }); }

  // 重画高亮：左右翻页画单页，滚动模式把所有画过的页都重画
  function paintHighlights() {
    if (FLOW === "scrolled") {
      SCROLL_PAGES.forEach(function (r) { if (r.drawn) paintScrollHl(r); });
      return;
    }
    hlLayer.innerHTML = "";
    var box = pageBox.getBoundingClientRect();
    hlOnPage(pageNo).forEach(function (h, hi) {
      h.rects.forEach(function (r) {
        var d = document.createElement("div");
        d.className = "pd-hl";
        d.setAttribute("data-hi", hi);
        d.style.cssText = "position:absolute; pointer-events:none; border-radius:2px; background:rgba(255,205,60,.42);" +
          "left:" + (r.x * box.width) + "px; top:" + (r.y * box.height) + "px;" +
          "width:" + (r.w * box.width) + "px; height:" + (r.h * box.height) + "px";
        hlLayer.appendChild(d);
      });
    });
  }

  function normRects(rects, box) {
    return rects.map(function (r) {
      return {
        x: (r.left - box.left) / box.width,
        y: (r.top - box.top) / box.height,
        w: r.width / box.width,
        h: r.height / box.height
      };
    }).filter(function (r) { return r.w > 0.002 && r.h > 0.002; });
  }

  // 所在页：优先用选词命中的那一页，滚动模式下和锚点页可能不同
  function activePage() {
    return popState.page || pageNo;
  }

  function addHighlight(text, rects, page) {
    var p = page || activePage();
    var list = hlAll();
    list.push({ page: p, text: (text || "").slice(0, 200), rects: rects, at: Date.now() });
    hlSet(list);
    paintHighlights();
    return list.length - 1;
  }
  function removeHighlight(idx) {
    var list = hlAll();
    // idx 是"当前页的第几个"，转成全局下标
    var p = activePage();
    var onPage = [];
    list.forEach(function (h, i) { if (h.page === p) onPage.push(i); });
    var g = onPage[idx];
    if (g == null) return;
    list.splice(g, 1);
    hlSet(list);
    paintHighlights();
  }
  function hitHighlight(text, rects, page) {
    var list = hlOnPage(page || activePage());
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === (text || "").slice(0, 200)) return i;
    }
    return -1;
  }

  /* ---------- 划词气泡 ---------- */
  function showPop(text, rects, page) {
    var p = page || pageNo;
    var hi = hitHighlight(text, rects, p);
    popState = { text: text, rects: rects, page: p, hl: hi };
    pop.innerHTML =
      '<div class="hd">' +
        '<div class="w"></div>' +
        '<button class="x" data-act="close" aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="acts">' +
        '<button class="primary" data-act="tr">翻译</button>' +
        '<button data-act="vocab">存生词</button>' +
        (hi >= 0 ? '<button data-act="unhl">取消高亮</button>' : '<button data-act="hl">高亮</button>') +
      "</div>" +
      '<div class="tr"></div>' +
      '<div class="more"><button data-act="expand">展开全文</button></div>';
    pop.querySelector(".w").textContent = text.length > 90 ? text.slice(0, 90) + "…" : text;
    pop.classList.add("on");
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
    if (!waiting) refreshClamp();
  }
  function refreshClamp() {
    var box = pop.querySelector(".tr"), more = pop.querySelector(".more");
    if (!box || !more) return;
    requestAnimationFrame(function () {
      var clipped = box.scrollHeight > box.clientHeight + 4;
      box.classList.toggle("clipped", clipped);
      more.classList.toggle("on", clipped);
      var b = more.querySelector("button");
      if (b) b.textContent = "展开全文";
    });
  }

  var COT = /(thinking process|思考过程|analyze the request|output format|draft\s*[:：]|task\s*[:：]|input\s*[:：]|step\s*\d)/i;
  function cleanTrans(s) {
    s = String(s || "").trim();
    if (!COT.test(s)) return s;
    var keep = s.split(/\n+/).map(function (x) { return x.trim(); }).filter(function (l) {
      return l && !COT.test(l) && /[\u4e00-\u9fa5]/.test(l) && l.length <= 120;
    });
    return keep.slice(-2).join("\n") || "这段没拿到干净的译文，再点一次「翻译」试试。";
  }
  function translate(text) {
    showTrans("翻译中…", true);
    return api("/api/translate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text })
    }).then(function (j) {
      if (!j.ok) throw new Error(j.hint || j.error || "翻译失败");
      var out = cleanTrans(j.text);
      showTrans(out, false);
      return out;
    }).catch(function (e) {
      showTrans("翻译没成功：" + e.message, false);
      throw e;
    });
  }
  function saveVocab(text, translation, fill) {
    return api("/api/vocab", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        word: text.slice(0, 60), book: BID, cfi: "pdf:p" + activePage(),
        sentence: text.slice(0, 300), translation: translation || "", src: "pdf", fill: !!fill
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
    var text = popState.text || "";
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
        if (!AUTO_VOCAB) return;
        saveVocab(text, tr).then(function (j) {
          tip(j && j.item && j.item.hits > 1 ? "译文已出，生词再记一次（第 " + j.item.hits + " 次）" : "译文已出，已存入生词本");
        }).catch(function () {});
        if (popState.hl < 0) { popState.hl = addHighlight(text, popState.rects, popState.page); markHlButton(); }
      }).catch(function () {});
    }
    if (act === "hl") {
      popState.hl = addHighlight(text, popState.rects, popState.page);
      markHlButton();
      tip("已高亮");
    }
    if (act === "unhl") {
      removeHighlight(popState.hl);
      popState.hl = -1;
      b.setAttribute("data-act", "hl");
      b.textContent = "高亮";
      tip("已取消高亮");
    }
    if (act === "vocab") {
      b.disabled = true;
      var seed = (pop.querySelector(".tr").textContent || "").trim();
      var done = function (tr) {
        saveVocab(text, tr).then(function (j) {
          tip(j && j.item && j.item.hits > 1 ? "生词已记下（第 " + j.item.hits + " 次）" : "已存入生词本");
        }).catch(function () { tip("存失败了，稍后再试"); })
          .then(function () { b.disabled = false; });
      };
      if (seed && !/翻译中/.test(seed)) done(seed);
      else translate(text).then(done).catch(function () { b.disabled = false; });
    }
  });
  function markHlButton() {
    var btn = pop.querySelector('[data-act="hl"]');
    if (btn) { btn.setAttribute("data-act", "unhl"); btn.textContent = "取消高亮"; }
  }

  /* ---------- 选词 ---------- */
  // 找出选词落在哪个页容器上（滚动模式每页一个壳）
  function pageOfSelection(range) {
    var node = range.commonAncestorContainer;
    if (node && node.nodeType === 3) node = node.parentNode;
    if (!node || !node.closest) return null;
    var host = node.closest(".pg");
    if (host) {
      var pn = parseInt(host.getAttribute("data-pn"), 10);
      if (!isNaN(pn)) return pn;
    }
    return null;
  }

  function onSelect() {
    if (Date.now() - popLock < 700) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var text = String(sel).trim();
    if (!text) return;
    var range = sel.getRangeAt(0);
    var pn = pageOfSelection(range);
    var host = pn ? $("flow").querySelector('.pg[data-pn="' + pn + '"]') : pageBox;
    if (!host) return;
    var box = host.getBoundingClientRect();
    var rects = normRects(Array.prototype.slice.call(range.getClientRects()), box);
    if (!rects.length) return;
    if (pop.classList.contains("on") && popState.text === text) return;
    showPop(text, rects, pn || pageNo);
  }
  document.addEventListener("selectionchange", function () {
    clearTimeout(onSelect._t);
    onSelect._t = setTimeout(onSelect, 220);
  });
  document.addEventListener("click", function (e) {
    if (!pop.contains(e.target) && !e.target.closest("#page, #flow .pg")) pop.classList.remove("on");
  });

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

  /* ---------- 启动 ---------- */
  // 下载进度：大文件在慢网络下要等几十秒，给个明确的进度比干等强
  var loadPct = 0;
  function showLoad(p) {
    if (!p || !p.total) return;
    var pct = Math.min(99, Math.round((p.loaded / p.total) * 100));
    if (pct <= loadPct) return;
    loadPct = pct;
    var h = $("hint");
    if (!h) return;
    h.style.display = "block";
    h.innerHTML = '<div style="text-align:center">' +
      '<div style="font-size:13px;margin-bottom:8px">正在下载这本书…' + pct + '%</div>' +
      '<div style="width:180px;height:4px;background:#e4d9c5;border-radius:3px;overflow:hidden;margin:0 auto">' +
      '<i style="display:block;height:100%;width:' + pct + '%;background:#c2352b;transition:width .3s"></i>' +
      "</div>" +
      '<div style="font-size:11px;color:#9a917f;margin-top:7px">' +
      (p.loaded / 1048576).toFixed(1) + " / " + (p.total / 1048576).toFixed(1) + " MB</div>" +
      "</div>";
  }
  function hideLoad() {
    var h = $("hint");
    if (!h) return;
    h.style.display = "none";
    h.textContent = "";
  }

  fetch("books.json", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (list) {
      book = (list || []).filter(function (b) { return b.id === BID; })[0];
      if (!book) throw new Error("没有这本书");
      $("ttl").textContent = book.title;
      document.title = book.title + " · 阅读";

      pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.mjs";
      // 文件随站点包发布，走站内绝对路径；worker 的登录闸门会拦住未登录的请求
      var url = "/" + book.file.replace(/^\//, "");
      // 加载参数保持 pdf.js 默认：
      // · rangeChunkSize 不能调大（实测 1MB 会卡在 pages=0 —— Cloudflare edge
      //   按 64KB 分片缓存，服务器只回 552 字节，pdf.js 等不到完整块）
      // · 不能开 disableAutoFetch（xref 在文件末尾，关掉自动抓取文档永远解析不出来）
      // 用 loadingTask 而不是 getDocument，是为了拿到 onProgress 显示下载进度
      var task = pdfjsLib.getDocument({ url: url, cMapUrl: undefined });
      task.onProgress = function (p) { showLoad(p); };
      return task.promise;
    })
    .then(function (d) {
      doc = d;
      numPages = d.numPages;
      hideLoad();
      loadSettings();
      loadProgress().then(function (cfi) {
        // 用户在文档打开前就指定了页码（页码框跳转、快捷指令），别用进度覆盖它
        if (!userPicked) {
          wantPage = pageFromCfi(cfi) || 1;
        }
        wantPage = Math.max(1, Math.min(numPages, wantPage));
        targetPage = wantPage;
        if (FLOW === "scrolled") {
          document.body.classList.add("scrollmode");
          enterScrollMode();
        } else {
          render();
        }
      });
      refreshBookmarks();
    })
    .catch(function (e) {
      var h = $("hint");
      h.innerHTML = "";
      h.textContent = "这本书打不开：" + (e && e.message || e);
      h.style.display = "block";
    });

  /* ---------- 交互 ---------- */
  function on(id, fn) { var el = $(id); if (el) el.onclick = fn; }

  on("prevBtn", function () { step(-1); });
  on("nextBtn", function () { step(1); });
  // 缩放：左右翻页重画当前页；滚动模式要重建所有页壳（尺寸变了）
  function applyScale() {
    if (FLOW === "scrolled") { enterScrollMode(); return; }
    render();
  }
  on("fitBtn", function () {
    fitWidth = !fitWidth;
    if (!fitWidth) scale = Math.min(2.4, scale * 1.35);
    $("fitBtn").textContent = fitWidth ? "适宽" : "缩放";
    applyScale();
  });
  on("zoomIn", function () { fitWidth = false; scale = Math.min(3, scale * 1.2); $("fitBtn").textContent = "缩放"; applyScale(); });
  on("zoomOut", function () { fitWidth = false; scale = Math.max(0.4, scale / 1.2); $("fitBtn").textContent = "缩放"; applyScale(); });
  on("jumpBtn", function () {
    $("pageInput").value = wantPage || pageNo;
    openPanel("tocPanel");
  });
  on("listBtn", function () { refreshBookmarks(); markVocabButtons(); markFlowButtons(); openPanel("listPanel"); });
  on("bmBtn", function () {
    addBookmark("第 " + pageNo + " 页");
    refreshBookmarks();
    tip("已加书签");
  });
  on("goPage", function () {
    var v = parseInt($("pageInput").value, 10);
    if (!isNaN(v)) { closePanels(); go(v); }
  });
  on("mask", closePanels);
  document.querySelectorAll("[data-close]").forEach(function (el) { el.onclick = closePanels; });
  on("vocabManual", function () { saveAutoVocab(false); });
  on("vocabAuto", function () { saveAutoVocab(true); });
  on("flowPage", function () { setFlow("paginated"); });
  on("flowScroll", function () { setFlow("scrolled"); });
  markFlowButtons();

  document.addEventListener("click", function (e) {
    var goBtn = e.target.closest("[data-go]");
    if (goBtn) { closePanels(); go(parseInt(goBtn.getAttribute("data-go"), 10)); return; }
    var del = e.target.closest("[data-del]");
    if (del) {
      delBookmark(del.getAttribute("data-del"), del.getAttribute("data-cfi"));
      setTimeout(refreshBookmarks, 300);
      tip("已删除");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (!doc) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(function () { if (doc) applyScale(); }, 260);
  });
  window.addEventListener("pagehide", function () { if (numPages) saveProgress(); });

  if (/[?&]debug=1/.test(location.search)) {
    window.__pd = {
      go: go, render: render, setFlow: setFlow,
      state: function () {
        return {
          page: pageNo, pages: numPages, scale: scale, flow: FLOW,
          drawn: SCROLL_PAGES.filter(function (r) { return r.drawn; }).length,
          shells: SCROLL_PAGES.length
        };
      },
      showPop: showPop, addHighlight: addHighlight
    };
  }
})();
