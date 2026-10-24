"""Generate the PWA icons in public/icons (requires Pillow: pip install pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (79, 70, 229)
FG = (255, 255, 255)


def draw(size, padding_ratio, rounded):
    scale = 4  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, s, s], fill=BG)
    p = s * padding_ratio
    inner = s - 2 * p
    # Three calendar "blocks" plus a check mark.
    bar_h = inner * 0.16
    gap = inner * 0.1
    widths = [0.95, 0.7, 0.5]
    y = p + inner * 0.08
    for w in widths:
        d.rounded_rectangle([p, y, p + inner * w, y + bar_h], radius=int(bar_h / 2), fill=FG)
        y += bar_h + gap
    lw = int(inner * 0.11)
    cx, cy = p + inner * 0.62, p + inner * 0.86
    d.line(
        [(cx, cy - inner * 0.1), (cx + inner * 0.1, cy), (cx + inner * 0.33, cy - inner * 0.24)],
        fill=FG, width=lw, joint="curve",
    )
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192, 0.18, True).save(OUT / "icon-192.png")
draw(512, 0.18, True).save(OUT / "icon-512.png")
draw(512, 0.28, False).save(OUT / "icon-maskable-512.png")
draw(180, 0.16, False).convert("RGB").save(OUT / "apple-touch-icon.png")
print("Icons written to", OUT)
