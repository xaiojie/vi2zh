#!/usr/bin/env python3
"""生成扩展图标（青绿圆角方块 + 白色“译”字）。

用法: python3 tools/make_icons.py
依赖: Pillow
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "icons"

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]

TOP = (45, 212, 191)      # #2dd4bf
BOTTOM = (13, 148, 136)   # #0d9488
GLOW = (94, 234, 212)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, size=size, index=0)
        except Exception:
            continue
    return ImageFont.load_default()


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        image.putpixel((0, y), color)
    return image.resize((size, size), Image.Resampling.BILINEAR)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_icon(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    radius = int(canvas * 0.24)

    gradient = vertical_gradient(canvas, TOP, BOTTOM)
    mask = rounded_mask(canvas, radius)

    # 左上角柔光，让图标更有立体感
    glow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (-canvas * 0.35, -canvas * 0.5, canvas * 0.85, canvas * 0.6),
        fill=(*GLOW, 90),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(canvas * 0.12))

    icon = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)
    icon.paste(glow, (0, 0), Image.composite(glow, Image.new("RGBA", (canvas, canvas)), mask))

    # 细内描边
    border = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle(
        (1, 1, canvas - 2, canvas - 2),
        radius=radius,
        outline=(255, 255, 255, 46),
        width=max(1, int(canvas * 0.012)),
    )
    icon.alpha_composite(border)

    # 白色“译”字，带轻微投影
    font = load_font(int(canvas * 0.62))
    text = "译"
    text_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)
    left, top, right, bottom = text_draw.textbbox((0, 0), text, font=font)
    x = (canvas - (right - left)) / 2 - left
    y = (canvas - (bottom - top)) / 2 - top - canvas * 0.015

    shadow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.text((x, y + canvas * 0.012), text, font=font, fill=(2, 44, 34, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(canvas * 0.008))

    text_draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    icon.alpha_composite(shadow)
    icon.alpha_composite(text_layer)

    return icon.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon = build_icon(size)
        path = OUT_DIR / f"icon{size}.png"
        icon.save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
