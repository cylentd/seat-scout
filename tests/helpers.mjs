// Shared fixtures: a config mirroring the real tier geometry, and builders for
// synthetic auditoriums/shows. Rows have 21 seats at x = 0,10,…,200, so a seat's
// normalized position cx = (seatNumber - 1) / 20 — e.g. seat 7 sits at cx 0.30,
// the inclusive edge of the center window.
export const cfg = {
  theatreName: 'Test Theatre',
  partySize: 2,
  fandango: {
    theaterId: 'TEST1',
    theaterSlug: 'test-theatre-test1',
    chainCode: 'REGL',
    movieTitleMatch: 'Odyssey',
    movieId: 123,
    formatFilter: 'IMAX 70MM',
    scanDays: 40,
    stopAfterEmptyDays: 4,
  },
  tiers: {
    excludeRows: ['A', 'B', 'C'],
    center: { rows: ['E', 'F', 'G'], xMin: 0.3, xMax: 0.7 },
    midBack: { rows: ['D', 'E', 'F', 'G', 'H', 'I'], xMin: 0.12, xMax: 0.88 },
  },
};

export const ROW_LEN = 21;

// One row of linked seats. `open`/`accessible` are arrays of 1-based seat numbers.
export function makeRow(row, { open = [], accessible = [], y = 0 } = {}) {
  return Array.from({ length: ROW_LEN }, (_, i) => {
    const num = i + 1;
    return {
      id: `${row}${num}`,
      x: i * 10, y, w: 8, h: 8, col: num,
      status: open.includes(num) ? 'A' : 'R',
      type: accessible.includes(num) ? 'wheelchair' : 'standard',
      right: i < ROW_LEN - 1 ? `${row}${num + 1}` : null,
    };
  });
}

// Full 9-row house (A front … I back). openByRow: { E: [8, 9], … }.
export function auditorium(openByRow = {}, accessibleByRow = {}) {
  const seats = [];
  [...'ABCDEFGHI'].forEach((row, ri) => {
    seats.push(...makeRow(row, {
      open: openByRow[row] || [],
      accessible: accessibleByRow[row] || [],
      y: ri * 10,
    }));
  });
  return seats;
}

export function makeShow({ id, ticketingDate, type = 'available', expired = false, seats = null, hash } = {}) {
  const show = {
    movieTitle: 'The Odyssey',
    id,
    hash: hash === undefined ? `hash${id}` : hash,
    timeLabel: 'raw',
    ticketingDate,
    type,
    expired,
    formats: ['IMAX 70MM'],
  };
  if (seats) {
    show.seatMap = {
      auditoriumId: 21,
      totalAvailable: seats.filter(s => s.status === 'A').length,
      totalSeats: seats.length,
      seats,
    };
  }
  return show;
}

// A small but complete scan: 2026-08-01 is a Saturday, 2026-08-03 a Monday.
//  - show 1: Sat 7:05 PM — E8..E11 open → 2 center pairs, usable 4 (hot for party of 2)
//  - show 2: Sat 1:00 PM — F5 open → midBack single, no pairs
//  - show 3: Sat 10:00 PM — sold out, no seat map
//  - show 4: Mon 1:00 PM (work hrs) — I1+I2 open (flexible pair, cx < 0.12)
//            plus H1,H3,H5,H7 singles → usable 6 (not hot)
//  - show 5: Mon — expired, must be dropped everywhere
export function makeScan() {
  return {
    scannedAt: '2026-07-19T12:00:00.000Z',
    source: 'fandango',
    results: [
      {
        date: '2026-08-01',
        scannedAt: '2026-07-19T12:00:00.000Z',
        shows: [
          makeShow({ id: 1, ticketingDate: '2026-08-01+19:05', seats: auditorium({ E: [8, 9, 10, 11] }) }),
          makeShow({ id: 2, ticketingDate: '2026-08-01+13:00', seats: auditorium({ F: [5] }) }),
          makeShow({ id: 3, ticketingDate: '2026-08-01+22:00', type: 'soldout' }),
        ],
        errors: [],
      },
      {
        date: '2026-08-03',
        scannedAt: '2026-07-19T12:00:00.000Z',
        shows: [
          makeShow({ id: 4, ticketingDate: '2026-08-03+13:00', seats: auditorium({ I: [1, 2], H: [1, 3, 5, 7] }) }),
          makeShow({ id: 5, ticketingDate: '2026-08-03+22:00', expired: true, seats: auditorium({ E: [8, 9] }) }),
        ],
        errors: [],
      },
    ],
  };
}
