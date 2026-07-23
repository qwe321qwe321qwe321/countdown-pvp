// Host-authoritative simulation.
// The entire game state lives in `sim` and only advances through stepSim(sim, inputs, dt).
// Inputs are plain data ({moveX, moveY, aimX, aimY, shootMinus, shootPlus, shield}) so in a
// networked build clients submit inputs and only the host runs stepSim; clients render
// the synced state. Nothing in here reads the mouse/keyboard directly.

function vlen(x, y) { return Math.hypot(x, y); }

function clampToArena(x, y, r) {
  return [
    Math.min(CONFIG.ARENA_W - r, Math.max(r, x)),
    Math.min(CONFIG.ARENA_H - r, Math.max(r, y)),
  ];
}

// Push a circle out of an axis-aligned rect. Returns [x, y].
function circleVsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  const d = vlen(dx, dy);
  if (d >= r || d === 0) {
    if (d === 0) return [cx, cy - r]; // center inside rect: eject upward (rare in practice)
    return [cx, cy];
  }
  return [nx + (dx / d) * r, ny + (dy / d) * r];
}

function circleHitsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return vlen(cx - nx, cy - ny) < r;
}

function createPlayer(id, name, x, y, color, isAI) {
  return {
    id, name, color, isAI,
    x, y,
    spawnX: x, spawnY: y,
    radius: CONFIG.PLAYER_RADIUS,
    alive: true,
    spectator: false,
    coins: 0,
    cards: [],
    coinTimer: 0,
    cardTimer: 0,
    shootCd: 0,
    shieldTimer: 0,     // >0 while shield active
    shieldCd: 0,        // >0 while recharging
    aimX: x, aimY: y - 1,
    wins: 0,
  };
}

function createSim() {
  const sim = {
    time: 0,
    round: 1,
    players: [
      createPlayer(0, 'YOU', 240, 320, '#5ab0f0', false),
      createPlayer(1, 'BOT', 720, 320, '#f0885a', true),
    ],
    walls: [
      { x: 430, y: 120, w: 100, h: 40 },
      { x: 430, y: 480, w: 100, h: 40 },
      { x: 140, y: 290, w: 40, h: 60 },
      { x: 780, y: 290, w: 40, h: 60 },
    ],
    bomb: {
      holderId: 0,
      offX: 0, offY: -CONFIG.BOMB_MIN_DIST,  // arm-controlled local offset
      x: 0, y: 0,                            // derived world position (holder pos + offset)
      timer: CONFIG.BOMB_START_TIME,
      radius: CONFIG.BOMB_RADIUS,
      transferCd: 0,
    },
    projectiles: [],
    fx: [],            // transient visual effects [{x, y, t, kind, text}]
    match: {
      state: 'playing',          // 'playing' | 'roundover'
      timer: 0,
      message: '',
    },
  };
  updateBombWorldPos(sim);
  return sim;
}

function getPlayer(sim, id) { return sim.players.find(p => p.id === id); }

function updateBombWorldPos(sim) {
  const holder = getPlayer(sim, sim.bomb.holderId);
  sim.bomb.x = holder.x + sim.bomb.offX;
  sim.bomb.y = holder.y + sim.bomb.offY;
  const [bx, by] = clampToArena(sim.bomb.x, sim.bomb.y, sim.bomb.radius);
  sim.bomb.x = bx; sim.bomb.y = by;
}

function addFx(sim, x, y, kind, text) {
  sim.fx.push({ x, y, kind, text: text || '', t: 0 });
}

function canAct(p) { return p.alive && !p.spectator; }

function stepSim(sim, inputs, dt) {
  sim.time += dt;

  // Decay visual effects regardless of match state.
  for (const f of sim.fx) f.t += dt;
  sim.fx = sim.fx.filter(f => f.t < 1.0);

  if (sim.match.state === 'roundover') {
    sim.match.timer -= dt;
    if (sim.match.timer <= 0) startNextRound(sim);
    return;
  }

  const bomb = sim.bomb;
  bomb.transferCd = Math.max(0, bomb.transferCd - dt);

  // --- Players: movement, timers, economy ---
  for (const p of sim.players) {
    const inp = inputs[p.id] || {};
    p.shootCd = Math.max(0, p.shootCd - dt);
    p.shieldCd = Math.max(0, p.shieldCd - dt);
    p.shieldTimer = Math.max(0, p.shieldTimer - dt);

    if (!canAct(p)) continue; // spectators cannot move, shoot, shield, or earn anything

    p.aimX = inp.aimX ?? p.aimX;
    p.aimY = inp.aimY ?? p.aimY;

    let mx = inp.moveX || 0, my = inp.moveY || 0;
    const ml = vlen(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    p.x += mx * CONFIG.PLAYER_SPEED * dt;
    p.y += my * CONFIG.PLAYER_SPEED * dt;
    [p.x, p.y] = clampToArena(p.x, p.y, p.radius);
    for (const w of sim.walls) [p.x, p.y] = circleVsRect(p.x, p.y, p.radius, w);

    // Coins / cards accrue only while alive; wiped on death.
    p.coinTimer += dt;
    while (p.coinTimer >= CONFIG.COIN_INTERVAL) { p.coinTimer -= CONFIG.COIN_INTERVAL; p.coins++; }
    p.cardTimer += dt;
    while (p.cardTimer >= CONFIG.CARD_INTERVAL) {
      p.cardTimer -= CONFIG.CARD_INTERVAL;
      if (p.cards.length < CONFIG.MAX_CARDS) p.cards.push('card');
    }
  }

  // --- Bomb arm control (holder only) ---
  const holder = getPlayer(sim, bomb.holderId);
  {
    const inp = inputs[holder.id] || {};
    if (canAct(holder)) {
      // Target offset = mouse position relative to the holder, clamped to BombArmReach.
      let tx = (inp.aimX ?? holder.aimX) - holder.x;
      let ty = (inp.aimY ?? holder.aimY) - holder.y;
      let tl = vlen(tx, ty);
      if (tl < 1e-6) { tx = 0; ty = -1; tl = 1; }
      const dist = Math.min(CONFIG.BOMB_ARM_REACH, Math.max(CONFIG.BOMB_MIN_DIST, tl));
      tx = (tx / tl) * dist; ty = (ty / tl) * dist;
      // Smooth follow so arms feel physical rather than teleporting.
      const k = Math.min(1, CONFIG.BOMB_FOLLOW_RATE * dt);
      bomb.offX += (tx - bomb.offX) * k;
      bomb.offY += (ty - bomb.offY) * k;

      // Shield only affects the bomb collider, and only the holder can raise it.
      if (inp.shield && p_shieldReady(holder)) {
        holder.shieldTimer = CONFIG.SHIELD_DURATION;
        holder.shieldCd = CONFIG.SHIELD_COOLDOWN;
      }
    }
  }
  updateBombWorldPos(sim);

  // --- Bomb transfer: touching the holder takes the bomb ---
  if (bomb.transferCd <= 0) {
    for (const p of sim.players) {
      if (p.id === bomb.holderId || !canAct(p)) continue;
      if (vlen(p.x - holder.x, p.y - holder.y) < p.radius + holder.radius) {
        bomb.holderId = p.id;
        bomb.transferCd = CONFIG.TRANSFER_COOLDOWN;
        // Hand the bomb over pointing back at the previous holder.
        let dx = holder.x - p.x, dy = holder.y - p.y;
        const dl = vlen(dx, dy) || 1;
        bomb.offX = (dx / dl) * CONFIG.BOMB_MIN_DIST;
        bomb.offY = (dy / dl) * CONFIG.BOMB_MIN_DIST;
        addFx(sim, bomb.x, bomb.y, 'text', 'PASSED!');
        updateBombWorldPos(sim);
        break;
      }
    }
  }

  // --- Shooting (only non-holders can shoot) ---
  for (const p of sim.players) {
    if (!canAct(p) || p.id === sim.bomb.holderId || p.shootCd > 0) continue;
    const inp = inputs[p.id] || {};
    const type = inp.shootMinus ? 'minus' : (inp.shootPlus ? 'plus' : null);
    if (!type) continue;
    let dx = p.aimX - p.x, dy = p.aimY - p.y;
    const dl = vlen(dx, dy);
    if (dl < 1e-6) continue;
    dx /= dl; dy /= dl;
    const spawnDist = p.radius + CONFIG.PROJ_RADIUS + 2;
    sim.projectiles.push({
      x: p.x + dx * spawnDist,
      y: p.y + dy * spawnDist,
      vx: dx * CONFIG.PROJ_SPEED,
      vy: dy * CONFIG.PROJ_SPEED,
      type,
      ownerId: p.id,
      radius: CONFIG.PROJ_RADIUS,
    });
    p.shootCd = CONFIG.SHOOT_COOLDOWN;
  }

  // --- Projectiles: move, then die on the first blocking thing they touch ---
  const holderNow = getPlayer(sim, sim.bomb.holderId);
  sim.projectiles = sim.projectiles.filter(pr => {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;

    // Arena bounds and walls block.
    if (pr.x < -20 || pr.x > CONFIG.ARENA_W + 20 || pr.y < -20 || pr.y > CONFIG.ARENA_H + 20) return false;
    if (pr.x < pr.radius || pr.x > CONFIG.ARENA_W - pr.radius || pr.y < pr.radius || pr.y > CONFIG.ARENA_H - pr.radius) {
      addFx(sim, pr.x, pr.y, 'poof');
      return false;
    }
    for (const w of sim.walls) {
      if (circleHitsRect(pr.x, pr.y, pr.radius, w)) { addFx(sim, pr.x, pr.y, 'poof'); return false; }
    }

    // Player bodies block (no damage, no effect) — checked before the bomb so
    // standing in the way genuinely body-blocks shots aimed at the bomb.
    for (const p of sim.players) {
      if (!canAct(p) || p.id === pr.ownerId) continue;
      if (vlen(pr.x - p.x, pr.y - p.y) < pr.radius + p.radius) {
        addFx(sim, pr.x, pr.y, 'poof');
        return false;
      }
    }

    // Bomb collider: the only place a gameplay effect happens.
    if (vlen(pr.x - sim.bomb.x, pr.y - sim.bomb.y) < pr.radius + sim.bomb.radius) {
      if (holderNow.shieldTimer > 0) {
        addFx(sim, pr.x, pr.y, 'shield-block', 'BLOCKED');
      } else {
        const delta = pr.type === 'minus' ? CONFIG.PROJ_MINUS_EFFECT : CONFIG.PROJ_PLUS_EFFECT;
        sim.bomb.timer += delta;
        addFx(sim, sim.bomb.x, sim.bomb.y, 'text', (delta > 0 ? '+' : '') + delta + 's');
      }
      return false; // projectile always vanishes, shield or not
    }
    return true;
  });

  // --- Bomb countdown / explosion ---
  sim.bomb.timer -= dt;
  if (sim.bomb.timer <= 0) {
    sim.bomb.timer = 0;
    explodeBomb(sim);
  }
}

function p_shieldReady(p) { return p.shieldCd <= 0 && p.shieldTimer <= 0; }

function explodeBomb(sim) {
  const victim = getPlayer(sim, sim.bomb.holderId);
  addFx(sim, sim.bomb.x, sim.bomb.y, 'explosion');

  // Death cleanup per the plan: coins zeroed, all unused cards cleared,
  // player becomes a spectator until the next match starts.
  victim.alive = false;
  victim.spectator = true;
  victim.coins = 0;
  victim.cards = [];
  victim.shieldTimer = 0;

  const survivors = sim.players.filter(p => p.alive);
  for (const s of survivors) s.wins++;
  sim.match.state = 'roundover';
  sim.match.timer = CONFIG.INTERMISSION;
  sim.match.message = victim.name + ' EXPLODED!' +
    (survivors.length === 1 ? '  ' + survivors[0].name + ' wins the round.' : '');

  // Give the bomb to a survivor during the intermission so state stays valid.
  if (survivors.length > 0) sim.bomb.holderId = survivors[0].id;
}

function startNextRound(sim) {
  sim.round++;
  for (const p of sim.players) {
    // Everyone rejoins at the start of the next match.
    p.alive = true;
    p.spectator = false;
    p.x = p.spawnX; p.y = p.spawnY;
    p.shootCd = 0; p.shieldTimer = 0; p.shieldCd = 0;
    p.coinTimer = 0; p.cardTimer = 0;
  }
  sim.projectiles = [];
  sim.bomb.holderId = (sim.round - 1) % sim.players.length;
  sim.bomb.timer = CONFIG.BOMB_START_TIME;
  sim.bomb.offX = 0; sim.bomb.offY = -CONFIG.BOMB_MIN_DIST;
  sim.bomb.transferCd = 1.5;
  updateBombWorldPos(sim);
  sim.match.state = 'playing';
  sim.match.message = '';
}
