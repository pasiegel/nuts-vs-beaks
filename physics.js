/* =========================================================================
 * NUT vs. BEAK - physics.js
 * Destructible pixel terrain + collision helpers.
 *
 * HOW DESTRUCTIBLE TERRAIN WORKS (two parallel representations, kept in sync):
 *   1. `mask`  - a Uint8Array, one byte per pixel (1 = solid, 0 = air).
 *                ALL collision queries read this. Reading one byte is far
 *                cheaper than getImageData(), and it never needs a GPU readback.
 *   2. `off`   - an offscreen <canvas> holding the pretty dirt/grass picture.
 *                Rendering just drawImage()s it every frame.
 *
 * An explosion at (cx,cy) radius r:
 *   - canvas: fill a circle with globalCompositeOperation = "destination-out",
 *             which ERASES pixels to transparent (the sky shows through).
 *   - mask:   for every pixel in the circle's bounding box, if
 *             (x-cx)^2 + (y-cy)^2 <= r^2 then mask = 0.
 * Squared distance is compared against r^2 so we never need a sqrt per pixel.
 * ========================================================================= */
const Physics = (() => {
  const W = 960, H = 540, GRAV = 0.25;

  let off = null, tctx = null, mask = null;

  /* ---- generation ------------------------------------------------------ */
  function generate() {
    off = document.createElement("canvas");
    off.width = W; off.height = H;
    tctx = off.getContext("2d", { willReadFrequently: true });
    mask = new Uint8Array(W * H);

    // Ground height = a few summed sines with random phases (cheap "noise").
    const p1 = Math.random() * 6.28, p2 = Math.random() * 6.28, p3 = Math.random() * 6.28;
    for (let x = 0; x < W; x++) {
      let h = 350 + 55 * Math.sin(x * 0.0075 + p1) + 32 * Math.sin(x * 0.021 + p2) + 14 * Math.sin(x * 0.055 + p3);
      h = Math.max(220, Math.min(440, h));
      for (let y = Math.floor(h); y < H; y++) mask[y * W + x] = 1;
    }

    // A few floating "tree branches" so there is vertical variety.
    for (let i = 0; i < 4; i++) {
      const cx = 110 + Math.random() * (W - 220), cy = 130 + Math.random() * 130;
      const hw = 45 + Math.random() * 30, th = 7 + Math.random() * 5;
      for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
        const t = 1 - Math.pow((x - cx) / hw, 2);
        const half = th * Math.sqrt(Math.max(0, t));
        for (let y = Math.floor(cy - half); y <= cy + half; y++) if (x >= 0 && x < W && y >= 0 && y < H) mask[y * W + x] = 1;
      }
    }
    paint();
  }

  /* Colour the mask into the offscreen canvas: grass on top of each solid run, dirt below. */
  function paint() {
    const img = tctx.createImageData(W, H), d = img.data;
    for (let x = 0; x < W; x++) {
      let depth = 0;
      for (let y = 0; y < H; y++) {
        if (!mask[y * W + x]) { depth = 0; continue; }
        const i = (y * W + x) * 4;
        let r, g, b;
        if (depth < 5) { r = 70 + (x % 7) * 3; g = 170 - depth * 6; b = 55; }              // grass
        else { const t = Math.min(1, y / H), n = ((x * 7 + y * 13) % 9); r = 139 - t * 60 + n; g = 90 - t * 40 + n; b = 43 - t * 20; } // dirt
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
        depth++;
      }
    }
    tctx.putImageData(img, 0, 0);
  }

  /* ---- queries --------------------------------------------------------- */
  function solid(x, y) {
    x = x | 0; y = y | 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return mask[y * W + x] === 1;
  }

  /* Surface normal at (x,y): points away from nearby solid pixels. Used to bounce grenades. */
  function normal(x, y) {
    let nx = 0, ny = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (solid(x + dx, y + dy)) { nx -= dx; ny -= dy; }
    const len = Math.hypot(nx, ny);
    return len < 1e-3 ? { x: 0, y: -1 } : { x: nx / len, y: ny / len };
  }

  /* First solid pixel scanning down from fromY that has air above it (a standable surface). */
  function surfaceY(x, fromY = 0) {
    x = x | 0;
    for (let y = Math.max(1, fromY | 0); y < H; y++) if (solid(x, y) && !solid(x, y - 1)) return y;
    return null;
  }

  /* March a ray; returns { x, y, dist } of the first solid pixel or null. */
  function raycast(x, y, angleDeg, maxLen) {
    const a = angleDeg * Math.PI / 180, dx = Math.cos(a), dy = -Math.sin(a);
    for (let d = 4; d <= maxLen; d += 2) if (solid(x + dx * d, y + dy * d)) return { x: x + dx * d, y: y + dy * d, dist: d };
    return null;
  }

  /* ---- destruction / construction ------------------------------------- */
  function carve(cx, cy, r) {
    tctx.save();
    tctx.globalCompositeOperation = "destination-out";
    tctx.beginPath(); tctx.arc(cx, cy, r, 0, Math.PI * 2); tctx.fill();
    tctx.restore();

    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) mask[y * W + x] = 0;
      }
    }
  }

  /* Stamp a solid wooden bar (popsicle-stick "girder") onto both canvas and mask. */
  function addBar(x1, y1, x2, y2, thick) {
    tctx.save();
    tctx.strokeStyle = "#d9b26b"; tctx.lineWidth = thick; tctx.lineCap = "butt";
    tctx.beginPath(); tctx.moveTo(x1, y1); tctx.lineTo(x2, y2); tctx.stroke();
    tctx.strokeStyle = "#8a6a34"; tctx.lineWidth = 1;
    tctx.beginPath(); tctx.moveTo(x1, y1); tctx.lineTo(x2, y2); tctx.stroke();
    tctx.restore();

    const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.ceil(len), rr = thick / 2;
    for (let i = 0; i <= steps; i++) {
      const cx = x1 + (x2 - x1) * i / steps, cy = y1 + (y2 - y1) * i / steps;
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const px = Math.round(cx + dx), py = Math.round(cy + dy);
        if (px >= 0 && px < W && py >= 0 && py < H) mask[py * W + px] = 1;
      }
    }
  }

  return { W, H, GRAV, generate, solid, normal, surfaceY, raycast, carve, addBar, canvas: () => off };
})();
