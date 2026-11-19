# Draws one Spare lens frame for mac/glasses-sim.mjs.
# stdin: one JSON scene per line  {"els": [...], "scale": 2, "guide": true}
# stdout: one JSON line per scene  {"png": "<base64>", "overflow": ["id", ...]}
# The lens is 540 x 220, monochrome, brightness 0-255 shown as green (spare.cool/dev/docs).
import base64, io, json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 540, 220
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'  # stand-in: the glasses' own font is not published
fonts = {}
ASSETS = Path(__file__).resolve().parent.parent / 'spare' / 'assets'
pictures = {}


def picture(name, scale):
    # An asset pixel is its brightness on the lens and 0 is transparent, so the picture doubles as its own mask.
    key = (name, scale)
    if key not in pictures:
        src = Image.open(ASSETS / name).convert('L')
        src = src.resize((src.width * scale, src.height * scale), Image.Resampling.NEAREST)
        rgb = Image.merge('RGB', (Image.new('L', src.size, 0), src, src.point(lambda v: round(v * 0.25))))
        pictures[key] = (rgb, src.point(lambda v: 255 if v else 0))
    return pictures[key]


def font(size, bold, scale):
    key = (size, bold, scale)
    if key not in fonts:
        fonts[key] = ImageFont.truetype(FONT, round(size * scale), index=1 if bold else 0)
    return fonts[key]


def green(gray):
    g = max(0, min(255, int(gray)))
    return (0, g, round(g * 0.25))


def draw(scene):
    s = scene.get('scale', 2)
    img = Image.new('RGB', (W * s, H * s), (0, 0, 0))
    d = ImageDraw.Draw(img)
    overflow = []

    def box(e, ox, oy):
        x, y = (ox + e['x']) * s, (oy + e['y']) * s
        return x, y, x + e['w'] * s, y + e['h'] * s

    def paint(e, ox=0, oy=0):
        if e.get('hidden'):
            return
        x0, y0, x1, y1 = box(e, ox, oy)
        kind = e['type']
        r = e.get('radius', 0) * s
        if kind == 'rect':
            if e.get('border', 0) > 0:
                d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=r, outline=green(e.get('gray', 255)), width=e['border'] * s)
            else:
                d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=r, fill=green(e.get('gray', 255)))
            for child in e.get('children', []):
                paint(child, ox + e['x'], oy + e['y'])
        elif kind == 'bar':
            d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=r, fill=green(e.get('track', 55)))
            fill = x0 + (x1 - x0) * max(0, min(100, e.get('value', 0))) / 100
            if fill > x0:
                d.rounded_rectangle((x0, y0, fill - 1, y1 - 1), radius=r, fill=green(e.get('gray', 255)))
        elif kind == 'text':
            text = e.get('text', '')
            if not text:
                return
            f = font(e.get('size', 22), e.get('bold', False), s)
            width = d.textlength(text, font=f)
            if width > x1 - x0 + s:
                overflow.append(e['id'])
            align = e.get('align', 'left')
            tx = x0 if align == 'left' else (x1 - width if align == 'right' else x0 + (x1 - x0 - width) / 2)
            # Clip to the element box so text that does not fit shows up cut, the way a fixed label would.
            bx0, by0, bx1, by1 = int(x0), int(y0), int(x1), int(y1)
            if bx1 <= bx0 or by1 <= by0:
                return
            layer = Image.new('RGBA', (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
            ImageDraw.Draw(layer).text((tx - bx0, 0), text, font=f, fill=green(e.get('gray', 255)) + (255,))
            img.paste(layer, (bx0, by0), layer)
        elif kind == 'image':
            if not (ASSETS / e.get('src', '')).is_file():
                d.rectangle((x0, y0, x1 - 1, y1 - 1), outline=green(80), width=s)
                return
            rgb, mask = picture(e['src'], s)
            img.paste(rgb, (int(x0), int(y0)), mask)

    for e in scene['els']:
        paint(e)
    if scene.get('guide'):
        # Below y 195 the lens may cut content off; about the last 10 px are lost.
        for x in range(0, W * s, 8 * s):
            d.line((x, 195 * s, x + 3 * s, 195 * s), fill=(90, 0, 0), width=1)
        d.rectangle((0, 210 * s, W * s - 1, H * s - 1), fill=(40, 0, 0))
    out = io.BytesIO()
    img.save(out, 'PNG', optimize=False, compress_level=1)
    return {'png': base64.b64encode(out.getvalue()).decode(), 'overflow': overflow}


for line in sys.stdin:
    try:
        result = draw(json.loads(line))
    except Exception as error:  # keep the simulator alive; it shows the message in its log
        result = {'error': repr(error)}
    sys.stdout.write(json.dumps(result) + '\n')
    sys.stdout.flush()
