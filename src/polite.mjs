// Politeness budget — the reusable "good citizen" layer that makes the non-abusive
// path the default. Enforces a request-rate cap, honors server backpressure
// (429 / 503 + Retry-After), and confines scans to off-peak hours.
//
// Design stance: one honest, persistent session that self-throttles well below any
// reasonable fair-use bar. No fingerprint rotation, no IP rotation — see README.

const sleep = ms => new Promise(res => setTimeout(res, ms));

export class PolitenessBudget {
  constructor(p = {}) {
    // Burst pacing: a page-load-shaped rhythm — a few quick requests (one
    // "page visit": a day's showtimes + its seat maps), then a longer jittered
    // rest (the human reading the page). The rolling per-minute ceiling below
    // remains the hard fair-use invariant on top of whatever the bursts do.
    this.burstSize = p.burstSize ?? 5;                 // requests per burst
    this.burstIntervalMs = p.burstIntervalMs ?? 400;   // spacing inside a burst
    this.burstRestMs = p.burstRestMs ?? p.minIntervalMs ?? 9000; // pause between bursts
    if (p.burstSize == null && p.minIntervalMs != null) this.burstSize = 1; // legacy config: uniform pacing at its old floor
    this.jitter = p.jitter ?? 0.4;                     // ±40% random spread on waits
    this.maxPerMinute = p.maxPerMinute ?? 20;          // rolling ceiling
    this.offPeakOnly = p.offPeakOnly ?? false;
    this.offPeakStartHour = p.offPeakStartHour ?? 22;  // local hour inclusive
    this.offPeakEndHour = p.offPeakEndHour ?? 7;       // local hour exclusive
    this._last = 0; // nomutate: means "never"; any small value is ~1.7e12ms before a real Date.now(), so the first request always sees a full rest
    this._burst = 0; // nomutate: requests in the current burst; the first request always resets it (since >= burstRestMs, see _last)
    this._stamps = [];                                 // request times in the last 60s
    this._queue = Promise.resolve();                   // overlapping callers take turns
  }

  _jit(ms) {
    const spread = ms * this.jitter;
    // deterministic-ish jitter without Math.random dependency at call sites
    return ms - spread + Math.random() * 2 * spread;
  }

  async _waitForOffPeak(now) {
    if (!this.offPeakOnly) return;
    const inWindow = () => {
      const h = new Date().getHours();
      return this.offPeakStartHour > this.offPeakEndHour
        ? (h >= this.offPeakStartHour || h < this.offPeakEndHour)   // wraps midnight
        : (h >= this.offPeakStartHour && h < this.offPeakEndHour);
    };
    let announced = false;
    while (!inWindow()) {
      if (!announced) { console.log(`[politeness] outside off-peak window (${this.offPeakStartHour}:00–${this.offPeakEndHour}:00) — waiting…`); announced = true; }
      await sleep(5 * 60 * 1000);
    }
  }

  // Call immediately before each network request. Calls are served one at a time,
  // so two overlapping callers are spaced exactly as if the second called later.
  beforeRequest() {
    const turn = this._queue.then(() => this._admit());
    this._queue = turn.catch(() => {});
    return turn;
  }

  async _admit() {
    await this._waitForOffPeak();
    const now = Date.now();

    // rolling per-minute ceiling
    this._stamps = this._stamps.filter(t => now - t < 60000);
    if (this._stamps.length >= this.maxPerMinute) {
      const wait = 60000 - (now - this._stamps[0]);
      if (wait > 0) await sleep(wait);
    }

    // burst pacing: quick spacing while the burst has budget, a long rest after
    const since = Date.now() - this._last;
    if (since >= this.burstRestMs) this._burst = 0; // a natural rest already elapsed
    const resting = this._burst >= this.burstSize;
    const target = this._jit(resting ? this.burstRestMs : this.burstIntervalMs);
    if (since < target) await sleep(target - since);

    this._burst = resting ? 1 : this._burst + 1;
    this._last = Date.now();
    this._stamps.push(this._last);
  }

  // Call after a response. Returns ms to wait before retrying (0 = proceed).
  // Honors Retry-After (delta-seconds or HTTP-date); falls back to exponential backoff.
  backoffFor(status, retryAfterHeader, attempt = 1) {
    if (status !== 429 && status !== 503) return 0;
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
      const when = Date.parse(retryAfterHeader);
      if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    }
    return Math.min(60000, 1000 * 2 ** attempt); // 2s,4s,8s… capped at 60s
  }
}

export { sleep };
