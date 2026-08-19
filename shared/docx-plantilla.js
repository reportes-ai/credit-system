'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PLANTILLAS WORD (.docx) CON MARCADORES — motor único.

   Un .docx es un ZIP con XMLs. Este módulo:
   · extraerTexto(buffer)          → texto plano del documento (para el revisor IA)
   · reemplazar(buffer, valores)   → nuevo .docx con los {{MARCADORES}} reemplazados
                                     en document.xml, headers y footers.

   Word suele PARTIR un marcador en varios "runs" ({{MIN<tags>IMO_MONTO}}), por eso
   el reemplazo tolera tags XML intercalados dentro del marcador.

   No hay lib de ZIP en las dependencias y no se agrega una por esto: el formato
   local de ZIP es estable y acá se implementa lo mínimo (STORE/DEFLATE + CRC32).
   ───────────────────────────────────────────────────────────────────────────── */
const zlib = require('zlib');

/* ── CRC32 (tabla estándar) ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/* ── Lector ZIP (vía central directory) ── */
function leerZip(buf) {
  // End of Central Directory: firma 0x06054b50, buscada desde el final
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No es un archivo ZIP/DOCX válido');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entradas = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Central directory corrupto');
    const metodo = buf.readUInt16LE(off + 10);
    const csize  = buf.readUInt32LE(off + 20);
    const nlen   = buf.readUInt16LE(off + 28);
    const elen   = buf.readUInt16LE(off + 30);
    const clen   = buf.readUInt16LE(off + 32);
    const lho    = buf.readUInt32LE(off + 42);
    const nombre = buf.toString('utf8', off + 46, off + 46 + nlen);
    // el local header puede traer extra propio: leer sus largos reales
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dataOff = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(dataOff, dataOff + csize);
    const contenido = metodo === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    entradas.push({ nombre, contenido });
    off += 46 + nlen + elen + clen;
  }
  return entradas;
}

/* ── Escritor ZIP (deflate para todo; suficiente para docx) ── */
function escribirZip(entradas) {
  const locales = [], centrales = [];
  let offset = 0;
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, 'utf8');
    const data = e.contenido;
    const comprimido = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comprimido.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nombre.length, 26); lh.writeUInt16LE(0, 28);
    locales.push(lh, nombre, comprimido);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comprimido.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nombre.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrales.push(ch, nombre);
    offset += 30 + nombre.length + comprimido.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entradas.length, 8); eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locales, cd, eocd]);
}

const escXml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Reemplaza {{MARCADOR}} tolerando tags XML intercalados dentro del marcador
   (Word parte el texto en runs). Los marcadores no reconocidos se dejan tal cual. */
function reemplazarXml(xml, valores) {
  return xml.replace(/\{\{(?:<[^>]*>|[^{}<>])*?\}\}/g, m => {
    const clave = m.replace(/<[^>]*>/g, '').slice(2, -2).trim().toUpperCase();
    if (!(clave in valores)) return m;
    return escXml(valores[clave]);
  });
}

/** Nuevo .docx con los marcadores reemplazados. `valores` = { CLAVE: 'texto' }. */
function reemplazar(buffer, valores) {
  const V = {};
  for (const k of Object.keys(valores || {})) V[k.toUpperCase()] = valores[k];
  const entradas = leerZip(buffer);
  let tocados = 0;
  for (const e of entradas) {
    if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(e.nombre)) {
      const antes = e.contenido.toString('utf8');
      const despues = reemplazarXml(antes, V);
      if (despues !== antes) tocados++;
      e.contenido = Buffer.from(despues, 'utf8');
    }
  }
  return { buffer: escribirZip(entradas), tocados };
}

/** Texto plano del documento (párrafos con salto de línea) — para el revisor IA. */
function extraerTexto(buffer) {
  const doc = leerZip(buffer).find(e => e.nombre === 'word/document.xml');
  if (!doc) return '';
  return doc.contenido.toString('utf8')
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{2,}/g, '\n').trim();
}

/** Marcadores {{...}} presentes en el documento (para avisar cuáles calzan). */
function marcadoresDe(buffer) {
  const doc = leerZip(buffer).find(e => e.nombre === 'word/document.xml');
  if (!doc) return [];
  const xml = doc.contenido.toString('utf8');
  const out = new Set();
  for (const m of xml.matchAll(/\{\{(?:<[^>]*>|[^{}<>])*?\}\}/g))
    out.add(m[0].replace(/<[^>]*>/g, '').slice(2, -2).trim().toUpperCase());
  return [...out];
}

module.exports = { reemplazar, extraerTexto, marcadoresDe };
