const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────────
   Mantenedor "Estado Créditos" — máquina de estados PARAMÉTRICA del crédito.
   Define los estados y sus transiciones permitidas por ámbito (brokerage hoy;
   AutoFácil/recursos propios a futuro). El Flujo Brokerage se dibuja desde acá.
   Fase actual: configuración + dibujo del flujo. NO bloquea transiciones todavía.
   ───────────────────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('estado-creditos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estados_credito (
        ambito     VARCHAR(20)  NOT NULL DEFAULT 'brokerage',
        codigo     VARCHAR(40)  NOT NULL,
        nombre     VARCHAR(80)  NOT NULL,
        color      VARCHAR(9)   NOT NULL DEFAULT '#64748b',
        orden      INT          NOT NULL DEFAULT 0,
        es_inicial TINYINT(1)   NOT NULL DEFAULT 0,
        es_final   TINYINT(1)   NOT NULL DEFAULT 0,
        activo     TINYINT(1)   NOT NULL DEFAULT 1,
        updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (ambito, codigo)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estados_transicion (
        id      INT AUTO_INCREMENT PRIMARY KEY,
        ambito  VARCHAR(20) NOT NULL DEFAULT 'brokerage',
        origen  VARCHAR(40) NOT NULL,
        destino VARCHAR(40) NOT NULL,
        UNIQUE KEY uq_trans (ambito, origen, destino)
      )`);

    // ── Seed brokerage (solo si la tabla está vacía para ese ámbito) ──
    const [[cnt]] = await pool.query("SELECT COUNT(*) n FROM estados_credito WHERE ambito='brokerage'");
    if (!cnt.n) {
      await pool.query(
        `INSERT IGNORE INTO estados_credito (ambito, codigo, nombre, color, orden, es_inicial, es_final) VALUES
          ('brokerage','DIGITADO','Digitado','#6366f1',10,1,0),
          ('brokerage','CARTA_APROBACION','Carta de Aprobación','#0ea5e9',20,1,0),
          ('brokerage','APROBADO','Aprobado','#16a34a',30,0,0),
          ('brokerage','RECHAZADO','Rechazado','#dc2626',40,0,0),
          ('brokerage','APELADO','Apelado','#d97706',50,0,1),
          ('brokerage','OTORGADO','Otorgado','#0f766e',60,0,0),
          ('brokerage','DESISTIDO','Desistido','#b91c1c',70,0,1),
          ('brokerage','PREPAGADO','Prepagado','#7c3aed',80,0,1),
          ('brokerage','ANULADO','Anulado','#64748b',90,0,1)`);
      await pool.query(
        `INSERT IGNORE INTO estados_transicion (ambito, origen, destino) VALUES
          ('brokerage','DIGITADO','APROBADO'),
          ('brokerage','DIGITADO','RECHAZADO'),
          ('brokerage','APROBADO','CARTA_APROBACION'),
          ('brokerage','APROBADO','OTORGADO'),
          ('brokerage','APROBADO','DESISTIDO'),
          ('brokerage','RECHAZADO','APELADO'),
          ('brokerage','RECHAZADO','OTORGADO'),
          ('brokerage','RECHAZADO','RECHAZADO'),
          ('brokerage','CARTA_APROBACION','OTORGADO'),
          ('brokerage','CARTA_APROBACION','DESISTIDO'),
          ('brokerage','OTORGADO','PREPAGADO'),
          ('brokerage','OTORGADO','ANULADO')`);
    }

    // ── Seed AutoFácil / recursos propios: ETAPAS de originación (solo si vacío) ──
    // La etapa propia termina en OTORGADO (es_final): ahí se congela y la segunda
    // dimensión (Estado de Cartera, mantenedor estados_cartera) toma el control.
    // Etapas reales de originación AutoFácil (recursos propios). Se siembra/repara
    // una vez (cuando falta INGRESO). Flujo: Ingresado → Carga Respaldos → En Análisis
    // → Emisión Documentos → Carga Docs AF → Validación Firma → OTORGADO (final: ahí
    // toma el control el Estado de Cartera).
    const [rIng] = await pool.query("SELECT 1 FROM estados_credito WHERE ambito='autofacil' AND codigo='INGRESO' LIMIT 1");
    if (!rIng.length) {
      await pool.query("DELETE FROM estados_transicion WHERE ambito='autofacil'");
      await pool.query("DELETE FROM estados_credito WHERE ambito='autofacil'");
      await pool.query(
        `INSERT IGNORE INTO estados_credito (ambito, codigo, nombre, color, orden, es_inicial, es_final) VALUES
          ('autofacil','INGRESO','Ingresado','#6366f1',10,1,0),
          ('autofacil','CARGA_RESPALDOS','Carga Respaldos','#8b5cf6',20,0,0),
          ('autofacil','EN_ANALISIS','En Análisis','#0ea5e9',30,0,0),
          ('autofacil','EMISION_DOCUMENTOS','Emisión Documentos','#f59e0b',40,0,0),
          ('autofacil','CARGA_DOCUMENTOS_AF','Carga Docs. AF','#d97706',50,0,0),
          ('autofacil','VALIDACION_FIRMA','Validación Firma','#0ea5e9',60,0,0),
          ('autofacil','OTORGADO','Otorgado','#0f766e',70,0,1),
          ('autofacil','RECHAZADO','Rechazado','#dc2626',80,0,1),
          ('autofacil','DESISTIDO','Desistido','#b91c1c',90,0,1)`);
      await pool.query(
        `INSERT IGNORE INTO estados_transicion (ambito, origen, destino) VALUES
          ('autofacil','INGRESO','CARGA_RESPALDOS'),
          ('autofacil','INGRESO','RECHAZADO'),
          ('autofacil','CARGA_RESPALDOS','EN_ANALISIS'),
          ('autofacil','EN_ANALISIS','EMISION_DOCUMENTOS'),
          ('autofacil','EN_ANALISIS','RECHAZADO'),
          ('autofacil','EMISION_DOCUMENTOS','CARGA_DOCUMENTOS_AF'),
          ('autofacil','CARGA_DOCUMENTOS_AF','VALIDACION_FIRMA'),
          ('autofacil','VALIDACION_FIRMA','OTORGADO'),
          ('autofacil','VALIDACION_FIRMA','DESISTIDO')`);
    }

    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_estado_creditos' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Etapas y Estados', 'mantenedores_estado_creditos', '/mantenedores/estado-creditos/', 'bi-diagram-3-fill')`);
    // La página ahora unifica Etapas (brokerage/autofácil) + Estado de Cartera.
    await pool.query("UPDATE funcionalidades SET nombre='Etapas y Estados' WHERE codigo='mantenedores_estado_creditos'").catch(() => {});
  } catch (e) { console.error('[estado-creditos migration]', e.message); }
});

const RE_COD = /^[A-Z0-9_]+$/;
const limpiarCodigo = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
const ambitoDe = req => limpiarCodigo(req.query.ambito || req.body?.ambito || 'BROKERAGE').toLowerCase();
const usuarioDe = req => (req.usuario?.nombre ? (req.usuario.nombre + ' ' + (req.usuario.apellido || '')).trim() : req.usuario?.email) || 'Usuario';

/* GET /api/estado-creditos?ambito=brokerage → estados (con destinos) del ámbito */
const getAll = async (req, res) => {
  try {
    const ambito = ambitoDe(req);
    const [estados] = await pool.query(
      'SELECT codigo, nombre, color, orden, es_inicial, es_final, activo FROM estados_credito WHERE ambito = ? ORDER BY orden, codigo',
      [ambito]);
    const [trans] = await pool.query(
      'SELECT origen, destino FROM estados_transicion WHERE ambito = ?', [ambito]);
    const mapa = {};
    trans.forEach(t => { (mapa[t.origen] = mapa[t.origen] || []).push(t.destino); });
    const data = estados.map(e => ({
      ...e,
      es_inicial: !!e.es_inicial, es_final: !!e.es_final, activo: !!e.activo,
      destinos: mapa[e.codigo] || []
    }));
    res.json({ success: true, data: { ambito, estados: data }, error: null });
  } catch (e) { console.error('[estado-creditos getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/estado-creditos → crear estado */
const crear = async (req, res) => {
  try {
    const ambito = ambitoDe(req);
    const codigo = limpiarCodigo(req.body.codigo);
    const nombre = String(req.body.nombre || '').trim();
    if (!codigo || !RE_COD.test(codigo)) return res.status(400).json({ success: false, data: null, error: 'Código inválido (use MAYÚSCULAS, números y _)' });
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre es obligatorio' });
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';
    const orden = Number.isFinite(+req.body.orden) ? parseInt(req.body.orden, 10) : 0;
    const es_inicial = req.body.es_inicial ? 1 : 0;
    const es_final = req.body.es_final ? 1 : 0;
    const [[ya]] = await pool.query('SELECT 1 ok FROM estados_credito WHERE ambito = ? AND codigo = ?', [ambito, codigo]);
    if (ya) return res.status(409).json({ success: false, data: null, error: 'Ya existe un estado con ese código' });
    await pool.query(
      'INSERT INTO estados_credito (ambito, codigo, nombre, color, orden, es_inicial, es_final) VALUES (?,?,?,?,?,?,?)',
      [ambito, codigo, nombre, color, orden, es_inicial, es_final]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'estado_credito', entidad_id: `${ambito}:${codigo}`, detalle: `Creó estado ${codigo} (${nombre})`, meta: { ambito, codigo, nombre } });
    res.json({ success: true, data: { ambito, codigo }, error: null });
  } catch (e) { console.error('[estado-creditos crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/estado-creditos/:codigo → editar propiedades del estado */
const actualizar = async (req, res) => {
  try {
    const ambito = ambitoDe(req);
    const codigo = limpiarCodigo(req.params.codigo);
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre es obligatorio' });
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';
    const orden = Number.isFinite(+req.body.orden) ? parseInt(req.body.orden, 10) : 0;
    const es_inicial = req.body.es_inicial ? 1 : 0;
    const es_final = req.body.es_final ? 1 : 0;
    const activo = req.body.activo === undefined ? 1 : (req.body.activo ? 1 : 0);
    const [r] = await pool.query(
      'UPDATE estados_credito SET nombre=?, color=?, orden=?, es_inicial=?, es_final=?, activo=? WHERE ambito=? AND codigo=?',
      [nombre, color, orden, es_inicial, es_final, activo, ambito, codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Estado no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'estado_credito', entidad_id: `${ambito}:${codigo}`, detalle: `Editó estado ${codigo}`, meta: { ambito, codigo, nombre } });
    res.json({ success: true, data: { ambito, codigo }, error: null });
  } catch (e) { console.error('[estado-creditos actualizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* DELETE /api/estado-creditos/:codigo → eliminar estado y sus transiciones */
const eliminar = async (req, res) => {
  try {
    const ambito = ambitoDe(req);
    const codigo = limpiarCodigo(req.params.codigo);
    const [r] = await pool.query('DELETE FROM estados_credito WHERE ambito=? AND codigo=?', [ambito, codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Estado no encontrado' });
    await pool.query('DELETE FROM estados_transicion WHERE ambito=? AND (origen=? OR destino=?)', [ambito, codigo, codigo]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'estado_credito', entidad_id: `${ambito}:${codigo}`, detalle: `Eliminó estado ${codigo}`, meta: { ambito, codigo } });
    res.json({ success: true, data: { ambito, codigo }, error: null });
  } catch (e) { console.error('[estado-creditos eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/estado-creditos/:codigo/transiciones → reemplaza los destinos permitidos */
const setTransiciones = async (req, res) => {
  try {
    const ambito = ambitoDe(req);
    const origen = limpiarCodigo(req.params.codigo);
    const [[existe]] = await pool.query('SELECT 1 ok FROM estados_credito WHERE ambito=? AND codigo=?', [ambito, origen]);
    if (!existe) return res.status(404).json({ success: false, data: null, error: 'Estado de origen no encontrado' });
    let destinos = Array.isArray(req.body.destinos) ? req.body.destinos.map(limpiarCodigo).filter(Boolean) : [];
    destinos = [...new Set(destinos)];
    if (destinos.length) {
      const [validos] = await pool.query('SELECT codigo FROM estados_credito WHERE ambito=?', [ambito]);
      const set = new Set(validos.map(v => v.codigo));
      destinos = destinos.filter(d => set.has(d));
    }
    await pool.query('DELETE FROM estados_transicion WHERE ambito=? AND origen=?', [ambito, origen]);
    if (destinos.length) {
      const values = destinos.map(d => [ambito, origen, d]);
      await pool.query('INSERT IGNORE INTO estados_transicion (ambito, origen, destino) VALUES ?', [values]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'estado_transicion', entidad_id: `${ambito}:${origen}`, detalle: `Transiciones de ${origen} → [${destinos.join(', ')}]`, meta: { ambito, origen, destinos } });
    res.json({ success: true, data: { ambito, origen, destinos }, error: null });
  } catch (e) { console.error('[estado-creditos setTransiciones]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, actualizar, eliminar, setTransiciones };
