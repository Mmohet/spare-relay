# Draws the lens icons into spare/assets/ (python3 spare/make-icons.py; needs Pillow).
# The compiler numbers assets by file name, so the two-digit prefix is the number main.ss passes to image().
# Each picture is 20 x 20; a pixel's value is its brightness on the lens and 0 is transparent. Icons come in a bright
# and a dim copy because the platform does not say whether gray() changes an image.
from pathlib import Path
from PIL import Image, ImageDraw

S = 4                      # draw four times larger, then shrink, for smooth edges
OUT = Path(__file__).resolve().parent / 'assets'
HI, LO = 255, 120


def p(x, y):
    return (x * S, y * S)


def line(d, pts, w):
    d.line([p(*q) for q in pts], fill=255, width=round(w * S), joint='curve')
    for q in (pts[0], pts[-1]):  # round caps
        r = w * S / 2
        d.ellipse((q[0] * S - r, q[1] * S - r, q[0] * S + r, q[1] * S + r), fill=255)


def ring(d, cx, cy, r, w):
    d.ellipse((p(cx - r, cy - r), p(cx + r, cy + r)), outline=255, width=round(w * S))


def disc(d, cx, cy, r):
    d.ellipse((p(cx - r, cy - r), p(cx + r, cy + r)), fill=255)


def codex(d):
    d.line([p(7, 3), p(3, 3), p(3, 17), p(7, 17)], fill=255, width=round(2.4 * S), joint='curve')
    d.line([p(13, 3), p(17, 3), p(17, 17), p(13, 17)], fill=255, width=round(2.4 * S), joint='curve')


def claude(d):
    for a, b in (((10, 2), (10, 18)), ((2, 10), (18, 10)), ((4.3, 4.3), (15.7, 15.7)), ((15.7, 4.3), (4.3, 15.7))):
        line(d, [a, b], 2.4)


def muse(d):
    ring(d, 10, 10, 7.5, 2.4)
    disc(d, 10, 10, 2.6)


def grok(d):
    d.rounded_rectangle((p(2.5, 2.5), p(17.5, 17.5)), radius=2 * S, outline=255, width=round(2.4 * S))
    line(d, [(6, 15), (14, 5)], 2.4)


def dsh(d):
    # DeepSeek: one wave across the slot, the same stroke as the other agents.
    import math
    line(d, [(3 + i * 0.5, 10 - 4.5 * math.sin((i * 0.5) / 14 * 2 * math.pi)) for i in range(29)], 2.4)


def relay(d):
    for c in ((4.2, 4.2), (15.8, 4.2), (4.2, 15.8), (15.8, 15.8)):
        line(d, [(10, 10), c], 1.9)
    for c in ((3, 3), (17, 3), (3, 17), (17, 17)):
        ring(d, c[0], c[1], 2.2, 1.9)
    disc(d, 10, 10, 3.6)


def zongguan(d):
    # 总管: a six-spoke asterisk around an open centre, so it does not read as Claude's eight spokes.
    import math
    for k in range(6):
        a = math.pi / 2 + k * math.pi / 3
        line(d, [(10 + 3.4 * math.cos(a), 10 - 3.4 * math.sin(a)), (10 + 8 * math.cos(a), 10 - 8 * math.sin(a))], 2.4)


def ok(d):
    line(d, [(3.5, 10.5), (8.5, 15.5), (16.5, 5)], 2.6)


def no(d):
    line(d, [(5, 5), (15, 15)], 2.6)
    line(d, [(15, 5), (5, 15)], 2.6)


def mic(d):
    d.rounded_rectangle((p(7, 2), p(13, 12)), radius=3 * S, outline=255, width=round(2.2 * S))
    d.arc((p(4, 3.5), p(16, 15.5)), 0, 180, fill=255, width=round(2.2 * S))
    line(d, [(10, 15.5), (10, 18.5)], 2.2)


def listing(d):
    line(d, [(3, 5), (17, 5)], 2.4)
    line(d, [(3, 10), (17, 10)], 2.4)
    line(d, [(3, 15), (12, 15)], 2.4)


def back(d):
    line(d, [(12.5, 4), (6.5, 10), (12.5, 16)], 2.6)


def plus(d):
    line(d, [(10, 3), (10, 17)], 2.6)
    line(d, [(3, 10), (17, 10)], 2.6)


def alert(d):
    line(d, [(10, 3), (10, 12.5)], 3)
    disc(d, 10, 16.5, 1.7)


def dots(d):
    for x in (4, 10, 16):
        disc(d, x, 10, 1.9)


def dot(d):
    disc(d, 10, 10, 1.6)


def hermes(d):
    # Hermes Agent: a staff with two wings near the top.
    line(d, [(10, 3), (10, 18)], 2.4)
    line(d, [(10, 6.5), (4, 3.5)], 2.2)
    line(d, [(10, 6.5), (16, 3.5)], 2.2)
    line(d, [(10, 10.5), (5.5, 8.5)], 2.2)
    line(d, [(10, 10.5), (14.5, 8.5)], 2.2)


def antigravity(d):
    # Antigravity: an arch lifting off a short base.
    d.arc((p(3, 4), p(17, 24)), 180, 360, fill=255, width=round(2.4 * S))
    line(d, [(3.2, 14), (3.2, 17)], 2.4)
    line(d, [(16.8, 14), (16.8, 17)], 2.4)
    disc(d, 10, 9.5, 1.9)


ICONS = [
    ('codex-hi', codex, HI), ('claude-hi', claude, HI), ('muse-hi', muse, HI), ('grok-hi', grok, HI),
    ('codex-lo', codex, LO), ('claude-lo', claude, LO), ('muse-lo', muse, LO), ('grok-lo', grok, LO),
    ('relay', relay, 230),
    ('ok-hi', ok, HI), ('ok-lo', ok, LO), ('no-hi', no, HI), ('no-lo', no, LO), ('mic-hi', mic, HI), ('mic-lo', mic, LO),
    ('list-hi', listing, HI), ('list-lo', listing, LO), ('back-hi', back, HI), ('back-lo', back, LO),
    ('plus-hi', plus, HI), ('plus-lo', plus, LO),
    ('alert', alert, HI), ('dots', dots, 170), ('dot', dot, 80),
    ('hermes-hi', hermes, HI), ('hermes-lo', hermes, LO), ('agy-hi', antigravity, HI),  # where the status marks were
    ('dsh-hi', dsh, HI), ('dsh-lo', dsh, LO),  # appended so the numbers above stay put
    ('zg-hi', zongguan, HI), ('zg-lo', zongguan, LO),
    ('agy-lo', antigravity, LO),
]


def main():
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob('*.png'):
        old.unlink()
    for n, (name, draw, level) in enumerate(ICONS):
        big = Image.new('L', (20 * S, 20 * S), 0)
        draw(ImageDraw.Draw(big))
        img = big.resize((20, 20), Image.Resampling.LANCZOS).point(lambda v: v * level // 255)
        img.save(OUT / f'{n:02d}-{name}.png')
    print(f'{len(ICONS)} icons in {OUT}')


main()
