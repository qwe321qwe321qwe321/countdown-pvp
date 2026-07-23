// Simple bot: produces the same input shape a remote client would submit,
// so the sim treats human and AI identically.
function getAIInput(sim, p) {
  const inp = { moveX: 0, moveY: 0, aimX: p.aimX, aimY: p.aimY, shootMinus: false, shootPlus: false, shield: false };
  if (!p.alive || p.spectator || sim.match.state !== 'playing') return inp;

  const bomb = sim.bomb;
  const holding = bomb.holderId === p.id;
  const enemy = sim.players.find(o => o.id !== p.id && o.alive && !o.spectator);

  if (holding) {
    // Chase someone to pass the bomb.
    if (enemy) {
      const dx = enemy.x - p.x, dy = enemy.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      inp.moveX = dx / d; inp.moveY = dy / d;
    }

    // Arm control: find the most threatening incoming projectile and either
    // dodge the bomb away from it (minus) or reach out to catch it (plus).
    let best = null, bestT = Infinity;
    for (const pr of sim.projectiles) {
      const rx = bomb.x - pr.x, ry = bomb.y - pr.y;
      const spd = Math.hypot(pr.vx, pr.vy) || 1;
      const closing = (rx * pr.vx + ry * pr.vy) / spd; // >0 means heading toward the bomb
      const dist = Math.hypot(rx, ry);
      if (closing > 0 && dist < 320 && dist / spd < bestT) { best = pr; bestT = dist / spd; }
    }
    if (best) {
      const spd = Math.hypot(best.vx, best.vy) || 1;
      const dirX = best.vx / spd, dirY = best.vy / spd;
      if (best.type === 'plus') {
        // Reach the bomb toward the repair shot's path.
        inp.aimX = best.x + dirX * 40;
        inp.aimY = best.y + dirY * 40;
      } else {
        // Slide the bomb perpendicular to the shot's path, away from it.
        const perpX = -dirY, perpY = dirX;
        const side = (bomb.x - best.x) * perpX + (bomb.y - best.y) * perpY >= 0 ? 1 : -1;
        inp.aimX = p.x + perpX * side * CONFIG.BOMB_ARM_REACH;
        inp.aimY = p.y + perpY * side * CONFIG.BOMB_ARM_REACH;
        // Panic shield if it's about to connect.
        if (bestT < 0.25 && p.shieldCd <= 0) inp.shield = true;
      }
    } else {
      // Idle: keep the bomb held out toward the enemy (ready to pass).
      inp.aimX = enemy ? enemy.x : p.x;
      inp.aimY = enemy ? enemy.y : p.y - 40;
    }
  } else {
    // Keep midrange distance from the holder and shoot at the bomb.
    const holder = sim.players.find(o => o.id === bomb.holderId);
    const dx = holder.x - p.x, dy = holder.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const want = 260;
    const push = d > want + 40 ? 1 : (d < want - 40 ? -1 : 0);
    // Orbit + range-keeping.
    inp.moveX = (dx / d) * push + (-dy / d) * 0.6;
    inp.moveY = (dy / d) * push + (dx / d) * 0.6;

    // Lead the shot slightly with some spread.
    const spread = 24;
    inp.aimX = bomb.x + (Math.random() - 0.5) * spread;
    inp.aimY = bomb.y + (Math.random() - 0.5) * spread;
    if (p.shootCd <= 0 && Math.random() < 0.6) inp.shootMinus = true;
  }
  return inp;
}
