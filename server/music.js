// Finding music to play. Songs come from YouTube (search needs a free YOUTUBE_API_KEY in .env and the video is
// played by YouTube's own embedded player in the browser). Radio comes from the free Radio Browser directory.
// Nothing is downloaded or stored here; we only look things up and hand the browser an id or a stream URL.

const YT_BASE = () => process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const RADIO_HOSTS = () =>
  process.env.RADIO_API_BASE ? [process.env.RADIO_API_BASE] : ['https://de1.api.radio-browser.info', 'https://at1.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];

export const songsAvailable = () => Boolean(process.env.YOUTUBE_API_KEY);

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'family-companion/1.0' } });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      e.body = await r.text().catch(() => '');
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Songs: up to `n` embeddable music videos for a query. */
export async function searchSongs(query, n = 6) {
  if (!songsAvailable()) throw Object.assign(new Error('no key'), { code: 'nokey' });
  const qs = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    videoCategoryId: '10', // Music
    safeSearch: 'moderate',
    maxResults: String(Math.min(10, n + 2)),
    q: String(query).slice(0, 120),
    key: process.env.YOUTUBE_API_KEY,
  });
  let data;
  try {
    data = await getJson(`${YT_BASE()}/search?${qs}`);
  } catch (e) {
    if (e.status === 403 && /quota/i.test(e.body || '')) throw Object.assign(new Error('quota'), { code: 'quota' });
    if (e.status === 400 || e.status === 403) throw Object.assign(new Error('key rejected'), { code: 'badkey' });
    throw e;
  }
  const seen = new Set();
  const out = [];
  for (const it of data.items || []) {
    const id = it.id?.videoId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'song', id, title: decode(it.snippet?.title), by: decode(it.snippet?.channelTitle).replace(/ - Topic$/, '') });
    if (out.length >= n) break;
  }
  return out;
}

/** Radio: stations that match a genre or country tag first, then a station name. */
export async function searchRadio(query, n = 6) {
  const q = String(query || '').trim().slice(0, 60);
  const common = { limit: '30', hidebroken: 'true', order: 'clickcount', reverse: 'true' };
  const attempts = q
    ? [{ tag: q.toLowerCase(), ...common }, { name: q, ...common }, { tag: q.toLowerCase().split(/\s+/)[0], ...common }]
    : [{ tag: 'pop', ...common }];
  for (const host of RADIO_HOSTS()) {
    try {
      for (const a of attempts) {
        const list = await getJson(`${host}/json/stations/search?${new URLSearchParams(a)}`);
        const good = (list || [])
          .filter((s) => /^https:/.test(s.url_resolved || '') && /mp3|aac/i.test(s.codec || '') && (s.lastcheckok ?? 1))
          .slice(0, n)
          .map((s) => ({ kind: 'radio', id: s.stationuuid, title: decode(s.name).trim(), by: [s.country, (s.tags || '').split(',')[0]].filter(Boolean).join(' · '), url: s.url_resolved }));
        if (good.length) return good;
      }
      return [];
    } catch (e) {
      console.warn('[radio] %s failed: %s', host, e.message);
    }
  }
  throw new Error('radio directory unreachable');
}
