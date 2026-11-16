// All settings come from Vercel → Project → Settings → Environment Variables
// (with the PayPal credentials pre-configured as fallback defaults).
const env = (k) => (process.env[k] || '').trim();
const int = (k, d) => { const n = Number.parseInt(env(k), 10); return Number.isFinite(n) && n > 0 ? n : d; };

export const DEFAULT_PAYPAL_CLIENT_ID = 'Aa_gDMbfH8Xfi-76OZuvq844cg9y-nn5KpaA3jY8UgbX9zhBeXrw0VmFLttQf_XSi7Lv4bxr4GecozXW';
export const DEFAULT_PAYPAL_CLIENT_SECRET = 'ENq-oGhxHhY8SkM8ioVu8a9bcrkr-PiTnP_LewTWiuYs956J3q6IyhKj_FTSm2NCeC6WCutGXkwZ7uXA';

// Languages the confirmation email is written in (see lib/email.js). The first is the fallback.
export const LANGS = ['en', 'it'];
export const pickLang = (l) => (LANGS.includes(String(l || '').toLowerCase()) ? String(l).toLowerCase() : LANGS[0]);

export const PRODUCT = {
  en: { name: '72H Reset Protocol', bonus: '5 audio tracks' },
  it: { name: 'Protocollo Reset 72H', bonus: '5 tracce audio' },
};

export function cfg() {
  const noDefaults = env('NO_DEFAULT_CREDENTIALS') === '1';
  const rawEnv = env('PAYPAL_ENV').toLowerCase();
  const mode = rawEnv === 'production' || rawEnv === 'live' ? 'live' : rawEnv === 'sandbox' ? 'sandbox' : 'auto';
  return {
    currency: 'EUR',
    priceCents: int('PRICE_CENTS', 1490),   // keep in step with PRICE in public/index.html
    bumpCents: int('BUMP_CENTS', 490),
    paypal: {
      clientId: env('PAYPAL_CLIENT_ID') || (noDefaults ? '' : DEFAULT_PAYPAL_CLIENT_ID),
      clientSecret: env('PAYPAL_CLIENT_SECRET') || (noDefaults ? '' : DEFAULT_PAYPAL_CLIENT_SECRET),
      mode,
      base: mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com',
      webhookId: env('PAYPAL_WEBHOOK_ID'),
    },
    github: { token: env('GITHUB_TOKEN'), repo: env('GITHUB_REPO'), branch: env('GITHUB_BRANCH') },
    email: { key: env('RESEND_API_KEY'), from: env('EMAIL_FROM'), support: env('SUPPORT_EMAIL') },
    downloadSecret: env('DOWNLOAD_SECRET'),
    siteUrl: env('SITE_URL').replace(/\/+$/, ''),
    setupToken: env('SETUP_TOKEN'),
  };
}

// Link of the file to deliver. Optional per-language variants: PRODUCT_URL_IT, BONUS_URL_IT, ...
export function fileUrl(kind, lang) {
  const base = kind === 'bonus' ? 'BONUS_URL' : 'PRODUCT_URL';
  return env(`${base}_${String(lang || '').toUpperCase()}`) || env(base);
}

// Names (never values) of the settings still missing before a payment can be accepted and delivered.
export function missing() {
  const c = cfg();
  const miss = [];
  if (!c.paypal.clientId) miss.push('PAYPAL_CLIENT_ID');
  if (!c.paypal.clientSecret) miss.push('PAYPAL_CLIENT_SECRET');
  const need = ['GITHUB_TOKEN', 'GITHUB_REPO', 'RESEND_API_KEY', 'EMAIL_FROM', 'PRODUCT_URL', 'BONUS_URL', 'DOWNLOAD_SECRET'];
  for (const k of need) if (!env(k)) miss.push(k);
  if (env('GITHUB_REPO') && !/^[\w.-]+\/[\w.-]+$/.test(env('GITHUB_REPO'))) miss.push('GITHUB_REPO (format: owner/repository)');
  for (const k of ['PRODUCT_URL', 'BONUS_URL']) if (env(k) && !/^https:\/\//i.test(env(k))) miss.push(`${k} (must start with https://)`);
  if (env('DOWNLOAD_SECRET') && env('DOWNLOAD_SECRET').length < 24) miss.push('DOWNLOAD_SECRET (at least 24 characters)');
  return miss;
}
