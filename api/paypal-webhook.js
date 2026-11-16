// POST /api/paypal-webhook  — PayPal calls this address when an order is approved or paid.
import { cfg } from '../lib/config.js';
import { empty, json, validOrderId, siteOrigin } from '../lib/util.js';
import { verifyWebhook } from '../lib/paypal.js';
import { fulfil } from '../lib/fulfil.js';

const EVENTS = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'CHECKOUT.ORDER.COMPLETED',
  'ORDER_COMPLETED',
]);

function extractOrderId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  if (evt.order_id) return String(evt.order_id);
  const res = evt.resource || {};
  const rel = res.supplementary_data && res.supplementary_data.related_ids && res.supplementary_data.related_ids.order_id;
  if (rel) return String(rel);
  if (res.id) return String(res.id);
  return '';
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const raw = await request.text();                     // the signature is verified on the exact payload received
    if (!(await verifyWebhook(raw, request.headers))) return json(401, { error: 'bad_signature' });

    let evt;
    try { evt = JSON.parse(raw); } catch { return json(400, { error: 'bad_json' }); }
    const type = String((evt && (evt.event_type || evt.event)) || '');
    const orderId = extractOrderId(evt);
    if (!EVENTS.has(type) || !validOrderId(orderId)) return empty(204);

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
