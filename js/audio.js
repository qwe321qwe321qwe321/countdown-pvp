"use strict";

// Lightweight procedural audio for the whole game. Everything is synthesized
// with Web Audio, so the prototype keeps its no-build, no-asset-loading setup.
const GameAudio = (() => {
  const PREF_KEY = "countdown-pvp:audio";
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const defaults = { music: true, sfx: true, volume: 0.72 };
  let prefs = defaults;
  try {
    prefs = Object.assign({}, defaults, JSON.parse(localStorage.getItem(PREF_KEY) || "{}"));
  } catch (_) {}

  let ctx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let compressor = null;
  let noiseBuffer = null;
  let scheduler = null;
  let nextStepAt = 0;
  let musicStep = 0;
  let scene = "menu";
  let gamePhase = null;
  let lastEventSeq = null;
  let lastEffectSeq = null;
  let lastPhase = null;
  let lastCountdown = null;
  let lastParryState = null;

  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function save() {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  }

  function updateMix(immediate) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const set = (node, value) => {
      if (immediate) node.gain.setValueAtTime(value, t);
      else node.gain.setTargetAtTime(value, t, 0.025);
    };
    set(master, Math.pow(prefs.volume, 1.35));
    set(musicBus, prefs.music ? 0.24 : 0);
    set(sfxBus, prefs.sfx ? 0.7 : 0);
  }

  function makeNoiseBuffer() {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  function init() {
    if (ctx || !AudioContextClass) return;
    ctx = new AudioContextClass();
    master = ctx.createGain();
    musicBus = ctx.createGain();
    sfxBus = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    musicBus.connect(master);
    sfxBus.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);
    makeNoiseBuffer();
    updateMix(true);
    nextStepAt = ctx.currentTime + 0.06;
    scheduler = window.setInterval(scheduleMusic, 40);
  }

  function unlock() {
    init();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().then(() => {
        nextStepAt = ctx.currentTime + 0.06;
      }).catch(() => {});
    }
  }

  function envelope(gain, when, duration, peak, attack) {
    const a = Math.max(0.002, attack || 0.008);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  }

  function synth(bus, frequency, duration, options) {
    if (!ctx) return;
    const o = Object.assign({
      type: "sine", gain: 0.12, when: ctx.currentTime,
      slide: null, attack: 0.008, detune: 0,
    }, options || {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(Math.max(20, frequency), o.when);
    if (o.slide != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slide), o.when + duration);
    }
    osc.detune.value = o.detune;
    envelope(gain, o.when, duration, o.gain, o.attack);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(o.when);
    osc.stop(o.when + duration + 0.03);
  }

  function noise(duration, options) {
    if (!ctx || !noiseBuffer) return;
    const o = Object.assign({
      gain: 0.12, when: ctx.currentTime, frequency: 1600,
      type: "bandpass", attack: 0.003,
    }, options || {});
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noiseBuffer;
    filter.type = o.type;
    filter.frequency.value = o.frequency;
    filter.Q.value = 0.8;
    envelope(gain, o.when, duration, o.gain, o.attack);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(sfxBus);
    src.start(o.when);
    src.stop(o.when + duration + 0.03);
  }

  function play(name) {
    if (!ctx || !prefs.sfx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    switch (name) {
      case "ui":
        synth(sfxBus, 430, 0.045, { type: "triangle", gain: 0.055, when: t, slide: 520 });
        break;
      case "tick":
        synth(sfxBus, 720, 0.09, { type: "square", gain: 0.09, when: t, slide: 610 });
        break;
      case "go":
        synth(sfxBus, 440, 0.18, { type: "square", gain: 0.09, when: t });
        synth(sfxBus, 660, 0.28, { type: "triangle", gain: 0.12, when: t + 0.08 });
        break;
      case "reveal":
        synth(sfxBus, 185, 0.34, { type: "sawtooth", gain: 0.08, when: t, slide: 370 });
        synth(sfxBus, 554, 0.28, { type: "sine", gain: 0.08, when: t + 0.12 });
        break;
      case "throw":
        noise(0.16, { gain: 0.12, when: t, frequency: 900 });
        synth(sfxBus, 230, 0.17, { type: "triangle", gain: 0.08, when: t, slide: 390 });
        break;
      case "catch":
        synth(sfxBus, 145, 0.13, { type: "sine", gain: 0.18, when: t, slide: 92 });
        noise(0.06, { gain: 0.06, when: t, frequency: 500, type: "lowpass" });
        break;
      case "shoot":
        noise(0.07, { gain: 0.2, when: t, frequency: 2100 });
        synth(sfxBus, 190, 0.09, { type: "square", gain: 0.13, when: t, slide: 82 });
        break;
      case "hit":
        synth(sfxBus, 115, 0.14, { type: "square", gain: 0.13, when: t, slide: 62 });
        noise(0.08, { gain: 0.09, when: t, frequency: 680, type: "lowpass" });
        break;
      case "card":
        synth(sfxBus, 330, 0.13, { type: "triangle", gain: 0.1, when: t, slide: 495 });
        synth(sfxBus, 660, 0.12, { type: "sine", gain: 0.07, when: t + 0.06 });
        break;
      case "coin":
        synth(sfxBus, 1180, 0.09, { type: "sine", gain: 0.1, when: t });
        synth(sfxBus, 1580, 0.13, { type: "sine", gain: 0.08, when: t + 0.055 });
        break;
      case "shield":
        synth(sfxBus, 220, 0.38, { type: "sine", gain: 0.12, when: t, slide: 880 });
        synth(sfxBus, 940, 0.3, { type: "sine", gain: 0.06, when: t + 0.05, slide: 620 });
        break;
      case "blackout":
        synth(sfxBus, 150, 0.55, { type: "sawtooth", gain: 0.1, when: t, slide: 38 });
        break;
      case "reverse":
        for (let i = 0; i < 4; i++) {
          synth(sfxBus, [330, 440, 554, 740][i], 0.12, {
            type: "triangle", gain: 0.07, when: t + i * 0.055,
          });
        }
        break;
      case "fakeboom":
        synth(sfxBus, 520, 0.12, { type: "square", gain: 0.09, when: t, slide: 180 });
        noise(0.18, { gain: 0.12, when: t + 0.02, frequency: 1500 });
        synth(sfxBus, 980, 0.25, { type: "sine", gain: 0.07, when: t + 0.1, slide: 1400 });
        break;
      case "explosion":
        noise(0.9, { gain: 0.36, when: t, frequency: 240, type: "lowpass", attack: 0.006 });
        synth(sfxBus, 105, 0.75, { type: "sawtooth", gain: 0.27, when: t, slide: 27 });
        synth(sfxBus, 58, 1.0, { type: "sine", gain: 0.24, when: t + 0.05, slide: 30 });
        break;
      case "parry":
        synth(sfxBus, 680, 0.15, { type: "square", gain: 0.12, when: t, slide: 1220 });
        synth(sfxBus, 1360, 0.24, { type: "sine", gain: 0.1, when: t + 0.08 });
        break;
      case "punish":
        synth(sfxBus, 180, 0.28, { type: "sawtooth", gain: 0.13, when: t, slide: 70 });
        break;
      case "win":
        [60, 64, 67, 72].forEach((note, i) => {
          synth(sfxBus, midi(note), 0.42, {
            type: "triangle", gain: 0.1, when: t + i * 0.13, attack: 0.012,
          });
        });
        break;
    }
  }

  function scheduleMusic() {
    if (!ctx || ctx.state !== "running") return;
    if (nextStepAt < ctx.currentTime - 0.5) nextStepAt = ctx.currentTime + 0.05;
    while (nextStepAt < ctx.currentTime + 0.22) {
      scheduleMusicStep(nextStepAt, musicStep++);
      const bpm = scene === "game"
        ? (gamePhase === "playing" ? 112 : 92)
        : 78;
      nextStepAt += 60 / bpm / 2;
    }
  }

  // A rematch stays on the game screen, so it does not pass through the
  // normal enterGame audio setup. Rebuild the scheduler at the start of the
  // next match and resume a browser-suspended context if necessary.
  function restartMusicTimeline() {
    init();
    if (!ctx) return;
    const restart = () => {
      if (scheduler != null) window.clearInterval(scheduler);
      musicStep = 0;
      nextStepAt = ctx.currentTime + 0.06;
      scheduler = window.setInterval(scheduleMusic, 40);
    };
    if (ctx.state === "suspended") ctx.resume().then(restart).catch(() => {});
    else restart();
  }

  function scheduleMusicStep(when, step) {
    if (!prefs.music) return;
    const playing = scene === "game";
    const roots = playing ? [45, 45, 48, 43] : [48, 48, 51, 46];
    const root = roots[Math.floor(step / 8) % roots.length];
    const scale = playing ? [0, 3, 7, 10, 12, 10, 7, 3] : [0, 7, 10, 7, 3, 7, 10, 12];
    if (step % 4 === 0) {
      synth(musicBus, midi(root - 12), playing ? 0.58 : 0.9, {
        type: "triangle", gain: playing ? 0.18 : 0.12, when, attack: 0.025,
      });
    }
    if (step % 2 === 0) {
      const note = root + scale[step % scale.length];
      synth(musicBus, midi(note), playing ? 0.2 : 0.38, {
        type: playing ? "square" : "sine",
        gain: playing ? 0.035 : 0.05,
        when,
        attack: playing ? 0.008 : 0.04,
        detune: step % 4 === 0 ? -4 : 4,
      });
    }
    if (playing && gamePhase === "playing" && step % 2 === 1) {
      // A tiny synthesized hi-hat. Kept on the music bus so the BGM toggle
      // silences the entire rhythm bed.
      const src = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      src.buffer = noiseBuffer;
      filter.type = "highpass";
      filter.frequency.value = 6200;
      envelope(gain, when, 0.035, 0.025, 0.002);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(musicBus);
      src.start(when);
      src.stop(when + 0.05);
    }
  }

  function soundForEvent(text) {
    if (/is passing the bomb/.test(text)) return "throw";
    if (/received the bomb|starts with the bomb|bomb moved to/.test(text)) return "catch";
    if (/fired |launched a charged shot/.test(text)) return "shoot";
    if (/SHIELD BLOCKED|DISPLAY JAMMED| SEC$|grappled the bomb/.test(text)) return "hit";
    if (/SHIELD ACTIVATED/.test(text)) return "shield";
    if (/LIGHTS OUT/.test(text)) return "blackout";
    if (/PASSING REVERSED|PASSING RESTORED/.test(text)) return "reverse";
    if (/auto-bought/.test(text)) return "coin";
    if (/used |ACTIVATED|equipped |pulled out a bomb/.test(text)) return "card";
    if (/WINS THE MATCH|wins the match/.test(text)) return "win";
    if (/BOMB TIME/.test(text)) return "reveal";
    return null;
  }

  function sync(snap) {
    if (!snap) return;
    gamePhase = snap.phase;

    if (lastEventSeq == null) {
      lastEventSeq = snap.events.reduce((n, ev) => Math.max(n, ev.seq), 0);
      lastEffectSeq = (snap.effects || []).reduce((n, ef) => Math.max(n, ef.seq), 0);
      lastPhase = snap.phase;
      lastCountdown = snap.phase === "countdown" ? Math.ceil(snap.phaseTimer) : null;
      lastParryState = snap.you && snap.you.parry ? snap.you.parry.state : null;
      return;
    }

    if (lastPhase === "matchover" && snap.phase === "reveal") {
      restartMusicTimeline();
    }

    if (snap.phase !== lastPhase) {
      if (snap.phase === "countdown") {
        lastCountdown = Math.ceil(snap.phaseTimer);
        play("tick");
      } else if (snap.phase === "playing") {
        play("go");
      } else if (snap.phase === "exploding") {
        play("explosion");
      }
      lastPhase = snap.phase;
    }
    if (snap.phase === "countdown") {
      const count = Math.ceil(snap.phaseTimer);
      if (count !== lastCountdown && count > 0) play("tick");
      lastCountdown = count;
    }

    for (const ev of snap.events) {
      if (ev.seq <= lastEventSeq) continue;
      const sound = soundForEvent(ev.text);
      if (sound) play(sound);
      lastEventSeq = Math.max(lastEventSeq, ev.seq);
    }
    for (const ef of snap.effects || []) {
      if (ef.seq <= lastEffectSeq) continue;
      if (ef.type === "fakeboom") play("fakeboom");
      else if (ef.type === "coinstolen") play("coin");
      lastEffectSeq = Math.max(lastEffectSeq, ef.seq);
    }

    const parryState = snap.you && snap.you.parry ? snap.you.parry.state : null;
    if (parryState !== lastParryState) {
      if (parryState === "success") play("parry");
      else if (parryState === "punished") play("punish");
      lastParryState = parryState;
    }
  }

  function reset() {
    lastEventSeq = null;
    lastEffectSeq = null;
    lastPhase = null;
    lastCountdown = null;
    lastParryState = null;
  }

  function setScene(next) {
    scene = next === "game" ? "game" : "menu";
    if (ctx) nextStepAt = Math.max(nextStepAt, ctx.currentTime + 0.03);
  }

  function setupControls() {
    const musicButton = document.getElementById("btnMusic");
    const sfxButton = document.getElementById("btnSfx");
    const volume = document.getElementById("audioVolume");
    if (!musicButton || !sfxButton || !volume) return;

    function refresh() {
      musicButton.textContent = prefs.music ? "♫ BGM" : "♫ BGM Off";
      sfxButton.textContent = prefs.sfx ? "🔊 SFX" : "🔇 SFX Off";
      musicButton.classList.toggle("active", prefs.music);
      sfxButton.classList.toggle("active", prefs.sfx);
      musicButton.setAttribute("aria-pressed", String(prefs.music));
      sfxButton.setAttribute("aria-pressed", String(prefs.sfx));
      volume.value = String(Math.round(prefs.volume * 100));
    }

    musicButton.addEventListener("click", () => {
      unlock();
      prefs.music = !prefs.music;
      save();
      updateMix();
      refresh();
    });
    sfxButton.addEventListener("click", () => {
      unlock();
      prefs.sfx = !prefs.sfx;
      save();
      updateMix();
      refresh();
      if (prefs.sfx) play("ui");
    });
    volume.addEventListener("input", () => {
      unlock();
      prefs.volume = clamp(Number(volume.value) / 100, 0, 1);
      save();
      updateMix();
    });
    document.addEventListener("click", e => {
      if (e.target.closest("button") && !e.target.closest("#audioControls")) play("ui");
    });
    refresh();
  }

  document.addEventListener("pointerdown", unlock, { once: true, capture: true });
  document.addEventListener("keydown", unlock, { once: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else ctx.resume().then(() => { nextStepAt = ctx.currentTime + 0.06; }).catch(() => {});
  });
  setupControls();

  return { play, reset, setScene, sync, unlock };
})();
