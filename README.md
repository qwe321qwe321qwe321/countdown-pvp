# Countdown PvP — Prototype

Playable prototype of the bomb arm-control rules in `docs/prototype_plan.md`.
Top-down 2D hot-potato: whoever holds the bomb when the timer hits 0 explodes.

## Run

No build step. Open `index.html` in a browser, or serve the folder:

```
npx serve .
```

## Controls

| Input | Holding the bomb | Not holding |
| --- | --- | --- |
| WASD / arrows | Move | Move |
| Mouse | Drag your arms — the bomb follows your hands, clamped to `BombArmReach` | Aim |
| Left click | — | Fire −5s projectile |
| Right click | — | Fire +10s repair projectile |
| Space | Shield (bomb collider only, short duration + cooldown) | — |

Touch the current holder to take the bomb (short transfer cooldown).

## Implemented rules (from the plan)

- **Arm control**: the bomb's position = player world position + a mouse-controlled
  local offset, clamped to `BOMB_ARM_REACH` (`js/config.js`). The whole reach area
  moves with the player. Two-segment arms visually connect body → hands → bomb.
- **Gameplay collider**: the bomb collider is at the bomb's controlled position, so
  the holder can dodge −5s shots or reach out to catch +10s repairs. Arms have no
  collision.
- **Projectiles**: real moving projectiles that vanish on the first blocking thing —
  walls, arena edge, player bodies (no damage/effect), or the bomb (effect applies).
  Standing in the shot's path genuinely body-blocks it.
- **Shield**: bomb-collider-only; blocked projectiles still vanish, no time effect.
- **Death cleanup**: on explosion the holder's coins are zeroed and unused cards
  cleared; they become a spectator (no movement, shooting, earning, or blocking)
  until the next round starts.
- **Host authority (structure)**: all state changes go through `stepSim(sim, inputs, dt)`
  in `js/sim.js`. Human and AI inputs are the same plain-data shape a network client
  would submit, so hit/dodge results are decided by the sim, never by an input source.
  Actual netcode is not included in this prototype.

## Files

- `js/config.js` — all tunables (`BOMB_ARM_REACH`, timers, cooldowns…)
- `js/sim.js` — authoritative simulation (state + `stepSim`)
- `js/ai.js` — bot that submits inputs like a client would (it dodges with its arms
  and shields in a panic, so the mechanic is demonstrated on both sides)
- `js/render.js` — canvas drawing + HUD
- `js/main.js` — input collection and fixed-timestep loop

Coins/cards are minimal (passive accrual, no card effects yet) — they exist to
demonstrate the death-cleanup rule.
