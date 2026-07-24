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

  // Coin economy rates in CONFIG are tuned for a 3-player match. Scale the
  // *Interval fields by seat count so per-player income drops proportionally
  // as more players join — total coin generation across the table stays
  // roughly flat instead of growing with every extra seat.
  function coinIntervalScale(sim) {
    return sim.seatCount / C.CoinEconomyBaselinePlayers;
  }

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

  // Box-cast used by the Magnifying Glass: a long, thin rectangle from the
  // player's seat out along their current aim direction. True only while the
  // given bomb world position actually falls inside that rectangle (expanded
  // by the bomb's own radius, so it counts as covered the moment the box
  // touches the bomb collider, not just its center). Works on any bomb — the
  // real one or a fake decoy — so a fake reads under the glass exactly like
  // the real bomb and never gives itself away by being unreadable.
  function magnifyCoversPos(sim, p, pos) {
    if (!pos) return false;
    const seat = seatPosition(p.seat, sim.seatCount);
    let dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return false;
    dx /= len; dy /= len;
    const px = -dy, py = dx; // perpendicular axis
    const fx = pos.x - seat.x, fy = pos.y - seat.y;
    const forward = fx * dx + fy * dy;
    const side = fx * px + fy * py;
    return forward >= -C.BombRadius && forward <= C.MagnifyCastLength + C.BombRadius &&
      Math.abs(side) <= C.MagnifyCastWidth / 2 + C.BombRadius;
  }

  function getPlayer(sim, id) { return sim.players.find(p => p.id === id) || null; }

  // Bomb world position = holder seat + arm-controlled offset. Before a holder
  // is chosen (reveal/countdown) the bomb sits at the table center.
  function bombWorldPos(sim) {
    const b = sim.bomb;
    if (!b) return null;
    if (b.transfer) {
      const t = Math.min(1, b.transfer.elapsed / b.transfer.duration);
      return {
        x: b.transfer.fromPos.x + (b.transfer.toPos.x - b.transfer.fromPos.x) * t,
        y: b.transfer.fromPos.y + (b.transfer.toPos.y - b.transfer.fromPos.y) * t,
      };
    }
    const holder = getPlayer(sim, b.holderId);
    if (!holder) return { x: CENTER.x, y: CENTER.y };
    const seat = seatPosition(holder.seat, sim.seatCount);
    return { x: seat.x + b.offset.x, y: seat.y + b.offset.y };
  }

  // Same position rule for a fake bomb entity: lerp along its transfer while
  // in flight, otherwise holder seat + arm-controlled offset.
  function fakeWorldPos(sim, f) {
    if (f.transfer) {
      const t = Math.min(1, f.transfer.elapsed / f.transfer.duration);
      return {
        x: f.transfer.fromPos.x + (f.transfer.toPos.x - f.transfer.fromPos.x) * t,
        y: f.transfer.fromPos.y + (f.transfer.toPos.y - f.transfer.fromPos.y) * t,
      };
    }
    const holder = getPlayer(sim, f.holderId);
    if (!holder) return { x: CENTER.x, y: CENTER.y };
    const seat = seatPosition(holder.seat, sim.seatCount);
    return { x: seat.x + f.offset.x, y: seat.y + f.offset.y };
  }

  // Fake bomb physically in this player's hands right now (not mid-flight).
  function fakeHeldBy(sim, playerId) {
    return sim.fakeBombs.find(f => f.holderId === playerId && !f.transfer) || null;
  }

  // "Hands full" test used everywhere a rule cares about holding *a* bomb —
  // real or fake must behave identically or the decoy gives itself away.
  function holdsAnyBomb(sim, p) {
    const b = sim.bomb;
    if (b && b.holderId === p.id && !b.transfer) return true;
    return !!fakeHeldBy(sim, p.id);
  }

  // ---- Events (public gameplay feedback) -----------------------------------

  // x/y are optional: events with a position also render as floating text.
  function addEvent(sim, text, x, y) {
    sim.eventSeq++;
    sim.events.push({ seq: sim.eventSeq, text, x, y, time: sim.time });
    if (sim.events.length > 40) sim.events.shift();
  }

  // Positioned visual-only effect (currently just "fakeboom": a fake bomb's
  // harmless explosion). Renderers key off type + age; `data` carries extra
  // presentation hints (e.g. midAir for the staged blast sequence).
  function addEffect(sim, type, x, y, data) {
    sim.effectSeq++;
    sim.effects.push(Object.assign({ seq: sim.effectSeq, type, x, y, time: sim.time }, data || {}));
    if (sim.effects.length > 12) sim.effects.shift();
  }

  // ---- Match / bomb lifecycle ----------------------------------------------

  // Fixed-size hand: null marks an empty slot. Using/discarding a card clears
  // its slot in place rather than shifting later cards down, so a card's
  // position never moves just because an earlier one was used.
  function freshHand() {
    const h = new Array(C.MaxHandSize).fill(null);
    C.StartingHand.forEach((id, i) => { h[i] = id; });
    return h;
  }

  // Fisher-Yates shuffle of seat indices, so entry order never determines
  // table position.
  function shuffledSeats(n) {
    const seats = Array.from({ length: n }, (_, i) => i);
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    return seats;
  }

  function createMatch(roster, bombTimePool) {
    const seats = shuffledSeats(roster.length);
    const sim = {
      seatCount: roster.length,
      bombTimePool: bombTimePool.slice(),
      players: roster.map((r, i) => ({
        id: r.id,
        name: r.name,
        isBot: !!r.isBot,
        seat: seats[i],
        disconnected: false,
        alive: true,
        coins: C.StartingCoins,
        hand: freshHand(),  // fixed-size; card type ids or null for empty slots
        passLock: 0,
        passiveAcc: 0,
        holderAcc: 0,
        holdElapsed: 0,          // time since this hold started; gates the holder income window
        revealRemaining: 0,     // magnifying glass private reveal
        aim: { x: CENTER.x, y: CENTER.y },
        equippedSlot: null,      // hand slot the player is currently aiming (cosmetic, public)
        gunPending: null,        // multi-click gun card mid-use: { cardId, slot, shotsLeft }
        armBuffRemaining: 0,     // Reinforced Arm: free-target + 2x pass speed while > 0
        lastPayoutAmount: 0,     // most recent farmed-pot cash-in, for the private "+N" cue
        lastPayoutSeq: 0,        // bumped every cash-in so the client can detect a new one even if the amount repeats
      })),
      bomb: null,
      // Fake Bomb decoys. Each entry is a full bomb entity — held in the
      // holder's arms, passed/bounced/grappled/shot exactly like sim.bomb —
      // that simply pops harmlessly when its own hidden timer runs out:
      // { id, remaining, holderId, offset:{x,y}, transfer|null }.
      // holderId keeps the sender during a pass transfer, mirroring how
      // sim.bomb.holderId works, so the two are indistinguishable in play.
      fakeBombs: [],
      nextFakeId: 1,
      projectiles: [],
      nextProjId: 1,
      events: [],
      eventSeq: 0,
      // Positioned, purely-visual one-shot effects (e.g. a fake bomb's
      // harmless pop) — same append/trim pattern as events.
      effects: [],
      effectSeq: 0,
      phase: "reveal",          // reveal -> countdown -> playing -> exploding -> (reveal | matchover)
      phaseTimer: 0,
      playElapsed: 0,           // real seconds since "playing" started this bomb (for the public reveal window)
      explosionAt: null,
      explosionVictimPos: null,
      explosionVictimId: null,
      explosionMidAir: false,   // detonated while flying between seats -> render the staged blast sequence
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
    // Pick the initial holder now and start it traveling there right away, so
    // the bomb visibly drifts in from the center during the reveal/countdown
    // display instead of snapping onto a player the instant "playing" starts.
    const alive = sim.players.filter(p => p.alive);
    const target = alive.length ? alive[Math.floor(Math.random() * alive.length)] : null;
    const fromPos = { x: CENTER.x, y: CENTER.y };
    const toPos = target ? seatPosition(target.seat, sim.seatCount) : fromPos;
    const travelWindow = Math.max(0.5, C.InitialTimeRevealDuration + C.CountdownSeconds - 0.3);
    sim.bomb = {
      initialTime: t,
      remaining: t,
      holderId: null,
      offset: { x: 0, y: 0 },
      speedMult: 1,
      speedRemaining: 0,
      shieldRemaining: 0,
      curseActive: false,
      pot: 0,                     // farming income accrued while held; paid to whoever throws it
      transfer: target
        ? { fromId: null, toId: target.id, elapsed: 0, duration: travelWindow, fromPos, toPos }
        : null,
    };
    sim.projectiles = [];
    sim.fakeBombs = [];
    sim.effects = [];
    sim.explosionAt = null;
    sim.explosionVictimPos = null;
    sim.explosionVictimId = null;
    sim.explosionMidAir = false;
    sim.playElapsed = 0;
    for (const p of sim.players) {
      p.passLock = 0;
      p.revealRemaining = 0;
      p.passiveAcc = 0;
      p.holderAcc = 0;
      p.holdElapsed = 0;
      p.gunPending = null;
      p.armBuffRemaining = 0;
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
      p.hand = freshHand();
      p.passLock = 0;
      p.passiveAcc = 0;
      p.holderAcc = 0;
      p.holdElapsed = 0;
      p.revealRemaining = 0;
      p.gunPending = null;
      p.armBuffRemaining = 0;
      p.lastPayoutAmount = 0;
      p.lastPayoutSeq = 0;
    }
    sim.winnerId = null;
    spawnBomb(sim);
  }

  function nextAliveFrom(sim, seat) {
    for (let k = 1; k <= sim.seatCount; k++) {
      const wantSeat = (seat + k) % sim.seatCount;
      const p = sim.players.find(pl => pl.seat === wantSeat);
      if (p && p.alive) return p;
    }
    return null;
  }

  // Reinforced Arm free-target passing: whichever other alive player's seat
  // is nearest to the live aim point, i.e. "aim at someone and press SPACE".
  function nearestAliveTo(sim, point, excludeId) {
    let best = null, bestDist = Infinity;
    for (const p of sim.players) {
      if (!p.alive || p.id === excludeId) continue;
      const seat = seatPosition(p.seat, sim.seatCount);
      const d = dist(point, seat);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  // Ownership transfer. Curse waits on the bomb and punishes the *receiver*
  // of the next transfer, then clears.
  function giveBomb(sim, player) {
    const b = sim.bomb;
    b.holderId = player.id;
    b.offset = { x: 0, y: 0 };
    b.pot = 0;                    // new carrier starts a fresh farming pot
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

  // Advance an in-flight bomb transfer (initial travel-in or an in-round
  // pass) and hand off ownership once it arrives. Safe to call in any phase;
  // during reveal/countdown this is what makes the bomb visibly drift onto
  // its initial holder instead of appearing there instantly.
  function advanceBombTransfer(sim, dt) {
    const b = sim.bomb;
    if (!b || !b.transfer) return;
    b.transfer.elapsed += dt;
    if (b.transfer.elapsed >= b.transfer.duration) {
      const initial = !b.transfer.fromId;
      const receiver = getPlayer(sim, b.transfer.toId);
      const sender = b.transfer.fromId ? getPlayer(sim, b.transfer.fromId) : null;
      b.transfer = null;
      if (receiver && receiver.alive) {
        giveBomb(sim, receiver);
        addEvent(sim, initial ? `${receiver.name} starts with the bomb!` : `${receiver.name} received the bomb`);
        bounceRealIfOccupied(sim, receiver);
      } else if (sender && sender.alive) {
        // Receiver vanished mid-pass: bomb returns home — but the sender may
        // have pulled out a fake while their throw was in flight, in which
        // case the returning real bomb hot-potatoes onward as usual.
        giveBomb(sim, sender);
        bounceRealIfOccupied(sim, sender);
      }
    }
  }

  // Hot-potato rule: nobody can hold two bombs (real or fake) at once. When a
  // bomb lands on a player who is already holding one, the *newcomer stays in
  // their hands* and the bomb they were already holding is the one thrown
  // onward to the next alive seat. Because both bombs look identical in
  // flight, swapping which one leaves is invisible and never reveals the
  // decoy. This forced release forfeits the old bomb's farming pot — only a
  // voluntary throw (controlHeldBomb) ever cashes a pot in.
  //
  // Finds whichever bomb `holder` is physically holding other than `keep`
  // (the newcomer they're keeping) and launches it toward the next seat.
  // Returns false only when there's nowhere to send it.
  function throwOtherBombOnward(sim, holder, keep) {
    const next = nextAliveFrom(sim, holder.seat);
    if (!next || next === holder) return false;
    const b = sim.bomb;
    if (b && b !== keep && b.holderId === holder.id && !b.transfer) {
      const seat = seatPosition(holder.seat, sim.seatCount);
      const fromPos = { x: seat.x + b.offset.x, y: seat.y + b.offset.y };
      const toPos = seatPosition(next.seat, sim.seatCount);
      b.pot = 0;
      b.transfer = {
        fromId: holder.id, toId: next.id, elapsed: 0,
        duration: Math.max(0.001, dist(fromPos, toPos) / C.BombPassSpeed),
        fromPos, toPos,
      };
      return true;
    }
    const fake = sim.fakeBombs.find(fk => fk !== keep && fk.holderId === holder.id && !fk.transfer);
    if (fake) {
      fake.pot = 0;
      startFakeTransfer(sim, fake, fakeWorldPos(sim, fake), next, holder.id);
      return true;
    }
    return false;
  }

  // Real-bomb half of the hot-potato rule: the real bomb just landed on a
  // receiver who was already holding a fake. The real one stays; their fake
  // is the bomb thrown onward. (The fake-arrival half lives in stepFakeBombs.)
  function bounceRealIfOccupied(sim, receiver) {
    if (!fakeHeldBy(sim, receiver.id)) return;
    if (throwOtherBombOnward(sim, receiver, sim.bomb)) {
      addEvent(sim, `${receiver.name} was already holding a bomb — passed one on!`);
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
    player.hand = new Array(C.MaxHandSize).fill(null);
    player.revealRemaining = 0;
    player.gunPending = null;
    player.equippedSlot = null;
    player.armBuffRemaining = 0;
    // A decoy in a dead player's hands vanishes with them; one they already
    // passed away is mid-flight and settles on arrival as usual.
    sim.fakeBombs = sim.fakeBombs.filter(f => f.transfer || f.holderId !== player.id);
  }

  // Who dies when the bomb reaches 0: normally the current holder (they are
  // by construction the nearest point to the bomb, since it sits in their
  // arm-controlled offset). But while a pass transfer is in flight, the bomb
  // is out in open space and the victim is whichever alive player is
  // physically nearest to it right now — not necessarily whoever it was
  // headed toward.
  function explode(sim) {
    const b = sim.bomb;
    let victim;
    if (b.transfer) {
      const pos = bombWorldPos(sim);
      let best = null, bestDist = Infinity;
      for (const p of sim.players) {
        if (!p.alive) continue;
        const d = dist(pos, seatPosition(p.seat, sim.seatCount));
        if (d < bestDist) { bestDist = d; best = p; }
      }
      victim = best;
    } else {
      victim = getPlayer(sim, b.holderId);
    }
    sim.explosionAt = bombWorldPos(sim);
    sim.explosionVictimPos = victim ? seatPosition(victim.seat, sim.seatCount) : null;
    sim.explosionVictimId = victim ? victim.id : null;
    // Mid-air blast gets the staged presentation (freeze at 0s -> ring
    // reaches the victim -> fast expand + fade); an in-hand blast keeps the
    // original instant ring. The kill itself already happened right here.
    sim.explosionMidAir = !!b.transfer;
    if (victim) {
      eliminate(sim, victim);
      addEvent(sim, `BOOM! ${victim.name} was eliminated`);
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
    const heldBomb = sim.bomb && sim.bomb.holderId === p.id && !sim.bomb.transfer;
    const inTransfer = sim.bomb && sim.bomb.transfer &&
      (sim.bomb.transfer.fromId === p.id || sim.bomb.transfer.toId === p.id);
    eliminate(sim, p);
    if (inTransfer) {
      // Mid-pass disconnect: abandon the transfer. If the sender is still
      // around, they keep the bomb; otherwise it moves to the next alive
      // player in order from the sender's seat.
      const sender = getPlayer(sim, sim.bomb.transfer.fromId);
      const fromSeat = sender ? sender.seat : p.seat;
      sim.bomb.transfer = null;
      const next = (sender && sender.alive) ? sender : nextAliveFrom(sim, fromSeat);
      if (next && sim.phase === "playing") {
        giveBomb(sim, next);
        addEvent(sim, `The bomb moved to ${next.name}`);
        bounceRealIfOccupied(sim, next);
      } else {
        sim.bomb.holderId = null;
      }
    } else if (heldBomb) {
      const next = nextAliveFrom(sim, p.seat);
      if (next && sim.phase === "playing") {
        giveBomb(sim, next);
        addEvent(sim, `The bomb moved to ${next.name}`);
        bounceRealIfOccupied(sim, next);
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
    const slot = p.hand.indexOf(null);
    if (slot === -1) return; // hand full: no draw, no charge
    p.coins -= C.CardDrawCost;
    // While bombs in play (real + fakes) are at the player-count cap, Fake
    // Bomb leaves the draw pool entirely — the card would be unusable dead
    // weight, so it can't even be drawn until a slot frees up.
    const bombsInPlay = (sim.bomb ? 1 : 0) + sim.fakeBombs.length;
    const exclude = bombsInPlay >= sim.players.length ? ["fakebomb"] : null;
    p.hand[slot] = Cards.rollCard(exclude);        // host decides which card
    addEvent(sim, `${p.name} drew a card`);
  }

  // Drop a card from the hand without triggering its effect (e.g. to make
  // room for a better draw). No coin refund. Clears the slot in place so
  // later cards don't shift down.
  function discardCard(sim, p, slot) {
    const cardId = p.hand[slot];
    if (!cardId) return;
    if (p.gunPending && p.gunPending.slot === slot) p.gunPending = null;
    p.hand[slot] = null;
    addEvent(sim, `${p.name} discarded ${Cards.TYPES[cardId].name}`);
  }

  function useCard(sim, p, slot) {
    const cardId = p.hand[slot];
    if (!cardId) return;
    const def = Cards.TYPES[cardId];
    const b = sim.bomb;
    const consume = () => { p.hand[slot] = null; };

    switch (def.kind) {
      case "magnify":
        // Opens an aiming window: for RevealDuration seconds the player must
        // keep their box-cast (see magnifyCovers) over the bomb to actually
        // see the number, computed fresh every tick in buildSnapshot. Only
        // this player's snapshot can ever carry the exact time.
        p.revealRemaining = C.RevealDuration;
        consume();
        addEvent(sim, `${p.name} used a Magnifying Glass`);
        break;

      case "speed": {
        // Override rule: the new modifier fully replaces the old one.
        b.speedMult = def.mult;
        b.speedRemaining = def.duration;
        consume();
        const msg = def.mult === 0 ? `TIME FROZEN (${p.name})` : `SPEED x${def.mult} (${p.name})`;
        addEvent(sim, msg, ...posArgs(bombWorldPos(sim)));
        break;
      }

      case "shield":
        // Only the current bomb holder may shield, and not while it's
        // already in flight mid-pass; otherwise the card stays in hand.
        if (b.holderId !== p.id || b.transfer) return;
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
        // A player holding a weapon needs both hands free to aim it, and a
        // bomb holder's hands are full holding the bomb — real or fake, the
        // rule must match or the decoy gives itself away. Once a bomb has
        // been thrown and is in flight, their hands are free again even
        // though ownership hasn't formally changed yet.
        if (holdsAnyBomb(sim, p)) return;
        // Real 2D projectiles (never hitscan), fired from the player's hand
        // toward their current mouse aim. +Time Repair Kits are a single
        // throw, consumed immediately. -Time Gun cards hold C.GunBurstCount
        // separate shots: each press here fires exactly one (re-aimed at the
        // current mouse position), and the card is only consumed once every
        // shot is spent — or earlier, if the player cancels and the
        // unfired rounds are discarded (see discardCard).
        if (def.amount < 0) {
          let pending = p.gunPending;
          if (!pending || pending.cardId !== cardId || pending.slot !== slot) {
            pending = { cardId, slot, shotsLeft: C.GunBurstCount };
            p.gunPending = pending;
          }
          fireProjectile(sim, p, def.amount);
          pending.shotsLeft--;
          addEvent(sim, `${p.name} fired ${def.name}`);
          if (pending.shotsLeft <= 0) {
            p.gunPending = null;
            consume();
          }
        } else {
          fireProjectile(sim, p, def.amount);
          consume();
          addEvent(sim, `${p.name} used ${def.name}`);
        }
        break;
      }

      case "grapple":
        // Same rule as projectile cards: can't aim while your hands are
        // literally on a bomb (real or fake). Once thrown it's in flight
        // and hands are free again even before ownership formally changes.
        if (holdsAnyBomb(sim, p)) return;
        fireClaw(sim, p);
        consume();
        addEvent(sim, `${p.name} fired a Grapple Claw`);
        break;

      case "reinforced":
        p.armBuffRemaining = C.ReinforcedArmDuration;
        consume();
        addEvent(sim, `${p.name} equipped a Reinforced Arm`);
        break;

      case "fakebomb": {
        // Only usable while not already holding a bomb (real or fake — your
        // hands must be free to pull one out), and only while the total bomb
        // count (real + fakes currently in play) hasn't already reached the
        // player count — otherwise bombs could keep multiplying indefinitely.
        if (holdsAnyBomb(sim, p)) return;
        const bombsInPlay = (b ? 1 : 0) + sim.fakeBombs.length;
        if (bombsInPlay >= sim.players.length) return;
        sim.fakeBombs.push({
          id: sim.nextFakeId++,
          remaining: C.FakeBombMinDuration +
            Math.random() * (C.FakeBombMaxDuration - C.FakeBombMinDuration),
          holderId: p.id,
          offset: { x: 0, y: 0 },
          transfer: null,
          pot: 0,                 // accrues + animates like the real bomb, but never pays out on release

          // The creator alone gets to read the decoy's rolled timer for a
          // few seconds (delivered only inside their own snapshot).
          revealTo: p.id,
          revealRemaining: C.FakeBombRevealDuration,
        });
        // Open a fresh farming window, exactly as giveBomb does for the real
        // bomb, so the decoy shows the identical coin-trickle animation from
        // the moment it's in hand (it just never cashes out on release).
        p.holderAcc = 0;
        p.holdElapsed = 0;
        consume();
        addEvent(sim, `${p.name} pulled out a bomb...`);
        break;
      }
    }
  }

  function posArgs(pos) { return pos ? [pos.x, pos.y] : []; }

  // Spawns one real 2D projectile from the player's seat toward their current
  // aim. Reads p.aim fresh each call so successive shots in a burst can be
  // re-aimed between shots.
  function fireProjectile(sim, p, amount) {
    const seat = seatPosition(p.seat, sim.seatCount);
    let dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    sim.projectiles.push({
      id: sim.nextProjId++,
      ownerId: p.id,
      amount,
      x: seat.x + dx * C.MuzzleOffset,
      y: seat.y + dy * C.MuzzleOffset,
      vx: dx * C.ProjectileSpeed,
      vy: dy * C.ProjectileSpeed,
    });
  }

  // Grapple Claw: a fast outbound throw tagged isClaw so stepProjectiles()
  // knows a hit should reel the bomb in rather than change its time.
  function fireClaw(sim, p) {
    const seat = seatPosition(p.seat, sim.seatCount);
    let dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    sim.projectiles.push({
      id: sim.nextProjId++,
      ownerId: p.id,
      isClaw: true,
      x: seat.x + dx * C.MuzzleOffset,
      y: seat.y + dy * C.MuzzleOffset,
      vx: dx * C.GrappleFireSpeed,
      vy: dy * C.GrappleFireSpeed,
      // Launch point, kept so the renderer can draw the trailing cable from
      // the thrower's hand out to the flying claw head.
      ox: seat.x + dx * C.MuzzleOffset,
      oy: seat.y + dy * C.MuzzleOffset,
    });
  }

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
        } else if (b.speedMult === 0 && b.speedRemaining > 0) {
          // Frozen (Freeze Stopwatch): the bomb is invincible while time is
          // stopped — hits still vanish the projectile but never touch time.
          addEvent(sim, "FROZEN — NO EFFECT", bombPos.x, bombPos.y);
        } else if (pr.isClaw) {
          // Latches on and reels the bomb straight to the claw owner. Reuses
          // the same b.transfer the explosion/other-claw/shot logic already
          // understands, so the bomb stays explodable/shootable/stealable
          // for the whole retract, whether it was static or already mid-pass.
          const owner = getPlayer(sim, pr.ownerId);
          if (owner && owner.alive) {
            const claimerSeat = seatPosition(owner.seat, sim.seatCount);
            const claimDist = dist(bombPos, claimerSeat);
            b.transfer = {
              fromId: b.holderId,
              toId: owner.id,
              elapsed: 0,
              duration: Math.max(0.001, claimDist / C.GrappleRetractSpeed),
              fromPos: bombPos,
              toPos: claimerSeat,
              claw: true,   // render the reel-in as a claw + cable, not a plain pass
            };
            addEvent(sim, `${owner.name} grappled the bomb!`, bombPos.x, bombPos.y);
          }
        } else if (pr.amount < 0) {
          // No floor: a gun hit can bring the bomb straight to 0 and detonate it.
          b.remaining += pr.amount;
          addEvent(sim, `${pr.amount} SEC`, bombPos.x, bombPos.y);
        } else {
          // No upper limit on bomb time.
          b.remaining += pr.amount;
          addEvent(sim, `+${pr.amount} SEC`, bombPos.x, bombPos.y);
        }
        continue;
      }

      // Fake bombs are physically real to projectiles too — a decoy that
      // let shots sail through would instantly out itself. Time hits shift
      // the decoy's own hidden timer (identical floating text included) and
      // a claw reels the decoy in exactly like the real thing.
      let hitFake = false;
      for (const f of sim.fakeBombs) {
        const fpos = fakeWorldPos(sim, f);
        if (dist(pr, fpos) > C.BombRadius + C.ProjectileRadius) continue;
        hitFake = true;
        if (pr.isClaw) {
          const owner = getPlayer(sim, pr.ownerId);
          if (owner && owner.alive) {
            const claimerSeat = seatPosition(owner.seat, sim.seatCount);
            f.transfer = {
              fromId: f.holderId,
              toId: owner.id,
              elapsed: 0,
              duration: Math.max(0.001, dist(fpos, claimerSeat) / C.GrappleRetractSpeed),
              fromPos: fpos,
              toPos: claimerSeat,
              claw: true,
            };
            addEvent(sim, `${owner.name} grappled the bomb!`, fpos.x, fpos.y);
          }
        } else {
          // Can drive it to 0 early: it just pops harmlessly next tick.
          f.remaining += pr.amount;
          addEvent(sim, `${pr.amount > 0 ? "+" : ""}${pr.amount} SEC`, fpos.x, fpos.y);
        }
        break;
      }
      if (hitFake) continue;

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
        advanceBombTransfer(sim, dt);
        if (sim.phaseTimer <= 0) {
          sim.phase = "countdown";
          sim.phaseTimer = C.CountdownSeconds;
        }
        break;

      case "countdown":
        sim.phaseTimer -= dt;
        allowDraws(sim, inputs);
        advanceBombTransfer(sim, dt);
        if (sim.phaseTimer <= 0) {
          // Countdown over: timer goes hidden, gameplay starts. The initial
          // holder should already have the bomb from its travel-in transfer;
          // this is just a safety net in case it hasn't landed yet.
          sim.phase = "playing";
          if (!sim.bomb.holderId) {
            const targetId = sim.bomb.transfer ? sim.bomb.transfer.toId : null;
            const alive = sim.players.filter(p => p.alive);
            const first = getPlayer(sim, targetId) || alive[Math.floor(Math.random() * alive.length)];
            sim.bomb.transfer = null;
            if (first) {
              giveBomb(sim, first);
              addEvent(sim, `${first.name} starts with the bomb!`);
            }
          }
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

    // Real-time window right after gameplay starts where the remaining time
    // is shown to everyone, before it goes hidden for the rest of the bomb.
    sim.playElapsed += dt;

    // Bomb countdown, scaled by the (non-stacking) speed modifier.
    if (b.speedRemaining > 0) {
      b.speedRemaining -= dt;
      if (b.speedRemaining <= 0) { b.speedMult = 1; b.speedRemaining = 0; }
    }
    if (b.shieldRemaining > 0) b.shieldRemaining = Math.max(0, b.shieldRemaining - dt);
    b.remaining -= dt * b.speedMult;

    // Advance an in-flight pass. The bomb keeps counting down while it
    // travels, so explode() below still has the right transfer state if it
    // reaches 0 mid-pass.
    advanceBombTransfer(sim, dt);

    const holder = getPlayer(sim, b.holderId);
    const coinScale = coinIntervalScale(sim);

    for (const p of sim.players) {
      if (!p.alive) continue;
      const inp = inputs[p.id] || {};

      // Cosmetic only: which hand slot (if any) this player is currently
      // aiming, so everyone can see they're wielding a thrown/fired weapon.
      p.equippedSlot = (typeof inp.equip === "number" && p.hand[inp.equip] &&
        ["projectile", "grapple"].includes(Cards.TYPES[p.hand[inp.equip]].kind)) ? inp.equip : null;

      // Passive income for everyone alive is the universal baseline. The
      // holder bonus ("farming") is no longer paid to the carrier while they
      // hold — instead it accrues onto the bomb itself as a pot, cashed in by
      // whoever throws it (see controlHeldBomb). A fake accrues onto its own
      // pot and shows the identical farming animation, but its pot is never
      // paid out on release — the bluff costs the decoy nothing real.
      const heldBomb = (p === holder && !b.transfer) ? b : fakeHeldBy(sim, p.id);
      const holding = !!heldBomb;
      const stalling = holding && p.holdElapsed >= C.BombHolderCoinDuration;
      if (holding) {
        // Farming the bomb replaces passive income entirely, not stacks on
        // top of it — no natural growth while holding, only the pot.
        p.passiveAcc = 0;
        if (stalling) {
          p.holderAcc = 0;
        } else {
          p.holderAcc += dt;
          const holderInterval = C.BombHolderCoinInterval * coinScale;
          while (p.holderAcc >= holderInterval) {
            p.holderAcc -= holderInterval;
            heldBomb.pot += C.BombHolderCoinAmount;
          }
        }
      } else {
        p.passiveAcc += dt;
        const passiveInterval = C.PassiveCoinInterval * coinScale;
        while (p.passiveAcc >= passiveInterval) {
          p.passiveAcc -= passiveInterval;
          p.coins += C.PassiveCoinAmount;
        }
      }
      if (holding) p.holdElapsed += dt;

      if (p.revealRemaining > 0) p.revealRemaining = Math.max(0, p.revealRemaining - dt);
      if (p.armBuffRemaining > 0) p.armBuffRemaining = Math.max(0, p.armBuffRemaining - dt);
      p.passLock = Math.max(0, p.passLock - dt);

      // Whichever bomb this player is physically holding right now — the
      // real one or a fake decoy — is carried and thrown through the exact
      // same code path, so nothing about the handling can give a fake away.
      const heldFake = fakeHeldBy(sim, p.id);
      if (p === holder && !b.transfer) {
        controlHeldBomb(sim, p, b, inp, dt);
      } else if (heldFake) {
        controlHeldBomb(sim, p, heldFake, inp, dt);
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

    stepFakeBombs(sim, dt);
    stepProjectiles(sim, dt);

    if (b.remaining <= 0) explode(sim);
  }

  // Arm control + SPACE pass for whichever bomb the player is physically
  // holding. The real bomb and fake decoys share this deliberately: the
  // clamped arm movement, pass lock, Reinforced Arm free-targeting/speed and
  // even the public "is passing the bomb" announcement are all identical.
  // The client only sends a mouse position; the host computes and clamps the
  // actual offset and moves it at a limited speed — the arm never teleports.
  function controlHeldBomb(sim, p, bombLike, inp, dt) {
    const seat = seatPosition(p.seat, sim.seatCount);
    const dx = p.aim.x - seat.x, dy = p.aim.y - seat.y;
    const len = Math.hypot(dx, dy);
    let target = bombLike.offset;
    if (len > 0.001) {
      const r = Math.min(len, C.BombArmReach);
      target = { x: (dx / len) * r, y: (dy / len) * r };
    }
    const ox = target.x - bombLike.offset.x, oy = target.y - bombLike.offset.y;
    const step = Math.hypot(ox, oy);
    const maxStep = C.BombArmMoveSpeed * dt;
    bombLike.offset = (step <= maxStep || step < 0.001)
      ? target
      : { x: bombLike.offset.x + (ox / step) * maxStep, y: bombLike.offset.y + (oy / step) * maxStep };

    if (inp.pass && p.passLock <= 0) {
      const buffed = p.armBuffRemaining > 0;
      // Reinforced Arm: pick whichever other alive player is nearest to
      // the live aim point instead of the fixed next-seat order.
      const next = buffed ? nearestAliveTo(sim, p.aim, p.id) : nextAliveFrom(sim, p.seat);
      if (next && next !== p) {
        const fromPos = { x: seat.x + bombLike.offset.x, y: seat.y + bombLike.offset.y };
        const toPos = seatPosition(next.seat, sim.seatCount);
        const speed = buffed ? C.BombPassSpeed * C.ReinforcedArmSpeedMult : C.BombPassSpeed;
        // holderId stays on the sender while in flight for real and fake
        // alike (arrival reassigns it), so mid-pass state looks the same.
        bombLike.transfer = {
          fromId: p.id,
          toId: next.id,
          elapsed: 0,
          duration: Math.max(0.001, dist(fromPos, toPos) / speed),
          fromPos,
          toPos,
        };
        // Cash in the farming pot at the moment of release. The real bomb pays
        // its pot to the thrower; a fake had the identical buildup and
        // animation but its release cashes out nothing. The public event log
        // stays silent about it — announcing the payout would reveal which
        // bomb was the decoy — but the thrower gets a private "+N" cue
        // (see the `you.payout` snapshot field) visible only to themselves.
        if (bombLike === sim.bomb && bombLike.pot > 0) {
          p.coins += bombLike.pot;
          p.lastPayoutAmount = bombLike.pot;
          p.lastPayoutSeq += 1;
        }
        bombLike.pot = 0;
        addEvent(sim, `${p.name} is passing the bomb to ${next.name}...`);
      }
    }
  }

  // Per-tick fake bomb upkeep: each decoy runs its own hidden countdown (a
  // harmless staged pop at 0) and settles transfer arrivals with the same
  // hot-potato bounce rule as the real bomb.
  function stepFakeBombs(sim, dt) {
    const survivors = [];
    for (const f of sim.fakeBombs) {
      f.remaining -= dt;
      if (f.revealRemaining > 0) f.revealRemaining = Math.max(0, f.revealRemaining - dt);
      if (f.remaining <= 0) {
        const pos = fakeWorldPos(sim, f);
        const holder = !f.transfer ? getPlayer(sim, f.holderId) : null;
        // Mid-air pops get the same staged blast presentation as a real
        // mid-air explosion; in someone's hands it bursts instantly like a
        // real in-hand one. Either way: zero damage, bluff revealed.
        addEffect(sim, "fakeboom", pos.x, pos.y, { midAir: !!f.transfer });
        addEvent(sim, holder ? `BOOM! ...${holder.name}'s bomb was a FAKE` : "BOOM! ...that bomb was a FAKE", pos.x, pos.y);
        continue;
      }
      if (f.transfer) {
        f.transfer.elapsed += dt;
        if (f.transfer.elapsed >= f.transfer.duration) {
          const receiver = getPlayer(sim, f.transfer.toId);
          const arrivedAt = f.transfer.toPos;
          f.transfer = null;
          f.holderId = null;
          if (!receiver || !receiver.alive) {
            // Receiver died or vanished mid-flight: keep the decoy moving to
            // the next alive seat, or let it vanish if nobody is left.
            const next = nextAliveFrom(sim, receiver ? receiver.seat : 0);
            if (!next) continue;
            startFakeTransfer(sim, f, arrivedAt, next, null);
          } else if (holdsAnyBomb(sim, receiver)) {
            // Hot potato: the arriving decoy stays in the receiver's hands and
            // whatever they were already holding (real or fake) is the one
            // thrown onward. If there's nowhere to send the old bomb, the
            // newcomer pops harmlessly instead so nobody ends up double-handed.
            f.holderId = receiver.id;
            f.offset = { x: 0, y: 0 };
            f.pot = 0;
            if (throwOtherBombOnward(sim, receiver, f)) {
              receiver.holderAcc = 0;
              receiver.holdElapsed = 0;
              receiver.passLock = Math.max(receiver.passLock, C.FakeBombForcedPassLock);
              addEvent(sim, `${receiver.name} was already holding a bomb — passed one on!`);
            } else {
              f.holderId = null;
              addEffect(sim, "fakeboom", arrivedAt.x, arrivedAt.y, { midAir: true });
              addEvent(sim, "BOOM! ...that bomb was a FAKE", arrivedAt.x, arrivedAt.y);
              continue;
            }
          } else {
            f.holderId = receiver.id;
            f.offset = { x: 0, y: 0 };
            f.pot = 0;
            // Same holder-income reset as giveBomb: the receiver's carry
            // window reopens so a passed decoy farms and animates like a real bomb.
            receiver.holderAcc = 0;
            receiver.holdElapsed = 0;
            addEvent(sim, `${receiver.name} received the bomb`);
          }
        }
      }
      survivors.push(f);
    }
    sim.fakeBombs = survivors;
  }

  // Launch a fake bomb toward a seat at normal pass speed. holderId mirrors
  // the real bomb's mid-flight convention (the player it's "coming from", or
  // null when it's being forwarded off a dead seat).
  function startFakeTransfer(sim, f, fromPos, toPlayer, holderId) {
    const toPos = seatPosition(toPlayer.seat, sim.seatCount);
    f.holderId = holderId;
    f.transfer = {
      fromId: holderId,
      toId: toPlayer.id,
      elapsed: 0,
      duration: Math.max(0.001, dist(fromPos, toPos) / C.BombPassSpeed),
      fromPos,
      toPos,
    };
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
      explosionVictimPos: sim.phase === "exploding" ? sim.explosionVictimPos : null,
      explosionVictimId: sim.phase === "exploding" ? sim.explosionVictimId : null,
      explosionMidAir: sim.phase === "exploding" ? sim.explosionMidAir : false,
      bomb: b ? {
        x: bombPos.x,
        y: bombPos.y,
        holderId: b.holderId,
        initialTime: b.initialTime,        // public: players know the starting time
        shield: b.shieldRemaining > 0,     // announced publicly, so visible
        curse: b.curseActive,              // announced publicly, so visible
        speedMult: b.speedMult,            // Speed Up/Down are announced publicly too
        transferring: !!b.transfer,        // in flight between seats: render it mid-pass
        // Being reeled in by a Grapple Claw: render a cable + claw gripping
        // the bomb, anchored at the puller's seat (the transfer target).
        claw: !!(b.transfer && b.transfer.claw),
        clawX: b.transfer && b.transfer.claw ? b.transfer.toPos.x : null,
        clawY: b.transfer && b.transfer.claw ? b.transfer.toPos.y : null,
        // Public reveal window: everyone can see the exact remaining time for
        // the first few real seconds of a bomb, then it goes hidden as usual.
        publicRemaining: (sim.phase === "playing" && sim.playElapsed < C.PublicTimeRevealDuration)
          ? b.remaining : null,
      } : null,
      // Fake decoys, rendered with the identical bomb body + holder arms as
      // the real one. Which one is real is never derivable from position,
      // carry or pass behavior — that's the whole bluff.
      fakeBombs: sim.fakeBombs.map(f => {
        const pos = fakeWorldPos(sim, f);
        return {
          x: pos.x,
          y: pos.y,
          holderId: f.holderId,
          transferring: !!f.transfer,
          claw: !!(f.transfer && f.transfer.claw),
          clawX: f.transfer && f.transfer.claw ? f.transfer.toPos.x : null,
          clawY: f.transfer && f.transfer.claw ? f.transfer.toPos.y : null,
          // Per-viewer private read of the decoy's timer, delivered only
          // inside this viewer's snapshot. Present in two cases, both
          // identical to how the real bomb reveals so a fake stays hidden:
          //   1. the creator's brief peek right after pulling it out, and
          //   2. anyone sweeping a live Magnifying Glass box-cast over it
          //      (or any spectator, who sees every timer).
          privateRemaining: (
            (f.revealTo === viewerId && f.revealRemaining > 0) ||
            (viewer && sim.phase === "playing" &&
              (!viewer.alive || (viewer.revealRemaining > 0 && magnifyCoversPos(sim, viewer, pos))))
          ) ? f.remaining : null,
        };
      }),
      players: sim.players.map(p => {
        const seat = seatPosition(p.seat, sim.seatCount);
        const equipped = p.equippedSlot != null;
        const revealing = p.revealRemaining > 0;
        // Real or fake — a bomb in this player's charge (holderId-based, so
        // it holds through a pass) lights the same income cue, so the coin
        // trickle can't be used to tell a decoy from the real bomb.
        const isHolderNow = !!(b && b.holderId === p.id) || sim.fakeBombs.some(f => f.holderId === p.id);
        return {
          id: p.id, name: p.name, seat: p.seat, x: seat.x, y: seat.y, alive: p.alive,
          equipped,                          // wielding a throwable/gun card — visible to everyone
          // Aim direction is public whenever a weapon or the magnifying glass
          // box-cast is out — everyone can see *where* it's pointed, never
          // the private reading it gives its owner.
          aimX: (equipped || revealing) ? p.aim.x : null,
          aimY: (equipped || revealing) ? p.aim.y : null,
          revealing,                         // using a Magnifying Glass right now — visible to everyone (not the reading itself)
          // Currently inside the holder-bonus income window — visible to
          // everyone so the extra coin trickle can be shown as a particle cue.
          earningBonus: isHolderNow && p.holdElapsed < C.BombHolderCoinDuration,
          // Past the grace window: holding the bomb currently earns nothing —
          // shown so everyone can see the stalling penalty has kicked in.
          earningPenalty: isHolderNow && p.holdElapsed >= C.BombHolderCoinDuration,
          // Coins and hand size are public — hovering another player shows
          // both so you can size up who's ahead and who's stocked up on cards.
          coins: p.coins,
          cardCount: p.hand.filter(c => c != null).length,
          // Reinforced Arm: public "iron arm" cue while the buff is active.
          armBuffed: p.armBuffRemaining > 0,
        };
      }),
      you: viewer ? {
        id: viewer.id,
        alive: viewer.alive,
        coins: viewer.coins,
        hand: viewer.hand.slice(),
        isHolder: !!(b && b.holderId === viewerId),
        // Fake-bomb mirror of isHolder, split into "in my hands right now"
        // and "my throw is still in flight" so the local UI (pass button,
        // hands-full card locks) can treat a fake exactly like the real one.
        holdsFake: !!fakeHeldBy(sim, viewerId),
        fakePassing: sim.fakeBombs.some(f => f.holderId === viewerId && f.transfer),
        // Present once at least one shot of a multi-click gun has already
        // been fired: canceling now must discard the unfired rounds rather
        // than leaving the card untouched.
        gunPending: viewer.gunPending ? { slot: viewer.gunPending.slot, shotsLeft: viewer.gunPending.shotsLeft } : null,
        passLock: viewer.passLock,
        canPass: !!(sim.phase === "playing" && viewer.passLock <= 0 &&
          ((b && !b.transfer && b.holderId === viewerId) || fakeHeldBy(sim, viewerId))),
        // Spectators (eliminated, waiting out the match) always see the exact
        // bomb time — they can no longer affect gameplay, so there's nothing
        // left to hide from them. Living players need an active Magnifying
        // Glass window *and* their box-cast actually over the bomb this tick.
        reveal: (b && sim.phase === "playing" &&
            (!viewer.alive || (viewer.revealRemaining > 0 && magnifyCoversPos(sim, viewer, bombPos))))
          ? { remaining: viewer.revealRemaining, bombTime: b.remaining }
          : null,
        // Private farmed-pot cash-in cue: bumps `seq` every payout so the
        // client can pop a one-shot "+N" even if the amount repeats. Never
        // sent to anyone but the thrower — showing it publicly would out a
        // decoy the instant its (nonexistent) payout failed to appear.
        payout: { amount: viewer.lastPayoutAmount, seq: viewer.lastPayoutSeq },
      } : null,
      projectiles: sim.projectiles.map(pr => ({
        x: pr.x, y: pr.y, amount: pr.amount, isClaw: !!pr.isClaw,
        ox: pr.isClaw ? pr.ox : undefined, oy: pr.isClaw ? pr.oy : undefined,
      })),
      events: sim.events.slice(-30),
      effects: sim.effects.slice(-8),
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
      fakeBombs: sim.fakeBombs.map(f => ({
        holder: f.holderId ? ((getPlayer(sim, f.holderId) || {}).name || f.holderId) : "-",
        to: f.transfer ? ((getPlayer(sim, f.transfer.toId) || {}).name || "?") : null,
        remaining: f.remaining,
      })),
      players: sim.players.map(p => ({
        name: p.name,
        state: p.disconnected ? "disconnected" : (p.alive ? "alive" : "spectator"),
        coins: p.coins,
        hand: p.hand.map(id => id ? Cards.TYPES[id].name : "-"),
        passLock: p.passLock,
      })),
    };
  }

  return {
    createMatch, step, buildSnapshot, resetMatch, dropPlayer,
    seatPosition, bombWorldPos, getPlayer,
  };
})();
