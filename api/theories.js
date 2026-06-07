// Vercel serverless function — THEORY SYNTHESIS AGENT.
// Collects a film's real context (TMDB), calls a free LLM (Groq / OpenAI-compatible),
// validates + safety-filters the output (Brief §6: no self-harm method/means, narrative-level only),
// returns grounded speculative fan theories. Cached per movie so each film generates once.
//   /api/theories?id=603  -> { title, theories:[{title, body, tag}] }
const TMDB = 'https://api.themoviedb.org/3';
const TKEY = process.env.TMDB_API_KEY;
function findGroqKey() {
  try { var ev = process.env; for (var k in ev) { if (!ev[k]) continue; var m = String(ev[k]).match(/gsk_[A-Za-z0-9]{20,}/); if (m) return m[0]; } } catch (e) {}
  return '';
}
const GKEY = findGroqKey();
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const TAGS = ['Plausible', 'Cult Favorite', 'Long Shot', 'Wildcard'];
var _hits = {};
function rateLimited(ip) { var now = Date.now(), w = 60000, max = 25; _hits[ip] = (_hits[ip] || []).filter(function (t) { return now - t < w; }); if (_hits[ip].length >= max) return true; _hits[ip].push(now); return false; }

// §6 safety net: reject any theory that names a suicide/self-harm method, means or lethality detail.
const BANNED = /\b(overdose|oxycodone|fentanyl|paracetamol|lethal dose|hang(ed|ing|s)?|noose|slit|wrists?|razor|bleach|carbon monoxide|jump(ed|ing)? (off|from)|gunshot to|shotgun in|pills? to (die|end|kill)|how to (kill|end|harm)|method of (suicide|self.?harm)|ways? to die)\b/i;
// r/FanTheories quality net: reject generic film-studies tropes not anchored to a specific scene/object.
const GENERIC = /\b(hidden agenda|true intent(ion)?s?|inner turmoil|hidden past|sinister intent(ion)?s?|ulterior motive|is a metaphor for|reflects (his|her|their|the character'?s|cobb'?s|[a-z]+'s) (inner|emotional|psyche|guilt|grief|trauma)|represents ([a-z]+'?s |his |her |their |the )?(unresolved )?(guilt|fear|trauma|desire|grief|insecurit\w*)|is a symbol of|symboli[sz]es)\b/i;

async function tmdb(path) {
  const u = new URL(TMDB + path);
  u.searchParams.set('api_key', TKEY);
  u.searchParams.set('language', 'en-US');
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}

function parseJSON(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // default: NEVER cache a failure (transient Groq errors must not poison the CDN); the success path below sets the 30d cache
  if (!TKEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'TMDB_API_KEY not configured', theories: [] })); }
  if (!GKEY) { return res.end(JSON.stringify({ error: 'unavailable', theories: [] })); } // graceful: empty wall (key missing server-side)
  try {
    const id = (req.query.id || '').toString();
    if (!/^\d{1,9}$/.test(id)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_id', theories: [] })); }
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (rateLimited(ip)) { res.statusCode = 429; res.setHeader('Cache-Control', 'no-store'); return res.end(JSON.stringify({ error: 'rate_limited', theories: [] })); }
    const out = await Promise.all([tmdb('/movie/' + id), tmdb('/movie/' + id + '/credits'), tmdb('/movie/' + id + '/keywords').catch(function () { return { keywords: [] }; })]);
    const d = out[0], credits = out[1], kw = out[2] || {};
    if (d.adult) { return res.end(JSON.stringify({ error: 'unavailable', theories: [] })); }
    const cast = (credits.cast || []).slice(0, 6).map(function (c) { return c.name + ' as ' + (c.character || '?'); }).join(', ');
    const ctx = 'Title: ' + d.title + ' (' + (d.release_date || '').slice(0, 4) + ')\n' +
      'Genres: ' + (d.genres || []).map(function (g) { return g.name; }).join(', ') + '\n' +
      'Tagline: ' + (d.tagline || '') + '\n' +
      'Premise: ' + (d.overview || '') + '\n' +
      'Keywords/themes: ' + ((kw.keywords || []).map(function (k) { return k.name; }).slice(0, 14).join(', ') || 'n/a') + '\n' +
      'Top cast: ' + cast;

    const sys = 'You write SPECIFIC, scene-anchored FAN THEORIES about a film, at the quality bar of top r/FanTheories posts (not generic blog filler). Return ONLY valid JSON: {"theories":[{"title":"","body":"","tag":""}]}. Produce EXACTLY 8 distinct, sharp theories (never fewer).\n' +
      'NON-NEGOTIABLE QUALITY RULES:\n' +
      '1. Each theory MUST anchor to a SPECIFIC named character, object, scene, motif or relationship from THIS film. Use the premise, keywords/themes and cast you are given, and reference a concrete on-screen detail by name. Generic theories that could apply to any film are forbidden. ONLY use character and actor names that appear in the provided cast list - NEVER invent a character name or assign an actor a role not listed; if unsure of a name, refer to the role generically.\n' +
      '2. BANNED unless tied to concrete named evidence from this film: bare "unreliable narrator", "it was all a dream", "X has a hidden agenda", "secret shared universe", "X is secretly the villain". Naming the trope is not a theory; you must ground it.\n' +
      '3. All theories must be DISTINCT angles (a character motive, a hidden connection, a timeline/structure read, a symbol/object, foreshadowing, an alternate interpretation, a sequel hook). Do not restate one idea 8 ways.\n' +
      '4. title: punchy and specific, max 70 chars. body: 2-3 sentences, speculative ("what if", "the theory goes"), grounded in the given details, never stating invented facts as truth.\n' +
      '5. tag is exactly one of: Plausible, Cult Favorite, Long Shot, Wildcard.\n' +
      '6. FINAL SELF-CHECK before you answer: delete any theory whose body does not name a SPECIFIC element from the Premise, Keywords/themes or cast above (a character by name, an object, a place, a scene-beat). Titles like "X\'s Hidden Agenda", "Y\'s Sinister Intentions", "Z\'s True Role", "The [Place] as a Symbol" are AUTO-REJECT unless the body cites concrete named evidence. Returning 6 sharp, grounded theories beats 8 padded with generic filler.\n' +
      'SAFETY (absolute): stay at the narrative/emotional level. NEVER describe the method, means, or lethality of suicide or self-harm, and no graphic violence detail. Handle heavy themes thematically and with care.';
    const user = 'Film context:\n' + ctx + '\n\nWrite the fan theories now as JSON only.';

    function callGroq(model) {
      return fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GKEY, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          model: model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.9, top_p: 0.95, max_tokens: 1800, response_format: { type: 'json_object' }
        }), 'utf-8')
      });
    }
    // quality-first model chain: best model first, then resilient fallbacks on rate-limit/error
    var CHAIN = [MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'].filter(function (m, i, a) { return a.indexOf(m) === i; });
    var r = null;
    for (var ci = 0; ci < CHAIN.length; ci++) { r = await callGroq(CHAIN[ci]); if (r && r.ok) break; }
    if (!r || !r.ok) { return res.end(JSON.stringify({ error: 'unavailable', theories: [] })); }
    const j = await r.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    const parsed = parseJSON(content) || {};
    const seen = {};
    var base = (parsed.theories || [])
      .filter(function (t) { return t && t.title && t.body; })
      .filter(function (t) { return !BANNED.test((t.title || '') + ' ' + (t.body || '')); }) // §6 hard filter
      .filter(function (t) { const k = String(t.title).toLowerCase().slice(0, 40); if (seen[k]) return false; seen[k] = 1; return true; });
    var grounded = base.filter(function (t) { return !GENERIC.test((t.title || '') + ' ' + (t.body || '')); });
    const theories = (grounded.length >= 5 ? grounded : base) // drop generic-trope filler, but never empty the wall
      .slice(0, 8)
      .map(function (t) {
        return {
          title: String(t.title).slice(0, 90),
          body: String(t.body).slice(0, 460),
          tag: TAGS.indexOf(t.tag) > -1 ? t.tag : 'Plausible'
        };
      });
    if (theories.length) res.setHeader('Cache-Control', 's-maxage=2592000, stale-while-revalidate=86400'); // cache ONLY a real, non-empty success — generate once, CDN-cache 30d
    return res.end(JSON.stringify({ title: d.title, theories: theories }));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: String((e && e.message) || e), theories: [] }));
  }
};
