"use strict";

// Top-level app: menu -> host/join lobby -> game. Captures local input into a
// collector, wires PeerJS sessions, and runs the render loop. No gameplay
// rules live here — the host's sim decides everything.
(() => {
  const $ = id => document.getElementById(id);

  // ---- Screens ----
  const screens = {};
  document.querySelectorAll(".screen").forEach(el => { screens[el.id] = el; });
  function show(id) {
    for (const k in screens) screens[k].classList.toggle("active", k === "screen-" + id);
  }

  // ---- Input collector ----
  // One shared shape for host-local play and network clients: mouse position
  // is continuous, presses accumulate until take() is called.
  function makeCollector() {
    const state = { mx: null, my: null, pass: false, draw: false, use: [], discard: [], debug: false, equip: null };
    return {
      setMouse(x, y) { state.mx = x; state.my = y; },
      pressPass() { state.pass = true; },
      pressDraw() { state.draw = true; },
      pressUse(slot) { state.use.push(slot); },
      pressDiscard(slot) { state.discard.push(slot); },
      setDebug(v) { state.debug = v; },
      setEquip(slot) { state.equip = slot; },
      peek() { return state; },
      take() {
        const out = {
          mx: state.mx, my: state.my, pass: state.pass, draw: state.draw,
          use: state.use.slice(), discard: state.discard.slice(), debug: state.debug,
          equip: state.equip,
        };
        state.pass = false; state.draw = false; state.use = []; state.discard = [];
        return out;
      },
    };
  }

  const collector = makeCollector();
  const canvas = $("game");
  const ctx = canvas.getContext("2d");

  // ---- Player name persistence ----
  const NAME_KEY = "countdown-pvp:playerName";
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) $("playerName").value = savedName;
  $("playerName").addEventListener("input", () => {
    localStorage.setItem(NAME_KEY, $("playerName").value.trim());
  });

  let role = null;            // 'host' | 'client'
  let hostSession = null;
  let clientSession = null;
  let myId = null;
  let latestSnap = null;

  // ---- Client-side smoothing (interpolation) + local prediction ------------
  // The host is authoritative and only sends snapshots at CONFIG.SnapshotRate
  // (20 Hz). A client that draws the newest snapshot raw sees remote motion
  // jump ~50 ms at a time, and its *own* arm/aim lag by a full round-trip.
  // Two fixes, both client-only (the host renders its own sim at 60 Hz with no
  // network in the loop, so it needs neither):
  //   ② interpolation: buffer snapshots and render ~2 frames in the past,
  //      lerping bomb/projectile/aim positions between the two straddling it.
  //   ① prediction: for the local player, drive the held bomb's arm offset and
  //      the weapon/magnify aim straight from the live mouse, so they respond
  //      instantly instead of after a round-trip.
  const snapBuffer = [];      // [{ t: receive ms, snap }], oldest first (client only)
  const InterpDelayMs = 2000 / CONFIG.SnapshotRate; // straddle two samples
  let predOffset = null;      // predicted local held-bomb arm offset {x,y}
  let lastFrameMs = performance.now();

  function pushClientSnap(snap) {
    snapBuffer.push({ t: performance.now(), snap });
    // Keep a small window; never drop below 2 so we can always interpolate.
    while (snapBuffer.length > 12) snapBuffer.shift();
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

  // The interpolated view at renderT = now - InterpDelayMs: discrete state
  // (phase, holder, hand, events…) comes from the older straddling snapshot;
  // continuous positions are lerped toward the newer one.
  function sampleInterpolated(nowMs) {
    if (snapBuffer.length === 0) return null;
    if (snapBuffer.length === 1) return snapBuffer[0].snap;
    const renderT = nowMs - InterpDelayMs;
    if (renderT <= snapBuffer[0].t) return snapBuffer[0].snap;
    let i = snapBuffer.length - 1; // default: renderT past newest → freeze there
    for (let k = 0; k < snapBuffer.length - 1; k++) {
      if (snapBuffer[k].t <= renderT && renderT < snapBuffer[k + 1].t) { i = k; break; }
    }
    const a = snapBuffer[i], b = snapBuffer[i + 1];
    if (!b) return a.snap;
    const span = b.t - a.t;
    return lerpSnap(a.snap, b.snap, clamp01(span > 0 ? (renderT - a.t) / span : 0));
  }

  function lerpSnap(s0, s1, t) {
    const out = Object.assign({}, s0); // discrete fields as-of s0

    if (s0.bomb && s1.bomb) {
      out.bomb = Object.assign({}, s0.bomb, {
        x: lerp(s0.bomb.x, s1.bomb.x, t),
        y: lerp(s0.bomb.y, s1.bomb.y, t),
      });
    }

    // Seats never move; only a raised weapon/magnify aim does.
    out.players = s0.players.map(p0 => {
      const p1 = s1.players.find(q => q.id === p0.id);
      if (!p1) return p0;
      if (p0.aimX != null && p1.aimX != null) {
        return Object.assign({}, p0, { aimX: lerp(p0.aimX, p1.aimX, t), aimY: lerp(p0.aimY, p1.aimY, t) });
      }
      if (p0.aimX == null && p1.aimX != null) {
        return Object.assign({}, p0, { aimX: p1.aimX, aimY: p1.aimY });
      }
      return p0;
    });

    // Projectiles matched by id so each is lerped along its own path.
    const m1 = new Map(s1.projectiles.map(pr => [pr.id, pr]));
    const seen = new Set();
    const proj = [];
    for (const p0 of s0.projectiles) {
      seen.add(p0.id);
      const p1 = m1.get(p0.id);
      proj.push(p1
        ? { id: p0.id, amount: p0.amount, x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) }
        : p0); // despawning: hold last spot until it drops out next sample
    }
    for (const p1 of s1.projectiles) if (!seen.has(p1.id)) proj.push(p1); // just spawned
    out.projectiles = proj;
    return out;
  }

  // Override the local player's held-bomb arm and weapon/magnify aim with the
  // live mouse, mirroring the host's arm integration so the two converge (they
  // agree exactly whenever the mouse is still — the host applies the same
  // clamp + BombArmMoveSpeed cap).
  function applyLocalPrediction(snap, dtMs) {
    if (!snap || !myId) return snap;
    const meIdx = snap.players.findIndex(p => p.id === myId);
    if (meIdx < 0) return snap;
    const me = snap.players[meIdx];
    const you = snap.you;
    const st = collector.peek();
    const mouse = st.mx != null ? { x: st.mx, y: st.my } : null;
    if (!mouse) return snap;

    let outBomb = snap.bomb;
    let outMe = me;

    const iAmHolder = !!(you && you.isHolder && snap.bomb && !snap.bomb.transferring && snap.phase === "playing");

    if (iAmHolder) {
      const seat = { x: me.x, y: me.y };
      let tx = mouse.x - seat.x, ty = mouse.y - seat.y;
      const len = Math.hypot(tx, ty);
      const target = len > 0.001
        ? (r => ({ x: tx / len * r, y: ty / len * r }))(Math.min(len, CONFIG.BombArmReach))
        : { x: 0, y: 0 };
      const auth = { x: snap.bomb.x - seat.x, y: snap.bomb.y - seat.y };
      if (!predOffset) predOffset = auth;
      // Snap back if we've diverged hard from the host (a correction, a hit
      // that moved the bomb, or a fresh hold): trust authority over the guess.
      if (Math.hypot(predOffset.x - auth.x, predOffset.y - auth.y) > CONFIG.BombArmReach) predOffset = auth;
      const dt = Math.min(dtMs, 100) / 1000;
      const dx = target.x - predOffset.x, dy = target.y - predOffset.y;
      const stepLen = Math.hypot(dx, dy);
      const maxStep = CONFIG.BombArmMoveSpeed * dt;
      predOffset = (stepLen <= maxStep || stepLen < 0.001)
        ? target
        : { x: predOffset.x + dx / stepLen * maxStep, y: predOffset.y + dy / stepLen * maxStep };
      outBomb = Object.assign({}, snap.bomb, { x: seat.x + predOffset.x, y: seat.y + predOffset.y });
    } else {
      predOffset = null; // reset so the next hold starts from authority
    }

    // Aim: if I've armed a weapon locally, show its pose + sight line pointing
    // at the live mouse now, rather than waiting for the host to echo my equip
    // back. Also tracks the mouse for an already-confirmed weapon/magnify.
    const armedNow = armedSlot != null && you && you.alive && snap.phase === "playing" && !iAmHolder;
    if (armedNow) {
      outMe = Object.assign({}, me, { equipped: true, aimX: mouse.x, aimY: mouse.y });
    } else if (me.equipped || me.revealing) {
      outMe = Object.assign({}, me, { aimX: mouse.x, aimY: mouse.y });
    }

    if (outBomb === snap.bomb && outMe === me) return snap;
    const out = Object.assign({}, snap, { bomb: outBomb });
    if (outMe !== me) { out.players = snap.players.slice(); out.players[meIdx] = outMe; }
    return out;
  }

  const dom = {
    coinDisplay: $("coinDisplay"),
    statusLine: $("statusLine"),
    hand: $("hand"),
    aimHint: $("aimHint"),
    btnPass: $("btnPass"),
    btnDraw: $("btnDraw"),
    eventLog: $("eventLog"),
    debugPanel: $("debugPanel"),
    matchOverBar: $("matchOverBar"),
    matchOverText: $("matchOverText"),
    btnRematch: $("btnRematch"),
  };

  // ---- Canvas / keyboard input ----

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  canvas.addEventListener("mousemove", e => {
    const p = canvasPoint(e);
    collector.setMouse(p.x, p.y);
  });

  // Projectile cards need a deliberate aim: selecting one "arms" it, and each
  // canvas click fires one shot toward the click point (so a stray
  // hand-panel click can't fire it toward wherever the mouse last happened
  // to be). Gun cards hold several separate shots — the card stays armed
  // across clicks until every shot is fired. Canceling before any shot is
  // fired is free; canceling after at least one shot forfeits the rest (the
  // card is discarded). Non-projectile cards (shield/curse/speed/magnify)
  // still use instantly.
  let armedSlot = null;

  // If the currently armed slot already has an in-progress multi-shot gun
  // (at least one round fired), leaving it behind discards the remainder.
  function deactivateArmed() {
    const you = latestSnap && latestSnap.you;
    if (armedSlot != null && you && you.gunPending && you.gunPending.slot === armedSlot) {
      collector.pressDiscard(armedSlot);
    }
    armedSlot = null;
    collector.setEquip(null);
  }

  function activateCard(slot) {
    const you = latestSnap && latestSnap.you;
    const cardId = you && you.hand[slot];
    if (!cardId) return;
    if (Cards.TYPES[cardId].kind === "projectile") {
      // Both hands are full holding the bomb — the holder can't wield a
      // weapon too. But once it's been thrown and is in flight, their hands
      // are free again even though isHolder hasn't flipped yet.
      const reallyHolding = you.isHolder && !(latestSnap.bomb && latestSnap.bomb.transferring);
      if (reallyHolding) return;
      if (armedSlot === slot) { deactivateArmed(); return; }
      deactivateArmed(); // switching weapons forfeits whatever was mid-burst
      armedSlot = slot;
      collector.setEquip(armedSlot);
    } else {
      collector.pressUse(slot);
    }
  }

  function cancelAim() { deactivateArmed(); }

  canvas.addEventListener("click", e => {
    if (armedSlot == null) return;
    const p = canvasPoint(e);
    collector.setMouse(p.x, p.y);
    collector.pressUse(armedSlot);
    // Don't clear armedSlot here: a multi-shot gun stays armed for its next
    // click. It clears itself in frame() below once the card actually
    // leaves the hand (last shot fired, or discarded via cancel).
  });
  canvas.addEventListener("contextmenu", e => { if (armedSlot != null) { e.preventDefault(); cancelAim(); } });

  window.addEventListener("keydown", e => {
    if (!screens["screen-game"].classList.contains("active")) return;
    if (e.code === "Escape") { cancelAim(); return; }
    if (e.repeat) return;
    if (e.code === "Space") { e.preventDefault(); collector.pressPass(); }
    else if (e.code === "KeyR") collector.pressDraw();
    else if (e.code === "Digit1") activateCard(0);
    else if (e.code === "Digit2") activateCard(1);
    else if (e.code === "Digit3") activateCard(2);
    else if (e.code === "Digit4") activateCard(3);
    else if (e.code === "Digit5") activateCard(4);
  });

  $("btnPass").onclick = () => collector.pressPass();
  $("btnDraw").onclick = () => collector.pressDraw();
  $("chkDebug").onchange = e => collector.setDebug(e.target.checked);

  // ---- Render loop (shared by host and client) ----

  function frame() {
    const nowMs = performance.now();
    const dtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;

    if (screens["screen-game"].classList.contains("active") && latestSnap) {
      // Armed-card cleanup reacts to *authoritative* state (the newest snapshot),
      // not the interpolated/predicted view: drop the armed card if it left the
      // hand (used elsewhere, discarded, died, or the phase changed) so the UI
      // never shows a stale aim state.
      const you = latestSnap.you;
      const reallyHolding = you && you.isHolder && !(latestSnap.bomb && latestSnap.bomb.transferring);
      if (armedSlot != null && (!you || !you.hand[armedSlot] || reallyHolding || latestSnap.phase !== "playing")) {
        armedSlot = null;
        collector.setEquip(null);
      }
      canvas.style.cursor = armedSlot != null ? "pointer" : "crosshair";

      // Host draws its own 60 Hz sim raw (no network in the loop). Clients draw
      // an interpolated past frame with the local player predicted forward.
      let viewSnap = latestSnap;
      if (role === "client") {
        viewSnap = applyLocalPrediction(sampleInterpolated(nowMs) || latestSnap, dtMs);
      }

      Render.draw(ctx, viewSnap, myId);
      Render.updateDom(dom, viewSnap, {
        useCard: s => activateCard(s),
        discardCard: s => { if (armedSlot === s) armedSlot = null; collector.pressDiscard(s); },
        armedSlot,
        isHost: role === "host",
      });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function enterGame() {
    Render.resetDomCache();
    dom.eventLog.innerHTML = "";
    snapBuffer.length = 0; // no stale interpolation carried across matches
    predOffset = null;
    show("game");
  }

  function playerName() {
    return ($("playerName").value.trim() || "Player").slice(0, 16);
  }

  function joinPlayerName() {
    return ($("joinName").value.trim() || "Player").slice(0, 16);
  }

  // ---- Seat list rendering (lobby) ----

  const SEAT_COLORS = ["#e6604c", "#4c9be6", "#5cc46a", "#e6c14c", "#b06ce6", "#e68b4c", "#4ce6d4", "#e64ca8"];

  function renderSeats(el, roster) {
    el.innerHTML = "";
    roster.forEach((r, i) => {
      const div = document.createElement("div");
      div.className = "seat";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = SEAT_COLORS[i % SEAT_COLORS.length];
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name + (r.isBot ? " (bot)" : "");
      div.append(dot, name);
      el.appendChild(div);
    });
  }

  // ---- Host flow ----

  $("btnGoHost").onclick = () => {
    role = "host";
    myId = "P0";
    show("host-lobby");
    $("roomCode").textContent = "connecting…";

    hostSession = Host.createSession({
      hostName: playerName(),
      localCollector: collector,
      onReady: code => {
        $("roomCode").textContent = code;
        $("shareLink").value = location.origin + location.pathname + "?room=" + code;
      },
      onError: err => { alert("Network error: " + (err && err.type ? err.type : err)); },
      onLobby: roster => renderSeats($("hostSeatList"), roster),
      onSnapshot: snap => { latestSnap = snap; },
    });
    renderSeats($("hostSeatList"), [{ id: "P0", name: playerName(), isBot: false }]);
    buildPoolChecks();
  };

  function buildPoolChecks() {
    const wrap = $("poolChecks");
    wrap.innerHTML = "";
    for (const t of CONFIG.BombTimePoolOptions) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(t);
      cb.checked = CONFIG.DefaultBombTimePool.includes(t);
      cb.onchange = () => {
        const pool = [...wrap.querySelectorAll("input:checked")].map(c => Number(c.value));
        hostSession.setPool(pool);
      };
      label.append(cb, ` ${t}s`);
      wrap.appendChild(label);
    }
  }

  $("btnCopyLink").onclick = async () => {
    const link = $("shareLink").value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      $("copyStatus").textContent = "Copied!";
    } catch {
      $("shareLink").select();
      document.execCommand("copy");
      $("copyStatus").textContent = "Copied!";
    }
    setTimeout(() => { $("copyStatus").textContent = ""; }, 2000);
  };

  $("btnAddBot").onclick = () => hostSession.addBot();
  $("btnRemoveBot").onclick = () => hostSession.removeBot();

  $("btnStartMatch").onclick = () => {
    const err = hostSession.start();
    if (err) { alert(err); return; }
    enterGame();
  };

  $("btnRematch").onclick = () => { if (hostSession) hostSession.rematch(); };

  // ---- Join flow ----

  $("btnGoJoin").onclick = () => {
    $("joinName").value = playerName();
    show("join");
    $("joinStatus").textContent = "";
  };

  $("btnJoinConnect").onclick = () => {
    const code = $("joinCode").value.trim();
    if (!code) { $("joinStatus").textContent = "Enter a room code."; return; }
    role = "client";
    $("joinStatus").textContent = "Connecting…";

    clientSession = Client.createSession({
      code,
      name: joinPlayerName(),
      collector,
      onWelcome: id => { myId = id; show("client-lobby"); },
      onReject: reason => { $("joinStatus").textContent = "Rejected: " + reason; },
      onLobby: roster => renderSeats($("clientSeatList"), roster),
      onStart: enterGame,
      onSnapshot: snap => { latestSnap = snap; pushClientSnap(snap); },
      onClosed: () => {
        alert("Disconnected from host.");
        location.reload();
      },
      onError: err => { $("joinStatus").textContent = "Error: " + (err && err.type ? err.type : err); },
    });
  };

  // ---- Join-by-link ----
  // A host's share link is `?room=CODE`; land straight on the join screen
  // with the code prefilled so the guest only needs to enter their name.
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) {
    $("joinCode").value = roomParam;
    show("join");
  }
})();
