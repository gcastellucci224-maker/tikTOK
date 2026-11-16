// POST /api/checkout  { email, bump, lang }  ->  { checkout_url, order_id }
// The price is decided here, on the server: whatever the browser sends about amounts is ignored.
import crypto from 'node:crypto';
import { cfg, missing, pickLang, PRODUCT } from '../lib/config.js';
import { json, validEmail, siteOrigin, sameOrigin } from '../lib/util.js';
import { createOrder } from '../lib/paypal.js';
import { writeOrder } from '../lib/github-db.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const c = cfg();
    if (!sameOrigin(request, c.siteUrl)) return json(403, { error: 'forbidden' });

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 2000) return json(413, { error: 'generic' });
      body = JSON.parse(raw);
    } catch { return json(400, { error: 'generic' }); }
    if (!body || typeof body !== 'object') return json(400, { error: 'generic' });
    if (body.company) return json(400, { error: 'generic' });   // hidden field: only bots fill it in

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!validEmail(email)) return json(400, { error: 'invalid_email' });
    const bump = body.bump === true;
    const lang = pickLang(body.lang);

    const miss = missing();
    if (miss.length) {
      console.error('[checkout] not configured, missing: ' + miss.join(', '));
      return json(503, { error: 'not_configured', missing: miss });
    }

    const amount = c.priceCents + (bump ? c.bumpCents : 0);
    const origin = siteOrigin(request, c.siteUrl);
    const P = PRODUCT[lang] || PRODUCT.en;
    try {
      const order = await createOrder({
        amount, currency: c.currency,
        description: bump ? `${P.name} + ${P.bonus}` : P.name,
        email,
        reference: 'r72-' + crypto.randomBytes(6).toString('hex'),
        redirectUrl: `${origin}/thanks?lang=${lang}`,
        cancelUrl: `${origin}/?lang=${lang}#offer`,
        metadata: { lang, bump: bump ? '1' : '0' },
      });
      if (!order || !order.id || !order.checkout_url) throw new Error('PayPal answered without id/checkout_url');

      // Save the order in GitHub DB if configured (do not block PayPal redirect if DB write fails).
      if (c.github.token && c.github.repo) {
        try {
          await writeOrder(order.id, {
            id: order.id, email, lang, bump, amount, currency: c.currency,
            status: 'pending', created_at: new Date().toISOString(),
          }, undefined, `order ${order.id}: created`);
        } catch (dbErr) {
          console.error('[checkout] github-db write warning: ' + dbErr.message);
        }
      }

      return json(200, { checkout_url: order.checkout_url, order_id: order.id });
    } catch (e) {
      console.error('[checkout] ' + e.message);
      return json(502, { error: 'generic', detail: String(e.message).slice(0, 300) });
    }
  },
};
