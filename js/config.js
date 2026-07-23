// All gameplay tunables in one place.
const CONFIG = {
  ARENA_W: 960,
  ARENA_H: 640,

  PLAYER_RADIUS: 18,
  PLAYER_SPEED: 230,

  // --- Bomb / arm control ---
  BOMB_RADIUS: 14,
  BOMB_ARM_REACH: 80,       // BombArmReach: max distance the bomb can extend from the holder's center
  BOMB_MIN_DIST: 22,        // bomb can't be pulled inside the body
  BOMB_FOLLOW_RATE: 14,     // how quickly the bomb offset tracks the mouse (1/s, exponential)
  BOMB_START_TIME: 30,      // seconds on the fuse at round start
  TRANSFER_COOLDOWN: 1.0,   // seconds before the bomb can change hands again

  // --- Projectiles ---
  PROJ_SPEED: 430,
  PROJ_RADIUS: 6,
  PROJ_MINUS_EFFECT: -5,    // seconds applied to bomb timer
  PROJ_PLUS_EFFECT: +10,
  SHOOT_COOLDOWN: 0.7,

  // --- Shield (bomb collider only) ---
  SHIELD_DURATION: 1.2,
  SHIELD_COOLDOWN: 5.0,

  // --- Economy (minimal; exists to demonstrate death cleanup) ---
  COIN_INTERVAL: 1.0,       // +1 coin per interval while alive
  CARD_INTERVAL: 8.0,       // draw a card per interval while alive
  MAX_CARDS: 3,

  // --- Match flow ---
  INTERMISSION: 3.0,        // seconds between rounds
};
