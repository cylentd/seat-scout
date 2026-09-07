# Seat Scout

Finds showtimes with good adjacent seats for a movie at a theatre, so you don't have
to click through every date and time yourself. Currently scoped to **The Odyssey in
IMAX 70mm at Regal Hacienda Crossings (Dublin, CA)** — all knobs live in `config.json`.

## How it works

Data comes from **Fandango** (`AAOPK` = this theatre; `REGL` = Regal chain). Fandango
is a ticketing partner whose whole business is machine-readable showtime/seat data, and
it served our scan cleanly at a polite pace. The scanner runs its API calls **inside a
real Chrome window** (launched with remote debugging) via the
[agent-browser](https://www.npmjs.com/package/agent-browser) CLI, so the `fetch()`
calls are same-origin and carry a genuine session.

Endpoints used (all under `https://www.fandango.com`):

| Endpoint | Purpose |
|---|---|
| `/napi/theaterCalendar/<id>` | dates the theatre has showtimes |
| `/napi/theaterMovieShowtimes/<ID>?chainCode=&startDate=YYYY-MM-DD` | showtimes per date, with `filmFormat`, and a per-show `type` (`available`/`soldout`) — so sold-out shows are skipped without a seat call |
| `/napi/seatMap/<showtimeHashCode>` | live seat map: `seats[]` with `id` (e.g. `F12`), `x/y` coords, `status` (`A` available / `R` reserved), `type`, `rightNeighbor`, plus `totalAvailableSeatCount` |
| `/napi/theaterswithshowtimes?zipCode=&city=&state=&date=&limit=` | theatres near a ZIP or city/state, sorted by distance, each with id/slug/chain and the movies (with showtime formats) it plays that date — powers the landing page's theatre finder |

Auditorium 21 (the IMAX 70mm house): rows **A (front) → I (back)**, 253 seats. Seat
tiers are geometry-based (normalized x-position + row letter) since Fandango gives
pixel coords rather than a column grid.

> A legacy Regal-direct scanner (`src/legacy-regal-scan.mjs`) is kept for reference.
> Regal's own `GetSeatPlan` endpoint is aggressively Cloudflare-protected and rate-flags
> a session after a short burst; Fandango was the sanctioned door that just worked.

## Launcher (landing page)

`scout.bat` (or `npm run app`) starts a local-only launcher at `http://127.0.0.1:8737`
and opens it in your browser. The landing page is prefilled from `config.json` — movie,
format, party size, time horizon, and theatre (collapsed behind "change") — so the
usual flow is: glance, maybe tweak, click **Scout seats**. It updates the config, runs
the scan with live progress, rebuilds `report.html`, and opens the report. A **Quick
check** button runs `--watch` when the target hasn't changed. Nothing is hosted:
the server binds to loopback only, and `report.html` remains the self-contained file
you share.

Changing the movie, theatre, or format invalidates the scan cache automatically
(party size doesn't — seat maps are raw data; grouping happens at report time, and
the classifier counts adjacent groups of your party size, not just pairs).

- **Theatre finder** — the "where" step's theatre panel takes a ZIP or "City, ST"
  and lists nearby ticketing theatres nearest-first (one `theaterswithshowtimes`
  call, cached per location in `data/theatres-<key>.json` for 12 h / same-day).
  Rows are badged when the theatre plays the picked movie — orange when it's in
  the picked format too — and one click fills the whole theatre form (name, ID,
  chain, slug; any stale direct-booking link is cleared). Badges reflect today's
  slate only, so an unbadged theatre may still play the movie on other dates;
  nothing is hidden. Like `/suggest`, the lookup only runs when a scan Chrome is
  already up.
- **Recent scouts** — every submission is saved as a profile (`data/profiles.json`,
  deduped per target, newest first, capped at 8). From two profiles up, the landing
  page shows them as chips; one click refills the whole form, theatre included.
- **Per-target scan caches** — scans live in `data/scans/<target>.json`, so flipping
  between movies keeps each one's cache warm (`scan-latest.json` still mirrors the
  most recent run for `report.mjs` and sharing). Pre-existing caches migrate on
  first use.
- **Direct booking** — set `directBooking: { label, url }` in `config.json` (or the
  "Direct booking URL" field in the landing page's theatre panel) and the report's
  primary CTA becomes the theatre's own fee-free checkout, with Fandango demoted to
  a small "F" monogram chip that deep-links the exact showtime (tooltip carries the
  convenience-fee caveat). Unset, the report falls back to Fandango-only.
- **Sell-rate trend** — every run appends a compact observation to
  `data/history-<target>.json` (per-show pairs/usable, only shows actually observed
  that run, capped at 40 entries). With two observations ≥12 h apart, the report adds
  a decomposed trend line ("Since Fri 5 PM: 7 of 15 showtimes sold out of pairs ·
  8 remain · +21 new showtimes opened") plus per-row "was N" deltas, "New" tags on
  first-seen showtimes, and "just opened" markers on all-new dates. Demand, passing
  dates, and new supply are reported separately so a new ticket release can't read
  as recovery. Theatres typically post the next week's schedule midweek for the
  Friday–Thursday week — but event runs like IMAX 70mm drop blocks on their own
  schedule, so the history log is the real answer to "when do dates open here."
- **Calendar probe** — watch runs start with one `theaterCalendar` call; if the
  theatre's calendar extends past the scanned window, the run flags "new dates open —
  run a full scan" (new dates = the best seat selection of the run).
- **Playing now** — when the scanner's Chrome is already up, the landing page shows
  the theatre's current slate (title suggestions + formats) from one showtimes call,
  cached for 6 hours. Loading the page never launches a browser or hits Fandango
  cold; without Chrome it just stays hidden.

## Scan modes

- `node src/scan.mjs` — **tiered-freshness scan.** Cached dates are reused only while
  young enough for how far out they are: the next 3 days always re-fetch, 4–14 days
  out expire after 24 h, further out after 72 h. Near-term data (where booking
  decisions happen) stays current without re-fetching the whole window.
- `node src/scan.mjs --watch` — **cheap check-in.** Re-fetches seat maps only for the
  shows that had pairs in the last scan, plus one showtimes call per affected date to
  catch sell-outs (~23 requests vs ~133 for a full scan). Prints a per-show delta
  (`pairs 3 → 2 · usable 6 → 4`) so you see at a glance what's slipping away. This is
  the "should I book today?" run — human-initiated when you're actually deciding, not
  a recurring monitor (see the robots.txt note below).
- `node src/scan.mjs --fresh` — ignore the cache and re-fetch everything.

After any scan: `node src/report.mjs` regenerates `report.html`.

`npm test` runs the suite (Node's built-in runner, zero dependencies): unit tests for
the classifier, formatting, and scanner logic (`src/scan-core.mjs` holds the pure,
network-free parts), plus regression tests that pin the report's view-model numbers
and rendered HTML, and a smoke test against the real `data/scan-latest.json`.

**One click:** `check-seats.bat` does the whole loop — starts a debug-port Chrome if
needed, runs the watch scan (`full`/`fresh` as an optional argument), rebuilds the
report, and opens it. Pin it to Start or make a desktop shortcut for the daily check.

## Drop watch (`npm run drops`)

The scan modes above answer *"which seats should I book?"*. The drop watcher answers a
different question — *"has more of the run gone on sale?"* — across several theatres at
once, without fetching a single seat map.

It reads `watchlist.json` (separate from `config.json`: that file is the one target the
interactive scanner is pointed at right now, this is the standing list) and reports two
kinds of news, deliberately kept apart because they call for different actions:

- **▲ Run extended** — dates that had no showtimes now do, or a date gained a screening.
  The whole auditorium is unsold, so this is the best seat selection you will ever get
  for that run. Worth acting on today, not urgently.
- **● Seats returned** — a showtime that was sold out is purchasable again (an expired
  hold or a refund). Usually one or two seats and often gone within minutes.

Each run probes `aheadDays` past the known last showtime (where an extension appears)
plus `recheckDays` from today (where returns appear) — about 14 requests for two
theatres. On a target's **first** run it instead walks forward until the run
demonstrably ends, so the recorded end date is the real one rather than "as far as we
happened to look"; without that, every later run would report the untouched remainder
of the run as a fresh extension. First runs record a baseline and never alert.

Alerts go to the terminal always, and to Discord when a webhook is set — either
`discordWebhook` in `watchlist.json` or the `SEAT_SCOUT_DISCORD_WEBHOOK` environment
variable, which wins and keeps the URL out of the repo. Create one under *Server
Settings → Integrations → Webhooks*.

**Scheduled runs:** `drops.bat` is the unattended entry point — it starts a debug-port
Chrome if none is listening, never pauses, and appends to `data\drops.log`. Register it
twice daily with:

```powershell
schtasks /create /tn "Seat Scout drops" /tr "C:\Users\David\Github\seat-scout\drops.bat" /sc daily /st 13:00 /ri 300 /du 05:00 /f
```

That fires at 13:00 and 18:00 local. Fandango can interpose a human check; when that
happens the watcher parks, logs it, and waits for you to clear it in the Chrome window —
it will not try to tunnel through. Check `data\drops.log` if alerts go quiet.

## Politeness budget — the "good citizen" layer

The point of this tool isn't to defeat bot detection; it's to be the kind of client a
site is happy to serve. `src/polite.mjs` enforces, on every request:

- **page-load-shaped pacing**: short bursts (`burstSize` requests spaced
  `burstIntervalMs` apart — one "page visit": a day's showtimes plus its seat maps)
  separated by a longer jittered rest (`burstRestMs`), all under a **rolling
  per-minute ceiling** (`maxPerMinute`) that is the hard invariant — quick the way
  a real page load is quick, never sustained;
- exact honoring of **server backpressure**: on `429`/`503` we read `Retry-After`
  (seconds or HTTP-date) and wait precisely that long before retrying;
- an optional **off-peak window** (`offPeakOnly`) to confine scans to quiet hours;
- **incremental caching with tiered freshness**: clean per-date results are reused
  across runs while still young for their distance (see Scan modes), `--watch`
  narrows a check-in to the handful of shows that matter, and shows with zero
  bookable pairs for `skipPairlessAfter` straight observations keep their cached
  seat map instead of a re-fetch (`--fresh` refetches everything) — the cheapest
  request is the one you don't send.

Deliberately **not** included: browser-fingerprint spoofing and IP/proxy rotation.
Rotating identities to slip under per-source limits is structurally the botnet move —
it evades the fair-share limit rather than respecting it. The durable, defensible design
is one honest, persistent session that self-throttles well below any reasonable bar, and
that involves a human when a site puts up a human check.

### How do you know an endpoint is "sanctioned"?

No single flag, but a strong signal stack — prefer sources that *want* to be read:

1. **Published/official APIs & partner feeds** — documented developer APIs, affiliate/
   partner programs (Fandango, ticketing aggregators), data licensing pages. Explicit invitation.
2. **`robots.txt` + Terms of Service** — the machine-readable statement of what may be
   crawled. If a path is `Disallow`ed or the ToS forbids automated access, that's a no
   regardless of technical feasibility. **Note:** Fandango's `robots.txt` *does*
   `Disallow: /napi/*` (and `*?*date=*`) for all user agents — the very paths this tool
   uses. robots.txt targets crawlers/indexers; a single, human-paced personal session
   that hits the same first-party endpoints your own browser calls is a grayer case
   than a spider — but the disallow is a real signal to **keep this minimal, sequential,
   and single-session — never parallelized.** The current budget (short page-load-shaped
   bursts with rests between, under a 20/min rolling ceiling) is a brisk human clicking
   through dates, not a crawler. Treat it as "automating my own visit," not "crawling."

   **Where the drop watcher sits.** This file used to say "one-shot, not a recurring
   monitor." `drop-watch.mjs` runs on a twice-daily schedule, so that line no longer
   described the tool and has been narrowed rather than quietly ignored. The line it
   holds: **~14 requests per run, twice daily, sequential, one session** — comparable
   to opening the two theatre pages yourself over coffee and again after work, which
   is exactly the habit it replaces. What stays forbidden is unchanged: no bursting,
   no parallel targets, no identity rotation, no minute-by-minute polling for returned
   seats. If you ever want hourly checks, that's the signal to go find a sanctioned
   feed rather than turn up the dial here.
3. **Is it the site's *own* first-party call?** Endpoints the page fetches to render
   itself (visible in DevTools Network) are meant to be hit by that page. Reusing them
   *from that same page/session, at page-like rates* is a world apart from scripting a
   headless swarm against them.
4. **Absence of an access-control wall** — no auth token, no aggressive WAF/anti-bot
   challenge on the endpoint. When a site puts Turnstile/DataDome in front of a path
   (as Regal does on `GetSeatPlan`), that *is* the site saying "not for automation" —
   the honest response is to back off and find the sanctioned door, not to tunnel through.
5. **Rate & terms you can meet politely** — if fair-use access requires bursting or
   hiding your origin, it isn't sanctioned for your use. If a gentle, identifiable,
   single-session pace works, you're inside the lines.

Rule of thumb: *invited (1) and not-forbidden (2) beats merely-reachable.* Reachable-but-
walled (fails 4) is the clearest "stop." When in doubt, throttle down and prefer the
partner/official feed over the origin site.

## Usage

1. Launch a dedicated real-Chrome instance (keeps your main Chrome untouched):

   ```powershell
   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
     '--remote-debugging-port=9222', `
     '--user-data-dir=C:\Users\David\AppData\Local\Temp\claude\chrome-scan-profile', `
     'https://www.fandango.com'
   ```

   Dismiss the location prompt and click **Continue** on the privacy banner once.

2. Run the scan + report:

   ```
   npm run all
   ```

3. Open `report.html` — showtimes ranked by adjacent-pair quality, each with its
   rendered seat map. Re-run `npm run report` alone to rebuild the report from the
   last scan without re-fetching.

## Sharing the report

`report.html` is a single, self-contained file — all CSS, JS, and seat data are inline,
with **no external requests** (fonts are system fonts; the only URLs are click-only
Fandango booking links). Just email/AirDrop/message the one file (~0.7 MB); whoever
opens it gets the full interactive report offline. Only the "Book on Fandango" links
need a connection.

**To Discord:** `npm run share` posts a summary embed — pairs found, plus the **top 3
picks as tappable Fandango links**, each going straight to that showtime's purchase page.
That is the phone-shaped version of the report: one tap from alert to checkout.

It does **not** attach `report.html` by default. Discord previews an `.html` attachment as
raw syntax-highlighted source — a wall of `<!doctype html>` that dwarfs the embed and
tells you nothing useful. `npm run share -- --attach` adds the file anyway if you want it;
otherwise the local `report.html` remains where you browse seat maps.

Run it after `report.mjs` — it warns if `report.html` is older than the latest scan rather
than describing a stale file with fresh numbers.

## Discord bot (`npm run bot` / `discord-bot.bat`)

Tag **@Seat Scout** in a channel (or DM it) and it scouts on demand and replies in
place — no website needed. The reply is the report dressed for Discord: the summary
embed with **top picks as tappable booking links**, a **screenshot of report.html as
the embed image** (the visual, since Discord previews raw `.html` as source code),
and the `report.html` file attached when you ask for it.

Prompts (free text; keywords steer it):

| You say | It does |
|---|---|
| `@Seat Scout` *(anything)* | quick `--watch` check of the configured target, best seats back |
| `@Seat Scout full scan` | tiered-freshness rescan of the whole window |
| `@Seat Scout fresh` | rescan ignoring every cache |
| `@Seat Scout report` | resend the latest report without scanning, file attached |
| `@Seat Scout … html` | any of the above + attach `report.html` |
| `@Seat Scout help` | the cheat sheet |

One-time setup (~3 minutes):

1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   **New Application** → name it "Seat Scout" → **Bot** tab → **Reset Token** → copy.
   No privileged intents needed — Discord always delivers message content for DMs and
   messages that @mention the bot, which is all this bot listens to.
2. Put the token in the `SEAT_SCOUT_DISCORD_TOKEN` env var (`setx` then open a new
   terminal) or in `watchlist.json` → `"discordBotToken"` (env wins).
3. Run `discord-bot.bat` — on login it prints the **invite URL**; open it, pick your
   server, done. (Permissions requested: view channels, send messages, attach files,
   read message history.)

The bot runs the same pipeline as the launcher (scan → report), launches the debug
Chrome itself if none is up, holds the same one-job-at-a-time lock, and scans under
the same politeness budget. It's a Gateway WebSocket client built on Node's built-in
`WebSocket` — still zero dependencies. Keep the window open; it reconnects and
resumes the session on network blips.

The report is interactive:
- **Top picks** podium shows the 3 best showtimes; each "View seat map" jumps to and
  opens that showtime's map (scrolled just below the filter bar, not off-screen).
- **Filters** (seat quality · time of day) keep the list short instead of one long scroll.
- **Any showtime time** (↗) opens that exact showtime's Fandango purchase page — the same
  deep link the site's own buttons use, so no searching.
- **Hover any seat** (desktop) or **tap it** (touch) to see its number and status.
- **Seat maps pan & zoom**: pinch on touch, ctrl/trackpad-scroll on desktop, or the
  +/−/Reset buttons; drag to pan when zoomed, double-tap to reset. Handy on phones where
  a 250-seat map is small — implemented dependency-free in `assets.mjs` (`PanZoom`).
- **Mobile-tuned**: no sideways scroll, 40px touch targets, full-width buttons, stacked
  layout under 560px.

### Ranking & pair counting

- **Pairs are non-overlapping**: a run of 4 open seats = 2 usable pairs, not 3. This
  reflects what two people can actually book without stranding a lone seat between groups
  (`classify.countRealisticPairs`). "Flexible ×4" means 4 separate places you could sit together.
- **Rank favours doable times**: weekend shows and weekday shows starting 5 PM or later
  rank above weekday work-hours matinees, *then* seat quality breaks ties
  (`classify.practicality` + `rankShows`). A great seat you can't attend loses to a
  decent seat you can. Weekday-daytime shows are tagged "work hrs".

## Project layout

Separated so each piece has one job and the report can grow without regressions:

```
src/
  browser.mjs        in-page fetch bridge to real Chrome + readiness checks
  fandango-api.mjs   shared request layer: politeness, backpressure, parking
  scan.mjs           orchestrates the scan (dates → showtimes → seat maps)
  drop-watch.mjs     multi-theatre run-extension / returned-seat watcher
  notify.mjs         alert delivery: terminal + Discord webhook (+ report embed)
  discord-bot.mjs    gateway bot: @mention → scan → reply with picks + report
  discord-core.mjs   pure prompt-parsing + canned texts for the bot
  theatres-core.mjs  pure nearby-theatre search: query parsing + normalizing
  polite.mjs         politeness budget: rate cap, Retry-After, off-peak
  classify.mjs       domain logic: seat → tier, adjacent-pair analysis
  report.mjs         thin entry: load → build model → render → write
  report-load.mjs    disk side of report building (config + scan + history)
  share-report.mjs   post report.html to Discord with a summary embed
  report/
    theme.mjs        single source of truth for tier/seat colours
    format.mjs       date/time/label formatting (pure)
    viewmodel.mjs    scan + analysis → presentation model (+ seat payloads)
    view.mjs         pure HTML components + page shell
    assets.mjs       CSS + browser-side filter/lazy-seat-map script
```

Data flows one way: `scan → data/scan-latest.json → viewmodel → view → report.html`.
The browser renders seat maps on demand from an embedded compact payload, so the page
stays light even with 100+ showtimes. Colours live only in `theme.mjs`; the client
script receives a serialised copy, so the legend, badges, and maps can't drift.

## Config (`config.json`)

- `movieCodes` — Regal HO-codes to include (the Open Caption variant is tagged in the report)
- `formatFilter.mustMatchAttrs` — regexes a performance's attributes must all match (`IMAX`, `70\s?mm`)
- `tiers` — seat quality zones, tuned for auditorium 21:
  - `excludeRows` — never acceptable (front 3 rows)
  - `center` — rows E–G, columns 11–20 (the sweet spot)
  - `midBack` — rows D–I, columns 6–25 (good, not perfect)
  - anything else outside `excludeRows` counts as `flexible`
- `partySize` — informational for now; pair logic finds 2-adjacent runs

## Extending to any movie/theatre (future)

- Theatre codes come from the directory embedded in `regmovies.com/theatres`
  (`path_name` like `regal-hacienda-crossings-0347`).
- Movie HO-codes appear in each theatre page's `__NEXT_DATA__` or the URL of the
  movie page. Swap `theatreCode` + `movieCodes`, adjust `tiers` for that auditorium's
  geometry (row letters/column count differ per house).
