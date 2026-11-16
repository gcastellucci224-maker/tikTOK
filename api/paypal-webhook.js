// POST /api/paypal-webhook  — PayPal calls this address when a buyer approves an order or a payment is completed.
import { cfg } from '../lib/config.js';
import { empty, json, validOrderId, siteOrigin } from '../lib/util.js';
import { verifyWebhook } from '../lib/paypal.js';
import { fulfil } from '../lib/fulfil.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const raw = await request.text();                     // checked exactly as received
    if (raw.length > 200000) return json(413, { error: 'too_large' });
    let genuine;
    try { genuine = await verifyWebhook(raw, request.headers); }
    catch (e) { console.error('[webhook] check failed: ' + e.message); return json(500, { error: 'retry' }); }
    if (!genuine) return json(401, { error: 'bad_signature' });

    let evt;
    try { evt = JSON.parse(raw); } catch { return json(400, { error: 'bad_json' }); }
    const res = (evt && evt.resource) || {};
    let orderId = '';
    if (evt.event_type === 'CHECKOUT.ORDER.APPROVED') orderId = res.id;
    else if (evt.event_type === 'PAYMENT.CAPTURE.COMPLETED') orderId = res.supplementary_data && res.supplementary_data.related_ids && res.supplementary_data.related_ids.order_id;
    if (!validOrderId(orderId)) return empty(204);

    try {
      const r = await fulfil(orderId, siteOrigin(request, cfg().siteUrl));
      if (r.status === 'review' || r.status === 'unknown') console.error(`[webhook] order ${orderId}: ${r.status}, check it by hand`);
      return empty(204);
    } catch (e) {
      console.error('[webhook] ' + e.message);
      return json(500, { error: 'retry' });               // any error answer makes PayPal try again later
    }
  },
};
