// Vercel serverless: serve index.html with per-movie OG/Twitter meta injected for ?movie=<id>.
// Shared movie links otherwise always preview Obsession (the static shell). Social scrapers don't run JS,
// so we swap the meta server-side; real users still get the full JS page which renders the movie normally.
const BASE = 'https://film-theory-vault.vercel.app';
const TKEY = process.env.TMDB_API_KEY;
const crypto = require('crypto');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
// Build a correct per-movie Movie schema (replaces the Obsession JSON-LD on ?movie pages instead of just stripping it).
function ldjson(d, cr, url) {
  var dir = (((cr.crew || []).filter(function (c) { return c.job === 'Director'; })[0]) || {}).name;
  var obj = {
    '@context': 'https://schema.org', '@type': 'Movie', name: d.title, url: url,
    image: d.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + d.backdrop_path : (d.poster_path ? 'https://image.tmdb.org/t/p/w780' + d.poster_path : undefined),
    datePublished: d.release_date || undefined,
    description: (d.overview || '').slice(0, 300) || undefined,
    genre: (d.genres || []).map(function (g) { return g.name; }),
    duration: d.runtime ? 'PT' + d.runtime + 'M' : undefined
  };
  if (dir) obj.director = { '@type': 'Person', name: dir };
  var actors = (cr.cast || []).slice(0, 5).map(function (c) { return { '@type': 'Person', name: c.name }; });
  if (actors.length) obj.actor = actors;
  return '<script type="application/ld+json">' + JSON.stringify(obj).replace(/</g, '\\u003c') + '</script>';
}

module.exports = async function (req, res) {
  let html = '';
  try { html = await fetch(BASE + '/app.html').then(function (r) { return r.text(); }); } catch (e) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // per-request CSP nonce: response must not be shared-cached
  if (!html) { res.statusCode = 200; return res.end('<!doctype html><meta http-equiv="refresh" content="0;url=/app.html"><title>Film Theory Vault</title><a href="/app.html">Open the Film Theory Vault</a>'); }
  // strip the spoiler payload out of the served HTML — the ending recap + fate are fetched from /api/ending on opt-in click, so view-source / curl / scrapers never see them
  html = html.replace(/(<template id="recapTpl">)[\s\S]*?(<\/template>)/, '$1$2').replace(/(<template id="fateTpl">)[\s\S]*?(<\/template>)/, '$1$2');
  const id = (req.query.movie || '').toString();
  if (/^\d{1,9}$/.test(id) && TKEY) {
    try {
      const api = 'https://api.themoviedb.org/3/movie/' + id;
      const out = await Promise.all([
        fetch(api + '?api_key=' + TKEY + '&language=en-US').then(function (r) { return r.json(); }),
        fetch(api + '/credits?api_key=' + TKEY + '&language=en-US').then(function (r) { return r.json(); }).catch(function () { return {}; })
      ]);
      const d = out[0], cr = out[1] || {};
      if (d && d.id && !d.adult) {
        const title = d.title + (d.release_date ? ' (' + d.release_date.slice(0, 4) + ')' : '');
        const desc = (d.overview || 'Real data, trailers, cast and AI fan theories you can vote on.').replace(/\s+/g, ' ').slice(0, 185);
        const img = d.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + d.backdrop_path : (d.poster_path ? 'https://image.tmdb.org/t/p/w780' + d.poster_path : '');
        const T = esc(title) + ' — Theory Vault', D = esc(desc), I = esc(img), U = BASE + '/?movie=' + id;
        html = html
          .replace(/<title>[^<]*<\/title>/, '<title>' + esc(title) + ' · Theory Vault</title>')
          .replace(/<meta property="og:title"[^>]*>/, '<meta property="og:title" content="' + T + '" />')
          .replace(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="' + D + '" />')
          .replace(/<meta property="og:url"[^>]*>/, '<meta property="og:url" content="' + U + '" />')
          .replace(/<meta property="og:image"[^>]*>/, '<meta property="og:image" content="' + I + '" />')
          .replace(/<meta name="twitter:title"[^>]*>/, '<meta name="twitter:title" content="' + T + '" />')
          .replace(/<meta name="twitter:description"[^>]*>/, '<meta name="twitter:description" content="' + D + '" />')
          .replace(/<meta name="twitter:image"[^>]*>/, '<meta name="twitter:image" content="' + I + '" />')
          .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="' + D + '" />')
          .replace(/<meta property="og:image:alt"[^>]*>/, '<meta property="og:image:alt" content="' + esc(title) + ' — Theory Vault" />')
          .replace(/<link rel="canonical"[^>]*>/, '<link rel="canonical" href="' + U + '" />')
          .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ldjson(d, cr, U));
        // SSR fallback body: no-JS visitors and non-rendering crawlers see the REAL movie, not the Obsession shell.
        const genres = (d.genres || []).map(function (g) { return g.name; }).slice(0, 3).join(' · ');
        const meta = [genres, d.runtime ? d.runtime + ' min' : '', d.vote_average ? (Math.round(d.vote_average * 10) / 10) + '/10 TMDB' : ''].filter(Boolean).join(' · ');
        const castLis = (cr.cast || []).slice(0, 12).map(function (c) { return '<li>' + esc(c.name) + (c.character ? ' <span>as ' + esc(c.character) + '</span>' : '') + '</li>'; }).join('');
        const ssr = '<noscript>'
          + '<style>.hero,main.wrap{display:none!important}.ssr-movie{display:block;max-width:920px;margin:0 auto;padding:48px 22px;color:#e8e2d9;font-family:Inter,system-ui,sans-serif}.ssr-movie img{width:100%;border-radius:14px;margin-bottom:24px}.ssr-movie h1{font-family:Oswald,sans-serif;font-size:2.6rem;line-height:1.05;margin:0 0 8px}.ssr-movie .tl{color:#b9b0a4;margin:0 0 18px;letter-spacing:.05em;text-transform:uppercase;font-size:.8rem}.ssr-movie p{line-height:1.7;color:#cfc7bb}.ssr-movie h2{font-family:Oswald,sans-serif;margin:30px 0 10px}.ssr-movie ul{columns:2;gap:24px;padding:0;list-style:none}.ssr-movie li{margin-bottom:6px;color:#cfc7bb}.ssr-movie li span{color:#9a9186}.ssr-movie .note{margin-top:30px;padding:16px 18px;border:1px solid #3a342e;border-radius:10px;color:#b9b0a4}.ssr-movie a{color:#d9a25c}</style>'
          + '<section class="ssr-movie">'
          + (img ? '<img src="' + I + '" alt="' + esc(d.title) + ' backdrop" />' : '')
          + '<h1>' + esc(title) + '</h1>'
          + (meta ? '<p class="tl">' + esc(meta) + '</p>' : '')
          + (d.tagline ? '<p><em>' + esc(d.tagline) + '</em></p>' : '')
          + '<p>' + esc(d.overview || '') + '</p>'
          + (castLis ? '<h2>Cast</h2><ul>' + castLis + '</ul>' : '')
          + '<p class="note">Enable JavaScript for the full Theory Vault — official trailers, AI fan theories you can vote on, the gallery, and where to watch. <a href="/">← Back to the Vault home</a></p>'
          + '</section></noscript>';
        html = html.replace('<body>', '<body>' + ssr);
      }
    } catch (e) {}
  }
  var nonce = crypto.randomBytes(16).toString('base64');
  html = html.replace(/<script\b/g, '<script nonce="' + nonce + '"');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://image.tmdb.org https://i.ytimg.com https://img.youtube.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'nonce-" + nonce + "'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; upgrade-insecure-requests");
  res.statusCode = 200;
  res.end(html);
};
