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
    if (screens["screen-game"].classList.contains("active") && latestSnap) {
      // Drop the armed card if it left the hand (used elsewhere, discarded,
      // died, or the phase changed) so the UI never shows a stale aim state.
      const you = latestSnap.you;
      const reallyHolding = you && you.isHolder && !(latestSnap.bomb && latestSnap.bomb.transferring);
      if (armedSlot != null && (!you || !you.hand[armedSlot] || reallyHolding || latestSnap.phase !== "playing")) {
        armedSlot = null;
        collector.setEquip(null);
      }
      canvas.style.cursor = armedSlot != null ? "pointer" : "crosshair";

      Render.draw(ctx, latestSnap, myId);
      Render.updateDom(dom, latestSnap, {
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
      onSnapshot: snap => { latestSnap = snap; },
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
