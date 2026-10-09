#!/usr/bin/env node
// Synthesizes the app sounds (ringtone, ringback, cues) from code, so they are
// original, reproducible and free of rights. Pure Node, no dependency: every
// voice is rendered sample by sample and written as 16-bit WAV.
//
//   node scripts/sounds/generate.mjs [--out dir] [--only name,name] [--repeat n] [--variants]
//
// Writes WAV masters; scripts/sounds/encode.sh turns them into the shipped files.
//
// Looped sounds (ringtone, ringback) are rendered circularly: a note's tail past
// the loop end wraps to its start, and every LFO period divides the loop length,
// so the loop has no seam.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SR = 48000;
const TAU = Math.PI * 2;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// 'C4' -> 60, 'F#3' -> 54, 'Bb2' -> 46
function midi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

class Mix {
  constructor(seconds, { loop = false } = {}) {
    this.n = Math.round(seconds * SR);
    this.loop = loop;
    this.l = new Float64Array(this.n);
    this.r = new Float64Array(this.n);
    this.seconds = seconds;
  }
  add(i, l, r) {
    if (this.loop) i %= this.n;
    else if (i >= this.n) return;
    this.l[i] += l;
    this.r[i] += r;
  }
}

const panGains = (pan) => {
  const a = ((pan + 1) / 4) * Math.PI;
  return [Math.cos(a), Math.sin(a)];
};

// Shared tape wobble and stereo tremolo, both functions of absolute time.
function feel(loopSeconds, { wow = 0.0018, trem = 0.22 } = {}) {
  // Periods snapped to the loop so the loop stays seamless.
  const snap = (hz) => (loopSeconds ? Math.max(1, Math.round(hz * loopSeconds)) / loopSeconds : hz);
  const wowHz = snap(0.55);
  const tremHz = snap(4.5);
  return {
    wow: (t) => 1 + wow * Math.sin(TAU * wowHz * t),
    trem: (t) => trem * Math.sin(TAU * tremHz * t),
  };
}

// Rhodes-like electric piano: 1:1 FM with a decaying index, plus the tine's
// short metallic partial. Tremolo pans it gently left and right.
function epiano(mix, fx, at, dur, note, vel = 0.8, pan = 0, { bright = 1 } = {}) {
  const m = typeof note === 'string' ? midi(note) : note;
  const f = mtof(m);
  const decay = Math.min(2.6, Math.max(0.9, 1.4 + (60 - m) * 0.035));
  const len = Math.round((dur + 1.4) * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  let pc = 0;
  let pt = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const abs = at + t;
    const w = fx.wow(abs);
    pc += (f * w) / SR;
    pt += (f * 14.02 * w) / SR;
    const index = bright * vel * (1.5 * Math.exp(-t * 4.5) + 0.3);
    let s = Math.sin(TAU * pc + index * Math.sin(TAU * pc));
    s += Math.sin(TAU * pt) * Math.exp(-t * 28) * 0.1 * vel * bright;
    const release = t > dur ? Math.exp(-(t - dur) * 9) : 1;
    const env = (1 - Math.exp(-t * 350)) * Math.exp(-t * decay) * release;
    const tr = fx.trem(abs);
    const v = s * env * vel * 0.32;
    mix.add(start + i, v * gl * (1 + tr), v * gr * (1 - tr));
  }
}

// Marimba: the bar's inharmonic partials, each with its own decay, and a mallet tick.
function marimba(mix, fx, at, note, vel = 0.8, pan = 0) {
  const f = mtof(midi(note));
  const parts = [
    [1, 1, 5.5],
    [3.93, 0.32, 18],
    [9.24, 0.1, 42],
  ];
  const len = Math.round(1.3 * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  const ph = parts.map(() => 0);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const w = fx.wow(at + t);
    let s = 0;
    for (let k = 0; k < parts.length; k++) {
      const [ratio, amp, dec] = parts[k];
      if (ratio * f > 18000) continue;
      ph[k] += (f * ratio * w) / SR;
      s += Math.sin(TAU * ph[k]) * amp * Math.exp(-t * dec);
    }
    const v = s * (1 - Math.exp(-t * 900)) * vel * 0.4;
    mix.add(start + i, v * gl, v * gr);
  }
}

// Kalimba: a bright FM tine (ratio 3.5) that settles into a pure tone.
function kalimba(mix, fx, at, note, vel = 0.8, pan = 0) {
  const f = mtof(midi(note));
  const len = Math.round(2.2 * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const w = fx.wow(at + t);
    pc += (f * w) / SR;
    pm += (f * 3.5 * w) / SR;
    const index = 2.2 * Math.exp(-t * 14);
    const s = Math.sin(TAU * pc + index * Math.sin(TAU * pm));
    const env = (1 - Math.exp(-t * 1200)) * Math.exp(-t * 2.6);
    const v = s * env * vel * 0.34;
    mix.add(start + i, v * gl, v * gr);
  }
}

// Band-limited saw by additive synthesis, through a moving low-pass.
function sawVoice(mix, fx, at, dur, note, vel, pan, { cutoff, attack = 0.005, release = 0.25, detune = 0, gain = () => 1, partials = 40 }) {
  const f = mtof(midi(note)) * 2 ** (detune / 1200);
  const len = Math.round((dur + release * 5) * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  const n = Math.max(1, Math.min(partials, Math.floor(16000 / f)));
  let p = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const abs = at + t;
    p += (f * fx.wow(abs)) / SR;
    const fc = cutoff(t);
    let s = 0;
    for (let k = 1; k <= n; k++) {
      const x = (k * f) / fc;
      s += Math.sin(TAU * k * p) / k / (1 + x * x * x * x);
    }
    const rel = t > dur ? Math.exp(-(t - dur) / release) : 1;
    const env = Math.min(1, t / attack) * rel;
    const v = s * env * vel * 0.18 * gain(abs);
    mix.add(start + i, v * gl, v * gr);
  }
}

function bass(mix, fx, at, dur, note, vel = 0.8) {
  const f = mtof(midi(note));
  const len = Math.round((dur + 0.4) * SR);
  const start = Math.round(at * SR);
  let p = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    p += (f * fx.wow(at + t)) / SR;
    const s = Math.sin(TAU * p) + 0.22 * Math.sin(TAU * 2 * p) + 0.06 * Math.sin(TAU * 3 * p);
    const rel = t > dur ? Math.exp(-(t - dur) * 14) : 1;
    const env = (1 - Math.exp(-t * 220)) * Math.exp(-t * 1.1) * rel;
    const v = s * env * vel * 0.36;
    mix.add(start + i, v, v);
  }
}

function kick(mix, at, vel = 0.8) {
  const len = Math.round(0.5 * SR);
  const start = Math.round(at * SR);
  let p = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    p += (46 + 85 * Math.exp(-t * 32)) / SR;
    const v = Math.sin(TAU * p) * Math.exp(-t * 8.5) * vel * 0.55;
    mix.add(start + i, v, v);
  }
}

// Noise percussion through a one-pole high-pass and low-pass.
function noiseHit(mix, rand, at, { len, decay, hp, lp, vel, pan = 0, tone = 0, toneHz = 190, bursts = null }) {
  const n = Math.round(len * SR);
  const start = Math.round(at * SR);
  const [gl, gr] = panGains(pan);
  const ah = Math.exp((-TAU * hp) / SR);
  const al = 1 - Math.exp((-TAU * lp) / SR);
  let xPrev = 0;
  let yh = 0;
  let yl = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = rand() * 2 - 1;
    yh = ah * (yh + x - xPrev);
    xPrev = x;
    yl += al * (yh - yl);
    let env = Math.exp(-t * decay);
    if (bursts) {
      // A clap: a few quick bursts before the tail.
      const k = Math.floor(t / 0.011);
      env = k < bursts ? Math.exp(-(t - k * 0.011) * 160) : Math.exp(-(t - bursts * 0.011) * decay);
    }
    let s = yl * env;
    if (tone) s += Math.sin(TAU * toneHz * t) * Math.exp(-t * 26) * tone;
    const v = s * vel;
    mix.add(start + i, v * gl, v * gr);
  }
}

const snare = (mix, rand, at, vel = 0.5) =>
  noiseHit(mix, rand, at, { len: 0.35, decay: 17, hp: 900, lp: 5200, vel, tone: 0.35 });
const hat = (mix, rand, at, vel = 0.25, pan = 0.3) =>
  noiseHit(mix, rand, at, { len: 0.09, decay: 70, hp: 6500, lp: 14000, vel, pan });
const clap = (mix, rand, at, vel = 0.45) =>
  noiseHit(mix, rand, at, { len: 0.3, decay: 22, hp: 1100, lp: 7000, vel, bursts: 3 });

// Vinyl: sparse crackle and a soft hiss bed, rendered over the whole buffer.
function vinyl(mix, rand, { crackle = 7, hiss = 0.0035 } = {}) {
  let hl = 0;
  let pop = 0;
  for (let i = 0; i < mix.n; i++) {
    if (rand() < crackle / SR) pop += (rand() ** 3) * 0.22 * (rand() < 0.5 ? -1 : 1);
    const c = pop;
    pop *= 0.82;
    hl += 0.08 * ((rand() * 2 - 1) - hl);
    const s = c + hl * hiss * 6;
    mix.add(i, s, s * 0.9);
  }
}

// Master: two one-pole low-passes (warmth), soft saturation, peak normalization.
// A loop is filtered twice so the filter state at its start matches its end.
function master(mix, { lp = 9000, drive = 1.2, peak = 0.89 }) {
  const a = 1 - Math.exp((-TAU * lp) / SR);
  for (const ch of [mix.l, mix.r]) {
    let y1 = 0;
    let y2 = 0;
    const passes = mix.loop ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < mix.n; i++) {
        y1 += a * (ch[i] - y1);
        y2 += a * (y1 - y2);
        // The first pass of a loop only warms the filter state; the input stays dry.
        if (pass === passes - 1) ch[i] = y2;
      }
    }
  }
  let max = 0;
  for (const ch of [mix.l, mix.r]) for (let i = 0; i < mix.n; i++) {
    ch[i] = Math.tanh(ch[i] * drive);
    max = Math.max(max, Math.abs(ch[i]));
  }
  const g = max > 0 ? peak / max : 1;
  for (const ch of [mix.l, mix.r]) for (let i = 0; i < mix.n; i++) ch[i] *= g;
  if (!mix.loop) {
    // Short fade at both ends of a one-shot: no click.
    const f = Math.round(0.004 * SR);
    for (const ch of [mix.l, mix.r]) for (let i = 0; i < f; i++) {
      ch[i] *= i / f;
      ch[mix.n - 1 - i] *= i / f;
    }
  }
  return mix;
}

function wav(mix) {
  const frames = mix.n;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(q(mix.l[i]), 44 + i * 4);
    buf.writeInt16LE(q(mix.r[i]), 46 + i * 4);
  }
  return buf;
}

// Swung eighth: the off-beat lands late, the lo-fi lilt.
const swing = (beat, eighth, amount = 0.12) => beat * eighth * 0.5 + (eighth % 2 ? beat * amount : 0);

// ---------------------------------------------------------------------------
// Ringtone variants

// A. Sunset Keys: lo-fi Rhodes, Fmaj9 Em7 Dm9 Cmaj9, boom-bap, vinyl.
function sunsetKeys() {
  const bpm = 88;
  const beat = 60 / bpm;
  const loop = beat * 8;
  const mix = new Mix(loop, { loop: true });
  const fx = feel(loop);
  const rand = rng(11);
  const chords = [
    ['F2', ['A3', 'C4', 'E4', 'G4']],
    ['E2', ['G3', 'B3', 'D4', 'F#4']],
    ['D2', ['F3', 'A3', 'C4', 'E4']],
    ['C2', ['E3', 'G3', 'B3', 'D4']],
  ];
  chords.forEach(([root, voicing], c) => {
    const at = c * 2 * beat;
    voicing.forEach((n, k) => epiano(mix, fx, at + k * 0.018, beat * 1.7, n, 0.55, -0.3 + k * 0.2));
    bass(mix, fx, at, beat * 1.2, root, 0.85);
    bass(mix, fx, at + swing(beat, 3), beat * 0.4, root, 0.5);
  });
  // The hook: a call that rises, an answer that settles.
  const hook = [
    [0, 'C5'], [1, 'E5'], [2, 'G5'], [3, 'A5'],
    [5, 'G5'], [6, 'E5'],
    [8, 'D5'], [9, 'F#5'], [10, 'A5'], [11, 'B5'],
    [13, 'A5'], [14, 'F#5'],
  ];
  // The second half answers a step lower.
  const answer = [
    [0, 'C5'], [1, 'E5'], [2, 'A5'], [3, 'G5'], [5, 'E5'],
    [8, 'B4'], [9, 'D5'], [10, 'G5'], [11, 'E5'], [13, 'D5'],
  ];
  hook.forEach(([e, n]) => epiano(mix, fx, swing(beat, e), beat * 0.45, n, 0.7, 0.25, { bright: 1.25 }));
  answer.forEach(([e, n]) => epiano(mix, fx, beat * 4 + swing(beat, e), beat * 0.45, n, 0.6, -0.2, { bright: 1.2 }));
  for (let b = 0; b < 8; b++) {
    if (b % 4 === 0) kick(mix, b * beat, 0.8);
    if (b % 4 === 2) kick(mix, b * beat + swing(beat, 1) , 0.55);
    if (b % 2 === 1) snare(mix, rand, b * beat, 0.42);
    hat(mix, rand, b * beat, 0.16);
    hat(mix, rand, b * beat + swing(beat, 1), 0.1, -0.3);
  }
  vinyl(mix, rand);
  return master(mix, { lp: 7200, drive: 1.3 });
}

// B. Pop Bubble: playful marimba hook over a bouncy bass and claps.
function popBubble() {
  const bpm = 112;
  const beat = 60 / bpm;
  const loop = beat * 8;
  const mix = new Mix(loop, { loop: true });
  const fx = feel(loop, { wow: 0.0008, trem: 0.05 });
  const rand = rng(23);
  const hook = [
    [0, 'G5'], [1, 'A5'], [2, 'C6'], [3, 'A5'], [4, 'D6'], [6, 'C6'], [7, 'A5'],
    [8, 'G5'], [9, 'E5'], [10, 'G5'], [11, 'A5'], [12, 'C6'], [14, 'G5'],
  ];
  hook.forEach(([e, n], k) => marimba(mix, fx, e * beat * 0.5, n, 0.8, k % 2 ? 0.35 : -0.35));
  // Echo of the hook, an octave down and softer.
  hook.forEach(([e, n]) => marimba(mix, fx, e * beat * 0.5 + beat * 0.75, n.replace(/\d$/, (d) => String(Number(d) - 1)), 0.3, 0));
  const roots = ['C3', 'A2', 'F2', 'G2'];
  roots.forEach((r, c) => {
    bass(mix, fx, c * 2 * beat, beat * 0.4, r, 0.8);
    bass(mix, fx, c * 2 * beat + beat * 1.5, beat * 0.3, r, 0.6);
  });
  for (let b = 0; b < 8; b++) {
    kick(mix, b * beat, b % 2 ? 0.45 : 0.7);
    if (b % 2 === 1) clap(mix, rand, b * beat, 0.4);
    hat(mix, rand, b * beat + beat * 0.5, 0.14);
  }
  return master(mix, { lp: 13000, drive: 1.15 });
}

// C. Neon Drive: synthwave pad and a pumping arpeggio. The chosen ringtone.
// Without drums and bass, quieter, it is the caller's ringback.
function neonDrive({ drums = true, peak = 0.89 } = {}) {
  const bpm = 100;
  const beat = 60 / bpm;
  const loop = beat * 8;
  const mix = new Mix(loop, { loop: true });
  const fx = feel(loop, { wow: 0.0006, trem: 0 });
  const rand = rng(37);
  const duck = (t) => 1 - 0.6 * Math.exp(-((t % beat) / beat) * 9);
  const chords = [
    ['A2', ['A3', 'C4', 'E4', 'G4']],
    ['F2', ['F3', 'A3', 'C4', 'E4']],
    ['C3', ['G3', 'C4', 'E4', 'G4']],
    ['G2', ['G3', 'B3', 'D4', 'F#4']],
  ];
  chords.forEach(([root, voicing], c) => {
    const at = c * 2 * beat;
    voicing.forEach((n, k) => {
      for (const d of [-9, 9]) {
        sawVoice(mix, fx, at, beat * 2, n, 0.35, d < 0 ? -0.6 : 0.6, {
          cutoff: (t) => 900 + 500 * Math.sin(TAU * 0.25 * t), attack: 0.12, release: 0.3, detune: d + k, gain: duck, partials: 24,
        });
      }
    });
    for (let s = 0; s < 8; s++) {
      const n = voicing[[0, 1, 2, 3, 2, 1, 2, 3][s]].replace(/\d$/, (d) => String(Number(d) + 1));
      sawVoice(mix, fx, at + s * beat * 0.25, beat * 0.2, n, 0.55, s % 2 ? 0.4 : -0.4, {
        cutoff: (t) => 400 + 5200 * Math.exp(-t * 18), release: 0.06, gain: duck, partials: 30,
      });
    }
    if (drums) bass(mix, fx, at, beat * 1.8, root, 0.9);
  });
  for (let b = 0; drums && b < 8; b++) {
    kick(mix, b * beat, 0.75);
    if (b % 2 === 1) snare(mix, rand, b * beat, 0.5);
    hat(mix, rand, b * beat + beat * 0.5, 0.15);
  }
  return master(mix, { lp: drums ? 11000 : 7000, drive: 1.25, peak });
}

// D. Kalimba Dream: a sparse kalimba lullaby over a warm Rhodes bed.
function kalimbaDream() {
  const bpm = 84;
  const beat = 60 / bpm;
  const loop = beat * 8;
  const mix = new Mix(loop, { loop: true });
  const fx = feel(loop);
  const rand = rng(41);
  const tune = [
    [0, 'E5'], [1, 'G5'], [2, 'B5'], [3, 'D6'], [4, 'B5'], [6, 'A5'], [7, 'G5'],
    [8, 'F#5'], [9, 'A5'], [10, 'D6'], [11, 'A5'], [12, 'E6'], [14, 'D6'],
  ];
  tune.forEach(([e, n], k) => kalimba(mix, fx, swing(beat, e, 0.08), n, 0.75, k % 2 ? 0.3 : -0.3));
  const chords = [
    ['E2', ['G3', 'B3', 'D4', 'F#4']],
    ['D2', ['F#3', 'A3', 'C#4', 'E4']],
  ];
  chords.forEach(([root, voicing], c) => {
    voicing.forEach((n, k) => epiano(mix, fx, c * 4 * beat + k * 0.03, beat * 3.6, n, 0.38, -0.2 + k * 0.13, { bright: 0.7 }));
    bass(mix, fx, c * 4 * beat, beat * 3, root, 0.6);
  });
  for (let b = 0; b < 8; b++) {
    if (b % 4 === 0) kick(mix, b * beat, 0.5);
    if (b % 4 === 2) snare(mix, rand, b * beat, 0.2);
    hat(mix, rand, b * beat + swing(beat, 1, 0.08), 0.07);
  }
  vinyl(mix, rand, { crackle: 4, hiss: 0.0025 });
  return master(mix, { lp: 8000, drive: 1.2 });
}

// ---------------------------------------------------------------------------
// Cues: one-shots in the Rhodes palette.

function cue(seconds, build, { lp = 9000 } = {}) {
  const mix = new Mix(seconds);
  const fx = feel(0, { wow: 0.001, trem: 0.1 });
  build(mix, fx);
  return master(mix, { lp, drive: 1.1, peak: 0.7 });
}

const cues = {
  join: () => cue(0.9, (m, fx) => {
    epiano(m, fx, 0, 0.12, 'C5', 0.7, -0.2, { bright: 1.3 });
    epiano(m, fx, 0.09, 0.4, 'G5', 0.8, 0.2, { bright: 1.3 });
    epiano(m, fx, 0.09, 0.4, 'E5', 0.4, 0, { bright: 1 });
  }),
  leave: () => cue(0.9, (m, fx) => {
    epiano(m, fx, 0, 0.12, 'G5', 0.6, 0.2, { bright: 1.1 });
    epiano(m, fx, 0.1, 0.4, 'C5', 0.7, -0.2, { bright: 0.9 });
  }),
  mute: () => cue(0.4, (m, fx) => epiano(m, fx, 0, 0.06, 'A4', 0.55, 0, { bright: 0.7 }), { lp: 5000 }),
  unmute: () => cue(0.45, (m, fx) => {
    epiano(m, fx, 0, 0.05, 'A4', 0.45, 0, { bright: 0.9 });
    epiano(m, fx, 0.06, 0.08, 'E5', 0.6, 0, { bright: 1.1 });
  }),
  // A new message (desktop notifications): a kalimba sparkle rising a fifth.
  message: () => cue(1.1, (m, fx) => {
    kalimba(m, fx, 0, 'E5', 0.55, -0.15);
    kalimba(m, fx, 0.075, 'B5', 0.6, 0.15);
    kalimba(m, fx, 0.15, 'E6', 0.3, 0);
  }, { lp: 8000 }),
  missed: () => cue(1.6, (m, fx) => {
    epiano(m, fx, 0, 0.25, 'E5', 0.6, 0.15);
    epiano(m, fx, 0.22, 0.9, 'C#5', 0.65, -0.15);
    epiano(m, fx, 0.22, 0.9, 'A4', 0.4, 0);
  }, { lp: 6500 }),
};

// The shipped set. The other ringtone candidates stay renderable with --variants.
const sounds = {
  ringtone: () => neonDrive(),
  ringback: () => neonDrive({ drums: false, peak: 0.5 }),
  ...Object.fromEntries(Object.entries(cues).map(([k, v]) => [`cue-${k}`, v])),
};
const variants = {
  'ringtone-a-sunset-keys': sunsetKeys,
  'ringtone-b-pop-bubble': popBubble,
  'ringtone-c-neon-drive': () => neonDrive(),
  'ringtone-d-kalimba-dream': kalimbaDream,
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt('--out') ?? 'assets/sounds';
const only = opt('--only')?.split(',');
const repeat = Number(opt('--repeat') ?? 1);
mkdirSync(out, { recursive: true });
for (const [name, make] of Object.entries(args.includes('--variants') ? variants : sounds)) {
  if (only && !only.includes(name)) continue;
  let mix = make();
  if (repeat > 1 && mix.loop) {
    // A preview plays the loop several times, which also proves the seam.
    const long = new Mix(mix.seconds * repeat);
    for (let i = 0; i < long.n; i++) {
      long.l[i] = mix.l[i % mix.n];
      long.r[i] = mix.r[i % mix.n];
    }
    mix = long;
  }
  writeFileSync(join(out, `${name}.wav`), wav(mix));
  console.log(`${name}.wav ${(mix.n / SR).toFixed(2)} s`);
}
