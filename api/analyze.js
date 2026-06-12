// /api/analyze — DNAbeat.pro
// Verifies Supabase JWT, enforces daily quota, calls Gemini (key stays server-side)
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ynyfvszgxhmldjnlcmcy.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
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

function scanPrompt() {
  return `You are MUSIC DNA — a Grammy-level music producer, mixing engineer, and the world's #1 Suno AI prompt engineer. You have produced 10,000+ tracks across every genre. LISTEN to the attached audio with extreme precision and reverse-engineer a Suno prompt that recreates this song's DNA.

CRITICAL LISTENING CHECKLIST — answer each precisely:
1. VOCAL: Is the singer male or female? Listen to pitch range, timbre, chest/head voice. Soprano/alto = female. Tenor/bass = male. Two voices alternating = duet. Be 100% accurate — getting gender wrong ruins the entire prompt.
2. VOCAL CHARACTER: breathy? husky? clear/bright? nasal? raspy? falsetto? vibrato-heavy? whisper sections? ad-libs? Describe the EXACT vocal texture.
3. BPM: Count precisely — tap along mentally. Don't guess round numbers.
4. KEY: Identify the actual musical key (e.g. "Eb minor", "A major").
5. INSTRUMENTS: List every distinct instrument/sound layer you hear. Be specific — "fingerpicked acoustic guitar" not just "guitar".
6. PRODUCTION STYLE: Describe the mix — lo-fi/dusty? clean/polished? compressed? spacious/reverb-heavy? layered? minimalist?
7. ENERGY CURVE: How does energy flow across the song?
8. STRUCTURE: Map the exact sections (Intro, Verse 1, Pre-Chorus, Chorus, etc.)

SUNO PROMPT RULES (STRICT):
- "style": max 25 words, comma-separated, ALWAYS IN ENGLISH. Format: "[genre], [sub-genre], [BPM] BPM, [vocal description], [2-3 key instruments], [mood], [production adjective]"
- "exclude": ALWAYS IN ENGLISH. List genres/elements that would pull Suno in the wrong direction.
- "lyricsTemplate": ALWAYS IN ENGLISH. Section tags ONLY like [Verse 1 - soft, intimate, acoustic guitar]. Write 2-3 placeholder lyric lines per section with VARIED line lengths (long-short alternation). NEVER uniform "square" lines — they make Suno vocals flat/robotic.
- "moreOptions": styleInfluence 45-70, weirdness 15-25, vocalGender MUST match what you actually heard.
- "title": ALWAYS IN ENGLISH.

ALL analysis text ("heard", "tips") must be in English.

${JSON_RULE}
JSON shape:
{
 "heard": { "genre":"", "bpm":"", "key":"", "vocal":"(gender + character)", "instruments":["(specific)"], "mood":"", "structure":"(all sections)", "production":"(mix style)", "energy":"(full arc)" },
 "prompt": {
   "title": "",
   "style": "(max 25 words, English)",
   "exclude": "(English)",
   "lyricsTemplate": "(English section tags + varied-length placeholder lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "(match heard)" }
 },
 "tips": ["", ""]
}`;
}

function tunePrompt(currentStyle, currentExclude, currentLyrics, feedback) {
  return `You are MUSIC DNA — a Grammy-level producer and the world's #1 Suno prompt refinement specialist.

You will receive TWO audio files:
- AUDIO 1: The ORIGINAL reference song (the target to clone)
- AUDIO 2: The SUNO RENDER (what the current prompt produced)

The user's current Suno prompt:
--- STYLE OF MUSIC ---
${currentStyle || '(not provided)'}
--- EXCLUDE STYLES ---
${currentExclude || '(not provided)'}
--- LYRICS ---
${currentLyrics || '(not provided)'}
--- END ---

User feedback: "${feedback || 'no specific feedback, just get closer to the original'}"

LISTEN TO BOTH AUDIO FILES CAREFULLY AND COMPARE:
1. Audio 1 (original) — note the vocal gender/character, BPM, instruments, energy, production
2. Audio 2 (Suno render) — note exactly what's different
3. Diagnose what the current prompt fails to capture

Common Suno failure points:
- Wrong vocal gender or character (this alone ruins everything)
- BPM off by even 5-10 changes the feel completely
- "style" string too vague — Suno needs specific descriptors
- Missing key instruments
- "exclude" too weak — Suno drifted into unwanted territory
- Lyrics template has uniform "square" lines → flat/robotic vocals (fix: vary line lengths)
- Missing production descriptors (reverb, compression, mix width)

Produce a refined prompt achieving 99% match. ALL PROMPT FIELDS IN ENGLISH. "style" max 25 words. Section-level lyric tags only with varied line lengths. styleInfluence 45-70, weirdness 15-25.

${JSON_RULE}
JSON shape:
{
 "diagnosis": ["(specific problem 1)", "(specific problem 2)"],
 "changes": [ { "what":"(changed)", "why":"(why closer to original)" } ],
 "prompt": {
   "title": "(English)",
   "style": "(max 25 words, English)",
   "exclude": "(English)",
   "lyricsTemplate": "(English section tags + varied-length lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "(match original)" }
 },
 "tips": ["(what to listen for comparing new render vs original)"]
}`;
}

function remixPrompt(dna, target) {
  return `You are MUSIC DNA — a Grammy-level producer specializing in genre transformation and Suno style remixing.

Original song DNA:
--- ORIGINAL DNA ---
${dna}
--- END ---

TRANSFORM into a new version:
- Target style: ${target.style || 'keep original genre'}
- Target vocal: ${target.voice || 'keep original vocal type'}
- Target mood: ${target.mood || 'keep original mood'}
- Lyrics (adapt to new style; if empty, write new template on same theme): ${target.lyrics ? '\n' + target.lyrics : '(empty — write new template)'}

RULES:
- KEEP: core melody feel, emotional theme, hook concept
- CHANGE: instruments, production, BPM (if genre requires), vocal approach, energy curve
- ALL PROMPT FIELDS IN ENGLISH
- "style" max 25 words. Lyrics: section-level tags, VARIED line lengths, NEVER square lines.
- styleInfluence 45-70, weirdness 15-25

${JSON_RULE}
JSON shape:
{
 "kept": ["(DNA kept)"],
 "changed": ["(what transformed)"],
 "prompt": {
   "title": "(English)",
   "style": "(max 25 words, English)",
   "exclude": "(English)",
   "lyricsTemplate": "(English section tags + varied-length lines)",
   "moreOptions": { "styleInfluence": 0, "weirdness": 0, "vocalGender": "" }
 },
 "tips": [""]
}`;
}

function timingPrompt(lyrics) {
  return `You are MUSIC DNA TIMING — a professional lyric synchronization engine, like the systems behind Spotify and Apple Music synced lyrics.

You receive an audio file (a full song) and the song's complete lyrics text. Your job: listen to the audio and determine the EXACT start time of every lyric line.

THE LYRICS (sync these lines, in order):
--- LYRICS ---
${lyrics}
--- END ---

SYNC RULES:
1. Listen to the full audio from start to end. Identify when the vocalist begins singing EACH line of the provided lyrics.
2. Keep the lines EXACTLY as provided — same order, same text. Do not rewrite, translate, merge, or split lines.
3. Skip empty lines and section headers like [Verse], [Chorus] — only time actual sung lines. But if the lyrics contain section headers, you may use them to navigate the structure.
4. Timestamps in "mm:ss.xx" format (minutes:seconds.centiseconds), e.g. "00:14.50". The time is when the FIRST syllable of that line is sung.
5. Times must be strictly increasing.
6. Instrumental intro: the first line's time should reflect when singing actually starts, not 00:00 (unless singing starts immediately).
7. If a line repeats (e.g. chorus repeated), time EACH occurrence separately in order.
8. Be as precise as possible — aim for ±0.5 second accuracy. Listen carefully to vocal onsets.
9. Also estimate each line's confidence: "high" if you clearly heard the vocal onset, "low" if the vocals were buried in the mix and you estimated.

${JSON_RULE}
JSON shape:
{
 "duration": "(total audio length mm:ss)",
 "vocalStart": "(when singing first begins, mm:ss.xx)",
 "lines": [
   { "time": "00:14.50", "text": "(lyric line exactly as provided)", "confidence": "high" }
 ],
 "notes": ["(any sync caveats, e.g. heavy autotune made onsets blurry in bridge)"]
}`;
}

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    let fixed = clean;
    const dq = (fixed.match(/"/g) || []).length;
    if (dq % 2 !== 0) fixed += '"';
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
  if (!SERVICE_KEY || !GEMINI_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const sb = admin();
  const user = await getUserFromReq(req, sb);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { data: profile } = await sb.from('profiles').select('plan').eq('id', user.id).maybeSingle();
  const plan = profile?.plan === 'premium' ? 'premium' : 'free';

  const day = todayUTC();
  const { data: row } = await sb.from('usage_daily').select('count').eq('user_id', user.id).eq('day', day).maybeSingle();
  const count = row?.count || 0;
  if (plan === 'free' && count >= FREE_LIMIT) {
    return res.status(429).json({ error: 'limit_reached', plan, count, limit: FREE_LIMIT });
  }

  const { mode, audio, sunoAudio, mimeType = 'audio/wav',
          currentStyle, currentExclude, currentLyrics, feedback,
          dna, target, lyrics } = req.body || {};

  if (!['scan', 'tune', 'remix', 'timing'].includes(mode)) return res.status(400).json({ error: 'bad_mode' });
  if ((mode === 'scan' || mode === 'timing') && !audio) return res.status(400).json({ error: 'audio_required' });
  if (mode === 'tune' && (!audio || !sunoAudio)) return res.status(400).json({ error: 'both_audio_required' });
  if (mode === 'remix' && !dna) return res.status(400).json({ error: 'dna_required' });
  if (mode === 'timing' && !lyrics) return res.status(400).json({ error: 'lyrics_required' });

  let parts;
  if (mode === 'scan') {
    parts = [
      { text: scanPrompt() },
      { inline_data: { mime_type: mimeType, data: audio } }
    ];
  } else if (mode === 'tune') {
    parts = [
      { text: tunePrompt(currentStyle, currentExclude, currentLyrics, feedback) },
      { text: '--- AUDIO 1: ORIGINAL REFERENCE SONG ---' },
      { inline_data: { mime_type: mimeType, data: audio } },
      { text: '--- AUDIO 2: SUNO RENDER TO COMPARE ---' },
      { inline_data: { mime_type: mimeType, data: sunoAudio } }
    ];
  } else if (mode === 'timing') {
    parts = [
      { text: timingPrompt(lyrics) },
      { inline_data: { mime_type: mimeType, data: audio } }
    ];
  } else {
    parts = [{ text: remixPrompt(dna, target || {}) }];
  }

  let result;
  try {
    result = await callGemini(parts);
  } catch (e) {
    return res.status(502).json({ error: 'gemini_failed', detail: String(e.message || e) });
  }

  const newCount = count + 1;
  await sb.from('usage_daily').upsert({ user_id: user.id, day, count: newCount }, { onConflict: 'user_id,day' });

  return res.status(200).json({
    result,
    usage: { plan, count: newCount, limit: plan === 'premium' ? null : FREE_LIMIT }
  });
}
