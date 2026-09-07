// Pure formatting helpers. No DOM, no HTML — just data → display strings.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Fandango ticketingDate looks like "2026-07-25+07:00" — a theatre-local wall time.
// Parse the parts by hand; never route through Date's timezone handling.
export function parseTicketingDate(ticketingDate) {
  const [datePart, timePart] = ticketingDate.split('+');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return { y, m, d, hh, mm, dateISO: datePart };
}

export function fmtShowtime(ticketingDate) {
  const { y, m, d, hh, mm, dateISO } = parseTicketingDate(ticketingDate);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const h12 = ((hh + 11) % 12) + 1;
  return {
    dateISO,
    dow,
    dayLabel: `${dow} ${MON[m - 1]} ${d}`,
    timeLabel: `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`,
    hour: hh,
  };
}

// Coarse buckets for the "time of day" filter.
export function partOfDay(hour) {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'late';
}

export const PART_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  late: 'Late night',
};

export function pct(n, total) {
  return total ? Math.round((100 * n) / total) : 0;
}
