# -*- coding: utf-8 -*-
"""扫描 books/ 下的 EPUB，生成 books.json 和封面缩略图。

    python3 tools/build_books.py

每本书的元信息从 OPF 里读；封面优先取 OPF 里 <meta name="cover">，
其次找文件名含 cover 的图，最后退化为最大的一张图。
封面统一缩到宽 480 的 jpg，原图不动（书本身直接用原文件读）。
"""
import io
import html as html_lib
import json
import os
import re
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, "public")
BOOKS = os.path.join(SITE, "books")
# 大 PDF 超过 Pages 单文件 25MB 上限，用 tools/split_pdf.py 拆成上下册后
# 直接放 public/books/ 随站点包发布（走登录闸门，不需要对象存储）。
# 原始整本放 books-src/（不进仓库），随时可以重新切分。
PDF_SRC = os.path.join(ROOT, "books-src")
COVERS = os.path.join(BOOKS, "covers")
OUT = os.path.join(SITE, "books.json")

# 手工补充的展示信息（书名/作者/epub 里元数据不规范时用）
OVERRIDES = {}


def read_opf(z):
    """返回 (opf_xml, opf_dir)。"""
    names = [n for n in z.namelist() if n.lower().endswith(".opf")]
    if not names:
        return "", ""
    opf = names[0]
    return z.read(opf).decode("utf-8", "ignore"), os.path.dirname(opf)


def pick_cover(z, opf, opf_dir):
    """按可靠程度挑封面：OPF 声明 > 文件名含 cover > 最大图片。"""
    imgs = [i for i in z.infolist()
            if i.filename.lower().endswith((".jpg", ".jpeg", ".png", ".gif"))
            and not i.filename.startswith("__MACOSX")]
    if not imgs:
        return None

    m = re.search(r'<meta[^>]+name="cover"[^>]+content="([^"]+)"', opf or "")
    if m:
        cid = m.group(1)
        hit = re.search(r'<item[^>]+id="%s"[^>]+href="([^"]+)"' % re.escape(cid), opf)
        if not hit:
            hit = re.search(r'<item[^>]+href="([^"]+)"[^>]+id="%s"' % re.escape(cid), opf)
        if hit:
            target = os.path.normpath(os.path.join(opf_dir, hit.group(1))).replace("\\", "/")
            for i in imgs:
                if i.filename == target:
                    return i

    named = [i for i in imgs if "cover" in os.path.basename(i.filename).lower()]
    if named:
        named.sort(key=lambda i: -i.file_size)
        return named[0]

    imgs.sort(key=lambda i: -i.file_size)
    return imgs[0]


def make_cover(z, info, out_path):
    try:
        raw = z.read(info.filename)
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        w, h = im.size
        if w > 480:
            im = im.resize((480, max(1, int(h * 480 / w))), Image.LANCZOS)
        im.save(out_path, "JPEG", quality=84, optimize=True)
        return True
    except Exception as e:
        print("   封面处理失败:", e)
        return False


def fallback_cover(title, out_path):
    """没有图的书，生成一张米色底 + 书名的占位封面。"""
    from PIL import ImageDraw, ImageFont
    W, H = 480, 640
    im = Image.new("RGB", (W, H), (245, 240, 231))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W - 1, 6], fill=(194, 53, 43))
    font = None
    for p in ["/System/Library/Fonts/Supplemental/Songti.ttc",
              "/System/Library/Fonts/PingFang.ttc"]:
        if os.path.exists(p):
            try:
                font = ImageFont.truetype(p, 40)
                break
            except Exception:
                pass
    lines, cur = [], ""
    for ch in title:
        cur += ch
        if len(cur) >= 9:
            lines.append(cur)
            cur = ""
    if cur:
        lines.append(cur)
    y = H // 2 - len(lines) * 28
    for ln in lines[:6]:
        d.text((48, y), ln, fill=(34, 38, 43), font=font)
        y += 56
    im.save(out_path, "JPEG", quality=84, optimize=True)


def pdf_books():
    """扫描 books/*.pdf（分册后的），返回书目条目。文件随站点包发布。"""
    out = []
    import pymupdf

    for fn in sorted(os.listdir(BOOKS)):
        if not fn.lower().endswith(".pdf"):
            continue
        bid = fn[:-4]
        path = os.path.join(BOOKS, fn)
        try:
            d = pymupdf.open(path)
            pages = len(d)
        except Exception as e:
            print("  跳过（打不开）:", fn, e)
            continue

        ov = OVERRIDES.get(bid, {})
        title = ov.get("title", fn[:-4])
        cover_rel = "books/covers/%s.jpg" % bid
        cover_path = os.path.join(COVERS, "%s.jpg" % bid)
        try:
            pix = d[0].get_pixmap(dpi=110)
            from PIL import Image
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            w, h = im.size
            if w > 480:
                im = im.resize((480, max(1, int(h * 480 / w))), Image.LANCZOS)
            im.save(cover_path, "JPEG", quality=84, optimize=True)
        except Exception as e:
            print("   封面生成失败:", e)
            fallback_cover(title, cover_path)

        out.append({
            "id": bid,
            "title": title,
            "author": ov.get("author", ""),
            "lang": "en",
            "desc": ov.get("desc", ""),
            "level": ov.get("level", ""),
            "format": "pdf",
            "pages": pages,
            "chapters": pages,
            "file": "books/%s.pdf" % bid,
            "src": path,
            "cover": cover_rel,
            "size": os.path.getsize(path),
            "added": "2026-10-31",
            "url": "pdf.html?b=%s" % bid,
        })
        print("  %-22s %-46s %5.1f MB  %d 页  (PDF)" % (bid, title[:44], os.path.getsize(path) / 1048576, pages))
    return out


def main():
    os.makedirs(COVERS, exist_ok=True)
    books = []
    for fn in sorted(os.listdir(BOOKS)):
        if not fn.lower().endswith(".epub"):
            continue
        bid = fn[:-5]
        path = os.path.join(BOOKS, fn)
        try:
            z = zipfile.ZipFile(path)
        except Exception as e:
            print("  跳过（打不开）:", fn, e)
            continue

        opf, opf_dir = read_opf(z)
        title = (re.search(r"<dc:title[^>]*>(.*?)</dc:title>", opf, re.S) or [None, bid])[1].strip()
        author = (re.search(r"<dc:creator[^>]*>(.*?)</dc:creator>", opf, re.S) or [None, ""])[1].strip()
        lang = (re.search(r"<dc:language[^>]*>(.*?)</dc:language>", opf, re.S) or [None, ""])[1].strip()
        desc = (re.search(r"<dc:description[^>]*>(.*?)</dc:description>", opf, re.S) or [None, ""])[1]
        # OPF 里的简介常是转义过的 HTML，先反转义再去标签，否则页面上会出现一堆 &lt;div&gt;
        desc = html_lib.unescape(desc)
        desc = re.sub(r"<[^>]+>", " ", desc)
        desc = re.sub(r"\s+", " ", desc).strip()
        if len(desc) > 160:
            desc = desc[:160].rstrip() + "…"
        chapters = len(re.findall(r'media-type="application/xhtml\+xml"', opf))

        ov = OVERRIDES.get(bid, {})
        title = ov.get("title", title)
        author = ov.get("author", author)
        desc = ov.get("desc", desc)

        cover_rel = "books/covers/%s.jpg" % bid
        cover_path = os.path.join(COVERS, "%s.jpg" % bid)
        info = pick_cover(z, opf, opf_dir)
        ok = make_cover(z, info, cover_path) if info else False
        if not ok:
            fallback_cover(title or bid, cover_path)

        books.append({
            "id": bid,
            "title": title or bid,
            "author": author,
            "lang": lang,
            "desc": desc,
            "level": ov.get("level", ""),
            "format": "epub",
            "chapters": chapters,
            "file": "books/%s.epub" % bid,
            "url": "reader.html?b=%s" % bid,
            "cover": cover_rel,
            "size": os.path.getsize(path),
            "added": "2026-10-31",
        })
        print("  %-22s %-46s %5.1f MB  封面:%s" % (
            bid, (title or "")[:44], os.path.getsize(path) / 1048576,
            "有" if ok else "占位"))

    books.extend(pdf_books())

    public = [{k: v for k, v in b.items() if k != "src"} for b in books]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(public, f, ensure_ascii=False, indent=1)
    print("写入 books.json：%d 本" % len(books))


if __name__ == "__main__":
    main()
