// Seat tier classification, realistic pair analysis, and showtime ranking.
// Seat fields: id "F12" (row letter + number), x/y pixel coords (y=0 is the screen
// end; row A is the front row), status "A" available / "R" reserved, type
// "standard" | wheelchair/companion variants, right = id of right-hand neighbor.
const ROW_RE = /^([A-Z]+)(\d+)$/;
const RANK = { center: 0, midBack: 1, flexible: 2, front: 3 };

export function analyzeShow(cfg, show) {
  const t = cfg.tiers;
  const seats = show.seatMap?.seats || [];
  const minX = Math.min(...seats.map(s => s.x));
  const maxX = Math.max(...seats.map(s => s.x));
  const span = Math.max(1, maxX - minX);

  const tierOf = (seat) => {
    const row = (seat.id.match(ROW_RE) || [])[1] || '?';
    if (t.excludeRows.includes(row)) return 'front';
    const cx = (seat.x - minX) / span;
    if (t.center.rows.includes(row) && cx >= t.center.xMin && cx <= t.center.xMax) return 'center';
    if (t.midBack.rows.includes(row) && cx >= t.midBack.xMin && cx <= t.midBack.xMax) return 'midBack';
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
function countRealisticGroups(decorated, size) {
  const duos = { center: 0, midBack: 0, flexible: 0 };
  const byId = new Map(decorated.map(s => [s.id, s]));
  const openStd = s => s && s.open && s.std;

  // A seat starts a run if it's open-standard and nothing open-standard points to it.
  const pointedTo = new Set();
  for (const s of decorated) {
    if (openStd(s) && s.right && openStd(byId.get(s.right))) pointedTo.add(s.right);
  }

  for (const s of decorated) {
    if (!openStd(s) || pointedTo.has(s.id)) continue;
    const run = [];
    let cur = s;
    while (openStd(cur)) {
      run.push(cur);
      cur = cur.right ? byId.get(cur.right) : null;
    }
    for (let i = 0; i + size - 1 < run.length; i += size) {
      const group = run.slice(i, i + size);
      const tier = group.reduce((worst, seat) => RANK[seat.tier] >= RANK[worst] ? seat.tier : worst, 'center');
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
  const tierRank = s => (s.bestTier ? RANK[s.bestTier] : 9);
  const pairTotal = s => s.duos.center + s.duos.midBack + s.duos.flexible;
  return [...analyzed].sort((a, b) =>
    (practicality(a.ticketingDate) - practicality(b.ticketingDate)) ||
    (tierRank(a) - tierRank(b)) ||
    (pairTotal(b) - pairTotal(a)) ||
    a.ticketingDate.localeCompare(b.ticketingDate)
  );
}
