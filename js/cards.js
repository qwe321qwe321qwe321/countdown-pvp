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

  // Every bomb/round gets its own four-card draw pool:
  //   Magnifying Glass (fixed) + one attack + one defense + one other card.
  // Zero-weight cards stay disabled even if they appear in a category below,
  // so CONFIG remains the switch that controls which variants are in use.
  const ROUND_ATTACK_IDS = [
    "gun1", "gun3", "gun5", "speedup", "reinforced", "grapple", "fakebomb",
  ];
  const ROUND_DEFENSE_IDS = ["slowdown", "repair5"];

  function randomFrom(ids) {
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function sameCardSet(a, b) {
    return !!a && a.length === b.length && a.every(id => b.includes(id));
  }

  function buildRoundPool() {
    const weights = CONFIG.CardDropWeights;
    const enabled = id => !!TYPES[id] && (weights[id] || 0) > 0;
    const attackIds = ROUND_ATTACK_IDS.filter(enabled);
    const defenseIds = ROUND_DEFENSE_IDS.filter(enabled);
    if (!enabled("magnify") || !attackIds.length || !defenseIds.length) {
      throw new Error("Round card pool needs Magnifying Glass plus an enabled attack and defense card");
    }

    const chosen = ["magnify", randomFrom(attackIds), randomFrom(defenseIds)];
    const randomIds = Object.keys(TYPES).filter(id => enabled(id) && !chosen.includes(id));
    if (!randomIds.length) {
      throw new Error("Round card pool needs a fourth enabled, non-duplicate card");
    }
    chosen.push(randomFrom(randomIds));
    return chosen;
  }

  // Re-roll at the start of every round. When the configured card set has
  // enough variety, avoid showing the exact same four-item set twice in a row.
  function rollRoundPool(previousPool) {
    let pool = buildRoundPool();
    for (let i = 0; previousPool && sameCardSet(pool, previousPool) && i < 24; i++) {
      pool = buildRoundPool();
    }
    if (previousPool && sameCardSet(pool, previousPool)) {
      const replacement = Object.keys(TYPES).find(id =>
        (CONFIG.CardDropWeights[id] || 0) > 0 &&
        !pool.slice(0, 3).includes(id) &&
        !previousPool.includes(id));
      if (replacement) pool[3] = replacement;
    }
    return pool;
  }

  // Weighted random draw over CONFIG.CardDropWeights. Host-only.
  // `excludeIds` drops cards from this roll entirely (e.g. Fake Bomb while
  // bombs in play are at the cap); `allowedIds` limits the roll to this
  // round's four-card pool. The remaining weights renormalize.
  function rollCard(excludeIds, allowedIds) {
    const weights = CONFIG.CardDropWeights;
    const ids = Object.keys(weights).filter(id =>
      weights[id] > 0 &&
      !(excludeIds && excludeIds.includes(id)) &&
      (!allowedIds || allowedIds.includes(id)));
    if (!ids.length) return null;
    const total = ids.reduce((s, id) => s + weights[id], 0);
    let r = Math.random() * total;
    for (const id of ids) {
      r -= weights[id];
      if (r <= 0) return id;
    }
    return ids[ids.length - 1];
  }

  return { TYPES, ROUND_ATTACK_IDS, ROUND_DEFENSE_IDS, rollRoundPool, rollCard };
})();
