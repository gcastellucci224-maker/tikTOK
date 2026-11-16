// GET /api/status?id=<order id>  — used by the thank-you page. Also delivers, in case the notification is late.
import { cfg, missing } from '../lib/config.js';
import { json, validOrderId, siteOrigin, maskEmail } from '../lib/util.js';
import { fulfil } from '../lib/fulfil.js';

const PUBLIC = { delivered: 'delivered', pending: 'pending', processing: 'processing', cancelled: 'cancelled', failed: 'failed', review: 'processing', unknown: 'unknown' };

export default {
  async fetch(request) {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validOrderId(id)) return json(400, { status: 'unknown' });
    if (missing().length) return json(503, { status: 'unknown' });
    const c = cfg();
    try {
      const r = await fulfil(id, siteOrigin(request, c.siteUrl));
      const out = { status: PUBLIC[r.status] || 'processing' };
      if (out.status === 'delivered' && r.order) { out.email = maskEmail(r.order.email); if (c.email.support) out.support = c.email.support; }
      return json(200, out);
    } catch (e) {
      console.error('[status] ' + e.message);
      return json(200, { status: 'processing' });
    }
  },
};
