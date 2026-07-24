"use strict";

// The initial card pool from the plan. Every special item is a card, obtained
// only through Coins -> random draw, and every card is single-use.
// kind: 'magnify' | 'projectile' | 'speed' | 'shield' | 'curse' | 'grapple' |
//       'reinforced' | 'fakebomb' | 'blackout' | 'reverse'
const Cards = (() => {
  // `desc` feeds the in-game item codex panel; numbers are pulled from
  // CONFIG so the reference text can never drift from the actual rules.
  const TYPES = {
    magnify:  { name: "Magnifying Glass", emoji: "🔍", kind: "magnify",
      desc: `Sweep the beam over the bomb within ${CONFIG.RevealDuration}s to privately read its exact remaining time.` },
    gun1:     { name: "-1s Machine Gun",  emoji: "🔫", kind: "projectile", amount: -1, gunStyle: "auto",
      magazine: CONFIG.Gun1Magazine,
      desc: `Hold fire for up to ${CONFIG.Gun1Magazine} fast rounds; each hit removes 1s.` },
    gun3:     { name: "-3s Shotgun",      emoji: "🔥", kind: "projectile", amount: -3, gunStyle: "shotgun",
      magazine: CONFIG.Gun3Magazine,
      desc: `One shell sprays ${CONFIG.Gun3Pellets} pellets in a fan, with every hit removing 3s.` },
    gun5:     { name: "-5s Gun",          emoji: "🔫", kind: "projectile", amount: -5, gunStyle: "semi",
      magazine: CONFIG.Gun5Magazine,
      desc: `${CONFIG.Gun5Magazine} semi-auto rounds with a short cooldown; each hit removes 5s.` },
    repair5:  { name: "+3s Repair Kit",   emoji: "🧰", kind: "projectile", amount: +3,
      desc: "One throw; hitting the bomb adds 3s to its timer." },
    repair10: { name: "+10s Repair Kit",  emoji: "🛠️", kind: "projectile", amount: +10,
      desc: "One throw; hitting the bomb adds 10s to its timer." },
    speedup:  { name: "Speed Up Stopwatch",  emoji: "⏩", kind: "speed", mult: CONFIG.FastBombMultiplier, duration: CONFIG.FastBombDuration,
      desc: `The bomb burns ${CONFIG.FastBombMultiplier}x faster for ${CONFIG.FastBombDuration}s. New speed effects replace old ones.` },
    slowdown: { name: "Freeze Stopwatch", emoji: "⏸️", kind: "speed", mult: CONFIG.SlowBombMultiplier, duration: CONFIG.SlowBombDuration,
      desc: `Freezes the bomb timer for ${CONFIG.SlowBombDuration}s — and a frozen bomb is immune to every hit.` },
    shield:   { name: "Shield", emoji: "🛡️", kind: "shield",
      desc: `Create a ${CONFIG.BombArmReach}-unit personal bubble that blocks projectiles and Magnifying Glass readings for ${CONFIG.ShieldDuration}s.` },
    curse:    { name: "Curse",  emoji: "☠️", kind: "curse",
      desc: `The next player to receive the bomb is locked from passing for ${CONFIG.CurseMinimumHoldTime}s.` },
    grapple:    { name: "Grapple Claw",   emoji: "🧲", kind: "grapple",
      desc: "Fire a claw at the bomb — wherever it is, even mid-pass — and reel it in to yourself." },
    reinforced: { name: "Reinforced Arm", emoji: "🦾", kind: "reinforced",
      desc: `For ${CONFIG.ReinforcedArmDuration}s: pass to whoever you aim at (any seat) and your passes fly ${CONFIG.ReinforcedArmSpeedMult}x faster.` },
    fakebomb:   { name: "Fake Bomb",      emoji: "🎭", kind: "fakebomb",
      desc: `Pull out a decoy only you know is fake — its timer is shown to you alone for ${CONFIG.FakeBombRevealDuration}s. It's held, passed, shot and grappled exactly like the real bomb, but pops harmlessly. Needs free hands.` },
    blackout:   { name: "Lights Out", emoji: "🌑", kind: "blackout",
      desc: `Black out the table for ${CONFIG.BlackoutDuration}s. Everyone keeps a small personal vision circle; an active Magnifying Glass also acts as a flashlight.` },
    reverse:    { name: "Reverse", emoji: "🔄", kind: "reverse",
      desc: "Toggle the global bomb-passing direction. Using it twice restores the original order; every new round resets it." },
    reroll:     { name: "Reroll All", emoji: "🎲", kind: "reroll",
      desc: "Pay to replace all three Roguelike shop choices." },
  };

  // Every bomb/round gets its own four-card draw pool:
  //   Magnifying Glass (fixed) + one attack + one defense + one other card.
  // Zero-weight cards stay disabled even if they appear in a category below,
  // so CONFIG remains the switch that controls which variants are in use.
  const ROUND_ATTACK_IDS = [
    "gun1", "gun3", "gun5", "speedup", "reinforced", "grapple", "fakebomb", "blackout",
  ];
  const ROUND_DEFENSE_IDS = ["slowdown", "repair5", "shield", "reverse"];

  function randomFrom(ids) {
    return ids[Math.floor(Math.random() * ids.length)];
  }

  // Prefer cards that have not appeared in any earlier round of this match.
  // This is deliberately a soft exclusion: once a role has exhausted all of
  // its unseen options, it falls back to the full eligible list so every
  // round can still satisfy the attack/defense pool rules.
  function randomPreferUnseen(ids, seenIds) {
    if (!seenIds || !seenIds.length) return randomFrom(ids);
    const unseen = ids.filter(id => !seenIds.includes(id));
    return randomFrom(unseen.length ? unseen : ids);
  }

  function sameCardSet(a, b) {
    return !!a && a.length === b.length && a.every(id => b.includes(id));
  }

  function buildRoundPool(bannedIds, seenIds) {
    const weights = CONFIG.CardDropWeights;
    const enabled = id => !!TYPES[id] && (weights[id] || 0) > 0 &&
      !(bannedIds && bannedIds.includes(id));
    const attackIds = ROUND_ATTACK_IDS.filter(enabled);
    const defenseIds = ROUND_DEFENSE_IDS.filter(enabled);
    if (!enabled("magnify") || !attackIds.length || !defenseIds.length) {
      throw new Error("Round card pool needs Magnifying Glass plus an enabled attack and defense card");
    }

    const chosen = [
      "magnify",
      randomPreferUnseen(attackIds, seenIds),
      randomPreferUnseen(defenseIds, seenIds),
    ];
    const randomIds = Object.keys(TYPES).filter(id => enabled(id) && !chosen.includes(id));
    if (!randomIds.length) {
      throw new Error("Round card pool needs a fourth enabled, non-duplicate card");
    }
    chosen.push(randomPreferUnseen(randomIds, seenIds));
    return chosen;
  }

  // Re-roll at the start of every round. When the configured card set has
  // enough variety, prefer cards that have not appeared earlier in the match
  // and avoid showing the exact same four-item set twice in a row.
  function rollRoundPool(previousPool, bannedIds, seenIds) {
    let pool = buildRoundPool(bannedIds, seenIds);
    for (let i = 0; previousPool && sameCardSet(pool, previousPool) && i < 24; i++) {
      pool = buildRoundPool(bannedIds, seenIds);
    }
    if (previousPool && sameCardSet(pool, previousPool)) {
      const replacements = Object.keys(TYPES).filter(id =>
        (CONFIG.CardDropWeights[id] || 0) > 0 &&
        !(bannedIds && bannedIds.includes(id)) &&
        !pool.slice(0, 3).includes(id) &&
        !previousPool.includes(id));
      if (replacements.length) pool[3] = randomPreferUnseen(replacements, seenIds);
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

  function enabledCardIds(excludeIds) {
    return Object.keys(CONFIG.CardDropWeights).filter(id =>
      CONFIG.CardDropWeights[id] > 0 &&
      TYPES[id] &&
      !(excludeIds && excludeIds.includes(id)));
  }

  // Generic weighted pool used by modes that deliberately bypass the
  // Magnify/Attack/Defense/Round-Pool structure.
  function rollAnyPool(count, previousPool, excludeIds) {
    const result = [];
    const blocked = new Set(excludeIds || []);
    for (let i = 0; i < count; i++) {
      const id = rollCard([...blocked], null);
      if (!id) break;
      result.push(id);
      blocked.add(id);
    }
    if (previousPool && result.length > 1 && sameCardSet(result, previousPool)) {
      const replacement = rollCard([...blocked, ...previousPool.slice(0, -1)], null);
      if (replacement) result[result.length - 1] = replacement;
    }
    return result;
  }

  return {
    TYPES, ROUND_ATTACK_IDS, ROUND_DEFENSE_IDS,
    rollRoundPool, rollAnyPool, rollCard, enabledCardIds,
  };
})();
