;(() => {
  // ==============================
  // Canvas & setup
  // ==============================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const dpr = () => window.devicePixelRatio || 1;
  function resize() {
    const ratio = dpr();
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  // ==============================
  // Utils
  // ==============================
  const TAU = Math.PI * 2;
  const rand = (min, max) => Math.random() * (max - min) + min;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function hardWrap(p, w, h) {
    p.x = ((p.x % w) + w) % w;
    p.y = ((p.y % h) + h) % h;
  }

  const circlePointHit = (cx, cy, r, px, py) =>
    (cx - px) ** 2 + (cy - py) ** 2 <= r * r;

  function circleCircleHit(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const rr = (a.r + b.r) * (a.r + b.r);
    return dx * dx + dy * dy <= rr;
  }

  // Distance from a circle center to a segment; return true if <= r
  function lineCircleHit(x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx*dx + dy*dy || 1;
    let t = ((cx - x1)*dx + (cy - y1)*dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t*dx, py = y1 + t*dy;
    const ddx = cx - px, ddy = cy - py;
    return (ddx*ddx + ddy*ddy) <= r*r;
  }

  function sqr(x){ return x*x; }

  function nearestTarget(x, y) {
    let best = null;
    let bestD2 = Infinity;

    // spheres
    for (const s of state.spheres) {
      const d2 = sqr(s.x - x) + sqr(s.y - y);
      if (d2 < bestD2) { bestD2 = d2; best = { type: 'sphere', ref: s }; }
    }

    // hunters (optional—include if you want homing to hit them too)
    if (state.hunters) {
      for (const h of state.hunters) {
        const d2 = sqr(h.x - x) + sqr(h.y - y);
        if (d2 < bestD2) { bestD2 = d2; best = { type: 'hunter', ref: h }; }
      }
    }

    // tanks (multi-hit)
    if (state.tanks) {
      for (const t of state.tanks) {
        const d2 = sqr(t.x - x) + sqr(t.y - y);
        if (d2 < bestD2) { bestD2 = d2; best = { type: 'tank', ref: t }; }
      }
    }

    // radius gate
    if (best && Math.sqrt(bestD2) <= params.homingAcquireRadius) return best;
    return null;
  }

  // ==============================
  // State
  // ==============================
  const state = {
    running: true,
    score: 0,
    lives: 3,
    wave: 1,
    invulnUntil: 0,

    bullets: [],
    spheres: [],
    hunters: [],          // new enemy type
    tanks: [],            // multi-hit enemy
    particles: [],        // includes RCS pulses (type:'rcs')
    collectibles: [],
    shockwaves: [],
    //lasers: [],

    collected: 0,
    keys: new Set(),
    lastShotAt: 0,
    charging: false,
    chargeStart: 0,
    lastRcsPuffAt: 0,
    lastRotPuffAt: 0,

    prevUpdateAt: 0,  // for dt-based regen
    energy: 100,          // %
    nextCollectibleAt: 0, // ms timestamp
    plumeLen: 0,
    plumeBend: 0,
    angVel: 0,
    prevAngle: 0,

    activeWeapon: 0,   // index into state.weapons
    weapons: ['bullet', 'fan', 'homing'], // start with two

    // --- State ---
    showWaveUntil: 0,
    waveMsg: '',
    waveStartAt: 0,

    // --- Director state ---
    spawnQueue: [],           // timed phase spawns
    waveActiveSince: 0,       // ms timestamp when wave enemies start
    waveDeaths: 0,            // deaths during current wave
    lastWaveStats: { clearMs: 0, deaths: 0 },
    difficultyScalar: 1.0,    // adaptive scaling 0.7..1.6
  };

  // ==============================
  // Ship
  // ==============================
  const ship = {
    x: canvas.width / dpr() / 2,
    y: canvas.height / dpr() / 2,
    vx: 0,
    vy: 0,
    a: -Math.PI / 2,
    r: 12,
  };

  // Ship collision helper (slightly larger than visual hull)
  function getShipHitR(){
    return (params.shipHitScale ?? 1.35) * ship.r;
  }

  // ==============================
  // Tunables / Params
  // ==============================
  const params = {
    // Movement
    thrust: 0.25, //default 0.18
    reverseThrust: 0.1, //default 0.09
    rotSpeed: 0.1, //defaul 0.09
    maxSpeed: 15,  //default 10
    friction: 0.990, //default 0.992

    // Weapons
    bulletSpeed: 14,
    bulletCooldown: 75,
    bulletLife: 1000,
    bulletSize: 5, // visual size in px (render only)
    bulletTrailLen: 60,     // base trail length in px
    bulletTrailWidth: 2,    // trail line width
    bulletTrailSpeedMult: 0.9, // adds length based on speed

    // Energy regen
    energyRegenDelayMs: 500,   // wait this long after your last shot
    energyRegenPerSec: 15,       // % per second to regen (slow-ish). Tweak as you like.

    // --- Fan/Spread weapon ---
    fanCount: 5,            // number of projectiles
    fanArcDeg: 22,          // total arc spread in degrees
    fanSpeedMult: 0.95,     // fan bullets slightly slower than single bullet
    fanEnergyCostMult: 2, // energy cost multiplier vs single bullet

    // Homing bullet params
    homingSpeed: 12,            // flight speed
    homingTurnRateRad: 0.04,     // max turn per frame (radians)
    homingRetargetMs: 140,       // how often to re-acquire a target
    homingAcquireRadius: 1200,   // max distance to consider targets
    homingLife: 2000,            // ms lifetime
    homingEnergyCostMult: 1.6,   // energy cost multiplier vs normal bullet
    
    // Spheres
    sphereMinR: 24,
    sphereMaxR: 110,         // allow larger spheres for higher threat
    sphereSplitFactor: 0.65,
    sphereCountBase: 5,
    sphereWaveGrowth: 2,
    sphereLightInnerFrac: 0.1,  // 0..1, inner radius of light in radial gradient
    sphereLightOffset: 0.30,    // 0..1, how far toward light the gradient center is shifted

    // --- Hunters (chasing drones) ---
    hunterCountBase: 1,          // per wave
    hunterWaveGrowth: 1,         // +N each wave
    hunterR: 15,                 // visual radius / hit radius
    hunterWander: 0.14,          // small random jitter to avoid perfect aim
    hunterSpawnGraceMs: 900,     // can't hurt you right after spawning
    hunterScore: 30,             // points
    hunterEnergyDropPct: 0,     // restore energy on kill

    // Hunter behavior
    hunterMaxSpeed: 4,
    hunterAccel: 0.06,              // how strongly they steer toward the ship
    hunterWanderStrength: 0.04,     // lateral wiggle force
    hunterWanderJitter: 0.15,       // how quickly wander angle meanders
    hunterSeparationRadius: 60,     // how close before they repel
    hunterSeparationStrength: 0.8,  // repulsion strength
    hunterDrag: 0.995,              // small damping

    // Hunter charge behavior
    hunterChargeTriggerDist: 360,   // start logic when within this distance
    hunterChargeAimConeRad: 0.30,   // ~17°: how aligned they must be to start windup
    hunterChargeWindupMs: 450,      // telegraph time before dash
    hunterChargeDurationMs: 320,    // how long they dash
    hunterChargeCooldownMs: 1800,   // rest before next attempt
    hunterChargeSpeedMult: 2.8,     // dash speed boost over hunterMaxSpeed
    hunterChargeDrag: 0.997,        // drag during charge (small)
    hunterRecoverDrag: 0.985,       // brief heavier drag right after charge

    // --- Tanks (multi-hit enemies) ---
    tankRMin: 22,
    tankRMax: 30,
    tankHp: 4,
    tankSpeedMin: 0.4,
    tankSpeedMax: 1.2,
    tankScore: 60,
    tankShockwaveDamage: 2,   // shockwave damage to tanks (hp)

    // --- Director difficulty scaling ---
    budgetBase: 12,     // previously 8
    budgetA: 5,         // previously 3
    budgetB: 0.9,       // previously 0.5
    budgetMult: 1.15,   // global multiplier
    directorHunterCapFrac: 0.75, // fraction of budget cost allowed for hunters


    // Player
    invulnAfterHitMs: 2000,
    shipHitScale: 1.15,    // collision radius multiplier vs ship.r
    invulnRingScale: 4,  // ring radius vs ship hit radius
    invulnRingWidth: 1,
    invulnRingPulseMs: 900,
    invulnRingPulseScale: 0.03, // +- radius pulsation fraction
    invulnRingBackPx: 4,        // offset ring center back along ship (px)


    // Charge / shockwave
    chargeTime: 600,
    laserMinPower: 0.45,     // reuse as "min charge to trigger wave"

    // Shockwave specifics
    shockDuration: 280,       // ms visible/active
    shockStartRadius: 18,     // px at birth
    shockMaxRadius: 360,      // px (range cap)
    shockWidth: 8,           // ring thickness for visuals/hit band
    shockFalloffInner: 0.5,   // 0..1, how 'empty' the inner hole is (0=filled disk)


    // // Charge / laser
    // chargeTime: 600,
    // laserMinPower: 0.45,
    // laserDuration: 200,
    // laserWidthBase: 15,
    // laserWidthMax: 25,
    // laserKnockback: 0.6,
    // knockbackMult: 0.25,

    knockbackMult: 0.25,   // <— put this back (outside any commented block)

    // RCS visuals
    rcsPuffCooldown: 120,
    rcsPulseLength: 12,

    // Engine plume
    plumeBaseLen: 20,
    plumeMaxLen: 60,
    plumeWidth: 16,
    plumeLerp: 0.10,
    plumeCurveFrac: 0,   // fraction of length used as max bend cap (0.28)
    plumeVelBias: 0.45,     // how much velocity lateral component bends 
    plumeTurnBias: 0.25,    // how much turning rate bends

    // RCS placement (positions)
    rcsOffsets: {
      left:  { fwd: 19, side: 16 },
      right: { fwd: 19, side: 16 },
      nose:  { fwd: 9 }
    },

    // RCS angles (directions relative to ship.a)
    rcsAngles: {
      left:  -Math.PI/2 - 0.4,
      right:  Math.PI/2 + 0.4,
      nose:   0,
      jitter: 0.10
    },

    // Energy / ammo
    energyMax: 100,
    bulletEnergyCost: 2,            // % per normal shot
    laserEnergyCostMult: 40,         // laser = 8× bullet cost
    collectibleEnergyRestore: 100,   // % restored per pickup

    // Timed collectible spawning during wave
    collectibleSpawnMinMs: 10000,
    collectibleSpawnMaxMs: 30000,
    collectibleMaxConcurrent: 2,

    // Collectible visuals/physics (also used by spawnCollectibles if you keep it)
    collectibleCount: 5,            // only used by the old "spawn at start" path
    collectibleBaseR: 6,
    collectiblePulseAmp: 2,
    collectiblePulseSpeed: 6.0,
    collectibleSpeed: 0.4,
    collectibleScore: 50,

    // --- Params (add) ---
    waveBannerMs: 2000,   // how long the banner shows

    // Spawn safety
    safeSpawnRadius: 260,          // no spheres inside this radius around the ship
    sphereSpawnMaxTries: 80,       // attempts before falling back to edge/ring spawn
    invulnAfterSpawnMs: 1500,      // ship invuln AFTER the banner (per wave)
    sphereSpawnGraceMs: 900,       // spheres can’t hurt the ship for this long after spawn

    // Legacy RCS braking (kept for reference)
    rcsBrakeFactor: 0.985,
    rcsReverseAccel: 0.09
  };

  // ==============================
  // Themes
  // ==============================
  const themes = {
    classic: {
      ship: '#e5e5e5',
      shipOutline: '#ffffff44',
      bullet: '#ffffff',
      hunter: '#f96262ff',
      tankBase: '#6acbff',
      plumeTop: '#c97320',
      plumeMid: '#5a2a00',
      sphereAlbedo: '#d9c6d3',
      sphereShadow: '#2e2a2e',
      sphereSpec:   '#ffe9ff',
      invulnRing: '#a3642d',
      engineFlame: '#ffd166',
      rcs: '#eaf7ff50',
      explosion: '#ffd166',
      sphereGradient: ['#9bf6ff', '#bdb2ff', '#ffadad'],
      sphereOutline: '#ffffff22',
      bg: '#0a0a0a',
    },
    retroGreen: {
      ship: '#00ff99',
      shipOutline: '#00cc77',
      bullet: '#00ffcc',
      hunter: '#f96262ff',
      tankBase: '#66ffaa',
      plumeTop: '#8ccf6a',
      plumeMid: '#2e5a2a',
      sphereAlbedo: '#a9f0c9',
      sphereShadow: '#0f2b19',
      sphereSpec:   '#eafff4',
      invulnRing: '#4aa06b',
      engineFlame: '#00ff55',
      rcs: '#55ffaa50',
      explosion: '#00ff55',
      sphereGradient: ['#003300', '#006600', '#00cc66'],
      sphereOutline: '#004422',
      bg: '#001100',
    },
    synthwave: {
      ship: '#ff6ad5',
      shipOutline: '#ff2e97',
      bullet: '#ff9150',
      hunter: '#f96262ff',
      tankBase: '#6affff',
      plumeTop: '#ff9150',
      plumeMid: '#4a210b',
      sphereAlbedo: '#F1D2E3',
      sphereShadow: '#292929',
      sphereSpec:   '#F1D2E3',
      invulnRing: '#c16a2f',
      engineFlame: '#ffb86c',
      rcs: '#ffffff50',
      explosion: '#ff6ad5',
      sphereGradient: ['#ff6ad5', '#9d6cff', '#6affff'],
      sphereOutline: '#ff2e97',
      bg: '#292929',
    },
  };
  let colors = themes.synthwave;

  // ==============================
  // Assets (SVG ship)
  // ==============================
  const shipImg = new Image();
  let shipImgReady = false;
  let shipImgW = 48, shipImgH = 48; // sensible defaults if SVG lacks size
  shipImg.onload = () => {
    shipImgReady = true;
    shipImgW = shipImg.naturalWidth || shipImg.width || 48;
    shipImgH = shipImg.naturalHeight || shipImg.height || 48;
  };
  shipImg.src = 'ship.svg';

  // ==============================
  // UI hooks
  // ==============================
// --- HUD refs ---
let scoreEl, livesEl, energyFillEl;

// Lazy grab (will be called inside setEnergy)
function ensureHudRefs(){
  if (!scoreEl)  scoreEl  = document.getElementById('score');
  if (!livesEl)  livesEl  = document.getElementById('lives');
  if (!energyFillEl) energyFillEl = document.getElementById('energyFill');
}

function setEnergy(v){
  state.energy = clamp(v, 0, params.energyMax);
  ensureHudRefs();

  const pct = (state.energy / params.energyMax) * 100;
  if (energyFillEl){
    energyFillEl.style.width = `${pct}%`;
    energyFillEl.classList.toggle('is-low', pct <= 25);
  }
}

  const addScore = (n) => {
    state.score += n;
    if (scoreEl) scoreEl.textContent = `Score: ${state.score}`;
  };

  function loseLife() {
    state.lives--;
    state.waveDeaths = (state.waveDeaths || 0) + 1;
    if (livesEl) livesEl.textContent = `Lives: ${state.lives}`;
    state.invulnUntil = performance.now() + params.invulnAfterHitMs;
    resetShip();
    if (state.lives < 0) {
      state.wave = 1;
      state.score = 0;
      announceWave();
      if (scoreEl) scoreEl.textContent = `Score: ${state.score}`;
      state.lives = 3;
      if (livesEl) livesEl.textContent = `Lives: ${state.lives}`;
    }
  }

  // ==============================
  // RCS anchor helper (positions + angles)
  // ==============================
  function rcsAnchor(kind) {
    const j = params.rcsAngles?.jitter
      ? rand(-params.rcsAngles.jitter, params.rcsAngles.jitter)
      : 0;

    if (kind === 'left') {
      const fwd  = params.rcsOffsets?.left?.fwd  ?? 8;
      const side = params.rcsOffsets?.left?.side ?? ship.r;
      return {
        x: ship.x + Math.cos(ship.a + Math.PI/2) * side + Math.cos(ship.a) * fwd,
        y: ship.y + Math.sin(ship.a + Math.PI/2) * side + Math.sin(ship.a) * fwd,
        angle: ship.a + (params.rcsAngles?.left ?? -Math.PI/2) + j
      };
    }

    if (kind === 'right') {
      const fwd  = params.rcsOffsets?.right?.fwd  ?? 8;
      const side = params.rcsOffsets?.right?.side ?? ship.r;
      return {
        x: ship.x + Math.cos(ship.a - Math.PI/2) * side + Math.cos(ship.a) * fwd,
        y: ship.y + Math.sin(ship.a - Math.PI/2) * side + Math.sin(ship.a) * fwd,
        angle: ship.a + (params.rcsAngles?.right ?? Math.PI/2) + j
      };
    }

    // nose (reverse)
    {
      const fwd = params.rcsOffsets?.nose?.fwd ?? 8;
      return {
        x: ship.x + Math.cos(ship.a) * (ship.r + fwd),
        y: ship.y + Math.sin(ship.a) * (ship.r + fwd),
        angle: ship.a + (params.rcsAngles?.nose ?? 0) + j
      };
    }
  }

  // ==============================
  // Ship control helpers
  // ==============================
  function resetShip(center = true) {
    ship.vx = 0;
    ship.vy = 0;
    ship.a = -Math.PI / 2;
    if (center) {
      ship.x = canvas.width / dpr() / 2;
      ship.y = canvas.height / dpr() / 2;
    }
  }

  function trySpendEnergy(costPct) {
    if (state.energy < costPct) return false;
    setEnergy(state.energy - costPct);
    return true;
  }


// ==============================
// Spawning
// ==============================

// Safer random point away from the ship (with non-edge fallback)
function safeRandomPointAwayFromShip(radius) {
  const w = canvas.width / dpr(), h = canvas.height / dpr();
  const rad = radius || params.safeSpawnRadius || 260;
  let x, y, tries = 0;

  while (tries++ < (params.sphereSpawnMaxTries || 80)) {
    x = rand(0, w); y = rand(0, h);
    if (Math.hypot(x - ship.x, y - ship.y) >= rad) return { x, y };
  }

  // Fallback: ring around ship, wrapped with modulo so we don't pin to edges
  const ang = rand(0, TAU);
  const r   = rad + 40;
  return {
    x: (ship.x + Math.cos(ang) * r + w) % w,
    y: (ship.y + Math.sin(ang) * r + h) % h,
  };
}

// Hunters with small off-edge nudge and guaranteed non-zero velocity
function spawnHunters(n = 1) {
  const w = canvas.width / dpr(), h = canvas.height / dpr();
  const now = performance.now();

  for (let i = 0; i < n; i++) {
    // always spawn away from ship (and not at edges)
    const pt = safeRandomPointAwayFromShip(220);
    let x = pt.x, y = pt.y;

    // tiny nudge off exact edges just in case
    const NUDGE = 8;
    if (x <= 0) x = NUDGE;
    if (y <= 0) y = NUDGE;
    if (x >= w) x = w - NUDGE;
    if (y >= h) y = h - NUDGE;

    // guaranteed finite non-zero velocity
    const spd = Number.isFinite(params.hunterSpeed) && params.hunterSpeed > 0 ? params.hunterSpeed : 1.6;
    let a = rand(0, TAU);
    let vx = Math.cos(a) * spd;
    let vy = Math.sin(a) * spd;
    // if somehow tiny, re-roll
    if (Math.abs(vx) + Math.abs(vy) < 0.001) {
      a = rand(0, TAU);
      vx = Math.cos(a) * spd;
      vy = Math.sin(a) * spd;
    }

    state.hunters.push({
      x, y, vx, vy,
      r: params.hunterR ?? 10,
      spawnGraceUntil: now + (params.hunterSpawnGraceMs ?? 800),

      // swarm/charge state
      seed: Math.random() * 1000,
      wanderTheta: rand(0, TAU),
      mode: 'seek',
      lockA: 0,
      windupUntil: 0,
      chargeUntil: 0,
      nextChargeAt: now + rand(600, 1400),

      // stuck watchdog
      lastX: x, lastY: y, stuckCheckAt: now + 800,
    });
  }
}

// --- Hunter (single) helper for pattern placement ---
function spawnHunterAt(x, y) {
  const now = performance.now();
  const spd = Number.isFinite(params.hunterSpeed) && params.hunterSpeed > 0 ? params.hunterSpeed : 1.6;
  let a = rand(0, TAU);
  let vx = Math.cos(a) * spd;
  let vy = Math.sin(a) * spd;
  if (Math.abs(vx) + Math.abs(vy) < 0.001) {
    a = rand(0, TAU);
    vx = Math.cos(a) * spd;
    vy = Math.sin(a) * spd;
  }
  state.hunters.push({
    x, y, vx, vy,
    r: params.hunterR ?? 10,
    spawnGraceUntil: now + (params.hunterSpawnGraceMs ?? 800),
    seed: Math.random() * 1000,
    wanderTheta: rand(0, TAU),
    mode: 'seek',
    lockA: 0,
    windupUntil: 0,
    chargeUntil: 0,
    nextChargeAt: now + rand(600, 1400),
    lastX: x, lastY: y, stuckCheckAt: now + 800,
  });
}

// --- Spheres helper for explicit positions/sizes ---
function spawnSphereAt(x, y, size) {
  const now = performance.now();
  const minR = params.sphereMinR ?? 24;
  const maxR = params.sphereMaxR ?? 80;
  let rMin, rMax;
  if (size === 'L') { rMin = Math.min(maxR, minR + 18); rMax = Math.min(maxR, minR + 28); }
  else if (size === 'M') { rMin = minR + 8; rMax = Math.min(maxR, minR + 16); }
  else { rMin = minR; rMax = Math.min(maxR, minR + 6); }
  const R = rand(rMin, rMax);
  const spd = rand(0.6, 2.2);
  const dir = rand(0, TAU);
  state.spheres.push({
    x, y,
    vx: Math.cos(dir) * spd,
    vy: Math.sin(dir) * spd,
    r: R,
    m: R * R,
    spawnGraceUntil: now + (params.sphereSpawnGraceMs ?? 900),
  });
}

function spawnTankAt(x, y) {
  const now = performance.now();
  const r = rand(params.tankRMin ?? 22, params.tankRMax ?? 30);
  const spd = rand(params.tankSpeedMin ?? 0.4, params.tankSpeedMax ?? 1.0);
  const dir = rand(0, TAU);
  const maxHp = Math.max(2, params.tankHp | 0);
  state.tanks.push({
    x, y,
    vx: Math.cos(dir) * spd,
    vy: Math.sin(dir) * spd,
    r,
    hp: maxHp,
    maxHp,
    spawnGraceUntil: now + (params.sphereSpawnGraceMs ?? 900),
  });
}

// ==============================
// Director: budgets, phases and patterns
// ==============================
function waveBudget(w) {
  const base = params.budgetBase ?? 8;
  const a    = params.budgetA    ?? 3;
  const b    = params.budgetB    ?? 0.5;
  const mult = params.budgetMult ?? 1;
  return Math.max(4, (base + a * w + b * w * w) * mult);
}

function clampDiff(x) { return clamp(x, 0.7, 1.6); }

function buildPhasePayload(budget, hunterCapRemaining) {
  // costs
  const COST = { S: 2, M: 4, L: 7, H: 6, T: 8 };
  let rem = Math.max(0, Math.floor(budget));
  const out = { S: 0, M: 0, L: 0, H: 0, T: 0 };

  while (rem >= Math.min(COST.S, COST.H)) {
    // candidates under budget and respecting hunter cap
    const cand = [];
    if (rem >= COST.S) cand.push('S');
    if (rem >= COST.M) cand.push('M');
    if (rem >= COST.L) cand.push('L');
    if (rem >= COST.H && hunterCapRemaining > 0) cand.push('H');
    if (rem >= COST.T) cand.push('T');
    if (cand.length === 0) break;

    // simple weights to vary mix a bit
    const weights = { S: 5, M: 3, L: 2, H: 3, T: 2 };
    const pickFrom = cand.flatMap(k => Array(weights[k]).fill(k));
    const k = pickFrom[Math.floor(rand(0, pickFrom.length))];

    out[k]++;
    rem -= COST[k];
    if (k === 'H') hunterCapRemaining--;
  }

  // ensure key present for T even if 0
  return { payload: { S: out.S||0, M: out.M||0, L: out.L||0, H: out.H||0, T: out.T||0 }, hunterCapRemaining };
}

function shuffledTypesFromPayload(payload) {
  const arr = [];
  for (let i = 0; i < payload.S; i++) arr.push('S');
  for (let i = 0; i < payload.M; i++) arr.push('M');
  for (let i = 0; i < payload.L; i++) arr.push('L');
  for (let i = 0; i < payload.H; i++) arr.push('H');
  for (let i = 0; i < payload.T; i++) arr.push('T');
  // shuffle
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function patternScatter(payload) {
  const types = shuffledTypesFromPayload(payload);
  for (const t of types) {
    const pt = safeRandomPointAwayFromShip(params.safeSpawnRadius ?? 260);
    if (t === 'H') spawnHunterAt(pt.x, pt.y);
    else if (t === 'T') spawnTankAt(pt.x, pt.y);
    else spawnSphereAt(pt.x, pt.y, t);
  }
}

function patternRing(payload) {
  const types = shuffledTypesFromPayload(payload);
  if (types.length === 0) return;
  const w = canvas.width / dpr(), h = canvas.height / dpr();
  const R = Math.min(Math.min(w, h) * 0.42, (params.safeSpawnRadius ?? 260) + 120);
  const startA = rand(0, TAU);
  const cx = ship.x, cy = ship.y;
  for (let i = 0; i < types.length; i++) {
    const a = startA + (i / types.length) * TAU;
    const x = ((cx + Math.cos(a) * R) + w) % w;
    const y = ((cy + Math.sin(a) * R) + h) % h;
    const t = types[i];
    if (t === 'H') spawnHunterAt(x, y);
    else if (t === 'T') spawnTankAt(x, y);
    else spawnSphereAt(x, y, t);
  }
}

function patternPincer(payload) {
  const types = shuffledTypesFromPayload(payload);
  if (types.length === 0) return;
  const w = canvas.width / dpr(), h = canvas.height / dpr();
  const R = Math.min(Math.min(w, h) * 0.5, (params.safeSpawnRadius ?? 260) + 140);
  const base = rand(0, TAU);
  const sides = [base, base + Math.PI];
  for (let i = 0; i < types.length; i++) {
    const side = sides[i % 2];
    const jitter = rand(-0.35, 0.35);
    const a = side + jitter;
    const cx = ship.x, cy = ship.y;
    const x = ((cx + Math.cos(a) * R) + w) % w;
    const y = ((cy + Math.sin(a) * R) + h) % h;
    const t = types[i];
    if (t === 'H') spawnHunterAt(x, y);
    else if (t === 'T') spawnTankAt(x, y);
    else spawnSphereAt(x, y, t);
  }
}

function announceWave() {
  state.waveMsg = `Wave ${state.wave}`;
  state.showWaveUntil = performance.now() + (params.waveBannerMs ?? 1200);
}

function spawnWave() {
  // clear previous wave
  state.spheres.length      = 0;
  state.hunters.length      = 0;
  state.tanks.length        = 0;
  state.collectibles.length = 0;
  state.spawnQueue.length   = 0;

  const w = canvas.width / dpr(), h = canvas.height / dpr();
  const now = performance.now();

  // --- Director: phased spawn scheduling ---
  const rawBudget = waveBudget(state.wave) * state.difficultyScalar * rand(0.9, 1.1);
  const budget = Math.max(4, Math.floor(rawBudget));

  // hunter cap: at most 40% of cost spent on hunters
  const H_COST = 6; // must match buildPhasePayload
  const hunterFrac = params.directorHunterCapFrac ?? 0.4;
  let hunterCapRemaining = Math.floor((budget * hunterFrac) / H_COST);

  const phases = state.wave >= 3 ? 3 : 2;
  const fracs = phases === 3 ? [0.45, 0.35, 0.20] : [0.6, 0.4];
  const gap = 4500; // ms between phases

  let firstAt = now;
  for (let i = 0; i < phases; i++) {
    const pBudget = Math.max(2, Math.floor(budget * fracs[i]));
    const built = buildPhasePayload(pBudget, hunterCapRemaining);
    hunterCapRemaining = built.hunterCapRemaining;

    // pick a pattern with simple weights (more scatter early)
    const roll = Math.random();
    let pattern = 'scatter';
    if (phases === 3) {
      if (i === 1 && roll < 0.6) pattern = 'ring';
      if (i === 2 && roll < 0.7) pattern = 'pincer';
    } else {
      if (i === 1 && roll < 0.5) pattern = 'ring';
    }

    const at = now + i * gap;
    if (i === 0) firstAt = at;
    state.spawnQueue.push({ at, pattern, payload: built.payload });
  }

  state.waveActiveSince = firstAt;

  // collectibles timing set by update() right after spawning starts
}

// Timed single collectible
function spawnOneCollectible() {
  const pt  = safeRandomPointAwayFromShip(140);
  const dir = rand(0, TAU);
  const spd = params.collectibleSpeed ?? 0.4;

  state.collectibles.push({
    x: pt.x, y: pt.y,
    vx: Math.cos(dir) * spd,
    vy: Math.sin(dir) * spd,
    born: performance.now(),
  });
}

  // ==============================
  // Input
  // ==============================
  const onKeyDown = (e) => {
    state.keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space' && state.charging) fireCharge();
    state.keys.delete(e.code);
  };
  addEventListener('keydown', onKeyDown, { passive: false });
  addEventListener('keyup', onKeyUp);

  // ==============================
  // Shooting
  // ==============================
  function shoot() {
    const now = performance.now();
    if (now - state.lastShotAt < params.bulletCooldown) return;
    state.lastShotAt = now;
    state.charging = true;
    state.chargeStart = now;
  }

  function fireCharge() {
  const now = performance.now();
  const chargeDur = now - state.chargeStart;
  const power = Math.min(1, chargeDur / params.chargeTime);
  const dirx = Math.cos(ship.a);
  const diry = Math.sin(ship.a);


  // Shockwave if charged enough
  if (power >= params.laserMinPower) {
    const shockCost = params.bulletEnergyCost * params.laserEnergyCostMult;
    if (!trySpendEnergy(shockCost)) { state.charging = false; return; }

    state.shockwaves.push({
      x: ship.x,
      y: ship.y,
      born: now,
      duration: params.shockDuration,
      startR: params.shockStartRadius,
      endR: params.shockMaxRadius,
      width: params.shockWidth,
      power
    });

    // No knockback (force is radial + symmetric)
    state.charging = false;
    return;
  }


  // // ----- Laser if charged enough -----
  // if (power >= params.laserMinPower) {
  //   const laserCost = params.bulletEnergyCost * params.laserEnergyCostMult; // e.g. 48%
  //   if (!trySpendEnergy(laserCost)) { state.charging = false; return; }

  //   state.lasers.push({
  //     x: ship.x, y: ship.y, a: ship.a,
  //     born: now, duration: params.laserDuration,
  //     width: params.laserWidthBase +
  //            (params.laserWidthMax - params.laserWidthBase) * power
  //   });

  //   // knockback
  //   const kb = params.bulletSpeed * params.laserKnockback * power;
  //   ship.vx -= dirx * kb;
  //   ship.vy -= diry * kb;
  //   state.charging = false;
  //   return;
  // }

  // ----- Normal shot path: depends on active weapon -----
  const weapon = state.weapons[state.activeWeapon];

  if (weapon === 'homing') {
    // cost
    const cost = params.bulletEnergyCost * (params.homingEnergyCostMult ?? 1.5);
    if (!trySpendEnergy(cost)) { state.charging = false; return; }

    // start forward; steering happens in bullet update
    state.bullets.push({
      kind: 'homing',
      x: ship.x + dirx * ship.r,
      y: ship.y + diry * ship.r,
      vx: ship.vx + dirx * (params.homingSpeed ?? 7),
      vy: ship.vy + diry * (params.homingSpeed ?? 7),
      born: now,
      life: params.homingLife ?? 1400,
      lastSeek: 0,
      target: null
    });

    // slight knockback
    ship.vx -= dirx * params.bulletSpeed * params.knockbackMult * power;
    ship.vy -= diry * params.bulletSpeed * params.knockbackMult * power;

  } else if (weapon === 'fan') {
    const cost = params.bulletEnergyCost * (params.fanEnergyCostMult ?? 1.2);
    if (!trySpendEnergy(cost)) { state.charging = false; return; }

    const baseSpeed = params.bulletSpeed * (1 + power * 1.2) * (params.fanSpeedMult ?? 1);
    const n   = Math.max(2, params.fanCount | 0);
    const arc = (params.fanArcDeg ?? 30) * Math.PI / 180;
    const start = ship.a - arc / 2;

    for (let i = 0; i < n; i++) {
      const a = start + (arc * (n === 1 ? 0.5 : i / (n - 1)));
      const dx = Math.cos(a), dy = Math.sin(a);
      state.bullets.push({
        x: ship.x + dx * ship.r,
        y: ship.y + dy * ship.r,
        vx: ship.vx + dx * baseSpeed,
        vy: ship.vy + dy * baseSpeed,
        born: now,
        power
      });
    }

    const kb = params.bulletSpeed * params.knockbackMult * power * 0.75;
    ship.vx -= Math.cos(ship.a) * kb;
    ship.vy -= Math.sin(ship.a) * kb;

  } else {
    // default single bullet
    if (!trySpendEnergy(params.bulletEnergyCost)) { state.charging = false; return; }

    const speed = params.bulletSpeed * (1 + power * 1.5);
    state.bullets.push({
      x: ship.x + dirx * ship.r,
      y: ship.y + diry * ship.r,
      vx: ship.vx + dirx * speed,
      vy: ship.vy + diry * speed,
      born: now,
      power
    });

    ship.vx -= dirx * params.bulletSpeed * params.knockbackMult * power;
    ship.vy -= diry * params.bulletSpeed * params.knockbackMult * power;
  }

  state.charging = false; // exactly once
}

  // ==============================
  // Particles
  // ==============================
  function burst(x, y, count = 10, color = colors.explosion) {
    for (let i = 0; i < count; i++) {
      const ang = rand(0, TAU), spd = rand(0.5, 3.5);
      state.particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: rand(300, 700),
        born: performance.now(),
        color
      });
    }
  }

  function drawRcsPulse(x, y, angle) {
    const len = params.rcsPulseLength;
    const endX = x + Math.cos(angle) * len;
    const endY = y + Math.sin(angle) * len;
    ctx.strokeStyle = colors.rcs;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }

  function drawEnginePlume(len, width, bend) {
    // Draw a vertical rounded rectangle plume behind the ship (negative X)
    const w = Math.max(2, width);
    const L = Math.max(0, len);
    if (L <= 0) return;

    // Gradient from near ship (-12) backward to -12 - L
    const x0 = -12, x1 = -12 - L;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    const top = colors.plumeTop || '#c97320';
    const mid = colors.plumeMid || '#5a2a00';
    g.addColorStop(0.0, top + 'ee');
    g.addColorStop(0.5, mid + 'aa');
    g.addColorStop(1.0, '#00000000');

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    // Curved plume: quadratic curves with bend offset (positive bends downward)
    const b = bend || 0;
    const cpX = x0 - L * 0.6;
    ctx.beginPath();
    // top edge (start centered near the ship, end offset by bend)
    ctx.moveTo(x0, -w/2);
    ctx.quadraticCurveTo(cpX, -w/2 + b, x1, -w/2 + b);
    // far end down to bottom edge (same bend sign to shift centerline)
    ctx.lineTo(x1,  w/2 + b);
    // bottom edge back
    ctx.quadraticCurveTo(cpX,  w/2 + b, x0,  w/2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ==============================
  // Loop
  // ==============================
  function loop(now) {
    if (state.running) update(now);
    render(now);
    requestAnimationFrame(loop);
  }

function update(now) {
  const w = canvas.width / dpr(), h = canvas.height / dpr();

  // --- Rotation + side RCS visuals
  const rotatingLeft  = state.keys.has('ArrowLeft')  || state.keys.has('KeyA');
  const rotatingRight = state.keys.has('ArrowRight') || state.keys.has('KeyD');
  if (rotatingLeft)  ship.a -= params.rotSpeed;
  if (rotatingRight) ship.a += params.rotSpeed;
  if ((rotatingLeft || rotatingRight) && now - state.lastRotPuffAt > params.rcsPuffCooldown) {
    state.lastRotPuffAt = now;
    if (rotatingRight) state.particles.push({ type: 'rcs', kind: 'right', born: now, life: 110 });
    if (rotatingLeft)  state.particles.push({ type: 'rcs', kind: 'left',  born: now, life: 110 });
  }

  // Angular velocity for plume bending
  {
    const prevA = state.prevAngle || ship.a;
    const dA = Math.atan2(Math.sin(ship.a - prevA), Math.cos(ship.a - prevA));
    state.angVel = dA;
    state.prevAngle = ship.a;
  }

  // --- Main engine
  if (state.keys.has('ArrowUp') || state.keys.has('KeyW')) {
    ship.vx += Math.cos(ship.a) * params.thrust;
    ship.vy += Math.sin(ship.a) * params.thrust;
  }

  // --- Reverse thrust
  if (state.keys.has('ArrowDown') || state.keys.has('KeyS')) {
    ship.vx -= Math.cos(ship.a) * params.reverseThrust;
    ship.vy -= Math.sin(ship.a) * params.reverseThrust;
    if (now - state.lastRcsPuffAt > params.rcsPuffCooldown) {
      state.lastRcsPuffAt = now;
      state.particles.push({ type: 'rcs', kind: 'nose',  born: now, life: 110 });
      state.particles.push({ type: 'rcs', kind: 'left',  born: now, life: 110 });
      state.particles.push({ type: 'rcs', kind: 'right', born: now, life: 110 });
    }
  }

  // --- Shooting trigger
  if (state.keys.has('Space') && !state.charging) shoot();

  // --- Ship physics & wrap
  ship.vx = clamp(ship.vx, -params.maxSpeed, params.maxSpeed);
  ship.vy = clamp(ship.vy, -params.maxSpeed, params.maxSpeed);
  ship.x  += ship.vx; ship.y += ship.vy;
  ship.vx *= params.friction; ship.vy *= params.friction;
  hardWrap(ship, w, h);

  // --- Drain scheduled spawn phases ---
  if (state.spawnQueue.length > 0) {
    // handle any phases due
    const due = [];
    for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
      if (state.spawnQueue[i].at <= now) {
        due.push(state.spawnQueue[i]);
        state.spawnQueue.splice(i, 1);
      }
    }
    for (const phase of due) {
      if (phase.pattern === 'ring') patternRing(phase.payload);
      else if (phase.pattern === 'pincer') patternPincer(phase.payload);
      else patternScatter(phase.payload);
    }
  }

  // =========================================================
  // Bullets (normal + homing)  <— this replaces the stray 'b' block
  // =========================================================
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];

    if (b.kind === 'homing') {
      // (re)acquire target occasionally
      const retargetMs = params.homingRetargetMs ?? 250;
      if (!b.target || (now - (b.lastSeek || 0)) > retargetMs) {
        b.target = nearestTarget(b.x, b.y); // your helper
        b.lastSeek = now;
      }

      // steer toward target if available
      if (b.target && b.target.ref) {
        const tx = b.target.ref.x, ty = b.target.ref.y;
        const curA = Math.atan2(b.vy, b.vx);
        const desA = Math.atan2(ty - b.y, tx - b.x);
        let dA = Math.atan2(Math.sin(desA - curA), Math.cos(desA - curA));
        const maxTurn = params.homingTurnRateRad ?? 0.12;
        if (dA >  maxTurn) dA =  maxTurn;
        if (dA < -maxTurn) dA = -maxTurn;
        const newA = curA + dA;
        const sp = params.homingSpeed ?? 7;
        b.vx = Math.cos(newA) * sp;
        b.vy = Math.sin(newA) * sp;
      } else {
        // no target: keep constant speed
        const a = Math.atan2(b.vy, b.vx);
        const sp = params.homingSpeed ?? 7;
        b.vx = Math.cos(a) * sp;
        b.vy = Math.sin(a) * sp;
      }

      b.x += b.vx; b.y += b.vy;
      hardWrap(b, w, h);
      // lifetime for homing bullets
      if ((b.life ?? 0) > 0 && now - (b.born || 0) > b.life) {
        state.bullets.splice(i, 1);
      }
      continue; // go to next bullet
    }

    // --- normal bullets
    b.x += b.vx; b.y += b.vy;
    hardWrap(b, w, h);
    if (now - (b.born || 0) > params.bulletLife) {
      state.bullets.splice(i, 1);
    }
  }
  // =========================================================

  // --- Spheres move
  for (const s of state.spheres) {
    s.x += s.vx; s.y += s.vy;
    hardWrap(s, w, h);
  }

  // --- Tanks move
  for (const t of state.tanks) {
    t.x += t.vx; t.y += t.vy;
    hardWrap(t, w, h);
  }

  /// --- Hunters: seek + wander + separation + charge
for (let i = 0; i < state.hunters.length; i++) {
  const hu = state.hunters[i];      // <<< don't shadow canvas 'h'
  const W = w, H = h;               // canvas width/height

  // vector toward ship
  let dx = ship.x - hu.x, dy = ship.y - hu.y;
  let dist = Math.hypot(dx, dy) || 1;
  const toShipX = dx / dist, toShipY = dy / dist;

  // current heading (fallback when nearly stopped)
  const heading = Math.atan2(hu.vy || toShipY, hu.vx || toShipX);

  function clampSpeed(maxSp){
    const sp = Math.hypot(hu.vx, hu.vy);
    if (sp > maxSp) { hu.vx = (hu.vx / sp) * maxSp; hu.vy = (hu.vy / sp) * maxSp; }
  }

  if (hu.mode === 'seek') {
    let ax = toShipX * params.hunterAccel;
    let ay = toShipY * params.hunterAccel;

    // wander
    hu.wanderTheta = (hu.wanderTheta ?? 0) + rand(-params.hunterWanderJitter, params.hunterWanderJitter);
    const lateral = heading + Math.PI / 2 + hu.wanderTheta;
    ax += Math.cos(lateral) * params.hunterWanderStrength;
    ay += Math.sin(lateral) * params.hunterWanderStrength;

    // separation
    const sepR = params.hunterSeparationRadius;
    let rx = 0, ry = 0, neighbors = 0;
    for (let j = 0; j < state.hunters.length; j++) if (j !== i) {
      const o = state.hunters[j];
      const sdx = hu.x - o.x, sdy = hu.y - o.y;
      const d = Math.hypot(sdx, sdy);
      if (d > 0 && d < sepR) {
        const wgt = (sepR - d) / sepR;
        rx += (sdx / d) * wgt; ry += (sdy / d) * wgt; neighbors++;
      }
    }
    if (neighbors > 0) {
      ax += (rx / neighbors) * params.hunterSeparationStrength * 0.1;
      ay += (ry / neighbors) * params.hunterSeparationStrength * 0.1;
    }

    // integrate
    hu.vx = (hu.vx + ax) * params.hunterDrag;
    hu.vy = (hu.vy + ay) * params.hunterDrag;
    clampSpeed(params.hunterMaxSpeed);

    // start windup if close & roughly aimed
    const canTry = now >= (hu.nextChargeAt || 0) && dist < params.hunterChargeTriggerDist;
    if (canTry) {
      const aimA = Math.atan2(toShipY, toShipX);
      let dA = Math.atan2(Math.sin(aimA - heading), Math.cos(aimA - heading));
      if (Math.abs(dA) < params.hunterChargeAimConeRad) {
        hu.mode = 'windup';
        hu.lockA = aimA;
        hu.windupUntil = now + params.hunterChargeWindupMs;
      }
    }

  } else if (hu.mode === 'windup') {
    const turn = 0.12;
    const dA = Math.atan2(Math.sin(hu.lockA - heading), Math.cos(hu.lockA - heading));
    const newHeading = heading + clamp(dA, -turn, turn);
    const sp = Math.hypot(hu.vx, hu.vy) * 0.98;
    hu.vx = Math.cos(newHeading) * sp;
    hu.vy = Math.sin(newHeading) * sp;

    if (now >= hu.windupUntil) {
      hu.mode = 'charge';
      hu.chargeUntil = now + params.hunterChargeDurationMs;
      const dashSp = params.hunterMaxSpeed * params.hunterChargeSpeedMult;
      hu.vx = Math.cos(hu.lockA) * dashSp;
      hu.vy = Math.sin(hu.lockA) * dashSp;
    }

  } else if (hu.mode === 'charge') {
    hu.vx *= params.hunterChargeDrag;
    hu.vy *= params.hunterChargeDrag;
    if (now >= hu.chargeUntil) {
      hu.mode = 'recover';
      hu.recoverUntil = now + 260;
      hu.nextChargeAt = now + params.hunterChargeCooldownMs;
    }

  } else if (hu.mode === 'recover') {
    hu.vx *= params.hunterRecoverDrag;
    hu.vy *= params.hunterRecoverDrag;
    if (now >= hu.recoverUntil) hu.mode = 'seek';
  }

  // move + wrap (use canvas height `h`, not the hunter!)
  hu.x += hu.vx; hu.y += hu.vy;
  hardWrap(hu, W, H);
}

  // --- Timed collectibles
  if (state.waveStartAt === 0 &&
      state.collectibles.length < params.collectibleMaxConcurrent &&
      now >= state.nextCollectibleAt) {
    spawnOneCollectible();
    state.nextCollectibleAt = now + rand(params.collectibleSpawnMinMs, params.collectibleSpawnMaxMs);
  }

  // --- Sphere vs sphere collisions (elastic)
  for (let i = 0; i < state.spheres.length; i++) {
    for (let j = i + 1; j < state.spheres.length; j++) {
      const a = state.spheres[i], b = state.spheres[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r;
      if (dist < minDist && dist > 0) {
        const nx = dx / dist, ny = dy / dist;
        const overlap = 0.5 * (minDist - dist);
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
        const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
        const vn = dvx * nx + dvy * ny;
        if (vn < 0) {
          const bounce = 0.4;
          const ma = a.m, mb = b.m;
          const jImpulse = -(1 + bounce) * vn / (1/ma + 1/mb);
          a.vx -= (jImpulse / ma) * nx; a.vy -= (jImpulse / ma) * ny;
          b.vx += (jImpulse / mb) * nx; b.vy += (jImpulse / mb) * ny;
        }
      }
    }
  }

  // --- Collectibles drift & wrap
  for (const c of state.collectibles) {
    c.x += c.vx; c.y += c.vy;
    hardWrap(c, w, h);
  }


  // --- Shockwaves collide with spheres & hunters, then expire
  for (let wi = state.shockwaves.length - 1; wi >= 0; wi--) {
  const sw = state.shockwaves[wi];
  const age = now - sw.born;
  if (age > sw.duration) { state.shockwaves.splice(wi, 1); continue; }

  // eased radius
  const t  = Math.max(0, Math.min(1, age / sw.duration));
  const tt = t*t*(3 - 2*t);
  const outerR = sw.startR + (sw.endR - sw.startR) * tt;

  // ring band
  const innerR = Math.max(0, outerR - sw.width);
  const hitInnerR = innerR * (params.shockFalloffInner ?? 0.5);

  const cx = sw.x, cy = sw.y;

  // spheres
  for (let si = state.spheres.length - 1; si >= 0; si--) {
    const s = state.spheres[si];
    const d = Math.hypot(s.x - cx, s.y - cy);
    if (d + s.r >= hitInnerR && d - s.r <= outerR) {
      state.spheres.splice(si, 1);
      burst(s.x, s.y, 14);
      addScore(10 + Math.round(46 - s.r));
      const newR = s.r * params.sphereSplitFactor;
      if (newR > params.sphereMinR) {
        const ang = rand(0, TAU);
        const spd1 = rand(1.2, 2.6), spd2 = rand(1.2, 2.6);
        state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang)*spd1,        vy: Math.sin(ang)*spd1,        r: newR, m: newR*newR });
        state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang+Math.PI)*spd2, vy: Math.sin(ang+Math.PI)*spd2, r: newR, m: newR*newR });
      }
    }
  }

  // hunters (include radius so grazing the ring counts)
  for (let hi = state.hunters.length - 1; hi >= 0; hi--) {
    const h = state.hunters[hi];
    if (now <= (h.spawnGraceUntil || 0)) continue;
    const d = Math.hypot(h.x - cx, h.y - cy);
    if (d <= outerR + h.r && d >= hitInnerR - h.r) {
      state.hunters.splice(hi, 1);
      burst(h.x, h.y, 16, colors.rcs);
      addScore(params.hunterScore || 25);
    }
  }

  // tanks: deal fixed damage per pass through ring band
  for (let ti = state.tanks.length - 1; ti >= 0; ti--) {
    const tnk = state.tanks[ti];
    if (now <= (tnk.spawnGraceUntil || 0)) continue;
    const d = Math.hypot(tnk.x - cx, tnk.y - cy);
    if (d <= outerR + tnk.r && d >= hitInnerR - tnk.r) {
      tnk.hp -= (params.tankShockwaveDamage || 2);
      if (tnk.hp <= 0) {
        state.tanks.splice(ti, 1);
        burst(tnk.x, tnk.y, 16, colors.rcs);
        addScore(params.tankScore || 60);
      }
    }
  }
}


  
  // // --- Lasers hit spheres & hunters
  // for (let i = state.lasers.length - 1; i >= 0; i--) {
  //   const L = state.lasers[i];
  //   const age = now - L.born;
  //   if (age > L.duration) { state.lasers.splice(i, 1); continue; }
  //   const maxLen = Math.hypot(w, h) * 1.2;
  //   const x1 = L.x, y1 = L.y;
  //   const x2 = x1 + Math.cos(L.a) * maxLen;
  //   const y2 = y1 + Math.sin(L.a) * maxLen;

  //   for (let si = state.spheres.length - 1; si >= 0; si--) {
  //     const s = state.spheres[si];
  //     if (lineCircleHit(x1, y1, x2, y2, s.x, s.y, s.r)) {
  //       state.spheres.splice(si, 1);
  //       burst(s.x, s.y, 14);
  //       addScore(10 + Math.round(46 - s.r));
  //       const newR = s.r * params.sphereSplitFactor;
  //       if (newR > params.sphereMinR) {
  //         const ang = rand(0, TAU);
  //         const spd1 = rand(1.2, 2.6), spd2 = rand(1.2, 2.6);
  //         state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang)*spd1, vy: Math.sin(ang)*spd1, r: newR, m: newR*newR });
  //         state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang+Math.PI)*spd2, vy: Math.sin(ang+Math.PI)*spd2, r: newR, m: newR*newR });
  //       }
  //     }
  //   }

  //   for (let hi = state.hunters.length - 1; hi >= 0; hi--) {
  //     const hu = state.hunters[hi];
  //     if (now <= (hu.spawnGraceUntil || 0)) continue;
  //     if (lineCircleHit(x1, y1, x2, y2, hu.x, hu.y, hu.r)) {
  //       state.hunters.splice(hi, 1);
  //       burst(hu.x, hu.y, 16, colors.rcs);
  //       addScore(params.hunterScore || 25);
  //     }
  //   }
  // }

  // --- Bullets vs spheres
  for (let i = state.spheres.length - 1; i >= 0; i--) {
    const s = state.spheres[i];
    for (let j = state.bullets.length - 1; j >= 0; j--) {
      const b = state.bullets[j];
      if (circlePointHit(s.x, s.y, s.r, b.x, b.y)) {
        state.bullets.splice(j, 1);
        state.spheres.splice(i, 1);
        burst(s.x, s.y, 12);
        addScore(10 + Math.round(46 - s.r));
        const newR = s.r * params.sphereSplitFactor;
        if (newR > params.sphereMinR) {
          const ang = rand(0, TAU);
          const spd1 = rand(1.2, 2.6), spd2 = rand(1.2, 2.6);
          state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang)*spd1, vy: Math.sin(ang)*spd1, r: newR, m: newR*newR });
          state.spheres.push({ x: s.x, y: s.y, vx: Math.cos(ang+Math.PI)*spd2, vy: Math.sin(ang+Math.PI)*spd2, r: newR, m: newR*newR });
        }
        break;
      }
    }
  }

  // --- Bullets vs tanks (multi-hit)
  for (let i = state.tanks.length - 1; i >= 0; i--) {
    const tnk = state.tanks[i];
    for (let j = state.bullets.length - 1; j >= 0; j--) {
      const b = state.bullets[j];
      if (circlePointHit(tnk.x, tnk.y, tnk.r, b.x, b.y)) {
        state.bullets.splice(j, 1);
        tnk.hp -= 1;
        if (tnk.hp <= 0) {
          state.tanks.splice(i, 1);
          burst(tnk.x, tnk.y, 14);
          addScore(params.tankScore || 60);
        }
        break;
      }
    }
  }

  // --- Bullets vs hunters
  for (let i = state.hunters.length - 1; i >= 0; i--) {
    const htr = state.hunters[i];
    for (let j = state.bullets.length - 1; j >= 0; j--) {
      const b = state.bullets[j];
      if (circlePointHit(htr.x, htr.y, htr.r, b.x, b.y)) {
        state.bullets.splice(j, 1);
        state.hunters.splice(i, 1);
        burst(htr.x, htr.y, 12);
        addScore(params.hunterScore || 30);
        if (typeof setEnergy === 'function' && params.hunterEnergyDropPct) {
          setEnergy(state.energy + params.hunterEnergyDropPct);
        }
        break;
      }
    }
  }

  // --- Ship vs spheres / hunters
  if (now > state.invulnUntil) {
    for (const s of state.spheres) {
      if (now <= (s.spawnGraceUntil || 0)) continue;
      if (circleCircleHit({ x: ship.x, y: ship.y, r: getShipHitR() }, s)) {
        burst(ship.x, ship.y, 24);
        loseLife();
        break;
      }
    }
    for (const h of state.hunters) {
      if (now <= (h.spawnGraceUntil || 0)) continue;
      if (circleCircleHit({ x: ship.x, y: ship.y, r: getShipHitR() }, { x: h.x, y: h.y, r: h.r })) {
        const charging = h.mode === 'charge';
        burst(ship.x, ship.y, charging ? 36 : 24);
        loseLife();
        if (charging) {
          const back = Math.atan2(ship.y - h.y, ship.x - h.x) + Math.PI;
          const kick = 3.0;
          h.vx = Math.cos(back) * kick;
          h.vy = Math.sin(back) * kick;
          h.mode = 'recover';
          h.recoverUntil = now + 300;
          h.nextChargeAt = now + params.hunterChargeCooldownMs;
        }
        break;
      }
    }
    for (const t of state.tanks) {
      if (now <= (t.spawnGraceUntil || 0)) continue;
      if (circleCircleHit({ x: ship.x, y: ship.y, r: getShipHitR() }, { x: t.x, y: t.y, r: t.r })) {
        burst(ship.x, ship.y, 28);
        loseLife();
        break;
      }
    }
  }

  // --- Ship collects energy pickups
  for (let i = state.collectibles.length - 1; i >= 0; i--) {
    const c = state.collectibles[i];
    const t = (now - c.born) / 1000;
    const r = params.collectibleBaseR +
              Math.sin(t * params.collectiblePulseSpeed) * params.collectiblePulseAmp;
    if (circleCircleHit({ x: ship.x, y: ship.y, r: getShipHitR() }, { x: c.x, y: c.y, r })) {
      addScore(params.collectibleScore);
      state.collected++;
      burst(c.x, c.y, 10, colors.rcs);
      setEnergy(Math.min(params.energyMax, state.energy + params.collectibleEnergyRestore));
      state.collectibles.splice(i, 1);
    }
  }

  // --- Particle lifetimes
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    if (p.type === 'rcs') {
      if (now - p.born > p.life) state.particles.splice(i, 1);
    } else {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.vy *= 0.99;
      if (now - p.born > p.life) state.particles.splice(i, 1);
    }
  }

  // --- Passive energy regen (slow, only after not firing for a bit) ---
  const dt = state.prevUpdateAt ? (now - state.prevUpdateAt) / 1000 : 0;
  state.prevUpdateAt = now;

  // no regen if we're actively charging a shot
  const idleLongEnough = (now - state.lastShotAt) >= (params.energyRegenDelayMs ?? 1500);
  if (idleLongEnough && !state.charging && state.energy < params.energyMax) {
    const rate = params.energyRegenPerSec ?? 6; // % per second
    setEnergy(state.energy + rate * dt);
}





  // --- Wave scheduling
  if (state.spheres.length === 0 && state.hunters.length === 0 && state.tanks.length === 0 && state.collectibles.length === 0 && state.spawnQueue.length === 0 && state.waveStartAt === 0) {
    // collect stats and adapt difficulty
    if (state.waveActiveSince) {
      const clearMs = now - state.waveActiveSince;
      state.lastWaveStats = { clearMs, deaths: state.waveDeaths };
      let s = state.difficultyScalar;
      if (state.waveDeaths > 0) s *= 0.9;
      else if (clearMs < 12000) s *= 1.08;
      else if (clearMs > 28000) s *= 0.95;
      state.difficultyScalar = clampDiff(s);
      state.waveDeaths = 0;
      state.waveActiveSince = 0;
    }

    state.wave++;
    announceWave();
    state.waveStartAt = now + params.waveBannerMs;
    state.invulnUntil = state.waveStartAt + params.invulnAfterSpawnMs;
  }
  if (state.waveStartAt && now >= state.waveStartAt && state.spheres.length === 0 && state.hunters.length === 0 && state.tanks.length === 0) {
    spawnWave();
    state.waveStartAt = 0;
    state.nextCollectibleAt = now + rand(params.collectibleSpawnMinMs, params.collectibleSpawnMaxMs);
  }
}

  function render(now) {
    const w = canvas.width / dpr(), h = canvas.height / dpr();

    // Background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Wave banner
    if (state.showWaveUntil > now && state.waveMsg) {
      const t = 1 - (state.showWaveUntil - now) / params.waveBannerMs; // 0..1
      // ease in/out alpha (quick in, quick out)
      const alpha = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
      ctx.save();
      ctx.globalAlpha = 0.85 * alpha;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 48px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 12;
      ctx.fillText(state.waveMsg, (canvas.width / dpr()) / 2, (canvas.height / dpr()) / 2);
      ctx.restore();
    }

    // RCS pulses anchored to ship (fade over life)
    for (const p of state.particles) {
      if (p.type !== 'rcs') continue;
      const t = (now - p.born) / p.life;
      if (t > 1) continue;
      const { x, y, angle } = rcsAnchor(p.kind);
      ctx.globalAlpha = 1 - t;
      drawRcsPulse(x, y, angle);
      ctx.globalAlpha = 1;
    }

    // Other particles (explosions)
    for (const p of state.particles) {
      if (p.type === 'rcs') continue;
      const t = (now - p.born) / p.life;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, TAU); ctx.fillStyle = p.color || colors.explosion; ctx.fill();
      ctx.globalAlpha = 1;
    }


    // Shockwaves (glowy ring that expands and fades)
    for (const W of state.shockwaves) {
    const age = now - W.born;
    const t = Math.max(0, Math.min(1, age / W.duration));
    const tt = t*t*(3 - 2*t);
    const outerR = W.startR + (W.endR - W.startR) * tt;
    const innerR = Math.max(0, outerR - W.width);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // soft glow
    ctx.beginPath();
    ctx.arc(W.x, W.y, outerR, 0, TAU);
    ctx.arc(W.x, W.y, innerR, 0, TAU, true);
    ctx.closePath();

    ctx.globalAlpha = 0.35 * (1 - t);
    ctx.fillStyle = colors.rcs;  // theme glow
    ctx.fill('evenodd');

    // bright edge
    ctx.globalAlpha = 0.9 * (1 - t);
    ctx.lineWidth = Math.max(2, W.width * 0.35);
    ctx.strokeStyle = colors.bullet; // bright core color
    ctx.beginPath();
    ctx.arc(W.x, W.y, (innerR + outerR) * 0.5, 0, TAU);
    ctx.stroke();

    ctx.restore();
  }


    // // Lasers
    // for (const L of state.lasers) {
    //   const age = now - L.born;
    //   const t = 1 - (age / L.duration);
    //   const width = L.width * (0.85 + 0.15 * t);

    //   const maxLen = Math.hypot(w, h) * 1.2;
    //   const x1 = L.x, y1 = L.y;
    //   const x2 = x1 + Math.cos(L.a) * maxLen;
    //   const y2 = y1 + Math.sin(L.a) * maxLen;

    //   ctx.save();
    //   ctx.globalCompositeOperation = 'lighter';

    //   // glow
    //   ctx.strokeStyle = colors.rcs;
    //   ctx.globalAlpha = 0.35 * t;
    //   ctx.lineWidth = width * 2.2;
    //   ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    //   // core
    //   ctx.strokeStyle = colors.bullet;
    //   ctx.globalAlpha = 0.9 * t;
    //   ctx.lineWidth = width;
    //   ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    //   ctx.restore();
    // }

    // Spheres (single radial gradient only)
    for (const s of state.spheres) {
      const r = s.r;
      // light direction (screen space): towards bottom-right
      const lx = 0.78, ly = 0.62;
      const off = params.sphereLightOffset ?? 0.38;
      const phx = s.x + lx * r * off;
      const phy = s.y + ly * r * off;

      // single diffuse radial gradient, no outlines or linear fades
      const innerFrac = params.sphereLightInnerFrac ?? 0.55;
      const g = ctx.createRadialGradient(phx, phy, r * innerFrac, s.x, s.y, r);
      g.addColorStop(0,   colors.sphereAlbedo || '#cfb0d8');
      g.addColorStop(1.0, colors.sphereShadow || '#24112d');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, TAU);
      ctx.fill();
    }

    // Tanks (multi-hit) — color shifts towards red as hp drops
    const RED = { r: 255, g: 77, b: 77 };
    function hexToRgb(hex){
      const s = hex.replace('#','');
      const n = parseInt(s.length===3 ? s.split('').map(c=>c+c).join('') : s, 16);
      return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
    }
    function rgbToHex({r,g,b}){
      const to = (v)=> v.toString(16).padStart(2,'0');
      return `#${to(r)}${to(g)}${to(b)}`;
    }
    function mix(a,b,t){ return { r: Math.round(a.r+(b.r-a.r)*t), g: Math.round(a.g+(b.g-a.g)*t), b: Math.round(a.b+(b.b-a.b)*t) }; }

    const baseTankRGB = hexToRgb(colors.tankBase || '#6affff');
    for (const t of state.tanks) {
      const dmg = 1 - (t.hp / t.maxHp);
      const col = mix(baseTankRGB, RED, clamp(dmg, 0, 1));
      ctx.fillStyle = rgbToHex(col);
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = colors.shipOutline; ctx.stroke();
    }


    // --- Hunters ---
for (const h of state.hunters) {
  ctx.save();
  ctx.translate(h.x, h.y);

  // --- stuck/NaN watchdog ---
if (!Number.isFinite(h.vx) || !Number.isFinite(h.vy)) {
  // recover from NaN by re-seeding velocity
  const sp = Number.isFinite(params.hunterSpeed) && params.hunterSpeed > 0 ? params.hunterSpeed : 1.6;
  const a = rand(0, TAU);
  h.vx = Math.cos(a) * sp;
  h.vy = Math.sin(a) * sp;
}

if (now >= (h.stuckCheckAt || 0)) {
  const movedDist = Math.hypot((h.x - (h.lastX ?? h.x)), (h.y - (h.lastY ?? h.y)));
  // consider "stuck" if it moved less than 2px over ~800ms
  if (movedDist < 2) {
    const sp = Math.max(1.2, params.hunterSpeed || 1.6);
    const a = rand(0, TAU);
    h.vx = Math.cos(a) * sp;
    h.vy = Math.sin(a) * sp;

    // if it’s hugging a corner, nudge it inward
    const NUDGE = 12;
    if (h.x < NUDGE) h.x = NUDGE;
    if (h.y < NUDGE) h.y = NUDGE;
    if (h.x > W - NUDGE) h.x = W - NUDGE;
    if (h.y > H - NUDGE) h.y = H - NUDGE;
  }
  h.lastX = h.x; h.lastY = h.y;
  h.stuckCheckAt = now + 800;
}

  // point in direction of travel
  const ang = Math.atan2(h.vy, h.vx);
  ctx.rotate(ang);

  // body (little arrow/diamond)
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.lineTo(-8, -8);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-8, 8);
  ctx.closePath();
  ctx.fillStyle  = (colors.hunter || '#ff6161');
  ctx.fill();

  // // optional eye
  // ctx.beginPath();
  // ctx.arc(5, 0, 2, 0, TAU);
  // ctx.fillStyle = colors.bullet || '#fff';
  // ctx.fill();

  // inside hunters render loop, before ctx.restore()
  if (h.mode === 'windup') {
    // draw a faint line in lockA as a tell
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = colors.hunterOutline || '#ffffff55';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(42, 0); // since we've rotated to heading earlier, consider rotating to h.lockA if you want exact
    ctx.stroke();
    ctx.restore();
  }
  if (h.mode === 'charge') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = colors.hunter || '#ff6161';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(14, 0);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore(); // <<< important!
}


    // Collectibles (pulsing)
    for (const c of state.collectibles) {
      const t = (now - c.born) / 1000;
      const r = params.collectibleBaseR +
                Math.sin(t * params.collectiblePulseSpeed) * params.collectiblePulseAmp;

      // glow
      const g = ctx.createRadialGradient(c.x, c.y, 1, c.x, c.y, r * 2.2);
      g.addColorStop(0, colors.rcs);
      g.addColorStop(1, '#00000000');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.2, 0, TAU); ctx.fill();

      // core
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU);
      ctx.fillStyle = colors.bullet; ctx.fill();
    ctx.strokeStyle = colors.shipOutline; ctx.stroke();
    }

    // Bullets (round) with trails — draw before ship so ship covers trails
    {
      const br = (params.bulletSize ?? 3) / 2;
      const trailBase = params.bulletTrailLen ?? 14;
      const trailW = params.bulletTrailWidth ?? 2;
      const trailSpMul = params.bulletTrailSpeedMult ?? 0.5;
      for (const b of state.bullets) {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const dx = (b.vx || 0) / sp;
        const dy = (b.vy || 0) / sp;
        const len = trailBase + sp * trailSpMul;
        const x2 = b.x - dx * len;
        const y2 = b.y - dy * len;
        // trail
        const g = ctx.createLinearGradient(b.x, b.y, x2, y2);
        const headCol = (colors.bullet || '#ffffff') + 'ee';
        g.addColorStop(0, headCol);
        g.addColorStop(1, '#0000');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = g;
        ctx.lineWidth = trailW;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();

        // head
        ctx.fillStyle = colors.bullet;
        ctx.beginPath();
        ctx.arc(b.x, b.y, br, 0, TAU);
        ctx.fill();
      }
    }

    // Ship (SVG with canvas effects fallback)
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.a);
    const inv = now < state.invulnUntil;
    ctx.globalAlpha = 1;

    // Engine plume behind hull (long rectangular gradient)
    const thrusting = state.keys.has('ArrowUp') || state.keys.has('KeyW');
    const speed = Math.hypot(ship.vx, ship.vy);
    const base = params.plumeBaseLen ?? 42;
    const maxL = params.plumeMaxLen ?? 160;
    const target = thrusting ? Math.min(maxL, base + speed * 10) : 0;
    const lerp = (params.plumeLerp ?? 0.18);
    state.plumeLen = (state.plumeLen || 0) * (1 - lerp) + target * lerp;

    // Compute lateral velocity in ship-local space (perpendicular component)
    const ca = Math.cos(ship.a), sa = Math.sin(ship.a);
    const localVY = -sa * ship.vx + ca * ship.vy; // +Y is to ship's right (screen-down when a≈0)
    const vNorm = clamp(localVY / (params.maxSpeed || 10), -1, 1);
    const wNorm = params.rotSpeed ? clamp(state.angVel / params.rotSpeed, -1, 1) : 0;

    const maxBend = (params.plumeCurveFrac ?? 0.28) * state.plumeLen;
    let bendTarget = 0;
    if (thrusting) {
      bendTarget = (vNorm * (params.plumeVelBias ?? 0.45) + wNorm * (params.plumeTurnBias ?? 0.25)) * state.plumeLen;
      bendTarget = clamp(bendTarget, -maxBend, maxBend);
    }
    state.plumeBend = (state.plumeBend || 0) * (1 - lerp) + bendTarget * lerp;
    drawEnginePlume(state.plumeLen, params.plumeWidth ?? 16, state.plumeBend);

    if (shipImgReady) {
      // Scale SVG to match old hull scale (ship.r ~= 12)
      const s = ship.r / 12;
      ctx.scale(s, s);
      ctx.drawImage(shipImg, -shipImgW / 2, -shipImgH / 2, shipImgW, shipImgH);
    } else {
      // Fallback hull (original path)
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-12, -9); ctx.lineTo(-6, 0); ctx.lineTo(-12, 9); ctx.closePath();
      ctx.fillStyle = colors.ship; ctx.fill();
      ctx.strokeStyle = colors.shipOutline; ctx.stroke();
    }
    ctx.restore();
    
    // Invulnerability ring (blink) — draw around ship while invuln
    if (inv) {
      const baseR = (params.invulnRingScale ?? 1.9) * getShipHitR();
      const period = params.invulnRingPulseMs ?? 900;
      const phase = (now % period) / period;
      const osc = Math.sin(phase * TAU);
      const alpha = 0.25 + 0.35 * (0.5 + 0.5 * osc);
      const R = baseR * (1 + (params.invulnRingPulseScale ?? 0.06) * osc);
      const back = params.invulnRingBackPx ?? 0;
      const cx = ship.x - Math.cos(ship.a) * back;
      const cy = ship.y - Math.sin(ship.a) * back;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colors.invulnRing || colors.engineFlame || '#ffa34d';
      ctx.lineWidth = params.invulnRingWidth ?? 3;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Pause overlay
    if (!state.running) {
      ctx.fillStyle = '#ffffffcc';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Paused', w / 2, h / 2);
    }
  }

  // ==============================
  // Hotkeys: pause, restart, theme
  // ==============================
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') state.running = !state.running;
    if (e.code === 'KeyR') {
      state.wave = 1;
      state.score = 0;
      announceWave();
      if (scoreEl) scoreEl.textContent = `Score: ${state.score}`;
      state.lives = 3;
      if (livesEl) livesEl.textContent = `Lives: ${state.lives}`;
      setEnergy(params.energyMax);
      resetShip();
      spawnWave();
    }
    if (e.code === 'KeyT') {
      const keys = Object.keys(themes);
      const current = keys.find(k => themes[k] === colors);
      const next = keys[(keys.indexOf(current) + 1) % keys.length];
      colors = themes[next];
      console.log(`Theme: ${next}`);
    }
    if (e.code === 'KeyQ') {
      state.activeWeapon = (state.activeWeapon + 1) % state.weapons.length;
      console.log('Weapon:', state.weapons[state.activeWeapon]);
    }
  });

  // ==============================
  // Init
  // ==============================
  setEnergy(state.energy);
  resetShip();
  state.wave = 1;
  announceWave();
  state.waveStartAt = performance.now() + params.waveBannerMs;

  requestAnimationFrame(loop);
})();
