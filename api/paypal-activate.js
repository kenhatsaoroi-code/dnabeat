// /api/paypal-activate — DNAbeat.pro
// Called by the client after PayPal subscription approval.
// Verifies the subscription with PayPal's API server-side, then upgrades the user.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynyfvszgxhmldjnlcmcy.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PP_CLIENT    = process.env.PAYPAL_CLIENT_ID;
const PP_SECRET    = process.env.PAYPAL_SECRET;
const PP_PLAN_ID   = process.env.PAYPAL_PLAN_ID;          // your $10/month plan
const PP_ENV       = process.env.PAYPAL_ENV || 'live';    // 'live' or 'sandbox'
const MONTHLY_CREDITS = 10000;

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
  if (!PP_CLIENT || !PP_SECRET || !PP_PLAN_ID) {
    return res.status(500).json({ error: 'paypal_not_configured', detail: 'Set PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_PLAN_ID in Vercel env' });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'unauthorized' });
  const user = data.user;

  const { subscriptionID } = req.body || {};
  if (!subscriptionID) return res.status(400).json({ error: 'subscription_id_required' });

  // Verify with PayPal server-side — never trust the client alone
  let sub;
  try {
    const ppToken = await paypalToken();
    const r = await fetch(`${PP_BASE}/v1/billing/subscriptions/${encodeURIComponent(subscriptionID)}`, {
      headers: { 'Authorization': 'Bearer ' + ppToken }
    });
    sub = await r.json();
    if (!r.ok) throw new Error(sub?.message || 'subscription_lookup_failed');
  } catch (e) {
    return res.status(502).json({ error: 'paypal_verify_failed', detail: String(e.message || e) });
  }

  if (sub.plan_id !== PP_PLAN_ID) {
    return res.status(400).json({ error: 'wrong_plan' });
  }
  if (!['ACTIVE', 'APPROVED'].includes(sub.status)) {
    return res.status(400).json({ error: 'subscription_not_active', status: sub.status });
  }

  // Upgrade user
  await sb.from('profiles').update({
    plan: 'premium',
    credits: MONTHLY_CREDITS,
    credits_reset_at: new Date().toISOString(),
    paypal_sub_id: subscriptionID
  }).eq('id', user.id);

  return res.status(200).json({ ok: true, plan: 'premium', credits: MONTHLY_CREDITS });
}
