// GET /api/setup-webhook?token=<SETUP_TOKEN>
// One-time helper: tells PayPal where to send the "order paid" notifications and shows the
// PAYPAL_WEBHOOK_ID to copy into Vercel. Works only while SETUP_TOKEN is set on Vercel:
// remove that variable when you are done and this address stops working.
import { cfg } from '../lib/config.js';
import { json, safeEqual, siteOrigin } from '../lib/util.js';
import { listWebhooks, getWebhook, createWebhook } from '../lib/paypal.js';

export default {
  async fetch(request) {
    const c = cfg();
    const token = new URL(request.url).searchParams.get('token') || '';
    if (!c.setupToken || c.setupToken.length < 16 || !safeEqual(token, c.setupToken)) return json(404, { error: 'not_found' });
    if (!c.paypal.clientId || !c.paypal.clientSecret) return json(400, { error: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing on Vercel' });
    const url = `${siteOrigin(request, c.siteUrl)}/api/paypal-webhook`;
    try {
      const list = await listWebhooks();
      const found = (Array.isArray(list) ? list : []).find((w) => w.url === url);
      const hook = found ? await getWebhook(found.id) : await createWebhook(url);
      const events = Array.isArray(hook.event_types) ? hook.event_types.map((e) => e.name || e) : hook.events;
      return json(200, {
        ok: true,
        already_existed: Boolean(found),
        environment: c.paypal.mode === 'sandbox' ? 'sandbox (test)' : c.paypal.mode === 'live' ? 'production (real payments)' : 'auto',
        webhook_url: hook.url || url,
        events,
        PAYPAL_WEBHOOK_ID: hook.id || '(not returned)',
        next: 'Copy PAYPAL_WEBHOOK_ID into Vercel > Settings > Environment Variables, delete SETUP_TOKEN, then redeploy.',
      });
    } catch (e) {
      console.error('[setup-webhook] ' + e.message);
      return json(502, { error: 'PayPal refused the request', detail: String(e.message).slice(0, 300) });
    }
  },
};
