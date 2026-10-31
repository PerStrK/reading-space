# -*- coding: utf-8 -*-
"""把超大 PDF 拆成上下两册，让每册都能塞进 Cloudflare Pages 单文件 25MB 上限。

    python3 tools/split_pdf.py

原书：《National Geographic Kids Almanac 2024》
分册点：PDF 第 199 页 = 书页 197 =「SCIENCE AND TECHNOLOGY」板块首页。
        上册收 Take Action / Animal Fun / Space and Earth / Awesome Exploration /
        Fun Stuff / Culture Connection；下册收 Science and Technology / Nature /
        History / Geography / 索引。

每册开头加一张封面页：用原书真实封面图做底，压一条色带写「上册 / 下册」和本册内容。
输出：site/books/<id>.pdf —— 直接进站点包，走登录闸门，不再需要 R2。
"""
import os
import sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, "public")
ROOT = os.path.dirname(SITE)
OUT_DIR = os.path.join(SITE, "books")

# (id, 册名, 起止 PDF 页下标[起, 止), 本册内容说明)
VOLUMES = [
    (
        "national-geographic-kids-almanac-2024-vol1",
        "上册",
        0, 199,
        "动物 · 太空与地球 · 探险 · 趣玩 · 文化",
        "从「获救的动物」讲到「文化中的金钱与语言」，"
        "另收「趣味动物」专题与年鉴挑战赛揭晓。",
    ),
    (
        "national-geographic-kids-almanac-2024-vol2",
        "下册",
        199, 372,
        "科学与技术 · 大自然 · 历史 · 地理",
        "从「生命三域」讲到各国风土人情，附录含世界地图、各国概况与全书索引。",
    ),
]

LIMIT = 25 * 1024 * 1024  # Pages 单文件上限


def wrap(font, text, max_width, fontsize):
    """用真实字体度量折行。max_width 单位与 fontsize 一致（像素）。"""
    out, cur = [], ""
    for ch in text:
        if ch == "\n":
            out.append(cur)
            cur = ""
            continue
        trial = cur + ch
        if font.text_length(trial, fontsize=fontsize) > max_width and cur:
            out.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        out.append(cur)
    return out


def make_cover_page(src_doc, vol_label, desc, out_path):
    """用原书首页封面图做底，做一张分册封面页。"""
    doc = pymupdf.open()
    src_pix = src_doc[0].get_pixmap(dpi=100)
    rect = pymupdf.Rect(0, 0, src_pix.width, src_pix.height)
    page = doc.new_page(width=rect.width, height=rect.height)
    w, h = rect.width, rect.height

    page.insert_image(page.rect, pixmap=src_pix)

    # 底部深色压条，标出是第几册
    band_h = h * 0.20
    band_top = h - band_h
    page.draw_rect(pymupdf.Rect(0, band_top, w, h), color=None, fill=(0.06, 0.12, 0.26),
                   fill_opacity=0.94)

    # 左侧红色角标（只放「上册 / 下册」两字）
    pad = w * 0.055
    tag_w, tag_h = w * 0.17, band_h * 0.40
    tag_x = pad
    tag_y = band_top + band_h * 0.24
    page.draw_rect(pymupdf.Rect(tag_x, tag_y, tag_x + tag_w, tag_y + tag_h),
                   color=None, fill=(0.88, 0.16, 0.13))
    fs_tag = tag_h * 0.60
    tw = len(vol_label) * fs_tag  # 中文每字一个字号宽
    page.insert_text(pymupdf.Point(tag_x + (tag_w - tw) / 2, tag_y + tag_h * 0.72),
                     vol_label, fontsize=fs_tag, color=(1, 1, 1), fontname="china-s")

    # 右侧本册内容说明（按真实字体度量折行，绝不溢出右边界）
    tx = tag_x + tag_w + w * 0.045
    fs = h * 0.0165
    line_h = fs * 1.55
    font = pymupdf.Font("china-s")
    avail = (w - w * 0.055) - tx
    desc_lines = wrap(font, desc, avail, fs)

    # 整体垂直居中于压条
    block_h = len(desc_lines) * line_h
    y = band_top + (band_h - block_h) / 2 + fs
    for ln in desc_lines[:4]:
        page.insert_text(pymupdf.Point(tx, y), ln, fontsize=fs,
                         color=(0.88, 0.92, 0.98), fontname="china-s")
        y += line_h

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tools/split_pdf.py 原始文件.pdf")
    raw = sys.argv[1]
    os.makedirs(OUT_DIR, exist_ok=True)
    src = pymupdf.open(raw)
    total = len(src)
    print("原书：%s  %d 页  %.1f MB" % (os.path.basename(raw), total,
                                       os.path.getsize(raw) / 1048576))

    for bid, vol_label, start, end, scope, desc in VOLUMES:
        tmp = "/tmp/_cover_%s.pdf" % bid
        make_cover_page(src, vol_label, desc, tmp)

        out = pymupdf.open()
        out.insert_pdf(pymupdf.open(tmp))
        os.remove(tmp)
        out.insert_pdf(src, from_page=start, to_page=end - 1)
        out.set_metadata({
            "title": "National Geographic Kids Almanac 2024 · %s" % vol_label,
            "author": "National Geographic Kids",
            "subject": scope,
        })
        path = os.path.join(OUT_DIR, bid + ".pdf")
        out.save(path, garbage=3, deflate=True, clean=True)
        pages = len(pymupdf.open(path))
        out.close()

        size = os.path.getsize(path)
        flag = "OK  " if size < LIMIT else "超限!"
        print("  %s %-46s %4d 页  %5.1f MB  %s · %s"
              % (flag, bid, pages, size / 1048576, vol_label, scope))
    src.close()


if __name__ == "__main__":
    main()
