// Delivers a paid order exactly once: checks (and captures) the payment with PayPal, then sends the email.
import { cfg, pickLang } from './config.js';
import { readOrder, writeOrder, Conflict } from './github-db.js';
import { getOrder, captureOrder, orderMoney, orderMeta, orderEmail } from './paypal.js';
import { sendProductEmail } from './email.js';
import { validEmail } from './util.js';

const CLAIM_MS = 2 * 60 * 1000;   // a delivery left half-way can be taken over after 2 minutes

function normalizeState(po) {
  const s = String((po && (po.status || po.state)) || '').toUpperCase();
  if (s === 'COMPLETED') return 'completed';
  if (s === 'APPROVED') return 'approved';
  if (s === 'VOIDED' || s === 'CANCELLED') return 'cancelled';
  if (s === 'FAILED' || s === 'DECLINED') return 'failed';
  if (s === 'CREATED' || s === 'SAVED' || s === 'PAYER_ACTION_REQUIRED' || s === 'PENDING') return 'pending';
  return 'processing';
}

// Returns { status, order }. status: unknown | pending | processing | cancelled | failed | review | delivered
export async function fulfil(orderId, origin) {
  const c = cfg();
  let rec = await readOrder(orderId);
  if (rec && rec.data.status === 'delivered') return { status: 'delivered', order: rec.data };
  if (rec && rec.data.status === 'review') return { status: 'review', order: rec.data };

  // The payment state always comes from PayPal, never from the browser or from the notification alone.
  let po;
  try { po = await getOrder(orderId); }
  catch (e) { if (e.status === 404) return { status: 'unknown' }; throw e; }
  let state = normalizeState(po);

  // In PayPal Orders v2, once the buyer approves the order on PayPal, we capture it to collect the funds.
  if (state === 'approved') {
    try {
      po = await captureOrder(orderId);
      state = normalizeState(po);
    } catch (e) {
      if (e.status === 422) {
        po = await getOrder(orderId);
        state = normalizeState(po);
      } else {
        throw e;
      }
    }
  }

  if (!rec) {
    // Safety net: the order was paid but its record is missing. Rebuild it from what PayPal holds.
    const email = orderEmail(po);
    if (state !== 'completed' || !validEmail(email)) return { status: state === 'completed' ? 'review' : 'unknown' };
    const m = orderMoney(po), meta = orderMeta(po);
    const data = { id: orderId, email, lang: pickLang(meta.lang), bump: meta.bump === '1', amount: m.amount, currency: m.currency, status: 'paid', created_at: new Date().toISOString(), rebuilt: true };
    if (data.amount !== c.priceCents + (data.bump ? c.bumpCents : 0)) return { status: 'review' };
    try { rec = { data, sha: await writeOrder(orderId, data, undefined) }; }
    catch (e) { if (!(e instanceof Conflict)) throw e; rec = await readOrder(orderId); if (!rec) throw e; }
  }

  const o = rec.data;
  if (state === 'cancelled' || state === 'failed') {
    if (o.status !== state) { try { await writeOrder(orderId, { ...o, status: state, updated_at: new Date().toISOString() }, rec.sha); } catch {} }
    return { status: state, order: o };
  }
  if (state !== 'completed') return { status: state === 'pending' ? 'pending' : 'processing', order: o };

  // Paid. The amount PayPal collected must be the one we asked for.
  const paid = orderMoney(po);
  if (paid.amount !== o.amount || paid.currency !== String(o.currency).toUpperCase()) {
    console.error(`[fulfil] ${orderId}: amount mismatch, expected ${o.amount} ${o.currency}, PayPal says ${paid.amount} ${paid.currency}`);
    try { await writeOrder(orderId, { ...o, status: 'review', note: 'amount mismatch', updated_at: new Date().toISOString() }, rec.sha); } catch {}
    return { status: 'review', order: o };
  }

  // Take the order before sending, so two notifications arriving together cannot both send the email.
  if (o.status === 'delivering' && Date.now() - Date.parse(o.claimed_at || 0) < CLAIM_MS) return { status: 'processing', order: o };
  const now = new Date().toISOString();
  const claimed = { ...o, status: 'delivering', paid_at: o.paid_at || now, claimed_at: now };
  let sha;
  try { sha = await writeOrder(orderId, claimed, rec.sha); }
  catch (e) { if (e instanceof Conflict) return { status: 'processing', order: o }; throw e; }

  try {
    const emailId = await sendProductEmail(claimed, origin);
    const done = { ...claimed, status: 'delivered', delivered_at: new Date().toISOString(), email_id: emailId };
    delete done.claimed_at; delete done.last_error;
    try { await writeOrder(orderId, done, sha); }
    catch (e) { console.error(`[fulfil] ${orderId}: email sent, but the record could not be updated: ${e.message}`); }
    return { status: 'delivered', order: done };
  } catch (e) {
    // The email did not go out: release the order so the next attempt (PayPal retries) can send it.
    console.error(`[fulfil] ${orderId}: email failed: ${e.message}`);
    const back = { ...claimed, status: 'paid', last_error: String(e.message).slice(0, 200) };
    delete back.claimed_at;
    try { await writeOrder(orderId, back, sha); } catch {}
    throw e;
  }
}
