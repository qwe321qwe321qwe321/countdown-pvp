// Entry point: collects local input, asks the AI for its input, and feeds both
// into the host-authoritative sim. In a networked build this file would instead
// send the local input to the host and render the host's synced state.
(function () {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const sim = createSim();

  const keys = new Set();
  const mouse = { x: CONFIG.ARENA_W / 2, y: CONFIG.ARENA_H / 2, left: false, right: false };

  window.addEventListener('keydown', e => {
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
    mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
  });
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) mouse.left = true;
    if (e.button === 2) mouse.right = true;
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 0) mouse.left = false;
    if (e.button === 2) mouse.right = false;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  function humanInput() {
    return {
      moveX: (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
      moveY: (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0),
      aimX: mouse.x,
      aimY: mouse.y,
      shootMinus: mouse.left,
      shootPlus: mouse.right,
      shield: keys.has('Space'),
    };
  }

  // Fixed-timestep sim (60 Hz) with rAF rendering.
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= STEP) {
      const inputs = {
        0: humanInput(),
        1: getAIInput(sim, sim.players[1]),
      };
      stepSim(sim, inputs, STEP);
      acc -= STEP;
    }
    render(ctx, sim);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
