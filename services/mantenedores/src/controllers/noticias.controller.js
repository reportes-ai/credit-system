const https = require('https');
const http  = require('http');

/* Feeds RSS (sin autenticación, públicos) */
const FEEDS = [
  { url: 'https://www.biobiochile.cl/feed/', src: 'BioBío' },
  { url: 'https://feeds.latercera.com/latercera/rss',  src: 'La Tercera' },
  { url: 'https://www.emol.com/rss/Noticias.xml',      src: 'Emol' },
];

function fetchUrl(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = rawUrl.startsWith('https') ? https : http;
    const req = mod.get(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (AutoFacil-News/1.0)',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
      },
      timeout: 6000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml, src) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const titleRe = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i;
  const linkRe  = /<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const t = titleRe.exec(block);
    const l = linkRe.exec(block);
    if (t && t[1].trim()) {
      items.push({
        titulo: t[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").trim(),
        link:   l ? l[1].trim() : '#',
        src,
      });
    }
    if (items.length >= 8) break;
  }
  return items;
}

/* Cache en memoria — 15 minutos */
let cache = null;
let cacheTs = 0;
const CACHE_MS = 15 * 60 * 1000;

const getNoticias = async (_req, res) => {
  try {
    if (cache && Date.now() - cacheTs < CACHE_MS) {
      return res.json({ success: true, data: cache, error: null });
    }

    const resultados = await Promise.allSettled(
      FEEDS.map(f => fetchUrl(f.url).then(xml => parseRSS(xml, f.src)))
    );

    let items = [];
    resultados.forEach(r => {
      if (r.status === 'fulfilled') items = items.concat(r.value);
    });

    // Mezclar fuentes: intercalar en lugar de concatenar
    const byFeed = {};
    items.forEach(i => { (byFeed[i.src] = byFeed[i.src] || []).push(i); });
    const mezclado = [];
    const keys = Object.keys(byFeed);
    let idx = 0;
    while (mezclado.length < items.length) {
      const k = keys[idx % keys.length];
      if (byFeed[k].length) mezclado.push(byFeed[k].shift());
      else keys.splice(idx % keys.length, 1);
      if (!keys.length) break;
      idx++;
    }

    if (!mezclado.length) {
      return res.json({ success: false, data: [], error: 'No se pudieron cargar noticias' });
    }

    cache  = mezclado;
    cacheTs = Date.now();
    res.json({ success: true, data: mezclado, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: [], error: e.message });
  }
};

module.exports = { getNoticias };
