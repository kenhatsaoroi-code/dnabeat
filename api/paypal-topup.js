// /api/paypal-topup — DNAbeat.pro
// One-time purchase: $5 = 3,000 credits.
// Client sends the approved orderID; server CAPTURES it with PayPal (never trust client), then adds credits.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynyfvszgxhmldjnlcmcy.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PP_CLIENT    = process.env.PAYPAL_CLIENT_ID;
const PP_SECRET    = process.env.PAYPAL_SECRET;
const PP_ENV       = process.env.PAYPAL_ENV || 'live';
const TOPUP_PRICE  = '5.00';
const TOPUP_CREDITS = 3000;

const PP_BASE = PP_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

async function paypalToken() {
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PP_CLIENT}:${PP_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error_description || 'paypal_auth_failed');
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });
  if (!PP_CLIENT || !PP_SECRET) {
    return res.status(500).json({ error: 'paypal_not_configured' });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'unauthorized' });
  const user = data.user;

  const { orderID } = req.body || {};
  if (!orderID) return res.status(400).json({ error: 'order_id_required' });

  // Capture the order server-side
  let captured;
  try {
    const ppToken = await paypalToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ppToken, 'Content-Type': 'application/json' }
    });
    captured = await r.json();
    // If already captured by a retry, fetch it instead
    if (!r.ok && captured?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') {
      const g = await fetch(`${PP_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}`, {
        headers: { 'Authorization': 'Bearer ' + ppToken }
      });
      captured = await g.json();
    } else if (!r.ok) {
      throw new Error(captured?.message || 'capture_failed');
    }
  } catch (e) {
    return res.status(502).json({ error: 'paypal_capture_failed', detail: String(e.message || e) });
  }

  // Verify amount
  const unit = captured?.purchase_units?.[0];
  const amount = unit?.payments?.captures?.[0]?.amount || unit?.amount;
  const status = captured?.status;
  if (status !== 'COMPLETED' || !amount || amount.currency_code !== 'USD' || parseFloat(amount.value) < parseFloat(TOPUP_PRICE)) {
    return res.status(400).json({ error: 'payment_invalid', status, amount });
  }

  // Add credits (idempotency: record order id to prevent double-credit)
  const { data: existing } = await sb.from('topups').select('order_id').eq('order_id', orderID).maybeSingle();
  if (existing) {
    const { data: p } = await sb.from('profiles').select('credits').eq('id', user.id).maybeSingle();
    return res.status(200).json({ ok: true, credits: p?.credits || 0, note: 'already_credited' });
  }
  await sb.from('topups').insert({ order_id: orderID, user_id: user.id, credits: TOPUP_CREDITS });

  const { data: profile } = await sb.from('profiles').select('credits').eq('id', user.id).maybeSingle();
  const newCredits = (profile?.credits || 0) + TOPUP_CREDITS;
  await sb.from('profiles').update({ credits: newCredits }).eq('id', user.id);

  return res.status(200).json({ ok: true, credits: newCredits, added: TOPUP_CREDITS });
}
