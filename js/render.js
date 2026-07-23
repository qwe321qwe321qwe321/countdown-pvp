"use strict";

// Canvas + DOM rendering. Consumes only the snapshot shape produced by
// Sim.buildSnapshot(), so host and clients share exactly one render path and
// nothing here can peek at hidden state (it simply isn't in the snapshot).
const Render = (() => {
  const C = CONFIG;
  const SEAT_COLORS = ["#e6604c", "#4c9be6", "#5cc46a", "#e6c14c", "#b06ce6", "#e68b4c", "#4ce6d4", "#e64ca8"];
  const FLOAT_LIFETIME = 1.6; // seconds a positioned event floats on screen

  // ---- Canvas --------------------------------------------------------------

  function draw(ctx, snap, myId) {
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

    // Players (fixed seats, never move).
    for (const p of snap.players) {
      const col = SEAT_COLORS[p.seat % SEAT_COLORS.length];
      ctx.beginPath();
      ctx.arc(p.x, p.y, C.PlayerBodyRadius, 0, Math.PI * 2);
      if (p.alive) {
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
      ctx.fillStyle = p.alive ? "#e8e8e8" : "#767e8a";
      const tag = p.id === myId ? " (you)" : "";
      ctx.fillText(p.name + tag, p.x, p.y - C.PlayerBodyRadius - 10);

      // A player aiming a projectile card holds it visibly for everyone to
      // see — and since both their hands are busy, they can't be the bomb
      // holder at the same time.
      if (p.alive && p.equipped) drawWeaponPose(ctx, p, cx, cy);
    }

    // Arms: body -> hands -> bomb, only for the current holder, and only
    // while the bomb isn't mid-flight between seats (nobody's arms are on it).
    if (snap.bomb && !snap.bomb.transferring && holder && holder.alive) {
      drawArms(ctx, holder, snap.bomb);
    }

    // Bomb.
    if (snap.bomb) drawBomb(ctx, snap);

    // Projectiles: red = minus-time, green = plus-time.
    for (const pr of snap.projectiles) {
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, C.ProjectileRadius, 0, Math.PI * 2);
      ctx.fillStyle = pr.amount < 0 ? "#ff5d5d" : "#5dff8a";
      ctx.fill();
    }

    // Explosion transition.
    if (snap.phase === "exploding" && snap.explosionAt) {
      const t = 1 - snap.phaseTimer / C.ExplosionTransitionDuration; // 0..1
      const r = 20 + t * 140;
      ctx.beginPath();
      ctx.arc(snap.explosionAt.x, snap.explosionAt.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,140,40,${Math.max(0, 1 - t)})`;
      ctx.lineWidth = 10;
      ctx.stroke();
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

    drawOverlays(ctx, snap);
  }

  // Background tint while a Speed Up/Slow Down modifier is active: a subtle
  // pulsing warm tint for 2x, cool tint for 0.5x — a public state, same tier
  // as the Shield/Curse booleans, so this is not the hidden timer leaking.
  function bgColorFor(snap) {
    const base = { r: 0x14, g: 0x16, b: 0x1a };
    const mult = snap.bomb ? snap.bomb.speedMult : 1;
    if (!mult || mult === 1) return `rgb(${base.r},${base.g},${base.b})`;
    const pulse = 0.5 + 0.5 * Math.sin(snap.time * 6);
    const tint = mult > 1 ? { r: 0x6a, g: 0x1a, b: 0x1a } : { r: 0x1a, g: 0x38, b: 0x6a };
    const k = 0.12 + pulse * 0.10;
    const mix = (a, b) => Math.round(a + (b - a) * k);
    return `rgb(${mix(base.r, tint.r)},${mix(base.g, tint.g)},${mix(base.b, tint.b)})`;
  }

  function drawArms(ctx, holder, bomb) {
    let dx = bomb.x - holder.x, dy = bomb.y - holder.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const px = -dy, py = dx; // perpendicular
    const col = SEAT_COLORS[holder.seat % SEAT_COLORS.length];
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
    // Body + fuse + spark.
    ctx.beginPath();
    ctx.arc(b.x, b.y, C.BombRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#101114";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#585f6b";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x + 4, b.y - C.BombRadius + 2);
    ctx.quadraticCurveTo(b.x + 12, b.y - C.BombRadius - 8, b.x + 6, b.y - C.BombRadius - 13);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#8a7a54";
    ctx.stroke();
    const flick = 2 + Math.sin(snap.time * 20) * 1.5;
    ctx.beginPath();
    ctx.arc(b.x + 6, b.y - C.BombRadius - 13, flick, 0, Math.PI * 2);
    ctx.fillStyle = "#ffce54";
    ctx.fill();
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
      ctx.fillStyle = "#ffe27a";
      ctx.fillText(snap.you.reveal.bombTime.toFixed(1) + "s", b.x, b.y + C.BombRadius + 22);
    } else if (b.publicRemaining != null) {
      // Opening public reveal window: same look as the Magnifying Glass,
      // but visible to everyone and follows the bomb around.
      ctx.font = "bold 17px monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffe27a";
      ctx.fillText(b.publicRemaining.toFixed(1) + "s", b.x, b.y + C.BombRadius + 22);
    }
  }

  function drawOverlays(ctx, snap) {
    const cx = C.WorldWidth / 2, cy = C.WorldHeight / 2;
    ctx.textAlign = "center";

    // Speed modifier badge, top-of-screen, matching the background tint.
    if (snap.bomb && snap.bomb.speedMult && snap.bomb.speedMult !== 1) {
      const fast = snap.bomb.speedMult > 1;
      ctx.font = "bold 18px sans-serif";
      ctx.fillStyle = fast ? "#ff8a6b" : "#7ec2ff";
      ctx.fillText(fast ? `⚡ SPEED x${snap.bomb.speedMult}` : `🐌 SPEED x${snap.bomb.speedMult}`, cx, 26);
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

    // Pass UI — only the current holder needs it.
    if (snap.you && snap.you.isHolder && snap.phase === "playing") {
      ctx.font = "bold 24px sans-serif";
      if (snap.bomb && snap.bomb.transferring) {
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
      dom.coinDisplay.innerHTML = `<span class="coin-icon">🪙</span>${you.coins}`;
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
            useBtn.textContent = `${i + 1}. ${Cards.TYPES[cardId].name}`;
            useBtn.disabled = !usable(i);
            if (hooks.armedSlot === i) useBtn.classList.add("armed");
            useBtn.onclick = () => hooks.useCard(i);
          } else {
            useBtn.textContent = `${i + 1}. —`;
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

      dom.btnDraw.disabled = !you.alive || you.coins < C.CardDrawCost || you.hand.length >= C.MaxHandSize;
      dom.btnDraw.textContent = `Draw Card (R) — ${C.CardDrawCost}c`;

      if (you.isHolder && snap.phase === "playing") {
        dom.btnPass.disabled = !you.canPass;
        dom.btnPass.textContent = (snap.bomb && snap.bomb.transferring) ? "Passing..."
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
      // Both hands are full holding the bomb — the holder can't wield a
      // thrown/fired weapon at the same time.
      if (kind === "projectile" && you.isHolder) return false;
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
    for (const p of d.players) {
      lines.push(`  ${p.name.padEnd(10)} ${p.state.padEnd(12)} coins=${String(p.coins).padEnd(4)} hand=[${p.hand.join(", ")}]`);
    }
    return lines.join("\n");
  }

  function fmt(v) { return v == null ? "-" : (typeof v === "number" ? v.toFixed(1) : String(v)); }

  function resetDomCache() {
    lastHandSig = null;
    lastEventSeq = 0;
  }

  return { draw, updateDom, resetDomCache };
})();
