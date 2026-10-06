// Shared Fandango request layer. Every call runs in-page on fandango.com inside
// the user's real Chrome (see browser.mjs) so it carries real-browser
// credentials, and every call passes through a PolitenessBudget.
//
// Extracted from scan.mjs so scan and drop-watch throttle against the SAME
// budget semantics instead of each rolling their own retry logic.
import { evalInChrome } from './browser.mjs';
import { sleep } from './polite.mjs';

const ORIGIN = 'https://www.fandango.com';

function tryFetch(cfg, url) {
  try {
    return evalInChrome(cfg, `
(async () => {
  const r = await fetch(${JSON.stringify(url)}, {credentials: 'include'});
  const retryAfter = r.headers.get('retry-after');
  if (!r.ok) return { httpStatus: r.status, retryAfter };
  return { httpStatus: 200, data: await r.json() };
})()`);
  } catch (e) {
    return { httpStatus: 0, error: e.message.split('\n')[0] };
  }
}

// Honors server backpressure (429/503 + Retry-After) exactly; a hard block
// (403/challenge) parks and waits for a human to clear the check. `log` is
// injected so callers control verbosity — drop-watch runs unattended.
// `fetchPage` is the in-page fetch; only tests swap it.
export async function apiGet(cfg, budget, path, { log = () => {}, parkMinutes = 15, fetchPage = tryFetch } = {}) {
  const url = path.startsWith('http') ? path : ORIGIN + path;
  for (let attempt = 1; ; attempt++) {
    await budget.beforeRequest();
    const res = fetchPage(cfg, url);
    if (res.httpStatus === 200) return res.data;

    // 404/410 are permanent — the resource is gone (e.g. a showtime removed
    // while still listed). Parking and retrying would stall the run for
    // minutes on something that can never succeed.
    if (res.httpStatus === 404 || res.httpStatus === 410) throw new Error(`HTTP ${res.httpStatus} for ${url}`);

    const backoff = budget.backoffFor(res.httpStatus, res.retryAfter, attempt);
    if (backoff > 0 && attempt <= 6) {
      log(`[${res.httpStatus}${res.retryAfter ? ' Retry-After ' + res.retryAfter : ''}] honoring backpressure — waiting ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }

    if (attempt === 1) {
      log(`[${res.error || 'HTTP ' + res.httpStatus}] backing off 90s…`);
      await sleep(90000);
      continue;
    }
    log('Blocked — parking. If Chrome shows a verification prompt, click it.');
    const deadline = Date.now() + parkMinutes * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(120000);
      const r2 = fetchPage(cfg, url);
      if (r2.httpStatus === 200) { log('Access restored'); return r2.data; }
    }
    throw new Error(`${res.error || 'HTTP ' + res.httpStatus} for ${url}`);
  }
}

export const showtimesPath = (theaterId, chainCode, date) =>
  `/napi/theaterMovieShowtimes/${theaterId}?chainCode=${chainCode}&startDate=${date}&isdesktop=true&partnerRestrictedTicketing=`;

export const calendarPath = (theaterId, chainCode) =>
  `/napi/theaterCalendar/${theaterId}?chainCode=${chainCode}`;
