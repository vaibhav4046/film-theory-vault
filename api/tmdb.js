// Vercel serverless function — TMDB proxy.
// The API key stays server-side (Vercel env var TMDB_API_KEY); visitors never see it.
// Endpoints:
//   /api/tmdb?action=search&q=the+matrix   -> { results: [{id,title,year,poster}] }
//   /api/tmdb?action=movie&id=603          -> normalized movie bundle
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const KEY = process.env.TMDB_API_KEY;
var _hits = {};
function rateLimited(ip) { var now = Date.now(), w = 60000, max = 40; _hits[ip] = (_hits[ip] || []).filter(function (t) { return now - t < w; }); if (_hits[ip].length >= max) return true; _hits[ip].push(now); return false; }

async function tmdb(path, params) {
  const u = new URL(TMDB + path);
  u.searchParams.set('api_key', KEY);
  Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); });
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('TMDB ' + r.status + ' for ' + path);
  return r.json();
}
const img = function (p, size) { return p ? IMG + size + p : null; };

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  if (!KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'TMDB_API_KEY is not configured on the server.' })); }
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (rateLimited(ip)) { res.statusCode = 429; res.setHeader('Cache-Control', 'no-store'); return res.end(JSON.stringify({ error: 'rate_limited' })); }
  try {
    const action = (req.query.action || '').toString();
    if (action === 'search') {
      const q = (req.query.q || '').toString().trim();
      if (!q) return res.end(JSON.stringify({ results: [] }));
      const data = await tmdb('/search/movie', { query: q, include_adult: 'false', language: 'en-US' });
      const results = (data.results || []).slice(0, 8).map(function (m) {
        return { id: m.id, title: m.title, year: (m.release_date || '').slice(0, 4), poster: img(m.poster_path, 'w92') };
      });
      return res.end(JSON.stringify({ results: results }));
    }
    if (action === 'movie') {
      const id = (req.query.id || '').toString();
      if (!/^\d{1,9}$/.test(id)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad id' })); }
      const soft = function (p) { return p.catch(function () { return {}; }); };
      const out = await Promise.all([
        tmdb('/movie/' + id, { language: 'en-US' }),
        tmdb('/movie/' + id + '/images', { include_image_language: 'en,null' }),
        tmdb('/movie/' + id + '/videos', { language: 'en-US' }),
        tmdb('/movie/' + id + '/credits', { language: 'en-US' }),
        soft(tmdb('/movie/' + id + '/recommendations', { language: 'en-US' })),
        soft(tmdb('/movie/' + id + '/watch/providers'))
      ]);
      const d = out[0], images = out[1], videos = out[2], credits = out[3], recs = out[4] || {}, wp = out[5] || {};
      if (d.adult) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
      const logos = (images.logos || []).filter(function (l) { return /\.(png|svg)$/i.test(l.file_path || ''); });
      const logo = logos.find(function (l) { return l.iso_639_1 === 'en'; }) || logos[0];
      const yt = (videos.results || []).filter(function (v) { return v.site === 'YouTube' && v.key; });
      const order = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };
      yt.sort(function (a, b) { return (order[a.type] == null ? 9 : order[a.type]) - (order[b.type] == null ? 9 : order[b.type]) + (b.official - a.official); });
      const movie = {
        id: d.id, title: d.title, year: (d.release_date || '').slice(0, 4),
        tagline: d.tagline || '', overview: d.overview || '', runtime: d.runtime || null,
        genres: (d.genres || []).map(function (g) { return g.name; }),
        rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
        votes: d.vote_count || 0, budget: d.budget || 0, revenue: d.revenue || 0,
        release: d.release_date || '', status: d.status || '',
        poster: img(d.poster_path, 'w780'),
        backdrop: img(d.backdrop_path, 'w1280'),
        logo: logo ? img(logo.file_path, 'w500') : null,
        backdrops: (images.backdrops || []).slice(0, 6).map(function (b) { return img(b.file_path, 'w1280'); }),
        cast: (credits.cast || []).slice(0, 12).map(function (c) {
          return { name: c.name, character: c.character || '', photo: img(c.profile_path, 'h632') };
        }),
        trailers: yt.slice(0, 4).map(function (t) { return { key: t.key, name: t.name, type: t.type }; }),
        similar: (recs.results || []).slice(0, 10).map(function (r) { return { id: r.id, title: r.title, year: (r.release_date || '').slice(0, 4), poster: img(r.poster_path, 'w342'), rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null }; }),
        watch: (function () { var us = (wp.results || {}).US || {}; return { flatrate: (us.flatrate || []).map(function (p) { return p.provider_name; }).slice(0, 5), link: us.link || null }; })()
      };
      return res.end(JSON.stringify(movie));
    }
    if (action === 'now_playing') {
      const data = await tmdb('/movie/now_playing', { language: 'en-US', region: 'US' });
      const results = (data.results || []).filter(function (m) { return m.poster_path; }).slice(0, 14).map(function (m) {
        return { id: m.id, title: m.title, year: (m.release_date || '').slice(0, 4), poster: img(m.poster_path, 'w185') };
      });
      return res.end(JSON.stringify({ results: results }));
    }
    if (action === 'trending') {
      const data = await tmdb('/trending/movie/week', { language: 'en-US' });
      const results = (data.results || []).filter(function (m) { return m.poster_path; }).slice(0, 12).map(function (m) {
        return { id: m.id, title: m.title, year: (m.release_date || '').slice(0, 4), poster: img(m.poster_path, 'w185') };
      });
      return res.end(JSON.stringify({ results: results }));
    }
    res.statusCode = 400; res.end(JSON.stringify({ error: 'unknown action' }));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
