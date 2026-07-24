"use strict";

// Host-side bots submit the same input shape as human clients. Their private
// brain state deliberately models notice chance, reaction time and imperfect
// aim so authoritative world access does not turn into superhuman reactions.
const AI = (() => {
  const C = CONFIG;

  function createBrain() {
    return {
      roundNumber: null,
      holdUntil: null,
      nextActAt: 0,
      wander: Math.random() * Math.PI * 2,
      aimSlot: null,
      aimReadyAt: 0,
      parryTransferId: null,
      parryWillAttempt: false,
      parryAt: Infinity,
      seenProjectileIds: new Set(),
      dodge: null,
      knownBombRemaining: null,
      knownBombAt: 0,
      knownBombSpeedMult: 1,
      knownBombRound: null,
      forcePass: false,
      reinforcedTargetId: null,
      slingCharging: false,
      slingTargetId: null,
      slingAimReadyAt: 0,
      blackoutAim: Math.random() * Math.PI * 2,
    };
  }

  function resetRoundState(sim, brain) {
    if (brain.roundNumber === sim.roundNumber) return;
    brain.roundNumber = sim.roundNumber;
    brain.holdUntil = null;
    brain.nextActAt = sim.time + 0.5 + Math.random();
    brain.aimSlot = null;
    brain.parryTransferId = null;
    brain.parryWillAttempt = false;
    brain.parryAt = Infinity;
    brain.seenProjectileIds.clear();
    brain.dodge = null;
    brain.knownBombRemaining = null;
    brain.knownBombSpeedMult = 1;
    brain.knownBombRound = null;
    brain.forcePass = false;
    brain.reinforcedTargetId = null;
    brain.slingCharging = false;
    brain.slingTargetId = null;
    brain.slingAimReadyAt = 0;
  }

  function findSlot(player, pred) {
    return player.hand.findIndex(id => id != null && pred(Cards.TYPES[id]));
  }

  function cardAt(player, slot) {
    const id = player.hand[slot];
    return id ? Cards.TYPES[id] : null;
  }

  function randomChoice(values) {
    return values[Math.floor(Math.random() * values.length)];
  }

  function isOpponent(sim, player, other) {
    return !!other && other.id !== player.id &&
      (sim.teamCount <= 1 || other.team !== player.team);
  }

  function sameTeam(sim, player, other) {
    return !!other && other.id !== player.id &&
      sim.teamCount > 1 && other.team === player.team;
  }

  function nextAliveInDirection(sim, seat, reversed) {
    const direction = reversed ? -1 : 1;
    for (let k = 1; k <= sim.seatCount; k++) {
      const wanted = (seat + direction * k + sim.seatCount * 2) % sim.seatCount;
      const candidate = sim.players.find(p => p.seat === wanted);
      if (candidate && candidate.alive) return candidate;
    }
    return null;
  }

  function nextPassRecipient(sim, player, reversed = sim.reversePassing) {
    return nextAliveInDirection(sim, player.seat, reversed);
  }

  // During flight, strategic effects apply to the receiver rather than the
  // sender whose holderId remains attached until arrival.
  function effectiveBombHolder(sim) {
    const b = sim.bomb;
    if (!b) return null;
    return Sim.getPlayer(sim, b.transfer ? b.transfer.toId : b.holderId);
  }

  function nextCurseVictim(sim) {
    const b = sim.bomb;
    if (!b) return null;
    if (b.transfer) return Sim.getPlayer(sim, b.transfer.toId);
    const holder = Sim.getPlayer(sim, b.holderId);
    return holder ? nextPassRecipient(sim, holder) : null;
  }

  function pointInCast(sim, player, point, radius, halfWidth) {
    const seat = Sim.seatPosition(player.seat, sim.seatCount);
    let dx = player.aim.x - seat.x, dy = player.aim.y - seat.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return false;
    dx /= len; dy /= len;
    const fx = point.x - seat.x, fy = point.y - seat.y;
    const forward = fx * dx + fy * dy;
    const side = fx * -dy + fy * dx;
    return forward >= -radius &&
      forward <= C.MagnifyCastLength + radius &&
      Math.abs(side) <= halfWidth + radius;
  }

  function canSeePoint(sim, player, point, radius = 0) {
    if (!point || !player.alive || sim.blackoutRemaining <= 0) return true;
    const seat = Sim.seatPosition(player.seat, sim.seatCount);
    if (Math.hypot(point.x - seat.x, point.y - seat.y) <=
        C.BlackoutVisionRadius + radius) return true;
    return player.revealRemaining > 0 &&
      pointInCast(sim, player, point, radius, C.MagnifyCastWidth * 1.4);
  }

  function aimIntoDarkness(sim, player, brain, inp) {
    const seat = Sim.seatPosition(player.seat, sim.seatCount);
    brain.blackoutAim += 0.04 + (Math.random() - 0.5) * 0.01;
    inp.mx = seat.x + Math.cos(brain.blackoutAim) * C.AimLineLength;
    inp.my = seat.y + Math.sin(brain.blackoutAim) * C.AimLineLength;
  }

  function bombLikeWorldPos(sim, bombLike) {
    if (bombLike === sim.bomb) return Sim.bombWorldPos(sim);
    if (bombLike.transfer) {
      const tr = bombLike.transfer;
      const t = Math.min(1, tr.elapsed / tr.duration);
      return {
        x: tr.fromPos.x + (tr.toPos.x - tr.fromPos.x) * t,
        y: tr.fromPos.y + (tr.toPos.y - tr.fromPos.y) * t,
      };
    }
    const holder = Sim.getPlayer(sim, bombLike.holderId);
    if (!holder) return null;
    const seat = Sim.seatPosition(holder.seat, sim.seatCount);
    return { x: seat.x + bombLike.offset.x, y: seat.y + bombLike.offset.y };
  }

  function shieldCoversRealBomb(sim, bombPos) {
    const b = sim.bomb;
    if (!b || b.shieldRemaining <= 0 || !b.shieldOwnerId) return false;
    const owner = Sim.getPlayer(sim, b.shieldOwnerId);
    if (!owner) return false;
    const seat = Sim.seatPosition(owner.seat, sim.seatCount);
    return Math.hypot(bombPos.x - seat.x, bombPos.y - seat.y) <=
      C.BombArmReach + C.BombRadius;
  }

  function magnifyCoversRealBomb(sim, player, bombPos) {
    if (player.revealRemaining <= 0 || shieldCoversRealBomb(sim, bombPos)) return false;
    return pointInCast(sim, player, bombPos, C.BombRadius,
      C.MagnifyCastWidth / 2);
  }

  function rememberVisibleTimer(sim, player, brain, bombPos) {
    const publicTimer = sim.playElapsed < C.PublicTimeRevealDuration &&
      canSeePoint(sim, player, bombPos, C.BombRadius);
    const privateTimer = magnifyCoversRealBomb(sim, player, bombPos);
    if (!publicTimer && !privateTimer) return false;
    brain.knownBombRemaining = sim.bomb.remaining;
    brain.knownBombAt = sim.time;
    brain.knownBombSpeedMult = sim.bomb.speedMult;
    brain.knownBombRound = sim.roundNumber;
    return privateTimer;
  }

  function advanceKnownTimer(sim, brain) {
    if (brain.knownBombRound !== sim.roundNumber ||
        brain.knownBombRemaining == null) return;
    brain.knownBombRemaining -= Math.max(0, sim.time - brain.knownBombAt) *
      brain.knownBombSpeedMult;
    brain.knownBombAt = sim.time;
    brain.knownBombSpeedMult = sim.bomb.speedMult;
  }

  function estimatedKnownTime(sim, brain) {
    if (brain.knownBombRound !== sim.roundNumber) return null;
    return brain.knownBombRemaining;
  }

  // Find a projectile whose current line actually intersects the bomb. Each
  // projectile gets only one notice roll; a miss is not re-rolled every tick.
  function noticeProjectileThreat(sim, player, brain, bombPos) {
    if (brain.dodge) {
      const stillFlying = sim.projectiles.some(pr => pr.id === brain.dodge.projectileId);
      if (stillFlying && sim.time <= brain.dodge.expiresAt) return brain.dodge;
      brain.dodge = null;
    }

    const candidates = [];
    for (const pr of sim.projectiles) {
      if (pr.amount == null || pr.amount >= 0 || brain.seenProjectileIds.has(pr.id)) continue;
      if (!canSeePoint(sim, player, pr, C.ProjectileRadius)) continue;
      const speedSq = pr.vx * pr.vx + pr.vy * pr.vy;
      if (speedSq < 1) continue;
      const rx = bombPos.x - pr.x, ry = bombPos.y - pr.y;
      const arrival = (rx * pr.vx + ry * pr.vy) / speedSq;
      if (arrival <= 0 || arrival > C.BotProjectileAwarenessTime) continue;
      const closestX = pr.x + pr.vx * arrival;
      const closestY = pr.y + pr.vy * arrival;
      const miss = Math.hypot(closestX - bombPos.x, closestY - bombPos.y);
      if (miss <= C.BombRadius + C.ProjectileRadius + 4) {
        candidates.push({ pr, arrival });
      }
    }
    candidates.sort((a, z) => a.arrival - z.arrival);

    for (const candidate of candidates) {
      const pr = candidate.pr;
      brain.seenProjectileIds.add(pr.id);
      if (Math.random() > C.BotProjectileNoticeChance) continue;
      const speed = Math.hypot(pr.vx, pr.vy) || 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      brain.dodge = {
        projectileId: pr.id,
        readyAt: sim.time + C.BotDodgeReactionMin +
          Math.random() * C.BotDodgeReactionJitter,
        expiresAt: sim.time + candidate.arrival + 0.12,
        px: -pr.vy / speed * side,
        py: pr.vx / speed * side,
        errorX: (Math.random() * 2 - 1) * C.BotDodgeAimError,
        errorY: (Math.random() * 2 - 1) * C.BotDodgeAimError,
      };
      return brain.dodge;
    }
    return null;
  }

  function considerParry(sim, player, brain, inp) {
    const incoming = [sim.bomb, ...sim.fakeBombs]
      .filter(x => x && x.transfer && x.transfer.parryable &&
        x.transfer.toId === player.id && !x.transfer.parryQueued &&
        !x.transfer.parryDenied)
      .sort((a, z) =>
        (a.transfer.duration - a.transfer.elapsed) -
        (z.transfer.duration - z.transfer.elapsed))[0];
    if (!incoming) return;

    const tr = incoming.transfer;
    if (!canSeePoint(sim, player, bombLikeWorldPos(sim, incoming), C.BombRadius)) return;
    const returnTarget = nextPassRecipient(sim, player);
    if (sameTeam(sim, player, returnTarget)) return;
    if (brain.parryTransferId !== tr.id) {
      brain.parryTransferId = tr.id;
      brain.parryWillAttempt = tr.speed <= C.BotParryMaxIncomingSpeed &&
        Math.random() < C.BotParryChance;
      brain.parryAt = Infinity;
      if (brain.parryWillAttempt) {
        const total = C.ParryPunishWindow + C.ParryWindow;
        const window = C.ParryWindow * Math.min(1, tr.duration / total);
        const remaining = Math.max(0, tr.duration - tr.elapsed);
        const pressAt = sim.time + remaining - window * (0.25 + Math.random() * 0.5);
        const reaction = C.BotDodgeReactionMin + Math.random() * 0.12;
        if (pressAt - sim.time < reaction) brain.parryWillAttempt = false;
        else brain.parryAt = pressAt;
      }
    }
    if (brain.parryWillAttempt && sim.time >= brain.parryAt &&
        tr.duration - tr.elapsed > 0) {
      inp.parry.push({ transferId: tr.id, outcome: "success" });
      brain.parryWillAttempt = false;
    }
  }

  function chooseReinforcedTarget(sim, player) {
    const opponents = sim.players.filter(p => {
      if (!p.alive || !isOpponent(sim, player, p)) return false;
      const seat = Sim.seatPosition(p.seat, sim.seatCount);
      return canSeePoint(sim, player, seat, C.PlayerBodyRadius);
    });
    return opponents.length ? randomChoice(opponents) : null;
  }

  function startAimedItem(sim, player, brain, inp, slot) {
    brain.aimSlot = slot;
    brain.aimReadyAt = sim.time + C.BotAimDuration + Math.random() * C.BotAimJitter;
    inp.equip = slot;
  }

  function aimedItemIsSafe(sim, player, def) {
    const holder = effectiveBombHolder(sim);
    if (!holder || sim.teamCount <= 1) return true;
    if (def.kind === "projectile" && def.amount > 0) {
      return sameTeam(sim, player, holder);
    }
    return isOpponent(sim, player, holder);
  }

  function speedItemIsSafe(sim, player, def) {
    const holder = effectiveBombHolder(sim);
    if (!holder || sim.teamCount <= 1) return true;
    return def.mult < 1
      ? holder.id === player.id || sameTeam(sim, player, holder)
      : isOpponent(sim, player, holder);
  }

  function curseIsSafe(sim, player) {
    const victim = nextCurseVictim(sim);
    return !victim || sim.teamCount <= 1 || isOpponent(sim, player, victim);
  }

  function reverseHelpsTeam(sim, player) {
    if (sim.teamCount <= 1) return true;
    const b = sim.bomb;
    if (!b || b.transfer) return false;
    const holder = Sim.getPlayer(sim, b.holderId);
    if (!holder) return false;
    const current = nextPassRecipient(sim, holder, sim.reversePassing);
    const reversed = nextPassRecipient(sim, holder, !sim.reversePassing);
    return sameTeam(sim, player, current) && isOpponent(sim, player, reversed);
  }

  function continueAimedItem(sim, player, brain, inp) {
    if (brain.aimSlot == null) return false;
    const def = cardAt(player, brain.aimSlot);
    const bombPos = Sim.bombWorldPos(sim);
    if (!def || !["projectile", "grapple"].includes(def.kind) ||
        shieldCoversRealBomb(sim, bombPos) ||
        !canSeePoint(sim, player, bombPos, C.BombRadius) ||
        !aimedItemIsSafe(sim, player, def)) {
      brain.aimSlot = null;
      return false;
    }

    inp.equip = brain.aimSlot;
    if (sim.time < brain.aimReadyAt) return true;
    if (def.kind === "projectile" && def.gunStyle === "auto") {
      inp.gunFireSlot = brain.aimSlot;
    } else {
      inp.use.push(brain.aimSlot);
    }
    brain.aimSlot = null;
    return true;
  }

  function slingTargetIsSafe(sim, player, bombPos) {
    const holder = effectiveBombHolder(sim);
    if (!holder || holder.id === player.id ||
        !canSeePoint(sim, player, bombPos, C.BombRadius)) return false;
    return sim.teamCount <= 1 || isOpponent(sim, player, holder);
  }

  function aimSlingAway(sim, player, brain, inp) {
    if (sim.blackoutRemaining > 0) {
      aimIntoDarkness(sim, player, brain, inp);
      return;
    }
    const seat = Sim.seatPosition(player.seat, sim.seatCount);
    const centerX = C.WorldWidth / 2, centerY = C.WorldHeight / 2;
    let dx = seat.x - centerX, dy = seat.y - centerY;
    const len = Math.hypot(dx, dy) || 1;
    inp.mx = seat.x + dx / len * C.AimLineLength;
    inp.my = seat.y + dy / len * C.AimLineLength;
  }

  function continueSling(sim, player, brain, inp, bombPos) {
    if (!brain.slingCharging) return false;
    const holder = effectiveBombHolder(sim);
    if (!slingTargetIsSafe(sim, player, bombPos)) {
      brain.slingTargetId = null;
      inp.primaryFire = true; // keep the charged shot; never release it toward a teammate
      aimSlingAway(sim, player, brain, inp);
      return true;
    }

    if (brain.slingTargetId !== holder.id) {
      brain.slingTargetId = holder.id;
      brain.slingAimReadyAt = sim.time + C.BotAimDuration +
        Math.random() * C.BotAimJitter;
    }
    inp.mx = bombPos.x;
    inp.my = bombPos.y;
    const fullyCharged = player.deadWeaponCharge + 1e-9 >= C.ChargedShotChargeTime;
    if (fullyCharged && sim.time >= brain.slingAimReadyAt) {
      inp.primaryFire = false;
      brain.slingCharging = false;
      brain.slingTargetId = null;
      brain.nextActAt = sim.time + 1.2 + Math.random() * 2.8;
    } else {
      inp.primaryFire = true;
    }
    return true;
  }

  function startSling(sim, player, brain, inp, bombPos) {
    const holder = effectiveBombHolder(sim);
    if (!holder || !slingTargetIsSafe(sim, player, bombPos)) return false;
    brain.slingCharging = true;
    brain.slingTargetId = holder.id;
    brain.slingAimReadyAt = sim.time + C.BotAimDuration +
      Math.random() * C.BotAimJitter;
    inp.mx = bombPos.x;
    inp.my = bombPos.y;
    inp.primaryFire = true;
    return true;
  }

  function deadItemIsSafe(sim, player, def) {
    if (!def || sim.teamCount <= 1 || def.kind === "blackout") return !!def;
    if (def.kind === "speed") return speedItemIsSafe(sim, player, def);
    if (def.kind === "reverse") return reverseHelpsTeam(sim, player);
    return false;
  }

  function useHeldItem(sim, player, brain, inp, threat, exactPrivateTimer) {
    const b = sim.bomb;
    const shield = findSlot(player, d => d.kind === "shield");
    if (threat && sim.time >= threat.readyAt &&
        shield >= 0 && b.shieldRemaining <= 0) {
      inp.use.push(shield);
      brain.nextActAt = sim.time + 1.5 + Math.random() * 2;
      return;
    }
    if (sim.time < brain.nextActAt) return;

    const known = estimatedKnownTime(sim, brain);
    const choices = [];
    for (let slot = 0; slot < player.hand.length; slot++) {
      const def = cardAt(player, slot);
      if (!def) continue;
      if (def.kind === "magnify" && player.revealRemaining <= 0 &&
          sim.playElapsed >= C.PublicTimeRevealDuration) {
        choices.push(slot, slot); // information is especially useful while carrying
      } else if (def.kind === "speed" && def.mult < 1 &&
          speedItemIsSafe(sim, player, def) &&
          (b.speedMult > 1 || known == null || known <= C.BotKnownBombPanicTime + 2)) {
        choices.push(slot);
      } else if (def.kind === "shield" && b.shieldRemaining <= 0) {
        choices.push(slot);
      } else if (def.kind === "curse" && !b.curseActive &&
          curseIsSafe(sim, player)) {
        choices.push(slot);
      } else if (def.kind === "blackout") {
        choices.push(slot);
      } else if (def.kind === "emp" &&
          (b.timerJamRemaining <= 0 ||
            sim.fakeBombs.some(f => f.timerJamRemaining <= 0))) {
        choices.push(slot);
      } else if (def.kind === "reverse" && reverseHelpsTeam(sim, player)) {
        choices.push(slot);
      } else if (def.kind === "reinforced" && player.armBuffRemaining <= 0 &&
          chooseReinforcedTarget(sim, player)) {
        choices.push(slot);
      }
    }

    if (choices.length) {
      const slot = randomChoice(choices);
      const def = cardAt(player, slot);
      inp.use.push(slot);
      if (def.kind === "reinforced") {
        const target = chooseReinforcedTarget(sim, player);
        brain.reinforcedTargetId = target ? target.id : null;
        brain.forcePass = true;
      } else if (def.kind === "reverse" && b.holderId === player.id) {
        brain.forcePass = true;
      }
      if (def.kind === "magnify" || exactPrivateTimer) {
        // Give the cast one tick to become authoritative before deciding.
        brain.holdUntil = Math.max(brain.holdUntil || 0, sim.time + 0.1);
      }
    }
    brain.nextActAt = sim.time + 1.2 + Math.random() * 2.8;
  }

  function useFreeHandItem(sim, player, brain, inp) {
    if (continueAimedItem(sim, player, brain, inp) || sim.time < brain.nextActAt) return;

    const b = sim.bomb;
    const bombPos = Sim.bombWorldPos(sim);
    const bombVisible = canSeePoint(sim, player, bombPos, C.BombRadius);
    const choices = [];
    for (let slot = 0; slot < player.hand.length; slot++) {
      const def = cardAt(player, slot);
      if (!def) continue;
      if (["projectile", "grapple"].includes(def.kind)) {
        if (bombVisible && aimedItemIsSafe(sim, player, def)) {
          choices.push({ slot, aimed: true });
        }
      } else if (def.kind === "magnify" && player.revealRemaining <= 0) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "speed" && speedItemIsSafe(sim, player, def)) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "curse" && !b.curseActive &&
          curseIsSafe(sim, player)) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "fakebomb" &&
          (sim.teamCount <= 1 ||
            isOpponent(sim, player, nextPassRecipient(sim, player)))) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "blackout") {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "emp" &&
          (b.timerJamRemaining <= 0 ||
            sim.fakeBombs.some(f => f.timerJamRemaining <= 0))) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "reverse" && reverseHelpsTeam(sim, player)) {
        choices.push({ slot, aimed: false });
      } else if (def.kind === "shield" && b.shieldRemaining <= 0 &&
          b.transfer && b.transfer.toId === player.id) {
        choices.push({ slot, aimed: false });
      }
    }

    const trySling = player.revealRemaining <= 0 &&
      slingTargetIsSafe(sim, player, bombPos) &&
      (!choices.length || Math.random() < C.BotSlingUseChance);
    if (trySling) {
      startSling(sim, player, brain, inp, bombPos);
    } else if (choices.length) {
      const choice = randomChoice(choices);
      if (choice.aimed) startAimedItem(sim, player, brain, inp, choice.slot);
      else inp.use.push(choice.slot);
    }
    brain.nextActAt = sim.time + 1.2 + Math.random() * 2.8;
  }

  function botInput(sim, player, brain) {
    const inp = {
      mx: player.aim.x, my: player.aim.y, pass: false, parry: [], use: [],
      primaryFire: false, gunFireSlot: null,
    };
    resetRoundState(sim, brain);

    if (!player.alive) {
      if (sim.phase === "playing" && sim.bomb) {
        const bombPos = Sim.bombWorldPos(sim);
        if (!continueSling(sim, player, brain, inp, bombPos)) {
          startSling(sim, player, brain, inp, bombPos);
        }
        const def = cardAt(player, 0);
        if (deadItemIsSafe(sim, player, def) &&
            sim.time >= brain.nextActAt && Math.random() < 0.35) {
          inp.use.push(0);
          brain.nextActAt = sim.time + 2;
        }
      }
      return inp;
    }
    if (sim.phase !== "playing" || !sim.bomb) return inp;

    const b = sim.bomb;
    const bombPos = Sim.bombWorldPos(sim);
    const seat = Sim.seatPosition(player.seat, sim.seatCount);
    const heldFake = sim.fakeBombs.find(f => f.holderId === player.id && !f.transfer);
    const holdingReal = b.holderId === player.id && !b.transfer;
    const holding = holdingReal || !!heldFake;
    const bombVisible = canSeePoint(sim, player, bombPos, C.BombRadius);
    advanceKnownTimer(sim, brain);
    const exactPrivateTimer = rememberVisibleTimer(sim, player, brain, bombPos);

    if (!holding) considerParry(sim, player, brain, inp);

    if (holding) {
      brain.slingCharging = false;
      brain.slingTargetId = null;
      const threat = noticeProjectileThreat(sim, player, brain, bombPos);
      const reinforcedTarget = brain.reinforcedTargetId &&
        Sim.getPlayer(sim, brain.reinforcedTargetId);

      // A noticed shot does not move the arms until the reaction clock has
      // elapsed. Very fast rounds generally arrive before that happens.
      if (threat && sim.time >= threat.readyAt && sim.time <= threat.expiresAt) {
        inp.mx = seat.x + threat.px * C.BombArmReach + threat.errorX;
        inp.my = seat.y + threat.py * C.BombArmReach + threat.errorY;
      } else if (reinforcedTarget && reinforcedTarget.alive &&
          player.armBuffRemaining > 0) {
        const targetSeat = Sim.seatPosition(reinforcedTarget.seat, sim.seatCount);
        inp.mx = targetSeat.x;
        inp.my = targetSeat.y;
      } else if (player.revealRemaining > 0) {
        inp.mx = bombPos.x;
        inp.my = bombPos.y;
      } else {
        brain.wander += (Math.random() - 0.5) * 0.2;
        const r = C.BombArmReach * 0.6;
        inp.mx = seat.x + Math.cos(brain.wander) * r;
        inp.my = seat.y + Math.sin(brain.wander) * r;
      }

      const known = estimatedKnownTime(sim, brain);
      const normalRecipient = nextPassRecipient(sim, player);
      const plannedRecipient = player.armBuffRemaining > 0 && reinforcedTarget
        ? reinforcedTarget : normalRecipient;
      const lethalForTeammate = holdingReal &&
        sameTeam(sim, player, plannedRecipient) &&
        known != null && known <= C.BotKnownBombPanicTime;
      if (holdingReal && (exactPrivateTimer ||
          (known != null && known <= C.BotKnownBombPanicTime)) &&
          !lethalForTeammate) {
        brain.forcePass = true;
      }

      if (player.passLock <= 0) {
        if (brain.forcePass && !lethalForTeammate) {
          inp.pass = true;
          brain.forcePass = false;
          brain.holdUntil = null;
          brain.reinforcedTargetId = null;
        } else {
          if (brain.holdUntil == null) {
            brain.holdUntil = sim.time + 0.3 + Math.random() * 2.2;
          }
          if (sim.time >= brain.holdUntil) {
            if (!lethalForTeammate) {
              inp.pass = true;
              brain.holdUntil = null;
            } else {
              // Do not dump a known lethal bomb on a teammate. Keep looking
              // for Reverse/Reinforced Arm while accepting the personal risk.
              brain.holdUntil = sim.time + 0.5;
            }
          }
        }
      }

      if (!inp.pass) useHeldItem(sim, player, brain, inp, threat, exactPrivateTimer);
    } else {
      brain.holdUntil = null;
      brain.dodge = null;
      if (bombVisible) {
        inp.mx = bombPos.x;
        inp.my = bombPos.y;
      } else {
        aimIntoDarkness(sim, player, brain, inp);
      }
      if (!continueSling(sim, player, brain, inp, bombPos)) {
        useFreeHandItem(sim, player, brain, inp);
      }
    }

    return inp;
  }

  return { createBrain, botInput };
})();
