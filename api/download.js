// GET /api/download?id=&f=main|bonus&sig=  — the links inside the email. Only paid orders get the file.
import { cfg, fileUrl, missing } from '../lib/config.js';
import { validOrderId, safeEqual } from '../lib/util.js';
import { downloadSig } from '../lib/email.js';
import { readOrder } from '../lib/github-db.js';

const page = (status, msg) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Download</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#090A0F;color:#EDEBE6;font-family:system-ui,sans-serif"><p style="max-width:420px;padding:24px;font-size:17px;line-height:1.5;text-align:center">${msg}</p>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const PAID = ['paid', 'delivering', 'delivered'];

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return page(405, 'Method not allowed.');
    const q = new URL(request.url).searchParams;
    const id = q.get('id') || '', f = q.get('f') || '', sig = q.get('sig') || '';
    if (missing().length || !cfg().downloadSecret) return page(503, 'Downloads are not available right now. Please try again later.');
    if (!validOrderId(id) || !['main', 'bonus'].includes(f) || !safeEqual(sig, downloadSig(id, f))) return page(403, 'This download link is not valid. Use the link from your confirmation email.');
    try {
      const rec = await readOrder(id);
      if (!rec || !PAID.includes(rec.data.status) || (f === 'bonus' && !rec.data.bump)) return page(403, 'This download is not available for this order.');
      const url = fileUrl(f, rec.data.lang);
      if (!url) return page(503, 'Downloads are not available right now. Please try again later.');
      return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    } catch (e) {
      console.error('[download] ' + e.message);
      return page(502, 'Something went wrong. Please try again in a minute.');
    }
  },
};
