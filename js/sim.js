"use strict";

// Host-authoritative simulation. This file is the single source of truth for
// every rule in docs/prototype_plan.md: bomb timer, holder, passing order,
// pass lock, projectile collision, coins, card draws, shield, curse, deaths.
// It only ever advances through Sim.step(sim, inputsByPlayerId, dt), where an
// input is plain data: { mx, my, pass, draw, use: [slotIndex] }.
// Clients never run this — they only send inputs and render snapshots.
const Sim = (() => {
  const C = CONFIG;
  const CENTER = { x: C.WorldWidth / 2, y: C.WorldHeight / 2 };

  // ---- Geometry helpers ----------------------------------------------------

  // Fixed seats around the table. Players never move for the whole match.
  function seatPosition(seatIndex, seatCount) {
    const a = -Math.PI / 2 + (seatIndex / seatCount) * Math.PI * 2;
    return {
      x: CENTER.x + Math.cos(a) * C.SeatDistance,
      y: CENTER.y + Math.sin(a) * C.SeatDistance,
    };
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function getPlayer(sim, id) { return sim.players.find(p => p.id === id) || null; }

  // Bomb world position = holder seat + arm-controlled offset. Before a holder
  // is chosen (reveal/countdown) the bomb sits at the table center.
  function bombWorldPos(sim) {
    const b = sim.bomb;
    if (!b) return null;
    const holder = getPlayer(sim, b.holderId);
    if (!holder) return { x: CENTER.x, y: CENTER.y };
    const seat = seatPosition(holder.seat, sim.seatCount);
    return { x: seat.x + b.offset.x, y: seat.y + b.offset.y };
  }

  // ---- Events (public gameplay feedback) -----------------------------------

  // x/y are optional: events with a position also render as floating text.
  function addEvent(sim, text, x, y) {
    sim.eventSeq++;
    sim.events.push({ seq: sim.eventSeq, text, x, y, time: sim.time });
    if (sim.events.length > 40) sim.events.shift();
  }

  // ---- Match / bomb lifecycle ----------------------------------------------

  function createMatch(roster, bombTimePool) {
    const sim = {
      seatCount: roster.length,
      bombTimePool: bombTimePool.slice(),
      players: roster.map((r, i) => ({
        id: r.id,
        name: r.name,
        isBot: !!r.isBot,
        seat: i,
        disconnected: false,
        alive: true,
        coins: C.StartingCoins,
        hand: [],               // card type ids
        passLock: 0,
        passiveAcc: 0,
        holderAcc: 0,
        holdElapsed: 0,          // time since this hold started; gates the holder bonus window
        revealRemaining: 0,     // magnifying glass private reveal
        aim: { x: CENTER.x, y: CENTER.y },
      })),
      bomb: null,
      projectiles: [],
      nextProjId: 1,
      events: [],
      eventSeq: 0,
      phase: "reveal",          // reveal -> countdown -> playing -> exploding -> (reveal | matchover)
      phaseTimer: 0,
      explosionAt: null,
      winnerId: null,
      time: 0,
    };
    spawnBomb(sim);
    return sim;
  }

  // New bomb: draw initial time from the lobby pool, reset all bomb-specific
  // temporary state. Alive players keep coins and cards across bombs.
  function spawnBomb(sim) {
    const pool = sim.bombTimePool;
    const t = pool[Math.floor(Math.random() * pool.length)];
    sim.bomb = {
      initialTime: t,
      remaining: t,
      holderId: null,
      offset: { x: 0, y: 0 },
      speedMult: 1,
      speedRemaining: 0,
      shieldRemaining: 0,
      curseActive: false,
    };
    sim.projectiles = [];
    sim.explosionAt = null;
    for (const p of sim.players) {
      p.passLock = 0;
      p.revealRemaining = 0;
      p.passiveAcc = 0;
      p.holderAcc = 0;
      p.holdElapsed = 0;
    }
    sim.phase = "reveal";
    sim.phaseTimer = C.InitialTimeRevealDuration;
    addEvent(sim, `BOMB TIME: ${t} SECONDS`);
  }

  // Full match reset (rematch): everyone back to their original seat, coins
  // and hands wiped, alive again. Disconnected players stay out.
  function resetMatch(sim) {
    for (const p of sim.players) {
      p.alive = !p.disconnected;
      p.coins = C.StartingCoins;
      p.hand = [];
      p.passLock = 0;
      p.passiveAcc = 0;
      p.holderAcc = 0;
      p.holdElapsed = 0;
      p.revealRemaining = 0;
    }
    sim.winnerId = null;
    spawnBomb(sim);
  }

  function nextAliveFrom(sim, seat) {
    for (let k = 1; k <= sim.seatCount; k++) {
      const p = sim.players[(seat + k) % sim.seatCount];
      if (p.alive) return p;
    }
    return null;
  }

  // Ownership transfer. Curse waits on the bomb and punishes the *receiver*
  // of the next transfer, then clears.
  function giveBomb(sim, player) {
    const b = sim.bomb;
    b.holderId = player.id;
    b.offset = { x: 0, y: 0 };
    player.holderAcc = 0;
    player.holdElapsed = 0;
    if (b.curseActive) {
      b.curseActive = false;
      player.passLock = C.CurseMinimumHoldTime;
      addEvent(sim, `CURSE! ${player.name} must hold for ${C.CurseMinimumHoldTime}s`);
    } else {
      player.passLock = C.BaseMinimumHoldTime;
    }
  }

  function checkWin(sim) {
    if (sim.phase === "matchover") return;
    const alive = sim.players.filter(p => p.alive);
    if (alive.length <= 1) {
      sim.phase = "matchover";
      sim.winnerId = alive.length ? alive[0].id : null;
      addEvent(sim, alive.length ? `${alive[0].name} WINS THE MATCH!` : "Nobody survived");
    }
  }

  // Death cleanup per the plan: coins zeroed, hand cleared, spectator until
  // the next full match.
  function eliminate(sim, player) {
    player.alive = false;
    player.coins = 0;
    player.hand = [];
    player.revealRemaining = 0;
  }

  function explode(sim) {
    const holder = getPlayer(sim, sim.bomb.holderId);
    sim.explosionAt = bombWorldPos(sim);
    if (holder) {
      eliminate(sim, holder);
      addEvent(sim, `BOOM! ${holder.name} was eliminated`);
    }
    sim.bomb = null;
    sim.projectiles = [];
    sim.phase = "exploding";
    sim.phaseTimer = C.ExplosionTransitionDuration;
  }

  // A player left mid-session. Treat as eliminated; if they held the bomb it
  // passes on so the round can continue.
  function dropPlayer(sim, id) {
    const p = getPlayer(sim, id);
    if (!p || p.disconnected) return;
    p.disconnected = true;
    if (!p.alive) return;
    addEvent(sim, `${p.name} disconnected`);
    const heldBomb = sim.bomb && sim.bomb.holderId === p.id;
    eliminate(sim, p);
    if (heldBomb) {
      const next = nextAliveFrom(sim, p.seat);
      if (next && sim.phase === "playing") {
        giveBomb(sim, next);
        addEvent(sim, `The bomb moved to ${next.name}`);
      } else {
        sim.bomb.holderId = null;
      }
    }
    checkWin(sim);
  }

  // ---- Cards ---------------------------------------------------------------

  function tryDraw(sim, p) {
    if (!p.alive) return;
    if (p.coins < C.CardDrawCost) return;
    if (p.hand.length >= C.MaxHandSize) return; // hand full: no draw, no charge
    p.coins -= C.CardDrawCost;
    p.hand.push(Cards.rollCard());               // host decides which card
    addEvent(sim, `${p.name} drew a card`);
  }

  // Drop a card from the hand without triggering its effect (e.g. to make
  // room for a better draw). No coin refund.
  function discardCard(sim, p, slot) {
    const cardId = p.hand[slot];
    if (!cardId) return;
    p.hand.splice(slot, 1);
    addEvent(sim, `${p.name} discarded ${Cards.TYPES[cardId].name}`);
  }

  function useCard(sim, p, slot) {
    const cardId = p.hand[slot];
    if (!cardId) return;
    const def = Cards.TYPES[cardId];
    const b = sim.bomb;
    const consume = () => p.hand.splice(slot, 1);

    switch (def.kind) {
      case "magnify":
        // Private reveal: only this player's snapshot carries the exact time.
        p.revealRemaining = C.RevealDuration;
        consume();
        addEvent(sim, `${p.name} used a Magnifying Glass`);
        break;

      case "speed": {
        // Override rule: the new modifier fully replaces the old one.
        b.speedMult = def.mult;
        b.speedRemaining = def.duration;
        consume();
        addEvent(sim, `SPEED x${def.mult} (${p.name})`, ...posArgs(bombWorldPos(sim)));
        break;
      }

      case "shield":
        // Only the current bomb holder may shield; otherwise the card stays.
        if (b.holderId !== p.id) return;
        b.shieldRemaining = C.ShieldDuration;
        consume();
        addEvent(sim, `SHIELD ACTIVATED (${p.name})`, ...posArgs(bombWorldPos(sim)));
        break;

      case "curse":
        b.curseActive = true;
        consume();
        addEvent(sim, `CURSE ACTIVATED (${p.name})`);
        break;

      case "projectile": {
        // Real 2D projectiles (never hitscan), fired from the player's hand
        // position toward their current mouse aim. The card is consumed even
        // if every shot misses. -Time Gun cards fire a short burst instead of
        // a single bullet; +Time Repair Kits stay a single throw.
        const seat = seatPosition(p.seat, sim.seatCount);
        let dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
        const baseAngle = Math.atan2(dy, dx);
        const count = def.amount < 0 ? C.GunBurstCount : 1;
        const spread = (C.GunBurstSpreadDeg * Math.PI) / 180;
        for (let i = 0; i < count; i++) {
          const offset = count > 1 ? (i / (count - 1) - 0.5) * spread : 0;
          const a = baseAngle + offset;
          const bx = Math.cos(a), by = Math.sin(a);
          sim.projectiles.push({
            id: sim.nextProjId++,
            ownerId: p.id,
            amount: def.amount,
            x: seat.x + bx * C.MuzzleOffset,
            y: seat.y + by * C.MuzzleOffset,
            vx: bx * C.ProjectileSpeed,
            vy: by * C.ProjectileSpeed,
          });
        }
        consume();
        addEvent(sim, `${p.name} used ${def.name}`);
        break;
      }
    }
  }

  function posArgs(pos) { return pos ? [pos.x, pos.y] : []; }

  // ---- Projectiles ---------------------------------------------------------

  function stepProjectiles(sim, dt) {
    const b = sim.bomb;
    const bombPos = bombWorldPos(sim);
    const survivors = [];

    for (const pr of sim.projectiles) {
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;

      // Walls block (projectile just vanishes).
      if (pr.x < 0 || pr.x > C.WorldWidth || pr.y < 0 || pr.y > C.WorldHeight) continue;

      // Bomb collider: the only place effects apply.
      if (b && b.holderId && dist(pr, bombPos) <= C.BombRadius + C.ProjectileRadius) {
        if (b.shieldRemaining > 0) {
          // Shield: projectile still vanishes, but no time effect.
          addEvent(sim, "SHIELD BLOCKED IT", bombPos.x, bombPos.y);
        } else if (pr.amount < 0) {
          // Safety rule: reductions can never zero the bomb directly.
          b.remaining = Math.max(b.remaining + pr.amount, C.MinimumBombTimeAfterReduction);
          addEvent(sim, `${pr.amount} SEC`, bombPos.x, bombPos.y);
        } else {
          // No upper limit on bomb time.
          b.remaining += pr.amount;
          addEvent(sim, `+${pr.amount} SEC`, bombPos.x, bombPos.y);
        }
        continue;
      }

      // Player bodies block projectiles (no damage, no effect) — positioning
      // the bomb behind your own body is a real defensive option.
      let blocked = false;
      for (const p of sim.players) {
        if (!p.alive) continue;
        const seat = seatPosition(p.seat, sim.seatCount);
        if (dist(pr, seat) <= C.PlayerBodyRadius + C.ProjectileRadius) { blocked = true; break; }
      }
      if (blocked) continue;

      survivors.push(pr);
    }
    sim.projectiles = survivors;
  }

  // ---- Main step -----------------------------------------------------------

  function step(sim, inputs, dt) {
    sim.time += dt;

    // Aim/mouse is always recorded, in every phase.
    for (const p of sim.players) {
      const inp = inputs[p.id];
      if (inp && inp.mx != null) p.aim = { x: inp.mx, y: inp.my };
    }

    switch (sim.phase) {
      case "reveal":
        sim.phaseTimer -= dt;
        allowDraws(sim, inputs);
        if (sim.phaseTimer <= 0) {
          sim.phase = "countdown";
          sim.phaseTimer = C.CountdownSeconds;
        }
        break;

      case "countdown":
        sim.phaseTimer -= dt;
        allowDraws(sim, inputs);
        if (sim.phaseTimer <= 0) {
          // Countdown over: timer goes hidden, a random alive player becomes
          // the initial holder, gameplay starts.
          sim.phase = "playing";
          const alive = sim.players.filter(p => p.alive);
          const first = alive[Math.floor(Math.random() * alive.length)];
          giveBomb(sim, first);
          addEvent(sim, `${first.name} starts with the bomb!`);
        }
        break;

      case "playing":
        stepPlaying(sim, inputs, dt);
        break;

      case "exploding":
        sim.phaseTimer -= dt;
        if (sim.phaseTimer <= 0) {
          checkWin(sim);
          if (sim.phase !== "matchover") spawnBomb(sim);
        }
        break;

      case "matchover":
        break; // waits for the host to trigger resetMatch()
    }
  }

  // Card draws are allowed at any time while alive (even between countdowns).
  function allowDraws(sim, inputs) {
    for (const p of sim.players) {
      const inp = inputs[p.id];
      if (!inp) continue;
      if (inp.draw) tryDraw(sim, p);
      if (inp.discard && inp.discard.length) {
        const slots = [...new Set(inp.discard)].sort((a, z) => z - a);
        for (const slot of slots) discardCard(sim, p, slot);
      }
    }
  }

  function stepPlaying(sim, inputs, dt) {
    const b = sim.bomb;

    // Bomb countdown, scaled by the (non-stacking) speed modifier.
    if (b.speedRemaining > 0) {
      b.speedRemaining -= dt;
      if (b.speedRemaining <= 0) { b.speedMult = 1; b.speedRemaining = 0; }
    }
    if (b.shieldRemaining > 0) b.shieldRemaining = Math.max(0, b.shieldRemaining - dt);
    b.remaining -= dt * b.speedMult;

    const holder = getPlayer(sim, b.holderId);

    for (const p of sim.players) {
      if (!p.alive) continue;
      const inp = inputs[p.id] || {};

      // Income: passive for everyone alive, plus a holder bonus on top.
      p.passiveAcc += dt;
      while (p.passiveAcc >= C.PassiveCoinInterval) {
        p.passiveAcc -= C.PassiveCoinInterval;
        p.coins += C.PassiveCoinAmount;
      }
      if (p === holder) {
        // Bonus income only accrues for the first BombHolderCoinDuration
        // seconds of a continuous hold — passing it off and getting it back
        // reopens the window.
        if (p.holdElapsed < C.BombHolderCoinDuration) {
          const window = Math.min(dt, C.BombHolderCoinDuration - p.holdElapsed);
          p.holderAcc += window;
          while (p.holderAcc >= C.BombHolderCoinInterval) {
            p.holderAcc -= C.BombHolderCoinInterval;
            p.coins += C.BombHolderCoinAmount;
          }
        }
        p.holdElapsed += dt;
      }

      if (p.revealRemaining > 0) p.revealRemaining = Math.max(0, p.revealRemaining - dt);

      // Holder-only: arm control and passing. The client only sends a mouse
      // position; the host computes and clamps the actual bomb offset.
      if (p === holder) {
        p.passLock = Math.max(0, p.passLock - dt);
        const seat = seatPosition(p.seat, sim.seatCount);
        const dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.001) {
          const r = Math.min(len, C.BombArmReach);
          b.offset = { x: (dx / len) * r, y: (dy / len) * r };
        }
        if (inp.pass && p.passLock <= 0) {
          const next = nextAliveFrom(sim, p.seat);
          if (next && next !== p) {
            giveBomb(sim, next);
            addEvent(sim, `${p.name} passed the bomb to ${next.name}`);
          }
        }
      }

      if (inp.draw) tryDraw(sim, p);

      if (inp.use && inp.use.length) {
        // Descending slot order so earlier splices don't shift later indices.
        const slots = [...new Set(inp.use)].sort((a, z) => z - a);
        for (const slot of slots) useCard(sim, p, slot);
      }

      if (inp.discard && inp.discard.length) {
        // Free the hand of an unwanted card without triggering its effect.
        const slots = [...new Set(inp.discard)].sort((a, z) => z - a);
        for (const slot of slots) discardCard(sim, p, slot);
      }
    }

    stepProjectiles(sim, dt);

    if (b.remaining <= 0) explode(sim);
  }

  // ---- Snapshots (the only thing clients ever see) -------------------------

  // The exact remaining time is never in a normal snapshot. It is included
  // only inside `you.reveal` while that viewer's own Magnifying Glass is
  // active, so clients cannot read the hidden timer even from the wire.
  function buildSnapshot(sim, viewerId, includeDebug) {
    const b = sim.bomb;
    const bombPos = bombWorldPos(sim);
    const viewer = getPlayer(sim, viewerId);

    const snap = {
      phase: sim.phase,
      phaseTimer: sim.phaseTimer,
      time: sim.time,
      seatCount: sim.seatCount,
      winnerId: sim.winnerId,
      winnerName: sim.winnerId ? getPlayer(sim, sim.winnerId).name : null,
      aliveCount: sim.players.filter(p => p.alive).length,
      explosionAt: sim.phase === "exploding" ? sim.explosionAt : null,
      bomb: b ? {
        x: bombPos.x,
        y: bombPos.y,
        holderId: b.holderId,
        initialTime: b.initialTime,        // public: players know the starting time
        shield: b.shieldRemaining > 0,     // announced publicly, so visible
        curse: b.curseActive,              // announced publicly, so visible
        speedMult: b.speedMult,            // Speed Up/Down are announced publicly too
      } : null,
      players: sim.players.map(p => {
        const seat = seatPosition(p.seat, sim.seatCount);
        return { id: p.id, name: p.name, seat: p.seat, x: seat.x, y: seat.y, alive: p.alive };
      }),
      you: viewer ? {
        id: viewer.id,
        alive: viewer.alive,
        coins: viewer.coins,
        hand: viewer.hand.slice(),
        isHolder: !!(b && b.holderId === viewerId),
        passLock: viewer.passLock,
        canPass: !!(b && b.holderId === viewerId && viewer.passLock <= 0 && sim.phase === "playing"),
        reveal: (viewer.revealRemaining > 0 && b && sim.phase === "playing")
          ? { remaining: viewer.revealRemaining, bombTime: b.remaining }
          : null,
      } : null,
      projectiles: sim.projectiles.map(pr => ({ x: pr.x, y: pr.y, amount: pr.amount })),
      events: sim.events.slice(-30),
    };

    if (includeDebug) snap.debug = buildDebug(sim);
    return snap;
  }

  // Development-only view of everything hidden, per the plan's Debug Mode list.
  function buildDebug(sim) {
    const b = sim.bomb;
    const holder = b ? getPlayer(sim, b.holderId) : null;
    const bombPos = bombWorldPos(sim);
    const aliveOrder = [];
    if (holder) {
      let p = holder;
      do {
        aliveOrder.push(p.name);
        p = nextAliveFrom(sim, p.seat);
      } while (p && p !== holder);
    }
    return {
      phase: sim.phase,
      bombRemaining: b ? b.remaining : null,
      bombInitial: b ? b.initialTime : null,
      holder: holder ? holder.name : null,
      bombPos: bombPos ? { x: Math.round(bombPos.x), y: Math.round(bombPos.y) } : null,
      armOffset: b ? { x: Math.round(b.offset.x), y: Math.round(b.offset.y) } : null,
      speedMult: b ? b.speedMult : null,
      speedRemaining: b ? b.speedRemaining : null,
      shieldActive: !!(b && b.shieldRemaining > 0),
      shieldRemaining: b ? b.shieldRemaining : null,
      curseActive: !!(b && b.curseActive),
      nextReceiverMinHold: b && b.curseActive ? C.CurseMinimumHoldTime : C.BaseMinimumHoldTime,
      passLockRemaining: holder ? holder.passLock : null,
      passingOrder: aliveOrder,
      nextAlive: holder ? (nextAliveFrom(sim, holder.seat) || {}).name : null,
      projectiles: sim.projectiles.map(pr => ({
        amount: pr.amount, x: Math.round(pr.x), y: Math.round(pr.y),
      })),
      players: sim.players.map(p => ({
        name: p.name,
        state: p.disconnected ? "disconnected" : (p.alive ? "alive" : "spectator"),
        coins: p.coins,
        hand: p.hand.map(id => Cards.TYPES[id].name),
        passLock: p.passLock,
      })),
    };
  }

  return {
    createMatch, step, buildSnapshot, resetMatch, dropPlayer,
    seatPosition, bombWorldPos, getPlayer,
  };
})();
