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
  BombPassSpeedCap: 900,                  // hard cap across reinforced throws and chained parries
  ParryPunishWindow: 0.35,                // local-only no-press window immediately before the parry window
  ParryWindow: 0.20,                      // local-only SPACE timing window at the end of an incoming pass
  ParrySpeedMultiplier: 1.5,              // successful returns multiply the exact incoming travel speed
  ParryResultGrace: 5.0,                  // host accepts a locally judged result this long after arrival
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
  // player income is scaled down proportionally as the number of *living*
  // players rises above that baseline, so total coin generation across the
  // table stays roughly constant instead of climbing with every extra player.
  // Because it tracks the current alive count (not the fixed seat count), the
  // rate speeds up as players die and the table thins — see
  // Sim.coinIntervalScale(sim), applied to the *Interval fields at use time.
  CoinEconomyBaselinePlayers: 3,
  StartingCoins: 0,
  PassiveCoinInterval: 1,               // natural growth: 1 coin/s at the 3-player baseline
  PassiveCoinAmount: 1,
  // Farming the bomb (pot accrual, cashed out on throw) is a flat 2 coins/s
  // for everyone — unlike passive income it does NOT scale with seat count.
  BombHolderCoinInterval: 0.5,
  BombHolderCoinAmount: 1,
  BombHolderPotCap: 10,                   // pot stops growing once it hits this, even if held longer
  BombBulletCoinLoss: 2,                  // each damaging hit steals this much from the real bomb's pot
  CoinStealEffectDuration: 0.9,
  BombHolderCoinDuration: 10.0,           // grace window per hold; past it the holder earns nothing at all (stalling penalty)

  // ---- Cards ----
  CardDrawCost: 5,
  ShopRerollCost: 5,
  RoguelikeChoiceCount: 3,
  MaxHandSize: 5,
  StartingHand: ["magnify"],              // the opening round's attack card is added after its pool is rolled
  // Three tiers: common utility at 10, the stronger swing cards (Freeze
  // Stopwatch / Grapple Claw / Reinforced Arm) rarer at 6, and Fake Bomb the
  // rarest of all at 3. Fake Bomb is additionally excluded from automatic
  // purchases while bombs in play are at the cap.
  CardDropWeights: {
    magnify: 8,
    gun1: 10,
    gun3: 10,
    gun5: 10,
    repair5: 8,
    repair10: 0,
    speedup: 10,
    slowdown: 6,
    shield: 0,                            // temporarily disabled
    curse: 0,
    grapple: 8,
    reinforced: 6,
    fakebomb: 3,
    blackout: 0,                          // temporarily disabled
    reverse: 7,
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
  ProjectileSpeed: 1450,                  // firearm rounds are deliberately much faster than charged sling shots
  ChargedProjectileSpeed: 760,             // full two-second charge speed
  ChargedProjectileMinSpeedMultiplier: 1 / 3, // one-second release starts at one-third speed
  ProjectileRadius: 5,
  MuzzleOffset: 32,                       // spawn distance from body center toward aim
  Gun5Magazine: 3,                        // semi-auto: three individually aimed rounds
  Gun5Cooldown: 0.28,
  Gun3Magazine: 1,                        // shotgun: one trigger pull
  Gun3Pellets: 3,
  Gun3SpreadDegrees: 13,
  Gun3Cooldown: 0.5,
  Gun1Magazine: 10,                       // automatic: hold primary fire
  Gun1FireInterval: 0.09,
  AimLineLength: 520,                     // how far a wielded weapon's sight line reaches

  // ---- Experimental wobbly hitscan ----
  // Firearms and the universal charged shot become instantaneous rays. Their
  // original time between shots determines how unstable they are: slower
  // weapons visibly wander farther and also receive a wider per-shot error.
  HitscanWobbleBaseDegrees: 1.5,
  HitscanWobblePerSecond: 20,
  HitscanWobbleMaxDegrees: 18,
  HitscanRandomSpreadMultiplier: 0.45,
  HitscanTrailDuration: 0.22,
  HitscanTrailMaxCount: 96,

  // ---- Universal charged sling shot ----
  ChargedShotMinimumChargeTime: 1.0,        // release before this cancels; at this point the shot is one-third speed
  ChargedShotChargeTime: 2.0,               // full charge reaches ChargedProjectileSpeed
  ChargedShotBaselinePlayers: 4,             // charge times scale linearly from this player count
  ChargedShotAmount: -3,
  ChargedShotAimSpeed: 150,                // world units/sec while primary fire is held (deliberately sluggish)

  // ---- Holder taunt / farming ----
  TauntFarmMultiplier: 2.0,                // holding primary fire doubles pot accrual while the pose is maintained

  // ---- Global round effects ----
  BlackoutDuration: 3.0,
  BlackoutFadeDuration: 0.35,
  BlackoutVisionRadius: 95,                // close to BombArmReach, with a little room for the body
  DeadGlobalItemIds: ["speedup", "slowdown", "reverse"],

  // ---- Grapple Claw ----
  GrappleFireSpeed: 3200,                 // fast outbound throw
  GrappleRetractSpeed: 260,               // normal-speed reel-in once it latches (same order as BombArmMoveSpeed)

  // ---- Reinforced Arm ----
  ReinforcedArmDuration: 5.0,
  ReinforcedArmSpeedMult: 2.0,

  // ---- Fake Bomb ----
  FakeBombMinDuration: 10,
  FakeBombMaxDuration: 30,
  FakeBombForcedPassLock: 1.0,            // short cooldown after a forced bounce so nobody instantly re-chains
  FakeBombRevealDuration: 3.0,            // the decoy's rolled timer is shown privately to its creator this long
  FakeBombNearestReward: 10,               // fixed reward paid to the closest living player when the decoy pops
  FakeBombBurstDuration: 1.25,

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
  BotProjectileAwarenessTime: 0.65,       // only shots predicted to arrive this soon are noticed
  BotProjectileNoticeChance: 0.55,        // bots sometimes fail to notice a threatening shot entirely
  BotDodgeReactionMin: 0.28,              // human-like delay between noticing a shot and moving the bomb
  BotDodgeReactionJitter: 0.30,
  BotDodgeAimError: 24,                   // imperfect sideways dodge target, in world units
  BotParryChance: 0.08,                   // ordinary bots should only very rarely attempt a parry
  BotParryMaxIncomingSpeed: 600,           // faster throws are outside a bot's plausible reaction limit
  BotKnownBombPanicTime: 5.0,             // recently observed low timer => pass at first legal instant
  BotSlingUseChance: 0.35,                // chance to choose the universal sling over a ready card

  // ---- Teams ----
  TeamCountOptions: [1, 2, 3, 4],          // 1 = no teams (free-for-all)
  DefaultTeamCount: 1,

  // ---- Session ----
  MaxPlayers: 8,
  TickRate: 60,                           // host simulation Hz
  SnapshotRate: 30,                       // host -> client state Hz (higher = fresher remote state, no delay tradeoff)
  InputSendRate: 60,                      // client -> host input Hz (fresher aim/mouse reaches the host sooner)
};
