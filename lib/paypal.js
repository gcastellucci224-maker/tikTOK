// PayPal REST API (Orders v2). The client id and the secret are read from the Vercel settings, never from the code.
import crypto from 'node:crypto';
import { cfg } from './config.js';

let cached = { key: '', token: '', until: 0 };

async function accessToken() {
  const { paypal } = cfg();
  const key = paypal.base + '|' + paypal.clientId;
  if (cached.token && cached.key === key && Date.now() < cached.until) return cached.token;
  const r = await fetch(paypal.base + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${paypal.clientId}:${paypal.secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`PayPal login -> ${r.status} ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  const j = JSON.parse(text);
  cached = { key, token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 300) - 120) * 1000 };
  return cached.token;
}

// body: an object (sent as JSON) or a ready-made JSON string
async function call(method, path, body, extraHeaders = {}) {
  const { paypal } = cfg();
  const send = async () => fetch(paypal.base + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let r = await send();
  if (r.status === 401) { cached.token = ''; r = await send(); }           // the saved login expired early: get a new one, once
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const e = new Error(`PayPal ${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status; e.issue = data && data.details && data.details[0] && data.details[0].issue; throw e;
  }
  return data;
}

const LOCALE = { en: 'en-GB', it: 'it-IT' };

// Creates the order. The buyer then approves it on PayPal's own page (the "payer-action" link).
export function createOrder({ amountCents, currency, description, customId, brand, lang, returnUrl, cancelUrl }) {
  return call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      description: description.slice(0, 127),
      ...(customId ? { custom_id: customId } : {}),
      amount: { currency_code: currency, value: (amountCents / 100).toFixed(2) },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name: brand.slice(0, 127),
      ...(LOCALE[lang] ? { locale: LOCALE[lang] } : {}),
      shipping_preference: 'NO_SHIPPING',                   // digital product: no address asked
      user_action: 'PAY_NOW',
      payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    } } },
  }, { 'PayPal-Request-Id': crypto.randomUUID() });
}
export const approveLink = (order) => {
  const l = ((order && order.links) || []).find((x) => x.rel === 'payer-action') || ((order && order.links) || []).find((x) => x.rel === 'approve');
  return l && /^https:\/\//.test(l.href || '') ? l.href : '';
};
export const getOrder = (id) => call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
// Takes the money of an approved order. The same request id makes a repeated call return the same result.
export const captureOrder = (id) => call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, { 'PayPal-Request-Id': 'capture-' + id });

// The payment taken for an order: { id, status, amountCents, currency } or null when nothing was captured yet.
export function capture(order) {
  const pu = order && order.purchase_units && order.purchase_units[0];
  const c = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  if (!c) return null;
  const a = c.amount || {};
  return { id: c.id, status: String(c.status || '').toUpperCase(), amountCents: Math.round(Number(a.value) * 100), currency: String(a.currency_code || '').toUpperCase() };
}
export const customId = (order) => { const pu = order && order.purchase_units && order.purchase_units[0]; return (pu && pu.custom_id) || ''; };

export const listWebhooks = async () => ((await call('GET', '/v1/notifications/webhooks')) || {}).webhooks || [];
export const WEBHOOK_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED'];
export const createWebhook = (url) => call('POST', '/v1/notifications/webhooks', { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) });

// Asks PayPal itself whether a notification is genuine. Returns true, or false for a forged or incomplete one.
// The notification is passed on byte for byte: rewriting it could make a genuine one fail the check.
export async function verifyWebhook(rawBody, headers) {
  const { paypal } = cfg();
  const h = (k) => headers.get(k) || '';
  const f = { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: paypal.webhookId };
  if (Object.values(f).some((v) => !v)) return false;
  try { const t = JSON.parse(rawBody); if (!t || typeof t !== 'object' || Array.isArray(t)) return false; } catch { return false; }
  const body = JSON.stringify(f).slice(0, -1) + ',"webhook_event":' + rawBody + '}';
  try {
    const r = await call('POST', '/v1/notifications/verify-webhook-signature', body);
    return Boolean(r && r.verification_status === 'SUCCESS');
  } catch (e) {
    if (e.status === 400 || e.status === 422) return false;   // PayPal could not even read the signature data: not genuine
    throw e;
  }
}
