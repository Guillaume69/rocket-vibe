"""Draws the Windows installer's artwork from the app's rocket.

    python installer-art.py

Writes installer/*.png next to this file (Pillow). Deterministic: the same
seed gives the same sky, so a rerun only changes what the code changes.
The rocket comes from the mobile splash icon (apps/mobile/assets), the
palette from the app icon.
"""

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
OUT = HERE / "installer"
ROCKET = HERE.parents[2] / "mobile" / "assets" / "splash-icon.png"

NIGHT_TOP = (35, 27, 66)
NIGHT_BOTTOM = (17, 14, 30)
PINK = (232, 110, 167)
TEAL = (72, 212, 204)
VIOLET = (138, 115, 207)
GOLD = (209, 173, 71)
CREAM = (255, 247, 222)
STARS = [CREAM, CREAM, TEAL, PINK, VIOLET, GOLD]

# Supersampling factor: Pillow draws polygons without antialiasing.
SS = 4


def gradient(size, top, bottom):
    w, h = size
    column = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize(size).convert("RGBA")


def glow(base, center, radius, color, strength):
    """A soft nebula: a blurred disc added on top of the sky."""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    x, y = center
    ImageDraw.Draw(layer).ellipse((x - radius, y - radius, x + radius, y + radius), fill=color + (strength,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.6))
    return Image.alpha_composite(base, layer)


def sparkle(draw, center, radius, color, alpha=255):
    """A four-pointed star with concave sides (an astroid), like the icon's."""
    x, y = center
    points = []
    for i in range(64):
        t = 2 * math.pi * i / 64
        points.append((x + radius * math.cos(t) ** 3, y + radius * math.sin(t) ** 3))
    draw.polygon(points, fill=color + (alpha,))


def sky(size, seed, sparkles, dots, glows, margin=0.0, spark=(0.012, 0.03), alpha=(170, 255)):
    """Night gradient, nebulae, dust and sparkles. `margin` keeps sparkles
    off a central column (where the rocket flies), as a fraction of width."""
    rng = random.Random(seed)
    w, h = size
    image = gradient(size, NIGHT_TOP, NIGHT_BOTTOM)
    for (fx, fy), fr, color, strength in glows:
        image = glow(image, (fx * w, fy * h), fr * max(w, h), color, strength)
    big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    for _ in range(dots):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(0.4, 1.3) * SS
        draw.ellipse((x * SS - r, y * SS - r, x * SS + r, y * SS + r), fill=CREAM + (rng.randint(60, 200),))
    placed = 0
    while placed < sparkles:
        x, y = rng.uniform(0.06, 0.94) * w, rng.uniform(0.04, 0.96) * h
        if margin and abs(x - w / 2) < margin * w:
            continue
        r = rng.uniform(*spark) * max(w, h)
        sparkle(draw, (x * SS, y * SS), r * SS, rng.choice(STARS), rng.randint(*alpha))
        placed += 1
    stars = big.resize(size, Image.LANCZOS)
    halo = stars.filter(ImageFilter.GaussianBlur(max(w, h) / 160))
    return Image.alpha_composite(Image.alpha_composite(image, halo), stars)


def rocket():
    """The rocket alone, cropped to its pixels."""
    art = Image.open(ROCKET).convert("RGBA")
    return art.crop(art.getbbox())


def trail(size, top, bottom, width):
    """A fading exhaust trail below the rocket, pink to teal to nothing."""
    w, h = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for y in range(top, bottom):
        t = (y - top) / max(bottom - top, 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(PINK, TEAL))
        half = width * (1 - 0.6 * t) / 2
        draw.line((w / 2 - half, y, w / 2 + half, y), fill=color + (round(150 * (1 - t) ** 1.6),))
    return layer.filter(ImageFilter.GaussianBlur(width / 3))


def wizard_image(size):
    """The tall picture of the Welcome and Finished pages."""
    w, h = size
    image = sky(
        size,
        seed=7,
        sparkles=9,
        dots=round(w * h / 900),
        glows=[((0.85, 0.12), 0.35, PINK, 70), ((0.1, 0.8), 0.4, TEAL, 55), ((0.6, 0.55), 0.3, VIOLET, 50)],
        margin=0.16,
    )
    ship = rocket()
    scale = (h * 0.5) / ship.height
    ship = ship.resize((round(ship.width * scale), round(ship.height * scale)), Image.LANCZOS)
    x, y = (w - ship.width) // 2, round(h * 0.16)
    image = Image.alpha_composite(image, trail(size, y + round(ship.height * 0.9), h, ship.width * 0.55))
    halo = Image.new("RGBA", size, (0, 0, 0, 0))
    halo.paste(ship, (x, y), ship)
    halo = halo.filter(ImageFilter.GaussianBlur(w / 14))
    halo = ImageChops.multiply(halo, Image.new("RGBA", size, (255, 255, 255, 150)))
    image = Image.alpha_composite(image, halo)
    image.alpha_composite(ship, (x, y))
    return image.convert("RGB")


def small_image(size):
    """The square badge of the inner pages' header: the rocket climbing
    diagonally, on a transparent ground."""
    ship = rocket().rotate(-35, resample=Image.BICUBIC, expand=True)
    ship = ship.crop(ship.getbbox())
    scale = size * 0.8 / max(ship.size)
    ship = ship.resize((round(ship.width * scale), round(ship.height * scale)), Image.LANCZOS)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    image.alpha_composite(ship, ((size - ship.width) // 2, (size - ship.height) // 2))
    return image


def back_image(size):
    """The whole-window background: a quiet sky, dim enough for text."""
    w, h = size
    return sky(
        size,
        seed=42,
        # Sparkles would land behind the pages' text: dust and nebulae only.
        sparkles=0,
        dots=round(w * h / 2500),
        glows=[((1.0, 0.0), 0.3, PINK, 45), ((0.0, 1.0), 0.35, TEAL, 40), ((0.75, 0.85), 0.25, VIOLET, 30)],
        spark=(0.006, 0.013),
        alpha=(80, 150),
    ).convert("RGB")


RAINBOW = [(255, 94, 126), (255, 159, 69), (255, 216, 74), (95, 224, 138), (72, 184, 255), (155, 123, 255)]


def pill(size):
    """The main button: a pink to teal pill with a soft top sheen. Its
    caption is a label the script lays over it."""
    w, h = size
    big = (w * SS, h * SS)
    fill = Image.new("RGBA", big)
    draw = ImageDraw.Draw(fill)
    for x in range(big[0]):
        t = x / (big[0] - 1)
        draw.line((x, 0, x, big[1]), fill=tuple(round(a + (b - a) * t) for a, b in zip(PINK, TEAL)) + (255,))
    sheen = Image.new("RGBA", big, (0, 0, 0, 0))
    ImageDraw.Draw(sheen).rounded_rectangle(
        (big[1] * 0.3, big[1] * 0.08, big[0] - big[1] * 0.3, big[1] * 0.45), radius=big[1] * 0.2, fill=(255, 255, 255, 34)
    )
    fill = Image.alpha_composite(fill, sheen.filter(ImageFilter.GaussianBlur(big[1] * 0.06)))
    mask = Image.new("L", big, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big[0] - 1, big[1] - 1), radius=big[1] / 2, fill=255)
    fill.putalpha(mask)
    return fill.resize(size, Image.LANCZOS)


def rocket_sideways(height):
    """The progress rocket, nose to the right."""
    ship = rocket().rotate(-90, resample=Image.BICUBIC, expand=True)
    ship = ship.crop(ship.getbbox())
    return ship.resize((round(ship.width * height / ship.height), height), Image.LANCZOS)


def rainbow(size):
    """The progress trail: six bands, fading out at the tail (left). The
    script stretches it lengthwise only, which bands do not mind."""
    w, h = size
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    band = h / len(RAINBOW)
    for i, color in enumerate(RAINBOW):
        draw.rectangle((0, round(i * band), w, round((i + 1) * band) - 1), fill=color + (255,))
    fade = Image.new("L", size)
    fade_draw = ImageDraw.Draw(fade)
    for x in range(w):
        fade_draw.line((x, 0, x, h), fill=round(255 * min(1.0, x / (w * 0.35)) ** 1.5))
    image.putalpha(ImageChops.multiply(image.getchannel("A"), fade))
    return image


def track(size):
    """Where the rocket is headed: a faint rounded lane."""
    w, h = size
    big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, w * SS - 1, h * SS - 1), radius=h * SS / 2, fill=(255, 255, 255, 22), outline=(255, 255, 255, 40), width=SS
    )
    return big.resize(size, Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    # The script's own controls: drawn at twice their size, stretched by Setup.
    pill((288, 80)).save(OUT / "pill.png", optimize=True)
    rocket_sideways(72).save(OUT / "rocket.png", optimize=True)
    rainbow((1200, 36)).save(OUT / "rainbow.png", optimize=True)
    track((1200, 36)).save(OUT / "track.png", optimize=True)
    # The image areas at 100%, 150% and 200% scaling (Inno Setup 6.7 help);
    # Setup picks the closest file.
    for w, h in [(202, 386), (336, 643), (430, 824)]:
        wizard_image((w, h)).save(OUT / f"wizard-{w}x{h}.png", optimize=True)
    for s in [58, 97, 124]:
        small_image(s).save(OUT / f"small-{s}.png", optimize=True)
    # 497:360 is the background's kept aspect ratio.
    back_image((1192, 864)).save(OUT / "back.png", optimize=True)


if __name__ == "__main__":
    main()
