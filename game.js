/* =========================================================================
 * NUT vs. BEAK - game.js
 * Turn loop, rendering, weapons, bot AI.
 *
 * Structure:
 *   WEAPONS       data-driven registry (one entry per !weapon name)
 *   units/turns   who is up, timers, chat-command handling
 *   entities      projectiles, mines, gas clouds, diggers, scripted set-pieces
 *   execute()     what each weapon KIND does when fired
 *   bot AI        brute-force ballistic search + error margin
 *   draw()        canvas rendering (emoji sprites, hitboxes are plain circles)
 *
 * Aim convention: !aim 0 = right, 90 = straight up, 180 = left.
 * ========================================================================= */
const Game = (() => {
  "use strict";
  const { W, H, GRAV } = Physics;
  const R = 12;                              // unit hitbox radius (independent of emoji size)
  const TURN_FRAMES = 30 * 60;               // 30 s at 60 fps
  const MOVE_BUDGET = 90;                    // px of walking per turn
  const SUDDEN_DEATH_TURN = 20;              // total turns before the water starts rising
  const MANUAL_CONTROL = false;              // false = Slash Royale style: every unit is AI-driven, chat only votes on weapons
  const VOTE_CHANCE = 0.4;                   // chance a turn opens a "type this weapon" chat vote
  const VOTE_SECONDS = 8;
  // Pacing for viewers: text goes up first, the action starts a beat later (frames at 60fps).
  const TURN_INTRO_FRAMES = 105;             // "X's turn" banner -> weapon announcement (~1.75 s)
  const READ_DELAY_FRAMES = 90;              // weapon announcement / chat's pick -> the shot (~1.5 s)
  // Relative odds the AI picks each weapon (also the pool chat can be offered).
  const WEIGHTS = { acorn: 5, egg: 3, cluster: 2, pinecone: 2, suet: 2, walnut: 2, pot: 2, spitter: 2, woodpecker: 1.5, bugspray: 1, crows: 1.5, skunk: 1, gophers: 1.5, ants: 1.5, gnome: 1, homeowner: 0.6, mower: 0.5, blower: 0.4, sprinklers: 0.3, dive: 0.4, gnaw: 0.5, firecracker: 0.6, sap: 0.6 };
  const ONCE_PER_MATCH = new Set(["sprinklers", "mower", "homeowner"]);
  // Supply crates: parachute in after some turns; anyone who touches one gets HP or a big weapon.
  const CRATE_CHANCE = 0.35;                 // chance a crate drops when a turn ends
  const MAX_CRATES = 2;                      // on the field at once
  const CRATE_HEAL = 40;                     // health crate restores this much...
  const MAX_HP = 150;                        // ...and may overheal up to this (normal max is 100)
  const CRATE_WEAPONS = ["walnut", "suet", "mower", "homeowner", "crows", "gnome", "skunk", "pot"];
  const FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  const EMOJI_FACES_LEFT = true;             // flip if your emoji font draws them facing right
  const ICON = { squirrels: "🐿️", birds: "🐦" };
  const COLOR = { squirrels: "#ffb066", birds: "#7cc8ff" };
  const BACKDROPS = ["img/bg-fence.png", "img/bg-canopy.png", "img/bg-twilight.png"];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  /* ---------------------------------------------------------------------
   * WEAPON REGISTRY
   *  kind: proj | drop | mine | spit | peck | melee | poke | dive | spray |
   *        air | dig | util | special      (util = does not end the turn)
   *  p:    projectile definition (see updateProj): r=blast radius, dmg,
   *        grav/wind multipliers, bounce (0 = explode on impact), fuse,
   *        impact, split, gas, homing, crush, settleFuse, ray
   *  epi:  cause-of-death line for the epitaph card ({k} = killer name)
   * ------------------------------------------------------------------- */
  const WEAPONS = {
    // ---- projectiles & explosives
    acorn:       { name: "Acorn-zooka", emoji: "🌰", kind: "proj", p: { emoji: "🌰", r: 34, dmg: 35, wind: 1, impact: true }, epi: "Nutted by {k}" },
    pinecone:    { name: "Heat-Seeking Pinecone", emoji: "🌲", kind: "proj", p: { emoji: "🌲", r: 30, dmg: 35, impact: true, homing: true }, epi: "Hunted down by {k}'s pinecone" },
    egg:         { name: "Rotten Egg", emoji: "🥚", kind: "proj", p: { emoji: "🥚", r: 40, dmg: 40, bounce: 0.55, fuse: 180, gas: { n: 7, dmg: 0.25, life: 150, rad: 16 } }, epi: "Stunk to death by {k}" },
    cluster:     { name: "Berry Cluster", emoji: "🫐", kind: "proj", p: { emoji: "🫐", r: 24, dmg: 22, impact: true, split: { n: 5, speed: 5, child: { emoji: "🫐", size: 0.6, r: 24, dmg: 16, bounce: 0.6, fuse: 70, jitter: 30 } } }, epi: "Stained by {k}'s berries" },
    suet:        { name: "Suet Cake", emoji: "🧈", kind: "proj", p: { emoji: "🧈", size: 1.3, grav: 1.15, r: 34, dmg: 26, bounce: 0.4, fuse: 200, split: { n: 12, speed: 6, child: { emoji: "🟡", size: 0.5, r: 28, dmg: 20, bounce: 0.65, fuse: 60, jitter: 45 } } }, epi: "Suet-smashed by {k}" },
    walnut:      { name: "Golden Walnut", emoji: "🥜", kind: "proj", p: { emoji: "🥜", glow: true, r: 95, dmg: 80, bounce: 0.5, settleFuse: 180, ray: true }, epi: "Smitten by {k}'s Golden Walnut" },
    firecracker: { name: "Firecrackers", emoji: "🧨", kind: "drop", p: { emoji: "🧨", r: 46, dmg: 55, fuse: 150, bounce: 0.2 }, epi: "Firecrackered by {k}" },
    sap:         { name: "Sap Trap", emoji: "🍯", kind: "mine", p: { emoji: "🍯", r: 50, dmg: 50, mine: true }, epi: "Stuck to {k}'s sap trap" },
    // ---- ranged / melee
    spitter:     { name: "Sunflower Seed Spitter", emoji: "🌻", kind: "spit", p: { emoji: "🌻", size: 0.5, r: 18, dmg: 24, grav: 0.1, wind: 0.1, impact: true }, epi: "Seeded by {k}" },
    woodpecker:  { name: "Gatling Woodpecker", emoji: "🐦", kind: "peck", p: { emoji: "•", size: 0.5, r: 13, dmg: 9, grav: 0.02, wind: 0, impact: true }, epi: "Pecked apart by {k}" },
    trowel:      { name: "Garden Trowel", emoji: "🔪", kind: "melee", mode: "halve", epi: "Trowelled in half by {k}" },
    newspaper:   { name: "Rolled-Up Newspaper", emoji: "🗞️", kind: "melee", mode: "swat", epi: "Swatted by {k}" },
    poke:        { name: "Tail Flick / Beak Poke", emoji: "👉", kind: "poke", epi: "Poked over the edge by {k}" },
    dive:        { name: "Dive Bomb", emoji: "🪂", kind: "dive", epi: "Dive-bombed by {k}" },
    bugspray:    { name: "Stolen Bug Spray", emoji: "🧴", kind: "spray", epi: "Fumigated by {k}" },
    // ---- airstrikes / animals / disasters (use !target 0-100)
    crows:       { name: "Flock of Crows", emoji: "🐦‍⬛", kind: "air", needsTarget: true, epi: "Bombed by {k}'s crows" },
    skunk:       { name: "Skunk Spray", emoji: "🦨", kind: "air", needsTarget: true, epi: "Gassed by {k}'s skunk" },
    gophers:     { name: "Gopher Platoon", emoji: "🦫", kind: "air", needsTarget: true, epi: "Undermined by {k}'s gophers" },
    ants:        { name: "Marching Ants", emoji: "🐜", kind: "dig", epi: "Marched upon by {k}'s ants" },
    gnome:       { name: "Garden Gnome", emoji: "🧙", kind: "air", needsTarget: true, epi: "Crushed by {k}'s gnome" },
    homeowner:   { name: "Angry Homeowner", emoji: "🥾", kind: "air", needsTarget: true, epi: "Stomped by {k}'s homeowner" },
    pot:         { name: "Ceramic Flower Pot", emoji: "🪴", kind: "proj", p: { emoji: "🪴", r: 40, dmg: 35, bounce: 0.35, fuse: 150, split: { n: 9, speed: 7, full: true, child: { emoji: "🟤", size: 0.45, r: 16, dmg: 14, impact: true } } }, epi: "Potted by {k}" },
    mower:       { name: "Lawn Mower", emoji: "🚜", kind: "special", epi: "Mowed down by {k}" },
    blower:      { name: "Leaf Blower", emoji: "🍃", kind: "special", epi: "Blown away by {k}" },
    sprinklers:  { name: "Turn on the Sprinklers", emoji: "🚿", kind: "special", epi: "Soaked by {k}" },
    // ---- navigation / construction / utility (do not end the turn)
    gnaw:        { name: "Gnawing Teeth", emoji: "🦷", kind: "gnaw", epi: "Gnawed by {k}" },
    stick:       { name: "Popsicle Stick", emoji: "🪵", kind: "util", epi: "" },
    yoyo:        { name: "Stolen Yo-Yo String", emoji: "🪀", kind: "util", epi: "" },
    dandelion:   { name: "Dandelion Seed", emoji: "🌼", kind: "util", epi: "" },
    birdhouse:   { name: "Magical Birdhouse", emoji: "🏠", kind: "util", needsTarget: true, epi: "" },
    wings:       { name: "Hummingbird Wings", emoji: "🪽", kind: "util", epi: "" },
    select:      { name: "Select-a-Critter", emoji: "👆", kind: "util", epi: "" },
    playdead:    { name: "Play Dead", emoji: "💀", kind: "special", epi: "" }
  };
  const ALIAS = { bazooka: "acorn", grenade: "egg", holy: "walnut", holyhand: "walnut", banana: "suet", shotgun: "spitter", flamethrower: "bugspray", torch: "gnaw", rope: "yoyo", parachute: "dandelion", teleport: "birdhouse", jetpack: "wings", girder: "stick", napalm: "skunk", armageddon: "mower", surrender: "playdead", skip: "playdead" };
  const BOT_WEAPONS = ["acorn", "acorn", "acorn", "egg", "cluster", "walnut", "pinecone", "suet", "pot"];

  /* ---- state ---- */
  let ctx = null, canvas = null, running = false, api = null, raf = 0, last = 0, acc = 0;
  let units = [], wind = 0, waterY = H - 24, shake = 0, frame = 0, turnCounter = 0, finishing = false;
  let projectiles = [], mines = [], gases = [], diggers = [], timers = [], particles = [], fx = [], scripted = [];
  let turn = null, sideRot = { squirrels: -1, birds: -1 }, lastSide = "birds", bg = null, skyGrad = null, clouds = [];
  let usedOnce = new Set(), crates = [];

  /* ---- small helpers ---- */
  const alive = () => units.filter(u => u.alive);
  const enemiesOf = u => units.filter(o => o.alive && o.side !== u.side);
  const later = (t, fn) => timers.push({ t, fn });
  function banner(text) {
    const b = document.getElementById("battleBanner");
    if (!b) return;
    b.textContent = text; b.classList.remove("show"); void b.offsetWidth; b.classList.add("show");
  }
  const sfx = (name, arg) => { if (window.Sfx) Sfx.play(name, arg); };   // all audio lives in sfx.js
  const chirp = f => sfx("chirp", f);

  /* ---------------------------------------------------------------------
   * START / STOP
   * ------------------------------------------------------------------- */
  function start(list, apiObj) {
    api = apiObj; canvas = document.getElementById("gameCanvas"); ctx = canvas.getContext("2d");
    Physics.generate();
    projectiles = []; mines = []; gases = []; diggers = []; timers = []; particles = []; fx = []; scripted = [];
    turn = null; sideRot = { squirrels: -1, birds: -1 }; lastSide = "birds"; frame = 0; turnCounter = 0; shake = 0; finishing = false;
    usedOnce = new Set(); crates = [];
    waterY = H - 24; wind = Math.round(rnd(-6, 6));
    units = list;
    placeUnits();
    clouds = Array.from({ length: 5 }, () => ({ x: rnd(0, W), y: rnd(20, 150), s: rnd(30, 54), v: rnd(0.05, 0.2) }));
    skyGrad = ctx.createLinearGradient(0, 0, 0, H); skyGrad.addColorStop(0, "#4a90d9"); skyGrad.addColorStop(1, "#bfe3f5");
    bg = new Image(); bg.src = pick(BACKDROPS);                // optional; falls back to the sky gradient if missing
    running = true; last = performance.now(); acc = 0;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    banner("BATTLE START!"); sfx("horn");
    later(120, nextTurn);
  }

  function placeUnits() {
    const xs = [];
    units.forEach(u => {
      let x, tries = 0;
      do { x = rnd(50, W - 50); tries++; } while (tries < 80 && xs.some(o => Math.abs(o - x) < 70));
      xs.push(x);
      Object.assign(u, { x, y: -20, vx: 0, vy: 0, hp: 100, alive: true, facing: Math.random() < 0.5 ? -1 : 1, damageDealt: 0, kills: 0, cause: null, soggy: 0, para: false, flying: 0, zip: null, hidden: false, lastHit: null, walk: null, gift: null });
    });
  }

  function loop(now) {
    if (!running) return;
    if (typeof state !== "undefined" && state !== "BATTLE") { running = false; return; }   // match was aborted
    acc += Math.min(100, now - last); last = now;
    while (acc >= 1000 / 60) { update(); acc -= 1000 / 60; }
    draw(); hud();
    raf = requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------------
   * UNITS
   * ------------------------------------------------------------------- */
  // Must mirror the landing test in updateUnit (centre + both side "feet"), otherwise a unit
  // resting on a slope edge is treated as airborne and the turn never finishes settling.
  const grounded = u => Physics.solid(u.x, u.y + R + 1) || Physics.solid(u.x - 5, u.y + R) || Physics.solid(u.x + 5, u.y + R);

  function hurt(u, amt, by, wkey) {
    if (!u.alive || amt <= 0) return;
    const real = Math.min(u.hp, amt);
    u.hp -= amt;
    if (amt > 4) sfx("hurt");
    if (by && by !== u && by.side !== u.side) by.damageDealt += real;
    u.lastHit = { by, w: wkey, t: frame };
    if (u.hp <= 0) kill(u, null);
  }

  function kill(u, kind) {
    if (!u.alive) return;
    u.alive = false; u.hp = 0; u.hidden = false;
    sfx("death");
    const lh = u.lastHit, recent = lh && frame - lh.t < 600;
    let cause;
    if (kind === "water") cause = recent && lh.by && lh.by !== u ? `Knocked into the abyss by ${lh.by.name}` : "Fell into the abyss";
    else if (kind === "sacrifice") cause = "Sacrificed themselves in a blaze of feathers";
    else if (kind === "soggy") cause = "Died soggy";
    else if (recent && lh.by === u) cause = "Blew themselves up";
    else if (recent && lh.by) cause = (WEAPONS[lh.w] && WEAPONS[lh.w].epi ? WEAPONS[lh.w].epi : "Killed by {k}").replace("{k}", lh.by.name);
    else cause = "Fell into the abyss";
    u.cause = cause;
    if (recent && lh.by && lh.by !== u && lh.by.side !== u.side) lh.by.kills++;
    for (let i = 0; i < 8; i++) particles.push({ x: u.x, y: u.y, vx: rnd(-2, 2), vy: rnd(-4, -1), life: 40, max: 40, emoji: "💨", size: 18, grav: 0.05 });
    particles.push({ x: u.x, y: u.y, vx: 0, vy: -0.6, life: 90, max: 90, emoji: "🪦", size: 26, grav: 0 });
    if (turn && turn.unit === u && turn.phase === "aim") turn.phase = "resolve";
  }

  function updateUnit(u) {
    if (!u.alive) return;
    if (u.zip) {                                             // yo-yo string zip
      const z = u.zip, dx = z.ax - u.x, dy = z.ay - u.y, d = Math.hypot(dx, dy);
      if (d < 18 || --z.frames <= 0) { u.vx = dx / (d || 1) * 2; u.vy = dy / (d || 1) * 2 - 1; u.zip = null; }
      else { u.x += dx / d * 6; u.y += dy / d * 6; }
      return;
    }
    if (u.flying > 0) {                                      // hummingbird wings
      u.flying--; u.x += u.fvx; u.y += u.fvy;
      if (u.flying === 0) { u.vx = u.fvx * 0.5; u.vy = u.fvy * 0.5; }
      if (u.x < -15 || u.x > W + 15) kill(u, "water");
      return;
    }
    if (u.walk) {                                            // queued !move steps
      const wk = u.walk; wk.left--; u.facing = wk.dir;
      const nx = u.x + wk.dir * 1.6;
      let ok = false;
      for (let k = 0; k <= 6 && !ok; k++) {
        if (!Physics.solid(nx + wk.dir * (R - 3), u.y - k) && !Physics.solid(nx + wk.dir * (R - 3), u.y + R - 6 - k)) { u.x = nx; u.y -= k; ok = true; }
      }
      if (!ok && wk.hop && grounded(u)) { u.vy = -6.5; u.vx = wk.dir * 2.2; wk.hop = false; }   // hop a ledge once
      else if (!ok || wk.left <= 0) u.walk = null;
    }
    let k = 0; while (k < 12 && Physics.solid(u.x, u.y + R - 2)) { u.y--; k++; }   // un-bury after girders / falling terrain
    const onG = grounded(u);
    u.vy += GRAV;
    if (u.para && !onG) { u.vy = Math.min(u.vy, 1.2); u.vx = clamp(u.vx + wind * 0.01, -2.5, 2.5); }

    if (u.vx !== 0) {                                        // horizontal move with small-step climbing
      const sx = Math.sign(u.vx), steps = Math.ceil(Math.abs(u.vx)), dx = u.vx / steps;
      const blocked = (x, y) => Physics.solid(x + sx * (R - 3), y) || Physics.solid(x + sx * (R - 3), y + R - 6);
      for (let i = 0; i < steps; i++) {
        const nx = u.x + dx;
        if (!blocked(nx, u.y)) u.x = nx;
        else { let c = 1; while (c <= 6 && blocked(nx, u.y - c)) c++; if (c <= 6) { u.x = nx; u.y -= c; } else { u.vx *= -0.3; break; } }
      }
    }
    const vsteps = Math.max(1, Math.ceil(Math.abs(u.vy))), dy = u.vy / vsteps;
    for (let i = 0; i < vsteps; i++) {                       // vertical move
      const ny = u.y + dy;
      if (dy > 0 && (Physics.solid(u.x, ny + R) || Physics.solid(u.x - 5, ny + R - 1) || Physics.solid(u.x + 5, ny + R - 1))) {
        if (u.vy > 7 && !u.para) hurt(u, (u.vy - 7) * 5, null, null);
        u.vy = 0; u.para = false; break;
      }
      if (dy < 0 && Physics.solid(u.x, ny - R)) { u.vy = 0; break; }
      u.y = ny;
    }
    if (grounded(u)) { u.vx *= 0.8; if (Math.abs(u.vx) < 0.05) u.vx = 0; } else u.vx *= 0.99;
    if (u.x < -15 || u.x > W + 15 || u.y + R > waterY + 6) { splash(u.x, waterY); kill(u, "water"); }
  }

  function splash(x, y) {
    sfx("splash");
    for (let i = 0; i < 7; i++) particles.push({ x, y, vx: rnd(-1.5, 1.5), vy: rnd(-4, -1.5), life: 30, max: 30, emoji: "💧", size: 12, grav: 0.2 });
  }

  /* ---------------------------------------------------------------------
   * EXPLOSIONS
   * ------------------------------------------------------------------- */
  function explode(x, y, r, dmg, owner, wkey, opt = {}) {
    if (!opt.noCarve) Physics.carve(x, y, r);
    sfx("explosion", r);
    fx.push({ t: "ring", x, y, r, life: 18, max: 18 });
    particles.push({ x, y, vx: 0, vy: 0, life: 20, max: 20, emoji: "💥", size: Math.max(20, r * 1.3), grav: 0 });
    for (let i = 0; i < Math.min(10, r / 5); i++) particles.push({ x, y, vx: rnd(-3, 3), vy: rnd(-4, 0), life: 26, max: 26, color: pick(["#ffb300", "#ff6d00", "#5d4037"]), size: rnd(2, 5), grav: 0.15 });
    shake = Math.max(shake, Math.min(14, r / 6));
    units.forEach(u => {
      if (!u.alive) return;
      const dx = u.x - x, dy = u.y - y, d = Math.hypot(dx, dy);
      if (d > r + R) return;
      const f = 1 - d / (r + R), nd = d || 1;
      hurt(u, dmg * f, owner, wkey);
      const kb = (r * 0.13 + 3) * f + 1.5;
      u.vx += dx / nd * kb; u.vy += dy / nd * kb - 2 * f;
      u.walk = null;
    });
  }

  /* ---------------------------------------------------------------------
   * PROJECTILES
   * ------------------------------------------------------------------- */
  function spawnProj(x, y, vx, vy, def, owner, w, extra = {}) {
    const p = Object.assign({ x, y, vx, vy, d: def, owner, w, age: 0, dead: false, settled: false, fuse: def.fuse != null ? def.fuse + (def.jitter ? Math.floor(rnd(0, def.jitter)) : 0) : null, bounces: 0 }, extra);
    (def.mine ? mines : projectiles).push(p);
    return p;
  }

  function nearestEnemy(u, x, y) {
    let best = null, bd = 1e9;
    enemiesOf(u).forEach(e => { const d = Math.hypot(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } });
    return best;
  }

  function updateProj(p) {
    const d = p.d; p.age++;
    if (d.dive) return updateDive(p);
    // Safety net: a homing pinecone can orbit a target closer than its turning radius forever.
    if (p.age > (d.crush ? 600 : 420)) { if (d.crush) p.dead = true; else detonate(p); return; }
    if (p.settled) {
      if (!Physics.solid(p.x, p.y + 6)) p.settled = false;
      else { if (p.fuse != null && --p.fuse <= 0) detonate(p); return; }
    }
    if (d.homing) {
      const t = nearestEnemy(p.owner, p.x, p.y);
      let cur = Math.atan2(p.vy, p.vx || 0.01);
      if (t && p.age > 8) {
        let diff = Math.atan2(t.y - p.y, t.x - p.x) - cur; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        cur += clamp(diff, -0.07, 0.07);
      }
      if (Physics.solid(p.x + Math.cos(cur) * 12, p.y + Math.sin(cur) * 12)) cur -= 0.5 * (Math.cos(cur) >= 0 ? 1 : -1) + 0.2;   // steer up and over ridges
      const sp = Math.min(5, Math.hypot(p.vx, p.vy) + 0.08);
      p.vx = Math.cos(cur) * sp; p.vy = Math.sin(cur) * sp;
    } else {
      p.vy += GRAV * (d.grav != null ? d.grav : 1);
      p.vx += wind * (d.wind != null ? d.wind : 0) * 0.0035;
    }
    const sp = Math.hypot(p.vx, p.vy), steps = Math.max(1, Math.ceil(sp / 2)), sx = p.vx / steps, sy = p.vy / steps;
    for (let i = 0; i < steps; i++) {
      const nx = p.x + sx, ny = p.y + sy;
      if (d.impact || d.crush) {
        for (const u of units) {
          if (!u.alive || (u === p.owner && p.age < 12)) continue;
          if (Math.hypot(u.x - nx, u.y - ny) < R + 2) { p.x = nx; p.y = ny; if (d.crush) { crushHit(p); continue; } detonate(p); return; }
        }
      }
      if (Physics.solid(nx, ny)) {
        if (d.impact) { p.x = nx; p.y = ny; detonate(p); return; }
        const n = Physics.normal(p.x, p.y), dot = p.vx * n.x + p.vy * n.y, b = d.bounce != null ? d.bounce : 0.5;
        if (dot < 0) { p.vx = (p.vx - 2 * dot * n.x) * b; p.vy = (p.vy - 2 * dot * n.y) * b; p.vx *= 0.92; }
        p.bounces++;
        if (Math.hypot(p.vx, p.vy) > 1.8 && !d.crush) sfx("bounce");
        if (d.crush) { crushHit(p); if (p.bounces > 6) { p.dead = true; return; } }
        if (Math.hypot(p.vx, p.vy) < 1.2 && n.y < -0.5 && !d.crush) {
          p.vx = p.vy = 0; p.settled = true;
          if (d.settleFuse && p.fuse == null) { p.fuse = d.settleFuse; if (d.ray) sfx("choir"); }
        }
        break;
      } else { p.x = nx; p.y = ny; }
    }
    if (p.x < -80 || p.x > W + 80 || p.y > waterY + 8) { if (p.y > waterY) splash(p.x, waterY); p.dead = true; return; }
    if (p.fuse != null && !p.settled && --p.fuse <= 0) detonate(p);
  }

  function crushHit(p) {                                    // Garden Gnome: indestructible, carves + flattens what it lands on
    if (p.lastCrush && frame - p.lastCrush < 20) return;   // don't re-hit every pixel of the same landing
    p.lastCrush = frame;
    Physics.carve(p.x, p.y + 8, 30); shake = 8; sfx("bong");
    units.forEach(u => {
      if (!u.alive || Math.hypot(u.x - p.x, u.y - p.y) > 34) return;
      hurt(u, 40, p.owner, p.w); u.vx += Math.sign(p.vx || 1) * 4; u.vy += 5; u.walk = null;
    });
    particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 14, max: 14, emoji: "💥", size: 40, grav: 0 });
  }

  function detonate(p) {
    if (p.dead) return; p.dead = true;
    const d = p.d;
    explode(p.x, p.y, d.r, d.dmg, p.owner, p.w);
    if (d.ray) { fx.push({ t: "ray", x: p.x, y: p.y, life: 45, max: 45 }); chirp(2200); }
    if (d.gas) spawnGas(p.x, p.y, d.gas, p.owner, p.w);
    if (d.split) {
      const s = d.split;
      for (let i = 0; i < s.n; i++) {
        const a = s.full ? rnd(0, Math.PI * 2) : -Math.PI * (0.12 + 0.76 * Math.random()), sp = rnd(2.2, s.speed);
        spawnProj(p.x, p.y - 4, Math.cos(a) * sp, Math.sin(a) * sp, s.child, p.owner, p.w);
      }
    }
  }

  function updateMine(m) {
    m.age++;
    if (!Physics.solid(m.x, m.y + 8)) { m.vy += GRAV; m.y += m.vy; m.x += m.vx; m.vx *= 0.97; } else { m.vy = 0; m.vx *= 0.8; }
    if (m.y > waterY) { m.dead = true; return; }
    if (m.age > 60) for (const u of units) if (u.alive && u.side !== m.owner.side && Math.hypot(u.x - m.x, u.y - m.y) < 28) { detonate(m); return; }
  }

  /* ---- gas clouds (egg stink, skunk spray, bug spray) ---- */
  function spawnGas(x, y, g, owner, w) {
    for (let i = 0; i < g.n; i++) gases.push({ x: x + rnd(-10, 10), y: y + rnd(-10, 10), vx: g.vx != null ? g.vx + rnd(-0.4, 0.4) : rnd(-0.5, 0.5), vy: g.vy != null ? g.vy + rnd(-0.3, 0.3) : rnd(-0.7, -0.1), life: g.life, max: g.life, dmg: g.dmg, rad: g.rad || 16, wind: g.wind || 0.3, fall: !!g.fall, owner, w });
  }
  function updateGas(g) {
    if (g.fall) { if (!Physics.solid(g.x, g.y + g.rad * 0.5)) { g.vy = Math.min(g.vy + 0.05, 1.6); } else g.vy = 0; g.x += wind * 0.004; }
    else { g.vy -= 0.004; }
    g.vx += wind * g.wind * 0.004; g.x += g.vx; g.y += g.vy; g.vx *= 0.97;
    if (g.y > waterY) g.life = 0;
    g.life--;
    units.forEach(u => { if (u.alive && Math.hypot(u.x - g.x, u.y - g.y) < g.rad + R * 0.6) hurt(u, g.dmg, g.owner, g.w); });
  }

  /* ---- diggers: gophers tunnel down, ants march along the surface ---- */
  function updateDigger(d) {
    d.t++;
    if (d.type === "gopher") {
      if (!Physics.solid(d.x, d.y + 8) && !d.digging) { d.vy = (d.vy || 0) + GRAV; d.y += d.vy; }
      else { d.digging = true; d.y += 2.2; Physics.carve(d.x, d.y + 6, 9); }
      if (d.y > waterY - 15 || d.t > d.life) return popDigger(d, 40, 40);
    } else {                                                 // ant
      d.x += d.dir * 0.9;
      let g = 0; while (Physics.solid(d.x, d.y) && g++ < 6) d.y--;
      g = 0; while (!Physics.solid(d.x, d.y + 1) && g++ < 4) d.y++;
      if (d.x < 0 || d.x > W || d.y > waterY) { d.dead = true; return; }
      if (d.t > d.life) return popDigger(d, 28, 26);
    }
    for (const u of units) if (u.alive && u.side !== d.owner.side && Math.hypot(u.x - d.x, u.y - d.y) < 16) return popDigger(d, d.type === "gopher" ? 40 : 28, d.type === "gopher" ? 40 : 26);
  }
  function popDigger(d, r, dmg) { d.dead = true; explode(d.x, d.y, r, dmg, d.owner, d.w); }

  /* ---- dive bomb ---- */
  function updateDive(p) {
    const sx = p.vx, sy = p.vy;
    p.x += sx; p.y += sy; p.dist += Math.hypot(sx, sy);
    Physics.carve(p.x, p.y, 14);
    p.owner.x = p.x; p.owner.y = p.y;
    if (p.age % 2 === 0) particles.push({ x: p.x, y: p.y, vx: rnd(-1, 1), vy: rnd(-1, 1), life: 20, max: 20, emoji: pick(["🪶", "💨"]), size: 14, grav: 0.05 });
    const hit = units.some(u => u.alive && u !== p.owner && Math.hypot(u.x - p.x, u.y - p.y) < R + 8);
    if (hit || p.dist > 220 || p.x < 0 || p.x > W || p.y < 0 || p.y > waterY) {
      p.dead = true; p.owner.hidden = false;
      explode(p.x, p.y, 55, 60, p.owner, p.w);
      kill(p.owner, "sacrifice");
    }
  }

  /* ---------------------------------------------------------------------
   * TURN MANAGEMENT
   * ------------------------------------------------------------------- */
  /* ---- supply crates ---- */
  function dropCrate(type, x) {
    type = type || (Math.random() < 0.5 ? "health" : "weapon");
    crates.push({ x: x != null ? x : rnd(70, W - 70), y: -30, vy: 0, type, gift: type === "weapon" ? pick(CRATE_WEAPONS) : null, landed: false, chuted: true, age: 0, dead: false });
    banner("📦 SUPPLY CRATE INBOUND!"); sfx("crateDrop");
  }

  function updateCrate(c) {
    c.age++;
    if (Physics.solid(c.x, c.y + 12)) { c.landed = true; c.chuted = false; c.vy = 0; }
    else {
      c.landed = false;
      if (c.chuted) { c.vy = 1.1; c.x += wind * 0.012; }       // drifting down under a parachute
      else c.vy = Math.min(c.vy + GRAV, 6);                    // ground was blown away: plain fall
      c.y += c.vy;
    }
    if (c.y > waterY - 6) { splash(c.x, waterY); c.dead = true; return; }
    for (const u of units) if (u.alive && Math.hypot(u.x - c.x, u.y - c.y) < 22) { collectCrate(u, c); return; }
  }

  function collectCrate(u, c) {
    c.dead = true;
    if (c.type === "health") {
      const before = u.hp; u.hp = Math.min(MAX_HP, u.hp + CRATE_HEAL);
      banner(`${u.name} found a medkit! +${Math.round(u.hp - before)} HP`); sfx("heal");
      for (let i = 0; i < 6; i++) particles.push({ x: u.x + rnd(-10, 10), y: u.y - 10, vx: rnd(-0.5, 0.5), vy: rnd(-2, -0.8), life: 45, max: 45, emoji: "❤️", size: 14, grav: 0 });
    } else {
      u.gift = c.gift;
      banner(`${u.name} found the ${WEAPONS[c.gift].emoji} ${WEAPONS[c.gift].name}!`); sfx("pickup");
      for (let i = 0; i < 6; i++) particles.push({ x: u.x + rnd(-10, 10), y: u.y - 10, vx: rnd(-0.5, 0.5), vy: rnd(-2, -0.8), life: 45, max: 45, emoji: "⭐", size: 14, grav: 0 });
    }
  }

  /* AI "choice": if a landed crate is close and reachable, walk toward it before shooting. */
  function goForCrate(u) {
    let best = null, bd = 1e9;
    crates.forEach(c => {
      if (!c.landed) return;
      const dx = c.x - u.x, dy = c.y - u.y;
      if (Math.abs(dx) < 320 && dy > -70 && Math.abs(dx) + Math.abs(dy) < bd) { bd = Math.abs(dx) + Math.abs(dy); best = c; }
    });
    if (!best || Math.abs(best.x - u.x) < 14 || Math.random() > 0.85) return false;
    const frames = Math.min(150, Math.ceil(Math.abs(best.x - u.x) / 1.6) + 6);
    u.walk = { dir: Math.sign(best.x - u.x), left: frames, hop: true };
    turn.walked = true; turn.think = frames + 35;
    banner(`${u.name} makes a run for the crate!`);
    return true;
  }

  function nextTurn() {
    if (checkWin()) return;
    let side = lastSide === "squirrels" ? "birds" : "squirrels";
    if (!units.some(u => u.alive && u.side === side)) side = side === "squirrels" ? "birds" : "squirrels";
    const mine = units.filter(u => u.side === side);
    let u = null;
    for (let i = 0; i < mine.length; i++) { sideRot[side] = (sideRot[side] + 1) % mine.length; if (mine[sideRot[side]].alive) { u = mine[sideRot[side]]; break; } }
    if (!u) return;
    lastSide = side; turnCounter++;
    wind = clamp(wind + Math.round(rnd(-3, 3)), -10, 10);
    // Sudden death: after SUDDEN_DEATH_TURN the water rises every turn so a stalemate always ends.
    if (turnCounter > SUDDEN_DEATH_TURN) { waterY = Math.max(110, waterY - 22); if (turnCounter === SUDDEN_DEATH_TURN + 1) later(60, () => banner("SUDDEN DEATH - THE WATER IS RISING!")); }
    const foe = nearestEnemy(u, u.x, u.y);
    u.facing = foe ? Math.sign(foe.x - u.x) || 1 : 1;
    turn = { unit: u, controller: MANUAL_CONTROL && !u.isBot ? u.name.toLowerCase() : null, phase: "aim", frames: TURN_FRAMES, weapon: "acorn", forced: null, vote: null, aim: u.facing > 0 ? 45 : 135, power: 50, target: 50, moveLeft: MOVE_BUDGET, used: {}, acted: false, auto: false, armed: false, think: TURN_INTRO_FRAMES, settle: 0, guard: 0, wings: 90 };
    banner(`${ICON[u.side]} ${u.name}'s turn`); sfx("turn");
    if (u.gift) {                                              // crate weapon replaces this turn's pick (and skips the vote)
      turn.forced = u.gift; u.gift = null;
      banner(`${ICON[u.side]} ${u.name} - CRATE WEAPON: ${WEAPONS[turn.forced].emoji} ${WEAPONS[turn.forced].name.toUpperCase()}!`);
    } else if (turnCounter > 1 && Math.random() < VOTE_CHANCE) startVote();
  }

  /* ---- "type this weapon" chat vote: 3 random weapons, chat types !name, winner is fired this turn ---- */
  function startVote() {
    const keys = Object.keys(WEIGHTS).filter(k => !(ONCE_PER_MATCH.has(k) && usedOnce.has(k)));
    keys.sort(() => Math.random() - 0.5);
    turn.vote = { options: keys.slice(0, 3), votes: {}, frames: VOTE_SECONDS * 60 };
    turn.phase = "vote";
    banner(`TYPE A WEAPON FOR ${turn.unit.name.toUpperCase()}!`); sfx("voteOpen");
  }
  function tallyVote() {
    const v = turn.vote, counts = {};
    v.options.forEach(o => counts[o] = 0);
    Object.values(v.votes).forEach(k => counts[k]++);
    const top = Math.max(...Object.values(counts));
    const winner = pick(v.options.filter(o => counts[o] === top));   // ties (and no votes at all) are random
    turn.forced = winner; turn.phase = "aim"; turn.think = READ_DELAY_FRAMES + 30;   // let "CHAT PICKED ..." be read
    banner(`CHAT PICKED ${WEAPONS[winner].emoji} ${WEAPONS[winner].name.toUpperCase()}!`); sfx("voteDone");
  }

  function isBusy() {
    return projectiles.length || gases.length || diggers.length || timers.length || scripted.some(s => !s.done) ||
      units.some(u => u.alive && (u.flying > 0 || u.zip || u.hidden));
  }
  const settled = () => units.every(u => !u.alive || (grounded(u) && Math.abs(u.vx) < 0.15 && Math.abs(u.vy) < 0.6 && !u.walk));

  function checkWin() {
    if (finishing) return true;
    const sq = units.some(u => u.alive && u.side === "squirrels"), bd = units.some(u => u.alive && u.side === "birds");
    if (sq && bd) return false;
    finishing = true; turn = null;
    const winner = sq ? "squirrels" : bd ? "birds" : null;
    banner(winner ? `${winner.toUpperCase()} WIN!` : "MUTUAL DESTRUCTION!"); sfx("fanfare");
    units.forEach(u => { u.damageDealt = Math.round(u.damageDealt); });
    setTimeout(() => { running = false; if (api) api.endMatch({ winner, units }); }, 2800);
    return true;
  }

  function endTurn() {
    units.forEach(u => {
      if (!u.alive || !u.soggy) return;
      u.soggy--; u.hp = Math.max(1, u.hp - 5);
      particles.push({ x: u.x, y: u.y - 14, vx: 0, vy: -0.8, life: 40, max: 40, emoji: "💧", size: 14, grav: 0 });
    });
    if (checkWin()) return;
    turn.phase = "gap"; turn.gap = 50;
    if (turnCounter > 2 && crates.length < MAX_CRATES && Math.random() < CRATE_CHANCE) { dropCrate(); turn.gap = 130; }
  }

  /* ---------------------------------------------------------------------
   * FRAME UPDATE
   * ------------------------------------------------------------------- */
  function update() {
    frame++;
    for (let i = timers.length - 1; i >= 0; i--) { if (--timers[i].t <= 0) { const f = timers[i].fn; timers.splice(i, 1); f(); } }
    units.forEach(updateUnit);
    projectiles.forEach(updateProj); projectiles = projectiles.filter(p => !p.dead);
    mines.forEach(updateMine); mines = mines.filter(m => !m.dead);
    gases.forEach(updateGas); gases = gases.filter(g => g.life > 0);
    diggers.forEach(updateDigger); diggers = diggers.filter(d => !d.dead);
    crates.forEach(updateCrate); crates = crates.filter(c => !c.dead);
    scripted.forEach(s => { if (!s.done) s.update(); }); scripted = scripted.filter(s => !s.done);
    particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += p.grav || 0; p.life--; }); particles = particles.filter(p => p.life > 0);
    fx.forEach(f => f.life--); fx = fx.filter(f => f.life > 0);
    clouds.forEach(c => { c.x += c.v; if (c.x > W + 60) c.x = -60; });
    if (finishing || !turn) return;
    if (checkWin()) return;

    if (turn.phase === "vote") {
      if (!turn.unit.alive) turn.phase = "resolve";
      else {
        if (turn.vote.frames <= 180 && turn.vote.frames % 60 === 0) sfx("tick");     // last 3 seconds tick down
        if (--turn.vote.frames <= 0) tallyVote();
      }
    } else if (turn.phase === "aim") {
      if (!turn.unit.alive) turn.phase = "resolve";
      else {
        if (MANUAL_CONTROL && --turn.frames <= 0 && !turn.auto && !turn.unit.isBot) { turn.auto = true; turn.think = 45; banner("AFK! A bot takes over..."); }
        if (!MANUAL_CONTROL || turn.unit.isBot || turn.auto) { if (--turn.think <= 0) botShoot(); }
      }
    } else if (turn.phase === "resolve") {
      turn.guard++;
      if (!isBusy() && settled()) { if (++turn.settle > 30) endTurn(); } else turn.settle = 0;
      if (turn.guard > 60 * 14) endTurn();                    // safety net so a stuck entity can't stall the stream
    } else if (turn.phase === "gap") {
      if (--turn.gap <= 0) nextTurn();
    }
  }

  /* ---------------------------------------------------------------------
   * FIRING
   * ------------------------------------------------------------------- */
  function fire() {
    if (!turn || turn.phase !== "aim") return;
    const u = turn.unit, wd = WEAPONS[turn.weapon];
    if (wd.kind === "util" && turn.used[turn.weapon] && turn.weapon !== "wings") { banner(`${wd.name} already used`); return; }
    const ends = execute(u, turn.weapon, wd);
    turn.acted = true;
    if (wd.kind === "util") turn.used[turn.weapon] = true;
    if (ends) { turn.phase = "resolve"; turn.settle = 0; turn.guard = 0; }
  }

  function execute(u, key, wd) {
    const a = turn.aim * Math.PI / 180, dx = Math.cos(a), dy = -Math.sin(a);
    u.facing = dx >= 0 ? 1 : -1; u.walk = null;
    const spd = turn.power * 0.16, mx = u.x + dx * (R + 6), my = u.y + dy * (R + 6) - 2;
    const tx = turn.target / 100 * W;
    switch (wd.kind) {
      case "proj": sfx("launch"); spawnProj(mx, my, dx * spd, dy * spd, wd.p, u, key); return true;
      case "drop": sfx("plop"); spawnProj(u.x, u.y + R - 6, 0, 0, wd.p, u, key); return true;
      case "mine": sfx("plop"); spawnProj(u.x + u.facing * (R + 8), u.y, u.facing * 1.5, -1, wd.p, u, key); banner("Sap trap set!"); return true;
      case "spit":
        [-2.5, 2.5].forEach((off, i) => later(i * 8, () => { sfx("spit"); const aa = (turn.aim + off) * Math.PI / 180; spawnProj(mx, my, Math.cos(aa) * spd * 1.3, -Math.sin(aa) * spd * 1.3, wd.p, u, key); }));
        return true;
      case "peck":
        for (let i = 0; i < 12; i++) later(i * 4, () => {
          if (!u.alive) return;
          sfx("peck");
          const aa = (turn.aim + rnd(-4, 4)) * Math.PI / 180;
          spawnProj(u.x + Math.cos(aa) * (R + 6), u.y - Math.sin(aa) * (R + 6), Math.cos(aa) * 14, -Math.sin(aa) * 14, wd.p, u, key);
          u.vx -= dx * 0.9; u.vy -= 0.2;                     // severe recoil
          particles.push({ x: mx, y: my, vx: rnd(-1, 1), vy: rnd(-1, 1), life: 10, max: 10, emoji: "✨", size: 10, grav: 0 });
        });
        return true;
      case "melee": return doMelee(u, key, wd, dx, dy);
      case "poke": {
        let hit = false;
        enemiesOf(u).concat(units.filter(o => o.alive && o !== u && o.side === u.side)).forEach(t => {
          if (Math.hypot(t.x - u.x, t.y - u.y) < 42) { hit = true; t.vx += dx * 5; t.vy -= 2; t.lastHit = { by: u, w: key, t: frame }; t.walk = null; }
        });
        fx.push({ t: "sprite", emoji: "👉", x: u.x + dx * 26, y: u.y + dy * 26, vx: dx, vy: dy, life: 14, max: 14 });
        if (!hit) banner("Poke... nothing there.");
        return true;
      }
      case "dive": {
        sfx("dive");
        u.hidden = true;
        spawnProj(u.x, u.y, dx * 9, dy * 9, { dive: true }, u, key, { dist: 0 });
        banner("KAMIKAZE!");
        return true;
      }
      case "spray":
        sfx("hiss");
        for (let i = 0; i < 45; i++) later(i, () => { if (u.alive) spawnGas(mx, my, { n: 1, vx: dx * spd * 0.45, vy: dy * spd * 0.45, life: 45, dmg: 0.55, rad: 10, wind: 2.2 }, u, key); });
        return true;
      case "air": return doAir(u, key, tx);
      case "dig":                                             // ants
        for (let i = 0; i < 8; i++) later(i * 6, () => {
          const x = u.x + u.facing * (18 + i * 2), sy = Physics.surfaceY(x, Math.max(0, u.y - 30));
          diggers.push({ type: "ant", x, y: sy != null ? sy - 2 : u.y, dir: u.facing, t: 0, life: Math.floor(rnd(50, 170)), owner: u, w: key });
        });
        return true;
      case "gnaw":
        for (let i = 0; i < 30; i++) later(i, () => {
          const px = u.x + dx * (14 + i * 3), py = u.y + dy * (14 + i * 3);
          Physics.carve(px, py, 13);
          enemiesOf(u).forEach(e => { if (Math.hypot(e.x - px, e.y - py) < 20) hurt(e, 0.7, u, key); });
        });
        banner("NOM NOM NOM");
        return true;
      case "special": return doSpecial(u, key, dx, dy);
      case "util": return doUtil(u, key, dx, dy, tx);
    }
    return true;
  }

  function doMelee(u, key, wd, dx, dy) {
    const reach = wd.mode === "halve" ? 40 : 50;
    const targets = units.filter(t => t.alive && t !== u && Math.hypot(t.x - u.x, t.y - u.y) < reach && (t.x - u.x) * u.facing > -6);
    fx.push({ t: "sprite", emoji: wd.emoji, x: u.x + u.facing * 22, y: u.y - 4, vx: u.facing * 1.5, vy: 0, life: 16, max: 16 });
    sfx("whack");
    if (!targets.length) { banner("WHIFF!"); return true; }
    if (wd.mode === "halve") {
      const t = targets.sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
      hurt(t, Math.max(1, t.hp / 2), u, key); banner("CHOP!");
    } else {
      targets.forEach(t => { hurt(t, 15, u, key); t.vx += dx * 11; t.vy += dy * 11 - 2; t.walk = null; });
      banner("SWAT!");
    }
    shake = 6;
    return true;
  }

  function doAir(u, key, tx) {
    if (key === "crows") {
      [0, 14, 30].forEach(d => later(d, () => sfx("caw")));
      for (let i = 0; i < 3; i++) fx.push({ t: "sprite", emoji: "🐦‍⬛", x: -40 - i * 40, y: 30 + i * 18, vx: (tx + 200) / 70, vy: 0, life: 110, max: 110 });
      for (let i = 0; i < 8; i++) later(20 + i * 8, () => spawnProj(tx + rnd(-90, 90), -20, rnd(-0.3, 0.3), 2, { emoji: "💩", size: 0.6, r: 28, dmg: 25, impact: true, grav: 0.6 }, u, key));
    } else if (key === "skunk") {
      sfx("hiss");
      for (let i = 0; i < 12; i++) later(i * 5, () => spawnGas(tx - 110 + i * 20, -10, { n: 2, vx: 0, vy: 1, life: 240, dmg: 0.35, rad: 20, fall: true, wind: 0.3 }, u, key));
      banner("PEE-YEW!");
    } else if (key === "gophers") {
      [-45, 0, 45].forEach((o, i) => later(i * 10, () => diggers.push({ type: "gopher", x: tx + o, y: -10, vy: 0, t: 0, life: 75, owner: u, w: key })));
    } else if (key === "gnome") {
      spawnProj(tx, -40, u.facing * 2.4, 0, { emoji: "🧙", size: 1.7, bounce: 0.6, crush: true, grav: 1, r: 0, dmg: 0 }, u, key);
      banner("GNOME BOMB!");
    } else if (key === "homeowner") {
      banner("GET OFF MY LAWN!");
      const b = { x: -80, y: 50, t: 0, phase: "walk", done: false,
        update() {
          this.t++;
          if (this.phase === "walk") { this.x += (tx + 80) / 150; this.y = 50 + Math.sin(this.t * 0.25) * 6; if (this.t >= 150) this.phase = "stomp"; }
          else { this.y += 14; const sy = Physics.surfaceY(tx, 0); if (this.y >= (sy != null ? sy : H) - 10) { sfx("stomp"); explode(tx, this.y, 85, 75, u, key); this.done = true; } }
        },
        draw() { emojiAt("🥾", this.x, this.y, 60, false); } };
      scripted.push(b);
    }
    return true;
  }

  function doSpecial(u, key, dx) {
    if (key === "mower") {
      banner("MOWER MAYHEM!"); shake = 10; sfx("mower");
      for (let i = 0; i < 26; i++) later(i * 7, () => spawnProj(rnd(20, W - 20), -20, rnd(-0.6, 0.6), 3, { emoji: pick(["🌿", "⚙️"]), size: 0.7, r: 30, dmg: 20, impact: true, grav: 0.5 }, u, key));
    } else if (key === "blower") {
      const dir = dx >= 0 ? 1 : -1; shake = 12; banner("WHOOOSH!"); sfx("whoosh");
      wind = clamp(wind + dir * 6, -10, 10);
      units.forEach(t => { if (t.alive) { t.vx += dir * rnd(3, 6); t.vy -= rnd(2, 4); t.walk = null; t.lastHit = t !== u ? { by: u, w: key, t: frame } : t.lastHit; } });
      mines.forEach(m => { m.vx += dir * 4; m.vy -= 3; });
      for (let i = 0; i < 16; i++) particles.push({ x: rnd(0, W), y: rnd(0, H * 0.7), vx: dir * rnd(6, 10), vy: rnd(-1, 1), life: 40, max: 40, emoji: "🍃", size: 16, grav: 0 });
    } else if (key === "sprinklers") {
      waterY = Math.max(H - 220, waterY - 55);
      units.forEach(t => { if (t.alive) t.soggy = 3; });
      banner("SPRINKLERS ON! SOGGY!"); sfx("sprinkle");
      for (let i = 0; i < 30; i++) particles.push({ x: rnd(0, W), y: -10, vx: 0, vy: rnd(3, 6), life: 90, max: 90, emoji: "💧", size: 12, grav: 0 });
    } else if (key === "playdead") {
      banner(`${u.name} plays dead...`);
    }
    return true;
  }

  function doUtil(u, key, dx, dy, tx) {
    if (key === "stick") {
      const cx = u.x + dx * 42, cy = u.y + dy * 42, px = -dy, py = dx;          // bar is perpendicular to the aim
      Physics.addBar(cx - px * 32, cy - py * 32, cx + px * 32, cy + py * 32, 8);
      banner("Bridge built!");
    } else if (key === "yoyo") {
      const hit = Physics.raycast(u.x, u.y - 4, turn.aim, 230);
      if (!hit) { banner("No anchor in range!"); delete turn.used[key]; return false; }
      u.zip = { ax: hit.x, ay: hit.y, frames: 40 };
      banner("YO-YO ZIP!");
    } else if (key === "dandelion") {
      u.para = true; banner("Dandelion parachute ready!");
    } else if (key === "birdhouse") {
      const sy = Physics.surfaceY(tx, 0);
      if (sy == null || tx < 20 || tx > W - 20) { banner("No open ground there!"); delete turn.used[key]; return false; }
      for (let i = 0; i < 8; i++) particles.push({ x: u.x, y: u.y, vx: rnd(-2, 2), vy: rnd(-2, 2), life: 25, max: 25, emoji: "✨", size: 14, grav: 0 });
      u.x = tx; u.y = sy - R - 2; u.vx = u.vy = 0; u.walk = null;
      for (let i = 0; i < 8; i++) particles.push({ x: u.x, y: u.y, vx: rnd(-2, 2), vy: rnd(-2, 2), life: 25, max: 25, emoji: "✨", size: 14, grav: 0 });
      banner("POOF!");
    } else if (key === "wings") {
      if (turn.wings <= 0) { banner("Out of stamina!"); return false; }
      const use = Math.min(30, turn.wings); turn.wings -= use;
      u.flying = use; u.fvx = dx * 3.2; u.fvy = dy * 3.2; u.walk = null;
      banner(`Wings! stamina ${Math.round(turn.wings / 0.9)}%`);
    } else if (key === "select") {
      banner("Type !select [name] to switch critter");
    }
    return false;
  }

  /* ---------------------------------------------------------------------
   * BOT AI
   * ------------------------------------------------------------------- */
  function simulateShot(u, aimDeg, power) {                  // ballistic preview with acorn physics (no bounces)
    const a = aimDeg * Math.PI / 180, spd = power * 0.16;
    let x = u.x + Math.cos(a) * (R + 6), y = u.y - Math.sin(a) * (R + 6) - 2, vx = Math.cos(a) * spd, vy = -Math.sin(a) * spd;
    for (let i = 0; i < 500; i++) {
      vy += GRAV; vx += wind * 0.0035;
      for (let s = 0; s < 2; s++) {
        x += vx / 2; y += vy / 2;
        if (Physics.solid(x, y) || y > waterY || x < -20 || x > W + 20) return { x, y };
      }
    }
    return { x, y };
  }

  function botShoot() {
    if (!turn || turn.phase !== "aim") return;
    const u = turn.unit, foes = enemiesOf(u);
    if (!foes.length) { turn.phase = "resolve"; return; }
    if (turn.armed) { turn.think = 9999; fire(); return; }   // 2nd call: the announced shot goes off
    if (!turn.walked && goForCrate(u)) return;               // detour to grab a crate, then plan the shot from there
    foes.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y));
    const tgt = Math.random() < 0.65 ? foes[0] : pick(foes);
    const dist = Math.hypot(tgt.x - u.x, tgt.y - u.y), close = dist < 42;

    let key = turn.forced;                                     // chat's pick wins over the AI's own choice
    if (!key) {
      if (close && Math.random() < 0.7) key = pick(["trowel", "newspaper", "poke"]);
      else {
        const pool = Object.entries(WEIGHTS).filter(([k]) => !(ONCE_PER_MATCH.has(k) && usedOnce.has(k)));
        let r = Math.random() * pool.reduce((s, [, w]) => s + w, 0);
        key = pool[pool.length - 1][0];
        for (const [k, w] of pool) { r -= w; if (r <= 0) { key = k; break; } }
        if ((key === "firecracker" || key === "dive" && dist > 230 || key === "gnaw" && dist > 100) && !close) key = "acorn";   // point-blank-only weapons
      }
    }
    if (ONCE_PER_MATCH.has(key)) usedOnce.add(key);
    turn.weapon = key;
    planShot(u, key, tgt);
    turn.armed = true;
    if (turn.forced) { turn.think = 9999; fire(); return; }    // chat's pick was already announced and waited on
    banner(`${u.name} uses ${WEAPONS[key].emoji} ${WEAPONS[key].name}!`);
    turn.think = READ_DELAY_FRAMES;                            // show the weapon name, THEN fire
  }

  /* Fill in aim / power / target for whatever weapon was picked (by the AI or by chat). */
  function planShot(u, key, tgt) {
    const kind = WEAPONS[key].kind, dir = tgt.x >= u.x ? 1 : -1;
    const ang = Math.atan2(u.y - tgt.y, tgt.x - u.x) * 180 / Math.PI;      // -180..180, up is positive
    turn.target = clamp(Math.round(tgt.x / W * 100 + rnd(-4, 4)), 0, 100);
    turn.power = 60;
    switch (kind) {
      case "melee": case "poke": case "dig": turn.aim = dir > 0 ? 15 : 165; return;
      case "dive": case "gnaw": case "peck": case "spray": turn.aim = Math.round(ang + rnd(-8, 8)); return;
      case "air": case "drop": case "mine": turn.aim = dir > 0 ? 20 : 160; return;
      case "special": turn.aim = dir > 0 ? 30 : 150; return;
    }
    // Ballistic weapons: brute-force the (angle, power) that lands nearest the target, then add
    // +/- error so shots aren't perfect.
    let best = null, bd = 1e9;
    for (let a = 8; a <= 172; a += 4) for (let pw = 20; pw <= 100; pw += 4) {
      const l = simulateShot(u, a, pw), d = Math.hypot(l.x - tgt.x, l.y - tgt.y);
      if (d < bd) { bd = d; best = { a, pw }; }
    }
    best = best || { a: 45, pw: 60 };
    turn.aim = clamp(Math.round(best.a + rnd(-5, 5)), 0, 180);
    turn.power = clamp(Math.round(best.pw * (1 + rnd(-0.15, 0.15))), 1, 100);
  }

  /* ---------------------------------------------------------------------
   * CHAT COMMANDS (twitch.js routes !weapon !aim !power !fire !target !move !jump !select here)
   * ------------------------------------------------------------------- */
  function handleCommand(user, cmd, args) {
    if (turn && turn.phase === "vote") {                     // "!crows" or "!vote crows" during a weapon vote
      const word = (cmd === "!vote" ? (args[0] || "") : cmd.slice(1)).toLowerCase(), key = ALIAS[word] || word;
      if (turn.vote.options.includes(key)) turn.vote.votes[user.toLowerCase()] = key;
      return;
    }
    if (!MANUAL_CONTROL) return;
    if (!turn || turn.phase !== "aim" || !turn.controller) return;
    if (user.toLowerCase() !== turn.controller) return;      // only the active human may act
    const u = turn.unit, n = parseInt(args[0], 10);
    switch (cmd) {
      case "!weapon": {
        const raw = (args[0] || "").toLowerCase(), key = ALIAS[raw] || raw;
        if (!WEAPONS[key]) { banner(`Unknown weapon "${raw}"`); return; }
        turn.weapon = key; banner(`${WEAPONS[key].emoji} ${WEAPONS[key].name}`); break;
      }
      case "!aim": if (!isNaN(n)) { turn.aim = clamp(n, 0, 180); u.facing = turn.aim < 90 ? 1 : -1; } break;
      case "!power": if (!isNaN(n)) turn.power = clamp(n, 1, 100); break;
      case "!target": if (!isNaN(n)) turn.target = clamp(n, 0, 100); break;
      case "!move": {
        const dir = (args[0] || "").startsWith("l") ? -1 : (args[0] || "").startsWith("r") ? 1 : 0;
        if (!dir) return;
        const steps = clamp(parseInt(args[1], 10) || 20, 1, 60), frames = Math.min(steps, turn.moveLeft);
        if (frames <= 0) { banner("No movement left!"); return; }
        turn.moveLeft -= frames; u.walk = { dir, left: frames }; break;
      }
      case "!jump": if (grounded(u)) { u.vy = -6.5; u.vx = u.facing * 2.5; } break;
      case "!select": {
        if (turn.acted) { banner("Too late to switch!"); return; }
        const want = (args[0] || "").toLowerCase(), t = units.find(o => o.alive && o.side === u.side && o.name.toLowerCase() === want);
        if (t) { turn.unit = t; t.facing = u.facing; banner(`Now controlling ${t.name}`); } break;
      }
      case "!fire": fire(); break;
    }
  }

  /* ---------------------------------------------------------------------
   * RENDERING
   * ------------------------------------------------------------------- */
  function emojiAt(e, x, y, size, flip) {
    ctx.font = `${size}px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (flip) { ctx.save(); ctx.translate(x, y); ctx.scale(-1, 1); ctx.fillText(e, 0, 0); ctx.restore(); } else ctx.fillText(e, x, y);
  }

  function draw() {
    ctx.save();
    if (shake > 0) { ctx.translate(rnd(-shake, shake), rnd(-shake, shake)); shake *= 0.9; if (shake < 0.3) shake = 0; }
    ctx.fillStyle = skyGrad; ctx.fillRect(-20, -20, W + 40, H + 40);
    if (bg && bg.complete && bg.naturalWidth) {                // cover-scale the 800x600 backdrop onto 960x540
      const s = Math.max(W / bg.naturalWidth, H / bg.naturalHeight), bw = bg.naturalWidth * s, bh = bg.naturalHeight * s;
      ctx.drawImage(bg, (W - bw) / 2, (H - bh) / 2, bw, bh);
    } else clouds.forEach(c => emojiAt("☁️", c.x, c.y, c.s * 1.6, false));
    ctx.drawImage(Physics.canvas(), 0, 0);

    mines.forEach(m => emojiAt("🍯", m.x, m.y - 2, 16, false));
    crates.forEach(c => {
      if (c.landed) { ctx.fillStyle = `rgba(255,235,120,${0.22 + 0.12 * Math.sin(frame * 0.15)})`; ctx.beginPath(); ctx.arc(c.x, c.y, 20, 0, 7); ctx.fill(); }
      emojiAt("📦", c.x, c.y, 24, false);
      if (c.chuted) emojiAt("🪂", c.x, c.y - 24, 30, false);
      emojiAt(c.type === "health" ? "❤️" : "⭐", c.x + 10, c.y - 12, 11, false);   // peek at what's inside
    });
    projectiles.forEach(p => {
      const d = p.d; if (d.dive) return;
      if (d.glow) { ctx.fillStyle = "rgba(255,230,120,.35)"; ctx.beginPath(); ctx.arc(p.x, p.y, 18 + Math.sin(frame * 0.2) * 3, 0, 7); ctx.fill(); }
      if (d.emoji === "•") { ctx.fillStyle = "#3e2723"; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill(); }
      else emojiAt(d.emoji, p.x, p.y, 22 * (d.size || 1), false);
      if (p.fuse != null && p.settled && d.settleFuse) { ctx.fillStyle = "#fff"; ctx.font = "10px 'Press Start 2P'"; ctx.fillText(Math.ceil(p.fuse / 60), p.x, p.y - 20); }
    });
    gases.forEach(g => { ctx.fillStyle = `rgba(120,200,60,${0.28 * g.life / g.max})`; ctx.beginPath(); ctx.arc(g.x, g.y, g.rad, 0, 7); ctx.fill(); });
    diggers.forEach(d => emojiAt(d.type === "gopher" ? "🦫" : "🐜", d.x, d.y - 4, 18, d.dir < 0));
    scripted.forEach(s => { if (!s.done && s.draw) s.draw(); });

    units.forEach(drawUnit);
    fx.forEach(drawFx);
    particles.forEach(p => {
      ctx.globalAlpha = Math.min(1, p.life / (p.max * 0.5));
      if (p.emoji) emojiAt(p.emoji, p.x, p.y, p.size, false); else { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size); }
      ctx.globalAlpha = 1;
    });
    // water (drawn last so anything below the line looks submerged)
    ctx.fillStyle = "rgba(30,110,200,.55)"; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, waterY + Math.sin(x * 0.05 + frame * 0.06) * 3);
    ctx.lineTo(W, H); ctx.fill();
    if (turn && turn.phase === "aim" && turn.unit.alive) drawAim();
    ctx.restore();
  }

  function drawUnit(u) {
    if (!u.alive || u.hidden) return;
    const flip = EMOJI_FACES_LEFT ? u.facing > 0 : u.facing < 0;
    emojiAt(ICON[u.side], u.x, u.y - 1, 26, flip);
    if (u.para) emojiAt("🌼", u.x, u.y - 24, 18, false);
    if (u.soggy) emojiAt("💧", u.x + 14, u.y - 14, 12, false);
    if (u.flying > 0) emojiAt("🪽", u.x - u.facing * 12, u.y - 4, 16, false);
    ctx.font = "8px 'Press Start 2P', monospace"; ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = "#000";
    ctx.strokeText(u.name.slice(0, 12), u.x, u.y - 30); ctx.fillStyle = COLOR[u.side]; ctx.fillText(u.name.slice(0, 12), u.x, u.y - 30);
    ctx.fillStyle = "#000"; ctx.fillRect(u.x - 16, u.y - 24, 32, 5);
    ctx.fillStyle = u.hp > 100 ? "#40c4ff" : u.hp > 50 ? "#4caf50" : u.hp > 25 ? "#ffc107" : "#f44336";   // cyan = overhealed by a crate
    ctx.fillRect(u.x - 15, u.y - 23, 30 * clamp(u.hp / 100, 0, 1), 3);
    if (turn && turn.unit === u && turn.phase === "aim") emojiAt("🔻", u.x, u.y - 46 + Math.sin(frame * 0.2) * 3, 16, false);
  }

  function drawFx(f) {
    const t = 1 - f.life / f.max;
    if (f.t === "ring") { ctx.strokeStyle = `rgba(255,170,0,${1 - t})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.4 + t * 0.7), 0, 7); ctx.stroke(); }
    else if (f.t === "ray") { const g = ctx.createLinearGradient(0, 0, 0, f.y); g.addColorStop(0, `rgba(255,240,150,${0.9 * (1 - t)})`); g.addColorStop(1, `rgba(255,255,255,${0.5 * (1 - t)})`); ctx.fillStyle = g; ctx.fillRect(f.x - 18, 0, 36, f.y); }
    else if (f.t === "sprite") { f.x += f.vx; f.y += f.vy; emojiAt(f.emoji, f.x, f.y, 26, false); }
  }

  function drawAim() {
    const u = turn.unit, a = turn.aim * Math.PI / 180, len = 34 + turn.power * 0.5;
    ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(u.x, u.y); ctx.lineTo(u.x + Math.cos(a) * len, u.y - Math.sin(a) * len); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#ff5252"; ctx.beginPath(); ctx.arc(u.x + Math.cos(a) * len, u.y - Math.sin(a) * len, 4, 0, 7); ctx.fill();
    if (WEAPONS[turn.weapon].needsTarget) { const tx = turn.target / 100 * W; ctx.strokeStyle = "#ffeb3b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, H); ctx.stroke(); emojiAt("🎯", tx, 40, 22, false); }
  }

  function hud() {
    const $ = id => document.getElementById(id);
    const box = $("weaponPoll");
    if (!turn || turn.phase !== "vote") box.classList.remove("show");
    if (!turn) return;
    if (turn.phase === "vote") {
      const v = turn.vote, counts = {};
      v.options.forEach(o => counts[o] = 0);
      Object.values(v.votes).forEach(k => counts[k]++);
      box.classList.add("show");
      $("weaponPollFor").textContent = `for ${turn.unit.name}`;
      $("weaponPollTimer").textContent = Math.ceil(v.frames / 60);
      $("weaponPollList").innerHTML = v.options.map(o => `<li><span>${WEAPONS[o].emoji} <b>!${o}</b></span><span class="n">${counts[o]}</span></li>`).join("");
    }
    const w = WEAPONS[turn.forced && turn.phase !== "vote" ? turn.weapon : turn.weapon];
    $("hudTurn").textContent = `${ICON[turn.unit.side]} ${turn.unit.name}${turn.auto ? " (AFK bot)" : ""}`;
    $("hudTimer").textContent = turn.phase === "aim" ? Math.max(0, Math.ceil(turn.frames / 60)) : "--";
    $("hudWind").textContent = `WIND ${wind === 0 ? "-" : wind < 0 ? "◀".repeat(Math.ceil(-wind / 3)) : "▶".repeat(Math.ceil(wind / 3))} ${Math.abs(wind)}`;
    $("hudWeapon").textContent = `${w.emoji} ${w.name.toUpperCase()}`;
    $("hudAim").textContent = w.needsTarget ? `TARGET: ${turn.target}` : `AIM: ${turn.aim}`;
    $("hudPower").textContent = `POWER: ${turn.power}`;
  }

  return {
    start, handleCommand,
    getActiveUnit: () => (turn && turn.phase === "aim" ? turn.unit : null),
    getPoll: () => (turn && turn.phase === "vote" ? turn.vote : null),
    dropCrate,
    getTurnId: () => turnCounter,
    WEAPONS,                                                 // exposed for tests / future UI
    _debug: { fire: (key, o = {}) => { turn.weapon = key; Object.assign(turn, o); fire(); }, get turn() { return turn; }, get units() { return units; }, get crates() { return crates; }, isBusy, endTurn }
  };
})();
window.Game = Game;
