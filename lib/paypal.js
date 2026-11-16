// PayPal REST API v2 (Orders + Webhooks).
import { cfg } from './config.js';

let tokenCache = { key: '', token: '', base: '', expiresAt: 0 };

export function resetTokenCache() {
  tokenCache = { key: '', token: '', base: '', expiresAt: 0 };
}

async function fetchToken(base, clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, text, data, base };
}

async function getAccessToken() {
  const { paypal } = cfg();
  const cacheKey = `${paypal.clientId}:${paypal.clientSecret}:${paypal.mode}`;
  if (tokenCache.key === cacheKey && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return { token: tokenCache.token, base: tokenCache.base };
  }

  let res = await fetchToken(paypal.base, paypal.clientId, paypal.clientSecret);
  if (!res.ok && res.status === 401 && paypal.mode === 'auto') {
    const altBase = paypal.base.includes('sandbox') ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const alt = await fetchToken(altBase, paypal.clientId, paypal.clientSecret);
    if (alt.ok) res = alt;
  }

  if (!res.ok || !res.data || !res.data.access_token) {
    const e = new Error(`PayPal OAuth -> ${res.status} ${res.text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }

  const ttl = Math.max(60, Number(res.data.expires_in) || 3600) - 30;
  tokenCache = {
    key: cacheKey,
    token: res.data.access_token,
    base: res.base,
    expiresAt: Date.now() + ttl * 1000,
  };
  return { token: tokenCache.token, base: tokenCache.base };
}

async function call(method, path, body) {
  const { token, base } = await getAccessToken();
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const e = new Error(`PayPal ${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

export async function createOrder({ amount, currency, description, email, reference, redirectUrl, cancelUrl, metadata }) {
  const cur = String(currency || 'EUR').toUpperCase();
  const val = (amount / 100).toFixed(2);
  const custom = JSON.stringify({ email, ...(metadata || {}) });
  const data = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: reference,
        description,
        custom_id: custom,
        amount: { currency_code: cur, value: val },
      },
    ],
    payment_source: {
      paypal: {
        email_address: email,
        experience_context: {
          brand_name: '72H Reset Protocol',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: redirectUrl,
          cancel_url: cancelUrl || redirectUrl,
        },
      },
    },
  });
  if (data && !data.checkout_url && Array.isArray(data.links)) {
    const link = data.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (link && link.href) data.checkout_url = link.href;
  }
  return data;
}

export const getOrder = (id) => call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
export const captureOrder = (id) => call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {});

// Amount (in cents) and currency of a PayPal order.
export function orderMoney(o) {
  if (o && Number.isFinite(o.amount)) return { amount: o.amount, currency: String(o.currency || '').toUpperCase() };
  const pu = (o && Array.isArray(o.purchase_units) && o.purchase_units[0]) || {};
  const cap = pu.payments && Array.isArray(pu.payments.captures) && pu.payments.captures[0];
  const a = (cap && cap.amount) || pu.amount || (o && o.order_amount) || {};
  const val = a.value !== undefined ? Math.round(Number.parseFloat(a.value) * 100) : NaN;
  const cur = String(a.currency_code || a.currency || '').toUpperCase();
  return { amount: val, currency: cur };
}

// Metadata and customer email stored on the PayPal order (used if the GitHub record needs to be rebuilt).
export function orderMeta(o) {
  if (o && o.metadata && typeof o.metadata === 'object') return o.metadata;
  const pu = (o && Array.isArray(o.purchase_units) && o.purchase_units[0]) || {};
  const cap = pu.payments && Array.isArray(pu.payments.captures) && pu.payments.captures[0];
  const raw = pu.custom_id || (cap && cap.custom_id) || '';
  if (raw) {
    try { return JSON.parse(raw) || {}; } catch {}
  }
  return {};
}

export function orderEmail(o) {
  const meta = orderMeta(o);
  return (
    meta.email ||
    (o && o.customer && o.customer.email) ||
    (o && o.payer && o.payer.email_address) ||
    (o && o.payment_source && o.payment_source.paypal && o.payment_source.paypal.email_address) ||
    (o && o.email) ||
    ''
  );
}

export async function listWebhooks() {
  const d = await call('GET', '/v1/notifications/webhooks');
  return (d && Array.isArray(d.webhooks)) ? d.webhooks : (Array.isArray(d) ? d : []);
}

export const getWebhook = (id) => call('GET', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
export const createWebhook = (url) => call('POST', '/v1/notifications/webhooks', {
  url,
  event_types: [
    { name: 'CHECKOUT.ORDER.APPROVED' },
    { name: 'PAYMENT.CAPTURE.COMPLETED' },
    { name: 'CHECKOUT.ORDER.COMPLETED' },
  ],
});

// Verifies a PayPal webhook notification via PayPal's /v1/notifications/verify-webhook-signature endpoint.
export async function verifyWebhook(rawBody, headers, now = Date.now()) {
  const webhookId = cfg().paypal.webhookId;
  const authAlgo = headers.get('paypal-auth-algo');
  const certUrl = headers.get('paypal-cert-url');
  const transmissionId = headers.get('paypal-transmission-id');
  const transmissionSig = headers.get('paypal-transmission-sig');
  const transmissionTime = headers.get('paypal-transmission-time');
  if (!webhookId || !authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return false;

  const ts = Date.parse(transmissionTime) || Number(transmissionTime);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return false;

  let evt;
  try { evt = JSON.parse(rawBody); } catch { return false; }

  try {
    const res = await call('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: evt,
    });
    return Boolean(res && res.verification_status === 'SUCCESS');
  } catch {
    return false;
  }
}
