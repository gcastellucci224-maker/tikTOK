// GET /api/status?id=<order id>  — used by the thank-you page. Confirms the payment with PayPal and hands over the downloads.
import { cfg, missing, fileUrl } from '../lib/config.js';
import { json, validOrderId, siteOrigin, maskEmail } from '../lib/util.js';
import { downloadLink } from '../lib/email.js';
import { fulfil } from '../lib/fulfil.js';

const PUBLIC = { delivered: 'delivered', paid: 'paid', pending: 'pending', processing: 'processing', cancelled: 'cancelled', failed: 'failed', review: 'processing', unknown: 'unknown' };

export default {
  async fetch(request) {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validOrderId(id)) return json(400, { status: 'unknown' });
    if (missing().length) return json(503, { status: 'unknown' });
    const c = cfg(), origin = siteOrigin(request, c.siteUrl);
    try {
      const r = await fulfil(id, origin);
      const out = { status: PUBLIC[r.status] || 'processing' };
      if ((out.status === 'delivered' || out.status === 'paid') && r.order) {
        const o = r.order;
        out.email = maskEmail(o.email); out.emailed = out.status === 'delivered';
        if (c.email.support) out.support = c.email.support;
        out.downloads = [];                                      // links only for files that have been configured
        if (fileUrl('main', o.lang)) out.downloads.push({ kind: 'main', url: downloadLink(origin, id, 'main') });
        if (o.bump && fileUrl('bonus', o.lang)) out.downloads.push({ kind: 'bonus', url: downloadLink(origin, id, 'bonus') });
      }
      return json(200, out);
    } catch (e) {
      console.error('[status] ' + e.message);
      return json(200, { status: 'processing' });
    }
  },
};
