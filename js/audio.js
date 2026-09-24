/* LIMBO — generative ambient audio. Zero audio files.
 *
 * A slow evolving pad (detuned oscillators -> lowpass w/ LFO -> feedback
 * delay) plus soft pentatonic plucks when echoes are collected.
 * Each scene retunes the pad to its own root note.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.oscs = [];
    this.currentRoot = 110;
    this._auraDucked = false; // set pre-init if the game starts in the sound room
    this._lastAuraRamp = null; // {target, timeConstant} — test seam proving ramps, not hard cuts
  }

  /* Must be called from a user gesture (the "click to drift" button). */
  init(rootFreq = 110) {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.currentRoot = rootFreq;

    // Master — kept low, fades in gently. This is the GAME master: jam
    // instruments, metronome, sampler and UI-adjacent audio all land here.
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Aura bus — the generative ambient pad (and echo chimes) live here so
    // the aura can be ducked independently of everything else on the master.
    this.aura = ctx.createGain();
    this.aura.gain.value = this._auraDucked ? 0 : 1;
    this.aura.connect(this.master);

    // Pad bus -> lowpass filter (the "air" of the room).
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 620;
    this.filter.Q.value = 0.8;

    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0; // Build 85: the drone is gone — pad bus muted.
    this.padBus.connect(this.filter);
    this.filter.connect(this.aura);

    // Slow LFO sweeping the filter cutoff — the pad "breathes".
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt);
    lfoAmt.connect(this.filter.frequency);
    lfo.start();

    // Feedback delay for cavernous space.
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.36;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    this.filter.connect(this.delay);
    this.delay.connect(fb);
    fb.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.aura);

    // Build 85: the drone is gone — pad bus muted above, voices not started.

    // Fade the master in over a couple of seconds — no clicks.
    this.master.gain.setTargetAtTime(0.16, ctx.currentTime, 1.8);
    this.started = true;
  }

  /* Glide the whole pad to a new root note (dreamy, slow). */
  setRoot(freq) {
    this.currentRoot = freq;
    if (!this.started) return;
    const t = this.ctx.currentTime;
    for (const { osc, mul } of this.oscs) {
      osc.frequency.setTargetAtTime(freq * mul, t, 1.4);
    }
  }

  /* Duck (or restore) the aura layer — used entering/leaving the sound room.
   * cancelScheduledValues + setTargetAtTime: rapid toggles never stack
   * ramps and never click. Pre-init calls are remembered and applied in init()
   * (aura starts muted, no fade needed). Everything on this.master (jam,
   * metronome, decks, jukebox, mute toggle) is untouched. */
  setAuraDucked(ducked, fadeSec = 1.5) {
    this._auraDucked = !!ducked;
    if (!this.started || !this.aura) return;
    const t = this.ctx.currentTime;
    const tc = Math.max(0.05, fadeSec / 3); // ~95% of the way there within fadeSec
    this.aura.gain.cancelScheduledValues(t);
    this.aura.gain.setTargetAtTime(this._auraDucked ? 0 : 1, t, tc);
    this._lastAuraRamp = { target: this._auraDucked ? 0 : 1, timeConstant: tc };
  }

  /* Soft pluck on echo pickup. `step` climbs a pentatonic ladder so
   * consecutive pickups always sound consonant. */
  chime(step) {
    if (!this.started || this.muted) return;
    const ctx = this.ctx;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];
    const i = (step - 1) % scale.length;
    const oct = Math.floor((step - 1) / scale.length);
    const f = 523.25 * Math.pow(2, scale[i] / 12) * Math.pow(2, Math.min(oct, 1));

    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(g);
    g.connect(this.aura);
    g.connect(this.delay); // let it bloom in the cavern
    o.start(t);
    o.stop(t + 1.8);
  }

  toggleMute() {
    if (!this.started) return this.muted;
    this.muted = !this.muted;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.16, t, 0.2);
    return this.muted;
  }
}
