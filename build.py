#!/usr/bin/env python3
"""build.py — 生成插件图标并打包 zotero-ima-sync.xpi

用法：
    python build.py            # 生成图标 + 打包
    python build.py --icons    # 仅生成图标
"""
import os
import struct
import sys
import zlib
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(ROOT, "icons")
ICON_PATH = os.path.join(ICON_DIR, "favicon.png")
OUT_XPI = os.path.join(ROOT, "zotero-ima-sync-0.0.1.xpi")

SIZE = 48
BG = (0, 82, 217, 255)          # #0052D9 腾讯蓝
FG = (255, 255, 255, 255)       # 白色箭头


def write_png(path, pixels, width, height):
    """pixels: list of rows, each row is list of (r,g,b,a)"""
    raw = b""
    for row in pixels:
        raw += b"\x00"  # filter: None
        for px in row:
            raw += struct.pack("4B", *px)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def in_rounded_rect(x, y, r=8):
    """48x48 画布内，圆角半径 r 的圆角矩形"""
    margin = 2
    x0, y0, x1, y1 = margin, margin, SIZE - 1 - margin, SIZE - 1 - margin
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # 四角圆角
    for (cx, cy) in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
        if abs(x - cx) <= r and abs(y - cy) <= r:
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                return False
    return True


def in_left_arrow(x, y):
    """向左白色三角：尖端 (14,24)，尾 (22,14)-(22,34)"""
    if 14 <= y <= 34:
        edge = 14 + 0.8 * abs(y - 24)
        if 14 <= x <= 22 and x >= edge:
            return True
    return False


def in_right_arrow(x, y):
    """向右白色三角：尖端 (34,24)，尾 (26,14)-(26,34)"""
    if 14 <= y <= 34:
        edge = 34 - 0.8 * abs(y - 24)
        if 26 <= x <= 34 and x <= edge:
            return True
    return False


def gen_icon():
    os.makedirs(ICON_DIR, exist_ok=True)
    rows = []
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            if not in_rounded_rect(x, y):
                row.append((0, 0, 0, 0))
            elif in_left_arrow(x, y) or in_right_arrow(x, y):
                row.append(FG)
            else:
                row.append(BG)
        rows.append(row)
    write_png(ICON_PATH, rows, SIZE, SIZE)
    print(f"[ok] icon -> {ICON_PATH}")


def build_xpi():
    files = []
    for dirpath, _, filenames in os.walk(ROOT):
        if "__pycache__" in dirpath or "node_modules" in dirpath or "test" in dirpath or "ima_probe" in dirpath:
            continue
        if "对照测试" in dirpath or ".git" in dirpath:
            continue
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if rel.startswith(("build.py", "build_realtest.py", "README.md", "CHANGELOG.md", "LICENSE", ".gitignore")) or rel.endswith(".xpi"):
                continue
            if rel.startswith("."):
                continue
            # 排除真实运行时自测的诊断产物（哨兵/HTTP 上报文件/结果文件）
            if rel in ("SELFTEST_RUN",) or rel.startswith(("http_", "real_verify_")):
                continue
            files.append((full, rel.replace(os.sep, "/")))

    files.sort(key=lambda t: t[1])
    # 打包方式与 zotero-plugin-template（BBT 等官方插件）一致：全部 DEFLATED。
    with zipfile.ZipFile(OUT_XPI, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            z.write(full, rel, compress_type=zipfile.ZIP_DEFLATED)
            print(f"  + {rel}")
    print(f"[ok] xpi -> {OUT_XPI} ({os.path.getsize(OUT_XPI)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--icons":
        gen_icon()
    else:
        gen_icon()
        build_xpi()
