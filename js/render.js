// Canvas renderer. Reads sim state only — never mutates it.
function render(ctx, sim) {
  const W = CONFIG.ARENA_W, H = CONFIG.ARENA_H;
  ctx.clearRect(0, 0, W, H);

  // Floor grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Walls
  for (const w of sim.walls) {
    ctx.fillStyle = '#39404e';
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = '#4d566a';
    ctx.lineWidth = 2;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  }

  const bomb = sim.bomb;
  const holder = sim.players.find(p => p.id === bomb.holderId);

  // BombArmReach ring around the holder (the controllable area)
  if (sim.match.state === 'playing' && holder.alive) {
    ctx.beginPath();
    ctx.arc(holder.x, holder.y, CONFIG.BOMB_ARM_REACH + CONFIG.BOMB_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Players
  for (const p of sim.players) {
    const ghost = !p.alive || p.spectator;
    ctx.globalAlpha = ghost ? 0.25 : 1;

    // Body
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Arms + bomb belong to the holder
    if (!ghost && p.id === bomb.holderId && sim.match.state === 'playing') {
      drawArmsAndBomb(ctx, sim, p);
    } else if (!ghost) {
      // Non-holder: small aim indicator hands
      let dx = p.aimX - p.x, dy = p.aimY - p.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      for (const side of [-1, 1]) {
        const px = -dy * side, py = dx * side;
        ctx.beginPath();
        ctx.arc(p.x + dx * 10 + px * p.radius * 0.75, p.y + dy * 10 + py * p.radius * 0.75, 5, 0, Math.PI * 2);
        ctx.fillStyle = shade(p.color, -20);
        ctx.fill();
      }
    }

    // Name + status
    ctx.globalAlpha = 1;
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = ghost ? '#8b93a1' : '#e8e8e8';
    ctx.fillText(p.name + (ghost ? ' (SPECTATOR)' : ''), p.x, p.y - p.radius - 26);
  }
  ctx.globalAlpha = 1;

  // Projectiles
  for (const pr of sim.projectiles) {
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, pr.radius, 0, Math.PI * 2);
    ctx.fillStyle = pr.type === 'minus' ? '#ff5d5d' : '#5dff8a';
    ctx.fill();
    // Motion streak
    const spd = Math.hypot(pr.vx, pr.vy) || 1;
    ctx.strokeStyle = pr.type === 'minus' ? 'rgba(255,93,93,0.35)' : 'rgba(93,255,138,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pr.x, pr.y);
    ctx.lineTo(pr.x - (pr.vx / spd) * 16, pr.y - (pr.vy / spd) * 16);
    ctx.stroke();
  }

  // FX
  for (const f of sim.fx) {
    const a = 1 - f.t;
    if (f.kind === 'poof') {
      ctx.beginPath();
      ctx.arc(f.x, f.y, 4 + f.t * 14, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(200,200,200,${a * 0.6})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (f.kind === 'explosion') {
      ctx.beginPath();
      ctx.arc(f.x, f.y, 10 + f.t * 120, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,160,60,${a})`;
      ctx.lineWidth = 8 * a + 1;
      ctx.stroke();
    } else if (f.kind === 'shield-block') {
      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(120,220,255,${a})`;
      ctx.fillText(f.text, f.x, f.y - f.t * 24);
    } else if (f.kind === 'text') {
      ctx.font = 'bold 15px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,235,140,${a})`;
      ctx.fillText(f.text, f.x, f.y - f.t * 28);
    }
  }

  drawHUD(ctx, sim);
}

function drawArmsAndBomb(ctx, sim, p) {
  const bomb = sim.bomb;
  let dx = bomb.x - p.x, dy = bomb.y - p.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  const perpX = -dy, perpY = dx;

  // Two-segment arms: shoulder -> elbow (bowed outward) -> hand on the bomb's side.
  for (const side of [-1, 1]) {
    const sx = p.x + perpX * side * p.radius * 0.8 + dx * p.radius * 0.3;
    const sy = p.y + perpY * side * p.radius * 0.8 + dy * p.radius * 0.3;
    const hx = bomb.x + perpX * side * bomb.radius * 0.85;
    const hy = bomb.y + perpY * side * bomb.radius * 0.85;
    const ex = (sx + hx) / 2 + perpX * side * 10;
    const ey = (sy + hy) / 2 + perpY * side * 10;

    ctx.strokeStyle = shade(p.color, -35);
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    // Hand
    ctx.beginPath();
    ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = shade(p.color, -15);
    ctx.fill();
  }

  // Bomb
  ctx.beginPath();
  ctx.arc(bomb.x, bomb.y, bomb.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#22252c';
  ctx.fill();
  ctx.strokeStyle = '#555c69';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fuse spark
  const sparkA = 0.5 + 0.5 * Math.sin(sim.time * 12);
  ctx.beginPath();
  ctx.arc(bomb.x + bomb.radius * 0.5, bomb.y - bomb.radius * 0.9, 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,${140 + sparkA * 100},60,${0.6 + sparkA * 0.4})`;
  ctx.fill();

  // Timer on the bomb — red when low
  const low = bomb.timer <= 5;
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = low ? '#ff6a6a' : '#ffd76a';
  ctx.fillText(Math.ceil(bomb.timer), bomb.x, bomb.y + 4);

  // Shield ring around the bomb collider only
  if (p.shieldTimer > 0) {
    ctx.beginPath();
    ctx.arc(bomb.x, bomb.y, bomb.radius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(120,220,255,${0.5 + 0.5 * Math.sin(sim.time * 20)})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function drawHUD(ctx, sim) {
  const bomb = sim.bomb;
  const holder = sim.players.find(p => p.id === bomb.holderId);

  // Big timer top-center
  ctx.font = 'bold 30px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = bomb.timer <= 5 ? '#ff6a6a' : '#e8e8e8';
  ctx.fillText(bomb.timer.toFixed(1), CONFIG.ARENA_W / 2, 40);
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillStyle = '#9aa4b2';
  ctx.fillText('ROUND ' + sim.round + '  ·  bomb: ' + holder.name, CONFIG.ARENA_W / 2, 58);

  // Player panels
  sim.players.forEach((p, i) => {
    const x = i === 0 ? 14 : CONFIG.ARENA_W - 190;
    const y = 14;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, y, 176, 74);
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px "Segoe UI", sans-serif';
    ctx.fillStyle = p.color;
    ctx.fillText(p.name + '  ·  wins ' + p.wins, x + 10, y + 20);
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillStyle = p.spectator ? '#8b93a1' : '#e8e8e8';
    if (p.spectator) {
      ctx.fillText('SPECTATOR', x + 10, y + 42);
    } else {
      ctx.fillText('Coins: ' + p.coins + '   Cards: ' + '🂠'.repeat(p.cards.length) + (p.cards.length === 0 ? '—' : ''), x + 10, y + 42);
      const shieldTxt = p.shieldTimer > 0 ? 'ACTIVE' : (p.shieldCd > 0 ? p.shieldCd.toFixed(1) + 's' : 'READY');
      ctx.fillStyle = p.shieldTimer > 0 ? '#78dcff' : (p.shieldCd > 0 ? '#8b93a1' : '#9fe8b0');
      ctx.fillText('Shield: ' + shieldTxt, x + 10, y + 62);
    }
  });

  // Round-over banner
  if (sim.match.state === 'roundover') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, CONFIG.ARENA_H / 2 - 60, CONFIG.ARENA_W, 120);
    ctx.font = 'bold 28px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd76a';
    ctx.fillText(sim.match.message, CONFIG.ARENA_W / 2, CONFIG.ARENA_H / 2 - 6);
    ctx.font = '15px "Segoe UI", sans-serif';
    ctx.fillStyle = '#c6cdd6';
    ctx.fillText('Next round in ' + Math.ceil(sim.match.timer) + '…', CONFIG.ARENA_W / 2, CONFIG.ARENA_H / 2 + 28);
  }
}

// Simple hex shade helper for arm/hand tints.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
