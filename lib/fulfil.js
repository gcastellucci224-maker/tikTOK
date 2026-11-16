// Delivers a paid order exactly once: asks PayPal for the real state of the payment, takes the money
// of an approved order, then sends the email.
import { cfg, pickLang } from './config.js';
import { readOrder, writeOrder, Conflict } from './github-db.js';
import { getOrder, captureOrder, capture, customId } from './paypal.js';
import { sendProductEmail } from './email.js';
import { validEmail } from './util.js';

const CLAIM_MS = 2 * 60 * 1000;   // a delivery left half-way can be taken over after 2 minutes
const stamp = () => new Date().toISOString();

// Returns { status, order }. status: unknown | pending | processing | cancelled | failed | review | delivered
export async function fulfil(orderId, origin) {
  const c = cfg();
  let rec = await readOrder(orderId);
  if (rec && rec.data.status === 'delivered') return { status: 'delivered', order: rec.data };
  if (rec && rec.data.status === 'review') return { status: 'review', order: rec.data };

  // The state of the payment always comes from PayPal, never from the browser or from a notification alone.
  let po;
  try { po = await getOrder(orderId); }
  catch (e) { if (e.status === 404) return { status: 'unknown' }; throw e; }
  let state = String(po.status || '').toUpperCase();

  if (state === 'APPROVED') {                 // the buyer said yes on PayPal: take the payment now
    try { po = await captureOrder(orderId); }
    catch (e) {
      if (e.status !== 422) throw e;          // 422 = PayPal refused: already captured by a parallel call, or the buyer's payment method failed
      po = await getOrder(orderId);
      if (String(po.status || '').toUpperCase() === 'APPROVED') {
        console.error(`[fulfil] ${orderId}: capture refused (${e.issue || 'unknown reason'})`);
        return { status: 'failed', order: rec && rec.data };
      }
    }
    state = String(po.status || '').toUpperCase();
  }

  if (!rec) {
    // Safety net: the order was paid but its record is missing. Rebuild it from what was stored on the PayPal order.
    const [lang, bumpFlag, ...rest] = customId(po).split('|'); const email = rest.join('|'); const cap0 = capture(po);
    if (state !== 'COMPLETED' || !cap0 || !validEmail(email)) return { status: state === 'COMPLETED' ? 'review' : 'unknown' };
    const data = { id: orderId, email, lang: pickLang(lang), bump: bumpFlag === '1', amount: cap0.amountCents, currency: cap0.currency, status: 'paid', created_at: stamp(), rebuilt: true };
    if (data.amount !== c.priceCents + (data.bump ? c.bumpCents : 0)) return { status: 'review' };
    try { rec = { data, sha: await writeOrder(orderId, data, undefined) }; }
    catch (e) { if (!(e instanceof Conflict)) throw e; rec = await readOrder(orderId); if (!rec) throw e; }
  }

  const o = rec.data;
  if (state === 'VOIDED') {
    if (o.status !== 'cancelled') { try { await writeOrder(orderId, { ...o, status: 'cancelled', updated_at: stamp() }, rec.sha); } catch {} }
    return { status: 'cancelled', order: o };
  }
  if (state !== 'COMPLETED') return { status: 'pending', order: o };     // created, waiting for the buyer

  const cap = capture(po);
  if (!cap || cap.status === 'PENDING') return { status: 'processing', order: o };   // PayPal is still checking the payment: a notification follows
  if (cap.status !== 'COMPLETED') {            // declined, failed or already refunded: nothing to deliver
    const st = cap.status === 'DECLINED' || cap.status === 'FAILED' ? 'failed' : 'review';
    if (o.status !== st) { try { await writeOrder(orderId, { ...o, status: st, note: 'capture ' + cap.status.toLowerCase(), updated_at: stamp() }, rec.sha); } catch {} }
    return { status: st, order: o };
  }

  // Paid. The amount PayPal collected must be the one we asked for.
  if (cap.amountCents !== o.amount || cap.currency !== String(o.currency).toUpperCase()) {
    console.error(`[fulfil] ${orderId}: amount mismatch, expected ${o.amount} ${o.currency}, PayPal says ${cap.amountCents} ${cap.currency}`);
    try { await writeOrder(orderId, { ...o, status: 'review', note: 'amount mismatch', updated_at: stamp() }, rec.sha); } catch {}
    return { status: 'review', order: o };
  }

  // Take the order before sending, so two requests arriving together cannot both send the email.
  if (o.status === 'delivering' && Date.now() - Date.parse(o.claimed_at || 0) < CLAIM_MS) return { status: 'processing', order: o };
  const now = stamp();
  const claimed = { ...o, status: 'delivering', paid_at: o.paid_at || now, claimed_at: now, capture_id: cap.id };
  let sha;
  try { sha = await writeOrder(orderId, claimed, rec.sha); }
  catch (e) { if (e instanceof Conflict) return { status: 'processing', order: o }; throw e; }

  try {
    const emailId = await sendProductEmail(claimed, origin);
    const done = { ...claimed, status: 'delivered', delivered_at: stamp(), email_id: emailId };
    delete done.claimed_at; delete done.last_error;
    try { await writeOrder(orderId, done, sha); }
    catch (e) { console.error(`[fulfil] ${orderId}: email sent, but the record could not be updated: ${e.message}`); }
    return { status: 'delivered', order: done };
  } catch (e) {
    // The email did not go out: release the order so the next attempt can send it.
    console.error(`[fulfil] ${orderId}: email failed: ${e.message}`);
    const back = { ...claimed, status: 'paid', last_error: String(e.message).slice(0, 200) };
    delete back.claimed_at;
    try { await writeOrder(orderId, back, sha); } catch {}
    throw e;
  }
}
