# Countdown PvP — Multiplayer Bomb Passing Prototype

Implementation of `docs/prototype_plan.md`: a 2D top-down, Liar's-Bar-style PvP prototype.
All players sit **fixed in their seats around a table for the entire match** — there is no
movement, no HP, no combat system. The only physical interaction is mouse-controlled arms
moving the bomb, real 2D projectiles, and the coin → random card economy.

## Run

No build step, but WebRTC/PeerJS needs a real HTTP origin (not `file://`) plus internet
access to reach the public PeerJS signaling broker:

```
npx serve .
```

Open the printed URL, enter a name, click **Host Game**, and share the room code. Other
players open the same URL and **Join Game** with that code. You can also add bots in the
host lobby and play solo for testing.

## Controls

| Input | Effect |
| --- | --- |
| Mouse | Holding the bomb: drag your arms — the bomb follows, clamped to `BombArmReach` (dodge minus-time shots, catch repair shots, hide the bomb behind your body). Not holding: aim your next projectile card. |
| Hold/release left mouse after elimination | Hold for 2 seconds to charge the permanent Ghost Gun, then release at 100% to fire its -5 projectile. Aim is heavily slowed while held; there is no post-shot cooldown. |
| Space | Pass the bomb to the next alive player in seat order (once `PASS LOCK` reaches 0) |
| 1 / 2 / 3 (or click) | Use the card in that hand slot |
| R (or Draw button) | Draw a random card for `CardDrawCost` coins, up to `MaxHandSize` |

At the start of each bomb/round, the host rolls a new four-card draw pool shared
by everyone: Magnifying Glass, one attack card, one defense card, and one other
non-duplicate random card. The right-side codex shows the current round's pool.

## Architecture (host authoritative)

One browser (the host) runs the entire simulation; every other browser only sends inputs
(`{mouse, pass, draw, use}`) and renders the snapshot the host sends back. Clients never
decide hits, bomb time changes, deaths, or card draws.

- `js/config.js` — every tunable number from the plan (`BombArmReach`, `BaseMinimumHoldTime`,
  `MinimumBombTimeAfterReduction`, speed/shield/curse durations, coin rates, drop weights…).
  Nothing gameplay-relevant is hardcoded elsewhere.
- `js/cards.js` — the 10-card pool (Magnifying Glass, -1/-3/-5s Guns, +5/+10s Repair Kits,
  Speed Up / Slow Down Stopwatches, Shield, Curse) and the weighted `rollCard()`.
- `js/sim.js` — the authoritative state machine: bomb-time-pool draw → initial time reveal →
  3-2-1 → hidden timer → random holder → passing/cards/projectiles → explosion → elimination
  → next bomb → last survivor wins, plus `buildSnapshot()` (the only view clients ever get).
- `js/ai.js` — bots submit the same plain input shape a network client does.
- `js/net.js` — thin PeerJS wrapper (host claims a room-code peer id; per-peer sends so each
  client gets a tailored snapshot).
- `js/host.js` — fixed 60 Hz sim loop, merges local + bot + remote inputs, ~20 Hz snapshots.
- `js/client.js` — sends the local input buffer at ~30 Hz; never steps the sim.
- `js/render.js` — one canvas + DOM render path shared by host and clients, driven purely by
  the snapshot.
- `js/main.js` — menu → lobby → game wiring and input capture.

## Rules implemented (per the plan)

- **Fixed seating**: player world positions never change; only arms and the bomb move.
- **Hidden timer**: after the 3-2-1, the exact remaining time exists only in the host's sim.
  It is never sent to clients — the sole exception is inside the Magnifying Glass user's own
  snapshot while their private 3 s reveal is active.
- **Passing**: automatic to the next alive player in seat order (dead players skipped),
  gated by `BaseMinimumHoldTime` pass lock; Curse defers a `CurseMinimumHoldTime` lock onto
  the *next* receiver, then clears.
- **Bomb arm control**: the holder sends only a mouse position; the host computes the bomb
  offset and clamps it to `BombArmReach`. The bomb collider genuinely moves — it can dodge
  shots, catch repair kits, or hide behind the holder's body.
- **Projectiles**: every gun/repair card fires a real moving projectile (no hitscan). Walls
  and alive player bodies block it (no damage to players); only touching the bomb collider
  applies the time change, publicly announced as `-5 SEC` / `+10 SEC` without revealing the
  remaining time.
- **Time rules**: reductions clamp at `MinimumBombTimeAfterReduction` (never explode from a
  hit; natural countdown to 0 still does); no upper limit on bomb time.
- **Speed modifiers**: Speed Up ×2 / Slow Down ×0.5 override each other completely — no
  stacking of multipliers or durations.
- **Shield**: holder-only (card stays in hand otherwise); blocks only ±time projectile
  *effects* on the bomb (projectiles still vanish); does not block Speed, Curse, Magnify,
  passing, or the natural countdown.
- **Economy**: integer coins only; passive income for all alive players plus a separate
  holder bonus (risk vs reward); draws cost coins, capped at `MaxHandSize`, no charge when
  full; all cards single-use, consumed even on a miss.
- **Elimination**: the only death is holding the bomb at 0. Dead players lose coins and
  cards, but permanently gain a charge-to-fire Ghost Gun for the rest of the match. Its
  normal projectile can still disrupt the bomb for -5 seconds, while a two-second charge
  and heavily slowed held aim limit its pressure. Eliminated players always see the exact
  timers on the real bomb and every fake bomb. Last survivor wins; host can rematch (full
  reset, everyone back in their original seats).
- **Debug UI** (checkbox, dev only): exact bomb time, speed/shield/curse state, pass lock,
  passing order, every player's coins/hand, projectile states — never part of normal UI.

## Testing

The sim is UI-free, so its rules run headless (see the repo history for the check script:
phases, pass lock, income, draws, projectile hits, floor rule, shield, curse, speed
override, hidden-timer snapshot audit, elimination, match reset).

## Known prototype limits

- No reconnection/late-join once a match started (disconnected players are eliminated).
- No client-side interpolation — clients render the host's ~20 Hz snapshots directly.
- Uses the public PeerJS cloud broker for signaling, so internet access is required even
  for a same-machine test.
