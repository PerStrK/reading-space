# -*- coding: utf-8 -*-
"""生成 PDF 阅读页 pdf.html。

复用 reader.html 里的 <style>（配色、气泡、抽屉都一致），只换 body 结构和脚本。
    python3 tools/build_pdf_reader.py
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, "public")

EXTRA_CSS = """
/* PDF 专用 */
#viewer{overflow:auto; -webkit-overflow-scrolling:touch; padding:12px 0 20px}
#page{position:relative; margin:12px auto; background:#fff; box-shadow:0 8px 26px rgba(40,30,15,.16)}
#cv{display:block; width:100%; height:100%}
#hlLayer{position:absolute; inset:0; pointer-events:none; z-index:1}
#tl{position:absolute; inset:0; overflow:hidden; opacity:1; line-height:1; text-align:initial;
  text-size-adjust:none; forced-color-adjust:none; transform-origin:0 0; z-index:2}
#tl span, #tl br{color:transparent; position:absolute; white-space:pre; cursor:text; transform-origin:0% 0%}
#tl ::selection{background:rgba(255,205,60,.45)}
#tl .endOfContent{display:block; position:absolute; inset:100% 0 0; z-index:-1; cursor:default; user-select:none}
#bot .pin{min-width:74px; text-align:center}
#bot .pbar{min-width:40px}
#pop{position:fixed; left:50%; bottom:64px; transform:translateX(-50%)}
.pagejump{display:flex; gap:8px; padding:14px 16px; align-items:center}
.pagejump input{width:78px; padding:7px 9px; border:1px solid #e4d9c5; border-radius:8px; font-size:14px}
.pagejump button{padding:7px 14px; border:1px solid #e4d9c5; background:#fffdf9; border-radius:8px; cursor:pointer}
#bot button{white-space:nowrap}

/* ---- 连续滚动模式 ---- */
/* 左右翻页时隐藏滚动容器；连续滚动时反过来 */
body:not(.scrollmode) #flow{display:none}
body.scrollmode #page{display:none}
body.scrollmode #viewer{overflow-y:auto; overflow-x:hidden; padding:10px 0 40px}
body.scrollmode #bot button{opacity:.55}
/* 每个页容器：高度先占好，画布后画，滚动条长度才不会跳 */
#flow .pg{position:relative; margin:10px auto; background:#fff; box-shadow:0 6px 20px rgba(40,30,15,.14)}
#flow .pg canvas{display:block; width:100%; height:100%}
#flow .pg .hl{position:absolute; inset:0; pointer-events:none; z-index:1}
#flow .pg .tl{position:absolute; inset:0; overflow:hidden; opacity:1; line-height:1; text-align:initial;
  text-size-adjust:none; forced-color-adjust:none; transform-origin:0 0; z-index:2}
#flow .pg .tl span, #flow .pg .tl br{color:transparent; position:absolute; white-space:pre; cursor:text; transform-origin:0% 0%}
#flow .pg .tl ::selection{background:rgba(255,205,60,.45)}
#flow .pg .tl .endOfContent{display:block; position:absolute; inset:100% 0 0; z-index:-1; cursor:default; user-select:none}
/* 页码角标，滚动时一眼知道在哪；放左上角，避开书里自己印的页码 */
#flow .pg .pn{position:absolute; left:6px; top:5px; z-index:3; font-size:10.5px; color:#b3a893;
  background:rgba(255,253,249,.82); padding:1px 6px; border-radius:999px; pointer-events:none}

@media (max-width:560px){
  #bot{gap:6px; padding:6px 8px}
  #bot button{padding:0 6px; font-size:12.5px; width:auto; height:28px}
  #bot .pin{min-width:58px; font-size:12px}
  #bot .pbar{min-width:22px}
}
"""

BODY = """
<div id="top">
  <a class="back" href="library.html">← 书架</a>
  <div class="ttl" id="ttl">正在打开…</div>
  <button class="ico" id="bmBtn" title="加书签"><svg viewBox="0 0 24 24"><path d="M7 4h10v16l-5-4-5 4z"/></svg></button>
  <button class="ico" id="listBtn" title="书签与设置"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>
</div>

<div id="stage">
  <div id="viewer">
    <div id="page">
      <canvas id="cv"></canvas>
      <div id="hlLayer"></div>
      <div id="tl" class="textLayer"></div>
    </div>
    <!-- 连续滚动模式：每一页一个占位容器，滚到附近才真正渲染 -->
    <div id="flow"></div>
  </div>
  <div id="hint">正在打开…</div>
</div>

<div id="bot">
  <button id="prevBtn">‹</button>
  <span class="pin" id="pinfo">– / –</span>
  <button id="nextBtn">›</button>
  <div class="pbar"><i id="pbar"></i></div>
  <button id="jumpBtn" style="width:auto;padding:0 8px">页码</button>
  <button id="zoomOut" style="width:auto;padding:0 8px">A－</button>
  <button id="zoomIn" style="width:auto;padding:0 8px">A＋</button>
  <button id="fitBtn" style="width:auto;padding:0 8px">适宽</button>
</div>

<div id="pop"></div>
<div id="toast"></div>

<div class="panel" id="tocPanel">
  <header>跳到某页<span data-close>关闭</span></header>
  <div class="body">
    <div class="pagejump">
      <input id="pageInput" type="number" min="1" placeholder="页码">
      <button id="goPage">跳转</button>
    </div>
    <div style="padding:4px 16px 10px;font-size:11.5px;line-height:1.6;color:#9a917f">
      也可以直接按键盘 ← → 翻页。PDF 是固定版式，用右下角 A＋/A－ 或「适宽」调大小。
    </div>
  </div>
</div>

<div class="panel" id="listPanel">
  <header>书签与设置<span data-close>关闭</span></header>
  <div class="body">
    <div style="padding:12px 16px 4px; font-size:12px; color:#9a917f">翻页方式</div>
    <div style="padding:0 16px; display:flex; gap:8px">
      <button class="row" id="flowPage" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">左右翻页</button>
      <button class="row" id="flowScroll" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">连续滚动</button>
    </div>
    <div style="padding:6px 16px 12px;font-size:11.5px;color:#a89e8c;line-height:1.5">
      连续滚动适合一口气往下读；左右翻页更像翻书。
    </div>
    <div style="padding:12px 16px 4px; font-size:12px; color:#9a917f">划词入库</div>
    <div style="padding:0 16px; display:flex; gap:8px">
      <button class="row" id="vocabManual" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">手动加入</button>
      <button class="row" id="vocabAuto" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">自动加入</button>
    </div>
    <div style="padding:6px 16px 12px;font-size:11.5px;color:#a89e8c;line-height:1.5">
      自动：点「翻译」就翻译、存进生词本，并把这句高亮；手动：只有点「存生词」才记。
    </div>
    <div style="padding:12px 16px 4px; font-size:12px; color:#9a917f">我的书签</div>
    <div id="bmList"></div>
  </div>
</div>
<div id="mask"></div>
"""

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>阅读 · 阅读空间</title>
<style>
{css}
{extra}
</style>
</head>
<body>
{body}
<script type="module">
  // pdf.min.mjs 是 ESM，用动态 import 挂到 window 上给普通脚本用
  import * as pdfjs from "./assets/vendor/pdf.min.mjs";
  window.pdfjsLib = pdfjs;
  var s = document.createElement("script");
  s.src = "assets/pdf-reader.js?v={v}";
  document.body.appendChild(s);
</script>
</body>
</html>
"""


def main():
    reader = open(os.path.join(SITE, "reader.html"), encoding="utf-8").read()
    m = re.search(r"<style>([\s\S]*?)</style>", reader)
    if not m:
        raise SystemExit("reader.html 里找不到 <style>")
    css = m.group(1)

    ver = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip() or "1"

    out = TEMPLATE.format(css=css, extra=EXTRA_CSS, body=BODY, v=ver)
    path = os.path.join(SITE, "pdf.html")
    open(path, "w", encoding="utf-8").write(out)
    print("写入:", os.path.basename(path), len(out) // 1024, "KB")


if __name__ == "__main__":
    main()
