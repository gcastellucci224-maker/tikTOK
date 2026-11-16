// POST /api/checkout  { email, bump, lang }  ->  { checkout_url, order_id }
// The price is decided here, on the server: whatever the browser sends about amounts is ignored.
import { cfg, missing, pickLang, PRODUCT } from '../lib/config.js';
import { json, validEmail, siteOrigin, sameOrigin } from '../lib/util.js';
import { createOrder, approveLink } from '../lib/paypal.js';
import { writeOrder, assertPrivateRepo } from '../lib/github-db.js';

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
      return json(503, { error: 'not_configured' });
    }

    const amount = c.priceCents + (bump ? c.bumpCents : 0);
    const origin = siteOrigin(request, c.siteUrl);
    const P = PRODUCT[lang] || PRODUCT.en;
    const tag = `${lang}|${bump ? '1' : '0'}|${email}`;          // kept on the PayPal order: lets a lost record be rebuilt
    try {
      await assertPrivateRepo();
      const order = await createOrder({
        amountCents: amount, currency: c.currency,
        description: bump ? `${P.name} + ${P.bonus}` : P.name,
        customId: tag.length <= 255 ? tag : '',
        brand: P.name, lang,
        returnUrl: `${origin}/thanks?lang=${lang}`,
        cancelUrl: `${origin}/thanks?lang=${lang}&cancel=1`,
      });
      const url = approveLink(order);
      if (!order || !order.id || !url) throw new Error('PayPal answered without an order id or an approval link');

      // Save the order before the customer pays: this is what the delivery relies on.
      await writeOrder(order.id, {
        id: order.id, email, lang, bump, amount, currency: c.currency, provider: 'paypal',
        status: 'pending', created_at: new Date().toISOString(),
      }, undefined, `order ${order.id}: created`);

      return json(200, { checkout_url: url, order_id: order.id });
    } catch (e) {
      console.error('[checkout] ' + e.message);
      return json(e.publicRepo ? 503 : 502, { error: e.publicRepo ? 'not_configured' : 'generic' });
    }
  },
};
