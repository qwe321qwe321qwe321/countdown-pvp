"use strict";

// Canvas + DOM rendering. Consumes only the snapshot shape produced by
// Sim.buildSnapshot(), so host and clients share exactly one render path and
// nothing here can peek at hidden state (it simply isn't in the snapshot).
const Render = (() => {
  const C = CONFIG;
  const SEAT_COLORS = ["#e6604c", "#4c9be6", "#5cc46a", "#e6c14c", "#b06ce6", "#e68b4c", "#4ce6d4", "#e64ca8"];
  // Team battle: color by team instead of by seat, so teammates read as one
  // side at a glance. Capped at CONFIG.TeamCountOptions' max (4).
  const TEAM_COLORS = ["#e6604c", "#4c9be6", "#5cc46a", "#e6c14c"];
  const BOMB_TIMER_COLOR = "#ffe27a";

  // Every player's identity color: team color when teams are in play
  // (snap.teamCount > 1), otherwise the per-seat color as before.
  function colorFor(p, snap) {
    return snap.teamCount > 1
      ? TEAM_COLORS[p.team % TEAM_COLORS.length]
      : SEAT_COLORS[p.seat % SEAT_COLORS.length];
  }
  const FLOAT_LIFETIME = 1.6; // seconds a positioned event floats on screen
  const PAYOUT_FLOAT_LIFETIME = 1.3; // seconds the private "+N" cash-in cue floats

  // Tracks the last farmed-pot payout this client has already shown, so a
  // new one (bumped `seq`) triggers exactly one float — module state because
  // it's driven by snap.time deltas across frames, same pattern as the DOM
  // hand/event caches below.
  let lastPayoutSeq = 0;
  let payoutFloatStart = null;
  let payoutFloatAmount = 0;
  let payoutFloatSource = null;

  function reinforcedThrowTarget(snap, myId, hoverPoint) {
    if (!hoverPoint || !snap.you || snap.you.id !== myId || snap.phase !== "playing") return null;
    const me = snap.players.find(p => p.id === myId);
    if (!me || !me.alive || !me.armBuffed) return null;

    let heldBomb = null;
    if (snap.you.isHolder && snap.bomb && !snap.bomb.transferring) {
      heldBomb = snap.bomb;
    } else {
      heldBomb = (snap.fakeBombs || []).find(f => f.holderId === myId && !f.transferring) || null;
    }
    if (!heldBomb) return null;

    const target = snap.players.find(p =>
      p.id !== myId && p.alive &&
      Math.hypot(p.x - hoverPoint.x, p.y - hoverPoint.y) <= C.PlayerBodyRadius + 18);
    return target ? { source: heldBomb, target } : null;
  }

  // ---- Canvas --------------------------------------------------------------

  function draw(ctx, snap, myId, hoverPoint) {
    const W = C.WorldWidth, H = C.WorldHeight;
    ctx.fillStyle = bgColorFor(snap);
    ctx.fillRect(0, 0, W, H);

    // Table (projectiles fly over it; it is not a collider).
    const cx = W / 2, cy = H / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, C.TableRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#242a35";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#39414f";
    ctx.stroke();

    const holder = snap.bomb ? snap.players.find(p => p.id === snap.bomb.holderId) : null;
    const reinforcedThrow = reinforcedThrowTarget(snap, myId, hoverPoint);

    // Staged mid-air explosion: the victim was already eliminated the instant
    // the timer hit 0, but they keep *looking* alive until the blast ring
    // visually reaches them (see the explosion block below).
    let pendingVictimId = null;
    if (snap.phase === "exploding" && snap.explosionMidAir && snap.explosionVictimId) {
      const elapsed = C.ExplosionTransitionDuration - snap.phaseTimer;
      if (elapsed < C.ExplosionHoldDuration + C.ExplosionRingCatchUpDuration) {
        pendingVictimId = snap.explosionVictimId;
      }
    }

    // Players (fixed seats, never move).
    for (const p of snap.players) {
      const col = colorFor(p, snap);
      const aliveLook = p.alive || p.id === pendingVictimId;
      ctx.beginPath();
      ctx.arc(p.x, p.y, C.PlayerBodyRadius, 0, Math.PI * 2);
      if (aliveLook) {
        ctx.fillStyle = col;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = p.id === myId ? "#ffffff" : "rgba(0,0,0,0.35)";
        ctx.stroke();
        // Face dot toward the table center.
        const a = Math.atan2(cy - p.y, cx - p.x);
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a) * 11, p.y + Math.sin(a) * 11, 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fill();
      } else {
        ctx.fillStyle = "#3a3f48";
        ctx.fill();
        ctx.fillStyle = "#767e8a";
        ctx.font = "bold 20px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✖", p.x, p.y + 7);
      }
      if (p.id === myId && snap.you && snap.you.parry) {
        drawLocalTimingCue(ctx, p, snap.you.parry, snap.time);
      }
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = aliveLook ? "#e8e8e8" : "#767e8a";
      const tag = p.id === myId ? " (you)" : "";
      const teamTag = snap.teamCount > 1 ? ` [T${p.team + 1}]` : "";
      ctx.fillText(p.name + tag + teamTag, p.x, p.y - C.PlayerBodyRadius - 10);

      // A player aiming a projectile card holds it visibly for everyone to
      // see — and since both their hands are busy, they can't be the bomb
      // holder at the same time.
      if (p.alive && p.equipped) drawWeaponPose(ctx, p, cx, cy, snap);
      // Eliminated players keep a permanent charged sling. Its direction and
      // charge-up are public so living players can read and react to the
      // incoming interference rather than being blindsided.
      if (p.chargedWeapon && (!p.alive || p.deadWeaponCharging)) {
        drawDeadWeaponPose(ctx, p, cx, cy, snap);
      }

      // Everyone can see *that* a player is using a Magnifying Glass, and
      // where its box-cast is pointed — just never the reading it gives them.
      if (p.alive && p.revealing) {
        drawMagnifyCast(ctx, p, snap.bomb);
        ctx.font = "18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("🔍", p.x + C.PlayerBodyRadius + 4, p.y - C.PlayerBodyRadius - 6);
      }


      // Reinforced Arm: public "iron arm" cue while the buff is active.
      if (p.alive && p.armBuffed) {
        ctx.font = "18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("🦾", p.x - C.PlayerBodyRadius - 4, p.y - C.PlayerBodyRadius - 6);
      }

    }

    // Hover tooltip: aim the mouse at another player to see their coins and
    // card count without needing to ask.
    if (hoverPoint) {
      const target = snap.players.find(p =>
        p.id !== myId && p.alive &&
        Math.hypot(p.x - hoverPoint.x, p.y - hoverPoint.y) <= C.PlayerBodyRadius + 14);
      if (target && !reinforcedThrow) drawPlayerTooltip(ctx, target);
    }

    // Fake decoys: drawn with the identical holder arms + bomb body as the
    // real one — on screen there is simply no way to tell them apart.
    for (const f of snap.fakeBombs) {
      const fHolder = f.holderId ? snap.players.find(p => p.id === f.holderId) : null;
      if (fHolder && fHolder.alive && !f.transferring) {
        if (fHolder.taunting) drawTauntPose(ctx, fHolder, f, snap);
        else drawArms(ctx, fHolder, f, fHolder.armBuffed, snap);
      }
      if (f.claw) drawClawTether(ctx, f.clawX, f.clawY, f.x, f.y);
      drawBombBody(ctx, f.x, f.y, snap.time);
      // Creator-only peek at the decoy's timer (only ever present in the
      // creator's own snapshot) — same look as the Magnifying Glass reveal.
      if (f.timerJammed) {
        drawJammedTimer(ctx, f.x, f.y, snap.time);
      } else if (f.privateRemaining != null) {
        ctx.font = "bold 17px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = BOMB_TIMER_COLOR;
        ctx.fillText(f.privateRemaining.toFixed(1) + "s", f.x, f.y);
        ctx.textBaseline = "alphabetic";
      } else if (f.publicRemaining != null) {
        ctx.font = "bold 17px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = BOMB_TIMER_COLOR;
        ctx.fillText(f.publicRemaining.toFixed(1) + "s", f.x, f.y);
        ctx.textBaseline = "alphabetic";
      }
      drawPotBadge(ctx, f.x, f.y, f.pot, f.potMaxed, snap.time);
    }

    // Arms: body -> hands -> bomb, only for the current holder, and only
    // while the bomb isn't mid-flight between seats (nobody's arms are on it).
    if (snap.bomb && !snap.bomb.transferring && holder && holder.alive) {
      if (holder.taunting) drawTauntPose(ctx, holder, snap.bomb, snap);
      else drawArms(ctx, holder, snap.bomb, holder.armBuffed, snap);
    }

    // Bomb (with cable + gripping claw while a grapple is reeling it in).
    if (snap.bomb) {
      if (snap.bomb.claw) drawClawTether(ctx, snap.bomb.clawX, snap.bomb.clawY, snap.bomb.x, snap.bomb.y);
      drawBomb(ctx, snap, holder);
    }

    // Local-only Reinforced Arm targeting aid. The authoritative throw still
    // uses the live aim point in sim.js; this simply makes the selected player
    // and bomb trajectory unmistakable before SPACE is pressed.
    if (reinforcedThrow) drawReinforcedThrowArrow(ctx, reinforcedThrow, snap);

    // Hitscan trails exist only for a fraction of a second, but snapshots
    // carry their authoritative start/end points so every client sees the
    // exact ray that hit (or missed) instead of a travelling bullet.
    for (const trail of snap.shotTrails || []) drawHitscanTrail(ctx, trail, snap.time);

    // Projectiles: red = minus-time, green = plus-time; a flying grapple is
    // a claw head trailing its cable back to where it was thrown from.
    for (const pr of snap.projectiles) {
      if (pr.isClaw) { drawClawProjectile(ctx, pr); continue; }
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, C.ProjectileRadius, 0, Math.PI * 2);
      ctx.fillStyle = pr.amount < 0 ? "#ff5d5d" : "#5dff8a";
      ctx.fill();
    }

    // Explosion transition. Mid-air blasts get the full staged sequence
    // (frozen "0.0s" beat first); in-hand blasts skip the freeze and burst
    // immediately — but both rings sweep out to the victim, keep growing
    // fast and fade, so nothing ever hangs frozen on screen.
    if (snap.phase === "exploding" && snap.explosionAt) {
      const elapsed = C.ExplosionTransitionDuration - snap.phaseTimer;
      drawStagedBlast(ctx, snap.explosionAt, snap.explosionVictimPos, elapsed, snap.time,
        snap.explosionMidAir ? C.ExplosionHoldDuration : 0);
    }

    // Fake bombs use a deliberately non-explosive confetti/coin burst so
    // players can distinguish the bluff reveal from a lethal real blast.
    for (const ef of snap.effects || []) {
      const age = snap.time - ef.time;
      if (ef.type === "fakeboom") drawFakeBombBurst(ctx, ef, age, snap);
      else if (ef.type === "coinstolen") drawCoinSteal(ctx, ef, age, snap);
    }

    // Floating public feedback ("-5 SEC", "SHIELD BLOCKED IT", ...).
    for (const ev of snap.events) {
      if (ev.x == null) continue;
      const age = snap.time - ev.time;
      if (age > FLOAT_LIFETIME) continue;
      const k = age / FLOAT_LIFETIME;
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(255,220,120,${1 - k})`;
      ctx.fillText(ev.text, ev.x, ev.y - 24 - k * 36);
    }

    // Private "+N" cash-in cue: only ever present in *your* snapshot, so
    // nobody else's screen shows when a pot gets paid out (that would out a
    // decoy the instant its payout failed to appear).
    // Fire on any *change* of seq, not just a higher value: a rematch resets
    // the server-side seq back to 0, so a `>` test would swallow the first few
    // payouts of the new match (their seq 1,2,3… never exceed the stale module
    // value carried over from the previous match). seq 0 is the "no payout yet"
    // sentinel and never pops the cue.
    if (snap.you && snap.you.payout && snap.you.payout.seq !== lastPayoutSeq) {
      lastPayoutSeq = snap.you.payout.seq;
      if (snap.you.payout.seq > 0) {
        payoutFloatStart = snap.time;
        payoutFloatAmount = snap.you.payout.amount;
        payoutFloatSource = (snap.you.payout.sourceX != null)
          ? { x: snap.you.payout.sourceX, y: snap.you.payout.sourceY }
          : null;
      }
    }
    if (payoutFloatStart != null) {
      const age = snap.time - payoutFloatStart;
      if (age <= PAYOUT_FLOAT_LIFETIME) {
        const me = snap.players.find(p => p.id === myId);
        if (me) {
          const k = age / PAYOUT_FLOAT_LIFETIME;
          const source = payoutFloatSource || me;
          ctx.save();
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          // One visible coin per dollar: a full $10 pot produces a satisfying
          // ten-coin stream, while smaller payouts stay proportional.
          const coinCount = Math.max(1, Math.round(payoutFloatAmount));
          for (let i = 0; i < coinCount; i++) {
            const travel = Math.max(0, Math.min(1, k / 0.62 - i * 0.035));
            const ease = 1 - Math.pow(1 - travel, 3);
            const angle = i * 2.39996;
            const spread = 5 + (i % 4) * 2;
            const startX = source.x + Math.cos(angle) * spread;
            const startY = source.y + Math.sin(angle) * spread;
            const endX = me.x + Math.cos(angle) * 8;
            const endY = me.y + Math.sin(angle) * 6;
            const coinX = startX + (endX - startX) * ease;
            const coinY = startY + (endY - startY) * ease -
              Math.sin(ease * Math.PI) * (30 + (i % 4) * 7);
            ctx.globalAlpha = Math.min(1, travel * 7) *
              Math.max(0, 1 - Math.max(0, k - 0.76) / 0.12);
            ctx.beginPath();
            ctx.arc(coinX, coinY, 5.5, 0, Math.PI * 2);
            ctx.fillStyle = "#ffd54c";
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#8a5b00";
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(coinX - 1.5, coinY - 1.5, 1.3, 0, Math.PI * 2);
            ctx.fillStyle = "#fff1a6";
            ctx.fill();
          }
          if (k >= 0.45) {
            const labelK = Math.max(0, (k - 0.42) / 0.58);
            const scale = 1 + (1 - Math.min(1, labelK)) * 0.3;
            ctx.globalAlpha = 1 - Math.max(0, labelK - 0.72) / 0.28;
            ctx.font = `bold ${Math.round(30 * scale)}px sans-serif`;
            ctx.fillStyle = "#ffd54c";
            ctx.strokeStyle = "rgba(0,0,0,0.7)";
            ctx.lineWidth = 5;
            const fx = me.x;
            const fy = me.y - C.PlayerBodyRadius - 30 - labelK * 34;
            const text = `+$${payoutFloatAmount}`;
            ctx.strokeText(text, fx, fy);
            ctx.fillText(text, fx, fy);
          }
          ctx.restore();
        }
      } else {
        payoutFloatStart = null;
      }
    }

    drawBlackout(ctx, snap, myId);
    drawWobblyCrosshair(ctx, snap, myId);
    drawOverlays(ctx, snap);
  }

  function drawHitscanTrail(ctx, trail, time) {
    const age = Math.max(0, time - trail.time);
    if (age > C.HitscanTrailDuration) return;
    const life = 1 - age / C.HitscanTrailDuration;
    const charged = trail.weapon === "charged";
    const shock = trail.weapon === "shockgun";
    const color = shock ? "70,225,255" : charged ? "210,130,255" : "255,92,76";

    ctx.save();
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.moveTo(trail.x0, trail.y0);
    ctx.lineTo(trail.x1, trail.y1);
    ctx.lineWidth = (shock ? C.ShockGunRayRadius * 2 : 9) * life + (shock ? 8 : 2);
    ctx.strokeStyle = `rgba(${color},${(shock ? 0.24 : 0.16) * life})`;
    ctx.shadowColor = `rgba(${color},${0.85 * life})`;
    ctx.shadowBlur = 18;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(trail.x0, trail.y0);
    ctx.lineTo(trail.x1, trail.y1);
    ctx.lineWidth = shock ? 5 : 2.2;
    ctx.strokeStyle = `rgba(255,245,225,${0.95 * life})`;
    ctx.stroke();

    if (trail.impact !== "wall") {
      ctx.beginPath();
      ctx.arc(trail.x1, trail.y1, 4 + (1 - life) * 12, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(${color},${0.9 * life})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  function aimedDirection(p, cx, cy, snap) {
    let dx = p.aimX != null ? p.aimX - p.x : cx - p.x;
    let dy = p.aimY != null ? p.aimY - p.y : cy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const wobble = p.aimInstability > 0
      ? HitscanAim.wobbleRadians(p.id, snap.time, p.aimInstability)
      : 0;
    return HitscanAim.rotate(dx, dy, wobble);
  }

  function drawWobblyCrosshair(ctx, snap, myId) {
    if (!(snap.modes && snap.modes.wobblyHitscan)) return;
    const me = snap.players.find(p => p.id === myId);
    if (!me || !(me.aimInstability > 0) || me.aimX == null) return;

    const rawX = me.aimX - me.x, rawY = me.aimY - me.y;
    const distance = Math.hypot(rawX, rawY);
    if (distance < 0.001) return;
    const direction = aimedDirection(me, C.WorldWidth / 2, C.WorldHeight / 2, snap);
    const x = me.x + direction.x * distance;
    const y = me.y + direction.y * distance;
    const pulse = 0.5 + 0.5 * Math.sin(snap.time * 18);

    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(255,238,205,0.95)";
    ctx.fillStyle = "rgba(255,92,76,0.95)";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(255,92,76,0.8)";
    ctx.shadowBlur = 7;
    const inner = 5 + pulse * 1.5;
    const outer = 13 + pulse * 2;
    ctx.beginPath();
    ctx.moveTo(-outer, 0); ctx.lineTo(-inner, 0);
    ctx.moveTo(outer, 0); ctx.lineTo(inner, 0);
    ctx.moveTo(0, -outer); ctx.lineTo(0, -inner);
    ctx.moveTo(0, outer); ctx.lineTo(0, inner);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Local timing windows use color only. No window names or failure text are
  // shown; only a successful trigger gets a brief confirmation in
  // drawOverlays().
  function drawLocalTimingCue(ctx, player, timing, time) {
    if (timing.state === "punished" || timing.state === "missed") return;
    const pulse = 0.5 + 0.5 * Math.sin(time * 18);
    const styles = {
      incoming:  { color: "190,200,214", alpha: 0.32, width: 3 },
      punish:    { color: "255,70,82",   alpha: 0.78, width: 5 },
      parry:     { color: "105,255,150", alpha: 0.92, width: 6 },
      success:   { color: "80,235,255",  alpha: 0.95, width: 7 },
    };
    const style = styles[timing.state] || styles.incoming;
    const radius = C.PlayerBodyRadius + 10 + pulse * (timing.state === "parry" ? 7 : 3);
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = style.width;
    ctx.strokeStyle = `rgba(${style.color},${style.alpha})`;
    ctx.shadowColor = `rgba(${style.color},${style.alpha})`;
    ctx.shadowBlur = timing.state === "parry" || timing.state === "success" ? 18 : 8;
    ctx.stroke();
    if (timing.state === "success") {
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 10 + pulse * 9, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${style.color},${0.55 - pulse * 0.25})`;
      ctx.stroke();
      drawParryBurstParticles(ctx, player, timing);
    }
    ctx.restore();
  }

  function drawParryBurstParticles(ctx, player, timing) {
    const duration = 0.45;
    const age = Math.max(0, timing.successAge || 0);
    if (age >= duration) return;
    const progress = age / duration;
    const eased = 1 - Math.pow(1 - progress, 2.4);
    const alpha = Math.pow(1 - progress, 1.35);
    const seed = (timing.transferId || 1) * 0.61803398875;
    const count = 18;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + seed;
      const stagger = 0.78 + ((i * 7) % 5) * 0.075;
      const distance = 13 + eased * (46 + (i % 4) * 9) * stagger;
      const sideDrift = Math.sin(progress * Math.PI) * ((i % 3) - 1) * 8;
      const px = player.x + Math.cos(angle) * distance -
        Math.sin(angle) * sideDrift;
      const py = player.y + Math.sin(angle) * distance +
        Math.cos(angle) * sideDrift;
      const size = Math.max(1.2, (4.2 - (i % 3) * 0.65) * (1 - progress * 0.58));

      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fillStyle = i % 3 === 0
        ? `rgba(255,255,255,${alpha})`
        : i % 3 === 1
          ? `rgba(100,244,255,${alpha})`
          : `rgba(125,255,155,${alpha * 0.9})`;
      ctx.fill();
    }
  }

  // Background tint while a Speed Up/Slow Down modifier is active: a subtle
  // pulsing warm tint for 2x, cool tint for 0.5x — a public state, same tier
  // as the Shield/Curse booleans, so this is not the hidden timer leaking.
  function bgColorFor(snap) {
    const base = { r: 0x14, g: 0x16, b: 0x1a };
    const mult = snap.bomb ? snap.bomb.speedMult : 1;
    if (mult === 1) return `rgb(${base.r},${base.g},${base.b})`;
    const pulse = 0.5 + 0.5 * Math.sin(snap.time * 6);
    // 0 = fully frozen (icy tint, and the bomb is invincible while it lasts).
    const tint = mult === 0 ? { r: 0x1a, g: 0x5a, b: 0x6a }
      : mult > 1 ? { r: 0x6a, g: 0x1a, b: 0x1a } : { r: 0x1a, g: 0x38, b: 0x6a };
    const k = 0.12 + pulse * 0.10;
    const mix = (a, b) => Math.round(a + (b - a) * k);
    return `rgb(${mix(base.r, tint.r)},${mix(base.g, tint.g)},${mix(base.b, tint.b)})`;
  }

  function drawArms(ctx, holder, bomb, buffed, snap) {
    let dx = bomb.x - holder.x, dy = bomb.y - holder.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const px = -dy, py = dx; // perpendicular
    // Reinforced Arm: tint the arms silver/metallic while the buff is active.
    const col = buffed ? "#c9d2dc" : colorFor(holder, snap);
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.strokeStyle = col;
    for (const side of [-1, 1]) {
      const sx = holder.x + px * side * 15 + dx * 8;
      const sy = holder.y + py * side * 15 + dy * 8;
      const hx = bomb.x + px * side * (C.BombRadius + 3);
      const hy = bomb.y + py * side * (C.BombRadius + 3);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
  }

  function drawReinforcedThrowArrow(ctx, selection, snap) {
    const source = selection.source;
    const target = selection.target;
    let dx = target.x - source.x, dy = target.y - source.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    dx /= len; dy /= len;

    const startX = source.x + dx * (C.BombRadius + 8);
    const startY = source.y + dy * (C.BombRadius + 8);
    const endX = target.x - dx * (C.PlayerBodyRadius + 12);
    const endY = target.y - dy * (C.PlayerBodyRadius + 12);
    const pulse = 0.5 + 0.5 * Math.sin(snap.time * 9);
    const color = snap.you.canPass ? "#64f4ff" : "#ffd166";
    const headLength = 20;
    const headWidth = 12;
    const px = -dy, py = dx;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Strong dark underlay keeps the trajectory readable over the table,
    // player colors, projectiles, and the bomb body.
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - dx * headLength + px * headWidth, endY - dy * headLength + py * headWidth);
    ctx.lineTo(endX - dx * headLength - px * headWidth, endY - dy * headLength - py * headWidth);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(target.x, target.y, C.PlayerBodyRadius + 10 + pulse * 4, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();

    const label = snap.you.canPass
      ? `SPACE → THROW TO ${target.name}`
      : `TARGET: ${target.name} · PASS LOCK ${snap.you.passLock.toFixed(1)}s`;
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    const labelWidth = ctx.measureText(label).width + 18;
    const labelX = target.x;
    const labelY = target.y + C.PlayerBodyRadius + 38;
    ctx.fillStyle = "rgba(10,14,20,0.9)";
    roundRect(ctx, labelX - labelWidth / 2, labelY - 18, labelWidth, 25, 6);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, labelX, labelY);
    ctx.restore();
  }

  function drawTauntPose(ctx, holder, bomb, snap) {
    const phase = Math.sin(snap.time * 12);
    const col = colorFor(holder, snap);
    ctx.save();
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.strokeStyle = col;
    // One hand keeps the bomb close while the other waves theatrically.
    ctx.beginPath();
    ctx.moveTo(holder.x - 5, holder.y);
    ctx.lineTo(bomb.x, bomb.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(holder.x + 6, holder.y);
    ctx.quadraticCurveTo(holder.x + 34, holder.y - 22 - phase * 8,
      holder.x + 18 + phase * 10, holder.y - 52);
    ctx.stroke();
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd54c";
    ctx.fillText("TAUNT!  ×2 💰", holder.x, holder.y + 48);
    ctx.restore();
  }

  // Public pose for a player who has a projectile card armed: a single raised
  // arm pointing toward their aim, tipped with a small weapon marker. Purely
  // cosmetic — the actual shot only fires once they click.
  function drawWeaponPose(ctx, p, cx, cy, snap) {
    const direction = aimedDirection(p, cx, cy, snap);
    const dx = direction.x, dy = direction.y;
    const col = colorFor(p, snap);
    const hx = p.x + dx * (C.PlayerBodyRadius + 18);
    const hy = p.y + dy * (C.PlayerBodyRadius + 18);
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(p.x + dx * 6, p.y + dy * 6);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#e8e8e8";
    ctx.fill();

    // Sight line: shows everyone exactly where this weapon is pointed.
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + dx * C.AimLineLength, hy + dy * C.AimLineLength);
    ctx.stroke();
    ctx.restore();
  }

  function drawDeadWeaponPose(ctx, p, cx, cy, snap) {
    const direction = aimedDirection(p, cx, cy, snap);
    const dx = direction.x, dy = direction.y;
    const hx = p.x + dx * (C.PlayerBodyRadius + 20);
    const hy = p.y + dy * (C.PlayerBodyRadius + 20);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = p.deadWeaponCharging ? "#d58cff" : "#7f6b91";
    ctx.beginPath();
    ctx.moveTo(p.x + dx * 5, p.y + dy * 5);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    // Y-shaped sling body and its charged projectile.
    const px = -dy, py = dx;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#caa5e8";
    ctx.beginPath();
    ctx.moveTo(hx - dx * 7, hy - dy * 7);
    ctx.lineTo(hx + px * 8, hy + py * 8);
    ctx.moveTo(hx - dx * 7, hy - dy * 7);
    ctx.lineTo(hx - px * 8, hy - py * 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx + dx * 13, hy + dy * 13, 4 + p.deadWeaponCharge * 7, 0, Math.PI * 2);
    ctx.fillStyle = p.deadWeaponCharging
      ? `rgba(220,140,255,${0.35 + p.deadWeaponCharge * 0.65})`
      : "rgba(150,120,170,0.45)";
    ctx.fill();

    // Sluggish public sight line; brighter as the charge fills.
    ctx.setLineDash([7, 10]);
    ctx.lineWidth = 1.5 + p.deadWeaponCharge * 1.5;
    ctx.strokeStyle = p.deadWeaponCharging
      ? `rgba(220,160,255,${0.35 + p.deadWeaponCharge * 0.55})`
      : "rgba(180,150,195,0.25)";
    ctx.beginPath();
    ctx.moveTo(hx + dx * 13, hy + dy * 13);
    ctx.lineTo(hx + dx * C.AimLineLength, hy + dy * C.AimLineLength);
    ctx.stroke();

    // Two-stage charge rings: the first second completes the inner ring and
    // unlocks the shot; only then does the second/full-power ring begin.
    const ringX = p.x, ringY = p.y;
    const progress = p.deadWeaponCharge;
    const minimumProgress = C.ChargedShotMinimumChargeTime / C.ChargedShotChargeTime;
    const firstRingProgress = Math.min(1, progress / minimumProgress);
    const secondRingProgress = Math.max(0,
      Math.min(1, (progress - minimumProgress) / (1 - minimumProgress)));
    ctx.setLineDash([]);
    ctx.lineWidth = 3;

    ctx.strokeStyle = "rgba(213,140,255,0.2)";
    ctx.beginPath();
    ctx.arc(ringX, ringY, C.PlayerBodyRadius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = firstRingProgress >= 1 ? "#ffd166" : "#d58cff";
    ctx.beginPath();
    ctx.arc(ringX, ringY, C.PlayerBodyRadius + 6, -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * firstRingProgress);
    ctx.stroke();

    if (progress >= minimumProgress) {
      ctx.strokeStyle = "rgba(125,255,155,0.2)";
      ctx.beginPath();
      ctx.arc(ringX, ringY, C.PlayerBodyRadius + 12, 0, Math.PI * 2);
      ctx.stroke();
      if (secondRingProgress > 0) {
        ctx.strokeStyle = "#7dff9b";
        ctx.beginPath();
        ctx.arc(ringX, ringY, C.PlayerBodyRadius + 12, -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * secondRingProgress);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Magnifying Glass box-cast: a long thin rectangle from the player out
  // along their aim, brighter when it's actually covering the bomb right
  // now. Purely cosmetic feedback — the host alone decides whether the
  // owner's private reading is actually included in their own snapshot.
  function drawMagnifyCast(ctx, p, bomb) {
    let dx, dy;
    if (p.aimX != null) { dx = p.aimX - p.x; dy = p.aimY - p.y; }
    else { dx = 0; dy = -1; }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const px = -dy, py = dx; // perpendicular
    const half = C.MagnifyCastWidth / 2;
    const length = C.MagnifyCastLength;

    let covering = false;
    if (bomb) {
      const fx = bomb.x - p.x, fy = bomb.y - p.y;
      const forward = fx * dx + fy * dy;
      const side = fx * px + fy * py;
      covering = forward >= -C.BombRadius && forward <= length + C.BombRadius &&
        Math.abs(side) <= half + C.BombRadius;
    }

    const x0 = p.x + px * half, y0 = p.y + py * half;
    const x1 = p.x - px * half, y1 = p.y - py * half;
    const x2 = x1 + dx * length, y2 = y1 + dy * length;
    const x3 = x0 + dx * length, y3 = y0 + dy * length;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fillStyle = covering ? "rgba(255,226,122,0.22)" : "rgba(255,226,122,0.08)";
    ctx.fill();
    ctx.strokeStyle = covering ? "rgba(255,226,122,0.85)" : "rgba(255,226,122,0.3)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }


  // Tooltip shown while aiming at another player: their coin total and hand
  // size, so you can size up who's ahead without asking.
  function drawPlayerTooltip(ctx, p) {
    const text = `💰${p.coins}   🃏${p.cardCount}/${C.MaxHandSize}`;
    ctx.font = "bold 13px sans-serif";
    const padX = 8, padY = 5;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 20 + padY * 2 - 6;
    const x = p.x, y = p.y - C.PlayerBodyRadius - 34;
    ctx.fillStyle = "rgba(20,22,28,0.88)";
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f0f0f0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
    ctx.textBaseline = "alphabetic";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBomb(ctx, snap, holder) {
    const b = snap.bomb;
    // Shield ring stays on its owner for the full duration. Whether the bomb
    // is currently inside that bubble is still decided authoritatively by the
    // sim; hiding the ring during every pass made the active shield flicker.
    const shieldOwner = b.shieldOwnerId && snap.players.find(p => p.id === b.shieldOwnerId);
    if (b.shield && shieldOwner) {
      ctx.beginPath();
      ctx.arc(shieldOwner.x, shieldOwner.y, C.BombArmReach, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(80,160,255,0.18)";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(120,190,255,0.9)";
      ctx.stroke();
    }
    drawBombBody(ctx, b.x, b.y, snap.time);
    // Curse marker (publicly announced when used).
    if (b.curse) {
      ctx.font = "bold 15px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#c07cff";
      ctx.fillText("☠", b.x - 14, b.y - C.BombRadius - 6);
    }
    // Private Magnifying Glass reveal — only ever present in *your* snapshot.
    if (b.timerJammed) {
      drawJammedTimer(ctx, b.x, b.y, snap.time);
    } else if (snap.you && snap.you.reveal) {
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = BOMB_TIMER_COLOR;
      ctx.fillText(snap.you.reveal.bombTime.toFixed(1) + "s", b.x, b.y);
      ctx.textBaseline = "alphabetic";
    } else if (b.publicRemaining != null) {
      // Opening public reveal window: same look as the Magnifying Glass,
      // but visible to everyone and follows the bomb around.
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = BOMB_TIMER_COLOR;
      ctx.fillText(b.publicRemaining.toFixed(1) + "s", b.x, b.y);
      ctx.textBaseline = "alphabetic";
    }
    drawPotBadge(ctx, b.x, b.y, b.pot, b.potMaxed, snap.time);
  }

  function drawJammedTimer(ctx, x, y, time) {
    const flicker = 0.78 + 0.22 * Math.sin(time * 37);
    ctx.save();
    ctx.font = "bold 19px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(100,235,255,${flicker})`;
    ctx.shadowColor = "#25dfff";
    ctx.shadowBlur = 7;
    ctx.fillText("###", x, y);
    ctx.restore();
  }

  // Farmed-pot badge, shown on the bomb itself while it's being held — public
  // to everyone, and drawn identically for a fake decoy (see the fakeBombs
  // loop in draw()) so the number on screen never tells the two apart. Only
  // whether it actually pays out on release stays private. MAX means no more
  // coins can be generated during this hold, so one-time pots keep that label
  // after enemy shots steal from their current balance.
  function drawPotBadge(ctx, x, y, pot, maxed, time) {
    if (!pot && !maxed) return;
    const text = maxed ? `💰${pot} MAX` : `💰${pot}`;
    ctx.font = "bold 13px sans-serif";
    const padX = 6, padY = 3;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 16 + padY * 2 - 4;
    const bx = x, by = y + C.BombRadius + 16;
    const pulse = maxed ? 0.5 + 0.5 * Math.sin(time * 7) : 0;
    ctx.fillStyle = "rgba(20,22,28,0.82)";
    ctx.strokeStyle = maxed ? `rgba(255,90,60,${0.7 + pulse * 0.3})` : "rgba(255,213,76,0.7)";
    ctx.lineWidth = maxed ? 2 : 1;
    roundRect(ctx, bx - w / 2, by - h / 2, w, h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = maxed ? "#ff7a54" : "#ffd54c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx, by + 1);
    ctx.textBaseline = "alphabetic";
  }

  // The bomb silhouette (body + fuse + flickering spark), shared verbatim by
  // the real bomb, every fake decoy, and the frozen "0.0s" beat of a staged
  // blast — pixel-identical rendering is what makes the Fake Bomb bluff hold.
  function drawBombBody(ctx, x, y, time) {
    ctx.beginPath();
    ctx.arc(x, y, C.BombRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#101114";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#585f6b";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 4, y - C.BombRadius + 2);
    ctx.quadraticCurveTo(x + 12, y - C.BombRadius - 8, x + 6, y - C.BombRadius - 13);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#8a7a54";
    ctx.stroke();
    const flick = 2 + Math.sin(time * 20) * 1.5;
    ctx.beginPath();
    ctx.arc(x + 6, y - C.BombRadius - 13, flick, 0, Math.PI * 2);
    ctx.fillStyle = "#ffce54";
    ctx.fill();
  }

  // Staged lethal blast used only for the real bomb: an optional frozen
  // "0.0s" beat (`hold` seconds — mid-air blasts only), then a ring expands
  // until it reaches the victim (or a default radius when there is no victim
  // to reach), then keeps growing fast while fading out.
  function drawStagedBlast(ctx, at, victimPos, elapsed, time, hold) {
    if (elapsed < hold) {
      drawBombBody(ctx, at.x, at.y, time);
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffe27a";
      ctx.fillText("0.0s", at.x, at.y);
      ctx.textBaseline = "alphabetic";
      return;
    }
    const t = elapsed - hold;
    const targetR = victimPos
      ? Math.max(30, Math.hypot(victimPos.x - at.x, victimPos.y - at.y) - C.PlayerBodyRadius)
      : 140;
    let r, alpha;
    if (t <= C.ExplosionRingCatchUpDuration) {
      r = targetR * (t / C.ExplosionRingCatchUpDuration);
      alpha = 0.95;
    } else {
      const t2 = t - C.ExplosionRingCatchUpDuration;
      r = targetR + t2 * C.ExplosionRingExpandSpeed;
      alpha = 1 - t2 / C.ExplosionRingFadeDuration;
    }
    if (alpha <= 0) return;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,140,40,${alpha})`;
    ctx.lineWidth = 10;
    ctx.stroke();
  }

  function drawFakeBombBurst(ctx, ef, age, snap) {
    if (age < 0 || age > C.FakeBombBurstDuration) return;
    const k = age / C.FakeBombBurstDuration;
    const ease = 1 - Math.pow(1 - k, 2);
    ctx.save();
    ctx.textAlign = "center";
    ctx.globalAlpha = Math.max(0, 1 - k);
    const colors = ["#ffd54c", "#7dff9b", "#ff8cc8", "#78c8ff", "#ffffff"];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + i * 1.73;
      const radius = 18 + ease * (55 + (i % 5) * 9);
      const x = ef.x + Math.cos(a) * radius;
      const y = ef.y + Math.sin(a) * radius + k * k * 35;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + k * 8);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
    const receiver = ef.rewardPlayerId &&
      snap.players.find(p => p.id === ef.rewardPlayerId);
    if (receiver) {
      // A visible stream of coins travels from the popped decoy to the player
      // the host selected as nearest, making the fixed reward unambiguous.
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "#ffd54c";
      for (let i = 0; i < 7; i++) {
        const travel = Math.max(0, Math.min(1, k * 1.45 - i * 0.07));
        const x = ef.x + (receiver.x - ef.x) * travel;
        const y = ef.y + (receiver.y - ef.y) * travel -
          Math.sin(travel * Math.PI) * (28 + i * 3);
        ctx.fillText("●", x, y);
      }
    }
    ctx.font = `bold ${Math.round(24 + 12 * (1 - k))}px sans-serif`;
    ctx.fillStyle = "#ffd54c";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 5;
    const labelY = ef.y - 36 - ease * 28;
    const label = `FAKE!  +$${ef.reward || C.FakeBombNearestReward}`;
    ctx.strokeText(label, ef.x, labelY);
    ctx.fillText(label, ef.x, labelY);
    ctx.restore();
  }

  function drawCoinSteal(ctx, ef, age, snap) {
    if (age < 0 || age > C.CoinStealEffectDuration) return;
    const receiver = ef.receiverId && snap.players.find(p => p.id === ef.receiverId);
    if (!receiver) return;
    const k = Math.min(1, age / C.CoinStealEffectDuration);
    const travelBase = Math.min(1, k * 1.35);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 15px sans-serif";
    const coinCount = Math.max(1, Math.min(C.BombBulletCoinLoss, ef.amount || 0));
    for (let i = 0; i < coinCount; i++) {
      const travel = Math.max(0, Math.min(1, travelBase - i * 0.075));
      const ease = 1 - Math.pow(1 - travel, 2);
      const x = ef.x + (receiver.x - ef.x) * ease;
      const y = ef.y + (receiver.y - ef.y) * ease -
        Math.sin(ease * Math.PI) * (30 + i * 4);
      ctx.globalAlpha = Math.min(1, travel * 5) * (1 - Math.max(0, k - 0.88) / 0.12);
      ctx.fillStyle = "#ffd54c";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#8a5b00";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (k > 0.48) {
      const labelK = (k - 0.48) / 0.52;
      ctx.globalAlpha = Math.min(1, labelK * 4) * (1 - Math.max(0, labelK - 0.72) / 0.28);
      ctx.font = "bold 22px sans-serif";
      ctx.fillStyle = "#ffd54c";
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 5;
      const label = `+$${ef.amount}`;
      const labelY = receiver.y - C.PlayerBodyRadius - 28 - labelK * 16;
      ctx.strokeText(label, receiver.x, labelY);
      ctx.fillText(label, receiver.x, labelY);
    }
    ctx.restore();
  }

  // ---- Grapple Claw visuals -------------------------------------------------

  // Taut steel cable from an anchor point (the thrower's hand / puller's
  // seat) out to the claw head.
  function drawClawCable(ctx, x0, y0, x1, y1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#8a93a0";
    ctx.stroke();
  }

  // Three-pronged claw head. `spread` is 1 while flying (prongs wide open,
  // ready to snatch) and near 0 once latched (prongs clamped shut around the
  // bomb). Drawn pointing along `angle`.
  function drawClawHead(ctx, x, y, angle, spread) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#c9d2dc";
    ctx.lineWidth = 3.5;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-7, side * 3);
      ctx.quadraticCurveTo(4, side * (7 + 9 * spread), 13, side * (4 + 7 * spread));
      ctx.quadraticCurveTo(17, side * (2 + 5 * spread), 14, side * (1 + 2 * spread));
      ctx.stroke();
    }
    // Center spike.
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(13, 0);
    ctx.stroke();
    // Hub the prongs hinge on.
    ctx.beginPath();
    ctx.arc(-7, 0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#9aa4b2";
    ctx.fill();
    ctx.restore();
  }

  // In-flight grapple: cable trailing from the launch point, open claw head
  // at the tip pointing along the direction of travel.
  function drawClawProjectile(ctx, pr) {
    const ox = pr.ox != null ? pr.ox : pr.x, oy = pr.oy != null ? pr.oy : pr.y;
    drawClawCable(ctx, ox, oy, pr.x, pr.y);
    const angle = Math.atan2(pr.y - oy, pr.x - ox);
    drawClawHead(ctx, pr.x, pr.y, angle, 1);
  }

  // Latched grapple reeling a bomb in: cable from the puller's seat to the
  // bomb, claw clamped shut on the bomb's near edge, facing into it.
  function drawClawTether(ctx, anchorX, anchorY, bombX, bombY) {
    drawClawCable(ctx, anchorX, anchorY, bombX, bombY);
    const angle = Math.atan2(bombY - anchorY, bombX - anchorX);
    const gripX = bombX - Math.cos(angle) * (C.BombRadius + 6);
    const gripY = bombY - Math.sin(angle) * (C.BombRadius + 6);
    drawClawHead(ctx, gripX, gripY, angle, 0.1);
  }

  function drawOverlays(ctx, snap) {
    const cx = C.WorldWidth / 2, cy = C.WorldHeight / 2;
    ctx.textAlign = "center";

    // Speed modifier badge, top-of-screen, matching the background tint.
    if (snap.bomb && snap.bomb.speedMult !== 1) {
      const mult = snap.bomb.speedMult;
      ctx.font = "bold 18px sans-serif";
      if (mult === 0) {
        ctx.fillStyle = "#7ec2ff";
        ctx.fillText("⏸️ TIME FROZEN", cx, 26);
      } else {
        const fast = mult > 1;
        ctx.fillStyle = fast ? "#ff8a6b" : "#7ec2ff";
        ctx.fillText(fast ? `⚡ SPEED x${mult}` : `🐌 SPEED x${mult}`, cx, 26);
      }
    }

    if (snap.reversePassing) {
      ctx.font = "bold 18px sans-serif";
      ctx.fillStyle = "#f5a3ff";
      ctx.fillText("🔄 PASS ORDER REVERSED", cx, 50);
    }

    if (snap.phase === "reveal" && snap.bomb) {
      ctx.font = "bold 42px sans-serif";
      ctx.fillStyle = "#ffce54";
      ctx.fillText(`BOMB TIME: ${snap.bomb.initialTime} SECONDS`, cx, cy - 10);
    } else if (snap.phase === "countdown" && snap.bomb) {
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "#c6cdd6";
      ctx.fillText(`BOMB TIME: ${snap.bomb.initialTime} SECONDS`, cx, cy - 60);
      ctx.font = "bold 96px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(Math.ceil(snap.phaseTimer)), cx, cy + 40);
    } else if (snap.phase === "matchover") {
      ctx.font = "bold 46px sans-serif";
      ctx.fillStyle = "#ffce54";
      ctx.fillText(snap.winnerName ? `${snap.winnerName} WINS!` : "MATCH OVER", cx, cy);
    }

    // Pass UI — anyone holding a bomb (real or fake — same UI, same bluff)
    // needs it.
    const you = snap.you;
    if (you && you.parry && you.parry.state === "success" && snap.phase === "playing") {
      ctx.font = "bold 26px sans-serif";
      ctx.fillStyle = "#64f4ff";
      ctx.fillText("PARRY!  SPEED ×1.5", cx, C.WorldHeight - 24);
    } else if (you && (you.isHolder || you.holdsFake || you.fakePassing) && snap.phase === "playing") {
      ctx.font = "bold 24px sans-serif";
      if ((you.isHolder && snap.bomb && snap.bomb.transferring) || you.fakePassing) {
        ctx.fillStyle = "#c6cdd6";
        ctx.fillText("PASSING...", cx, C.WorldHeight - 24);
      } else if (snap.you.canPass) {
        ctx.fillStyle = "#7dff9b";
        ctx.fillText("PASS  (SPACE)", cx, C.WorldHeight - 24);
      } else {
        ctx.fillStyle = "#ff9d5c";
        ctx.fillText(`PASS LOCK: ${snap.you.passLock.toFixed(1)}s`, cx, C.WorldHeight - 24);
      }
    } else if (snap.you && snap.you.chargedWeaponCharging && snap.phase === "playing") {
      ctx.font = "bold 20px sans-serif";
      const progress = snap.you.deadWeaponCharge;
      const minimumProgress = C.ChargedShotMinimumChargeTime / C.ChargedShotChargeTime;
      const chargeTimeScale = Math.max(1, snap.players.length) / C.ChargedShotBaselinePlayers;
      if (progress >= 1) {
        ctx.fillStyle = "#7dff9b";
        ctx.fillText("SLING SHOT FULL POWER — RELEASE (100% SPEED)", cx, C.WorldHeight - 24);
      } else if (progress >= minimumProgress) {
        const speedProgress = (progress - minimumProgress) / (1 - minimumProgress);
        const speedPercent = Math.round(100 *
          (C.ChargedProjectileMinSpeedMultiplier +
            (1 - C.ChargedProjectileMinSpeedMultiplier) * speedProgress));
        ctx.fillStyle = "#ffd166";
        ctx.fillText(`SLING SHOT READY — RELEASE (${speedPercent}% SPEED) · HOLD FOR FULL`,
          cx, C.WorldHeight - 24);
      } else {
        ctx.fillStyle = "#dca0ff";
        const elapsed = progress * C.ChargedShotChargeTime * chargeTimeScale;
        const minimumTime = C.ChargedShotMinimumChargeTime * chargeTimeScale;
        ctx.fillText(`CHARGING SLING SHOT: ${elapsed.toFixed(1)} / ${minimumTime.toFixed(1)}s`,
          cx, C.WorldHeight - 24);
      }
    } else if (snap.you && !snap.you.alive && snap.phase !== "matchover") {
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "#9aa4b2";
      ctx.fillText("GHOST SLING STANDBY", cx, C.WorldHeight - 24);
    }
  }

  let blackoutCanvas = null;
  function drawBlackout(ctx, snap, myId) {
    if (!(snap.blackoutRemaining > 0)) return;
    if (!blackoutCanvas) {
      blackoutCanvas = document.createElement("canvas");
      blackoutCanvas.width = C.WorldWidth;
      blackoutCanvas.height = C.WorldHeight;
    }
    const oc = blackoutCanvas.getContext("2d");
    oc.clearRect(0, 0, C.WorldWidth, C.WorldHeight);
    oc.globalCompositeOperation = "source-over";
    const fade = Math.min(1,
      (snap.blackoutElapsed || 0) / C.BlackoutFadeDuration,
      snap.blackoutRemaining / C.BlackoutFadeDuration);
    // Eliminated players are spectators: Lights Out does not restrict their
    // vision, but their screen still receives a subdued blackout tint.
    if (snap.you && !snap.you.alive) {
      oc.fillStyle = `rgba(0,0,0,${0.55 * fade})`;
      oc.fillRect(0, 0, C.WorldWidth, C.WorldHeight);
      ctx.drawImage(blackoutCanvas, 0, 0);
      return;
    }
    oc.fillStyle = `rgba(0,0,0,${0.97 * fade})`;
    oc.fillRect(0, 0, C.WorldWidth, C.WorldHeight);
    oc.globalCompositeOperation = "destination-out";

    const me = snap.players.find(p => p.id === myId);
    if (me) {
      const radius = C.BlackoutVisionRadius;
      const glow = oc.createRadialGradient(me.x, me.y, radius * 0.35, me.x, me.y, radius);
      glow.addColorStop(0, "rgba(0,0,0,1)");
      glow.addColorStop(0.72, "rgba(0,0,0,0.9)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      oc.fillStyle = glow;
      oc.beginPath();
      oc.arc(me.x, me.y, radius, 0, Math.PI * 2);
      oc.fill();

      // An active Magnifying Glass doubles as a directional flashlight.
      if (me.revealing && me.aimX != null) {
        let dx = me.aimX - me.x, dy = me.aimY - me.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const px = -dy, py = dx;
        const half = C.MagnifyCastWidth * 1.4;
        oc.fillStyle = "rgba(0,0,0,0.95)";
        oc.beginPath();
        oc.moveTo(me.x + px * half, me.y + py * half);
        oc.lineTo(me.x - px * half, me.y - py * half);
        oc.lineTo(me.x - px * half + dx * C.MagnifyCastLength,
          me.y - py * half + dy * C.MagnifyCastLength);
        oc.lineTo(me.x + px * half + dx * C.MagnifyCastLength,
          me.y + py * half + dy * C.MagnifyCastLength);
        oc.closePath();
        oc.fill();
      }
    }
    oc.globalCompositeOperation = "source-over";
    ctx.drawImage(blackoutCanvas, 0, 0);
  }

  // ---- DOM panels ----------------------------------------------------------

  let lastHandSig = null;
  let lastCodexSig = null;
  let lastEventSeq = 0;

  // dom: { coinDisplay, statusLine, hand, btnPass, autoBuyStatus, btnDeadItem, eventLog,
  //        cardCodex, codexTitle, debugPanel, matchOverBar, matchOverText, aimHint }
  // hooks: { useCard(slot), discardCard(slot), armedSlot, isHost }
  function updateDom(dom, snap, hooks) {
    const you = snap.you;
    const me = you ? snap.players.find(p => p.id === you.id) : null;

    // The right-side codex is the authoritative shop pool for this round, not
    // a static list of every card in the game. Pool order carries its role:
    // fixed Magnifying Glass, attack roll, defense roll, unrestricted roll.
    const roundIds = snap.roundCardPool || [];
    const shopMode = !!(snap.modes && snap.modes.roguelikeShop);
    const codexSig = JSON.stringify([snap.roundNumber, roundIds, shopMode]);
    if (dom.cardCodex && codexSig !== lastCodexSig) {
      lastCodexSig = codexSig;
      if (dom.codexTitle) dom.codexTitle.textContent = shopMode
        ? "Full Card Pool"
        : `Round ${snap.roundNumber} Shop Pool`;
      dom.cardCodex.innerHTML = "";
      const roleNames = ["FIXED", "ATTACK", "DEFENSE", "RANDOM"];
      for (let i = 0; i < roundIds.length; i++) {
        const def = Cards.TYPES[roundIds[i]];
        if (!def) continue;
        const row = document.createElement("div");
        row.className = "codexRow";
        const emoji = document.createElement("div");
        emoji.className = "codexEmoji";
        emoji.textContent = def.emoji;
        const body = document.createElement("div");
        const tag = document.createElement("div");
        tag.className = `codexTag codexTag${i}`;
        tag.textContent = shopMode ? "AVAILABLE" : (roleNames[i] || "RANDOM");
        const name = document.createElement("div");
        name.className = "codexName";
        name.textContent = def.name;
        const desc = document.createElement("div");
        desc.className = "codexDesc";
        desc.textContent = def.desc || "";
        body.append(tag, name, desc);
        row.append(emoji, body);
        dom.cardCodex.appendChild(row);
      }
    }

    if (you) {
      if (dom.handTitle) dom.handTitle.textContent = shopMode
        ? `Choose & use (${C.CardDrawCost}c each · 1-3) or reroll (${C.ShopRerollCost}c · 4)`
        : "Hand (1-5 or click)";
      // Mirrors Sim.coinIntervalScale: scale by the *current* alive count, not
      // the fixed seat count, so the shown rate speeds up as players die.
      const coinScale = Math.max(1, snap.aliveCount) / C.CoinEconomyBaselinePlayers;
      const baseRate = C.PassiveCoinAmount / (C.PassiveCoinInterval * coinScale);
      // Farming the bomb replaces passive income, it doesn't stack on top —
      // matches Sim.step's coin logic. The pot itself grows (shown on the
      // bomb badge instead), but it isn't yours until you throw it, so your
      // own rate reads 0 the whole time you're holding.
      let rate = baseRate, rateColor = "#9aa1ad";
      if (me && me.earningPenalty) { rate = 0; rateColor = "#ff5d5d"; }
      else if (me && me.earningBonus) { rate = 0; rateColor = "#ffd54c"; }
      const rateText = `(+${Number.isInteger(rate) ? rate : rate.toFixed(1)}/s)`;
      dom.coinDisplay.innerHTML = `<span class="coin-icon">💰</span>${you.coins}` +
        ` <span style="font-size:14px;color:${rateColor}">${rateText}</span>`;
      const aliveText = snap.teamAliveCounts
        ? snap.teamAliveCounts.map((n, i) => `Team ${i + 1}: ${n}`).join("   ·   ")
        : `Alive: ${snap.aliveCount}/${snap.players.length}`;
      dom.statusLine.textContent = aliveText +
        (snap.bomb ? `   ·   Bomb started at ${snap.bomb.initialTime}s` : "") +
        (me && me.armBuffed ? "   ·   🦾 Free-target throw active" : "");
    } else {
      dom.coinDisplay.textContent = "";
      dom.statusLine.textContent = "";
    }

    if (dom.aimHint) {
      const reinforcedActive = !!(you && me && me.armBuffed && snap.phase === "playing" &&
        ((you.isHolder && snap.bomb && !snap.bomb.transferring) || you.holdsFake));
      const chargedActive = !!(you && you.chargedWeapon && hooks.armedSlot == null &&
        snap.phase === "playing");
      dom.aimHint.style.display =
        (reinforcedActive || hooks.armedSlot != null || chargedActive) ? "block" : "none";
      dom.aimHint.textContent = reinforcedActive
        ? "🦾 REINFORCED ARM — point at any living player, then press SPACE to throw"
        : chargedActive
          ? `🪃 CHARGED SLING — release after ${(C.ChargedShotMinimumChargeTime * Math.max(1, snap.players.length) / C.ChargedShotBaselinePlayers).toFixed(1)}s at 33% speed, or hold ${(C.ChargedShotChargeTime * Math.max(1, snap.players.length) / C.ChargedShotBaselinePlayers).toFixed(1)}s for full speed (${C.ChargedShotAmount}s)`
          : "🎯 AIMING — click to fire (hold for machine gun), right-click/Esc to cancel";
    }

    // Hand slots (rebuild only when contents/usability/armed state changes).
    if (you) {
      const usable = slotUsable(snap);
      const sig = JSON.stringify([
        you.hand, you.shopPaidSlots, you.hand.map((_, i) => usable(i)), hooks.armedSlot,
      ]);
      if (sig !== lastHandSig) {
        lastHandSig = sig;
        dom.hand.innerHTML = "";
        const visibleSlots = shopMode ? C.RoguelikeChoiceCount + 1 : C.MaxHandSize;
        for (let i = 0; i < visibleSlots; i++) {
          const row = document.createElement("div");
          row.className = "cardRow";
          const cardId = you.hand[i];

          const useBtn = document.createElement("button");
          useBtn.className = "useBtn";
          if (cardId) {
            const def = Cards.TYPES[cardId];
            const paid = Array.isArray(you.shopPaidSlots) && you.shopPaidSlots.includes(i);
            const price = shopMode
              ? (paid ? " · PAID" : ` · ${def.kind === "reroll" ? C.ShopRerollCost : C.CardDrawCost}c`)
              : "";
            useBtn.innerHTML = `<span class="cardEmoji">${def.emoji}</span><span class="cardLabel">${i + 1}. ${def.name}${price}</span>`;
            useBtn.disabled = !usable(i);
            if (hooks.armedSlot === i) useBtn.classList.add("armed");
            useBtn.onclick = () => hooks.useCard(i);
          } else {
            useBtn.innerHTML = `<span class="cardEmoji">·</span><span class="cardLabel">${i + 1}. —</span>`;
            useBtn.disabled = true;
          }
          row.appendChild(useBtn);

          if (!shopMode) {
            const discardBtn = document.createElement("button");
            discardBtn.className = "discardBtn";
            discardBtn.textContent = "✕";
            discardBtn.title = "Discard without using";
            discardBtn.disabled = !cardId || !you.alive;
            discardBtn.onclick = () => hooks.discardCard(i);
            row.appendChild(discardBtn);
          }

          dom.hand.appendChild(row);
        }
      }

      if (dom.autoBuyStatus) {
        const hasRoom = you.hand.includes(null);
        const needed = Math.max(0, C.CardDrawCost - you.coins);
        dom.autoBuyStatus.textContent = shopMode
          ? (!you.alive ? "Shop unavailable" : "Pick 1–3 · reroll with 4")
          : !you.alive ? "Auto-buy paused"
          : !hasRoom ? "Hand full"
          : needed > 0 ? `Auto-buy in ${needed}c`
          : "Auto-buying…";
      }

      // Fake bombs are passed with the same button/key as the real one; the
      // UI deliberately can't tell the difference either.
      const holdsBombNow = you.isHolder || you.holdsFake || you.fakePassing;
      const bombInFlight = (you.isHolder && snap.bomb && snap.bomb.transferring) || you.fakePassing;
      if (holdsBombNow && snap.phase === "playing") {
        dom.btnPass.disabled = !you.canPass;
        dom.btnPass.textContent = bombInFlight ? "Passing..."
          : you.canPass
            ? (me && me.armBuffed ? "Throw to Target (Space)" : "Pass Bomb (Space)")
            : `Pass Lock ${you.passLock.toFixed(1)}s`;
      } else {
        dom.btnPass.disabled = true;
        dom.btnPass.textContent = "Pass Bomb (Space)";
      }
    }

    // Event log (append-only by seq).
    for (const ev of snap.events) {
      if (ev.seq <= lastEventSeq) continue;
      lastEventSeq = ev.seq;
      const div = document.createElement("div");
      div.textContent = ev.text;
      dom.eventLog.appendChild(div);
      while (dom.eventLog.childNodes.length > 60) dom.eventLog.removeChild(dom.eventLog.firstChild);
      dom.eventLog.scrollTop = dom.eventLog.scrollHeight;
    }

    // Debug panel (dev-only; data present only when requested from the host).
    if (snap.debug) {
      dom.debugPanel.style.display = "block";
      dom.debugPanel.textContent = formatDebug(snap.debug, hooks.isHost);
    } else {
      dom.debugPanel.style.display = "none";
    }

    // Host controls / match-over bar. The host gets Rematch + Back to Lobby in
    // any phase; the win banner only shows once the match is actually over.
    const isOver = snap.phase === "matchover";
    if (isOver || hooks.isHost) {
      dom.matchOverBar.style.display = "flex";
      dom.matchOverText.textContent = isOver
        ? (snap.winnerName ? `${snap.winnerName} wins!` : "Match over")
        : "";
      dom.btnRematch.style.display = hooks.isHost ? "inline-block" : "none";
      if (dom.btnToLobby) dom.btnToLobby.style.display = hooks.isHost ? "inline-block" : "none";
    } else {
      dom.matchOverBar.style.display = "none";
    }
  }

  function slotUsable(snap) {
    const you = snap.you;
    return (slot) => {
      if (snap.phase !== "playing") return false;
      const cardId = you.hand[slot];
      if (!cardId) return false;
      const kind = Cards.TYPES[cardId].kind;
      const shopMode = !!(snap.modes && snap.modes.roguelikeShop);
      if (kind === "reroll") {
        return shopMode && you.alive && you.coins >= C.ShopRerollCost;
      }
      const paid = Array.isArray(you.shopPaidSlots) && you.shopPaidSlots.includes(slot);
      if (shopMode && you.alive && !paid && you.coins < C.CardDrawCost) return false;
      if (snap.modes && snap.modes.publicSeconds && kind === "magnify") return false;
      // Eliminated players only ever hold their per-round ghost item — one
      // of the global-effect cards — and can fire it like anyone's card.
      if (!you.alive) return kind === "speed" || kind === "blackout" || kind === "reverse";
      // Shield is a personal bubble and can be activated by any living player;
      // it does not require carrying the bomb.
      // Both hands are full holding a bomb (real or fake) — the holder
      // can't wield a thrown/fired weapon at the same time. Once it's been
      // thrown and is in flight, their hands are free again.
      const handsFull = (you.isHolder && !(snap.bomb && snap.bomb.transferring)) || you.holdsFake;
      if ((kind === "projectile" || kind === "grapple") && handsFull) return false;
      if (kind === "fakebomb") {
        // Needs free hands to pull one out, and the sim also caps total
        // bombs in play (real + fakes) at the player count.
        if (handsFull) return false;
        const bombsInPlay = (snap.bomb ? 1 : 0) + (snap.fakeBombs ? snap.fakeBombs.length : 0);
        if (bombsInPlay >= snap.players.length) return false;
      }
      return true;
    };
  }

  function formatDebug(d, isHost) {
    const lines = [];
    lines.push(`[DEBUG] authority=${isHost ? "host (this machine)" : "host (remote)"}  phase=${d.phase}` +
      (d.teamCount > 1 ? `  teamCount=${d.teamCount} winningTeam=${d.winningTeam != null ? d.winningTeam + 1 : "-"}` : ""));
    lines.push(`bomb: remaining=${fmt(d.bombRemaining)} initial=${fmt(d.bombInitial)} holder=${d.holder ?? "-"}`);
    lines.push(`  pos=${d.bombPos ? d.bombPos.x + "," + d.bombPos.y : "-"} armOffset=${d.armOffset ? d.armOffset.x + "," + d.armOffset.y : "-"}`);
    lines.push(`  speed=x${fmt(d.speedMult)} (${fmt(d.speedRemaining)}s left)  shield=${d.shieldActive} (${fmt(d.shieldRemaining)}s)  jam=${fmt(d.timerJamRemaining)}s  curse=${d.curseActive}`);
    lines.push(`  passLock=${fmt(d.passLockRemaining)}  nextReceiverMinHold=${fmt(d.nextReceiverMinHold)}`);
    lines.push(`order: ${d.passingOrder.join(" → ") || "-"}   next=${d.nextAlive ?? "-"}`);
    lines.push(`projectiles: ${d.projectiles.length ? d.projectiles.map(p => `${p.amount > 0 ? "+" : ""}${p.amount}s@${p.x},${p.y}`).join("  ") : "none"}`);
    lines.push(`fakes: ${d.fakeBombs && d.fakeBombs.length ? d.fakeBombs.map(f => `${f.holder}${f.to ? "→" + f.to : ""} ${f.remaining.toFixed(1)}s jam=${f.timerJamRemaining.toFixed(1)}s`).join("  ") : "none"}`);
    for (const p of d.players) {
      const teamTag = d.teamCount > 1 ? `T${p.team + 1} ` : "";
      lines.push(`  ${teamTag}${p.name.padEnd(10)} ${p.state.padEnd(12)} coins=${String(p.coins).padEnd(4)} hand=[${p.hand.join(", ")}]`);
    }
    return lines.join("\n");
  }

  function fmt(v) { return v == null ? "-" : (typeof v === "number" ? v.toFixed(1) : String(v)); }

  function resetDomCache() {
    lastHandSig = null;
    lastCodexSig = null;
    lastEventSeq = 0;
    lastPayoutSeq = 0;
    payoutFloatStart = null;
    payoutFloatSource = null;
  }

  return { draw, updateDom, resetDomCache };
})();
