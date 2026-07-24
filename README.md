# Countdown PvP — Multiplayer Bomb Passing Prototype

Implementation of `docs/prototype_plan.md`: a 2D top-down, Liar's-Bar-style PvP prototype.
All players sit **fixed in their seats around a table for the entire match** — there is no
movement or HP. The physical interaction is mouse-controlled arms moving the bomb,
real 2D projectiles (or optional unstable hitscan), a charged sling shot, and
an automatic coin → card economy.

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
| Mouse | Holding the bomb: drag your arms. Hold left mouse to taunt, lock arm control/passing, and farm the pot at 2× speed. With free hands: hold/release to charge and launch a slower -3s sling shot. |
| Space | Pass while holding; on an incoming pass, avoid the punish window and press in the parry window to return it at 1.5× incoming travel speed |
| 1 / 2 / 3 (or click) | Use the card in that hand slot |
| 4 (Roguelike Shop) | Pay to reroll all three choices |
| Q after elimination | Use your one randomly assigned global item for the round |

Cards are bought automatically whenever an alive player has at least `CardDrawCost`
coins and an empty hand slot. At the start of each bomb/round, the host rolls a four-card shop pool shared
by everyone: Magnifying Glass, one attack card, one defense card, and one other
non-duplicate random card. The right-side codex shows the current round's pool.
Each player opens with a Magnifying Glass and that opening pool's attack card.

The host lobby also exposes several experimental switches:

- **Public seconds** keeps every lethal/decoy timer visible and removes the
  Magnifying Glass from starting hands and card rolls. This mode exclusively
  adds the Electronic Shock Gun: its wide, stable hitscan pulse makes a real
  or fake bomb display `###` for a host-tunable duration (5 seconds by
  default) without changing its authoritative countdown. A lobby option
  replaces the gun card with E.M.P, an instant-use card that jams every real
  and fake bomb display for that same duration.
- **Double bomb** starts each round with two simultaneous lethal bombs while
  at least four players remain. Both eliminations belong to the same round;
  new rounds return to one bomb once only one to three players remain.
- **Roguelike 3-choice shop** replaces auto-buy/hand storage with three
  personal choices plus a paid reroll in slot 4. Choosing a card costs
  `CardDrawCost`; after it is consumed, that slot immediately rolls a new card
  from every enabled card rather than the round Shop Pool. Magnifying Glass
  uses a mode-specific 2× draw weight. Its optional **Free choices; only
  reroll costs coins** rule makes slots 1–3 free and leaves consumed slots
  empty across rounds; pressing slot 4 pays a lobby-configurable price
  (15 coins by default), discards every remaining choice, and rolls a fresh
  set of three.
- **Wobbly hitscan weapons** makes firearm rounds and the universal charged
  shot resolve instantly. Their original firing cycle controls sight wobble
  (slower weapons wander farther), and every ray receives additional random
  spread. A short authoritative trail shows its exact path. Bomb passes,
  repair-kit throws, and Grapple Claws remain moving projectiles.
- **One-time $10 bomb pot** limits each hold to generating $10 in total.
  Damaging enemy shots still steal up to $2 from the stored pot, but those
  stolen coins no longer regenerate before the bomb is passed. The pot keeps
  its `MAX` label after reaching that limit, even when its balance is stolen.

## Architecture (host authoritative)

One browser (the host) runs the simulation; every other browser sends inputs
(`{mouse, pass, parry, use, primaryFire, gunFireSlot}`) and renders the snapshot the host sends
back. Clients never decide hits, bomb time changes, deaths, purchases, or rewards. Parry/punish
timing is the deliberate exception: each receiving client judges its own local window and sends
the result with an opaque transfer id, so network round-trip latency cannot spoil the timing.

- `js/config.js` — every tunable number from the plan (`BombArmReach`, `BaseMinimumHoldTime`,
  `MinimumBombTimeAfterReduction`, speed/shield/curse durations, coin rates, drop weights…).
  Nothing gameplay-relevant is hardcoded elsewhere.
- `js/cards.js` — card definitions including the three distinct firearms, repair kits,
  global timer effects, Shield, Reverse, and the weighted shop roll.
- `js/aim.js` — the shared deterministic sight-wobble model used by both the
  authoritative hitscan resolver and client rendering.
- `js/sim.js` — the authoritative state machine: bomb-time-pool draw → initial time reveal →
  3-2-1 → hidden timer → random holder → passing/cards/projectiles → explosion → elimination
  → next bomb → last survivor wins, plus `buildSnapshot()` (the only view clients ever get).
- `js/ai.js` — bots submit the same plain input shape a network client does, use
  the universal sling, and avoid hostile team actions.
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
  the *next* receiver, then clears. Reverse toggles the entire order until toggled again or
  the round ends.
- **Local parry timing**: an incoming ordinary pass exposes a local punish window followed by
  a parry window. Pressing in punish locks out that transfer; pressing in parry immediately
  returns it at incoming speed ×1.5, up to the global pass-speed cap.
  The host validates the receiver and transfer id, and accepts a short late result only while
  that exact bomb is still in the receiver's hands.
- **Bomb arm control**: the holder sends only a mouse position; the host computes the bomb
  offset and clamps it to `BombArmReach`. The bomb collider genuinely moves — it can dodge
  shots, catch repair kits, or hide behind the holder's body.
- **Shots and projectiles**: normally every gun/repair card fires a real moving
  projectile. In Wobbly Hitscan mode, firearms and charged shots become
  instantaneous host-resolved rays with visible trails, aim wobble, and random
  spread; thrown tools and bombs still travel. The -5s gun is a three-round
  semi-auto, the -3s shotgun has one three-pellet shell, and the -1s machine
  gun has a ten-round hold-to-fire magazine. The Public Seconds-only Electronic
  Shock Gun is always a wide, stable hitscan pulse and jams either a real or
  fake bomb's visible timer to `###` for the lobby-configured duration; its
  optional E.M.P replacement applies that jam to all bombs immediately.
- **Time rules**: reductions clamp at `MinimumBombTimeAfterReduction` (never explode from a
  hit; natural countdown to 0 still does); no upper limit on bomb time.
- **Speed modifiers**: Speed Up ×2 / Slow Down ×0.5 override each other completely — no
  stacking of multipliers or durations.
- **Shield**: any living player can activate a five-second personal bubble roughly
  equal to arm reach; it blocks incoming projectiles and Magnifying Glass readings
  while the bomb is inside the bubble.
- **Economy**: integer coins only; passive income for alive players and a bomb pot cashed
  on throw. Purchases happen automatically when affordable. A holder can taunt to farm the
  pot at 2× speed while surrendering arm and pass control. If a full pot is damaged by a
  coin-stealing shot, it continues replenishing back to its $10 cap unless the
  one-time $10 bomb pot lobby option is enabled.
- **Fake Bomb reward**: a fake pops with a distinct confetti/coin effect instead of the
  lethal blast ring and awards $10 to the closest living player.
- **Bomb pot damage**: each damaging hit on the real bomb steals up to 2 coins
  from its banked pot for the shooter, with a public coin-transfer animation
  (blocked shots do not).
- **Elimination**: the only death is holding the bomb at 0. Dead players lose coins and
  cards, retain the -3s charged sling shot (releasable after one second at 33% speed
  in a four-player match, scaling linearly to full speed at two seconds; both charge
  times scale with the match's player count), and receive one random global item
  (Speed Up, Freeze, or Reverse) each round. Eliminated players always see the
  exact timers on the real bomb and every fake bomb. Last survivor wins; host can rematch.
- **Debug UI** (checkbox, dev only): exact bomb time, speed/shield/curse state, pass lock,
  passing order, every player's coins/hand, projectile states — never part of normal UI.

## Testing

The sim is UI-free, so its rules run headless (see the repo history for the check script:
phases, pass lock, income, auto-purchases, projectile hits, shield, global effects
override, hidden-timer snapshot audit, elimination, match reset).

## Known prototype limits

- No reconnection/late-join once a match started (disconnected players are eliminated).
- No client-side interpolation — clients render the host's ~20 Hz snapshots directly.
- Uses the public PeerJS cloud broker for signaling, so internet access is required even
  for a same-machine test.
