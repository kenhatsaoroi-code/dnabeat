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
  return `You are MUSIC DNA — a Grammy-level music producer, mixing engineer, and the world's #1 Suno AI prompt engineer. You have produced 10,000+ tracks across every genre. LISTEN to the attached audio with extreme precision and reverse-engineer a Suno prompt that recreates this song's DNA.

CRITICAL LISTENING CHECKLIST — answer each precisely:
1. VOCAL: Is the singer male or female? Listen to pitch range, timbre, chest/head voice. Soprano/alto = female. Tenor/bass = male. Two voices alternating = duet. Be 100% accurate — getting gender wrong ruins the entire prompt.
2. VOCAL CHARACTER: breathy? husky? clear/bright? nasal? raspy? falsetto? vibrato-heavy? whisper sections? ad-libs? Describe the EXACT vocal texture — this is what makes Suno output sound human vs robotic.
3. BPM: Count precisely — tap along mentally. Don't guess round numbers.
4. KEY: Identify the actual musical key (e.g. "Eb minor", "A major"). If uncertain, give best estimate.
5. INSTRUMENTS: List every distinct instrument/sound layer you hear (e.g. "fingerpicked acoustic guitar", "sub bass 808", "shimmering synth pad", "trap hi-hats", "orchestral strings pizzicato"). Be specific — "guitar" is too vague.
6. PRODUCTION STYLE: Describe the mix — is it lo-fi/dusty? clean/polished? heavily compressed? spacious/reverb-heavy? layered? minimalist? What era/school does it sound like?
7. ENERGY CURVE: How does energy flow across the song? (e.g. "starts intimate/quiet → builds through pre-chorus → explodes at chorus → drops to bridge → final chorus bigger than first")
8. STRUCTURE: Map the exact sections (Intro, Verse 1, Pre-Chorus, Chorus, Verse 2, Bridge, Outro, etc.)

SUNO PROMPT RULES (these are STRICT — Suno has specific quirks):
- "style": max 25 words, comma-separated. Format: "[genre], [sub-genre], [BPM] BPM, [vocal description], [2-3 key instruments], [mood], [production adjective]". Example: "Indie Pop Rock, 128 BPM, bright clear female vocals, acoustic guitar, driving drums, synth pads, hopeful, energetic, modern polished production"
- "exclude": list genres and elements that would pull Suno in the WRONG direction. Be specific. Example: "Heavy Metal, Rap, lo-fi, overly melancholic, acoustic folk ballad, orchestral"
- "lyricsTemplate": section-level tags ONLY describing what happens musically + vocally in each section. Format: "[Section Name - vocal direction, instrument changes, energy level]". Write 2-3 placeholder lyric lines per section with VARIED line lengths (long-short-long alternation). NEVER uniform "square" lines — they make Suno vocals sound flat/robotic. Include breathing space, repetition points, and natural flow.
- "moreOptions": styleInfluence 45-70 (higher = more faithful to style string), weirdness 15-25 (adds organic variation), vocalGender MUST match what you actually heard — "male"/"female"/"duet"/"none"

All human-readable analysis text must be in ${L}.

${JSON_RULE}
JSON shape:
{
 "heard": { "genre":"", "bpm":"", "key":"", "vocal":"(MUST describe gender + character precisely)", "instruments":["(be specific for each)"], "mood":"", "structure":"(list all sections)", "production":"(describe mix style)", "energy":"(describe the full energy arc)" },
 "prompt": {
   "title": "(creative title capturing the song's essence)",
   "style": "(max 25 words, comma-separated, include vocal gender description)",
   "exclude": "(specific genres/elements to avoid)",
   "lyricsTemplate": "(section tags with vocal+instrument direction, varied-length placeholder lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "(MUST match heard vocal)" }
 },
 "tips": ["(specific Suno tips for this song)", "(what to listen for when comparing Suno output vs original)"]
}`;
}

function tunePrompt(lang, currentPrompt, feedback) {
  const L = lang === 'en' ? 'English' : 'Vietnamese';
  return `You are MUSIC DNA — a Grammy-level producer and the world's #1 Suno prompt refinement specialist. You have tuned 10,000+ Suno prompts to 99% match.

The attached audio is the ORIGINAL reference song. The user tried to recreate it on Suno with this prompt:

--- CURRENT PROMPT ---
${currentPrompt}
--- END ---

User feedback on what's still wrong: "${feedback || 'no specific feedback, just get closer to the original'}"

LISTEN to the original with extreme precision and diagnose EXACTLY what the current prompt fails to capture. Common Suno failure points to check:
- Wrong vocal gender or character (this alone ruins everything)
- BPM off by even 5-10 makes the feel completely different
- "style" string too vague — Suno needs specific descriptors, not generic genres
- Missing key instruments (e.g. forgot the synth pad, or the fingerpicked guitar)
- "exclude" too weak — Suno drifted into unwanted territory
- Lyrics template has uniform "square" lines → makes vocals sound flat/robotic (fix: vary line lengths, add breathing space)
- styleInfluence too high (>70 = rigid) or too low (<45 = Suno ignores style)
- Missing production descriptors (reverb type, compression style, mix width)

Produce a refined prompt achieving 99% match. "style" max 25 words. Section-level lyric tags only with varied line lengths. styleInfluence 45-70, weirdness 15-25. vocalGender MUST match the actual singer.

All human-readable text in ${L}.

${JSON_RULE}
JSON shape:
{
 "diagnosis": ["(specific problem 1)", "(specific problem 2)", "..."],
 "changes": [ { "what":"(what was changed)", "why":"(why this brings it closer to original)" } ],
 "prompt": {
   "title": "",
   "style": "(max 25 words, precise descriptors)",
   "exclude": "(expanded to prevent drift)",
   "lyricsTemplate": "(improved section tags + varied-length placeholder lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "(MUST match original)" }
 },
 "tips": ["(what to listen for when comparing new render vs original)"]
}`;
}

function remixPrompt(lang, dna, target) {
  const L = lang === 'en' ? 'English' : 'Vietnamese';
  return `You are MUSIC DNA — a Grammy-level producer specializing in genre transformation and the world's #1 Suno style remix specialist.

Here is the complete DNA of an original song (from a previous analysis):

--- ORIGINAL DNA ---
${dna}
--- END ---

TRANSFORM this into a completely new version with these target choices:
- Target style: ${target.style || 'keep original genre'}
- Target vocal: ${target.voice || 'keep original vocal type'}
- Target mood: ${target.mood || 'keep original mood'}
- Lyrics (user-provided, adapt to new style; if empty, write new lyrics TEMPLATE on the same theme with varied line lengths): ${target.lyrics ? '\n' + target.lyrics : '(empty — write new template)'}

TRANSFORMATION RULES:
- KEEP the recognizable DNA: the core melody feel, the emotional theme, the hook concept, the song's "soul"
- CHANGE everything about the sonic presentation: instruments, production style, BPM (if genre requires), vocal approach, energy curve
- The result must sound like a completely different song that somehow reminds you of the original — like hearing a rock ballad reimagined as city pop, or a K-pop hit turned into lo-fi chill
- "style" max 25 words with specific descriptors for the NEW genre
- Lyrics template: section-level tags with vocal+instrument direction for the NEW style. Lines must have VARIED lengths (long-short alternation), include repetition points, breathing space. NEVER uniform "square" lines.
- styleInfluence 45-70, weirdness 15-25, vocalGender must match the target vocal choice

All human-readable text in ${L}.

${JSON_RULE}
JSON shape:
{
 "kept": ["(DNA element kept from original)", "..."],
 "changed": ["(what was transformed and how)", "..."],
 "prompt": {
   "title": "(new creative title reflecting the transformation)",
   "style": "(max 25 words for the NEW style)",
   "exclude": "(genres/elements to avoid in the new version)",
   "lyricsTemplate": "(section tags for new style + varied-length placeholder lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "" }
 },
 "tips": ["(how to get the best Suno render for this specific transformation)"]
}`;
}

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  // Try parsing; if truncated JSON, attempt to fix by closing brackets
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Attempt recovery: close any open strings and brackets
    let fixed = clean;
    // Close unterminated string
    const dq = (fixed.match(/"/g) || []).length;
    if (dq % 2 !== 0) fixed += '"';
    // Close open arrays/objects
    const opens = (fixed.match(/[\[{]/g) || []).length;
    const closes = (fixed.match(/[\]}]/g) || []).length;
    for (let i = 0; i < opens - closes; i++) {
      const lastOpen = Math.max(fixed.lastIndexOf('['), fixed.lastIndexOf('{'));
      fixed += fixed[lastOpen] === '[' ? ']' : '}';
    }
    return JSON.parse(fixed);
  }
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
