"use strict";

// Canvas + DOM rendering. Consumes only the snapshot shape produced by
// Sim.buildSnapshot(), so host and clients share exactly one render path and
// nothing here can peek at hidden state (it simply isn't in the snapshot).
const Render = (() => {
  const C = CONFIG;
  const SEAT_COLORS = ["#e6604c", "#4c9be6", "#5cc46a", "#e6c14c", "#b06ce6", "#e68b4c", "#4ce6d4", "#e64ca8"];
  const FLOAT_LIFETIME = 1.6; // seconds a positioned event floats on screen
  const PAYOUT_FLOAT_LIFETIME = 1.3; // seconds the private "+N" cash-in cue floats

  // Tracks the last farmed-pot payout this client has already shown, so a
  // new one (bumped `seq`) triggers exactly one float — module state because
  // it's driven by snap.time deltas across frames, same pattern as the DOM
  // hand/event caches below.
  let lastPayoutSeq = 0;
  let payoutFloatStart = null;
  let payoutFloatAmount = 0;

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
      const col = SEAT_COLORS[p.seat % SEAT_COLORS.length];
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
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = aliveLook ? "#e8e8e8" : "#767e8a";
      const tag = p.id === myId ? " (you)" : "";
      ctx.fillText(p.name + tag, p.x, p.y - C.PlayerBodyRadius - 10);

      // A player aiming a projectile card holds it visibly for everyone to
      // see — and since both their hands are busy, they can't be the bomb
      // holder at the same time.
      if (p.alive && p.equipped) drawWeaponPose(ctx, p, cx, cy);

      // Everyone can see *that* a player is using a Magnifying Glass, and
      // where its box-cast is pointed — just never the reading it gives them.
      if (p.alive && p.revealing) {
        drawMagnifyCast(ctx, p, snap.bomb);
        ctx.font = "18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("🔍", p.x + C.PlayerBodyRadius + 4, p.y - C.PlayerBodyRadius - 6);
      }

      // Bonus-income cue: pulsing ring + coins drifting up while the
      // holder-bonus window is open, gone the instant it stops (pass it off
      // / window ends).
      if (p.alive && p.earningBonus) drawCoinParticles(ctx, p, snap.time);

      // Stalling penalty cue: holder has been sitting on the bomb past the
      // grace window and is currently earning nothing.
      if (p.alive && p.earningPenalty) drawStalledIcon(ctx, p, snap.time);

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
      if (target) drawPlayerTooltip(ctx, target);
    }

    // Fake decoys: drawn with the identical holder arms + bomb body as the
    // real one — on screen there is simply no way to tell them apart.
    for (const f of snap.fakeBombs) {
      const fHolder = f.holderId ? snap.players.find(p => p.id === f.holderId) : null;
      if (fHolder && fHolder.alive && !f.transferring) drawArms(ctx, fHolder, f, fHolder.armBuffed);
      if (f.claw) drawClawTether(ctx, f.clawX, f.clawY, f.x, f.y);
      drawBombBody(ctx, f.x, f.y, snap.time);
      // Creator-only peek at the decoy's timer (only ever present in the
      // creator's own snapshot) — same look as the Magnifying Glass reveal.
      if (f.privateRemaining != null) {
        ctx.font = "bold 17px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffe27a";
        ctx.fillText(f.privateRemaining.toFixed(1) + "s", f.x, f.y);
        ctx.textBaseline = "alphabetic";
      }
      drawPotBadge(ctx, f.x, f.y, f.pot);
    }

    // Arms: body -> hands -> bomb, only for the current holder, and only
    // while the bomb isn't mid-flight between seats (nobody's arms are on it).
    if (snap.bomb && !snap.bomb.transferring && holder && holder.alive) {
      drawArms(ctx, holder, snap.bomb, holder.armBuffed);
    }

    // Bomb (with cable + gripping claw while a grapple is reeling it in).
    if (snap.bomb) {
      if (snap.bomb.claw) drawClawTether(ctx, snap.bomb.clawX, snap.bomb.clawY, snap.bomb.x, snap.bomb.y);
      drawBomb(ctx, snap);
    }

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

    // One-shot positioned effects: a fake bomb popping harmlessly — the
    // exact same blast presentation as the real thing (mid-air pops include
    // the frozen-at-0 beat), just with nobody to kill.
    for (const ef of snap.effects || []) {
      if (ef.type !== "fakeboom") continue;
      const age = snap.time - ef.time;
      drawStagedBlast(ctx, ef, null, age, snap.time, ef.midAir ? C.ExplosionHoldDuration : 0);
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
    if (snap.you && snap.you.payout && snap.you.payout.seq > lastPayoutSeq) {
      lastPayoutSeq = snap.you.payout.seq;
      payoutFloatStart = snap.time;
      payoutFloatAmount = snap.you.payout.amount;
    }
    if (payoutFloatStart != null) {
      const age = snap.time - payoutFloatStart;
      if (age <= PAYOUT_FLOAT_LIFETIME) {
        const me = snap.players.find(p => p.id === myId);
        if (me) {
          const k = age / PAYOUT_FLOAT_LIFETIME;
          const scale = 1 + (1 - k) * 0.3;
          ctx.save();
          ctx.font = `bold ${Math.round(30 * scale)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = `rgba(255,213,76,${1 - k})`;
          ctx.strokeStyle = `rgba(0,0,0,${0.55 * (1 - k)})`;
          ctx.lineWidth = 4;
          const fx = me.x, fy = me.y - C.PlayerBodyRadius - 30 - k * 46;
          const text = `+${payoutFloatAmount} 💰`;
          ctx.strokeText(text, fx, fy);
          ctx.fillText(text, fx, fy);
          ctx.restore();
        }
      } else {
        payoutFloatStart = null;
      }
    }

    drawOverlays(ctx, snap);
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

  function drawArms(ctx, holder, bomb, buffed) {
    let dx = bomb.x - holder.x, dy = bomb.y - holder.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const px = -dy, py = dx; // perpendicular
    // Reinforced Arm: tint the arms silver/metallic while the buff is active.
    const col = buffed ? "#c9d2dc" : SEAT_COLORS[holder.seat % SEAT_COLORS.length];
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

  // Public pose for a player who has a projectile card armed: a single raised
  // arm pointing toward their aim, tipped with a small weapon marker. Purely
  // cosmetic — the actual shot only fires once they click.
  function drawWeaponPose(ctx, p, cx, cy) {
    let dx, dy;
    if (p.aimX != null) {
      dx = p.aimX - p.x; dy = p.aimY - p.y;
    } else {
      dx = cx - p.x; dy = cy - p.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const col = SEAT_COLORS[p.seat % SEAT_COLORS.length];
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

  // Deterministic little coin puffs rising off a player, driven purely by
  // snap.time so it needs no particle-system state of its own — matches the
  // rest of this module's "render is a pure function of snap" approach.
  // Paired with a pulsing golden ring so the bonus window is unmistakable at
  // a glance, not just a small drifting emoji.
  function drawCoinParticles(ctx, p, time) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, C.PlayerBodyRadius + 7 + pulse * 3, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(255,213,76,${0.45 + pulse * 0.4})`;
    ctx.stroke();

    const seed = (p.seat * 37) % 100;
    const COUNT = 4, PERIOD = 0.8;
    for (let i = 0; i < COUNT; i++) {
      const phase = (seed + i * 25) % 100 / 100;
      const t = ((time / PERIOD + phase) % 1 + 1) % 1; // 0..1 loop
      const rise = t * 40;
      const drift = Math.sin((t + phase) * Math.PI * 2) * 10;
      const alpha = 1 - t;
      ctx.font = `bold ${14 + t * 6}px sans-serif`;
      ctx.textAlign = "center";
      ctx.globalAlpha = alpha;
      ctx.fillText("💰", p.x + drift, p.y - C.PlayerBodyRadius - 6 - rise);
      ctx.globalAlpha = 1;
    }
  }

  // Red pulsing ring + crossed-out coin: the holder is past the grace window
  // and currently earning nothing — the stalling penalty is active.
  function drawStalledIcon(ctx, p, time) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    ctx.beginPath();
    ctx.arc(p.x, p.y, C.PlayerBodyRadius + 7, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(255,80,80,${0.4 + pulse * 0.35})`;
    ctx.stroke();
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("🚫💰", p.x, p.y - C.PlayerBodyRadius - 16);
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

  function drawBomb(ctx, snap) {
    const b = snap.bomb;
    // Shield ring.
    if (b.shield) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, C.BombRadius + 8, 0, Math.PI * 2);
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
    if (snap.you && snap.you.reveal) {
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffe27a";
      ctx.fillText(snap.you.reveal.bombTime.toFixed(1) + "s", b.x, b.y);
      ctx.textBaseline = "alphabetic";
    } else if (b.publicRemaining != null) {
      // Opening public reveal window: same look as the Magnifying Glass,
      // but visible to everyone and follows the bomb around.
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffe27a";
      ctx.fillText(b.publicRemaining.toFixed(1) + "s", b.x, b.y);
      ctx.textBaseline = "alphabetic";
    }
    drawPotBadge(ctx, b.x, b.y, b.pot);
  }

  // Farmed-pot badge, shown on the bomb itself while it's being held — public
  // to everyone, and drawn identically for a fake decoy (see the fakeBombs
  // loop in draw()) so the number on screen never tells the two apart. Only
  // whether it actually pays out on release stays private.
  function drawPotBadge(ctx, x, y, pot) {
    if (!pot) return;
    const text = `💰${pot}`;
    ctx.font = "bold 13px sans-serif";
    const padX = 6, padY = 3;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 16 + padY * 2 - 4;
    const bx = x, by = y + C.BombRadius + 16;
    ctx.fillStyle = "rgba(20,22,28,0.82)";
    ctx.strokeStyle = "rgba(255,213,76,0.7)";
    ctx.lineWidth = 1;
    roundRect(ctx, bx - w / 2, by - h / 2, w, h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd54c";
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

  // Staged blast, used for every explosion real or fake: an optional frozen
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
    if (you && (you.isHolder || you.holdsFake || you.fakePassing) && snap.phase === "playing") {
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
    } else if (snap.you && !snap.you.alive && snap.phase !== "matchover") {
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "#9aa4b2";
      ctx.fillText("SPECTATOR", cx, C.WorldHeight - 24);
    }
  }

  // ---- DOM panels ----------------------------------------------------------

  let lastHandSig = null;
  let lastEventSeq = 0;

  // dom: { coinDisplay, statusLine, hand, btnPass, btnDraw, eventLog, debugPanel, matchOverBar, matchOverText, aimHint }
  // hooks: { useCard(slot), discardCard(slot), armedSlot, isHost }
  function updateDom(dom, snap, hooks) {
    const you = snap.you;

    if (you) {
      const me = snap.players.find(p => p.id === you.id);
      const coinScale = snap.seatCount / C.CoinEconomyBaselinePlayers;
      const baseRate = C.PassiveCoinAmount / (C.PassiveCoinInterval * coinScale);
      const bonusRate = C.BombHolderCoinAmount / (C.BombHolderCoinInterval * coinScale);
      // Farming the bomb replaces passive income, it doesn't stack on top —
      // matches Sim.step's coin logic.
      let rate = baseRate, rateColor = "#9aa1ad";
      if (me && me.earningPenalty) { rate = 0; rateColor = "#ff5d5d"; }
      else if (me && me.earningBonus) { rate = bonusRate; rateColor = "#5dff8a"; }
      const rateText = `(+${rate.toFixed(1)}/s)`;
      dom.coinDisplay.innerHTML = `<span class="coin-icon">💰</span>${you.coins}` +
        ` <span style="font-size:14px;color:${rateColor}">${rateText}</span>`;
      dom.statusLine.textContent = `Alive: ${snap.aliveCount}/${snap.players.length}` +
        (snap.bomb ? `   ·   Bomb started at ${snap.bomb.initialTime}s` : "");
    } else {
      dom.coinDisplay.textContent = "";
      dom.statusLine.textContent = "";
    }

    if (dom.aimHint) dom.aimHint.style.display = hooks.armedSlot != null ? "block" : "none";

    // Hand slots (rebuild only when contents/usability/armed state changes).
    if (you) {
      const usable = slotUsable(snap);
      const sig = JSON.stringify([you.hand, you.hand.map((_, i) => usable(i)), hooks.armedSlot]);
      if (sig !== lastHandSig) {
        lastHandSig = sig;
        dom.hand.innerHTML = "";
        for (let i = 0; i < C.MaxHandSize; i++) {
          const row = document.createElement("div");
          row.className = "cardRow";
          const cardId = you.hand[i];

          const useBtn = document.createElement("button");
          useBtn.className = "useBtn";
          if (cardId) {
            const def = Cards.TYPES[cardId];
            useBtn.innerHTML = `<span class="cardEmoji">${def.emoji}</span><span class="cardLabel">${i + 1}. ${def.name}</span>`;
            useBtn.disabled = !usable(i);
            if (hooks.armedSlot === i) useBtn.classList.add("armed");
            useBtn.onclick = () => hooks.useCard(i);
          } else {
            useBtn.innerHTML = `<span class="cardEmoji">·</span><span class="cardLabel">${i + 1}. —</span>`;
            useBtn.disabled = true;
          }
          row.appendChild(useBtn);

          const discardBtn = document.createElement("button");
          discardBtn.className = "discardBtn";
          discardBtn.textContent = "✕";
          discardBtn.title = "Discard without using";
          discardBtn.disabled = !cardId || !you.alive;
          discardBtn.onclick = () => hooks.discardCard(i);
          row.appendChild(discardBtn);

          dom.hand.appendChild(row);
        }
      }

      dom.btnDraw.disabled = !you.alive || you.coins < C.CardDrawCost || !you.hand.includes(null);
      dom.btnDraw.textContent = `Draw Card (R) — ${C.CardDrawCost}c`;

      // Fake bombs are passed with the same button/key as the real one; the
      // UI deliberately can't tell the difference either.
      const holdsBombNow = you.isHolder || you.holdsFake || you.fakePassing;
      const bombInFlight = (you.isHolder && snap.bomb && snap.bomb.transferring) || you.fakePassing;
      if (holdsBombNow && snap.phase === "playing") {
        dom.btnPass.disabled = !you.canPass;
        dom.btnPass.textContent = bombInFlight ? "Passing..."
          : you.canPass ? "Pass Bomb (Space)" : `Pass Lock ${you.passLock.toFixed(1)}s`;
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

    // Match over bar.
    if (snap.phase === "matchover") {
      dom.matchOverBar.style.display = "flex";
      dom.matchOverText.textContent = snap.winnerName ? `${snap.winnerName} wins!` : "Match over";
      dom.btnRematch.style.display = hooks.isHost ? "inline-block" : "none";
      if (dom.btnToLobby) dom.btnToLobby.style.display = hooks.isHost ? "inline-block" : "none";
    } else {
      dom.matchOverBar.style.display = "none";
    }
  }

  function slotUsable(snap) {
    const you = snap.you;
    return (slot) => {
      if (!you.alive || snap.phase !== "playing") return false;
      const cardId = you.hand[slot];
      if (!cardId) return false;
      const kind = Cards.TYPES[cardId].kind;
      if (kind === "shield" && !you.isHolder) return false;
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
    lines.push(`[DEBUG] authority=${isHost ? "host (this machine)" : "host (remote)"}  phase=${d.phase}`);
    lines.push(`bomb: remaining=${fmt(d.bombRemaining)} initial=${fmt(d.bombInitial)} holder=${d.holder ?? "-"}`);
    lines.push(`  pos=${d.bombPos ? d.bombPos.x + "," + d.bombPos.y : "-"} armOffset=${d.armOffset ? d.armOffset.x + "," + d.armOffset.y : "-"}`);
    lines.push(`  speed=x${fmt(d.speedMult)} (${fmt(d.speedRemaining)}s left)  shield=${d.shieldActive} (${fmt(d.shieldRemaining)}s)  curse=${d.curseActive}`);
    lines.push(`  passLock=${fmt(d.passLockRemaining)}  nextReceiverMinHold=${fmt(d.nextReceiverMinHold)}`);
    lines.push(`order: ${d.passingOrder.join(" → ") || "-"}   next=${d.nextAlive ?? "-"}`);
    lines.push(`projectiles: ${d.projectiles.length ? d.projectiles.map(p => `${p.amount > 0 ? "+" : ""}${p.amount}s@${p.x},${p.y}`).join("  ") : "none"}`);
    lines.push(`fakes: ${d.fakeBombs && d.fakeBombs.length ? d.fakeBombs.map(f => `${f.holder}${f.to ? "→" + f.to : ""} ${f.remaining.toFixed(1)}s`).join("  ") : "none"}`);
    for (const p of d.players) {
      lines.push(`  ${p.name.padEnd(10)} ${p.state.padEnd(12)} coins=${String(p.coins).padEnd(4)} hand=[${p.hand.join(", ")}]`);
    }
    return lines.join("\n");
  }

  function fmt(v) { return v == null ? "-" : (typeof v === "number" ? v.toFixed(1) : String(v)); }

  function resetDomCache() {
    lastHandSig = null;
    lastEventSeq = 0;
    lastPayoutSeq = 0;
    payoutFloatStart = null;
  }

  return { draw, updateDom, resetDomCache };
})();
