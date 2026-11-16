// GET /api/setup-webhook?token=<SETUP_TOKEN>
// One-time helper: tells PayPal where to send its notifications and shows the webhook id to copy into
// Vercel as PAYPAL_WEBHOOK_ID. Works only while SETUP_TOKEN is set on Vercel: remove that variable when
// you are done and this address stops working.
import { cfg } from '../lib/config.js';
import { json, safeEqual, siteOrigin } from '../lib/util.js';
import { listWebhooks, createWebhook, WEBHOOK_EVENTS } from '../lib/paypal.js';

export default {
  async fetch(request) {
    const c = cfg();
    const token = new URL(request.url).searchParams.get('token') || '';
    if (!c.setupToken || c.setupToken.length < 16 || !safeEqual(token, c.setupToken)) return json(404, { error: 'not_found' });
    if (!c.paypal.clientId || !c.paypal.secret) return json(400, { error: 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing on Vercel' });
    const url = `${siteOrigin(request, c.siteUrl)}/api/paypal-webhook`;
    try {
      const found = (await listWebhooks()).find((w) => w.url === url);
      const hook = found || await createWebhook(url);
      return json(200, {
        ok: true,
        already_existed: Boolean(found),
        environment: c.paypal.base.includes('sandbox') ? 'sandbox (test)' : 'live (real payments)',
        webhook_url: hook.url || url,
        events: (hook.event_types || []).map((e) => e.name),
        expected_events: WEBHOOK_EVENTS,
        PAYPAL_WEBHOOK_ID: hook.id,
        next: 'Copy PAYPAL_WEBHOOK_ID into Vercel > Settings > Environment Variables, delete SETUP_TOKEN, then redeploy.',
      });
    } catch (e) {
      console.error('[setup-webhook] ' + e.message);
      const hint = e.status === 401 ? 'PayPal did not accept the client id and secret. Check that PAYPAL_ENV (sandbox or live) matches the kind of keys you pasted.' : 'PayPal refused the request';
      return json(502, { error: hint, detail: String(e.message).slice(0, 300) });
    }
  },
};
