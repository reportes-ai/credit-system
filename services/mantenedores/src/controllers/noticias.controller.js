const https = require('https');
const http  = require('http');
const pool  = require('../../../../shared/config/database');

/* Google News RSS — siempre disponible, sin API key */
/* Antigüedad máxima de las noticias (días) — editable en el selector de feeds.
   Se guarda en config_ui (clave noticias_max_dias); default 7. */
const DEFAULT_MAX_DIAS = 7;
async function getDiasMax() {
  try {
    const [[row]] = await pool.query("SELECT valor FROM config_ui WHERE clave='noticias_max_dias'");
    if (row) { const n = parseInt(JSON.parse(row.valor)); if (n > 0 && n <= 60) return n; }
  } catch (_) { /* tabla puede no existir aún */ }
  return DEFAULT_MAX_DIAS;
}

/* when:Nd en la consulta limita a los últimos N días en el origen */
function buildFeeds(dias) {
  const w = '+when:' + dias + 'd';
  return [
    { url: `https://news.google.com/rss/search?q=chile+noticias${w}&hl=es-419&gl=CL&ceid=CL:es-419`, src: 'Google News' },
    { url: `https://news.google.com/rss/search?q=economia+chile${w}&hl=es-419&gl=CL&ceid=CL:es-419`, src: 'Economía' },
    { url: `https://news.google.com/rss/search?q=finanzas+credito+chile${w}&hl=es-419&gl=CL&ceid=CL:es-419`, src: 'Finanzas' },
    { url: `https://news.google.com/rss/search?q=industria+automotriz+venta+autos+chile${w}&hl=es-419&gl=CL&ceid=CL:es-419`, src: 'Automotriz' },
    { url: `https://news.google.com/rss/search?q=banca+tasas+interes+banco+central+chile${w}&hl=es-419&gl=CL&ceid=CL:es-419`, src: 'Banca' },
  ];
}

function fetchUrl(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = rawUrl.startsWith('https') ? https : http;
    const req = mod.get(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (AutoFacil-News/1.0)' },
      timeout: 8000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location)
        return resolve(fetchUrl(res.headers.location, redirects + 1));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml, src, maxAgeMs) {
  const items = [];
  const itemRe  = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const titleRe = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i;
  const linkRe  = /<link>(.*?)<\/link>/i;
  const dateRe  = /<pubDate>(.*?)<\/pubDate>/i;
  const ahora = Date.now();
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const t = titleRe.exec(block);
    const l = linkRe.exec(block);
    // Descartar noticias más antiguas que el máximo de días configurado
    const d = dateRe.exec(block);
    if (d) { const ts = Date.parse(d[1]); if (!isNaN(ts) && (ahora - ts) > maxAgeMs) continue; }
    if (t && t[1].trim()) {
      // Limpiar el " - Fuente" que agrega Google al final del título
      let titulo = t[1]
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'")
        .replace(/ - [^-]{3,40}$/, '') // quita " - NombreFuente" al final
        .trim();
      if (titulo.length > 10) {
        items.push({ titulo, link: l ? l[1].trim() : '#', src });
      }
    }
    if (items.length >= 10) break;
  }
  return items;
}

/* Cache 15 minutos (se invalida si cambian los días configurados) */
let cache = null, cacheTs = 0, cacheDias = null;
const CACHE_MS = 15 * 60 * 1000;

const getNoticias = async (_req, res) => {
  try {
    const dias = await getDiasMax();
    if (cache && cacheDias === dias && Date.now() - cacheTs < CACHE_MS)
      return res.json({ success: true, data: cache, error: null });

    const maxAgeMs = dias * 24 * 60 * 60 * 1000;
    const resultados = await Promise.allSettled(
      buildFeeds(dias).map(f => fetchUrl(f.url).then(xml => parseRSS(xml, f.src, maxAgeMs)))
    );

    let items = [];
    resultados.forEach(r => { if (r.status === 'fulfilled') items = items.concat(r.value); });

    // Mezclar alternando fuentes
    const byFeed = {};
    items.forEach(i => { (byFeed[i.src] = byFeed[i.src] || []).push(i); });
    const mezclado = [], keys = Object.keys(byFeed);
    let idx = 0;
    while (keys.length) {
      const k = keys[idx % keys.length];
      if (byFeed[k]?.length) mezclado.push(byFeed[k].shift());
      if (!byFeed[k]?.length) { keys.splice(idx % keys.length, 1); } else { idx++; }
      if (mezclado.length >= 24) break;
    }

    if (!mezclado.length)
      return res.json({ success: false, data: [], error: 'No se pudieron cargar noticias' });

    cache = mezclado; cacheTs = Date.now(); cacheDias = dias;
    res.json({ success: true, data: mezclado, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: [], error: e.message });
  }
};

module.exports = { getNoticias };
