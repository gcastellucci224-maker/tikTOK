// Self-test: runs the whole purchase flow against FAKE PayPal, GitHub and Resend servers.
// No real payment, no real email, no network. Run with:  node scripts/selftest.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://shop.example';
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const SECRETS = {                                   // invented on every run: nothing real is ever written here
  PAYPAL_CLIENT_SECRET: 'E' + rnd(58),
  GITHUB_TOKEN: 'github_pat_selftest_' + rnd(12),
  RESEND_API_KEY: 're_selftest_' + rnd(12),
  DOWNLOAD_SECRET: rnd(30),
  SETUP_TOKEN: rnd(20),
};
const CLIENT_ID = 'A' + rnd(58);
const WEBHOOK_ID = 'WH' + crypto.randomBytes(8).toString('hex').toUpperCase();
const FULL_ENV = {
  ...SECRETS, PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: WEBHOOK_ID, GITHUB_REPO: 'someone/orders-db',
  EMAIL_FROM: 'Shop <hello@shop.example>', SUPPORT_EMAIL: 'help@shop.example',
  PRODUCT_URL: 'https://files.example/manual.zip', BONUS_URL: 'https://files.example/audio.zip', PRODUCT_URL_IT: 'https://files.example/manuale.zip', SITE_URL: SITE,
};
const ALL_KEYS = [...Object.keys(FULL_ENV), 'GITHUB_BRANCH', 'PRICE_CENTS', 'BUMP_CENTS', 'BONUS_URL_IT'];
const setEnv = (o) => { for (const k of ALL_KEYS) delete process.env[k]; Object.assign(process.env, o); };

// ------------------------------------------------------------------ fake services
const SIGN_KEY = rnd(16);                            // stands in for PayPal's own signing key
const sigFor = (rawEvent, id, time) => crypto.createHmac('sha256', SIGN_KEY).update(`${id}|${time}|${WEBHOOK_ID}|${rawEvent}`).digest('base64');
const S = { orders: new Map(), files: new Map(), hooks: [], emails: [], resendCalls: 0, idem: new Map(), failEmail: 0, log: [], tokens: new Set(), tokenCalls: 0, captures: 0, captureCalls: 0, reqIds: new Map() };
const res = (status, data) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));
const view = (o) => { const { _sent, _capture, ...pub } = o; return pub; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = new Headers(init.headers || {});
  S.log.push(`${m} ${u.host}${u.pathname}`);
  await tick();
  if (u.host === 'api-m.sandbox.paypal.com' || u.host === 'api-m.paypal.com') {
    if (u.pathname === '/v1/oauth2/token') {
      S.tokenCalls++;
      if (h.get('authorization') !== 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRETS.PAYPAL_CLIENT_SECRET}`).toString('base64') || init.body !== 'grant_type=client_credentials') return res(401, { error: 'invalid_client' });
      const t = 'tok_' + rnd(12); S.tokens.add(t); return res(200, { access_token: t, token_type: 'Bearer', expires_in: 32400 });
    }
    if (!S.tokens.has((h.get('authorization') || '').replace('Bearer ', ''))) return res(401, { error: 'invalid_token' });
    const body = init.body && u.pathname !== '/v1/notifications/verify-webhook-signature' ? JSON.parse(init.body) : null;
    let mm;
    if (m === 'POST' && u.pathname === '/v2/checkout/orders') {
      if (!h.get('paypal-request-id')) return res(400, { name: 'INVALID_REQUEST' });
      const id = crypto.randomBytes(9).toString('hex').toUpperCase().slice(0, 17);
      const o = { id, status: 'PAYER_ACTION_REQUIRED', intent: body.intent, purchase_units: JSON.parse(JSON.stringify(body.purchase_units)), _sent: body,
                  links: [{ href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' }, { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action', method: 'GET' }] };
      S.orders.set(id, o); return res(200, view(o));
    }
    if (m === 'GET' && (mm = u.pathname.match(/^\/v2\/checkout\/orders\/([\w-]+)$/))) { const o = S.orders.get(mm[1]); return o ? res(200, view(o)) : res(404, { name: 'RESOURCE_NOT_FOUND' }); }
    if (m === 'POST' && (mm = u.pathname.match(/^\/v2\/checkout\/orders\/([\w-]+)\/capture$/))) {
      S.captureCalls++;
      const o = S.orders.get(mm[1]); if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      const rid = h.get('paypal-request-id');
      if (rid && S.reqIds.has(rid)) return res(201, view(o));                                  // same request id: same answer, no second charge
      if (o.status === 'COMPLETED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      if (o.status !== 'APPROVED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
      const k = o._capture || {};
      if (k.decline) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
      S.captures++; if (rid) S.reqIds.set(rid, true);
      o.status = 'COMPLETED';
      o.purchase_units[0].payments = { captures: [{ id: 'CAP' + rnd(6), status: k.status || 'COMPLETED', final_capture: true, amount: k.amount || o.purchase_units[0].amount }] };
      return res(201, view(o));
    }
    if (m === 'POST' && u.pathname === '/v1/notifications/verify-webhook-signature') {
      // like PayPal, check the signature against the notification exactly as it was sent
      const raw = init.body, mark = ',"webhook_event":', at = raw.indexOf(mark);
      let f; try { f = JSON.parse(raw); } catch { return res(400, { name: 'MALFORMED_REQUEST' }); }
      if (at < 0 || !f.auth_algo || !f.cert_url || !f.transmission_id || !f.transmission_time || !f.transmission_sig) return res(400, { name: 'VALIDATION_ERROR' });
      const rawEvent = raw.slice(at + mark.length, -1);
      const good = f.webhook_id === WEBHOOK_ID && f.transmission_sig === sigFor(rawEvent, f.transmission_id, f.transmission_time);
      return res(200, { verification_status: good ? 'SUCCESS' : 'FAILURE' });
    }
    if (m === 'GET' && u.pathname === '/v1/notifications/webhooks') return res(200, { webhooks: S.hooks });
    if (m === 'POST' && u.pathname === '/v1/notifications/webhooks') { const w = { id: 'WH' + crypto.randomBytes(8).toString('hex').toUpperCase(), url: body.url, event_types: body.event_types }; S.hooks.push(w); return res(201, w); }
    return res(404, {});
  }
  if (u.host === 'api.github.com') {
    if (h.get('authorization') !== `Bearer ${SECRETS.GITHUB_TOKEN}`) return res(401, { message: 'Bad credentials' });
    const body = init.body ? JSON.parse(init.body) : null;
    const mm = u.pathname.match(/^\/repos\/someone\/orders-db\/contents\/(.+)$/);
    if (!mm) return res(404, { message: 'Not Found' });
    const p = mm[1], cur = S.files.get(p);
    if (m === 'GET') return cur ? res(200, { content: cur.content, sha: cur.sha, encoding: 'base64' }) : res(404, { message: 'Not Found' });
    if (m === 'PUT') {
      if (cur && !body.sha) return res(422, { message: 'sha wasn\'t supplied' });
      if (cur && body.sha !== cur.sha) return res(409, { message: 'does not match' });
      if (!cur && body.sha) return res(409, { message: 'does not match' });
      const sha = crypto.randomBytes(20).toString('hex');
      S.files.set(p, { content: body.content, sha, message: body.message });
      return res(cur ? 200 : 201, { content: { sha, path: p } });
    }
  }
  if (u.host === 'api.resend.com' && m === 'POST' && u.pathname === '/emails') {
    if (h.get('authorization') !== `Bearer ${SECRETS.RESEND_API_KEY}`) return res(401, { message: 'unauthorized' });
    const body = JSON.parse(init.body);
    S.resendCalls++;
    if (S.failEmail > 0) { S.failEmail--; return res(500, { message: 'temporary failure' }); }
    const key = h.get('idempotency-key');
    if (key && S.idem.has(key)) return res(200, { id: S.idem.get(key) });
    const id = crypto.randomUUID(); if (key) S.idem.set(key, id);
    S.emails.push({ id, key, ...body }); return res(200, { id });
  }
  throw new Error('selftest: unexpected outgoing call to ' + url);
};
const dbOrder = (id) => { const f = S.files.get(`orders/${id}.json`); return f ? JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')) : null; };

// ------------------------------------------------------------------ helpers
const api = async (name) => (await import(`../api/${name}.js`)).default;
const [checkout, webhook, status, download, setup] = await Promise.all(['checkout', 'paypal-webhook', 'status', 'download', 'setup-webhook'].map(api));
const req = (p, { method = 'GET', body, headers = {} } = {}) => new Request(SITE + p, { method, headers: { host: 'shop.example', ...headers }, body });
const post = (b, headers = {}) => checkout.fetch(req('/api/checkout', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b), headers: { 'content-type': 'application/json', origin: SITE, ...headers } }));
// a notification the way PayPal sends it; the odd spacing would break the signature if our code rewrote the JSON
const hook = (orderId, { type = 'CHECKOUT.ORDER.APPROVED', badSig, tamper, drop } = {}) => {
  const resource = type === 'PAYMENT.CAPTURE.COMPLETED' ? `{ "id":"CAP1" ,"status" : "COMPLETED", "supplementary_data":{"related_ids":{"order_id":"${orderId}"}} }` : `{ "id" : "${orderId}",  "status":"APPROVED" }`;
  const raw = `{"id":"WH-${rnd(6)}",  "event_type" : "${type}","amount":1.50,   "resource":${resource} }`;
  const tid = crypto.randomUUID(), time = new Date().toISOString();
  const headers = { 'content-type': 'application/json', 'paypal-transmission-id': tid, 'paypal-transmission-time': time, 'paypal-auth-algo': 'SHA256withRSA',
                    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-sig': badSig ? 'forged' : sigFor(raw, tid, time) };
  if (drop) delete headers[drop];
  return webhook.fetch(req('/api/paypal-webhook', { method: 'POST', body: tamper ? raw.replace(orderId, tamper) : raw, headers }));
};
const approve = (id) => { S.orders.get(id).status = 'APPROVED'; };                // the buyer says yes on PayPal's page
const getStatus = async (id) => body(await status.fetch(req('/api/status?id=' + id)));
const linksIn = (html) => [...html.matchAll(/href="([^"]+\/api\/download[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const newOrder = async (b) => (await body(await post(b))).order_id;

let passed = 0, failed = 0; const seen = [];
const quiet = console.error; console.error = () => {};      // the handlers log expected errors: keep the report readable
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what); };
const body = async (r) => { const t = await r.text(); seen.push(t); try { return JSON.parse(t); } catch { return t; } };

// ------------------------------------------------------------------ tests
console.log('\nCheckout');
await test('refuses to take money while settings are missing', async () => {
  setEnv({ SITE_URL: SITE });
  const r = await post({ email: 'anna@example.com' }); eq(r.status, 503, 'status'); eq((await body(r)).error, 'not_configured', 'error');
  for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'RESEND_API_KEY', 'PRODUCT_URL']) {
    setEnv({ ...FULL_ENV, [k]: '' }); eq((await post({ email: 'anna@example.com' })).status, 503, 'status without ' + k);
  }
  eq(S.orders.size, 0, 'orders created');
});
setEnv(FULL_ENV);
await test('email is required and checked on the server', async () => {
  for (const email of [undefined, '', 'anna', 'anna@', 'anna@example', 'a b@example.com', 'x'.repeat(250) + '@example.com']) {
    const r = await post({ email }); eq(r.status, 400, `status for ${email}`); eq((await body(r)).error, 'invalid_email', 'error');
  }
  eq(S.orders.size, 0, 'orders created');
});
await test('bots, other websites and wrong methods are turned away', async () => {
  eq((await post({ email: 'anna@example.com', company: 'ACME' })).status, 400, 'honeypot');
  eq((await post({ email: 'anna@example.com' }, { origin: 'https://evil.example' })).status, 403, 'foreign origin');
  eq((await post('not json')).status, 400, 'bad json');
  eq((await checkout.fetch(req('/api/checkout'))).status, 405, 'GET');
  eq(S.orders.size, 0, 'orders created');
});
let A, B;
await test('base order: 14.90 EUR on PayPal, order saved as pending, buyer sent to PayPal', async () => {
  const r = await post({ email: '  anna@example.com ', bump: false, lang: 'en' }); eq(r.status, 200, 'status');
  const j = await body(r); A = j.order_id;
  const o = S.orders.get(A); ok(o, 'order exists at PayPal'); const sent = o._sent, pu = sent.purchase_units[0], x = sent.payment_source.paypal.experience_context;
  eq(sent.intent, 'CAPTURE', 'intent'); eq(pu.amount.value, '14.90', 'amount'); eq(pu.amount.currency_code, 'EUR', 'currency'); eq(pu.custom_id, 'en|0|anna@example.com', 'custom id');
  eq(x.return_url, SITE + '/thanks?lang=en', 'return url'); eq(x.cancel_url, SITE + '/thanks?lang=en&cancel=1', 'cancel url'); eq(x.shipping_preference, 'NO_SHIPPING', 'no shipping'); eq(x.user_action, 'PAY_NOW', 'pay now');
  eq(j.checkout_url, `https://www.sandbox.paypal.com/checkoutnow?token=${A}`, 'checkout url');
  const d = dbOrder(A); eq(d.status, 'pending', 'db status'); eq(d.email, 'anna@example.com', 'db email'); eq(d.amount, 1490, 'db amount'); eq(d.bump, false, 'db bump');
});
await test('bundle order: 19.80 EUR, and a price sent by the browser is ignored', async () => {
  const r = await post({ email: 'luca@example.com', bump: true, lang: 'it', amount: 1, price: 1, priceCents: 1 }); eq(r.status, 200, 'status');
  B = (await body(r)).order_id;
  eq(S.orders.get(B)._sent.purchase_units[0].amount.value, '19.80', 'amount'); eq(dbOrder(B).lang, 'it', 'lang'); eq(S.orders.get(B)._sent.payment_source.paypal.experience_context.locale, 'it-IT', 'PayPal page in Italian');
  const id = await newOrder({ email: 'x@example.com', bump: 'yes', lang: 'zz', amount: 1 });
  eq(S.orders.get(id)._sent.purchase_units[0].amount.value, '14.90', 'non-boolean bump'); eq(dbOrder(id).lang, 'en', 'unknown language falls back to English');
});

console.log('\nPayment');
await test('nothing is charged or delivered before the buyer approves on PayPal', async () => {
  eq((await getStatus(A)).status, 'pending', 'status'); eq((await hook(A)).status, 204, 'notification for an order not approved');
  eq(S.captureCalls, 0, 'capture attempts'); eq(S.emails.length, 0, 'emails sent'); eq(dbOrder(A).status, 'pending', 'db status');
});
await test('buyer approves and comes back: payment taken once, one email with a working download link', async () => {
  approve(A); const j = await getStatus(A);
  eq(j.status, 'delivered', 'status'); eq(j.email, 'an•••@example.com', 'email is masked'); eq(S.captures, 1, 'payments taken'); eq(S.emails.length, 1, 'emails sent');
  const e = S.emails[0]; eq(e.to[0], 'anna@example.com', 'recipient'); eq(e.from, FULL_ENV.EMAIL_FROM, 'sender'); ok(/72H Reset Protocol/.test(e.subject), 'English subject');
  const links = linksIn(e.html); eq(new Set(links).size, 1, 'download links (no bonus bought)');
  const d = dbOrder(A); eq(d.status, 'delivered', 'db status'); ok(d.delivered_at && d.paid_at && d.capture_id, 'dates and PayPal payment id saved');
  const r = await download.fetch(new Request(links[0])); eq(r.status, 302, 'download status'); eq(r.headers.get('location'), FULL_ENV.PRODUCT_URL, 'download target');
});
await test('asking again, or PayPal notifying again, never charges or emails twice', async () => {
  const c0 = S.captureCalls, m0 = S.resendCalls;
  eq((await getStatus(A)).status, 'delivered', 'status'); eq((await hook(A)).status, 204, 'approved notification'); eq((await hook(A, { type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 204, 'completed notification');
  eq(S.captureCalls, c0, 'capture attempts'); eq(S.resendCalls, m0, 'calls to the email service'); eq(S.captures, 1, 'payments taken');
});
await test('Italian bundle, thank-you page and 3 notifications at the same moment: one payment, one email, two links', async () => {
  approve(B); const c0 = S.captures, m0 = S.resendCalls;
  const rs = await Promise.all([hook(B), hook(B), hook(B, { type: 'PAYMENT.CAPTURE.COMPLETED' }), status.fetch(req('/api/status?id=' + B))]);
  ok(rs.every((r) => r.status === 204 || r.status === 200), 'all answered');
  eq(S.captures - c0, 1, 'payments taken'); eq(S.resendCalls - m0, 1, 'calls to the email service');
  const e = S.emails.at(-1); eq(e.to[0], 'luca@example.com', 'recipient'); ok(/Protocollo Reset 72H/.test(e.subject), 'Italian subject');
  const links = [...new Set(linksIn(e.html))]; eq(links.length, 2, 'download links');
  const [m, b] = await Promise.all(links.map((l) => download.fetch(new Request(l))));
  eq(m.headers.get('location'), FULL_ENV.PRODUCT_URL_IT, 'Italian file'); eq(b.headers.get('location'), FULL_ENV.BONUS_URL, 'bonus file');
  eq(dbOrder(B).status, 'delivered', 'db status');
});
await test('buyer approves but never comes back to the site: the PayPal notification completes the sale', async () => {
  const id = await newOrder({ email: 'nora@example.com', bump: false, lang: 'en' }); approve(id); const n = S.emails.length;
  eq((await hook(id)).status, 204, 'status'); eq(S.emails.length, n + 1, 'emails sent'); eq(S.emails.at(-1).to[0], 'nora@example.com', 'recipient'); eq(dbOrder(id).status, 'delivered', 'db status');
});
await test('email service down: the payment is kept, PayPal is asked to retry, and the retry delivers', async () => {
  const id = await newOrder({ email: 'sara@example.com', bump: false, lang: 'en' }); approve(id);
  S.failEmail = 1; const n = S.emails.length, c0 = S.captures;
  eq((await hook(id)).status, 500, 'first attempt'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'paid', 'db status after failure'); eq(S.captures - c0, 1, 'payments taken');
  eq((await hook(id, { type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 204, 'retry'); eq(S.emails.length, n + 1, 'emails sent after retry'); eq(dbOrder(id).status, 'delivered', 'db status'); eq(S.captures - c0, 1, 'still one payment');
});
await test('payment method refused by PayPal: nothing delivered, buyer told it did not go through', async () => {
  const id = await newOrder({ email: 'ugo@example.com', bump: false, lang: 'en' }); approve(id); S.orders.get(id)._capture = { decline: true }; const n = S.emails.length;
  eq((await getStatus(id)).status, 'failed', 'status'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'pending', 'db status');
});
await test('payment still under review at PayPal: delivery waits, then happens when PayPal confirms', async () => {
  const id = await newOrder({ email: 'pia@example.com', bump: false, lang: 'en' }); approve(id); S.orders.get(id)._capture = { status: 'PENDING' }; const n = S.emails.length;
  eq((await getStatus(id)).status, 'processing', 'status while pending'); eq(S.emails.length, n, 'emails sent');
  S.orders.get(id).purchase_units[0].payments.captures[0].status = 'COMPLETED';
  eq((await hook(id, { type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 204, 'notification'); eq(S.emails.length, n + 1, 'emails sent after confirmation');
});
await test('amount paid differs from the price: nothing is delivered, order flagged for review', async () => {
  const id = await newOrder({ email: 'tom@example.com', bump: true, lang: 'en' }); approve(id); S.orders.get(id)._capture = { amount: { currency_code: 'EUR', value: '1.00' } }; const n = S.emails.length;
  eq((await hook(id)).status, 204, 'status'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'review', 'db status');
  const id2 = await newOrder({ email: 'tim@example.com', bump: false, lang: 'en' }); approve(id2); S.orders.get(id2)._capture = { amount: { currency_code: 'USD', value: '14.90' } };
  await getStatus(id2); eq(S.emails.length, n, 'wrong currency: emails sent'); eq(dbOrder(id2).status, 'review', 'wrong currency: db status');
});
await test('paid order whose record is missing is rebuilt from PayPal and delivered', async () => {
  const id = await newOrder({ email: 'eva@example.com', bump: true, lang: 'it' });
  S.files.delete(`orders/${id}.json`); approve(id); const n = S.emails.length;
  eq((await hook(id)).status, 204, 'status'); eq(S.emails.length, n + 1, 'emails sent'); eq(S.emails.at(-1).to[0], 'eva@example.com', 'recipient');
  eq(dbOrder(id).status, 'delivered', 'db status'); eq(dbOrder(id).bump, true, 'bump kept'); eq(dbOrder(id).lang, 'it', 'language kept');
});
await test('cancelled order and unknown order are reported as such', async () => {
  const id = await newOrder({ email: 'vito@example.com' }); S.orders.get(id).status = 'VOIDED';
  eq((await getStatus(id)).status, 'cancelled', 'voided'); eq(dbOrder(id).status, 'cancelled', 'db status');
  eq((await getStatus('ZZZZZZZZZZZZZZZZZ')).status, 'unknown', 'unknown order'); eq((await status.fetch(req('/api/status?id=../../etc'))).status, 400, 'bad id');
});

console.log('\nNotifications (webhook)');
await test('a forged, altered or incomplete notification is rejected, and does nothing', async () => {
  const id = await newOrder({ email: 'fake@example.com' }); approve(id); const n = S.emails.length, c0 = S.captureCalls;
  eq((await hook(id, { badSig: true })).status, 401, 'wrong signature');
  eq((await hook(A, { tamper: id })).status, 401, 'order id swapped inside a signed notification');
  for (const hname of ['paypal-transmission-sig', 'paypal-transmission-id', 'paypal-cert-url', 'paypal-auth-algo', 'paypal-transmission-time']) eq((await hook(id, { drop: hname })).status, 401, 'missing ' + hname);
  eq((await webhook.fetch(req('/api/paypal-webhook', { method: 'POST', body: 'not json', headers: { 'paypal-transmission-id': 'x' } }))).status, 401, 'garbage');
  eq(S.captureCalls, c0, 'capture attempts'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'pending', 'db status');
  process.env.PAYPAL_WEBHOOK_ID = 'WHSOMEONEELSE'; eq((await hook(id)).status, 401, 'notification signed for another webhook'); process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
});
await test('other kinds of notification are acknowledged and ignored', async () => {
  const n = S.emails.length; eq((await hook(A, { type: 'PAYMENT.CAPTURE.REFUNDED' })).status, 204, 'status'); eq(S.emails.length, n, 'emails sent');
});

console.log('\nDownloads');
await test('wrong signature, unpaid order or bonus not bought are refused', async () => {
  const C = await newOrder({ email: 'marta.rossi@example.com', bump: false, lang: 'en' }); approve(C); await getStatus(C);
  const sig = (id, f) => crypto.createHmac('sha256', SECRETS.DOWNLOAD_SECRET).update(`${id}.${f}`).digest('hex');
  const get = (id, f, s) => download.fetch(req(`/api/download?id=${id}&f=${f}&sig=${s}`));
  eq((await get(C, 'main', sig(C, 'main'))).status, 302, 'valid');
  eq((await get(C, 'main', 'deadbeef')).status, 403, 'bad signature');
  eq((await get(C, 'main', sig(A, 'main'))).status, 403, 'signature of another order');
  eq((await get(C, 'bonus', sig(C, 'main'))).status, 403, 'signature of another file');
  eq((await get(C, 'bonus', sig(C, 'bonus'))).status, 403, 'bonus not bought');
  const U = await newOrder({ email: 'nopay@example.com', bump: true });
  eq((await get(U, 'main', sig(U, 'main'))).status, 403, 'unpaid order');
  eq((await get(C, 'other', sig(C, 'other'))).status, 403, 'unknown file');
});

console.log('\nSetup helper and secrets');
await test('setup-webhook works only with the setup token and registers the right address and events', async () => {
  eq((await setup.fetch(req('/api/setup-webhook'))).status, 404, 'no token');
  eq((await setup.fetch(req('/api/setup-webhook?token=wrong'))).status, 404, 'wrong token');
  const j = await (await setup.fetch(req('/api/setup-webhook?token=' + SECRETS.SETUP_TOKEN))).json();
  eq(j.webhook_url, SITE + '/api/paypal-webhook', 'address'); ok(String(j.PAYPAL_WEBHOOK_ID).startsWith('WH'), 'webhook id returned');
  eq(S.hooks[0].event_types.map((e) => e.name).join(), 'CHECKOUT.ORDER.APPROVED,PAYMENT.CAPTURE.COMPLETED', 'events');
  const j2 = await (await setup.fetch(req('/api/setup-webhook?token=' + SECRETS.SETUP_TOKEN))).json();
  eq(S.hooks.length, 1, 'no duplicate webhook'); eq(j2.PAYPAL_WEBHOOK_ID, j.PAYPAL_WEBHOOK_ID, 'same id'); eq(j2.already_existed, true, 'recognised');
  const env = { ...process.env }; delete process.env.SETUP_TOKEN;
  eq((await setup.fetch(req('/api/setup-webhook?token='))).status, 404, 'disabled without SETUP_TOKEN'); Object.assign(process.env, env);
  ok(!JSON.stringify(j).includes(SECRETS.PAYPAL_CLIENT_SECRET), 'the helper never shows the PayPal secret');
});
await test('no key appears in any answer, in any email, in the saved orders or in the public files', async () => {
  const vals = [...Object.entries(SECRETS).filter(([k]) => k !== 'SETUP_TOKEN'), ['PAYPAL_CLIENT_ID', CLIENT_ID]];
  const hay = seen.join('\n') + S.emails.map((e) => e.html + e.text + e.subject).join('\n') + [...S.files.values()].map((f) => Buffer.from(f.content, 'base64').toString()).join('\n');
  for (const [k, v] of vals) ok(!hay.includes(v), `${k} leaked`);
  const pub = fs.readdirSync(path.join(ROOT, 'public')).map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  for (const k of [...Object.keys(FULL_ENV), 'process.env']) ok(!pub.includes(k), `"${k}" appears in the public files`);
  const all = ['public', 'api', 'lib', '.'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => fs.statSync(path.join(ROOT, d, f)).isFile()).map((f) => [d + '/' + f, fs.readFileSync(path.join(ROOT, d, f), 'utf8')]));
  for (const [name, text] of all) {
    const long = (text.replace(/data:[^"')\s]+/g, '').match(/(?<![A-Za-z0-9_\/+.-])[A-Za-z0-9_-]{48,}(?![A-Za-z0-9_\/+.-])/g) || []).filter((s) => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s));
    ok(long.length === 0, `something that looks like a key is written in ${name}`);
  }
});
await test('only the expected services are contacted, and the PayPal login is reused', async () => {
  const hosts = [...new Set(S.log.map((l) => l.split(' ')[1].split('/')[0]))].sort();
  eq(hosts.join(), 'api-m.sandbox.paypal.com,api.github.com,api.resend.com', 'hosts');
  ok(S.tokenCalls <= 2, `PayPal login requested ${S.tokenCalls} times`);
  process.env.PAYPAL_ENV = 'live'; const n = S.log.length;
  await post({ email: 'live@example.com' }); ok(S.log.slice(n).some((l) => l.includes(' api-m.paypal.com/')), 'live address used when PAYPAL_ENV=live');
});

console.error = quiet; globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
