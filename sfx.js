/* =========================================================================
 * NUT vs. BEAK - sfx.js
 * Every sound is synthesized live with the Web Audio API (oscillators + filtered
 * noise), so there are no audio files to load or license.
 *
 *   Sfx.play("explosion", 40)     play a named sound (optional argument, e.g. blast radius)
 *   Sfx.toggle() / Sfx.setMuted() mute control; also ?mute=1 in the URL
 *
 * Browsers only allow audio after a user gesture; OBS browser sources allow it
 * automatically. Sfx quietly resumes the AudioContext on the first click/key press.
 * Loud/rapid sounds are rate-limited so a mower shower doesn't become a wall of noise.
 * ========================================================================= */
const Sfx = (() => {
  const MASTER_VOLUME = 0.5;
  let ac = null, master = null, noiseBuf = null, active = 0, errors = 0;
  const last = {};
  let muted = false;
  try { muted = new URLSearchParams(location.search).has("mute") || localStorage.getItem("nvb_mute") === "1"; } catch (e) {}

  function ctx() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = MASTER_VOLUME; master.connect(ac.destination);
      } catch (e) { return null; }
    }
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  }
  ["click", "keydown"].forEach(ev => window.addEventListener(ev, () => { if (!muted) ctx(); }, { once: false, passive: true }));

  /* --- building blocks --- */
  function tone({ f = 440, f2 = null, dur = 0.2, type = "sine", vol = 0.25, delay = 0, attack = 0.005 }) {
    const a = ctx(); if (!a) return;
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
    active++; o.onended = () => active--;
  }
  function noise({ dur = 0.3, vol = 0.25, type = "lowpass", f = 1000, f2 = null, q = 1, delay = 0 }) {
    const a = ctx(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + delay, src = a.createBufferSource(), flt = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; src.loop = true;
    flt.type = type; flt.Q.value = q; flt.frequency.setValueAtTime(f, t);
    if (f2) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(master); src.start(t); src.stop(t + dur + 0.03);
    active++; src.onended = () => active--;
  }
  const note = (f, delay, dur = 0.18, type = "triangle", vol = 0.22) => tone({ f, dur, type, vol, delay });

  /* --- the sounds (arg is optional; explosion takes the blast radius) --- */
  const SOUNDS = {
    explosion: (r = 40) => {
      const s = Math.min(1, r / 80);
      noise({ dur: 0.25 + s * 0.6, vol: 0.28 + s * 0.3, type: "lowpass", f: 1600, f2: 90 });
      tone({ f: 130, f2: 35, dur: 0.3 + s * 0.4, type: "sine", vol: 0.35 + s * 0.3 });
    },
    launch:   () => noise({ dur: 0.28, vol: 0.16, type: "bandpass", f: 500, f2: 2200, q: 2 }),
    spit:     () => tone({ f: 900, f2: 500, dur: 0.08, type: "square", vol: 0.1 }),
    peck:     () => { tone({ f: 1200, f2: 700, dur: 0.04, type: "square", vol: 0.09 }); },
    bounce:   () => tone({ f: 330, f2: 210, dur: 0.09, type: "sine", vol: 0.18 }),
    hurt:     () => tone({ f: 260, f2: 90, dur: 0.14, type: "square", vol: 0.14 }),
    whack:    () => { noise({ dur: 0.12, vol: 0.25, type: "lowpass", f: 900, f2: 200 }); tone({ f: 160, f2: 70, dur: 0.12, type: "sine", vol: 0.3 }); },
    death:    () => { tone({ f: 420, f2: 60, dur: 0.55, type: "sawtooth", vol: 0.16 }); note(196, 0.5, 0.35, "sine", 0.14); },
    splash:   () => noise({ dur: 0.35, vol: 0.22, type: "highpass", f: 900, f2: 3000 }),
    turn:     () => { note(660, 0, 0.12, "triangle", 0.16); note(880, 0.09, 0.16, "triangle", 0.16); },
    horn:     () => { tone({ f: 220, dur: 0.5, type: "sawtooth", vol: 0.15 }); tone({ f: 330, dur: 0.5, type: "sawtooth", vol: 0.12, delay: 0.22 }); },
    voteOpen: () => { note(988, 0, 0.16, "sine", 0.2); note(1319, 0.13, 0.28, "sine", 0.2); },
    tick:     () => tone({ f: 1100, dur: 0.05, type: "square", vol: 0.1 }),
    voteDone: () => { note(523, 0, 0.12); note(659, 0.1, 0.12); note(784, 0.2, 0.12); note(1047, 0.3, 0.3); },
    crateDrop:() => { tone({ f: 1400, f2: 500, dur: 0.7, type: "sine", vol: 0.1 }); noise({ dur: 0.5, vol: 0.05, type: "bandpass", f: 3000, q: 4 }); },
    pickup:   () => { note(880, 0, 0.1, "sine", 0.2); note(1175, 0.08, 0.1, "sine", 0.2); note(1568, 0.16, 0.25, "sine", 0.2); },
    heal:     () => { note(523, 0, 0.14, "sine", 0.2); note(784, 0.12, 0.3, "sine", 0.2); },
    choir:    () => { [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: 1.6, type: "sine", vol: 0.09, attack: 0.5, delay: i * 0.05 })); },
    chirp:    (f = 1800) => tone({ f, f2: f * 1.7, dur: 0.3, type: "sine", vol: 0.12 }),
    caw:      () => { tone({ f: 520, f2: 300, dur: 0.16, type: "sawtooth", vol: 0.12 }); tone({ f: 500, f2: 280, dur: 0.16, type: "sawtooth", vol: 0.1, delay: 0.2 }); },
    hiss:     () => noise({ dur: 0.7, vol: 0.12, type: "highpass", f: 4000, q: 0.7 }),
    whoosh:   () => noise({ dur: 0.7, vol: 0.28, type: "bandpass", f: 400, f2: 2500, q: 1.2 }),
    sprinkle: () => noise({ dur: 1.2, vol: 0.14, type: "highpass", f: 3500 }),
    mower:    () => { tone({ f: 90, f2: 140, dur: 1.4, type: "sawtooth", vol: 0.14 }); noise({ dur: 1.4, vol: 0.1, type: "lowpass", f: 700 }); },
    bong:     () => tone({ f: 190, f2: 150, dur: 0.5, type: "sine", vol: 0.35 }),
    dive:     () => tone({ f: 1500, f2: 300, dur: 0.6, type: "sawtooth", vol: 0.1 }),
    plop:     () => tone({ f: 500, f2: 150, dur: 0.14, type: "sine", vol: 0.25 }),
    stomp:    () => { tone({ f: 70, f2: 35, dur: 0.4, type: "sine", vol: 0.45 }); noise({ dur: 0.25, vol: 0.2, type: "lowpass", f: 300 }); },
    join:     () => { note(784, 0, 0.08, "square", 0.08); note(1175, 0.07, 0.12, "square", 0.08); },
    sting:    () => { note(196, 0, 0.35, "sawtooth", 0.12); note(247, 0.25, 0.35, "sawtooth", 0.12); note(294, 0.5, 0.6, "sawtooth", 0.14); },
    fanfare:  () => { note(523, 0, 0.18, "square", 0.12); note(659, 0.16, 0.18, "square", 0.12); note(784, 0.32, 0.18, "square", 0.12); note(1047, 0.48, 0.6, "square", 0.14); }
  };
  // Minimum gap (ms) between repeats of the same sound so barrages stay pleasant.
  const MIN_GAP = { explosion: 60, launch: 60, spit: 60, peck: 45, bounce: 70, hurt: 90, whack: 80, splash: 80, tick: 200, hiss: 400, caw: 150, death: 120, plop: 80, chirp: 200 };

  function play(name, arg) {
    if (muted || !SOUNDS[name]) return;
    const now = performance.now(), gap = MIN_GAP[name] || 0;
    if (gap && now - (last[name] || 0) < gap) return;
    if (active > 30) return;
    last[name] = now;
    try { SOUNDS[name](arg); } catch (e) { errors++; }
  }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem("nvb_mute", muted ? "1" : "0"); } catch (e) {}
    if (!muted) ctx();
    return muted;
  }
  return { play, setMuted, toggle: () => setMuted(!muted), isMuted: () => muted, get errors() { return errors; }, names: Object.keys(SOUNDS) };
})();
window.Sfx = Sfx;
