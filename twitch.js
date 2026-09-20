/* =========================================================================
 * NUT vs. BEAK - twitch.js
 * ComfyJS setup, chat parsing, and the DOM state machine
 * (IDLE -> LOBBY -> BATTLE -> MEMORIAM -> RESULTS -> IDLE).
 *
 * Phase-2 contract (game.js / physics.js will provide this):
 *   window.Game.start(units, api)          begin the canvas battle
 *   window.Game.handleCommand(user, cmd, args)   route !weapon/!aim/!power/!fire
 * `api` is { endMatch(result) } - call it when one faction is eliminated:
 *   result = { winner: "squirrels"|"birds", units: [...] } where each unit
 *   keeps { name, side, isBot, alive, damageDealt, kills, cause }.
 * ========================================================================= */

/* ---------------- config ---------------- */
const urlParams = new URLSearchParams(window.location.search);
// Which Twitch channel to read: index.html?username=YourChannel  (a leading @ or # is stripped).
const DEFAULT_CHANNEL = "PaladinArcade";
const CHANNEL_NAME = (urlParams.get("username") || "").trim().replace(/^[@#]/, "") || DEFAULT_CHANNEL;
const CHANNEL_FROM_URL = !!(urlParams.get("username") || "").trim();
let DEV_MODE = urlParams.has("dev");
try { if (localStorage.getItem("nvb_dev_mode") === "1") DEV_MODE = true; } catch (e) {}

const LOBBY_SECONDS = 60;
const UNITS_PER_SIDE = 4;
const RESULTS_HOLD_MS = 8000;
const MEMORIAM_HOLD_MS = 14000;

const SIDES = {
  squirrels: { label: "SQUIRRELS", icon: "🐿️", token: "🌰", botPrefix: "Bot_Nut" },
  birds:     { label: "BIRDS",     icon: "🐦", token: "🪶", botPrefix: "Bot_Beak" }
};

const CAUSES_FALLBACK = ["Lost in battle", "Was outmaneuvered by a rodent-sized grudge"];
const INTRO_MS = 10000;                      // commander cards: long enough to read both quotes

/* Commanding officers - one is drawn per side each match. Quotes are affectionate
 * mangles of MacArthur / Twain / Churchill lines, retargeted at the bird feeder. */
const OFFICERS = {
  squirrels: [
    { rank: "General", name: "Douglas MacAcorn", quote: "Old squirrels never die. They just fade away... usually behind the shed, with the good peanuts." },
    { rank: "Field Marshal", name: "Mark Twig", quote: "The reports of my nut-burying are greatly exaggerated. I have exactly forty-one nuts. Where? Ask me again tomorrow." },
    { rank: "Brigadier", name: "Patton Pecan", quote: "There is no substitute for victory. Except peanut butter. Peanut butter is a very good substitute." },
    { rank: "Commodore", name: "Sir Squeaks-a-Lot", quote: "I shall return. Preferably with snacks, and preferably before that hawk finishes lunch." },
    { rank: "Colonel", name: "Nutty Roosevelt", quote: "Speak softly and carry a big acorn. Also, chew through the feeder's wire. Mostly that second part." },
    { rank: "Admiral", name: "Chester W. Nimbletz", quote: "Uncommon valor was a common virtue among squirrels. Uncommon parking, less so. Please stop parking on the fence." },
    { rank: "General", name: "Dwight D. Eisenhazelnut", quote: "Plans are worthless, but planning is everything. Our plan is to fall out of the tree with confidence." },
    { rank: "Major General", name: "Tail Whitman", quote: "I contain multitudes. Mostly peanuts. Some of them are not mine, and I refuse to discuss it." },
    { rank: "Lieutenant", name: "Nutsy Bradley", quote: "The best defense is a good offense, and the best offense is a very fluffy tail. Nobody has ever explained why." },
    { rank: "Fleet Admiral", name: "Chip Nimitz", quote: "The war will be won by the side that hides the most nuts and forgets the fewest. We are not that side." },
    { rank: "Colonel", name: "Ulysses S. Grain", quote: "I propose to fight it out on this line if it takes all summer. The line is the clothesline. It will take all summer." }
  ],
  birds: [
    { rank: "General", name: "Douglas MacArthrush", quote: "I have returned. The feeder is empty. Somebody will answer for this, and it will be a squirrel." },
    { rank: "Field Marshal", name: "Mark Tweet", quote: "It is better to keep your beak shut and be thought a fool than to open it and reveal where the feeder is." },
    { rank: "Air Marshal", name: "Wingston Churchill", quote: "We shall fight them on the wires, we shall fight them on the fence posts, we shall never surrender the suet." },
    { rank: "Colonel", name: "Eddie Rickenbeaker", quote: "Get your seeds first, then you can distort them as you please. Nobody counts them anyway. Least of all Dale." },
    { rank: "General", name: "George S. Pigeon", quote: "No bird ever won a war by dying for his feeder. He won it by making the squirrel die for his." },
    { rank: "Admiral", name: "Horatio Nelsong", quote: "England expects that every bird will do his duty. I expect that every bird will also stop pooping on my car." },
    { rank: "Colonel", name: "Amelia Earhawk", quote: "The most difficult thing is the decision to act. The rest is merely tenacity, and also a lot of seed." },
    { rank: "General", name: "Claire Chennault-Finch", quote: "Give me a feeder, a flock, and a tailwind, and I will show you a very confused squirrel." },
    { rank: "Field Marshal", name: "Montgomery Sparrow", quote: "Never stop attacking. Never stop pecking. Never, under any circumstances, trust the suet after Tuesday." },
    { rank: "Major", name: "Red Baron von Robin", quote: "I do not fight for the feeder. I fight because the squirrel looked at me. He knows what he did." },
    { rank: "Air Commodore", name: "Sir Douglas Bader-Beak", quote: "Good tactics can save even the worst strategy. Great tactics can save us from Dale's cat. Mostly." }
  ]
};

/* Attract-mode backstory: rotates through the idle screen between the logo cards. */
const STORY = [
  "For eleven peaceful years, one bird feeder hung in Dale's backyard, and all was well.",
  "Then Dale bought a \"squirrel-proof\" feeder. It was not squirrel-proof. It was squirrel-INSPIRING.",
  "The birds say the seed was theirs first. The squirrels say Dale is obviously a squirrel sympathizer.",
  "Both sides hired lawyers. Both lawyers turned out to be squirrels. This is now a war.",
  "Dale has since moved to Arizona. The feeder remains. So does the fighting."
];

/* ---------------- state ---------------- */
let state = "IDLE";
let lobby = { squirrels: [], birds: [] };   // human joiners only: { name }
let matchUnits = [];                         // full 8-unit roster for the current match
let stats = {};                              // { lowercaseName: { games, wins, damage, kills } }
let lobbyTimerHandle = null;
let phaseTimeoutHandle = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const el = id => document.getElementById(id);
const panels = {
  IDLE: el("panelIdle"), LOBBY: el("panelLobby"), INTRO: el("panelIntro"), BATTLE: el("panelBattle"),
  MEMORIAM: el("panelMemoriam"), RESULTS: el("panelResults")
};
let commanders = null;                       // { squirrels: {...}, birds: {...} } for the current match
let idleCycleHandle = null, idleView = 0;

function setState(next) {
  state = next;
  if (next !== "IDLE") stopIdleCycle();
  Object.values(panels).forEach(p => p.classList.remove("active"));
  panels[next].classList.add("active");
}

/* ---------------- persistence (localStorage, no backend) ---------------- */
function loadStats() {
  try { const s = localStorage.getItem("nvb_stats"); stats = s ? JSON.parse(s) : {}; } catch (e) { stats = {}; }
}
function saveStats() {
  try { localStorage.setItem("nvb_stats", JSON.stringify(stats)); } catch (e) {}
}

/* ---------------- idle ---------------- */
function enterIdle() {
  clearInterval(lobbyTimerHandle);
  clearTimeout(phaseTimeoutHandle);
  lobby = { squirrels: [], birds: [] };
  matchUnits = [];
  setState("IDLE");
  el("statsCard").style.display = "none";
  startIdleCycle();
}

/* Attract mode: view 0 = logo + "!join" call to action, views 1..N = backstory chapters. */
function showIdleView(i) {
  idleView = i;
  if (el("statsCard").style.display === "flex") return;     // a !stats card has the screen right now
  el("idlePrompt").style.display = i === 0 ? "flex" : "none";
  el("storyCard").style.display = i === 0 ? "none" : "flex";
  if (i > 0) {
    const t = el("storyText");
    t.textContent = STORY[i - 1];
    t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";   // replay the fade-in
    el("storyChapter").textContent = `Chapter ${i} of ${STORY.length}`;
  }
}
function startIdleCycle() {
  stopIdleCycle();
  showIdleView(0);
  const step = () => {
    idleCycleHandle = setTimeout(() => { showIdleView((idleView + 1) % (STORY.length + 1)); step(); }, idleView === 0 ? 9000 : 7500);
  };
  step();
}
function stopIdleCycle() { clearTimeout(idleCycleHandle); idleCycleHandle = null; }

function showStatsCard(user) {
  const s = stats[user.toLowerCase()] || { games: 0, wins: 0, damage: 0, kills: 0 };
  el("statsCardName").textContent = user;
  el("statsCardBody").innerHTML =
    `<div class="stat-row"><span>Games</span><span>${s.games}</span></div>` +
    `<div class="stat-row"><span>Wins</span><span>${s.wins}</span></div>` +
    `<div class="stat-row"><span>Damage</span><span>${s.damage}</span></div>` +
    `<div class="stat-row"><span>Kills</span><span>${s.kills}</span></div>`;
  el("idlePrompt").style.display = "none";
  el("storyCard").style.display = "none";
  el("statsCard").style.display = "flex";
  setTimeout(() => { if (state === "IDLE") { el("statsCard").style.display = "none"; showIdleView(idleView); } }, 6000);
}

/* ---------------- lobby ---------------- */
function toast(msg) {
  const t = el("toast");
  t.textContent = msg; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
}

function isJoined(user) {
  const u = user.toLowerCase();
  return [...lobby.squirrels, ...lobby.birds].some(p => p.name.toLowerCase() === u);
}

function openLobby() {
  lobby = { squirrels: [], birds: [] };
  setState("LOBBY");
  renderLobby();

  let left = LOBBY_SECONDS;
  el("lobbyTimer").textContent = left;
  clearInterval(lobbyTimerHandle);
  lobbyTimerHandle = setInterval(() => {
    left--;
    el("lobbyTimer").textContent = left;
    if (left <= 0) startMatch();
  }, 1000);
}

function handleJoin(user, side) {
  if (state !== "IDLE" && state !== "LOBBY") return;       // no joining mid-battle
  if (state === "IDLE") openLobby();                        // first join opens the lobby
  if (isJoined(user)) { toast(`${user} is already enlisted!`); return; }
  if (lobby[side].length >= UNITS_PER_SIDE) { toast(`${SIDES[side].label} are full - try the other side!`); return; }

  lobby[side].push({ name: user });
  renderLobby(user);
}

function renderLobby(justJoined) {
  const build = (side) => {
    const humans = lobby[side].map(p => ({ name: p.name, bot: false }));
    const bots = Array.from({ length: UNITS_PER_SIDE - humans.length }, (_, i) => ({ name: `${SIDES[side].botPrefix}${i + 1}`, bot: true }));
    return [...humans, ...bots].map(p =>
      `<li class="${p.bot ? "bot" : ""} ${justJoined && p.name === justJoined ? "glitch" : ""}">${p.bot ? "🤖 " : ""}${escapeHtml(p.name)}</li>`
    ).join("");
  };
  el("sqCount").textContent = lobby.squirrels.length;
  el("birdCount").textContent = lobby.birds.length;
  el("listSquirrels").innerHTML = build("squirrels");
  el("listBirds").innerHTML = build("birds");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- match start ---------------- */
function buildRoster() {
  const units = [];
  ["squirrels", "birds"].forEach(side => {
    for (let i = 0; i < UNITS_PER_SIDE; i++) {
      const human = lobby[side][i];
      units.push({
        name: human ? human.name : `${SIDES[side].botPrefix}${i + 1}`,
        side, isBot: !human,
        hp: 100, alive: true,
        damageDealt: 0, kills: 0, cause: null
      });
    }
  });
  return units;
}

function startMatch() {
  if (state !== "LOBBY") return;
  clearInterval(lobbyTimerHandle);

  if (lobby.squirrels.length + lobby.birds.length === 0) {
    toast("Nobody enlisted - standing down.");
    enterIdle();
    return;
  }

  matchUnits = buildRoster();
  commanders = { squirrels: pickOne(OFFICERS.squirrels), birds: pickOne(OFFICERS.birds) };
  showIntro();
}

const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

/* Commander cards, like Slash Royale's killer intro: shown once, then the battle starts. */
function showIntro() {
  const c = commanders;
  el("offSqRank").textContent = c.squirrels.rank.toUpperCase();
  el("offSqName").textContent = c.squirrels.name;
  el("offSqQuote").textContent = `“${c.squirrels.quote}”`;
  el("offBirdRank").textContent = c.birds.rank.toUpperCase();
  el("offBirdName").textContent = c.birds.name;
  el("offBirdQuote").textContent = `“${c.birds.quote}”`;
  setState("INTRO");
  clearTimeout(phaseTimeoutHandle);
  phaseTimeoutHandle = setTimeout(beginBattle, INTRO_MS);
}

function beginBattle() {
  if (state !== "INTRO") return;
  clearTimeout(phaseTimeoutHandle);
  setState("BATTLE");
  el("hudTurn").textContent = "GET READY";
  el("hudTimer").textContent = "--";

  if (window.Game && typeof window.Game.start === "function") {
    window.Game.start(matchUnits, { endMatch });
  } else {
    drawPhase1Placeholder();
  }
}

/* Shown until game.js/physics.js exist, so the lobby -> battle transition can be tested. */
function drawPhase1Placeholder() {
  const c = el("gameCanvas"), ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, "#2b4a7a"); g.addColorStop(1, "#7fb6d9");
  ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#3d2b1a"; ctx.fillRect(0, 400, c.width, 140);
  ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "16px 'Press Start 2P', monospace";
  ctx.fillText("BATTLE ENGINE COMING IN PHASE 2", c.width / 2, 120);
  ctx.font = "34px serif";
  matchUnits.forEach((u, i) => {
    const x = u.side === "squirrels" ? 90 + (i % UNITS_PER_SIDE) * 70 : 610 + (i % UNITS_PER_SIDE) * 70;
    ctx.fillText(SIDES[u.side].icon, x, 380);
  });
  ctx.font = "10px 'Press Start 2P', monospace";
  matchUnits.forEach((u, i) => {
    const x = u.side === "squirrels" ? 90 + (i % UNITS_PER_SIDE) * 70 : 610 + (i % UNITS_PER_SIDE) * 70;
    ctx.fillText(u.name.slice(0, 8), x, 412);
  });
  el("battleBanner").textContent = "Use dev 'Simulate Game Over' to test epitaph cards";
  el("battleBanner").classList.remove("show"); void el("battleBanner").offsetWidth; el("battleBanner").classList.add("show");
}

/* ---------------- match end -> epitaph cards -> results ---------------- */
function endMatch(result) {
  if (state !== "BATTLE") return;
  const units = result.units || matchUnits;
  const winner = result.winner;

  // Persist stats for human players only.
  units.filter(u => !u.isBot).forEach(u => {
    const key = u.name.toLowerCase();
    const s = stats[key] || { games: 0, wins: 0, damage: 0, kills: 0 };
    s.games++; s.damage += u.damageDealt || 0; s.kills += u.kills || 0;
    if (u.side === winner) s.wins++;
    stats[key] = s;
  });
  saveStats();

  showMemoriam(units, winner);
}

function showMemoriam(units, winner) {
  const humans = units.filter(u => !u.isBot);
  if (humans.length === 0) { showResults(winner); return; }

  setState("MEMORIAM");
  const grid = el("epitaphGrid");
  grid.innerHTML = humans.map((u, i) => {
    const side = SIDES[u.side];
    const survived = u.alive;
    const cause = survived ? "Survived!" : (u.cause || CAUSES_FALLBACK[i % CAUSES_FALLBACK.length]);
    return `
      <div class="evidence-card" style="animation-delay:${i * 0.25}s">
        <div class="evidence-stamp ${survived ? "survived" : ""}">${survived ? "SURVIVED" : "FALLEN"}</div>
        <div class="evidence-icon">${side.token}</div>
        <div class="evidence-name">${escapeHtml(u.name)}</div>
        <div class="evidence-faction">${side.icon} ${side.label}</div>
        <div class="evidence-stats">DAMAGE DEALT: ${u.damageDealt || 0}<br>ENEMIES DEFEATED: ${u.kills || 0}</div>
        <div class="evidence-cause">"${escapeHtml(cause)}"</div>
      </div>`;
  }).join("");

  phaseTimeoutHandle = setTimeout(() => showResults(winner), MEMORIAM_HOLD_MS);
}

function showResults(winner) {
  setState("RESULTS");
  const side = SIDES[winner];
  el("resultsIcon").textContent = side ? side.icon : "🏳️";
  el("resultsTitle").textContent = side ? `${side.label} WIN!` : "DRAW";
  const cmd = commanders && side ? commanders[winner] : null;
  el("resultsSub").textContent = side
    ? `${cmd ? `${cmd.rank} ${cmd.name} claims the bird feeder.` : "The bird feeder belongs to them now."}`
    : "Nobody wins the feeder. Dale would be so disappointed.";
  phaseTimeoutHandle = setTimeout(enterIdle, RESULTS_HOLD_MS);
}

/* ---------------- chat parsing ---------------- */
function onChatCommand(user, message, flags) {
  const text = (message || "").trim().toLowerCase();
  if (!text.startsWith("!")) {                              // a bare "crows" counts as a weapon vote too
    if (state === "BATTLE" && window.Game && text && !text.includes(" ")) window.Game.handleCommand(user, "!" + text, []);
    return;
  }
  const [cmd, ...args] = text.split(/\s+/);
  const isMod = !!(flags && (flags.broadcaster || flags.mod));

  if (cmd === "!reset" && flags && flags.broadcaster) { stats = {}; saveStats(); return; }
  if (cmd === "!stats" && state === "IDLE") { showStatsCard(user); return; }

  if (cmd === "!join") {
    const arg = args[0] || "";
    if (arg === "squirrels" || arg === "squirrel") handleJoin(user, "squirrels");
    else if (arg === "birds" || arg === "bird") handleJoin(user, "birds");
    else if (state === "LOBBY" || state === "IDLE") toast("Type !join squirrels or !join birds");
    return;
  }

  if (cmd === "!start") { if (isMod && state === "LOBBY") startMatch(); return; }

  // In-battle commands are validated (is it this player's turn?) by game.js.
  // Battle: every command is handed to game.js, which only reacts to weapon votes
  // ("!crows" or "!vote crows" while a vote is open) unless MANUAL_CONTROL is on there.
  if (state === "BATTLE" && window.Game && typeof window.Game.handleCommand === "function") window.Game.handleCommand(user, cmd, args);
}

/* ---------------- Twitch ---------------- */
function connectTwitch() {
  console.log(`Nut vs. Beak: connecting to Twitch chat channel "${CHANNEL_NAME}"${CHANNEL_FROM_URL ? "" : " (default - add ?username=YourChannel to the URL)"}`);
  ComfyJS.onChat = (user, message, flags) => onChatCommand(user, message, flags);
  // ComfyJS sends "!"-prefixed messages to onCommand and splits "!aim 45" into
  // command="aim" + message="45". Reconstruct the FULL text or every argument
  // (side, angle, power, weapon name) is silently dropped.
  ComfyJS.onCommand = (user, command, message, flags) =>
    onChatCommand(user, `!${command}${message ? " " + message : ""}`, flags);
  ComfyJS.Init(CHANNEL_NAME);
}

/* ---------------- dev tools ---------------- */
function devLog(line) { const d = el("devLog"); d.innerHTML = `<div>${escapeHtml(line)}</div>` + d.innerHTML; }
function devSendChat() {
  const u = el("devUsername").value.trim() || "TestUser";
  const m = el("devMessage").value;
  const mod = el("devBroadcasterFlag").checked;
  onChatCommand(u, m, { broadcaster: mod, mod });
  devLog(`${u}: ${m}${mod ? " [mod]" : ""}`);
}
function devQuickJoin(side) { el("devMessage").value = `!join ${side}`; devSendChat(); }
function devFloodJoins(n) {
  for (let i = 0; i < n; i++) {
    const side = Math.random() > 0.5 ? "squirrels" : "birds";
    onChatCommand(`TestHuman${Math.floor(Math.random() * 900) + 100}`, `!join ${side}`, {});
  }
}
function devStart() { onChatCommand("DevMod", "!start", { broadcaster: true, mod: true }); devLog("DevMod: !start [mod]"); }
function devDropCrate() { if (state === "BATTLE" && window.Game) Game.dropCrate(); else devLog("Start a battle first."); }
function devSkipIntro() { if (state === "INTRO") beginBattle(); else devLog("Not in the intro."); }
function devBattleCmd(text) { el("devMessage").value = text; devSendChat(); }
function devSimulateGameOver() {
  if (state !== "BATTLE") { devLog("Start a match first."); return; }
  const causes = ["Blew themselves up", "Fell into the abyss", "Caught the Holy Hand Grenade", "Was out-aimed by a bot"];
  const units = matchUnits.map((u, i) => ({
    ...u,
    alive: u.side === "squirrels" && i % 2 === 0,
    damageDealt: Math.floor(Math.random() * 120),
    kills: Math.floor(Math.random() * 3),
    cause: causes[i % causes.length]
  }));
  endMatch({ winner: "squirrels", units });
}
/* ---- Auto-play: fake chatters run whole matches hands-free ----
 * Lobby: joins 3-6 fake humans, waits, then !start as a mod.
 * Battle: once game.js exists (Game.getActiveUnit()), the active human takes
 * their turn through the real chat router (!weapon/!aim/!power/!fire). Until
 * then it falls back to a simulated game over so the full flow still runs. */
let autoPlayOn = false;
let autoPlayTimer = null;
let autoPlayBattleTicks = 0;
let autoPlayLastActing = null;

function devToggleAutoPlay() {
  autoPlayOn = !autoPlayOn;
  const btn = el("devAutoBtn");
  btn.textContent = autoPlayOn ? "Auto-Play: ON (click to stop)" : "Auto-Play Match";
  btn.style.background = autoPlayOn ? "#2e7d32" : "";
  btn.style.color = autoPlayOn ? "#fff" : "";
  clearInterval(autoPlayTimer);
  autoPlayBattleTicks = 0;
  if (autoPlayOn) { devLog("Auto-play started"); autoPlayTimer = setInterval(autoPlayTick, 1500); autoPlayTick(); }
  else devLog("Auto-play stopped");
}

function autoPlayTick() {
  if (!autoPlayOn) return;

  if (state === "IDLE") {
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? "squirrels" : "birds";
      onChatCommand(`Chatter${Math.floor(Math.random() * 900) + 100}`, `!join ${side}`, {});
    }
    autoPlayBattleTicks = 0;
    return;
  }

  if (state === "LOBBY") {
    autoPlayBattleTicks++;
    if (autoPlayBattleTicks >= 3) { onChatCommand("AutoMod", "!start", { broadcaster: true, mod: true }); autoPlayBattleTicks = 0; }
    return;
  }

  if (state === "BATTLE") {
    const g = window.Game;
    if (g && typeof g.getPoll === "function" && g.getPoll()) {           // fake chatters vote in weapon polls
      const p = g.getPoll();
      for (let i = 0; i < 3; i++) onChatCommand(`Voter${i}`, `!${p.options[Math.floor(Math.random() * p.options.length)]}`, {});
      return;
    }
    if (g && typeof g.getActiveUnit === "function") {
      const u = g.getActiveUnit(), id = g.getTurnId();
      if (u && !u.isBot && id !== autoPlayLastActing) {
        autoPlayLastActing = id;
        const weapons = ["acorn", "egg", "walnut", "cluster", "spitter", "pinecone", "suet", "crows", "gophers", "skunk", "mower", "woodpecker"];
        onChatCommand(u.name, `!weapon ${weapons[Math.floor(Math.random() * weapons.length)]}`, {});
        onChatCommand(u.name, `!aim ${10 + Math.floor(Math.random() * 160)}`, {});
        onChatCommand(u.name, `!power ${30 + Math.floor(Math.random() * 70)}`, {});
        onChatCommand(u.name, `!target ${Math.floor(Math.random() * 100)}`, {});
        onChatCommand(u.name, "!fire", {});
      }
    } else {
      autoPlayBattleTicks++;
      if (autoPlayBattleTicks >= 3) { devSimulateGameOver(); autoPlayBattleTicks = 0; }
    }
    return;
  }
  // MEMORIAM / RESULTS: wait for the normal timers, then it loops from IDLE.
}

function devVoteWeapon() {
  const p = window.Game && Game.getPoll && Game.getPoll();
  if (!p) { devLog("No weapon vote is open right now."); return; }
  el("devMessage").value = `!${p.options[Math.floor(Math.random() * p.options.length)]}`;
  devSendChat();
}
function devSendStats() { el("devMessage").value = "!stats"; devSendChat(); }
function devSendReset() { el("devMessage").value = "!reset"; el("devBroadcasterFlag").checked = true; devSendChat(); }

el("devToggleBtn").addEventListener("click", () => {
  let cur = "0";
  try { cur = localStorage.getItem("nvb_dev_mode"); } catch (e) {}
  try { localStorage.setItem("nvb_dev_mode", cur === "1" ? "0" : "1"); } catch (e) {}
  location.reload();
});

/* ---------------- boot ---------------- */
(function init() {
  loadStats();
  enterIdle();
  el("devChannel").textContent = CHANNEL_NAME + (CHANNEL_FROM_URL ? "" : " (default)");
  if (DEV_MODE) {
    el("devPanel").classList.add("show");
    const btn = document.createElement("button");
    btn.textContent = "Connect to Twitch";
    btn.onclick = () => { connectTwitch(); el("devChatStatus").textContent = "ON (live)"; btn.disabled = true; };
    el("devPanel").insertBefore(btn, el("devPanel").querySelector(".dev-buttons"));
  } else {
    connectTwitch();
  }
})();
