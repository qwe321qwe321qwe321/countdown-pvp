"use strict";

// Shared deterministic aim model for the experimental hitscan mode. The host
// uses this exact wobble when resolving a ray, while every renderer uses it to
// draw the public sight line and local crosshair at the same angle.
const HitscanAim = (() => {
  const C = CONFIG;

  function gunCycleSeconds(def) {
    if (!def || def.amount >= 0) return 0;
    if (def.gunStyle === "semi") return C.Gun5Cooldown;
    if (def.gunStyle === "shotgun") return C.Gun3Cooldown;
    if (def.gunStyle === "auto") return C.Gun1FireInterval;
    return 0;
  }

  function cycleSeconds(cardId, playerCount) {
    if (cardId === "charged") {
      return C.ChargedShotChargeTime *
        Math.max(1, playerCount || 1) / C.ChargedShotBaselinePlayers;
    }
    return gunCycleSeconds(Cards.TYPES[cardId]);
  }

  function instabilityDegrees(cardId, playerCount) {
    const cycle = cycleSeconds(cardId, playerCount);
    if (!(cycle > 0)) return 0;
    return Math.min(C.HitscanWobbleMaxDegrees,
      C.HitscanWobbleBaseDegrees + cycle * C.HitscanWobblePerSecond);
  }

  function idPhase(id) {
    const text = String(id || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967296) * Math.PI * 2;
  }

  function wobbleRadians(playerId, time, instability) {
    if (!(instability > 0)) return 0;
    const phase = idPhase(playerId);
    const wave =
      Math.sin(time * 8.7 + phase) * 0.56 +
      Math.sin(time * 15.1 + phase * 1.71) * 0.29 +
      Math.sin(time * 23.9 + phase * 0.63) * 0.15;
    return wave * instability * Math.PI / 180;
  }

  function rotate(dx, dy, radians) {
    if (!radians) return { x: dx, y: dy };
    const cos = Math.cos(radians), sin = Math.sin(radians);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  return { instabilityDegrees, wobbleRadians, rotate };
})();
