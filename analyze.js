// /api/analyze — DNAbeat.pro
// Verifies Supabase JWT, enforces daily quota, calls Gemini (key stays server-side)
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynyfvszgxhmldjnlcmcy.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY; // set in Vercel env
const GEMINI_KEY   = process.env.GEMINI_API_KEY;            // set in Vercel env
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FREE_LIMIT   = 5;

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function getUserFromReq(req, sb) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Gemini prompt builders ----------
const JSON_RULE = `Respond with ONLY a valid JSON object. No markdown fences, no preamble, no trailing text.`;

function scanPrompt(lang) {
  const L = lang === 'en' ? 'English' : 'Vietnamese';
  return `You are MUSIC DNA — an expert music producer and Suno AI prompt engineer. LISTEN to the attached audio carefully (instruments, vocal character, BPM, key, mix, energy curve, structure) and reverse-engineer a Suno prompt that recreates this song's DNA as closely as possible.

Rules for the Suno prompt:
- "style" must be a SHORT style-of-music string, max 25 words, comma-separated descriptors (genre, sub-genre, BPM, vocal type, key instruments, mood, production style).
- "exclude" lists styles/elements to exclude so Suno doesn't drift.
- "lyricsTemplate" is a structure skeleton with section-level tags ONLY, like [Verse 1 - soft, intimate], [Chorus - emotional, voice soaring]. Never per-line tags. Natural flowing lines with varied lengths, not square/uniform lines.
- "moreOptions": styleInfluence between 45 and 70, weirdness between 15 and 25, vocalGender "male"/"female"/"duet"/"none".

All human-readable analysis text must be in ${L}.

${JSON_RULE}
JSON shape:
{
 "heard": { "genre":"", "bpm":"", "key":"", "vocal":"", "instruments":[""], "mood":"", "structure":"", "production":"", "energy":"" },
 "prompt": {
   "title": "",
   "style": "",
   "exclude": "",
   "lyricsTemplate": "",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "" }
 },
 "tips": ["", ""]
}`;
}

function tunePrompt(lang, currentPrompt, feedback) {
  const L = lang === 'en' ? 'English' : 'Vietnamese';
  return `You are MUSIC DNA — Suno prompt refinement expert. The attached audio is the ORIGINAL reference song. The user generated a version on Suno using this prompt:

--- CURRENT PROMPT ---
${currentPrompt}
--- END ---

User feedback about what is still wrong / different from the original: "${feedback || 'no specific feedback, just get closer to the original'}"

LISTEN to the original again, diagnose what the current prompt fails to capture, and produce a refined prompt that gets the Suno output to 99% match. Keep "style" max 25 words. Section-level lyric tags only. styleInfluence 45-70, weirdness 15-25.

All human-readable text in ${L}.

${JSON_RULE}
JSON shape:
{
 "diagnosis": ["", ""],
 "changes": [ { "what":"", "why":"" } ],
 "prompt": {
   "title": "",
   "style": "",
   "exclude": "",
   "lyricsTemplate": "",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "" }
 },
 "tips": [""]
}`;
}

function remixPrompt(lang, dna, target) {
  const L = lang === 'en' ? 'English' : 'Vietnamese';
  return `You are MUSIC DNA — style transformation expert. Here is the DNA of an original song (from a previous scan):

--- ORIGINAL DNA ---
${dna}
--- END ---

Transform it into a NEW version with these choices:
- Target style: ${target.style || 'keep original'}
- Vocal: ${target.voice || 'keep original'}
- Mood: ${target.mood || 'keep original'}
- Lyrics provided by user (adapt to fit new style; if empty, write a new lyrics TEMPLATE on the same theme): ${target.lyrics ? '\n' + target.lyrics : '(empty)'}

Keep the recognizable DNA (melody feel, theme, hook idea) but fully transform the style. "style" max 25 words. Section-level tags only, varied line lengths. styleInfluence 45-70, weirdness 15-25.

All human-readable text in ${L}.

${JSON_RULE}
JSON shape:
{
 "kept": ["", ""],
 "changed": ["", ""],
 "prompt": {
   "title": "",
   "style": "",
   "exclude": "",
   "lyricsTemplate": "",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "" }
 },
 "tips": [""]
}`;
}

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: 'application/json' }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!SERVICE_KEY || !GEMINI_KEY) return res.status(500).json({ error: 'server_not_configured', detail: 'Missing SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY env vars' });

  const sb = admin();
  const user = await getUserFromReq(req, sb);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  // plan
  const { data: profile } = await sb.from('profiles').select('plan').eq('id', user.id).maybeSingle();
  const plan = profile?.plan === 'premium' ? 'premium' : 'free';

  // quota
  const day = todayUTC();
  const { data: row } = await sb.from('usage_daily').select('count').eq('user_id', user.id).eq('day', day).maybeSingle();
  const count = row?.count || 0;
  if (plan === 'free' && count >= FREE_LIMIT) {
    return res.status(429).json({ error: 'limit_reached', plan, count, limit: FREE_LIMIT });
  }

  const { mode, lang = 'vi', audio, mimeType = 'audio/wav', currentPrompt, feedback, dna, target } = req.body || {};
  if (!['scan', 'tune', 'remix'].includes(mode)) return res.status(400).json({ error: 'bad_mode' });
  if ((mode === 'scan' || mode === 'tune') && !audio) return res.status(400).json({ error: 'audio_required' });
  if (mode === 'remix' && !dna) return res.status(400).json({ error: 'dna_required' });

  let parts;
  if (mode === 'scan') {
    parts = [{ text: scanPrompt(lang) }, { inline_data: { mime_type: mimeType, data: audio } }];
  } else if (mode === 'tune') {
    parts = [{ text: tunePrompt(lang, currentPrompt || '', feedback || '') }, { inline_data: { mime_type: mimeType, data: audio } }];
  } else {
    parts = [{ text: remixPrompt(lang, dna, target || {}) }];
  }

  let result;
  try {
    result = await callGemini(parts);
  } catch (e) {
    return res.status(502).json({ error: 'gemini_failed', detail: String(e.message || e) });
  }

  // increment usage (service role bypasses RLS)
  const newCount = count + 1;
  await sb.from('usage_daily').upsert({ user_id: user.id, day, count: newCount }, { onConflict: 'user_id,day' });

  return res.status(200).json({
    result,
    usage: { plan, count: newCount, limit: plan === 'premium' ? null : FREE_LIMIT }
  });
}
