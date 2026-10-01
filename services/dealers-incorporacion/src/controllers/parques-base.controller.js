'use strict';
/**
 * Base de Parques Automotrices — la ficha del parque como contraparte comercial.
 *
 * QUÉ ES: los parques ya existen como parámetro de cálculo (parques_comisiones:
 * nombre + arriendo + comisión, mantenedor "Arriendos y Comisiones Parque y
 * Calle"). Pero a los parques, igual que a los dealers, se les emiten cartolas
 * y ellos nos facturan — y para eso falta su ficha: RUT, razón social,
 * representante legal, dirección, contactos y la cuenta donde depositar.
 *
 * UNA SOLA FUENTE (Máxima 2): esta ficha NO re-almacena el nombre ni la
 * comisión/arriendo. Se cuelga de parques_comisiones por id_parque (UNIQUE):
 * el nombre y los parámetros de cálculo siguen viviendo en su mantenedor;
 * aquí vive únicamente la identidad comercial del parque. Las futuras
 * cartolas de parque leerán ambas cosas de su fuente respectiva.
 */
const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');
const NOM = require('../../../../api-gateway/public/js/nombres-core');   // empresas en MAYÚSCULAS, personas en Nombre Propio
const { auditar } = require('../../../../shared/audit');
const almacen = require('../../../../shared/almacen-docs');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

/* ── Migración: tabla + card en el módulo Creación/Mantenedor de Dealer ───── */
require('../../../../shared/migrate').enFila('parques-base', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parques_ficha (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_parque     INT          NOT NULL,
        rut           VARCHAR(20)  NULL,
        razon_social  VARCHAR(200) NULL,
        direccion     VARCHAR(300) NULL,
        comuna        VARCHAR(120) NULL,
        rl_nombre     VARCHAR(150) NULL,
        rl_telefono   VARCHAR(40)  NULL,
        rl_email      VARCHAR(150) NULL,
        cc_nombre     VARCHAR(150) NULL,
        cc_telefono   VARCHAR(40)  NULL,
        cc_email      VARCHAR(150) NULL,
        cf_nombre     VARCHAR(150) NULL,
        cf_telefono   VARCHAR(40)  NULL,
        cf_email      VARCHAR(150) NULL,
        tipo_documento VARCHAR(10) NULL,
        banco         VARCHAR(80)  NULL,
        cuenta_tipo   VARCHAR(30)  NULL,
        rut_cuenta    VARCHAR(20)  NULL,
        nombre_cuenta VARCHAR(150) NULL,
        num_cuenta    VARCHAR(40)  NULL,
        correo_confirmacion VARCHAR(150) NULL,
        observaciones TEXT         NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_parque (id_parque)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[parques_ficha migration]', e.message); }

  // Documentos de respaldo del parque: ficha firmada, poderes/escritura y cédulas
  // de los firmantes. Los archivos van al bucket vía shared/almacen-docs (la
  // columna `data` existe SOLO como fallback cuando no hay GCS_BUCKET — local y
  // staging; en producción queda NULL y el contenido vive en gs://autofacil-docs).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parques_ficha_archivos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_parque   INT          NOT NULL,
        categoria   VARCHAR(20)  NOT NULL,
        nombre      VARCHAR(200) NULL,
        mime        VARCHAR(100) NULL,
        data        LONGBLOB     NULL,
        doc_storage VARCHAR(10)  NOT NULL DEFAULT 'db',
        doc_ruta    VARCHAR(500) NULL,
        doc_bytes   BIGINT       NULL,
        subido_por  VARCHAR(200) NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_parque (id_parque)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[parques_ficha_archivos migration]', e.message); }

  // Card en el landing del módulo 370001 + permiso (Admin y quienes mantienen dealers).
  try {
    const codigo = 'parque_ficha';
    const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (370001, 'Creación de Parque', ?, '/dealers-incorporacion/parques.html', 'bi-p-square')`, [codigo]);
      idf = r.insertId;
    }
    for (const idp of [1, 6, 90008]) {   // Admin · Analista de Operaciones · Gte. Operaciones y Crédito
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
  } catch (e) { console.error('[parques_ficha funcionalidad]', e.message); }
});

const norm = s => { const v = String(s ?? '').trim(); return v || null; };

/* Los campos editables de la ficha, en el orden del INSERT/UPDATE. */
const CAMPOS = ['rut','razon_social','direccion','comuna','rl_nombre','rl_telefono','rl_email',
  'cc_nombre','cc_telefono','cc_email','cf_nombre','cf_telefono','cf_email',
  'tipo_documento','banco','cuenta_tipo','rut_cuenta','nombre_cuenta','num_cuenta',
  'correo_confirmacion','observaciones'];

function limpiarFicha(body) {
  const f = {};
  for (const c of CAMPOS) f[c] = norm(body[c]);
  // RUTs al formato canónico; si el DV no cuadra se rechaza (mejor que guardarlo torcido).
  for (const c of ['rut', 'rut_cuenta']) {
    if (!f[c]) continue;
    const n = RUT.normalizar(f[c]);
    if (!n) return { error: `El ${c === 'rut' ? 'RUT del parque' : 'RUT de la cuenta'} no es válido` };
    f[c] = n;
  }
  /* Formato único de los nombres (nombres-core), igual que dealers y la ficha de
     incorporación: la razón social es EMPRESA y los contactos son PERSONAS. El titular
     de la cuenta sigue el RUT de la cuenta, porque acá `cuenta_tipo` guarda el tipo de
     cuenta (Corriente/Vista), no la marca EMPRESA/PERSONA. */
  if (f.razon_social != null) f.razon_social = NOM.empresa(f.razon_social);
  for (const c of ['rl_nombre', 'cc_nombre', 'cf_nombre']) if (f[c] != null) f[c] = NOM.persona(f[c]);
  if (f.nombre_cuenta != null) f.nombre_cuenta = NOM.titular(f.nombre_cuenta, NOM.cuentaTipoDeRut(f.rut_cuenta));
  return { f };
}

/* RUT REPETIDO ENTRE PARQUES — requiere la aprobación de un gerente con comentario (Pato, 01-10-2026).
   Un mismo dueño puede tener dos parques (PLANETCAR y PLANET MAS, AUTOMOTORA FRQ SPA): cada uno
   lleva su cartola, su orden de pago y su factura, porque el circuito separa por parque y mes,
   no por RUT. Pero el mismo parque cargado dos veces con otro nombre se ve igual, y el sistema
   solo comparaba el NOMBRE: por eso un segundo parque con el mismo RUT lo decide Gerencia, viendo
   cuál parque ya lo usa. Motor único del cruce: lo usan guardar() de acá y la cadena de niveles
   de la ficha de incorporación (fichas.controller → parquesMismoRut: nivel PARQUE_RUT_REPETIDO y cierre).
   @returns {Promise<Array<{id:number,nombre:string,activo:number}>>} otros parques con ese RUT */
async function parquesConRut(rut, exceptoIdParque) {
  const n = RUT.normalizar(rut);
  if (!n) return [];
  const [rows] = await pool.query(
    `SELECT p.id, p.nombre, p.activo
       FROM parques_ficha f JOIN parques_comisiones p ON p.id = f.id_parque
      WHERE REPLACE(UPPER(f.rut),'.','') = ? AND p.id <> ?
      ORDER BY p.nombre`, [String(n).replace(/\./g, '').toUpperCase(), Number(exceptoIdParque) || 0]);
  return rows;
}
/* Respuesta 409 que la pantalla convierte en una confirmación (mismo patrón que confirmar:'cuota'). */
function avisoRutRepetido(rut, otros) {
  const lista = otros.map(o => o.nombre + (o.activo ? '' : ' (inactivo)')).join(', ');
  return { confirmar: 'rut_parque', rut: RUT.normalizar(rut) || rut, parques: otros,
    mensaje: `El RUT ${RUT.normalizar(rut) || rut} ya está en la ficha de ${lista}. ` +
      `Si es OTRO parque del mismo dueño, confirma para continuar: tendrá su propia cartola, orden de pago y factura. ` +
      `Si es el MISMO parque, no sigas: edita la ficha que ya existe.` };
}
exports.parquesConRut = parquesConRut;
exports.avisoRutRepetido = avisoRutRepetido;

/* GET /parques-base — la base completa: parámetro de cálculo + ficha (si existe). */
exports.listar = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.nombre, p.arriendo, p.comision_pct, p.activo, p.orden,
              f.id AS id_ficha, f.rut, f.razon_social, f.direccion, f.comuna,
              f.rl_nombre, f.rl_telefono, f.rl_email,
              f.cc_nombre, f.cc_telefono, f.cc_email,
              f.cf_nombre, f.cf_telefono, f.cf_email,
              f.tipo_documento, f.banco, f.cuenta_tipo, f.rut_cuenta, f.nombre_cuenta, f.num_cuenta,
              f.correo_confirmacion, f.observaciones, f.updated_at AS ficha_actualizada
         FROM parques_comisiones p
         LEFT JOIN parques_ficha f ON f.id_parque = p.id
        ORDER BY p.orden, p.nombre`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[parques-base listar]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /parques-base/:idParque — guarda/actualiza la ficha de un parque existente. */
exports.guardar = async (req, res) => {
  try {
    const idParque = Number(req.params.idParque);
    const [[p]] = await pool.query('SELECT id, nombre FROM parques_comisiones WHERE id=?', [idParque]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });
    const { f, error } = limpiarFicha(req.body || {});
    if (error) return res.status(400).json({ success: false, data: null, error });

    /* RUT que ya usa otro parque — requiere la aprobación de un gerente y un comentario válido de él
       (Pato, 01-10-2026). Por esta pantalla no hay cadena de niveles, así que el cambio lo guarda el
       propio gerente (permiso parque_rut_repetido de la matriz, o Administrador) con su comentario; a
       cualquier otro se le explica y no se guarda. Se exige solo cuando el RUT de ESTA ficha cambia (o es
       nueva), para no pedirlo en cada edición de dos parques que ya comparten dueño. */
    let rutCompartido = [], comentarioRut = null;
    if (f.rut) {
      const [[act]] = await pool.query('SELECT rut FROM parques_ficha WHERE id_parque=?', [idParque]);
      if (RUT.normalizar(act && act.rut) !== f.rut) {
        rutCompartido = await parquesConRut(f.rut, idParque);
        if (rutCompartido.length) {
          const aviso = avisoRutRepetido(f.rut, rutCompartido);
          const esGerencia = (req.usuario || {}).perfil_nombre === 'Administrador' || await tieneFunc(req.usuario.id_usuario, 'parque_rut_repetido');
          if (!esGerencia)
            return res.status(403).json({ success: false, data: { parques: rutCompartido },
              error: `El RUT ${aviso.rut} ya está en la ficha de ${rutCompartido.map(o => o.nombre).join(', ')}. Un segundo parque con el mismo RUT requiere la aprobación de un gerente: pídele que guarde él este RUT con su comentario. Si es el mismo parque, edita la ficha que ya existe.` });
          comentarioRut = String((req.body && req.body.comentario_rut) || '').trim().slice(0, 500);
          if (!(comentarioRut.length >= 10 && /\s/.test(comentarioRut)))
            return res.status(409).json({ success: false, data: { ...aviso, confirmar: 'comentario_rut_parque' },
              error: `El RUT ${aviso.rut} ya está en la ficha de ${rutCompartido.map(o => o.nombre).join(', ')}. Para aprobar un segundo parque con el mismo RUT escribe tu comentario (mínimo 10 caracteres): por qué es OTRO parque y no el mismo repetido.` });
        }
      }
    }

    await pool.query(
      `INSERT INTO parques_ficha (id_parque, ${CAMPOS.join(',')}) VALUES (?${',?'.repeat(CAMPOS.length)})
       ON DUPLICATE KEY UPDATE ${CAMPOS.map(c => `${c}=VALUES(${c})`).join(',')}`,
      [idParque, ...CAMPOS.map(c => f[c])]);

    auditar({ req, accion: 'EDITAR', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: idParque,
      detalle: `Editó la ficha del parque "${p.nombre}"` + (rutCompartido.length ? ` — aprobó (Gerencia) que comparte el RUT ${f.rut} con ${rutCompartido.map(o => o.nombre).join(', ')}; comentario: «${comentarioRut}»` : ''), meta: req.body });
    res.json({ success: true, data: null, error: null });
  } catch (e) { console.error('[parques-base guardar]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Documentos de respaldo ───────────────────────────────────────────────── */
const CATEGORIAS = ['FIRMADA', 'PODERES', 'CEDULA'];   // ficha firmada · poderes y escritura · cédulas de los firmantes
const MAX_POR_CAT = 5;
const MAX_MB = 15;

/* GET /parques-base/:idParque/archivos — lista (sin el contenido). */
exports.archivosListar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, categoria, nombre, mime, doc_bytes, subido_por, created_at
         FROM parques_ficha_archivos WHERE id_parque=? ORDER BY categoria, id`, [Number(req.params.idParque)]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[parques-base archivos]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /parques-base/:idParque/archivos — sube un documento (base64). */
exports.archivoSubir = async (req, res) => {
  try {
    const idParque = Number(req.params.idParque);
    const { categoria, archivo_nombre, mime_type, archivo_data } = req.body || {};
    const cat = String(categoria || '').toUpperCase();
    if (!CATEGORIAS.includes(cat)) return res.status(400).json({ success: false, data: null, error: 'Categoría inválida' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[p]] = await pool.query('SELECT id, nombre FROM parques_comisiones WHERE id=?', [idParque]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Parque no encontrado' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM parques_ficha_archivos WHERE id_parque=? AND categoria=?', [idParque, cat]);
    if (n >= MAX_POR_CAT) return res.status(400).json({ success: false, data: null, error: `Máximo ${MAX_POR_CAT} archivos por categoría` });
    const buffer = Buffer.from(String(archivo_data), 'base64');
    if (!buffer.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });
    if (buffer.length > MAX_MB * 1024 * 1024) return res.status(400).json({ success: false, data: null, error: `El archivo supera los ${MAX_MB} MB` });

    const d = await almacen.colocar({ ambito: 'parques-archivos', clave: idParque, buffer, mime: mime_type, nombre: archivo_nombre || 'archivo' });
    const quien = `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim() || null;
    const [r] = await pool.query(
      `INSERT INTO parques_ficha_archivos (id_parque, categoria, nombre, mime, data, doc_storage, doc_ruta, doc_bytes, subido_por)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [idParque, cat, archivo_nombre || 'archivo', mime_type || 'application/octet-stream', d.blob, d.storage, d.ruta, d.bytes, quien]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: idParque,
      detalle: `Subió documento (${cat}) al parque "${p.nombre}": ${archivo_nombre || ''}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[parques-base archivo subir]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /parques-base/:idParque/archivos/:archivoId — sirve el documento. */
exports.archivoVer = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      'SELECT nombre, mime, data, doc_ruta FROM parques_ficha_archivos WHERE id=? AND id_parque=?',
      [Number(req.params.archivoId), Number(req.params.idParque)]);
    if (!a || (!a.data && !a.doc_ruta)) return res.status(404).json({ success: false, data: null, error: 'Sin archivo' });
    auditar({ req, accion: 'VER_DOCUMENTO', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: req.params.idParque,
      detalle: `Visualizó documento del parque #${req.params.idParque}: ${a.nombre || ''}` });
    return almacen.servir(res, { ruta: a.doc_ruta, blob: a.data, nombre: a.nombre || 'archivo', mime: a.mime });
  } catch (e) { console.error('[parques-base archivo ver]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* DELETE /parques-base/:idParque/archivos/:archivoId
   Capturar doc_ruta ANTES del DELETE y borrar el objeto DESPUÉS (regla del almacén). */
exports.archivoEliminar = async (req, res) => {
  try {
    const idParque = Number(req.params.idParque), idArch = Number(req.params.archivoId);
    const [[arch]] = await pool.query('SELECT doc_ruta, nombre, categoria FROM parques_ficha_archivos WHERE id=? AND id_parque=?', [idArch, idParque]);
    if (!arch) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    await pool.query('DELETE FROM parques_ficha_archivos WHERE id=? AND id_parque=?', [idArch, idParque]);
    if (arch.doc_ruta) await almacen.borrar(arch.doc_ruta);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealers-incorporacion', entidad: 'parque_ficha', entidad_id: idParque,
      detalle: `Eliminó documento (${arch.categoria}) del parque #${idParque}: ${arch.nombre || ''}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[parques-base archivo eliminar]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
