/* LIMBO — jam room core (build 13).
 *
 * Pure music math + DSP: tempo estimation, onset detection, note
 * scheduling helpers, and the pocket-synth voice. No DOM, no net —
 * game.js wires this into the UI and the Trystero jam actions.
 *
 * THE LATENCY TRICK (why this feels tight): instrument audio is NEVER
 * streamed. Tiny note/pad events ride the data channel and EVERY client
 * synthesizes the sound locally with WebAudio, scheduled against the
 * shared beat clock. Your own notes play instantly (zero latency for
 * you); everyone else's land quantized on the grid. ~500ms of network
 * jitter disappears into the quantization.
 */

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* Next grid line at or after `beat`. grid is in beats (0.25 = 16th). */
export function quantizeUp(beat, grid) {
  if (!Number.isFinite(beat) || !Number.isFinite(grid) || grid <= 0) return beat;
  return Math.ceil(beat / grid - 1e-9) * grid;
}

/* Tempo from onset times (seconds). Method: median inter-onset interval
 * of plausible beat IOIs, octave-snapped into 70–180 BPM. Dance music
 * onsets cluster on the beat grid, so the median IOI is usually a beat
 * (or a clean subdivision, which the snapping fixes). Returns null when
 * there isn't enough data to trust. Honest v1 — not a full beat tracker. */
export function estimateBpm(onsets, min = 70, max = 180) {
  if (!onsets || onsets.length < 8) return null;
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.15 && d < 1.2) iois.push(d);
  }
  if (iois.length < 6) return null;
  iois.sort((a, b) => a - b);
  const med = iois[Math.floor(iois.length / 2)];
  let bpm = 60 / med;
  while (bpm < min) bpm *= 2;
  while (bpm > max) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/* Energy-flux onset detector. Feed it the DJ stream's analyser once a
 * second (or so); it keeps a sliding ~12s window of onset times for
 * estimateBpm(). Works with any object exposing getByteFrequencyData()
 * and frequencyBinCount — which is also what makes it unit-testable
 * with a fake analyser. */
export class OnsetDetector {
  constructor() {
    this.buf = null;
    this.prev = null;
    this.onsets = [];
    this.avg = 0;
  }
  reset() {
    this.onsets = [];
    this.avg = 0;
    this.prev = null;
  }
  process(analyser) {
    try {
      const n = analyser.frequencyBinCount;
      if (!this.buf || this.buf.length !== n) {
        this.buf = new Uint8Array(n);
        this.prev = new Float32Array(n);
      }
      analyser.getByteFrequencyData(this.buf);
      // Spectral flux over the low-mid bins — kicks and bass live here.
      // (The game's analyser runs fftSize 64 = 32 coarse bins; good
      // enough for v1, not a studio detector.)
      let flux = 0;
      const K = Math.min(n, 24);
      for (let i = 1; i < K; i++) {
        const d = this.buf[i] - this.prev[i];
        if (d > 0) flux += d;
        this.prev[i] = this.buf[i];
      }
      this.avg = this.avg * 0.92 + flux * 0.08;
      const now = performance.now() / 1000;
      const last = this.onsets.length ? this.onsets[this.onsets.length - 1] : -10;
      if (flux > Math.max(18, this.avg * 1.9) && now - last > 0.09) {
        this.onsets.push(now);
      }
      while (this.onsets.length && now - this.onsets[0] > 12) this.onsets.shift();
    } catch (e) {
      /* detection must never break the game */
    }
    return this.onsets;
  }
}

/* The pocket synth voice (build 39: deeper).
 * Two detuned oscillators (waveform selectable) + an optional sine sub an
 * octave down, through a lowpass filter with its own envelope (cutoff +
 * env amount + decay), a shaping amp envelope (attack/decay), optional
 * portamento glide for mono-style leads, and per-voice echo sends that tap
 * the game's delay + reverb directly (the dotted-eighth psy-lead sound).
 * Every note spawns fresh nodes — no voice stealing, so overlapping notes
 * from several jammers just layer. `time` is an AudioContext timestamp.
 * All new opts are optional with musical defaults, so older {w,c,r} patches
 * from the room render exactly as before. */
/* Diagnostic: how many synth voices are alive right now. */
export function synthVoiceCount() {
  return SYNTH_VOICES.size;
}

/* ---------------- build 63: the real synth ----------------
 * Vital-style voice: 2 oscillators + sub, resonant lowpass with its own
 * ADSR, amp ADSR, LFO to pitch and filter, glide. synthNoteOn returns a
 * voice id; synthNoteOff releases it. Hold a key = sustain; lift = release.
 * playSynthNote stays as the one-shot wrapper (remote notes, sequencers). */
const SYNTH_VOICES = new Map();
let _synthVoiceId = 1;
const SYNTH_MAX_VOICES = 12;
function synthPrune() {
  if (SYNTH_VOICES.size < SYNTH_MAX_VOICES) return;
  let oldest = null, oldestT = Infinity;
  for (const [id, v] of SYNTH_VOICES) {
    if (v.t < oldestT) { oldestT = v.t; oldest = id; }
  }
  if (oldest != null) synthNoteOff(null, oldest, 0, true);
}
function synthEnv(param, t, peak, a, d, s) {
  // Attack -> decay -> sustain (held). Returns time when sustain is reached.
  const atk = Math.max(0.002, Math.min(2, a));
  const dec = Math.max(0.02, Math.min(4, d));
  const sus = Math.max(0, Math.min(1, s));
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(0.0011, peak), t + atk);
  param.exponentialRampToValueAtTime(Math.max(0.0011, peak * sus), t + atk + dec);
  return t + atk + dec;
}
export function synthNoteOn(ctx, dest, opts) {
  const {
    midi = 60, vel = 0.9, time = 0,
    osc1 = null, osc2 = null, // {wave, oct, detune, level}
    sub = 0,
    cutoff = 1800, reso = 5, keytrack = 0.5,
    fAmt = 0.35, fA = 0.01, fD = 0.25, fS = 0.4, fR = 0.25,
    aA = 0.008, aD = 0.3, aS = 0.7, aR = 0.3,
    lfoRate = 5, lfoPitch = 0, lfoFilter = 0, // lfoPitch in cents, lfoFilter 0..1
    glide = 0, fromFreq = 0,
    echo = 0, sends = null,
  } = opts || {};
  try {
    synthPrune();
    const t = Math.max(time || 0, ctx.currentTime);
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const f = midiToFreq(m);
    const v = clampVel(vel);
    const o1 = { wave: 'sawtooth', oct: 0, detune: 0, level: 0.85, ...(osc1 || {}) };
    const o2 = { wave: 'sawtooth', oct: 0, detune: 8, level: 0.0, ...(osc2 || {}) };
    // Filter: base cutoff with keytrack, plus its own ADSR opening by fAmt.
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    const kt = Math.pow(2, ((m - 60) / 12) * Math.max(0, Math.min(1, keytrack)));
    const cut = Math.max(80, Math.min(12000, cutoff * kt));
    const fPeak = Math.min(14000, cut + Math.max(0, Math.min(1, fAmt)) * 7000);
    flt.Q.value = Math.max(0, Math.min(15, reso));
    flt.frequency.setValueAtTime(cut, t);
    // Filter envelope: opens to fPeak, settles to cut+fAmt*sustain portion.
    const fSusF = cut + (fPeak - cut) * Math.max(0, Math.min(1, fS));
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, fPeak), t + Math.max(0.005, fA));
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, fSusF), t + Math.max(0.005, fA) + Math.max(0.03, fD));
    // Amp ADSR.
    const amp = ctx.createGain();
    const peak = 0.3 * v;
    synthEnv(amp.gain, t, peak, aA, aD, aS);
    const mkOsc = (wave, freqMul, detune, level) => {
      if (level <= 0.005) return null;
      const o = ctx.createOscillator();
      o.type = ['sawtooth', 'square', 'triangle', 'sine'].includes(wave) ? wave : 'sawtooth';
      const ff = f * freqMul;
      if (glide > 0.005 && fromFreq > 20) {
        o.frequency.setValueAtTime(Math.min(12000, fromFreq * freqMul), t);
        o.frequency.exponentialRampToValueAtTime(Math.min(12000, ff), t + glide);
      } else {
        o.frequency.value = ff;
      }
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og); og.connect(flt);
      o.start(t);
      return o;
    };
    const oscs = [];
    const w1 = mkOsc(o1.wave, Math.pow(2, o1.oct || 0), o1.detune || 0, o1.level);
    if (w1) oscs.push(w1);
    const w2 = mkOsc(o2.wave, Math.pow(2, o2.oct || 0), o2.detune || 0, o2.level);
    if (w2) oscs.push(w2);
    const subAmt = Math.max(0, Math.min(1, sub));
    if (subAmt > 0.01) {
      const ws = mkOsc('sine', 0.5, 0, subAmt * 0.6);
      if (ws) oscs.push(ws);
    }
    // LFO: sine -> pitch (cents) and filter (Hz, bipolar around base).
    let lfo = null;
    const lp = Math.max(0, Math.min(1200, lfoPitch));
    const lf = Math.max(0, Math.min(1, lfoFilter));
    if ((lp > 1 || lf > 0.01) && lfoRate > 0.05) {
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = Math.max(0.05, Math.min(30, lfoRate));
      if (lp > 1) {
        const lg = ctx.createGain(); lg.gain.value = lp;
        lfo.connect(lg);
        for (const o of oscs) { try { lg.connect(o.detune); } catch (e) {} }
      }
      if (lf > 0.01) {
        const fg = ctx.createGain(); fg.gain.value = lf * 2500;
        lfo.connect(fg);
        try { fg.connect(flt.frequency); } catch (e) {}
      }
      lfo.start(t);
    }
    flt.connect(amp);
    amp.connect(dest);
    const echoAmt = Math.max(0, Math.min(1, echo || 0));
    if (echoAmt > 0.01 && Array.isArray(sends)) {
      for (const s of sends) {
        if (!s || !s.node) continue;
        const sg = ctx.createGain();
        sg.gain.value = echoAmt * Math.max(0, Math.min(1, Number(s.gain) || 0.5));
        amp.connect(sg);
        try { sg.connect(s.node); } catch (e) { try { sg.disconnect(); } catch (e2) {} }
      }
    }
    const id = _synthVoiceId++;
    SYNTH_VOICES.set(id, {
      id, t, oscs, flt, amp, lfo,
      aR: Math.max(0.02, Math.min(3, aR)),
      fR: Math.max(0.02, Math.min(3, fR)),
      fSusF, peak, aS: Math.max(0, Math.min(1, aS)),
      released: false,
    });
    return id;
  } catch (e) { return 0; }
}
export function synthNoteOff(ctx, id, when = 0, steal = false) {
  const v = SYNTH_VOICES.get(id);
  if (!v) return;
  SYNTH_VOICES.delete(id);
  try {
    const t = Math.max(when || 0, ctx ? ctx.currentTime : 0);
    const rel = steal ? 0.03 : v.aR;
    const fRel = steal ? 0.03 : v.fR;
    // Hold the live value, then glide to silence.
    for (const p of [v.amp.gain, v.flt.frequency]) {
      try {
        if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
        else p.cancelScheduledValues(t);
      } catch (e) {}
    }
    v.amp.gain.setTargetAtTime(0.0001, t, Math.max(0.008, rel / 4));
    v.flt.frequency.setTargetAtTime(Math.max(40, v.fSusF * 0.5), t, Math.max(0.008, fRel / 4));
    const stopAt = t + rel + 0.15;
    for (const o of v.oscs) { try { o.stop(stopAt); } catch (e) {} }
    if (v.lfo) { try { v.lfo.stop(stopAt); } catch (e) {} }
  } catch (e) { /* ignore */ }
}
export function synthAllOff(ctx) {
  for (const id of [...SYNTH_VOICES.keys()]) synthNoteOff(ctx, id, 0);
}

/* ---------------- synth FX insert (build 64) ----------------
 * The synth's own pedalboard: clipper -> delay -> limiter.
 * Voices land on `input`; connect `output` (the limiter) to the bus.
 * Sensible and efficient: one waveshaper, one delay line, one
 * fast compressor — all created once, then just knob-turns. */
function makeClipCurve(drive) {
  const n = 256;
  const curve = new Float32Array(n);
  const k = 1 + drive * 24; // 0 = clean, 1 = smashed
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k * 0.7) * 0.7;
  }
  return curve;
}
export function createSynthFx(ctx) {
  const input = ctx.createGain();
  const clipper = ctx.createWaveShaper();
  clipper.oversample = '2x';
  const postClip = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const delay = ctx.createDelay(2.0);
  const fb = ctx.createGain();
  const dlySend = ctx.createGain();
  const dlyWet = ctx.createGain();
  input.connect(clipper);
  clipper.connect(postClip);
  postClip.connect(limiter);
  postClip.connect(dlySend); dlySend.connect(delay);
  delay.connect(fb); fb.connect(delay);
  delay.connect(dlyWet); dlyWet.connect(limiter);
  const fx = {
    input, output: limiter, nodes: { clipper, delay, fb, dlySend, dlyWet },
    drive: 0, dlyMix: 0.25, dlyFb: 0.35, dlyDiv: 0.75, bpm: 120,
    setDrive(v) {
      this.drive = Math.max(0, Math.min(1, Number(v) || 0));
      try { clipper.curve = makeClipCurve(this.drive); } catch (e) {}
    },
    setDelay(mix, fbAmt, div) {
      if (mix != null) this.dlyMix = Math.max(0, Math.min(1, Number(mix)));
      if (fbAmt != null) this.dlyFb = Math.max(0, Math.min(0.92, Number(fbAmt)));
      if (div != null) this.dlyDiv = Number(div) || 0.75;
      const t = ctx.currentTime;
      try {
        dlyWet.gain.setTargetAtTime(this.dlyMix * 0.9, t, 0.03);
        fb.gain.setTargetAtTime(this.dlyFb, t, 0.03);
        delay.delayTime.setTargetAtTime((60 / this.bpm) * this.dlyDiv, t, 0.05);
      } catch (e) {}
    },
    updateTempo(bpm) {
      this.bpm = Math.max(40, Math.min(220, Number(bpm) || 120));
      this.setDelay(null, null, null);
    },
  };
  fx.setDrive(0);
  fx.setDelay(0.25, 0.35, 0.75);
  return fx;
}

/* One-shot wrapper: the pocket synth the room already knows. Implemented
 * on the real voice — note on, then auto-release after the decay. Reads
 * both the legacy flat patch and the build-63 full patch. */
export function playSynthNote(ctx, dest, opts) {
  const o = opts || {};
  const spread = Number(o.spread) || 0;
  const wave = o.wave || 'sawtooth';
  const id = synthNoteOn(ctx, dest, {
    ...o,
    osc1: { wave, oct: 0, detune: -spread / 2, level: 0.85 },
    osc2: {
      wave: o.wave2 || (wave === 'mix' ? 'square' : wave),
      oct: 0, detune: spread / 2,
      level: o.osc2mix != null ? o.osc2mix : (wave === 'mix' ? 0.7 : 0.85),
    },
    aA: o.attack, aD: o.decay,
    aS: o.sustain != null ? o.sustain : 0.55,
    aR: o.release != null ? o.release : Math.max(0.15, (o.decay || 0.4) * 0.6),
    fAmt: o.env, fA: 0.008, fD: (o.decay || 0.4) * 1.2, fS: 0.35, fR: 0.2,
    lfoRate: o.lfoRate || 5, lfoPitch: o.lfoPitch || 0, lfoFilter: o.lfoFilter || 0,
  });
  if (id) {
    const hold = Math.max(0.05, (o.attack || 0.008) + (o.decay || 0.4));
    const ctxRef = ctx;
    setTimeout(() => synthNoteOff(ctxRef, id, 0), hold * 1000);
  }
}

/* ---------------- build 20: instruments, space, metronome ----------------
 * Four instruments share the jam bus: LEAD (the pocket synth above),
 * BASS (sub), DRUMS (synthesized kit), PAD (chord stabs). Plus a generated
 * impulse response for the room reverb and a metronome click. All pure
 * DSP — game.js owns the bus graph, UI, and net. */

function clampVel(v) {
  return Math.max(0.05, Math.min(1.2, Number(v) || 0.9));
}

/* Cached 1s white-noise buffer (shared by every drum hit — cheap). */
let _noiseBuf = null;
let _noiseRate = 0;
export function getNoiseBuffer(ctx) {
  if (_noiseBuf && _noiseRate === ctx.sampleRate) return _noiseBuf;
  const len = ctx.sampleRate;
  _noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  _noiseRate = ctx.sampleRate;
  return _noiseBuf;
}

/* Generated stereo impulse response: decaying noise, no audio files. */
export function makeImpulseResponse(ctx, seconds = 1.9, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * Math.max(0.2, seconds)));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* BASS: sine + triangle, one octave below the played key, through a
 * lowpass with a punchy pluck envelope. Sub you feel in your chest. */
export function playBassNote(ctx, dest, opts) {
  const { midi = 48, vel = 0.9, time = 0 } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const f = midiToFreq(Math.max(0, Math.min(127, Math.round(midi))) - 12);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 520;
    flt.Q.value = 2;
    const g = ctx.createGain();
    const peak = 0.5 * clampVel(vel);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak + 0.001, t + 0.012);
    g.gain.exponentialRampToValueAtTime(peak * 0.6 + 0.001, t + 0.14);
    g.gain.setTargetAtTime(0.0001, t + 0.32, 0.09);
    for (const [type, detune] of [['sine', 0], ['triangle', 5]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(flt);
      o.start(t);
      o.stop(t + 1.0);
    }
    flt.connect(g);
    g.connect(dest);
  } catch (e) { /* a missed note is better than a crashed frame */ }
}

/* DRUMS: fully synthesized kit. kick = sine pitch drop, snare/clap =
 * filtered noise + body, hats/shaker = highpassed noise. */
/* DRUM KITS (build 63): every pad carries a kit of variations — real
 * synthesized "samples" with distinct character. renderDrumKits() bakes
 * each variation to an AudioBuffer once (offline); pads then trigger
 * buffer playback: instant, consistent, zero downloads. variant 0 of
 * each kit is the legacy voice, so old code and old peers keep working. */
export const DRUM_KITS = {
  kick: [
    { name: 'punch', hits: [
      { k: 'tone', type: 'sine', f0: 155, f1: 44, dur: 0.26, peak: 0.95 },
      { k: 'noise', fType: 'highpass', freq: 4000, q: 0.7, dur: 0.03, peak: 0.25 } ] },
    { name: 'boom', hits: [
      { k: 'tone', type: 'sine', f0: 120, f1: 36, dur: 0.55, peak: 1.0 } ] },
    { name: 'hard', hits: [
      { k: 'tone', type: 'sine', f0: 165, f1: 40, dur: 0.22, peak: 1.0, drive: 14 },
      { k: 'noise', fType: 'highpass', freq: 5200, q: 0.7, dur: 0.02, peak: 0.3 } ] },
    { name: 'soft', hits: [
      { k: 'tone', type: 'sine', f0: 130, f1: 55, dur: 0.18, peak: 0.7 } ] },
  ],
  snare: [
    { name: 'crack', hits: [
      { k: 'noise', fType: 'bandpass', freq: 1900, q: 0.9, dur: 0.17, peak: 0.6 },
      { k: 'tone', type: 'triangle', f0: 196, f1: 150, dur: 0.11, peak: 0.35 } ] },
    { name: 'deep', hits: [
      { k: 'noise', fType: 'bandpass', freq: 1200, q: 0.8, dur: 0.22, peak: 0.65 },
      { k: 'tone', type: 'triangle', f0: 150, f1: 105, dur: 0.16, peak: 0.45 } ] },
    { name: 'tight', hits: [
      { k: 'noise', fType: 'bandpass', freq: 2600, q: 1.0, dur: 0.11, peak: 0.55 },
      { k: 'tone', type: 'triangle', f0: 230, f1: 180, dur: 0.08, peak: 0.3 } ] },
    { name: 'rim', hits: [
      { k: 'noise', fType: 'highpass', freq: 4500, q: 0.8, dur: 0.04, peak: 0.5 },
      { k: 'tone', type: 'square', f0: 800, f1: 700, dur: 0.03, peak: 0.22 } ] },
  ],
  clap: [
    { name: 'clap', hits: [
      { k: 'noise', fType: 'bandpass', freq: 1300, q: 1.4, dur: 0.09, peak: 0.5 },
      { k: 'noise', fType: 'bandpass', freq: 1300, q: 1.4, dur: 0.09, peak: 0.5, at: 0.014 },
      { k: 'noise', fType: 'bandpass', freq: 1300, q: 1.4, dur: 0.2, peak: 0.55, at: 0.028 } ] },
    { name: 'snap', hits: [
      { k: 'noise', fType: 'bandpass', freq: 2200, q: 1.6, dur: 0.06, peak: 0.5 },
      { k: 'noise', fType: 'bandpass', freq: 2200, q: 1.6, dur: 0.12, peak: 0.55, at: 0.012 } ] },
  ],
  chat: [
    { name: 'tight', hits: [
      { k: 'noise', fType: 'highpass', freq: 8200, q: 0.7, dur: 0.05, peak: 0.32 } ] },
    { name: 'crisp', hits: [
      { k: 'noise', fType: 'highpass', freq: 9600, q: 0.7, dur: 0.04, peak: 0.3 } ] },
    { name: 'dark', hits: [
      { k: 'noise', fType: 'highpass', freq: 6800, q: 0.7, dur: 0.06, peak: 0.32 } ] },
    { name: 'tick', hits: [
      { k: 'noise', fType: 'highpass', freq: 9000, q: 0.9, dur: 0.025, peak: 0.28 } ] },
  ],
  ohat: [
    { name: 'open', hits: [
      { k: 'noise', fType: 'highpass', freq: 7600, q: 0.7, dur: 0.32, peak: 0.3 } ] },
    { name: 'long', hits: [
      { k: 'noise', fType: 'highpass', freq: 7200, q: 0.7, dur: 0.55, peak: 0.28 } ] },
    { name: 'wash', hits: [
      { k: 'noise', fType: 'highpass', freq: 6500, q: 0.6, dur: 0.4, peak: 0.25, attack: 0.02 } ] },
  ],
  shaker: [
    { name: 'shake', hits: [
      { k: 'noise', fType: 'highpass', freq: 6200, q: 0.8, dur: 0.11, peak: 0.22, attack: 0.012 } ] },
    { name: 'soft', hits: [
      { k: 'noise', fType: 'highpass', freq: 5500, q: 0.8, dur: 0.14, peak: 0.18, attack: 0.02 } ] },
    { name: 'tamb', hits: [
      { k: 'noise', fType: 'highpass', freq: 7500, q: 0.9, dur: 0.09, peak: 0.25, attack: 0.008 },
      { k: 'noise', fType: 'bandpass', freq: 10000, q: 2.0, dur: 0.05, peak: 0.15 } ] },
  ],
};
export const JAM_DRUMS = ['kick', 'snare', 'clap', 'chat', 'ohat', 'shaker'];
function drumVariant(drum, vi) {
  const kit = DRUM_KITS[drum];
  if (!kit || !kit.length) return null;
  return kit[Math.max(0, Math.min(kit.length - 1, vi | 0))];
}
export function drumVariantName(drum, vi) {
  const v = drumVariant(drum, vi);
  return v ? v.name : '';
}
export function drumVariantCount(drum) {
  const kit = DRUM_KITS[drum];
  return kit ? kit.length : 0;
}
export function playDrum(ctx, dest, opts) {
  const { drum = 'kick', variant = 0, vel = 0.9, time = 0 } = opts || {};
  const v = drumVariant(drum, variant);
  if (!v) return;
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const vv = clampVel(vel);
    const noise = getNoiseBuffer(ctx);
    const noiseHit = (t0, dur, fType, freq, q, peak, attack = 0.002) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = fType;
      flt.frequency.value = freq;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0011, peak * vv), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(flt); flt.connect(g); g.connect(dest);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    };
    const toneHit = (t0, dur, type, f0, f1, peak, drive = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(20, f0), t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0011, peak * vv), t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (drive > 0.5) {
        const ws = ctx.createWaveShaper();
        const curve = new Float32Array(256);
        const amt = Math.max(1, Math.min(40, drive));
        for (let i = 0; i < 256; i++) {
          const x = i / 128 - 1;
          curve[i] = Math.tanh(amt * x) / Math.tanh(amt * 0.5) * 0.5;
        }
        ws.curve = curve;
        o.connect(ws); ws.connect(g);
      } else {
        o.connect(g);
      }
      g.connect(dest);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    };
    for (const h of v.hits) {
      const at = t + (h.at || 0);
      if (h.k === 'tone') toneHit(at, h.dur, h.type, h.f0, h.f1, h.peak, h.drive || 0);
      else noiseHit(at, h.dur, h.fType, h.freq, h.q, h.peak, h.attack || 0.002);
    }
  } catch (e) { /* ignore */ }
}

/* Bake every kit variation to an AudioBuffer (offline, once). Pads then
 * play buffers — sample-trigger feel, zero CPU per hit, zero downloads. */
let _drumBufs = null;
export async function renderDrumKits(ctx) {
  if (_drumBufs) return _drumBufs;
  const out = {};
  for (const drum of JAM_DRUMS) {
    out[drum] = [];
    const n = drumVariantCount(drum);
    for (let vi = 0; vi < n; vi++) {
      try {
        const len = Math.max(1, Math.ceil(ctx.sampleRate * 1.2));
        const oc = new OfflineAudioContext(1, len, ctx.sampleRate);
        const g = oc.createGain();
        g.connect(oc.destination);
        playDrum(oc, g, { drum, variant: vi, vel: 1, time: 0.01 });
        out[drum].push(await oc.startRendering());
      } catch (e) { out[drum].push(null); }
    }
  }
  _drumBufs = out;
  return out;
}
export function drumKitBuffers() { return _drumBufs; }
/* Trigger a baked sample. Falls back to live synthesis if the kits
 * haven't rendered yet (or the variant is missing). */
export function playDrumSample(ctx, dest, opts) {
  const { drum = 'kick', variant = 0, vel = 0.9, time = 0 } = opts || {};
  const buf = _drumBufs && _drumBufs[drum] && _drumBufs[drum][variant | 0];
  if (!buf) { playDrum(ctx, dest, opts); return; }
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = clampVel(vel);
    src.connect(g); g.connect(dest);
    src.start(t);
  } catch (e) { playDrum(ctx, dest, opts); }
}

/* PAD: i–VI–III–VII triads in A minor. Detuned saws, slow attack,
 * per-note stereo spread — wide and weightless. */
export const JAM_CHORDS = [
  { name: 'Am', numeral: 'i', midi: [57, 60, 64] },
  { name: 'F', numeral: 'VI', midi: [53, 57, 60] },
  { name: 'C', numeral: 'III', midi: [55, 60, 64] },
  { name: 'G', numeral: 'VII', midi: [55, 59, 62] },
];
export function playPadChord(ctx, dest, opts) {
  const { chord = 0, vel = 0.8, time = 0 } = opts || {};
  const ch = JAM_CHORDS[chord] || JAM_CHORDS[0];
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const v = clampVel(vel);
    ch.midi.forEach((m, i) => {
      const f = midiToFreq(m);
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 950;
      flt.Q.value = 0.7;
      const g = ctx.createGain();
      const peak = 0.15 * v;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak + 0.001, t + 0.7); // slow bloom
      g.gain.setValueAtTime(peak + 0.001, t + 1.6);
      g.gain.setTargetAtTime(0.0001, t + 1.7, 0.5);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = i % 2 ? 0.28 : -0.28; // subtle width
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(flt);
        o.start(t);
        o.stop(t + 3.4);
      }
      flt.connect(g);
      if (pan) { g.connect(pan); pan.connect(dest); }
      else g.connect(dest);
    });
  } catch (e) { /* ignore */ }
}

/* Personal metronome click: accented on beat 1. Short square blip,
 * local-only — game.js never broadcasts it. */
export function jamMetroClick(ctx, dest, opts) {
  const { time = 0, accent = false, vol = 0.5 } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = accent ? 1568 : 1046;
    const g = ctx.createGain();
    const peak = Math.max(0.0011, (accent ? 0.32 : 0.2) * Math.max(0, Math.min(1, vol)));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.09);
  } catch (e) { /* ignore */ }
}
