"use strict";

// The initial card pool from the plan. Every special item is a card, obtained
// only through Coins -> random draw, and every card is single-use.
// kind: 'magnify' | 'projectile' | 'speed' | 'shield' | 'curse'
const Cards = (() => {
  const TYPES = {
    magnify:  { name: "Magnifying Glass", emoji: "🔍", kind: "magnify" },
    gun1:     { name: "-1s Gun",          emoji: "🔫", kind: "projectile", amount: -1 },
    gun3:     { name: "-3s Gun",          emoji: "🔥", kind: "projectile", amount: -3 },
    gun5:     { name: "-5s Gun",          emoji: "🔫", kind: "projectile", amount: -5 },
    repair5:  { name: "+5s Repair Kit",   emoji: "🧰", kind: "projectile", amount: +5 },
    repair10: { name: "+10s Repair Kit",  emoji: "🛠️", kind: "projectile", amount: +10 },
    speedup:  { name: "Speed Up Stopwatch",  emoji: "⏩", kind: "speed", mult: CONFIG.FastBombMultiplier, duration: CONFIG.FastBombDuration },
    slowdown: { name: "Freeze Stopwatch", emoji: "⏸️", kind: "speed", mult: CONFIG.SlowBombMultiplier, duration: CONFIG.SlowBombDuration },
    shield:   { name: "Shield", emoji: "🛡️", kind: "shield" },
    curse:    { name: "Curse",  emoji: "☠️", kind: "curse" },
  };

  // Weighted random draw over CONFIG.CardDropWeights. Host-only.
  function rollCard() {
    const weights = CONFIG.CardDropWeights;
    const ids = Object.keys(weights);
    const total = ids.reduce((s, id) => s + weights[id], 0);
    let r = Math.random() * total;
    for (const id of ids) {
      r -= weights[id];
      if (r <= 0) return id;
    }
    return ids[ids.length - 1];
  }

  return { TYPES, rollCard };
})();
