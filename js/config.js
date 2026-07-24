"use strict";

// Every tunable gameplay number lives here — nothing gameplay-relevant is
// hardcoded in sim.js or elsewhere.
const CONFIG = {
  // ---- Match / bomb flow ----
  BombTimePoolOptions: [30, 60, 90, 120], // candidates the host can toggle in the lobby
  DefaultBombTimePool: [60, 90, 120],
  InitialTimeRevealDuration: 2.5,         // "BOMB TIME: Xs" shown before the countdown
  CountdownSeconds: 3,                    // the 3-2-1 before gameplay starts
  ExplosionTransitionDuration: 2.5,       // pause between explosion and next bomb

  // ---- Passing ----
  BaseMinimumHoldTime: 0,                 // no forced hold before an uncursed bomb can be passed again
  CurseMinimumHoldTime: 5.0,              // pass lock when receiving a cursed bomb
  BombPassSpeed: 300,                     // world units/sec the bomb travels while mid-pass between seats
  PublicTimeRevealDuration: 5.0,         // real seconds, right after gameplay starts, the timer is shown to everyone

  // ---- Speed modifiers (override, never stack) ----
  FastBombMultiplier: 2.0,
  FastBombDuration: 4.0,
  // 0 = full freeze: the bomb timer stops entirely, and while frozen the bomb
  // is also invincible — gun/repair hits that land on it during this window
  // are blocked with no time effect, same as Shield (see stepProjectiles).
  SlowBombMultiplier: 0,
  SlowBombDuration: 2.0,

  // ---- Shield / Curse / Magnifying Glass ----
  ShieldDuration: 5.0,
  RevealDuration: 3.0,                    // magnifying glass: how long the equipped window lasts
  MagnifyCastLength: 620,                 // box-cast length from the seat, along the aim direction
  MagnifyCastWidth: 36,                   // box-cast full width (perpendicular to the aim direction)

  // ---- Coin economy (integers only) ----
  // The rates below (interval/amount) are tuned for a 3-player match. Per-
  // player income is scaled down proportionally as the seat count rises
  // above that baseline, so total coin generation across the table stays
  // roughly constant instead of climbing with every extra player — see
  // Sim.coinIntervalScale(sim), applied to the *Interval fields at use time.
  CoinEconomyBaselinePlayers: 3,
  StartingCoins: 0,
  PassiveCoinInterval: 1,               // natural growth: 1 coin/s at the 3-player baseline
  PassiveCoinAmount: 1,
  BombHolderCoinInterval: 1.0,            // holder bonus stacks on top of passive income: +1 coin/s while holding = 2/s total, at baseline
  BombHolderCoinAmount: 1,
  BombHolderCoinDuration: 10.0,           // grace window per hold; past it the holder earns nothing at all (stalling penalty)

  // ---- Cards ----
  CardDrawCost: 5,
  MaxHandSize: 5,
  StartingHand: ["magnify", "gun5"],      // every player begins the match with these, for free
  // Three tiers: common utility at 10, the stronger swing cards (Freeze
  // Stopwatch / Grapple Claw / Reinforced Arm) rarer at 6, and Fake Bomb the
  // rarest of all at 3. Fake Bomb is additionally excluded from draws
  // entirely while bombs in play are at the cap (see Sim.tryDraw).
  CardDropWeights: {
    magnify: 8,
    gun1: 0,
    gun3: 0,
    gun5: 10,
    repair5: 8,
    repair10: 0,
    speedup: 10,
    slowdown: 6,
    shield: 0,
    curse: 0,
    grapple: 6,
    reinforced: 6,
    fakebomb: 3,
  },

  // ---- Geometry (world units = canvas pixels) ----
  WorldWidth: 960,
  WorldHeight: 640,
  TableRadius: 185,
  SeatDistance: 245,                      // seat center distance from table center
  PlayerBodyRadius: 24,
  BombRadius: 26,                         // 2x the original 13 — also grows the bomb's collider
  BombArmReach: 80,                       // max arm-controlled bomb offset from the seat
  BombArmMoveSpeed: 260,                  // world units/sec the bomb's arm-controlled offset can move — arm motion is not instant

  // ---- Projectiles ----
  ProjectileSpeed: 900,                   // world units/sec — tune this if shots feel too slow/fast
  ProjectileRadius: 5,
  MuzzleOffset: 32,                       // spawn distance from body center toward aim
  GunBurstCount: 3,                       // -Time Gun cards can be fired this many separate times per use
  AimLineLength: 520,                     // how far a wielded weapon's sight line reaches

  // ---- Grapple Claw ----
  GrappleFireSpeed: 2200,                 // fast outbound throw
  GrappleRetractSpeed: 260,               // normal-speed reel-in once it latches (same order as BombArmMoveSpeed)

  // ---- Reinforced Arm ----
  ReinforcedArmDuration: 5.0,
  ReinforcedArmSpeedMult: 2.0,

  // ---- Fake Bomb ----
  FakeBombMinDuration: 10,
  FakeBombMaxDuration: 30,
  FakeBombForcedPassLock: 1.0,            // short cooldown after a forced bounce so nobody instantly re-chains
  FakeBombRevealDuration: 3.0,            // the decoy's rolled timer is shown privately to its creator this long

  // ---- Explosion visuals ----
  // Mid-air detonation sequence (presentation only — the kill itself is
  // decided the instant the timer hits 0): the bomb freezes in place showing
  // "0.0s" for HoldDuration, then the blast ring expands for CatchUpDuration
  // until it touches the victim (who only *visually* dies at that moment),
  // then keeps expanding fast while fading out over FadeDuration.
  ExplosionHoldDuration: 0.5,             // frozen "0.0s" beat before the blast ring appears
  ExplosionRingCatchUpDuration: 0.4,      // seconds for the ring to reach the victim
  ExplosionRingExpandSpeed: 1100,         // world units/sec the ring keeps growing after the hit
  ExplosionRingFadeDuration: 0.45,        // seconds the post-hit ring takes to fade out

  // ---- Bots ----
  BotAimDuration: 0.35,                   // seconds a bot must hold its weapon raised & aimed before it actually fires
  BotAimJitter: 0.35,                     // extra random 0..this seconds added on top, so bots don't all fire in lockstep

  // ---- Session ----
  MaxPlayers: 8,
  TickRate: 60,                           // host simulation Hz
  SnapshotRate: 30,                       // host -> client state Hz (higher = fresher remote state, no delay tradeoff)
  InputSendRate: 60,                      // client -> host input Hz (fresher aim/mouse reaches the host sooner)
};
