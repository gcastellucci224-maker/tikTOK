// Self-test: runs the whole purchase flow against FAKE PayPal, GitHub and Resend servers.
// No real payment, no real email, no network. Run with:  node scripts/selftest.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetTokenCache } from '../lib/paypal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://shop.example';
const SECRETS = {
  PAYPAL_CLIENT_ID: 'Aa_selftest_' + crypto.randomBytes(12).toString('hex'),
  PAYPAL_CLIENT_SECRET: 'EN_selftest_' + crypto.randomBytes(12).toString('hex'),
  PAYPAL_WEBHOOK_ID: 'WH_' + crypto.randomBytes(8).toString('hex').toUpperCase(),
  GITHUB_TOKEN: 'github_pat_selftest_' + crypto.randomBytes(12).toString('hex'),
  RESEND_API_KEY: 're_selftest_' + crypto.randomBytes(12).toString('hex'),
  DOWNLOAD_SECRET: crypto.randomBytes(24).toString('hex'),
  SETUP_TOKEN: crypto.randomBytes(16).toString('hex'),
};
const FULL_ENV = {
  ...SECRETS, PAYPAL_ENV: 'sandbox', GITHUB_REPO: 'someone/orders-db', EMAIL_FROM: 'Shop <hello@shop.example>', SUPPORT_EMAIL: 'help@shop.example',
  PRODUCT_URL: 'https://files.example/manual.zip', BONUS_URL: 'https://files.example/audio.zip', PRODUCT_URL_IT: 'https://files.example/manuale.zip', SITE_URL: SITE,
};
const ALL_KEYS = [...Object.keys(FULL_ENV), 'GITHUB_BRANCH', 'PRICE_CENTS', 'BUMP_CENTS', 'BONUS_URL_IT', 'NO_DEFAULT_CREDENTIALS'];
const setEnv = (o) => { for (const k of ALL_KEYS) delete process.env[k]; Object.assign(process.env, o); resetTokenCache(); };

// ------------------------------------------------------------------ fake services
const S = { orders: new Map(), files: new Map(), hooks: [], emails: [], resendCalls: 0, idem: new Map(), failEmail: 0, log: [], token: 'tok_' + crypto.randomBytes(8).toString('hex') };
const res = (status, data) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = new Headers(init.headers || {});
  const isForm = (h.get('content-type') || '').includes('x-www-form-urlencoded');
  const body = init.body && !isForm ? JSON.parse(init.body) : null;
  S.log.push(`${m} ${u.host}${u.pathname}`);
  await tick();
  if (u.host === 'api-m.sandbox.paypal.com' || u.host === 'api-m.paypal.com') {
    if (m === 'POST' && u.pathname === '/v1/oauth2/token') {
      const exp = 'Basic ' + Buffer.from(`${SECRETS.PAYPAL_CLIENT_ID}:${SECRETS.PAYPAL_CLIENT_SECRET}`).toString('base64');
      if (h.get('authorization') !== exp) return res(401, { error: 'invalid_client' });
      return res(200, { access_token: S.token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (h.get('authorization') !== `Bearer ${S.token}`) return res(401, { message: 'unauthorized' });
    if (m === 'POST' && u.pathname === '/v2/checkout/orders') {
      const id = 'PP' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const pu = body.purchase_units[0];
      const o = {
        id, status: 'PAYER_ACTION_REQUIRED', intent: body.intent,
        purchase_units: [pu],
        payment_source: body.payment_source,
        links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action', method: 'GET' }],
        _sent: body,
      };
      S.orders.set(id, o);
      return res(201, o);
    }
    let mm;
    if (m === 'GET' && (mm = u.pathname.match(/^\/v2\/checkout\/orders\/([\w-]+)$/))) {
      const o = S.orders.get(mm[1]);
      return o ? res(200, o) : res(404, { message: 'not found' });
    }
    if (m === 'POST' && (mm = u.pathname.match(/^\/v2\/checkout\/orders\/([\w-]+)\/capture$/))) {
      const o = S.orders.get(mm[1]);
      if (!o) return res(404, { message: 'not found' });
      if (o.status === 'COMPLETED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      o.status = 'COMPLETED';
      return res(201, o);
    }
    if (m === 'GET' && u.pathname === '/v1/notifications/webhooks') return res(200, { webhooks: S.hooks });
    if (m === 'POST' && u.pathname === '/v1/notifications/webhooks') {
      const w = { id: 'WH-' + crypto.randomBytes(6).toString('hex').toUpperCase(), url: body.url, event_types: body.event_types };
      S.hooks.push(w);
      return res(201, w);
    }
    if (m === 'GET' && (mm = u.pathname.match(/^\/v1\/notifications\/webhooks\/([\w-]+)$/))) {
      const w = S.hooks.find((x) => x.id === mm[1]);
      return w ? res(200, w) : res(404, {});
    }
    if (m === 'POST' && u.pathname === '/v1/notifications/verify-webhook-signature') {
      const expectedSig = crypto.createHmac('sha256', SECRETS.PAYPAL_WEBHOOK_ID)
        .update(`${body.transmission_id}.${body.transmission_time}.${JSON.stringify(body.webhook_event)}`)
        .digest('hex');
      const okSig = body.webhook_id === SECRETS.PAYPAL_WEBHOOK_ID && body.transmission_sig === expectedSig;
      return res(200, { verification_status: okSig ? 'SUCCESS' : 'FAILURE' });
    }
    return res(404, {});
  }
  if (u.host === 'api.github.com') {
    if (h.get('authorization') !== `Bearer ${SECRETS.GITHUB_TOKEN}`) return res(401, { message: 'Bad credentials' });
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
const sign = (evtObj, tsIso = new Date().toISOString(), whId = SECRETS.PAYPAL_WEBHOOK_ID) => {
  const tid = 'tid-' + crypto.randomBytes(4).toString('hex');
  const sig = crypto.createHmac('sha256', whId).update(`${tid}.${tsIso}.${JSON.stringify(evtObj)}`).digest('hex');
  return {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
    'paypal-transmission-id': tid,
    'paypal-transmission-time': tsIso,
    'paypal-transmission-sig': sig,
  };
};
const hook = (id, { ts, secret, event = 'CHECKOUT.ORDER.APPROVED', tamper } = {}) => {
  const evtObj = { event_type: event, resource: { id } };
  const raw = JSON.stringify(evtObj);
  const tsIso = ts ? new Date(ts).toISOString() : new Date().toISOString();
  const headers = { 'content-type': 'application/json', ...sign(evtObj, tsIso, secret || SECRETS.PAYPAL_WEBHOOK_ID) };
  return webhook.fetch(req('/api/paypal-webhook', { method: 'POST', body: tamper ? raw.replace(id, tamper) : raw, headers }));
};
const pay = (id) => { S.orders.get(id).status = 'APPROVED'; };
const linksIn = (html) => [...html.matchAll(/href="([^"]+\/api\/download[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

let passed = 0, failed = 0; const seen = [];
const quiet = console.error; console.error = () => {};
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
  setEnv({ SITE_URL: SITE, NO_DEFAULT_CREDENTIALS: '1' });
  const r = await post({ email: 'anna@example.com' }); eq(r.status, 503, 'status'); eq((await body(r)).error, 'not_configured', 'error');
  setEnv({ ...FULL_ENV, PAYPAL_CLIENT_SECRET: '', NO_DEFAULT_CREDENTIALS: '1' });
  eq((await post({ email: 'anna@example.com' })).status, 503, 'status without PayPal secret');
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
await test('base order: 14.90 EUR, email sent to PayPal, order saved as pending', async () => {
  const r = await post({ email: '  anna@example.com ', bump: false, lang: 'en' }); eq(r.status, 200, 'status');
  const j = await body(r); A = j.order_id;
  const o = S.orders.get(A); ok(o, 'order exists at PayPal');
  eq(o.purchase_units[0].amount.value, '14.90', 'amount'); eq(o.purchase_units[0].amount.currency_code, 'EUR', 'currency');
  eq(o.payment_source.paypal.email_address, 'anna@example.com', 'customer email');
  eq(o.intent, 'CAPTURE', 'intent');
  eq(o.payment_source.paypal.experience_context.return_url, SITE + '/thanks?lang=en', 'redirect');
  eq(j.checkout_url, o.links[0].href, 'checkout url');
  const d = dbOrder(A); eq(d.status, 'pending', 'db status'); eq(d.email, 'anna@example.com', 'db email'); eq(d.amount, 1490, 'db amount'); eq(d.bump, false, 'db bump');
});
await test('bundle order: 19.80 EUR, and a price sent by the browser is ignored', async () => {
  const r = await post({ email: 'luca@example.com', bump: true, lang: 'it', amount: 1, price: 1, priceCents: 1 }); eq(r.status, 200, 'status');
  B = (await body(r)).order_id;
  eq(S.orders.get(B).purchase_units[0].amount.value, '19.80', 'amount');
  eq(JSON.parse(S.orders.get(B).purchase_units[0].custom_id).bump, '1', 'metadata');
  eq(dbOrder(B).lang, 'it', 'lang');
  const r2 = await post({ email: 'x@example.com', bump: 'yes', lang: 'zz', amount: 1 }); const id = (await body(r2)).order_id;
  eq(S.orders.get(id).purchase_units[0].amount.value, '14.90', 'non-boolean bump'); eq(dbOrder(id).lang, 'en', 'unknown language falls back to English');
});

console.log('\nPayment notification (webhook)');
await test('rejects a forged, altered, expired or unsigned notification', async () => {
  pay(A);
  eq((await hook(A, { secret: 'WH_WRONG' })).status, 401, 'wrong secret');
  eq((await hook(A, { tamper: B })).status, 401, 'altered body');
  eq((await hook(A, { ts: Date.now() - 6 * 60 * 1000 })).status, 401, 'old timestamp');
  eq((await webhook.fetch(req('/api/paypal-webhook', { method: 'POST', body: '{}' }))).status, 401, 'no signature');
  eq(S.emails.length, 0, 'emails sent'); eq(dbOrder(A).status, 'pending', 'db status');
  S.orders.get(A).status = 'PAYER_ACTION_REQUIRED';
});
await test('a notification alone is not enough: PayPal must confirm the order is approved/paid', async () => {
  eq((await hook(A)).status, 204, 'status'); eq(S.emails.length, 0, 'emails sent'); eq(dbOrder(A).status, 'pending', 'db status');
  eq((await hook(A, { event: 'OTHER.EVENT' })).status, 204, 'other event ignored');
});
await test('approved order: captured on PayPal, one email to the buyer with a working download link', async () => {
  pay(A); eq((await hook(A)).status, 204, 'status');
  eq(S.orders.get(A).status, 'COMPLETED', 'captured on PayPal');
  eq(S.emails.length, 1, 'emails sent'); const e = S.emails[0];
  eq(e.to[0], 'anna@example.com', 'recipient'); eq(e.from, FULL_ENV.EMAIL_FROM, 'sender'); ok(/72H Reset Protocol/.test(e.subject), 'English subject');
  const links = linksIn(e.html); eq(new Set(links).size, 1, 'download links (no bonus bought)'); ok(links[0].startsWith(SITE + '/api/download?'), 'link points to the site');
  const d = dbOrder(A); eq(d.status, 'delivered', 'db status'); ok(d.delivered_at && d.paid_at, 'dates saved');
  const r = await download.fetch(new Request(links[0])); eq(r.status, 302, 'download status'); eq(r.headers.get('location'), FULL_ENV.PRODUCT_URL, 'download target');
});
await test('the same notification again does not send a second email', async () => {
  const before = S.resendCalls;
  eq((await hook(A)).status, 204, 'status'); eq((await hook(A)).status, 204, 'status');
  eq(S.resendCalls, before, 'calls to the email service'); eq(S.emails.length, 1, 'emails sent');
});
await test('Italian bundle order, 4 notifications at the same moment: still one email, two links', async () => {
  pay(B); const before = S.resendCalls;
  const rs = await Promise.all([hook(B), hook(B), hook(B), status.fetch(req('/api/status?id=' + B))]);
  ok(rs.every((r) => r.status === 204 || r.status === 200), 'all answered');
  eq(S.resendCalls - before, 1, 'calls to the email service');
  const e = S.emails.at(-1); eq(e.to[0], 'luca@example.com', 'recipient'); ok(/Protocollo Reset 72H/.test(e.subject), 'Italian subject');
  const links = [...new Set(linksIn(e.html))]; eq(links.length, 2, 'download links');
  const [m, b] = await Promise.all(links.map((l) => download.fetch(new Request(l))));
  eq(m.headers.get('location'), FULL_ENV.PRODUCT_URL_IT, 'Italian file'); eq(b.headers.get('location'), FULL_ENV.BONUS_URL, 'bonus file');
  eq(dbOrder(B).status, 'delivered', 'db status');
});
await test('email service down: PayPal is asked to retry, and the retry delivers', async () => {
  const id = (await body(await post({ email: 'sara@example.com', bump: false, lang: 'en' }))).order_id; pay(id);
  S.failEmail = 1; const n = S.emails.length;
  eq((await hook(id)).status, 500, 'first attempt'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'paid', 'db status after failure');
  eq((await hook(id)).status, 204, 'retry'); eq(S.emails.length, n + 1, 'emails sent after retry'); eq(dbOrder(id).status, 'delivered', 'db status');
});
await test('amount paid differs from the price: nothing is delivered, order flagged for review', async () => {
  const id = (await body(await post({ email: 'tom@example.com', bump: true, lang: 'en' }))).order_id;
  S.orders.get(id).purchase_units[0].amount.value = '1.00'; pay(id); const n = S.emails.length;
  eq((await hook(id)).status, 204, 'status'); eq(S.emails.length, n, 'emails sent'); eq(dbOrder(id).status, 'review', 'db status');
});
await test('paid order whose record is missing is rebuilt from PayPal and delivered', async () => {
  const id = (await body(await post({ email: 'eva@example.com', bump: true, lang: 'it' }))).order_id;
  S.files.delete(`orders/${id}.json`); pay(id); const n = S.emails.length;
  eq((await hook(id)).status, 204, 'status'); eq(S.emails.length, n + 1, 'emails sent'); eq(S.emails.at(-1).to[0], 'eva@example.com', 'recipient');
  eq(dbOrder(id).status, 'delivered', 'db status'); eq(dbOrder(id).bump, true, 'bump kept');
});

console.log('\nThank-you page and downloads');
let C;
await test('status: pending before payment, delivered after (also captures & delivers if webhook never arrives)', async () => {
  C = (await body(await post({ email: 'marta.rossi@example.com', bump: false, lang: 'en' }))).order_id;
  eq((await body(await status.fetch(req('/api/status?id=' + C)))).status, 'pending', 'before');
  pay(C); const n = S.emails.length;
  const j = await body(await status.fetch(req('/api/status?id=' + C)));
  eq(j.status, 'delivered', 'after'); eq(S.emails.length, n + 1, 'emails sent'); eq(j.email, 'ma•••@example.com', 'email is masked'); eq(j.support, 'help@shop.example', 'support');
  eq((await body(await status.fetch(req('/api/status?id=' + crypto.randomUUID())))).status, 'unknown', 'unknown order');
  eq((await status.fetch(req('/api/status?id=../../etc'))).status, 400, 'bad id');
});
await test('downloads: wrong signature, unpaid order or bonus not bought are refused', async () => {
  const sig = (id, f) => crypto.createHmac('sha256', SECRETS.DOWNLOAD_SECRET).update(`${id}.${f}`).digest('hex');
  const get = (id, f, s) => download.fetch(req(`/api/download?id=${id}&f=${f}&sig=${s}`));
  eq((await get(C, 'main', sig(C, 'main'))).status, 302, 'valid');
  eq((await get(C, 'main', 'deadbeef')).status, 403, 'bad signature');
  eq((await get(C, 'main', sig(A, 'main'))).status, 403, 'signature of another order');
  eq((await get(C, 'bonus', sig(C, 'main'))).status, 403, 'signature of another file');
  eq((await get(C, 'bonus', sig(C, 'bonus'))).status, 403, 'bonus not bought');
  const U = (await body(await post({ email: 'nopay@example.com', bump: true }))).order_id;
  eq((await get(U, 'main', sig(U, 'main'))).status, 303 >= 0 ? 403 : 403, 'unpaid order');
  eq((await get(C, 'other', sig(C, 'other'))).status, 403, 'unknown file');
});

console.log('\nSetup helper and secrets');
await test('setup-webhook works only with the setup token and registers the right address', async () => {
  eq((await setup.fetch(req('/api/setup-webhook'))).status, 404, 'no token');
  eq((await setup.fetch(req('/api/setup-webhook?token=wrong'))).status, 404, 'wrong token');
  const j = await (await setup.fetch(req('/api/setup-webhook?token=' + SECRETS.SETUP_TOKEN))).json();
  eq(j.webhook_url, SITE + '/api/paypal-webhook', 'address'); ok(String(j.PAYPAL_WEBHOOK_ID).startsWith('WH-'), 'webhook ID returned');
  const j2 = await (await setup.fetch(req('/api/setup-webhook?token=' + SECRETS.SETUP_TOKEN))).json();
  eq(S.hooks.length, 1, 'no duplicate webhook'); eq(j2.PAYPAL_WEBHOOK_ID, j.PAYPAL_WEBHOOK_ID, 'same id'); eq(j2.already_existed, true, 'recognised');
  const env = { ...process.env }; delete process.env.SETUP_TOKEN;
  eq((await setup.fetch(req('/api/setup-webhook?token='))).status, 404, 'disabled without SETUP_TOKEN'); Object.assign(process.env, env);
});
await test('no secret appears in any answer, in any email or in the public files', async () => {
  const vals = Object.entries(SECRETS).filter(([k]) => k !== 'SETUP_TOKEN');
  const hay = seen.join('\n') + S.emails.map((e) => e.html + e.text + e.subject).join('\n');
  for (const [k, v] of vals) ok(!hay.includes(v), `${k} leaked in an answer or email`);
  const pub = fs.readdirSync(path.join(ROOT, 'public')).map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  for (const k of [...Object.keys(FULL_ENV), 'process.env']) ok(!pub.includes(k), `"${k}" appears in the public files`);
  ok(!/\b(sk|wsk|re|ghp|github_pat)_[A-Za-z0-9]{8,}/.test(pub), 'something that looks like a key is in the public files');
});
await test('only the expected services are contacted', async () => {
  const hosts = [...new Set(S.log.map((l) => l.split(' ')[1].split('/')[0]))].sort();
  eq(hosts.join(), 'api-m.sandbox.paypal.com,api.github.com,api.resend.com', 'hosts');
  process.env.PAYPAL_ENV = 'production'; resetTokenCache(); const n = S.log.length;
  await post({ email: 'live@example.com' }); ok(S.log.slice(n).some((l) => l.includes(' api-m.paypal.com/')), 'production address used when PAYPAL_ENV=production');
});

console.error = quiet; globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
