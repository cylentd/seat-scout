// Single source of truth for the report's visual language: tier metadata and the
// seat-state → colour mapping. Both the server-rendered HTML and the browser-side
// seat-map renderer read from here (the client gets a serialised copy), so colours
// can never drift between the legend, the badges, and the maps.

export const ACCENT = '#ff7a45';

// Ordered best → worst. `rank` drives sorting and "worse-of-a-pair" resolution.
export const TIERS = {
  center:   { key: 'center',   label: 'Center',   symbol: '★', color: '#34d399', rank: 0 },
  midBack:  { key: 'midBack',  label: 'Mid-back', symbol: '●', color: '#60a5fa', rank: 1 },
  flexible: { key: 'flexible', label: 'Flexible', symbol: '◆', color: '#fbbf24', rank: 2 },
};

export const TIER_ORDER = ['center', 'midBack', 'flexible'];

// Seat rendering states, keyed by a compact integer code embedded in the page.
// 0 is deliberately "taken" (the most common state) to keep the payload small.
export const SEAT_STATES = [
  { code: 0, key: 'taken',      label: 'Taken',            color: '#2a2540' },
  { code: 1, key: 'front',      label: 'Front rows',       color: '#9f5b68' },
  { code: 2, key: 'flexible',   label: 'Flexible',         color: '#fbbf24' },
  { code: 3, key: 'midBack',    label: 'Mid-back',         color: '#60a5fa' },
  { code: 4, key: 'center',     label: 'Center',           color: '#34d399' },
  { code: 5, key: 'accessible', label: 'Accessible',       color: '#a78bfa' },
];

export const SEAT_COLORS = SEAT_STATES.map(s => s.color);

// Map an analysed seat (from classify.mjs) to its render code.
export function seatCode(seat) {
  if (!seat.open) return 0;
  if (!seat.std) return 5; // accessible / companion, open
  return { front: 1, flexible: 2, midBack: 3, center: 4 }[seat.tier];
}
