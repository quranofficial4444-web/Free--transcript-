// TubeKit backend: InnerTube proxy (transcript, tags, thumbnails)
const express = require('express');
const app = express();
app.set('trust proxy', 1);

// ---------- InnerTube clients (tried in order until one works) ----------
const CLIENTS = [
  { n: 'ANDROID', v: '20.10.38', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', x: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' } },
  { n: 'WEB', v: '2.20250925.01.00', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', x: {} },
  { n: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', v: '2.0', ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15', x: {}, embed: true },
];

class AppError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const parseId = (u = '') => {
  u = String(u).trim();
  if (/^[\w-]{11}$/.test(u)) return u;
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    const h = x.hostname.replace(/^(www|m|music)\./, '');
    let id;
    if (h === 'youtu.be') id = x.pathname.split('/')[1];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com')
      id = x.searchParams.get('v') || (x.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/) || [])[2];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
};

async function player(id, c) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua, Origin: 'https://www.youtube.com' },
    body: JSON.stringify({
      videoId: id, contentCheckOk: true, racyCheckOk: true,
      context: { client: { clientName: c.n, clientVersion: c.v, hl: 'en', gl: 'US', ...c.x }, ...(c.embed && { thirdParty: { embedUrl: 'https://www.google.com' } }) },
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function captionFetch(track, tlang, c) {
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  if (tlang) u.searchParams.set('tlang', tlang);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': c.ua } });
  if (!r.ok) throw new Error('caption HTTP ' + r.status);
  const txt = await r.text();
  if (!txt) throw new Error('empty caption');
  return (JSON.parse(txt).events || [])
    .filter((e) => e.segs)
    .map((e) => ({ s: e.tStartMs || 0, d: e.dDurationMs || 0, t: e.segs.map((g) => g.utf8).join('').replace(/\s*\n\s*/g, ' ').trim() }))
    .filter((e) => e.t);
}

async function getVideo(id, wantCaps, lang, tlang) {
  let info = null, status = '', reason = '';
  for (const c of CLIENTS) {
    try {
      const p = await player(id, c);
      const st = p.playabilityStatus || {};
      if (!status || st.status === 'OK') { status = st.status; reason = st.reason || ''; }
      if (!p.videoDetails) continue;
      info = info || p;
      if (!wantCaps) break;
      const tracks = p.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) continue;
      const pick = tracks.find((t) => t.languageCode === lang) || tracks.find((t) => t.kind !== 'asr') || tracks[0];
      const segs = await captionFetch(pick, tlang, c).catch(() => null);
      if (segs && segs.length) return { p, tracks, pick, segs };
    } catch { /* try next client */ }
  }
  if (!info) {
    if (/age|sign in|confirm/i.test(reason)) throw new AppError('This video is age-restricted or requires sign-in, so its transcript cannot be fetched.', 403);
    if (/private/i.test(reason)) throw new AppError('This video is private.', 403);
    throw new AppError('Video not found or unavailable. Check the link and try again.', 404);
  }
  if (!wantCaps) return { p: info };
  if (status === 'LOGIN_REQUIRED') throw new AppError('This video is age-restricted or private.', 403);
  throw new AppError('This video has no captions available.', 404);
}

// ---------- cache + rate limit ----------
const cache = new Map(), hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of cache) if (v.exp < n) cache.delete(k); hits.clear(); }, 60000).unref();

app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
  if (n > 40) return res.status(429).json({ message: 'Too many requests. Please wait a minute and try again.' });
  next();
});

app.get('/api/video', async (req, res) => {
  try {
    const id = parseId(req.query.url);
    if (!id) throw new AppError('That does not look like a valid YouTube link.');
    const caps = req.query.captions !== '0', lang = String(req.query.lang || ''), tlang = String(req.query.tlang || '');
    if (!/^[\w-]{0,12}$/.test(lang + tlang)) throw new AppError('Invalid language.');
    const key = [id, caps, lang, tlang].join('|');
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return res.json(hit.data);
    const { p, tracks, pick, segs } = await getVideo(id, caps, lang, tlang);
    const v = p.videoDetails;
    const data = {
      id, title: v.title, author: v.author, seconds: +v.lengthSeconds || 0, views: +v.viewCount || 0, tags: v.keywords || [],
      tracks: (tracks || []).map((t) => ({ code: t.languageCode, name: t.name?.simpleText || t.languageCode, auto: t.kind === 'asr' })),
      lang: pick?.languageCode || '', segs: segs || [],
    };
    if (cache.size > 500) cache.clear();
    cache.set(key, { exp: Date.now() + 30 * 60000, data });
    res.json(data);
  } catch (e) {
    if (e instanceof AppError) return res.status(e.status).json({ message: e.message });
    console.error(e);
    res.status(502).json({ message: 'YouTube did not respond. Please try again in a moment.' });
  }
});

// Thumbnail proxy (enables reliable one-click downloads)
app.get('/api/thumb', async (req, res) => {
  const { id, q, dl } = req.query;
  if (!/^[\w-]{11}$/.test(id || '') || !['maxresdefault', 'hq720', 'sddefault', 'hqdefault', 'mqdefault'].includes(q)) return res.status(400).end();
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=86400' });
    if (dl) res.set('Content-Disposition', `attachment; filename="${id}-${q}.jpg"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

app.use(express.static(__dirname + '/public'));
module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('TubeKit running on http://localhost:' + (process.env.PORT || 3000)));
  
