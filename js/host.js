"use strict";

// Host session: owns the only sim instance. Runs the fixed-rate simulation
// loop, merges local + bot + remote inputs each tick, and sends every peer a
// snapshot tailored to them (this is how Magnifying Glass reveals stay
// private and the hidden bomb timer never touches the wire).
const Host = (() => {
  const C = CONFIG;

  // opts: {
  //   hostName,
  //   localCollector,          // input collector for the host's own player
  //   onReady(code), onError(err),
  //   onLobby(roster, pool),   // fired on any lobby change
  //   onSnapshot(snap),        // host's own per-frame view
  // }
  function createSession(opts) {
    const roster = [{ id: "P0", name: opts.hostName || "Host", isBot: false, peerId: null }];
    let nextClientNum = 1;
    let nextBotNum = 1;
    let pool = C.DefaultBombTimePool.slice();
    let started = false;
    let sim = null;
    let tickTimer = null;
    let lastTick = 0;
    let acc = 0;
    let snapAcc = 0;

    const peerToPlayer = new Map();  // peerId -> playerId
    const remoteInputs = new Map();  // playerId -> accumulated input buffer
    const debugWanted = new Map();   // playerId -> bool
    const bots = new Map();          // playerId -> AI brain

    const net = Net.createHost({
      onReady: code => opts.onReady(code),
      onError: err => opts.onError(err),
      onMessage: handleMessage,
      onLeave: peerId => {
        const pid = peerToPlayer.get(peerId);
        if (!pid) return;
        peerToPlayer.delete(peerId);
        remoteInputs.delete(pid);
        if (!started) {
          const i = roster.findIndex(r => r.id === pid);
          if (i >= 0) roster.splice(i, 1);
          lobbyChanged();
        } else if (sim) {
          Sim.dropPlayer(sim, pid);
        }
      },
    });

    function rosterView() {
      return roster.map(r => ({ id: r.id, name: r.name, isBot: r.isBot }));
    }

    function lobbyChanged() {
      opts.onLobby(rosterView(), pool);
      net.broadcast({ type: "lobby", roster: rosterView(), pool });
    }

    function handleMessage(peerId, msg) {
      if (msg.type === "hello") {
        if (started) { net.sendTo(peerId, { type: "reject", reason: "Match already started" }); return; }
        if (roster.length >= C.MaxPlayers) { net.sendTo(peerId, { type: "reject", reason: "Room is full" }); return; }
        const id = "P" + nextClientNum++;
        const name = String(msg.name || "Player").slice(0, 16) || "Player";
        roster.push({ id, name, isBot: false, peerId });
        peerToPlayer.set(peerId, id);
        net.sendTo(peerId, { type: "welcome", playerId: id });
        lobbyChanged();
      } else if (msg.type === "input") {
        const pid = peerToPlayer.get(peerId);
        if (!pid) return;
        accumulate(pid, msg.input);
        debugWanted.set(pid, !!msg.input.debug);
      }
    }

    // Merge a client packet into that player's buffer: mouse overwrites,
    // presses accumulate until the sim consumes them (so nothing sent between
    // ticks is lost).
    function accumulate(pid, inc) {
      let buf = remoteInputs.get(pid);
      if (!buf) { buf = { mx: null, my: null, pass: false, draw: false, use: [], discard: [] }; remoteInputs.set(pid, buf); }
      if (inc.mx != null) { buf.mx = inc.mx; buf.my = inc.my; }
      buf.pass = buf.pass || !!inc.pass;
      buf.draw = buf.draw || !!inc.draw;
      if (Array.isArray(inc.use) && inc.use.length) buf.use.push(...inc.use);
      if (Array.isArray(inc.discard) && inc.discard.length) buf.discard.push(...inc.discard);
    }

    // ---- Lobby controls (host UI) ----

    function addBot() {
      if (started || roster.length >= C.MaxPlayers) return;
      roster.push({ id: "B" + nextBotNum, name: "Bot " + nextBotNum, isBot: true, peerId: null });
      nextBotNum++;
      lobbyChanged();
    }

    function removeBot() {
      if (started) return;
      for (let i = roster.length - 1; i >= 0; i--) {
        if (roster[i].isBot) { roster.splice(i, 1); break; }
      }
      lobbyChanged();
    }

    function setPool(newPool) {
      pool = newPool.slice();
      lobbyChanged();
    }

    // ---- Game loop ----

    function start() {
      if (started) return null;
      if (roster.length < 2) return "Need at least 2 players — add a bot?";
      if (pool.length < 1) return "Enable at least one Bomb Time Pool value";
      started = true;
      sim = Sim.createMatch(rosterView(), pool);
      for (const r of roster) if (r.isBot) bots.set(r.id, AI.createBrain());
      net.broadcast({ type: "start" });
      lastTick = performance.now();
      acc = 0;
      snapAcc = 0;
      tickTimer = setInterval(tick, 1000 / C.TickRate);
      return null;
    }

    function collectInputs() {
      const inputs = {};
      inputs["P0"] = opts.localCollector.take();
      for (const [pid, brain] of bots) {
        const p = Sim.getPlayer(sim, pid);
        if (p) inputs[pid] = AI.botInput(sim, p, brain);
      }
      for (const [pid, buf] of remoteInputs) {
        inputs[pid] = { mx: buf.mx, my: buf.my, pass: buf.pass, draw: buf.draw, use: buf.use.slice(), discard: buf.discard.slice() };
        buf.pass = false; buf.draw = false; buf.use = []; buf.discard = [];
      }
      return inputs;
    }

    function stripPresses(inputs) {
      for (const pid in inputs) {
        inputs[pid] = { mx: inputs[pid].mx, my: inputs[pid].my, pass: false, draw: false, use: [], discard: [] };
      }
    }

    const DT = 1 / C.TickRate;

    function tick() {
      const now = performance.now();
      let elapsed = (now - lastTick) / 1000;
      lastTick = now;
      if (elapsed > 0.25) elapsed = 0.25; // tab was backgrounded — don't fast-forward
      acc += elapsed;
      if (acc < DT) return; // no step this tick: leave presses buffered

      let inputs = collectInputs();
      let first = true;
      while (acc >= DT) {
        acc -= DT;
        Sim.step(sim, inputs, DT);
        if (first) { stripPresses(inputs); first = false; } // presses apply once
      }

      snapAcc += elapsed;
      if (snapAcc >= 1 / C.SnapshotRate) {
        snapAcc = 0;
        for (const r of roster) {
          if (!r.peerId || !peerToPlayer.has(r.peerId)) continue;
          net.sendTo(r.peerId, {
            type: "snap",
            snap: Sim.buildSnapshot(sim, r.id, debugWanted.get(r.id)),
          });
        }
      }
      // The host's own view refreshes at full tick rate.
      opts.onSnapshot(Sim.buildSnapshot(sim, "P0", !!opts.localCollector.peek().debug));
    }

    function rematch() {
      if (sim && sim.phase === "matchover") Sim.resetMatch(sim);
    }

    function destroy() {
      if (tickTimer) clearInterval(tickTimer);
      net.close();
    }

    return { addBot, removeBot, setPool, start, rematch, destroy, getPool: () => pool.slice() };
  }

  return { createSession };
})();
