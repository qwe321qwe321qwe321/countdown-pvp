"use strict";

// Thin PeerJS wrapper (WebRTC data channels signaled through the public
// PeerJS cloud broker). The host claims a peer id derived from a short room
// code; clients connect to that id. All payloads are plain JSON-able objects.
const Net = (() => {
  const PREFIX = "cdpvp-";

  function makeCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  // cb: { onReady(code), onError(err), onMessage(peerId, msg), onLeave(peerId) }
  function createHost(cb) {
    const code = makeCode();
    const peer = new Peer(PREFIX + code);
    const conns = new Map(); // peerId -> DataConnection

    peer.on("open", () => cb.onReady(code));
    peer.on("error", err => cb.onError(err));

    peer.on("connection", conn => {
      conn.on("open", () => conns.set(conn.peer, conn));
      conn.on("data", data => cb.onMessage(conn.peer, data));
      conn.on("close", () => {
        conns.delete(conn.peer);
        cb.onLeave(conn.peer);
      });
    });

    return {
      code,
      sendTo(peerId, msg) {
        const c = conns.get(peerId);
        if (c && c.open) c.send(msg);
      },
      broadcast(msg) {
        for (const c of conns.values()) if (c.open) c.send(msg);
      },
      close() { peer.destroy(); },
    };
  }

  // cb: { onOpen(), onMessage(msg), onClose(), onError(err) }
  function createClient(code, cb) {
    const peer = new Peer();
    let conn = null;

    peer.on("open", () => {
      conn = peer.connect(PREFIX + code.trim().toUpperCase(), { reliable: true });
      conn.on("open", () => cb.onOpen());
      conn.on("data", data => cb.onMessage(data));
      conn.on("close", () => cb.onClose());
      conn.on("error", err => cb.onError(err));
    });
    peer.on("error", err => cb.onError(err));

    return {
      send(msg) { if (conn && conn.open) conn.send(msg); },
      close() { peer.destroy(); },
    };
  }

  return { createHost, createClient };
})();
