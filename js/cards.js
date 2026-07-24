"use strict";

// The initial card pool from the plan. Every special item is a card, obtained
// only through Coins -> random draw, and every card is single-use.
// kind: 'magnify' | 'projectile' | 'speed' | 'shield' | 'curse' | 'grapple' |
//       'reinforced' | 'fakebomb'
const Cards = (() => {
  // `desc` feeds the in-game item codex panel; numbers are pulled from
  // CONFIG so the reference text can never drift from the actual rules.
  const TYPES = {
    magnify:  { name: "Magnifying Glass", emoji: "🔍", kind: "magnify",
      desc: `Sweep the beam over the bomb within ${CONFIG.RevealDuration}s to privately read its exact remaining time.` },
    gun1:     { name: "-1s Gun",          emoji: "🔫", kind: "projectile", amount: -1,
      desc: `${CONFIG.GunBurstCount} shots; each hit removes 1s from the bomb.` },
    gun3:     { name: "-3s Gun",          emoji: "🔥", kind: "projectile", amount: -3,
      desc: `${CONFIG.GunBurstCount} shots; each hit removes 3s from the bomb.` },
    gun5:     { name: "-5s Gun",          emoji: "🔫", kind: "projectile", amount: -5,
      desc: `${CONFIG.GunBurstCount} shots; each hit removes 5s from the bomb. Bodies block shots — it can even detonate the bomb outright.` },
    repair5:  { name: "+5s Repair Kit",   emoji: "🧰", kind: "projectile", amount: +5,
      desc: "One throw; hitting the bomb adds 5s to its timer." },
    repair10: { name: "+10s Repair Kit",  emoji: "🛠️", kind: "projectile", amount: +10,
      desc: "One throw; hitting the bomb adds 10s to its timer." },
    speedup:  { name: "Speed Up Stopwatch",  emoji: "⏩", kind: "speed", mult: CONFIG.FastBombMultiplier, duration: CONFIG.FastBombDuration,
      desc: `The bomb burns ${CONFIG.FastBombMultiplier}x faster for ${CONFIG.FastBombDuration}s. New speed effects replace old ones.` },
    slowdown: { name: "Freeze Stopwatch", emoji: "⏸️", kind: "speed", mult: CONFIG.SlowBombMultiplier, duration: CONFIG.SlowBombDuration,
      desc: `Freezes the bomb timer for ${CONFIG.SlowBombDuration}s — and a frozen bomb is immune to every hit.` },
    shield:   { name: "Shield", emoji: "🛡️", kind: "shield",
      desc: `Holder only: blocks anything hitting the bomb for ${CONFIG.ShieldDuration}s.` },
    curse:    { name: "Curse",  emoji: "☠️", kind: "curse",
      desc: `The next player to receive the bomb is locked from passing for ${CONFIG.CurseMinimumHoldTime}s.` },
    grapple:    { name: "Grapple Claw",   emoji: "🧲", kind: "grapple",
      desc: "Fire a claw at the bomb — wherever it is, even mid-pass — and reel it in to yourself." },
    reinforced: { name: "Reinforced Arm", emoji: "🦾", kind: "reinforced",
      desc: `For ${CONFIG.ReinforcedArmDuration}s: pass to whoever you aim at (any seat) and your passes fly ${CONFIG.ReinforcedArmSpeedMult}x faster.` },
    fakebomb:   { name: "Fake Bomb",      emoji: "🎭", kind: "fakebomb",
      desc: `Pull out a decoy only you know is fake — its timer is shown to you alone for ${CONFIG.FakeBombRevealDuration}s. It's held, passed, shot and grappled exactly like the real bomb, but pops harmlessly. Needs free hands.` },
  };

  // Weighted random draw over CONFIG.CardDropWeights. Host-only.
  // `excludeIds` drops cards from this roll entirely (e.g. Fake Bomb while
  // bombs in play are at the cap) — the remaining weights renormalize.
  function rollCard(excludeIds) {
    const weights = CONFIG.CardDropWeights;
    const ids = Object.keys(weights).filter(id =>
      weights[id] > 0 && !(excludeIds && excludeIds.includes(id)));
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
