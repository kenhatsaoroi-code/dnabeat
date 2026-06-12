// /api/usage — DNAbeat.pro
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynyfvszgxhmldjnlcmcy.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FREE_LIMIT   = 5;
const MONTHLY_CREDITS = 10000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'unauthorized' });
  const user = data.user;

  const { data: profile } = await sb.from('profiles')
    .select('plan, credits, credits_reset_at').eq('id', user.id).maybeSingle();
  const plan = profile?.plan === 'premium' ? 'premium' : 'free';

  if (plan === 'premium') {
    let credits = profile?.credits || 0;
    const resetAt = profile?.credits_reset_at ? new Date(profile.credits_reset_at) : null;
    const expired = !resetAt || (Date.now() - resetAt.getTime()) > 30 * 24 * 3600 * 1000;
    if (expired) {
      credits = MONTHLY_CREDITS;
      await sb.from('profiles').update({ credits, credits_reset_at: new Date().toISOString() }).eq('id', user.id);
    }
    return res.status(200).json({ plan, credits, monthly: MONTHLY_CREDITS });
  }

  const day = new Date().toISOString().slice(0, 10);
  const { data: row } = await sb.from('usage_daily').select('count').eq('user_id', user.id).eq('day', day).maybeSingle();
  const count = row?.count || 0;
  return res.status(200).json({
    plan, count, limit: FREE_LIMIT,
    remaining: Math.max(0, FREE_LIMIT - count)
  });
}
