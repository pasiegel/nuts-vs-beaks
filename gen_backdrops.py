import os
import random
from PIL import Image, ImageDraw

os.makedirs("./img", exist_ok=True)
W, H = 800, 600

def create_suburban_fence():
    # Bright summer sky
    img = Image.new("RGB", (W, H), color=(135, 206, 235))
    draw = ImageDraw.Draw(img)

    # Cloud scattering
    for _ in range(12):
        cx = random.randint(-50, W)
        cy = random.randint(20, H // 2)
        cw = random.randint(80, 200)
        ch = random.randint(30, 60)
        draw.ellipse([cx, cy, cx + cw, cy + ch], fill=(255, 255, 255))
        draw.ellipse([cx + 30, cy - 20, cx + cw - 20, cy + ch], fill=(255, 255, 255))

    # Picket fence
    fence_top = int(H * 0.4)
    draw.rectangle([0, fence_top + 40, W, fence_top + 60], fill=(220, 210, 200)) # Crossbeam
    for x in range(10, W, 70):
        # Picket post
        draw.polygon([(x, fence_top + 20), (x + 25, fence_top), (x + 50, fence_top + 20)], fill=(240, 235, 225))
        draw.rectangle([x, fence_top + 20, x + 50, H], fill=(240, 235, 225))
        # Wood grain lines
        draw.line([(x + 10, fence_top + 30), (x + 10, H)], fill=(210, 200, 190), width=2)
        draw.line([(x + 35, fence_top + 50), (x + 35, H)], fill=(210, 200, 190), width=2)

    img.save("./img/bg-fence.png")
    print("Created ./img/bg-fence.png")

def create_oak_canopy():
    # Deep foliage green background
    img = Image.new("RGB", (W, H), color=(34, 55, 34))
    draw = ImageDraw.Draw(img)

    # Sun shafts cutting through the leaves
    for x in range(-200, W, 150):
        draw.polygon([(x, 0), (x + 80, 0), (x + 300, H), (x + 220, H)], fill=(45, 70, 40))

    # Distant branches
    for _ in range(15):
        bx = random.randint(0, W)
        by = random.randint(0, H)
        draw.line([(bx, by), (bx + random.randint(100, 300), by - random.randint(50, 200))], fill=(25, 20, 15), width=random.randint(8, 24))

    # Out of focus foreground leaves (Bokeh effect)
    for _ in range(60):
        lx = random.randint(0, W)
        ly = random.randint(0, H)
        size = random.randint(40, 120)
        shade = random.randint(60, 100)
        draw.ellipse([lx, ly, lx + size, ly + size], fill=(shade - 20, shade, shade - 30))

    img.save("./img/bg-canopy.png")
    print("Created ./img/bg-canopy.png")

def create_twilight_yard():
    # Sunset to night gradient
    img = Image.new("RGB", (W, H), color=(10, 15, 30))
    draw = ImageDraw.Draw(img)

    for y in range(H):
        t = y / H
        r = int(10 + 120 * t)
        g = int(15 + 40 * t)
        b = int(30 + 20 * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))

    # Silhouetted treeline
    horizon = int(H * 0.6)
    for _ in range(30):
        tx = random.randint(-50, W)
        tw = random.randint(60, 150)
        th = random.randint(100, 300)
        draw.ellipse([tx, horizon - th, tx + tw, horizon + 50], fill=(5, 5, 10))

    # Fireflies
    for _ in range(45):
        fx = random.randint(0, W)
        fy = random.randint(horizon - 100, H)
        draw.ellipse([fx, fy, fx + 4, fy + 4], fill=(200, 255, 100))
        # Glow
        draw.ellipse([fx - 4, fy - 4, fx + 8, fy + 8], outline=(150, 200, 50), width=1)

    img.save("./img/bg-twilight.png")
    print("Created ./img/bg-twilight.png")

if __name__ == "__main__":
    create_suburban_fence()
    create_oak_canopy()
    create_twilight_yard()
    print("Backyard backgrounds generated successfully!")
