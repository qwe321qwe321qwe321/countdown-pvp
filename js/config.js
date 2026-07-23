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
  BaseMinimumHoldTime: 1.0,               // pass lock after receiving the bomb
  CurseMinimumHoldTime: 5.0,              // pass lock when receiving a cursed bomb

  // ---- Bomb time modification ----
  MinimumBombTimeAfterReduction: 1.0,     // -Time hits can never drop the bomb below this

  // ---- Speed modifiers (override, never stack) ----
  FastBombMultiplier: 2.0,
  FastBombDuration: 4.0,
  SlowBombMultiplier: 0.5,
  SlowBombDuration: 4.0,

  // ---- Shield / Curse / Magnifying Glass ----
  ShieldDuration: 5.0,
  RevealDuration: 3.0,                    // magnifying glass private timer reveal

  // ---- Coin economy (integers only) ----
  StartingCoins: 0,
  PassiveCoinInterval: 3.0,
  PassiveCoinAmount: 1,
  BombHolderCoinInterval: 1.0,
  BombHolderCoinAmount: 1,
  BombHolderCoinDuration: 10.0,           // holder bonus only accrues for this long per hold

  // ---- Cards ----
  CardDrawCost: 5,
  MaxHandSize: 5,
  CardDropWeights: {
    magnify: 10,
    gun1: 0,
    gun3: 0,
    gun5: 10,
    repair5: 10,
    repair10: 0,
    speedup: 10,
    slowdown: 10,
    shield: 0,
    curse: 0,
  },

  // ---- Geometry (world units = canvas pixels) ----
  WorldWidth: 960,
  WorldHeight: 640,
  TableRadius: 185,
  SeatDistance: 245,                      // seat center distance from table center
  PlayerBodyRadius: 24,
  BombRadius: 13,
  BombArmReach: 80,                       // max arm-controlled bomb offset from the seat

  // ---- Projectiles ----
  ProjectileSpeed: 380,
  ProjectileRadius: 5,
  MuzzleOffset: 32,                       // spawn distance from body center toward aim
  GunBurstCount: 3,                       // -Time Gun cards fire this many bullets per use
  GunBurstSpreadDeg: 10,                  // total spread angle across the burst

  // ---- Session ----
  MaxPlayers: 8,
  TickRate: 60,                           // host simulation Hz
  SnapshotRate: 20,                       // host -> client state Hz
  InputSendRate: 30,                      // client -> host input Hz
};
