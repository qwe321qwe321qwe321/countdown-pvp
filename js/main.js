"use strict";

// Top-level app: menu -> host/join lobby -> game. Captures local input into a
// collector, wires PeerJS sessions, and runs the render loop. No gameplay
// rules live here except latency-sensitive parry-window classification; the
// host's sim still validates and applies every resulting state change.
(() => {
  const $ = id => document.getElementById(id);

  // ---- Screens ----
  const screens = {};
  document.querySelectorAll(".screen").forEach(el => { screens[el.id] = el; });
  function show(id) {
    for (const k in screens) screens[k].classList.toggle("active", k === "screen-" + id);
    GameAudio.setScene(id);
  }

  // ---- Input collector ----
  // One shared shape for host-local play and network clients: mouse position
  // is continuous, presses accumulate until take() is called.
  function makeCollector() {
    const state = {
      mx: null, my: null, pass: false, use: [], discard: [],
      parry: [],
      debug: false, equip: null, primaryFire: false, gunFireSlot: null,
    };
    return {
      setMouse(x, y) { state.mx = x; state.my = y; },
      pressPass() { state.pass = true; },
      pressParry(transferId, outcome) { state.parry.push({ transferId, outcome }); },
      pressUse(slot) { state.use.push(slot); },
      pressDiscard(slot) { state.discard.push(slot); },
      setDebug(v) { state.debug = v; },
      setEquip(slot) { state.equip = slot; },
      setPrimaryFire(v) { state.primaryFire = !!v; },
      setGunFireSlot(slot) { state.gunFireSlot = slot == null ? null : slot; },
      peek() { return state; },
      take() {
        const out = {
          mx: state.mx, my: state.my, pass: state.pass,
          parry: state.parry.slice(),
          use: state.use.slice(), discard: state.discard.slice(), debug: state.debug,
          equip: state.equip, primaryFire: state.primaryFire,
          gunFireSlot: state.gunFireSlot,
        };
        state.pass = false; state.parry = []; state.use = []; state.discard = [];
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
  function setSavedName(name) {
    localStorage.setItem(NAME_KEY, name);
  }
  $("playerName").addEventListener("input", () => {
    setSavedName($("playerName").value.trim());
  });

  let role = null;            // 'host' | 'client'
  let hostSession = null;
  let clientSession = null;
  let myId = null;
  let latestSnap = null;
  let latestSnapReceivedMs = performance.now();

  // Parry timing is deliberately client-local. The first snapshot announcing
  // an incoming transfer starts a local clock that is never corrected by
  // later host snapshots, so network transit time and jitter cannot move the
  // player's punish/parry windows. The transfer id makes the returned result
  // safe to apply only to that exact incoming throw.
  let localParry = null;
  const seenParryTransfers = new Set();

  function acceptSnapshot(snap) {
    latestSnap = snap;
    latestSnapReceivedMs = performance.now();
    const offer = snap && snap.you && snap.you.incomingParry;
    if (offer && !seenParryTransfers.has(offer.transferId)) {
      seenParryTransfers.add(offer.transferId);
      if (seenParryTransfers.size > 100) {
        const oldest = seenParryTransfers.values().next().value;
        seenParryTransfers.delete(oldest);
      }
      localParry = {
        transferId: offer.transferId,
        duration: offer.duration,
        initialRemaining: offer.remaining,
        incomingSpeed: offer.incomingSpeed,
        startedAtMs: latestSnapReceivedMs,
        outcome: null,
        outcomeAtMs: null,
      };
    }
  }

  function localParryView(nowMs) {
    if (!localParry) return null;
    const elapsed = Math.max(0, (nowMs - localParry.startedAtMs) / 1000);
    const remaining = localParry.initialRemaining - elapsed;
    const configuredTotal = CONFIG.ParryPunishWindow + CONFIG.ParryWindow;
    const scale = Math.min(1, localParry.duration / configuredTotal);
    const punishWindow = CONFIG.ParryPunishWindow * scale;
    const parryWindow = CONFIG.ParryWindow * scale;
    let state;
    if (localParry.outcome) {
      state = localParry.outcome === "success" ? "success" : "punished";
    } else if (remaining > punishWindow + parryWindow) {
      state = "incoming";
    } else if (remaining > parryWindow) {
      state = "punish";
    } else if (remaining > 0) {
      state = "parry";
    } else {
      state = "missed";
    }
    return {
      transferId: localParry.transferId,
      state,
      remaining: Math.max(0, remaining),
      successAge: state === "success" && localParry.outcomeAtMs != null
        ? Math.max(0, (nowMs - localParry.outcomeAtMs) / 1000)
        : null,
      incomingSpeed: localParry.incomingSpeed,
      outgoingSpeed: localParry.incomingSpeed * CONFIG.ParrySpeedMultiplier,
    };
  }

  function pressSpace() {
    const view = localParryView(performance.now());
    if (view) {
      if (!localParry.outcome) {
        if (view.state === "punish") {
          localParry.outcome = "punished";
          localParry.outcomeAtMs = performance.now();
          collector.pressParry(view.transferId, "punished");
        } else if (view.state === "parry") {
          localParry.outcome = "success";
          localParry.outcomeAtMs = performance.now();
          collector.pressParry(view.transferId, "success");
        }
      }
      // An incoming throw owns SPACE for its whole local timeline, including
      // after an early punish. It can never leak into a normal pass on arrival.
      return;
    }
    collector.pressPass();
  }

  function withLocalParry(snap, nowMs) {
    if (!snap || !snap.you) return snap;
    const view = localParryView(nowMs);
    if (!view) return snap;
    const outcomeExpired = localParry.outcomeAtMs != null &&
      nowMs - localParry.outcomeAtMs > 450;
    const missedExpired = !localParry.outcome && view.state === "missed" &&
      nowMs - localParry.startedAtMs > (localParry.initialRemaining + 0.45) * 1000;
    if (outcomeExpired || missedExpired) {
      localParry = null;
      return snap;
    }
    return Object.assign({}, snap, {
      you: Object.assign({}, snap.you, { parry: view }),
    });
  }

  // ---- Local prediction (client only) --------------------------------------
  // The host is authoritative and only echoes state back at SnapshotRate, so a
  // client's *own* mouse-driven arm and aim would otherwise lag by a full
  // round-trip. We drive just the local player's held-bomb arm offset and
  // weapon/magnify aim straight from the live mouse, mirroring the host's exact
  // clamp + move-speed integration so the two stay converged (they agree
  // exactly whenever the mouse is still). Everything the local player does NOT
  // control is left on the newest snapshot untouched — no interpolation, so we
  // never add latency to anyone's view. The host renders its own 60Hz sim, so
  // it needs none of this.
  let predOffset = null;      // predicted local held-bomb arm offset {x,y}
  let predHolder = false;     // were we the predicted holder last frame?
  let predDeadAim = null;     // smoothed local copy of the host's slowed ghost aim
  let lastFrameMs = performance.now();

  // Override the local player's held-bomb position and weapon/magnify aim in a
  // shallow copy of the snapshot (never mutating the shared latestSnap).
  function applyLocalPrediction(snap, dtMs) {
    if (!snap || !myId) return snap;
    const meIdx = snap.players.findIndex(p => p.id === myId);
    if (meIdx < 0) { predOffset = null; predHolder = false; predDeadAim = null; return snap; }
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
      const auth = { x: snap.bomb.x - seat.x, y: snap.bomb.y - seat.y };
      // Re-seed from authority when a hold just began, or if we somehow drifted
      // far from it (a correction the host applied that arm motion can't
      // explain) — otherwise trust the local integration, which is deterministic
      // from the mouse and matches what the host computes.
      if (!predHolder || !predOffset ||
          Math.hypot(predOffset.x - auth.x, predOffset.y - auth.y) > CONFIG.BombArmReach * 1.5) {
        predOffset = auth;
      }
      // Same target + integration the host uses (sim.js stepPlaying).
      let tx = mouse.x - seat.x, ty = mouse.y - seat.y;
      const len = Math.hypot(tx, ty);
      const target = len > 0.001
        ? (r => ({ x: tx / len * r, y: ty / len * r }))(Math.min(len, CONFIG.BombArmReach))
        : { x: 0, y: 0 };
      const dt = Math.min(dtMs, 100) / 1000;
      const dx = target.x - predOffset.x, dy = target.y - predOffset.y;
      const stepLen = Math.hypot(dx, dy);
      const maxStep = CONFIG.BombArmMoveSpeed * (me.armBuffed ? CONFIG.ReinforcedArmSpeedMult : 1) * dt;
      if (!st.primaryFire) {
        predOffset = (stepLen <= maxStep || stepLen < 0.001)
          ? target
          : { x: predOffset.x + dx / stepLen * maxStep, y: predOffset.y + dy / stepLen * maxStep };
      }
      outBomb = Object.assign({}, snap.bomb, { x: seat.x + predOffset.x, y: seat.y + predOffset.y });
      predHolder = true;
    } else {
      predOffset = null;
      predHolder = false;
    }

    // Aim: once I've armed a weapon locally, show its pose + sight line pointing
    // at the live mouse immediately, rather than waiting for the host to echo my
    // equip back; also keep an already-confirmed weapon/magnify tracking live.
    const chargeAiming = !!(you && you.chargedWeapon && snap.phase === "playing" &&
      armedSlot == null && !iAmHolder && !you.holdsFake);
    if (chargeAiming) {
      const auth = (me.aimX != null) ? { x: me.aimX, y: me.aimY } : mouse;
      if (!predDeadAim ||
          Math.hypot(predDeadAim.x - auth.x, predDeadAim.y - auth.y) > CONFIG.ChargedShotAimSpeed) {
        predDeadAim = auth;
      }
      // Keep predicting the slowed aim through the release frame while the
      // latest host snapshot still says the shot is charged/held.
      if (st.primaryFire || you.chargedWeaponCharging) {
        const dt = Math.min(dtMs, 100) / 1000;
        const dx = mouse.x - predDeadAim.x, dy = mouse.y - predDeadAim.y;
        const len = Math.hypot(dx, dy);
        const maxStep = CONFIG.ChargedShotAimSpeed * dt;
        predDeadAim = (len <= maxStep || len < 0.001)
          ? mouse
          : { x: predDeadAim.x + dx / len * maxStep, y: predDeadAim.y + dy / len * maxStep };
      } else {
        predDeadAim = mouse;
      }
      outMe = Object.assign({}, me, { aimX: predDeadAim.x, aimY: predDeadAim.y });
    } else {
      predDeadAim = null;
    }

    const armedNow = armedSlot != null && you && you.alive && snap.phase === "playing" && !iAmHolder;
    if (armedNow) {
      outMe = Object.assign({}, me, { equipped: true, aimX: mouse.x, aimY: mouse.y });
    } else if (!chargeAiming && (me.equipped || me.revealing)) {
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
    autoBuyStatus: $("autoBuyStatus"),
    eventLog: $("eventLog"),
    cardCodex: $("cardCodex"),
    codexTitle: $("codexTitle"),
    debugPanel: $("debugPanel"),
    matchOverBar: $("matchOverBar"),
    matchOverText: $("matchOverText"),
    btnRematch: $("btnRematch"),
    btnToLobby: $("btnToLobby"),
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

  // While the primary button is held we capture the pointer, which means
  // browsers may dispatch movement as `pointermove` instead of `mousemove`.
  // Keep feeding the live cursor into the collector so the charged sling can
  // continue its deliberately slow authoritative tracking during charge.
  canvas.addEventListener("pointermove", e => {
    const p = canvasPoint(e);
    collector.setMouse(p.x, p.y);
  });

  // Primary mouse is contextual: free hands charge the universal sling shot,
  // holding a bomb taunts, and an armed machine gun fires continuously.
  canvas.addEventListener("pointerdown", e => {
    const you = latestSnap && latestSnap.you;
    if (e.button !== 0 || !you || latestSnap.phase !== "playing") return;
    const p = canvasPoint(e);
    collector.setMouse(p.x, p.y);
    const cardId = armedSlot != null && you.hand[armedSlot];
    if (cardId && Cards.TYPES[cardId].gunStyle === "auto") {
      collector.setGunFireSlot(armedSlot);
    } else if (armedSlot == null) {
      collector.setPrimaryFire(true);
    }
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  const releasePrimary = () => {
    collector.setPrimaryFire(false);
    collector.setGunFireSlot(null);
  };
  canvas.addEventListener("pointerup", releasePrimary);
  canvas.addEventListener("pointercancel", releasePrimary);
  window.addEventListener("blur", releasePrimary);

  // Projectile cards need a deliberate aim: selecting one "arms" it, and each
  // canvas click fires one shot toward the click point (so a stray
  // hand-panel click can't fire it toward wherever the mouse last happened
  // to be). Gun cards hold several separate shots — the card stays armed
  // across clicks until every shot is fired. Canceling before any shot is
  // fired is free; canceling after at least one shot forfeits the rest (the
  // card is discarded). Non-projectile cards (shield/curse/speed/magnify)
  // still use instantly.
  let armedSlot = null;
  let armedSlotVersion = null;

  function clearArmed() {
    armedSlot = null;
    armedSlotVersion = null;
    collector.setEquip(null);
    collector.setGunFireSlot(null);
  }

  // If the currently armed slot already has an in-progress multi-shot gun
  // (at least one round fired), leaving it behind discards the remainder.
  function deactivateArmed() {
    const you = latestSnap && latestSnap.you;
    if (armedSlot != null && you && you.gunPending && you.gunPending.slot === armedSlot) {
      collector.pressDiscard(armedSlot);
    }
    clearArmed();
  }

  function activateCard(slot) {
    const you = latestSnap && latestSnap.you;
    const cardId = you && you.hand[slot];
    if (!cardId) return;
    if (["projectile", "grapple"].includes(Cards.TYPES[cardId].kind)) {
      // Both hands are full holding a bomb (real or fake) — the holder
      // can't wield a weapon too. But once it's been thrown and is in
      // flight, their hands are free again even though isHolder hasn't
      // flipped yet.
      const reallyHolding = (you.isHolder && !(latestSnap.bomb && latestSnap.bomb.transferring)) || you.holdsFake;
      if (reallyHolding) return;
      if (armedSlot === slot) { deactivateArmed(); return; }
      deactivateArmed(); // switching weapons forfeits whatever was mid-burst
      armedSlot = slot;
      armedSlotVersion = you.handSlotVersions ? you.handSlotVersions[slot] : 0;
      collector.setEquip(armedSlot);
    } else {
      collector.pressUse(slot);
    }
  }

  function cancelAim() { deactivateArmed(); }

  canvas.addEventListener("click", e => {
    if (armedSlot == null) return;
    const you = latestSnap && latestSnap.you;
    const cardId = you && you.hand[armedSlot];
    if (cardId && Cards.TYPES[cardId].gunStyle === "auto") return;
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
    if (e.code === "Space") { e.preventDefault(); pressSpace(); }
    else if (e.code === "Digit1") activateCard(0);
    else if (e.code === "Digit2") activateCard(1);
    else if (e.code === "Digit3") activateCard(2);
    else if (e.code === "Digit4") activateCard(3);
    else if (e.code === "Digit5") activateCard(4);
  });

  $("btnPass").onclick = () => pressSpace();
  $("chkDebug").onchange = e => collector.setDebug(e.target.checked);

  // ---- Render loop (shared by host and client) ----

  function frame() {
    const nowMs = performance.now();
    const dtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;

    if (screens["screen-game"].classList.contains("active") && latestSnap) {
      // Drop the armed card if it left the hand (used elsewhere, discarded,
      // died, or the phase changed) so the UI never shows a stale aim state.
      const you = latestSnap.you;
      if (!you || latestSnap.phase !== "playing") releasePrimary();
      const reallyHolding = you && ((you.isHolder && !(latestSnap.bomb && latestSnap.bomb.transferring)) || you.holdsFake);
      const armedCardWasReplaced = armedSlot != null && you && you.handSlotVersions &&
        you.handSlotVersions[armedSlot] !== armedSlotVersion;
      if (armedSlot != null &&
          (!you || !you.hand[armedSlot] || armedCardWasReplaced ||
            reallyHolding || latestSnap.phase !== "playing")) {
        clearArmed();
      }
      canvas.style.cursor = armedSlot != null ? "pointer" : "crosshair";

      // Host draws its own 60Hz sim raw. Clients draw the newest snapshot with
      // only the local player's own arm/aim predicted forward from the mouse.
      const predictedSnap = role === "client" ? applyLocalPrediction(latestSnap, dtMs) : latestSnap;
      const viewSnap = withLocalParry(predictedSnap, nowMs);

      GameAudio.sync(viewSnap);
      const hoverPt = collector.peek();
      Render.draw(ctx, viewSnap, myId, hoverPt.mx != null ? { x: hoverPt.mx, y: hoverPt.my } : null);
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
    GameAudio.reset();
    dom.eventLog.innerHTML = "";
    predOffset = null;
    predHolder = false;
    localParry = null;
    seenParryTransfers.clear();
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
      onSnapshot: acceptSnapshot,
    });
    renderSeats($("hostSeatList"), [{ id: "P0", name: playerName(), isBot: false }]);
    $("hostPlayerName").value = playerName();
    buildPoolChecks();
    buildTeamCountSelect();
  };

  $("hostPlayerName").addEventListener("input", () => {
    setSavedName($("hostPlayerName").value.trim());
    if (hostSession) hostSession.renameSelf($("hostPlayerName").value.trim());
  });

  function buildTeamCountSelect() {
    const sel = $("teamCountSelect");
    sel.innerHTML = "";
    for (const n of CONFIG.TeamCountOptions) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n <= 1 ? "Free-for-all" : `${n} Teams`;
      if (n === CONFIG.DefaultTeamCount) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => hostSession.setTeamCount(Number(sel.value));
  }

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
  $("btnToLobby").onclick = () => { if (hostSession) { hostSession.toLobby(); show("host-lobby"); } };

  // ---- Join flow ----

  $("btnGoJoin").onclick = () => {
    $("joinName").value = playerName();
    show("join");
    $("joinStatus").textContent = "";
  };

  // Shared by the manual join screen and join-by-link: connects straight into
  // the client lobby, falling back to the join screen (with the code and
  // name prefilled) if the room can't be reached.
  function startJoin(code, name) {
    role = "client";
    show("client-lobby");
    $("clientPlayerName").value = name;
    $("clientConnectStatus").textContent = "Connecting…";
    renderSeats($("clientSeatList"), []);
    $("clientTeamInfo").textContent = "";

    function fallbackToJoinScreen(message) {
      show("join");
      $("joinCode").value = code;
      $("joinName").value = name;
      $("joinStatus").textContent = message;
    }

    clientSession = Client.createSession({
      code,
      name,
      collector,
      onWelcome: id => { myId = id; $("clientConnectStatus").textContent = ""; },
      onReject: reason => fallbackToJoinScreen("Rejected: " + reason),
      onLobby: (roster, pool, teamCount) => {
        renderSeats($("clientSeatList"), roster);
        $("clientTeamInfo").textContent = teamCount > 1 ? `Team Mode: ${teamCount} Teams` : "Free-for-all";
      },
      onStart: enterGame,
      onReturnToLobby: () => show("client-lobby"),
      onSnapshot: acceptSnapshot,
      onClosed: () => {
        alert("Disconnected from host.");
        location.reload();
      },
      onError: err => fallbackToJoinScreen("Error: " + (err && err.type ? err.type : err)),
    });
  }

  $("clientPlayerName").addEventListener("input", () => {
    setSavedName($("clientPlayerName").value.trim());
    if (clientSession) clientSession.rename($("clientPlayerName").value.trim());
  });

  $("btnLeaveLobby").onclick = () => {
    if (clientSession) { clientSession.destroy(); clientSession = null; }
    role = null;
    myId = null;
    if (location.search) history.replaceState(null, "", location.pathname);
    show("menu");
  };

  $("btnJoinConnect").onclick = () => {
    const code = $("joinCode").value.trim();
    if (!code) { $("joinStatus").textContent = "Enter a room code."; return; }
    startJoin(code, joinPlayerName());
  };

  // ---- Join-by-link ----
  // A host's share link is `?room=CODE`; land straight in the client lobby
  // using the player's saved name, so a guest clicking the link needs no
  // extra steps to get in (they can still rename themselves in the lobby).
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) {
    startJoin(roomParam, playerName());
  }
})();
