import crypto from 'node:crypto';
// All settings come from Vercel → Project → Settings → Environment Variables.
// Nothing secret is written in the code or in the public page.
const env = (k) => (process.env[k] || '').trim();
const int = (k, d) => { const n = Number.parseInt(env(k), 10); return Number.isFinite(n) && n > 0 ? n : d; };

// Languages the confirmation email is written in (see lib/email.js). The first is the fallback.
export const LANGS = ['en', 'it'];
export const pickLang = (l) => (LANGS.includes(String(l || '').toLowerCase()) ? String(l).toLowerCase() : LANGS[0]);

export const PRODUCT = {
  en: { name: '72H Reset Protocol', bonus: '5 audio tracks' },
  it: { name: 'Protocollo Reset 72H', bonus: '5 tracce audio' },
};

export function cfg() {
  return {
    currency: 'EUR',
    priceCents: int('PRICE_CENTS', 1490),   // keep in step with PRICE in public/index.html
    bumpCents: int('BUMP_CENTS', 490),
    paypal: {
      clientId: env('PAYPAL_CLIENT_ID'),
      secret: env('PAYPAL_CLIENT_SECRET'),
      base: ['live', 'production'].includes(env('PAYPAL_ENV').toLowerCase()) ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
      webhookId: env('PAYPAL_WEBHOOK_ID'),
    },
    github: { token: env('GITHUB_TOKEN'), repo: env('GITHUB_REPO'), branch: env('GITHUB_BRANCH') },
    email: { key: env('RESEND_API_KEY'), from: env('EMAIL_FROM'), support: env('SUPPORT_EMAIL') },
    // signs the download links; when not set, one is derived from the PayPal secret (never shown anywhere)
    downloadSecret: env('DOWNLOAD_SECRET') || (env('PAYPAL_CLIENT_SECRET') ? crypto.createHmac('sha256', env('PAYPAL_CLIENT_SECRET')).update('download-links').digest('hex') : ''),
    siteUrl: env('SITE_URL').replace(/\/+$/, ''),
    setupToken: env('SETUP_TOKEN'),
  };
}

// Link of the file to deliver. Optional per-language variants: PRODUCT_URL_IT, BONUS_URL_IT, ...
export function fileUrl(kind, lang) {
  const base = kind === 'bonus' ? 'BONUS_URL' : 'PRODUCT_URL';
  return env(`${base}_${String(lang || '').toUpperCase()}`) || env(base);
}

// Names (never values) of the settings still missing before a payment can be accepted.
// Only PayPal and the orders repository are required. Email, product links and the PayPal webhook are optional extras.
export function missing() {
  const need = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GITHUB_TOKEN', 'GITHUB_REPO'];
  const miss = need.filter((k) => !env(k));
  if (env('GITHUB_REPO') && !/^[\w.-]+\/[\w.-]+$/.test(env('GITHUB_REPO'))) miss.push('GITHUB_REPO (format: owner/repository)');
  for (const k of ['PRODUCT_URL', 'BONUS_URL']) if (env(k) && !/^https:\/\//i.test(env(k))) miss.push(`${k} (must start with https://)`);
  return miss;
}
export const emailReady = () => Boolean(env('RESEND_API_KEY') && env('EMAIL_FROM'));
