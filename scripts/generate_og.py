from pathlib import Path
import os
import subprocess

from PIL import Image, ImageDraw, ImageFont


W, H = 1200, 630
BG = "#111111"
GREEN = "#16A34A"
WHITE = "#FFFFFF"
GRAY = "#9CA3AF"
OUT = Path(__file__).resolve().parents[1] / "public" / "og.png"


def find_dejavu_mono():
    roots = [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "/opt/homebrew/share/fonts",
        str(Path.home() / "Library/Fonts"),
        "/Library/Fonts",
        "/System/Library/Fonts",
    ]
    for root in roots:
        p = Path(root)
        if not p.exists():
            continue
        for candidate in p.rglob("DejaVuSansMono.ttf"):
            return str(candidate)
    try:
        out = subprocess.check_output(
            ["fc-match", "-f", "%{file}", "DejaVu Sans Mono"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if out and Path(out).exists():
            return out
    except Exception:
        pass
    return None


def load_font(candidates, size, default_size=None, index=0):
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.suffix.lower() == ".dfont":
            continue
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size, index=index)
            except Exception:
                continue
        else:
            try:
                return ImageFont.truetype(candidate, size=size, index=index)
            except Exception:
                continue
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except Exception:
        pass
    return ImageFont.load_default(size=default_size or size)


def text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1], box


def draw_logo(draw, x, y, scale=1.0):
    def sx(v):
        return x + v * scale

    def sy(v):
        return y + v * scale

    radius = int(6 * scale)
    bars = [
        (24, 35, 83, 48),
        (24, 55, 83, 68),
        (24, 75, 72, 88),
    ]
    for x1, y1, x2, y2 in bars:
        draw.rounded_rectangle(
            [sx(x1), sy(y1), sx(x2), sy(y2)],
            radius=radius,
            fill=WHITE,
        )

    cx, cy, r = sx(105), sy(105), 22 * scale
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)
    pts = [(sx(95), sy(105)), (sx(102), sy(112)), (sx(116), sy(98))]
    draw.line(pts, fill=WHITE, width=max(4, int(4 * scale)), joint="curve")


def draw_wordmark(draw, x, y, font):
    left = "toolidx"
    right = ".dev"
    draw.text((x, y), left, fill=GREEN, font=font)
    left_w, _, _ = text_size(draw, left, font)
    draw.text((x + left_w, y), right, fill=WHITE, font=font)


def text_bbox_at(draw, x, y, text, font):
    return draw.textbbox((x, y), text, font=font)


def bbox_union(boxes):
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def main():
    im = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(im)

    mono_font = load_font(
        [
            "/Library/Fonts/JetBrainsMono-Regular.ttf",
            "/System/Library/Fonts/Courier.dfont",
            find_dejavu_mono(),
            "DejaVuSansMono.ttf",
        ],
        76,
    )
    headline_font = load_font(
        [
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/SF-Pro-Display-Bold.otf",
            "/Library/Fonts/Inter-Bold.ttf",
        ],
        56,
        index=1,
    )
    subtitle_font = load_font(
        [
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "/Library/Fonts/Inter-Regular.ttf",
        ],
        34,
        index=0,
    )
    muted_font = load_font(
        [
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNSItalic.ttf",
            "/Library/Fonts/Inter-Italic.ttf",
        ],
        28,
        index=0,
    )

    wordmark = "toolidx.dev"
    headline = "Verified tools. Structured trust."
    subtitle = "MCP Servers Quality Checked"
    muted = "installed, tested, scored, reviewed."

    logo_content = (24, 35, 127, 127)
    logo_h = 160
    scale = logo_h / (logo_content[3] - logo_content[1])
    logo_w = (logo_content[2] - logo_content[0]) * scale
    gap_logo_word = 24
    gap_word_head = 34
    gap_head_sub = 18
    gap_sub_muted = 14

    word_w, word_h, word_box = text_size(draw, wordmark, mono_font)
    head_w, head_h, head_box = text_size(draw, headline, headline_font)
    sub_w, sub_h, sub_box = text_size(draw, subtitle, subtitle_font)
    muted_w, muted_h, muted_box = text_size(draw, muted, muted_font)

    block_w = max(logo_w, word_w, head_w, sub_w, muted_w)
    block_h = (
        logo_h
        + gap_logo_word
        + word_h
        + gap_word_head
        + head_h
        + gap_head_sub
        + sub_h
        + gap_sub_muted
        + muted_h
    )
    block_x = (W - block_w) / 2
    block_y = (H - block_h) / 2

    logo_left = block_x + (block_w - logo_w) / 2
    logo_top = block_y
    word_x = block_x + (block_w - word_w) / 2 - word_box[0]
    word_y = logo_top + logo_h + gap_logo_word - word_box[1]
    head_x = block_x + (block_w - head_w) / 2 - head_box[0]
    head_y = word_y + word_h + gap_word_head - head_box[1]
    sub_x = block_x + (block_w - sub_w) / 2 - sub_box[0]
    sub_y = head_y + head_h + gap_head_sub - sub_box[1]
    muted_x = block_x + (block_w - muted_w) / 2 - muted_box[0]
    muted_y = sub_y + sub_h + gap_sub_muted - muted_box[1]

    boxes = [
        (logo_left, logo_top, logo_left + logo_w, logo_top + logo_h),
        (word_x + word_box[0], word_y + word_box[1], word_x + word_box[2], word_y + word_box[3]),
        text_bbox_at(draw, head_x, head_y, headline, headline_font),
        text_bbox_at(draw, sub_x, sub_y, subtitle, subtitle_font),
        text_bbox_at(draw, muted_x, muted_y, muted, muted_font),
    ]
    content_box = bbox_union(boxes)
    dy = (H / 2) - ((content_box[1] + content_box[3]) / 2)
    logo_top += dy
    word_y += dy
    head_y += dy
    sub_y += dy
    muted_y += dy

    # The logo art has internal padding in its original 128px coordinate space.
    # Offset the draw origin so the visible mark, not that padding, is centered.
    draw_logo(
        draw,
        logo_left - logo_content[0] * scale,
        logo_top - logo_content[1] * scale,
        scale,
    )
    draw_wordmark(draw, word_x, word_y, mono_font)
    draw.text((head_x, head_y), headline, fill=WHITE, font=headline_font)
    draw.text((sub_x, sub_y), subtitle, fill=WHITE, font=subtitle_font)
    draw.text((muted_x, muted_y), muted, fill=GRAY, font=muted_font)

    boxes = [
        (logo_left, logo_top, logo_left + logo_w, logo_top + logo_h),
        (word_x + word_box[0], word_y + word_box[1], word_x + word_box[2], word_y + word_box[3]),
        text_bbox_at(draw, head_x, head_y, headline, headline_font),
        text_bbox_at(draw, sub_x, sub_y, subtitle, subtitle_font),
        text_bbox_at(draw, muted_x, muted_y, muted, muted_font),
    ]
    content_box = bbox_union(boxes)
    centroid = (
        (content_box[0] + content_box[2]) / 2,
        (content_box[1] + content_box[3]) / 2,
    )

    im.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}")
    print(f"size: {im.size} bytes: {os.path.getsize(OUT)}")
    print(f"content_box: {tuple(round(v, 2) for v in content_box)}")
    print(f"content_centroid: ({centroid[0]:.2f}, {centroid[1]:.2f})")


if __name__ == "__main__":
    main()
