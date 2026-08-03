'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   EJECUTIVO (texto) → USUARIO (id) — motor único (Máxima 1).

   `creditos.ejecutivo` guarda TEXTO, no una llave: por convención "PRIMER nombre
   + apellido PATERNO" en mayúsculas ("KAREN FARIAS"). Cuando hay que avisarle
   al dueño de una operación, alguien tiene que traducir ese texto a un usuario.

   Por qué no es un simple igual:
     · La carga masiva y las cartas escriben variantes: "DAMARIS SANHUEZA
       ORELLANA" (dos apellidos), "CARMEN CARDENAS MUÑOZ", "DANIEL ROMO VEGA".
     · Hay placeholders que NO son personas: "AUTOFACIL DIRECTO", "EJECUTIVO
       AUTOFACIL", "VENDEDOR (AFA) …", "VENTA DIRECTA AUTOFACIL".
     · Hay ex-empleados que ya no tienen usuario activo.

   La estrategia: indexar a cada usuario activo por "primer nombre + CADA uno de
   sus apellidos" y aceptar solo coincidencias ÚNICAS. Ante dos candidatos
   devuelve null — es preferible no avisar a nadie que avisarle al equivocado.

   IMPORTANTE para quien la use: `null` es un resultado esperado y frecuente
   (placeholders, ex-empleados). SIEMPRE hay que definir qué pasa en ese caso;
   nunca dejar que el aviso se pierda en silencio.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const TTL = 5 * 60 * 1000;          // el padrón de usuarios cambia poco
let _idx = null, _ts = 0;

const norm = s => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')     // fuera tildes
  .toUpperCase().replace(/[^A-Z ]/g, ' ')               // fuera puntos, paréntesis, números
  .replace(/\s+/g, ' ').trim();

/* Palabras que delatan un placeholder y no una persona. */
const PLACEHOLDER = /^(AUTOFACIL|EJECUTIVO AUTOFACIL|VENTA DIRECTA|VENDEDOR|SIN INFORMACION|S I|NN)\b/;

async function indice() {
  if (_idx && (Date.now() - _ts) < TTL) return _idx;
  const m = new Map();                                  // "NOMBRE APELLIDO" → Set(id_usuario)
  try {
    const [us] = await pool.query(
      "SELECT id_usuario, nombre, apellido FROM usuarios WHERE estado = 'activo'");
    for (const u of us) {
      const n = norm(u.nombre).split(' ')[0];
      if (!n) continue;
      for (const ap of norm(u.apellido).split(' ').filter(Boolean)) {
        const k = n + ' ' + ap;
        if (!m.has(k)) m.set(k, new Set());
        m.get(k).add(u.id_usuario);
      }
    }
    _idx = m; _ts = Date.now();
  } catch (_) { _idx = _idx || m; }
  return _idx;
}

/**
 * Traduce el texto de `creditos.ejecutivo` al id_usuario correspondiente.
 * @returns {Promise<number|null>} id_usuario, o null si es placeholder,
 *          ex-empleado o el nombre calza con más de una persona.
 */
async function idUsuarioDeEjecutivo(texto) {
  const t = norm(texto).replace(/^VENDEDOR AFA /, '').trim();
  if (!t || PLACEHOLDER.test(t)) return null;
  const partes = t.split(' ').filter(Boolean);
  if (partes.length < 2) return null;                   // solo el nombre: ambiguo por definición
  const idx = await indice();
  // primer token (nombre) contra CADA token siguiente (cualquiera de los apellidos)
  for (let i = 1; i < partes.length; i++) {
    const s = idx.get(partes[0] + ' ' + partes[i]);
    if (s && s.size === 1) return [...s][0];            // coincidencia única: es esa persona
    if (s && s.size > 1) return null;                   // homónimos: mejor no adivinar
  }
  return null;
}

/** Limpia la caché (tras crear o dar de baja usuarios). */
function invalidar() { _idx = null; _ts = 0; }

module.exports = { idUsuarioDeEjecutivo, invalidar, _norm: norm };
