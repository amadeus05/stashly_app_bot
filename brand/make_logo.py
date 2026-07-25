# -*- coding: utf-8 -*-
"""
Логотип Stashly — аватар для Telegram-бота.

Рисуем растр напрямую: Telegram принимает PNG, а не SVG.
Рендерим в 4x и уменьшаем — это даёт чистые края на скруглениях
и повёрнутых карточках без единой лестницы из пикселей.

    python brand/make_logo.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent
SIZE = 512
SS = 4                      # супersampling
S = SIZE * SS

INDIGO_TOP = (99, 91, 255)
INDIGO_BOTTOM = (124, 58, 237)
AMBER = (251, 191, 36)
INK = (49, 46, 129)
WHITE = (255, 255, 255)


def gradient(size, top, bottom):
    """Вертикальный градиент фона."""
    base = Image.new('RGB', (1, size))
    pixels = base.load()
    for y in range(size):
        t = y / (size - 1)
        pixels[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return base.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def card(w, h, radius, fill, angle, center, canvas_size, shadow=True):
    """Карточка со скруглением, тенью и поворотом — отдельным слоем."""
    pad = int(max(w, h) * 0.5)
    layer = Image.new('RGBA', (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle([pad, pad, pad + w, pad + h], radius=radius, fill=fill)

    result = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))

    if shadow:
        # Тень строим из той же формы: смещаем, размываем, гасим прозрачностью.
        blur = Image.new('RGBA', layer.size, (0, 0, 0, 0))
        ImageDraw.Draw(blur).rounded_rectangle(
            [pad, pad, pad + w, pad + h], radius=radius, fill=(20, 12, 60, 110))
        blur = blur.filter(ImageFilter.GaussianBlur(14 * SS))
        blur = blur.rotate(angle, resample=Image.BICUBIC, center=(layer.width // 2, layer.height // 2))
        result.alpha_composite(blur, (center[0] - layer.width // 2, center[1] - layer.height // 2 + 6 * SS))

    layer = layer.rotate(angle, resample=Image.BICUBIC, center=(layer.width // 2, layer.height // 2))
    result.alpha_composite(layer, (center[0] - layer.width // 2, center[1] - layer.height // 2))
    return result


def background():
    bg = gradient(S, INDIGO_TOP, INDIGO_BOTTOM).convert('RGBA')
    bg.putalpha(rounded_mask(S, int(S * 0.235)))

    # Мягкий блик сверху слева — иначе плоская заливка выглядит дёшево.
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [-S * 0.25, -S * 0.45, S * 0.75, S * 0.35], fill=(255, 255, 255, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(40 * SS))
    glow.putalpha(Image.composite(glow.getchannel('A'), Image.new('L', (S, S), 0), rounded_mask(S, int(S * 0.235))))
    bg.alpha_composite(glow)
    return bg


def card_stack(image):
    """Три карточки веером: задние — намёк на стопку, передняя — носитель смысла."""
    cx, cy = S // 2, S // 2
    w, h = int(S * 0.44), int(S * 0.54)
    radius = int(S * 0.055)

    image.alpha_composite(card(w, h, radius, (255, 255, 255, 105), -15, (cx - int(S * 0.055), cy), S))
    image.alpha_composite(card(w, h, radius, (255, 255, 255, 170), -7.5, (cx - int(S * 0.025), cy), S))
    image.alpha_composite(card(w, h, radius, WHITE + (255,), 0, (cx + int(S * 0.02), cy), S))
    return cx + int(S * 0.02), cy, w, h


def variant_monogram():
    """A: монограмма S на передней карточке."""
    image = background()
    cx, cy, w, h = card_stack(image)

    font = ImageFont.truetype(r'C:\Windows\Fonts\ariblk.ttf', int(h * 0.72))
    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), 'S', font=font)
    draw.text((cx - (box[2] + box[0]) / 2, cy - (box[3] + box[1]) / 2), 'S', font=font, fill=INK)

    # Уголок-закладка: единственное цветовое пятно, оно и держит внимание.
    tag = int(S * 0.052)
    draw.ellipse([cx + w // 2 - tag * 2, cy - h // 2 - tag // 2,
                  cx + w // 2, cy - h // 2 + tag * 3 // 2], fill=AMBER)
    return image


def variant_lines():
    """B: строки и тег вместо буквы — без языка и без монограммы."""
    image = background()
    cx, cy, w, h = card_stack(image)
    draw = ImageDraw.Draw(image)

    left = cx - w // 2 + int(w * 0.16)
    top = cy - h // 2 + int(h * 0.22)
    line_h = int(h * 0.075)
    gap = int(h * 0.135)

    for i, ratio in enumerate((0.68, 0.52, 0.60)):
        y = top + i * gap
        draw.rounded_rectangle([left, y, left + int(w * 0.68 * ratio / 0.68), y + line_h],
                               radius=line_h // 2, fill=INK)

    # Тег — акцент и намёк на главную механику продукта.
    tag_y = top + 3 * gap + int(h * 0.04)
    tag_w = int(w * 0.42)
    draw.rounded_rectangle([left, tag_y, left + tag_w, tag_y + int(line_h * 1.7)],
                           radius=int(line_h * 0.85), fill=AMBER)
    return image


def save(image, name):
    final = image.resize((SIZE, SIZE), Image.LANCZOS)
    final.save(OUT / f'{name}.png')

    # Как это увидят в списке чатов.
    preview = final.resize((96, 96), Image.LANCZOS)
    circle = Image.new('L', (96, 96), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, 95, 95], fill=255)
    small = Image.new('RGBA', (96, 96), (0, 0, 0, 0))
    small.paste(preview, (0, 0), circle)
    small.save(OUT / f'{name}_96.png')
    print(f'  {name}.png  512x512  +  {name}_96.png (как в списке чатов)')


if __name__ == '__main__':
    print('Stashly — логотип:')
    save(variant_monogram(), 'logo_monogram')
    save(variant_lines(), 'logo_card')
