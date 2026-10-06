// Seat tier classification, realistic pair analysis, and showtime ranking.
// Seat fields: id "F12" (row letter + number), x/y pixel coords (y=0 is the screen
// end; row A is the front row), status "A" available / "R" reserved, type
// "standard" | wheelchair/companion variants, right = id of right-hand neighbor.
const ROW_RE = /^([A-Z]+)(\d+)$/;
const RANK = { center: 0, midBack: 1, flexible: 2, front: 3 };

// Each row's depth as a fraction 0 (front, nearest the screen) .. 1 (back),
// derived from the seat map's own geometry (mean y per row, y=0 is the screen).
// This is what lets the tier windows below work in ANY auditorium instead of a
// single hardcoded house: a 9-row and a 20-row theatre both get a 0..1 scale.
function rowDepths(seats) {
  const sumY = new Map(), n = new Map();
  for (const s of seats) {
    const row = (s.id.match(ROW_RE) || [])[1];
    if (!row) continue;
    sumY.set(row, (sumY.get(row) || 0) + s.y);
    n.set(row, (n.get(row) || 0) + 1);
  }
  const rows = [...sumY.keys()].map(r => [r, sumY.get(r) / n.get(r)]);
  rows.sort((a, b) => a[1] - b[1]); // low y (front) -> high y (back)
  const last = rows.length - 1;
  const depth = new Map();
  rows.forEach(([r], i) => depth.set(r, last <= 0 ? 0.5 : i / last));
  return depth;
}

export function analyzeShow(cfg, show) {
  const t = cfg.tiers;
  const seats = show.seatMap?.seats || [];
  const minX = Math.min(...seats.map(s => s.x));
  const maxX = Math.max(...seats.map(s => s.x));
  const span = Math.max(1, maxX - minX);
  const rowDepth = rowDepths(seats);

  // Tier windows are fractions of row depth + normalized x, not fixed row
  // letters — so "front third excluded, middle-depth centre band" holds whether
  // the house has 9 rows or 20.
  const tierOf = (seat) => {
    const row = (seat.id.match(ROW_RE) || [])[1] || '?';
    const d = rowDepth.get(row) ?? 1;
    if (d < t.frontFrac) return 'front';
    const cx = (seat.x - minX) / span;
    if (d >= t.center.rowMin && d <= t.center.rowMax && cx >= t.center.xMin && cx <= t.center.xMax) return 'center';
    if (d >= t.midBack.rowMin && cx >= t.midBack.xMin && cx <= t.midBack.xMax) return 'midBack';
    return 'flexible';
  };

  const counts = { open: { center: 0, midBack: 0, flexible: 0, front: 0 }, accessibleOpen: 0, sold: 0, total: seats.length };
  const decorated = seats.map(s => {
    const std = s.type === 'standard';
    const open = s.status === 'A';
    const tier = tierOf(s);
    if (open && std) counts.open[tier]++;
    else if (open) counts.accessibleOpen++;
    else counts.sold++;
    return { ...s, tier, open, std };
  });

  const duos = countRealisticGroups(decorated, cfg.partySize || 2);
  const bestTier = duos.center ? 'center' : duos.midBack ? 'midBack' : duos.flexible ? 'flexible' : null;
  return { ...show, seats: decorated, counts, duos, bestTier };
}

// Realistic adjacent groups for a party of `size`: runs of consecutive open
// standard seats yield floor(len/size) NON-overlapping groups (a run of 4 seats
// two pairs, not "3 combinations"). Groups are taken greedily from the start of
// each run; a group's tier is the worst of its seats, and groups touching the
// front rows don't count. (`duos` keeps its name for compatibility — it now
// means "groups of partySize".)
// Right-hand neighbor resolver. Prefer the API's rightNeighbor; fall back to
// geometry (same row, next seat by x within ~1.6 seat-widths of pitch, so an
// aisle breaks the run) for theatres whose seat maps don't populate
// rightNeighbor — some AMC and Regal houses return it null for most seats.
function buildRightOf(decorated) {
  const byId = new Map(decorated.map(s => [s.id, s]));
  const byRow = new Map();
  for (const s of decorated) {
    const row = (s.id.match(ROW_RE) || [])[1] || `y${Math.round(s.y)}`;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(s);
  }
  const geomRight = new Map();
  for (const list of byRow.values()) {
    list.sort((a, b) => a.x - b.x);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      const pitch = b.x - a.x;
      if (pitch > 0 && pitch <= 1.6 * (a.w || 1)) geomRight.set(a.id, b.id);
    }
  }
  return (seat) => (seat.right && byId.has(seat.right)) ? seat.right : (geomRight.get(seat.id) || null);
}

function countRealisticGroups(decorated, size) {
  const duos = { center: 0, midBack: 0, flexible: 0 };
  const byId = new Map(decorated.map(s => [s.id, s]));
  const rightOf = buildRightOf(decorated);
  const openStd = s => s && s.open && s.std;

  // A seat starts a run if it's open-standard and nothing open-standard points to it.
  const pointedTo = new Set();
  for (const s of decorated) {
    const r = rightOf(s);
    if (openStd(s) && r && openStd(byId.get(r))) pointedTo.add(r);
  }

  for (const s of decorated) {
    if (!openStd(s) || pointedTo.has(s.id)) continue;
    const run = [];
    let cur = s;
    while (openStd(cur)) {
      run.push(cur);
      const r = rightOf(cur);
      cur = r ? byId.get(r) : null;
    }
    for (let i = 0; i + size - 1 < run.length; i += size) {
      const group = run.slice(i, i + size);
      const tier = group.reduce((worst, seat) => RANK[seat.tier] >= RANK[worst] ? seat.tier : worst, 'center'); // nomutate: a tie swaps a tier name for the same name, so >= and > agree
      if (tier !== 'front') duos[tier]++;
    }
  }
  return duos;
}

// Time practicality: weekday shows starting during work hours are demoted —
// a great seat you can't attend loses to a decent seat you can.
// 0 = doable (weekends, and weekday starts from 5 PM on) · 1 = weekday work-hours.
export function practicality(ticketingDate) {
  const [datePart, timePart] = ticketingDate.split('+');
  const [y, m, d] = datePart.split('-').map(Number);
  const hour = Number(timePart.split(':')[0]);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  return weekend || hour >= 17 ? 0 : 1;
}

// Rank: doable times first, then seat quality, then how many pairs, then soonest.
export function rankShows(analyzed) {
  const tierRank = s => (s.bestTier ? RANK[s.bestTier] : 9); // nomutate: 9 only has to exceed every real rank (0-3); 10 sorts the same
  const pairTotal = s => s.duos.center + s.duos.midBack + s.duos.flexible;
  return [...analyzed].sort((a, b) =>
    (practicality(a.ticketingDate) - practicality(b.ticketingDate)) ||
    (tierRank(a) - tierRank(b)) ||
    (pairTotal(b) - pairTotal(a)) ||
    a.ticketingDate.localeCompare(b.ticketingDate)
  );
}
