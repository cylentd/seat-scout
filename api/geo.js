// Approximate visitor location from Vercel's IP-geolocation headers. City-level
// accuracy, no browser permission prompt — enough to sort theatres nearest-first.
// Locally (python http.server) this route does not exist; the client treats a
// 404 or network error as "no geo" and falls back to best-seats order.
export const config = { runtime: 'edge' };

export default function handler(request) {
  const h = request.headers;
  const lat = Number(h.get('x-vercel-ip-latitude'));
  const lng = Number(h.get('x-vercel-ip-longitude'));
  const body = Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng, city: decodeURIComponent(h.get('x-vercel-ip-city') || ''), region: h.get('x-vercel-ip-country-region') || '', source: 'ip' }
    : { lat: null, lng: null, city: '', region: '', source: 'none' };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Per-visitor answer: never let the edge cache one person's city for the next.
      'cache-control': 'private, no-store',
    },
  });
}
