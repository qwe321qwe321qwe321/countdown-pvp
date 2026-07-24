"use strict";

// Host-side bots for solo testing. A bot produces exactly the same plain
// input shape a network client sends ({ mx, my, pass, draw, use }), so the
// sim treats humans and bots identically and bots get no special authority.
const AI = (() => {
  const C = CONFIG;

  function createBrain() {
    return {
      holdUntil: null,   // when (sim.time) to pass after the lock opens
      nextActAt: 0,      // next time this bot considers using a card
      wander: Math.random() * Math.PI * 2,
      aimSlot: null,     // gun slot the bot has raised and is aiming, not fired yet
      aimReadyAt: 0,     // sim.time this bot may actually pull the trigger
    };
  }

  function findSlot(player, pred) {
    return player.hand.findIndex(id => id != null && pred(Cards.TYPES[id]));
  }

  function botInput(sim, player, brain) {
    const inp = {
      mx: player.aim.x, my: player.aim.y, pass: false, draw: false, use: [],
      deadFire: false,
    };
    if (!player.alive) {
      // Dead bots use the same permanent interference weapon as humans. They
      // keep holding to auto-cycle charge -> cooldown -> charge, while the
      // host applies the same sluggish aim tracking and projectile rules.
      if (sim.phase === "playing" && sim.bomb) {
        const bombPos = Sim.bombWorldPos(sim);
        inp.mx = bombPos.x;
        inp.my = bombPos.y;
        inp.deadFire = true;
      }
      return inp;
    }

    // Draw whenever affordable (lightly throttled by chance per tick).
    if (player.coins >= C.CardDrawCost && player.hand.includes(null) && Math.random() < 0.01) {
      inp.draw = true;
    }

    if (sim.phase !== "playing" || !sim.bomb) return inp;

    const b = sim.bomb;
    // A fake decoy in hand is carried/passed exactly like the real bomb, so
    // the bot treats "holding" identically for both — it hot-potatoes a fake
    // onward just as urgently, which is exactly what keeps the bluff alive.
    const heldFake = sim.fakeBombs.find(f => f.holderId === player.id && !f.transfer);
    const holding = b.holderId === player.id || !!heldFake;
    const bombPos = Sim.bombWorldPos(sim);
    const seat = Sim.seatPosition(player.seat, sim.seatCount);

    // Nearest incoming minus-time projectile threatening the bomb.
    let threat = null, threatDist = Infinity;
    for (const pr of sim.projectiles) {
      if (pr.amount >= 0) continue;
      const d = Math.hypot(pr.x - bombPos.x, pr.y - bombPos.y);
      const toward = (bombPos.x - pr.x) * pr.vx + (bombPos.y - pr.y) * pr.vy > 0;
      if (toward && d < 260 && d < threatDist) { threat = pr; threatDist = d; }
    }

    if (holding) {
      // Arm control: dodge incoming minus shots sideways, otherwise drift the
      // bomb gently around the seat.
      if (threat) {
        const vlen = Math.hypot(threat.vx, threat.vy) || 1;
        const px = -threat.vy / vlen, py = threat.vx / vlen; // perpendicular
        const side = (bombPos.x - threat.x) * px + (bombPos.y - threat.y) * py >= 0 ? 1 : -1;
        inp.mx = seat.x + px * side * C.BombArmReach;
        inp.my = seat.y + py * side * C.BombArmReach;
      } else {
        brain.wander += (Math.random() - 0.5) * 0.2;
        const r = C.BombArmReach * 0.6;
        inp.mx = seat.x + Math.cos(brain.wander) * r;
        inp.my = seat.y + Math.sin(brain.wander) * r;
      }

      // Pass after a short random extra hold once the lock opens.
      if (player.passLock <= 0) {
        if (brain.holdUntil == null) brain.holdUntil = sim.time + 0.3 + Math.random() * 2.2;
        if (sim.time >= brain.holdUntil) { inp.pass = true; brain.holdUntil = null; }
      }

      // Defensive cards while holding. Both hands are on the bomb, so the
      // holder can't wield a thrown weapon (repair kits included) — only
      // non-projectile cards are an option here.
      const shieldSlot = findSlot(player, d => d.kind === "shield");
      if (threat && shieldSlot >= 0 && b.shieldRemaining <= 0) {
        inp.use.push(shieldSlot);
      } else if (sim.time >= brain.nextActAt) {
        const slow = findSlot(player, d => d.kind === "speed" && d.mult < 1);
        if (slow >= 0 && b.speedMult >= 1) {
          inp.use.push(slow);
        }
        brain.nextActAt = sim.time + 1.5 + Math.random() * 3;
      }
    } else {
      brain.holdUntil = null;
      // Keep aiming at the bomb; occasionally play an offensive card.
      inp.mx = bombPos.x;
      inp.my = bombPos.y;

      if (brain.aimSlot != null) {
        // Weapon already raised: a human has to click to arm, aim, then
        // click again to fire, which naturally takes a beat — a bot has no
        // such delay by default, so it holds the gun up and aimed here for
        // BotAimDuration before actually pulling the trigger.
        const heldCard = player.hand[brain.aimSlot];
        if (!heldCard || Cards.TYPES[heldCard].kind !== "projectile" || b.shieldRemaining > 0) {
          brain.aimSlot = null; // shot invalidated mid-aim (used/discarded/shielded)
        } else {
          inp.equip = brain.aimSlot;
          if (sim.time >= brain.aimReadyAt) {
            inp.use.push(brain.aimSlot);
            brain.aimSlot = null;
          }
        }
      } else if (sim.time >= brain.nextActAt) {
        const gun = findSlot(player, d => d.kind === "projectile" && d.amount < 0);
        const fast = findSlot(player, d => d.kind === "speed" && d.mult > 1);
        const curse = findSlot(player, d => d.kind === "curse");
        const magnify = findSlot(player, d => d.kind === "magnify");
        const fake = findSlot(player, d => d.kind === "fakebomb");
        if (gun >= 0 && b.shieldRemaining <= 0) {
          brain.aimSlot = gun;
          brain.aimReadyAt = sim.time + C.BotAimDuration + Math.random() * C.BotAimJitter;
          inp.equip = gun;
        }
        else if (fast >= 0 && b.speedMult <= 1) inp.use.push(fast);
        else if (curse >= 0 && !b.curseActive) inp.use.push(curse);
        else if (fake >= 0 && Math.random() < 0.5) inp.use.push(fake); // sim rejects it if the bomb cap is reached; the card just stays in hand
        else if (magnify >= 0 && Math.random() < 0.5) inp.use.push(magnify);
        brain.nextActAt = sim.time + 1.5 + Math.random() * 3;
      }
    }

    return inp;
  }

  return { createBrain, botInput };
})();
