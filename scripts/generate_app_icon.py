from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
RES_DIR = ROOT / "android" / "app" / "src" / "main" / "res"
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

BACKGROUND = (31, 26, 23, 255)
BACKGROUND_SOFT = (17, 78, 74, 120)
LOTUS = (244, 181, 96, 255)
LOTUS_HIGHLIGHT = (255, 219, 157, 255)
PALM = (255, 247, 235, 255)
PALM_SHADOW = (214, 174, 111, 160)


def add_rotated_ellipse(
    base: Image.Image,
    center: tuple[float, float],
    size: tuple[float, float],
    angle: float,
    fill: tuple[int, int, int, int],
) -> None:
    width = max(1, int(size[0]))
    height = max(1, int(size[1]))
    pad = max(width, height) * 4
    layer = Image.new("RGBA", (pad, pad), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    left = (pad - width) // 2
    top = (pad - height) // 2
    draw.ellipse((left, top, left + width, top + height), fill=fill)
    rotated = layer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(rotated, (int(center[0] - rotated.width / 2), int(center[1] - rotated.height / 2)))


def build_foreground(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    add_rotated_ellipse(shadow, (size * 0.39, size * 0.40), (size * 0.18, size * 0.44), -18, PALM_SHADOW)
    add_rotated_ellipse(shadow, (size * 0.61, size * 0.40), (size * 0.18, size * 0.44), 18, PALM_SHADOW)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1, size // 52)))
    image.alpha_composite(shadow)

    add_rotated_ellipse(image, (size * 0.39, size * 0.38), (size * 0.17, size * 0.42), -18, PALM)
    add_rotated_ellipse(image, (size * 0.61, size * 0.38), (size * 0.17, size * 0.42), 18, PALM)
    add_rotated_ellipse(image, (size * 0.50, size * 0.24), (size * 0.10, size * 0.16), 0, PALM)

    lotus = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    add_rotated_ellipse(lotus, (size * 0.50, size * 0.67), (size * 0.20, size * 0.22), 0, LOTUS_HIGHLIGHT)
    add_rotated_ellipse(lotus, (size * 0.36, size * 0.68), (size * 0.16, size * 0.20), -28, LOTUS)
    add_rotated_ellipse(lotus, (size * 0.64, size * 0.68), (size * 0.16, size * 0.20), 28, LOTUS)
    add_rotated_ellipse(lotus, (size * 0.27, size * 0.74), (size * 0.12, size * 0.16), -48, LOTUS_HIGHLIGHT)
    add_rotated_ellipse(lotus, (size * 0.73, size * 0.74), (size * 0.12, size * 0.16), 48, LOTUS_HIGHLIGHT)
    image.alpha_composite(lotus)

    return image


def build_full_icon(size: int, round_mask: bool) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    inset = int(size * 0.06)
    radius = int(size * 0.24)
    draw.rounded_rectangle((inset, inset, size - inset, size - inset), radius=radius, fill=BACKGROUND)

    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo)
    halo_draw.ellipse(
        (int(size * 0.18), int(size * 0.16), int(size * 0.82), int(size * 0.80)),
        fill=BACKGROUND_SOFT,
    )
    halo = halo.filter(ImageFilter.GaussianBlur(radius=max(1, size // 20)))
    image.alpha_composite(halo)

    foreground = build_foreground(int(size * 0.90))
    left = (size - foreground.width) // 2
    top = (size - foreground.height) // 2
    image.alpha_composite(foreground, (left, top))

    if round_mask:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
        image.putalpha(mask)

    return image


def save_icons() -> None:
    for density, size in DENSITIES.items():
        mipmap_dir = RES_DIR / f"mipmap-{density}"
        mipmap_dir.mkdir(parents=True, exist_ok=True)

        build_foreground(size).save(mipmap_dir / "ic_launcher_foreground.png")
        build_full_icon(size, round_mask=False).save(mipmap_dir / "ic_launcher.png")
        build_full_icon(size, round_mask=True).save(mipmap_dir / "ic_launcher_round.png")


if __name__ == "__main__":
    save_icons()
