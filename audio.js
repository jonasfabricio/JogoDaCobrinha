// Sons e música do Labirinto 3D, sintetizados com Web Audio (sem arquivos de áudio).
// O navegador só libera o áudio depois de um clique/toque, por isso tudo começa em Sfx.unlock().
window.Sfx = (() => {
  let ctx = null, master = null, sfxBus = null, musicBus = null;
  let muted = loadMuted();
  let musicMode = null, musicTimer = 0, nextNoteTime = 0, step = 0;

  function loadMuted() { try { return localStorage.getItem("labirinto-mute") === "1"; } catch { return false; } }
  function saveMuted() { try { localStorage.setItem("labirinto-mute", muted ? "1" : "0"); } catch {} }

  function unlock() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.5;
      sfxBus.connect(master);
      // música passa por um passa-baixa para ficar macia, de fundo
      const soften = ctx.createBiquadFilter();
      soften.type = "lowpass";
      soften.frequency.value = 1500;
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      musicBus.connect(soften).connect(master);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  const midi = (n) => 440 * 2 ** ((n - 69) / 12);

  // Uma nota curta com envelope (ataque rápido, queda exponencial) e deslize opcional de frequência.
  function tone(freq, dur = 0.15, type = "sine", vol = 0.4, delay = 0, slideTo = null, out = sfxBus) {
    if (!ctx) return;
    const t = ctx.currentTime + Math.max(0, delay);
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // Ruído filtrado (impactos).
  let noiseBuffer = null;
  function noise(dur = 0.2, vol = 0.3, freq = 1000, delay = 0) {
    if (!ctx) return;
    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(vol, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(band).connect(env).connect(sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  const arpeggio = (notes, gap, dur, type, vol) => notes.forEach((n, i) => tone(midi(n), dur, type, vol, i * gap));

  const effects = {
    gem: (combo = 1) => { const n = 76 + (combo - 1) * 2; tone(midi(n), 0.12, "triangle", 0.35); tone(midi(n + 7), 0.2, "triangle", 0.3, 0.06); },
    power: () => { tone(midi(84), 0.5, "sine", 0.3, 0, midi(96)); tone(midi(91), 0.5, "triangle", 0.2, 0.05, midi(103)); },
    smash: () => { noise(0.18, 0.5, 900); tone(170, 0.22, "square", 0.22, 0, 55); },
    hurt: () => { tone(220, 0.4, "sawtooth", 0.3, 0, 65); noise(0.25, 0.3, 350); },
    key: () => arpeggio([72, 76, 79, 84], 0.07, 0.22, "triangle", 0.3),
    locked: () => { tone(150, 0.1, "square", 0.18); tone(115, 0.16, "square", 0.18, 0.1); },
    win: () => { arpeggio([72, 76, 79, 84, 88], 0.09, 0.3, "triangle", 0.3); tone(midi(96), 0.7, "sine", 0.22, 0.45); },
    gameOver: () => arpeggio([67, 63, 60, 55], 0.18, 0.45, "sawtooth", 0.16),
    achievement: () => arpeggio([79, 83, 86, 91], 0.08, 0.28, "sine", 0.3),
  };

  /* ---------- Música ambiente ----------
     Arpejo em lá menor. As notas são agendadas pelo relógio do Web Audio (preciso);
     o setInterval só "enche a fila" ~0,4 s à frente. */
  const PATTERNS = {
    normal: { step: 0.22, notes: [57, 60, 64, 67, 69, 67, 64, 60], bass: [45, 45, 41, 41, 43, 43, 40, 40] },
    dark: { step: 0.4, notes: [45, 48, 51, null, 50, 48, null, 44], bass: [33, 33, 33, 33, 32, 32, 32, 32] },
  };

  function scheduleMusic() {
    if (!ctx || !musicMode) return;
    const P = PATTERNS[musicMode];
    if (nextNoteTime < ctx.currentTime - 0.1) nextNoteTime = ctx.currentTime + 0.05; // aba voltou do segundo plano
    while (nextNoteTime < ctx.currentTime + 0.4) {
      const i = step % P.notes.length;
      const delay = nextNoteTime - ctx.currentTime;
      if (P.notes[i] !== null) tone(midi(P.notes[i]), P.step * 1.6, "triangle", 0.5, delay, null, musicBus);
      if (i % 2 === 0) tone(midi(P.bass[i]), P.step * 2.2, "sine", 0.6, delay, null, musicBus);
      nextNoteTime += P.step;
      step++;
    }
  }

  // "normal" | "dark" | null (para)
  function music(mode) {
    if (!ctx || mode === musicMode) return;
    musicMode = mode;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setTargetAtTime(mode ? 0.16 : 0, t, 0.3);
    if (mode && !musicTimer) {
      nextNoteTime = t + 0.1;
      step = 0;
      musicTimer = setInterval(scheduleMusic, 100);
    }
    if (!mode && musicTimer) { clearInterval(musicTimer); musicTimer = 0; }
  }

  /* ---------- Mudo ---------- */
  const button = document.querySelector("#mute");
  function renderMute() {
    button.textContent = muted ? "🔇" : "🔊";
    button.title = muted ? "Ligar som (M)" : "Desligar som (M)";
    button.setAttribute("aria-pressed", String(muted));
  }
  function toggleMute() {
    muted = !muted;
    saveMuted();
    renderMute();
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
  }
  button.addEventListener("click", () => { unlock(); toggleMute(); button.blur(); });
  renderMute();

  return { unlock, music, toggleMute, ...effects };
})();
