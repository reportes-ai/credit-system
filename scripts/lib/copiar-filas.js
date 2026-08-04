'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   COPIA DE FILAS ENTRE BASES — motor único de los scripts de staging (Máxima 1).

   Lo usan `crear-bd-staging.js` (estructura + configuración) y
   `cargar-meses-staging.js` (meses de cartera para cuadrar cifras). Una sola
   implementación, porque las reglas de enmascarado y los cuatro gotchas que
   costaron encontrar valen para ambos:

     1. COLUMNAS GENERADAS (rut_cuerpo, rut_dv) las calcula la base: no admiten
        valor en el INSERT.
     2. COLUMNAS JSON: mysql2 las entrega ya parseadas como objeto; hay que
        volver a serializarlas o el INSERT recibe "[object Object]".
     3. `clave` en este código significa LLAVE, no contraseña — las tablas de
        configuración son (clave, valor). Solo se enmascara lo que de verdad
        guarda una contraseña.
     4. El correo enmascarado debe ser INALCANZABLE, no IRRECONOCIBLE: el login
        del sistema es por correo, así que se conserva la parte local y se cambia
        el dominio a `.invalid` (TLD reservado por la RFC 2606, que ningún DNS
        resuelve). Las partes locales repetidas llevan sufijo.

   Y una regla de operación: **nunca `INSERT IGNORE`**. Descartaba filas en
   silencio ante un choque de clave foránea y el script informaba éxito con la
   tabla vacía. Se inserta de verdad y se verifica el conteo.
   ───────────────────────────────────────────────────────────────────────────── */

const esCorreo   = c => /(mail|correo)/i.test(c);
const esTelefono = c => /(telefono|fono|celular|movil|whatsapp|wsp)/i.test(c);

const correoStaging = (v, vistos) => {
  const local = String(v).split('@')[0].trim().toLowerCase() || 'usuario';
  let cand = local, n = 1;
  while (vistos.has(cand)) cand = `${local}-${++n}`;
  vistos.add(cand);
  return cand + '@staging.invalid';
};

const esc = v => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

/**
 * Copia filas de `origen.tabla` a `destino.tabla`, enmascarando contacto.
 *
 * @param {object} cx        conexión con FOREIGN_KEY_CHECKS ya en 0
 * @param {object} o
 * @param {string} o.origen  base de origen
 * @param {string} o.destino base de destino
 * @param {string} o.tabla
 * @param {string} [o.where] filtro SQL (sin la palabra WHERE); vacío = todo
 * @param {any[]} [o.params] parámetros del filtro
 * @param {string} [o.hashStaging] hash que reemplaza toda contraseña
 * @returns {Promise<{tabla:string, filas:number, mascaras:string[]}>}
 */
async function copiarTabla(cx, { origen, destino, tabla, where = '', params = [], hashStaging = null }) {
  const [meta] = await cx.query(
    `SELECT column_name c, data_type t, extra e FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?`, [origen, tabla]);
  if (!meta.length) throw new Error(`la tabla ${tabla} no existe en ${origen}`);

  const generadas = new Set(meta.filter(m => /GENERATED/i.test(m.e || '')).map(m => m.c));
  const texto     = new Set(meta.filter(m => /char|text/i.test(m.t)).map(m => m.c));
  const json      = new Set(meta.filter(m => /json/i.test(m.t)).map(m => m.c));

  const [filas] = await cx.query(
    `SELECT * FROM \`${origen}\`.\`${tabla}\`${where ? ' WHERE ' + where : ''}`, params);
  if (!filas.length) return { tabla, filas: 0, mascaras: [] };

  const cols = Object.keys(filas[0]).filter(c => !generadas.has(c));
  const mask = {};
  cols.forEach(c => {
    if (!texto.has(c)) return;
    if (hashStaging && (/password/i.test(c) || /(^|_)hash$/i.test(c))) mask[c] = 'clave';
    else if (esCorreo(c))   mask[c] = 'correo';
    else if (esTelefono(c)) mask[c] = 'fono';
  });

  const vistosCorreo = new Set();
  const nombres = cols.map(c => '`' + c + '`').join(',');

  const valores = r => '(' + cols.map(c => {
    const v = r[c];
    if (mask[c] === 'clave')   return esc(hashStaging);
    if (v == null || v === '') return esc(v);
    if (mask[c] === 'correo')  return esc(correoStaging(v, vistosCorreo));
    if (mask[c] === 'fono')    return `'+56900000000'`;
    if (json.has(c))           return esc(typeof v === 'string' ? v : JSON.stringify(v));
    return esc(v);
  }).join(',') + ')';

  /* Los lotes se arman por TAMAÑO, no por cantidad de filas. Con lotes fijos de
     200, una tabla de documentos en base64 (fundantes_seg_docs) generaba una
     sentencia gigante: el servidor cerraba la conexión y se caía todo lo que
     venía después. Una fila sola puede pesar varios MB, así que además va sola
     si hace falta. */
  const TOPE = 2 * 1024 * 1024;   // 2 MB por sentencia, muy bajo el límite del servidor
  let lote = [], peso = 0;
  const vaciar = async () => {
    if (!lote.length) return;
    await cx.query(`INSERT INTO \`${destino}\`.\`${tabla}\` (${nombres}) VALUES ${lote.join(',')}`);
    lote = []; peso = 0;
  };
  for (const r of filas) {
    const v = valores(r);
    if (lote.length && peso + v.length > TOPE) await vaciar();
    lote.push(v); peso += v.length + 1;
    if (lote.length >= 200) await vaciar();
  }
  await vaciar();

  return { tabla, filas: filas.length, mascaras: Object.keys(mask) };
}

module.exports = { copiarTabla, esc, correoStaging, esCorreo, esTelefono };
