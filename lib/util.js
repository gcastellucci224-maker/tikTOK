import crypto from 'node:crypto';

export const json = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
export const empty = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export const validEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(v);
export const validOrderId = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

export const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Public address of the site: SITE_URL when set, otherwise the address the request came to.
export function siteOrigin(request, siteUrl) {
  if (siteUrl) return siteUrl;
  const h = request.headers;
  const host = h.get('x-forwarded-host') || h.get('host');
  if (host) return `${(h.get('x-forwarded-proto') || 'https').split(',')[0].trim()}://${host.split(',')[0].trim()}`;
  return new URL(request.url).origin;
}

// Browsers send "Origin" on POST: refuse calls coming from other websites.
export function sameOrigin(request, siteUrl) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const o = new URL(origin).host;
    const own = [request.headers.get('x-forwarded-host'), request.headers.get('host'), siteUrl && new URL(siteUrl).host].filter(Boolean).map((s) => s.split(',')[0].trim());
    return own.includes(o);
  } catch { return false; }
}

export const maskEmail = (e) => {
  const [u, d] = String(e).split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '•' : u.slice(0, 2) + '•••') + '@' + d;
};
export const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
