// Settings come from Vercel → Project → Settings → Environment Variables,
// with pre-configured defaults so PayPal checkout works immediately.
const env = (k) => (process.env[k] || '').trim();
const int = (k, d) => { const n = Number.parseInt(env(k), 10); return Number.isFinite(n) && n > 0 ? n : d; };

export const DEFAULT_PAYPAL_CLIENT_ID = 'Aa_gDMbfH8Xfi-76OZuvq844cg9y-nn5KpaA3jY8UgbX9zhBeXrw0VmFLttQf_XSi7Lv4bxr4GecozXW';
export const DEFAULT_PAYPAL_CLIENT_SECRET = 'ENq-oGhxHhY8SkM8ioVu8a9bcrkr-PiTnP_LewTWiuYs956J3q6IyhKj_FTSm2NCeC6WCutGXkwZ7uXA';
export const DEFAULT_GITHUB_TOKEN = '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';
export const DEFAULT_GITHUB_REPO = 'gcastellucci224-maker/tikTOK';
export const DEFAULT_DOWNLOAD_SECRET = 'r72h_default_download_secret_9f8e7d6c5b4a3210';

// Cleans accidental GitHub URLs or "/tree/main" suffixes into "owner/repo"
function cleanRepo(raw) {
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/tree\/[^/]+.*$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

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
    github: {
      token: env('GITHUB_TOKEN') || (noDefaults ? '' : DEFAULT_GITHUB_TOKEN),
      repo: cleanRepo(env('GITHUB_REPO')) || (noDefaults ? '' : DEFAULT_GITHUB_REPO),
      branch: env('GITHUB_BRANCH'),
    },
    email: { key: env('RESEND_API_KEY'), from: env('EMAIL_FROM'), support: env('SUPPORT_EMAIL') },
    downloadSecret: env('DOWNLOAD_SECRET') || (noDefaults ? '' : DEFAULT_DOWNLOAD_SECRET),
    siteUrl: env('SITE_URL').replace(/\/+$/, ''),
    setupToken: env('SETUP_TOKEN'),
  };
}

// Link of the file to deliver. Optional per-language variants: PRODUCT_URL_IT, BONUS_URL_IT, ...
export function fileUrl(kind, lang) {
  const base = kind === 'bonus' ? 'BONUS_URL' : 'PRODUCT_URL';
  return env(`${base}_${String(lang || '').toUpperCase()}`) || env(base);
}

// Only PayPal credentials are required to open the PayPal checkout.
export function missing() {
  const c = cfg();
  const miss = [];
  if (!c.paypal.clientId) miss.push('PAYPAL_CLIENT_ID');
  if (!c.paypal.clientSecret) miss.push('PAYPAL_CLIENT_SECRET');
  return miss;
}
