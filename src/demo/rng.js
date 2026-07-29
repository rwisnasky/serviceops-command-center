/**
 * src/demo/rng.js
 *
 * Deterministic pseudo-random number generation for the demo dataset.
 *
 * The whole demo world is rebuilt from scratch on every boot. That is only
 * acceptable if it comes out *identical* every time — otherwise screenshots
 * go stale, deep links rot, and two people looking at the same demo see
 * different numbers. So: no Math.random() anywhere in src/demo/. Everything
 * flows from a single integer seed (DEMO_SEED, default 20260728).
 *
 * mulberry32 is a small, fast, well-distributed 32-bit PRNG. It is not
 * cryptographically secure and does not need to be.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap string -> 32-bit hash, so callers can fork a stable sub-stream by name. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

class Rng {
  constructor(seed) {
    this.seed = typeof seed === "number" ? seed : hashString(seed);
    this._next = mulberry32(this.seed);
  }

  /** Float in [0, 1). */
  float() {
    return this._next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    if (max === undefined) {
      max = min;
      min = 0;
    }
    return Math.floor(this._next() * (max - min + 1)) + min;
  }

  /** Float in [min, max), rounded to `places` decimals. */
  money(min, max, places = 2) {
    const v = this._next() * (max - min) + min;
    const p = Math.pow(10, places);
    return Math.round(v * p) / p;
  }

  /** Uniform pick from an array. */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this._next() * arr.length)];
  }

  /**
   * Weighted pick. Accepts either
   *   [["a", 5], ["b", 1]]           (tuples)
   * or
   *   [{ value: "a", weight: 5 }]    (objects)
   */
  weighted(entries) {
    const norm = entries.map((e) =>
      Array.isArray(e) ? { value: e[0], weight: e[1] } : e
    );
    const total = norm.reduce((s, e) => s + (e.weight || 0), 0);
    if (total <= 0) return norm[0] && norm[0].value;
    let roll = this._next() * total;
    for (const e of norm) {
      roll -= e.weight || 0;
      if (roll <= 0) return e.value;
    }
    return norm[norm.length - 1].value;
  }

  /** True with probability p. */
  chance(p) {
    return this._next() < p;
  }

  /** n distinct picks from arr (or all of arr if n >= arr.length). */
  sample(arr, n) {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
  }

  /** In-place Fisher-Yates. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Roughly normal via sum-of-uniforms (Irwin-Hall, n=4). Good enough for
   * making ticket totals and job durations cluster instead of being flat.
   */
  gaussian(mean, stdDev) {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += this._next();
    return mean + (sum - 2) * stdDev * 0.866;
  }

  /** Clamped gaussian, for values that must stay in a sane band. */
  gaussianClamped(mean, stdDev, min, max) {
    const v = this.gaussian(mean, stdDev);
    return Math.min(max, Math.max(min, v));
  }

  /** A fresh, independent stream derived from this one's seed plus a label. */
  fork(label) {
    return new Rng((this.seed ^ hashString(label)) >>> 0);
  }
}

/** The process-wide seed. Override with DEMO_SEED to reshuffle the whole world. */
const ROOT_SEED = Number(process.env.DEMO_SEED) || 20260728;

module.exports = { Rng, mulberry32, hashString, ROOT_SEED };
