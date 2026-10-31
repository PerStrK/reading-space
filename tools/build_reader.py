# -*- coding: utf-8 -*-
"""阅读空间 · 书架页与阅读器页

    python3 tools/build_reader.py

生成 library.html（书架）与 reader.html（阅读器）。
书本身和 books.json 由 tools/build_books.py 负责。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, "public")

BRAND = "阅读空间"

LIBRARY = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{{brand}} · 书架</title>
<meta name="description" content="{{brand}}：书架与阅读记录。">
<link rel="stylesheet" href="assets/site.css?v={{v}}">
<script src="/assets/account.js?v={{v}}" defer></script>
<style>
/* 书架页自己的头部，不依赖首页那套内联写法 */
.top{padding:20px 0 6px}
.top .wrap{display:flex; align-items:center; gap:12px}
.brand{display:flex; align-items:center; gap:10px; text-decoration:none; color:inherit; min-width:0}
.brand .mark{width:34px; height:34px; flex:0 0 auto; border-radius:11px; background:#c2352b; color:#fff;
  display:grid; place-items:center; font-family:Georgia,"Songti SC",serif; font-size:19px}
.brand b{font-family:Georgia,"Songti SC",serif; font-size:18px; letter-spacing:.06em; white-space:nowrap}
.brand .tag{font-size:11.5px; color:var(--muted); letter-spacing:.2em; white-space:nowrap}
[hidden]{display:none !important}
.acct{margin-left:auto; font-size:11.5px; font-weight:600; padding:4px 11px; border-radius:999px;
  background:#e7f2ec; color:#0f6e56; border:1px solid #bfe0d0; white-space:nowrap}
.out{margin-left:12px; font-size:12.5px; color:var(--muted); text-decoration:none;
  border-bottom:1px solid #d9cfbd; padding-bottom:1px; white-space:nowrap}
.out:hover{color:#c2352b; border-color:#c2352b}
@media (max-width:560px){ .brand .tag{display:none} .brand b{font-size:16.5px} .top .wrap{gap:8px} }

.shelf{display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:22px 18px; margin-top:26px}
.bk{display:block; text-decoration:none; color:inherit}
.bk .cv{position:relative; aspect-ratio:3/4; border-radius:10px; overflow:hidden; background:#e8e0d2;
  box-shadow:0 8px 22px rgba(40,30,15,.16); transition:.2s}
.bk:hover .cv{transform:translateY(-4px); box-shadow:0 16px 34px rgba(40,30,15,.24)}
.bk .cv img{width:100%; height:100%; object-fit:cover; display:block}
.bk .badge{position:absolute; left:0; right:0; bottom:0; padding:6px 9px 7px; font-size:11px;
  color:#fff; background:linear-gradient(transparent, rgba(0,0,0,.62)); display:flex; justify-content:space-between; align-items:center}
.bk .bar{position:absolute; left:0; bottom:0; height:3px; width:100%; background:rgba(255,255,255,.28)}
.bk .bar i{display:block; height:100%; background:#ffb3a7; width:0}
.bk h3{font-family:Georgia,"Songti SC",serif; font-size:14.5px; line-height:1.45; margin:10px 0 3px;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden}
.bk .au{font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.bk .lv{font-size:11px; color:#2c7a7b; margin-top:3px}
.empty{color:var(--muted); font-size:14px; margin:30px 0}
@media (max-width:560px){ .shelf{grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 14px} }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="index.html">
      <span class="mark">阅</span><b>{{brand}}</b><span class="tag">书 架 · 阅 读</span>
    </a>
    <span class="acct" id="acct" hidden></span>
    <a class="out" href="/logout">退出</a>
  </div>
</header>

<main id="main">
  <div class="wrap">
    <div class="kicker" style="font-size:12px;letter-spacing:.22em;color:var(--muted);margin-bottom:10px">LIBRARY</div>
    <h1>书架</h1>
    <p class="lead">点开就接着上次读到的地方。读到哪儿会自动记住。</p>
    <div class="shelf" id="shelf"><p class="empty">正在加载书目…</p></div>
    <p class="back" style="margin-top:34px"><a href="index.html">← 回主页</a></p>
  </div>
</main>

<footer class="foot">
  <div class="wrap">
    <div>建议用 Safari 或 Chrome 打开</div>
    {{updateddiv}}
  </div>
</footer>
<script src="assets/library.js?v={{v}}"></script>
</body>
</html>
"""

READER = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>阅读 · {{brand}}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:#f7f4ec; color:#22262b; display:flex; flex-direction:column; overflow:hidden}
/* 顶部 */
#top{flex:0 0 auto; display:flex; align-items:center; gap:10px; padding:10px 12px;
  background:#fffdf9; border-bottom:1px solid #e4d9c5; z-index:30}
#top .back{display:inline-flex; align-items:center; gap:5px; text-decoration:none; color:#22262b;
  font-size:13px; background:#f2ece0; border:1px solid #e4d9c5; border-radius:999px; padding:6px 12px; white-space:nowrap}
#top .back:hover{background:#c2352b; border-color:#c2352b; color:#fff}
#top .ttl{flex:1; min-width:0; font-size:13.5px; font-weight:600;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center}
#top .ico{display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px;
  border-radius:10px; border:1px solid #e4d9c5; background:#fffdf9; color:#5b5348; cursor:pointer; flex:0 0 auto}
#top .ico:hover{background:#f2ece0; color:#c2352b}
#top .ico svg{width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round}
/* 阅读区 */
#stage{flex:1 1 auto; position:relative; overflow:hidden; background:#f7f4ec}
#viewer{position:absolute; inset:0}
#viewer iframe{border:0}
#hint{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); color:#9a917f; font-size:14px}
/* 底部 */
#bot{flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:8px 14px 10px;
  background:#fffdf9; border-top:1px solid #e4d9c5; font-size:12px; color:#6b6459; z-index:30}
#bot .pbar{flex:1; height:4px; background:#e8e0d2; border-radius:3px; overflow:hidden}
#bot .pbar i{display:block; height:100%; width:0; background:#c2352b; transition:width .25s}
#bot b{font-weight:600; color:#22262b}
#bot button{border:1px solid #e4d9c5; background:#fffdf9; color:#5b5348; border-radius:9px;
  width:34px; height:30px; cursor:pointer; font-size:15px; line-height:1}
#bot button:disabled{opacity:.35; cursor:default}
/* 抽屉 */
.panel{position:fixed; top:0; right:0; bottom:0; width:min(320px,84vw); background:#fffdf9;
  border-left:1px solid #e4d9c5; box-shadow:-14px 0 40px rgba(40,30,15,.16); z-index:60;
  transform:translateX(102%); transition:transform .26s ease; display:flex; flex-direction:column}
.panel.on{transform:none}
.panel header{display:flex; align-items:center; justify-content:space-between; padding:14px 16px;
  border-bottom:1px solid #eee5d4; font-size:14px; font-weight:600}
.panel header span{cursor:pointer; color:#8a8174; font-weight:400}
.panel .body{flex:1; overflow:auto; padding:8px 0}
.panel .row{display:block; width:100%; text-align:left; border:0; background:none; cursor:pointer;
  padding:10px 16px; font-size:13.5px; line-height:1.55; color:#3a342a; border-bottom:1px solid #f4eee1}
.panel .row:hover{background:#f7f1e4}
.panel .row small{display:block; color:#9a917f; font-size:11.5px; margin-top:2px}
.panel .row.now{background:#fdf3f1; color:#c2352b}
#mask{position:fixed; inset:0; background:rgba(30,25,15,.35); z-index:55; opacity:0; pointer-events:none; transition:opacity .26s}
#mask.on{opacity:1; pointer-events:auto}
/* 划词气泡 */
#pop{position:absolute; left:50%; bottom:10px; transform:translateX(-50%); z-index:60; display:none;
  flex-direction:column; background:#22262b; color:#f8f3e9; border-radius:16px; padding:10px 12px 12px;
  box-shadow:0 12px 34px rgba(0,0,0,.34); font-size:13px; width:min(94%,460px);
  max-height:64vh; overflow:hidden}
#pop.on{display:flex}
#pop .hd{display:flex; align-items:flex-start; gap:8px; flex:0 0 auto}
#pop .w{flex:1 1 auto; min-width:0; color:#ffd9a8; font-size:12.5px; line-height:1.5;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden}
#pop .x{flex:0 0 auto; width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,.12);
  color:#f8f3e9; font-size:16px; line-height:1; display:grid; place-items:center; padding:0; margin:-2px -2px 0 0}
#pop .x:hover{background:#c2352b}
#pop .acts{display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; flex:0 0 auto}
#pop button{border:0; background:rgba(255,255,255,.12); color:#f8f3e9; border-radius:8px;
  padding:6px 11px; font-size:12.5px; cursor:pointer; white-space:nowrap}
#pop button:hover{background:#c2352b}
#pop button.primary{background:#2c7a7b}
#pop button.primary:hover{background:#1f6162}
#pop .tr{margin-top:9px; padding-top:9px; border-top:1px solid rgba(255,255,255,.14);
  line-height:1.62; font-size:12.8px; white-space:pre-wrap; display:none; position:relative;
  max-height:5.2em; overflow:hidden}
#pop .tr.on{display:block}
/* 展开后自己是一块可滚区域：再长的译文也只在气泡里滑动，不会顶出屏幕 */
#pop .tr.full{max-height:42vh; overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain;
  padding-right:4px}
#pop .tr.full::-webkit-scrollbar{width:6px}
#pop .tr.full::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28); border-radius:3px}
#pop .tr.on.clipped::after{content:""; position:absolute; left:0; right:0; bottom:0; height:1.7em;
  background:linear-gradient(transparent,#22262b 70%); pointer-events:none}
#pop .tr.wait{color:#9aa3b8}
/* 单词的音标：和释义区分开，像词典那样 */
#pop .tr .ipa{color:#93c7c7; font-size:12px; letter-spacing:.35px; margin-right:5px}
#pop .more{margin-top:6px; display:none; flex:0 0 auto}
#pop .more.on{display:block}
#pop .more button{background:rgba(255,255,255,.08); color:#cfd6e6; padding:4px 10px; font-size:12px}
#pop .more button:hover{background:rgba(255,255,255,.16); color:#fff}
/* 连续滚动模式：底部翻页键不再有意义 */
body.scrolled #bot button{opacity:.3; pointer-events:none}
#toast{position:fixed; left:50%; bottom:76px; transform:translateX(-50%); background:rgba(34,38,43,.92);
  color:#fff; font-size:13px; padding:9px 16px; border-radius:999px; opacity:0; transition:opacity .2s; z-index:70; pointer-events:none}
#toast.on{opacity:1}
body.sepia{background:#f4ecd8} body.sepia #stage{background:#f4ecd8}
body.night{background:#161a1f} body.night #stage{background:#161a1f}
body.night #top,body.night #bot{background:#1d2228; border-color:#2b323a; color:#c9d1d9}
body.night #top .ttl{color:#e6edf3} body.night #top .back,body.night #top .ico,body.night #bot button{background:#242a31; border-color:#333b44; color:#c9d1d9}
@media (max-width:560px){ #top .ttl{font-size:12.5px} #bot{gap:8px} }
</style>
</head>
<body>
<div id="top">
  <a class="back" href="library.html">← 书架</a>
  <div class="ttl" id="ttl">加载中…</div>
  <button class="ico" id="tocBtn" title="目录"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg></button>
  <button class="ico" id="bmBtn" title="加书签"><svg viewBox="0 0 24 24"><path d="M6 4h12v17l-6-4.5L6 21z"/></svg></button>
  <button class="ico" id="listBtn" title="书签与设置"><svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.5" r="1.6"/></svg></button>
</div>

<div id="stage">
  <div id="viewer"></div>
  <div id="hint">正在打开…</div>
  <div id="pop"></div>
</div>

<div id="bot">
  <button id="prevBtn" title="上一页">‹</button>
  <button id="nextBtn" title="下一页">›</button>
  <div class="pbar"><i id="pbar"></i></div>
  <span id="pct"><b>0</b>%</span>
</div>

<div id="mask"></div>

<div class="panel" id="tocPanel">
  <header>目录 <span data-close>关闭</span></header>
  <div class="body" id="tocBody"></div>
</div>

<div class="panel" id="listPanel">
  <header>书签与设置 <span data-close>关闭</span></header>
  <div class="body">
    <div style="padding:12px 16px; border-bottom:1px solid #f4eee1">
      <div style="font-size:12px;color:#9a917f;margin-bottom:8px">字号</div>
      <div style="display:flex;gap:8px">
        <button class="row" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px" data-fs="-">A－</button>
        <button class="row" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px" data-fs="+">A＋</button>
      </div>
      <div style="font-size:12px;color:#9a917f;margin:14px 0 8px">背景</div>
      <div style="display:flex;gap:8px">
        <button class="row" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px" data-bg="day">纸白</button>
        <button class="row" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px" data-bg="sepia">米黄</button>
        <button class="row" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px" data-bg="night">夜间</button>
      </div>
      <div style="font-size:12px;color:#9a917f;margin:14px 0 8px">翻页方式</div>
      <div style="display:flex;gap:8px">
        <button class="row" id="flowPage" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">左右翻页</button>
        <button class="row" id="flowScroll" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">连续滚动</button>
      </div>
      <div style="font-size:11.5px;color:#a89e8c;margin-top:6px;line-height:1.5">连续滚动适合一口气往下读；左右翻页更像翻书。</div>
      <div style="font-size:12px;color:#9a917f;margin:14px 0 8px">划词入库</div>
      <div style="display:flex;gap:8px">
        <button class="row" id="vocabManual" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">手动加入</button>
        <button class="row" id="vocabAuto" style="flex:1;text-align:center;border:1px solid #e4d9c5;border-radius:9px">自动加入</button>
      </div>
      <div style="font-size:11.5px;color:#a89e8c;margin-top:6px;line-height:1.5">自动：点「翻译」就翻译、存进生词本，并把这段高亮起来；手动：只有点「存生词」才记。</div>
    </div>
    <div style="padding:12px 16px 4px; font-size:12px; color:#9a917f">我的书签</div>
    <div id="bmList"></div>
  </div>
</div>

<div id="toast"></div>

<script src="assets/vendor/jszip.min.js"></script>
<script src="assets/vendor/epub.min.js"></script>
<script src="assets/reader.js?v={{v}}"></script>
</body>
</html>
"""


def main():
    import re
    ver = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip() or "1"
    # VERSION 形如 20261031 时，页脚显示成 2026-10-31；否则不显示这一行
    upd = ""
    if len(ver) == 8 and ver.isdigit():
        upd = '<div class="u">最后更新 %s-%s-%s</div>' % (ver[:4], ver[4:6], ver[6:])
    ctx = dict(brand=BRAND, v=ver, updateddiv=upd)
    for name, tpl in [("library.html", LIBRARY), ("reader.html", READER)]:
        # 模板里大量 CSS 百分号，用 replace 而不是 % 格式化
        out = tpl
        for k, v in ctx.items():
            out = out.replace("{{%s}}" % k, v)
        open(os.path.join(SITE, name), "w", encoding="utf-8").write(out)
        print("写入:", name, "%.1f KB" % (len(out.encode()) / 1024))


if __name__ == "__main__":
    main()
