"use strict";

// Client session: never runs the sim. Sends the local input buffer to the
// host at a fixed rate and hands every received snapshot to the UI.
const Client = (() => {
  // opts: {
  //   code, name,
  //   collector,              // local input collector (shared shape with host)
  //   onWelcome(playerId), onReject(reason),
  //   onLobby(roster, pool, teamCount), onStart(), onSnapshot(snap),
  //   onReturnToLobby(),      // host ended the match and reopened the lobby
  //   onClosed(), onError(err),
  // }
  function createSession(opts) {
    let sendTimer = null;

    const net = Net.createClient(opts.code, {
      onOpen: () => net.send({ type: "hello", name: opts.name }),
      onMessage: msg => {
        switch (msg.type) {
          case "welcome":
            opts.onWelcome(msg.playerId);
            startSending();
            break;
          case "reject": opts.onReject(msg.reason); break;
          case "lobby": opts.onLobby(msg.roster, msg.pool, msg.teamCount); break;
          case "start": opts.onStart(); break;
          case "tolobby": opts.onReturnToLobby && opts.onReturnToLobby(); break;
          case "snap": opts.onSnapshot(msg.snap); break;
        }
      },
      onClose: () => { stopSending(); opts.onClosed(); },
      onError: err => opts.onError(err),
    });

    function startSending() {
      sendTimer = setInterval(() => {
        net.send({ type: "input", input: opts.collector.take() });
      }, 1000 / CONFIG.InputSendRate);
    }

    function stopSending() {
      if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    }

    return {
      destroy() { stopSending(); net.close(); },
      rename(name) { net.send({ type: "rename", name }); },
    };
  }

  return { createSession };
})();
