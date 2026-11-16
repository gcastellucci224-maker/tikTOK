// The email that delivers the product (sent with Resend: https://resend.com).
import { cfg, pickLang, PRODUCT } from './config.js';
import { hmacHex, escHtml } from './util.js';

// One block per language. To add a language: copy "en", translate, and add its code to LANGS in lib/config.js.
const TEXT = {
  en: {
    subject: 'Your {name} is ready to download',
    hello: 'Your purchase is confirmed. Thank you.',
    intro: 'Here is your {name}. Download it and keep it on your device: you can start this weekend.',
    main: 'Download the {name}',
    bonus: 'Download the {bonus}',
    plain: 'If a button does not work, copy this link into your browser:',
    keep: 'Keep this email: the links stay valid if you need to download again.',
    help: 'Need help? Write to {support}.',
    order: 'Order',
  },
  it: {
    subject: 'Il tuo {name} è pronto da scaricare',
    hello: 'Il tuo acquisto è confermato. Grazie.',
    intro: 'Ecco il tuo {name}. Scaricalo e tienilo sul tuo dispositivo: puoi iniziare già questo weekend.',
    main: 'Scarica il {name}',
    bonus: 'Scarica le {bonus}',
    plain: 'Se un pulsante non funziona, copia questo link nel browser:',
    keep: 'Conserva questa email: i link restano validi se devi scaricare di nuovo.',
    help: 'Serve aiuto? Scrivi a {support}.',
    order: 'Ordine',
  },
};

export const downloadSig = (id, f) => hmacHex(cfg().downloadSecret, `${id}.${f}`);
export const downloadLink = (origin, id, f) => `${origin}/api/download?id=${encodeURIComponent(id)}&f=${f}&sig=${downloadSig(id, f)}`;

export function buildEmail(order, origin) {
  const lang = pickLang(order.lang);
  const T = TEXT[lang] || TEXT.en, P = PRODUCT[lang] || PRODUCT.en;
  const { email } = cfg();
  const fill = (s) => s.replace('{name}', P.name).replace('{bonus}', P.bonus).replace('{support}', email.support);
  const links = [{ label: fill(T.main), url: downloadLink(origin, order.id, 'main') }];
  if (order.bump) links.push({ label: fill(T.bonus), url: downloadLink(origin, order.id, 'bonus') });

  const btn = (l) => `<p style="margin:0 0 14px"><a href="${escHtml(l.url)}" style="display:inline-block;padding:15px 22px;border-radius:14px;background:#7DF9C1;color:#04130D;font-weight:800;font-size:16px;text-decoration:none">${escHtml(l.label)}</a></p>`;
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:0;background:#F3F4F6">
<div style="max-width:520px;margin:0 auto;padding:28px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="background:#0B0D14;border-radius:20px;padding:28px 24px;color:#EDEBE6">
    <p style="margin:0 0 6px;font-size:14px;color:#7DF9C1;font-weight:700">${escHtml(P.name)}</p>
    <h1 style="margin:0 0 12px;font-size:23px;line-height:1.25;color:#FFFFFF">${escHtml(fill(T.hello))}</h1>
    <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#C9C7C2">${escHtml(fill(T.intro))}</p>
    ${links.map(btn).join('\n    ')}
    <p style="margin:18px 0 6px;font-size:13px;line-height:1.5;color:#9A9DA8">${escHtml(T.plain)}</p>
    ${links.map((l) => `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;word-break:break-all"><a href="${escHtml(l.url)}" style="color:#7DF9C1">${escHtml(l.url)}</a></p>`).join('\n    ')}
  </div>
  <p style="margin:16px 8px 0;font-size:13px;line-height:1.5;color:#6B7280">${escHtml(T.keep)}${email.support ? ' ' + escHtml(fill(T.help)) : ''}</p>
  <p style="margin:6px 8px 0;font-size:12px;color:#9CA3AF">${escHtml(T.order)}: ${escHtml(order.id)}</p>
</div></body></html>`;
  const text = [fill(T.hello), '', fill(T.intro), '', ...links.flatMap((l) => [l.label + ':', l.url, '']), T.keep, email.support ? fill(T.help) : '', `${T.order}: ${order.id}`].filter((x) => x !== null).join('\n');
  return { subject: fill(T.subject), html, text };
}

export async function sendProductEmail(order, origin) {
  const { email } = cfg();
  const m = buildEmail(order, origin);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${email.key}`,
      'Content-Type': 'application/json',
      // Same key = same email: if the delivery is retried, Resend does not send it twice.
      'Idempotency-Key': `reset72h-${order.id}`,
    },
    body: JSON.stringify({
      from: email.from, to: [order.email], subject: m.subject, html: m.html, text: m.text,
      ...(email.support ? { reply_to: email.support } : {}),
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Resend -> ${r.status} ${body.slice(0, 200)}`);
  try { return JSON.parse(body).id || null; } catch { return null; }
}
