const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────────
   Mantenedor "Estado Cartera" — ciclo de vida del crédito de RECURSOS PROPIOS
   (AutoFácil) mientras lo administramos. Es la SEGUNDA dimensión, distinta de la
   ETAPA (originación, mantenedor Estado Créditos):
     · ETAPA  = en qué punto del proceso está la operación (DIGITADO…OTORGADO…).
     · ESTADO = situación de pago del crédito vivo en cartera.
   El Estado arranca en VIGENTE cuando la Etapa llega a OTORGADO (solo propios;
   brokerage cierra en su Etapa y NO tiene Estado de cartera).

   Estados automáticos (los gobierna el motor por días de atraso, bidireccional):
     VIGENTE (0 días) · EN MORA (≥1) · VENCIDO (>90).
   Estados terminales: TERMINADO (pagó a plazo) · PREPAGADO (pagó anticipado) ·
     CASTIGADO (write-off, MANUAL — guía >180 días, discrecional).

   Fase actual: configuración + umbrales. El motor calcula y muestra, NO bloquea
   ni mueve automáticamente todavía (enforcement se activa cuando se valide).
   ───────────────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estados_cartera (
        codigo     VARCHAR(40)  NOT NULL,
        nombre     VARCHAR(80)  NOT NULL,
        color      VARCHAR(9)   NOT NULL DEFAULT '#64748b',
        orden      INT          NOT NULL DEFAULT 0,
        es_inicial TINYINT(1)   NOT NULL DEFAULT 0,
        es_final   TINYINT(1)   NOT NULL DEFAULT 0,
        automatico TINYINT(1)   NOT NULL DEFAULT 0,
        activo     TINYINT(1)   NOT NULL DEFAULT 1,
        updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (codigo)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estados_cartera_transicion (
        id      INT AUTO_INCREMENT PRIMARY KEY,
        origen  VARCHAR(40) NOT NULL,
        destino VARCHAR(40) NOT NULL,
        UNIQUE KEY uq_trans_cartera (origen, destino)
      )`);
    // Umbrales paramétricos (días). El Administrador los edita sin tocar código.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cartera_parametros (
        clave VARCHAR(40) PRIMARY KEY,
        valor VARCHAR(40) NOT NULL
      )`);
    await pool.query(
      `INSERT IGNORE INTO cartera_parametros (clave, valor) VALUES
        ('mora_desde','1'), ('vencido_desde','91'), ('castigo_sugerido','181')`);

    // ── Seed estados (solo si la tabla está vacía) ──
    const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM estados_cartera');
    if (!cnt.n) {
      await pool.query(
        `INSERT IGNORE INTO estados_cartera (codigo, nombre, color, orden, es_inicial, es_final, automatico) VALUES
          ('VIGENTE','Vigente','#16a34a',10,1,0,1),
          ('MORA','En Mora','#d97706',20,0,0,1),
          ('VENCIDO','Vencido','#dc2626',30,0,0,1),
          ('PREPAGADO','Prepagado','#7c3aed',40,0,1,0),
          ('TERMINADO','Terminado','#0f766e',50,0,1,0),
          ('CASTIGADO','Castigado','#111827',60,0,1,0)`);
      await pool.query(
        `INSERT IGNORE INTO estados_cartera_transicion (origen, destino) VALUES
          ('VIGENTE','MORA'),
          ('VIGENTE','PREPAGADO'),
          ('VIGENTE','TERMINADO'),
          ('MORA','VIGENTE'),
          ('MORA','VENCIDO'),
          ('MORA','PREPAGADO'),
          ('MORA','TERMINADO'),
          ('MORA','CASTIGADO'),
          ('VENCIDO','MORA'),
          ('VENCIDO','VIGENTE'),
          ('VENCIDO','PREPAGADO'),
          ('VENCIDO','TERMINADO'),
          ('VENCIDO','CASTIGADO')`);
    }

    // Campo en creditos: el Estado de cartera vive en la operación (solo propios).
    await pool.query(`ALTER TABLE creditos ADD COLUMN IF NOT EXISTS estado_cartera VARCHAR(40) NULL`).catch(() => {});

    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_estado_cartera' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Estado Cartera', 'mantenedores_estado_cartera', '/mantenedores/estado-cartera/', 'bi-wallet2')`);
  } catch (e) { console.error('[estado-cartera migration]', e.message); }
})();

const RE_COD = /^[A-Z0-9_]+$/;
const limpiarCodigo = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

/* GET /api/estado-cartera → estados (con destinos) + parámetros */
const getAll = async (req, res) => {
  try {
    const [estados] = await pool.query(
      'SELECT codigo, nombre, color, orden, es_inicial, es_final, automatico, activo FROM estados_cartera ORDER BY orden, codigo');
    const [trans] = await pool.query('SELECT origen, destino FROM estados_cartera_transicion');
    const [params] = await pool.query('SELECT clave, valor FROM cartera_parametros');
    const mapa = {};
    trans.forEach(t => { (mapa[t.origen] = mapa[t.origen] || []).push(t.destino); });
    const data = estados.map(e => ({
      ...e,
      es_inicial: !!e.es_inicial, es_final: !!e.es_final, automatico: !!e.automatico, activo: !!e.activo,
      destinos: mapa[e.codigo] || []
    }));
    const parametros = {};
    params.forEach(p => { parametros[p.clave] = p.valor; });
    res.json({ success: true, data: { estados: data, parametros }, error: null });
  } catch (e) { console.error('[estado-cartera getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/estado-cartera → crear estado */
const crear = async (req, res) => {
  try {
    const codigo = limpiarCodigo(req.body.codigo);
    const nombre = String(req.body.nombre || '').trim();
    if (!codigo || !RE_COD.test(codigo)) return res.status(400).json({ success: false, data: null, error: 'Código inválido (use MAYÚSCULAS, números y _)' });
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre es obligatorio' });
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';
    const orden = Number.isFinite(+req.body.orden) ? parseInt(req.body.orden, 10) : 0;
    const es_inicial = req.body.es_inicial ? 1 : 0;
    const es_final = req.body.es_final ? 1 : 0;
    const automatico = req.body.automatico ? 1 : 0;
    const [[ya]] = await pool.query('SELECT 1 ok FROM estados_cartera WHERE codigo = ?', [codigo]);
    if (ya) return res.status(409).json({ success: false, data: null, error: 'Ya existe un estado con ese código' });
    await pool.query(
      'INSERT INTO estados_cartera (codigo, nombre, color, orden, es_inicial, es_final, automatico) VALUES (?,?,?,?,?,?,?)',
      [codigo, nombre, color, orden, es_inicial, es_final, automatico]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'estado_cartera', entidad_id: codigo, detalle: `Creó estado de cartera ${codigo} (${nombre})`, meta: { codigo, nombre } });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[estado-cartera crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/estado-cartera/:codigo → editar propiedades */
const actualizar = async (req, res) => {
  try {
    const codigo = limpiarCodigo(req.params.codigo);
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre es obligatorio' });
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';
    const orden = Number.isFinite(+req.body.orden) ? parseInt(req.body.orden, 10) : 0;
    const es_inicial = req.body.es_inicial ? 1 : 0;
    const es_final = req.body.es_final ? 1 : 0;
    const automatico = req.body.automatico ? 1 : 0;
    const activo = req.body.activo === undefined ? 1 : (req.body.activo ? 1 : 0);
    const [r] = await pool.query(
      'UPDATE estados_cartera SET nombre=?, color=?, orden=?, es_inicial=?, es_final=?, automatico=?, activo=? WHERE codigo=?',
      [nombre, color, orden, es_inicial, es_final, automatico, activo, codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Estado no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'estado_cartera', entidad_id: codigo, detalle: `Editó estado de cartera ${codigo}`, meta: { codigo, nombre } });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[estado-cartera actualizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* DELETE /api/estado-cartera/:codigo → eliminar estado y sus transiciones */
const eliminar = async (req, res) => {
  try {
    const codigo = limpiarCodigo(req.params.codigo);
    const [r] = await pool.query('DELETE FROM estados_cartera WHERE codigo=?', [codigo]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Estado no encontrado' });
    await pool.query('DELETE FROM estados_cartera_transicion WHERE origen=? OR destino=?', [codigo, codigo]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'estado_cartera', entidad_id: codigo, detalle: `Eliminó estado de cartera ${codigo}`, meta: { codigo } });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[estado-cartera eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/estado-cartera/:codigo/transiciones → reemplaza los destinos permitidos */
const setTransiciones = async (req, res) => {
  try {
    const origen = limpiarCodigo(req.params.codigo);
    const [[existe]] = await pool.query('SELECT 1 ok FROM estados_cartera WHERE codigo=?', [origen]);
    if (!existe) return res.status(404).json({ success: false, data: null, error: 'Estado de origen no encontrado' });
    let destinos = Array.isArray(req.body.destinos) ? req.body.destinos.map(limpiarCodigo).filter(Boolean) : [];
    destinos = [...new Set(destinos)];
    if (destinos.length) {
      const [validos] = await pool.query('SELECT codigo FROM estados_cartera');
      const set = new Set(validos.map(v => v.codigo));
      destinos = destinos.filter(d => set.has(d));
    }
    await pool.query('DELETE FROM estados_cartera_transicion WHERE origen=?', [origen]);
    if (destinos.length) {
      const values = destinos.map(d => [origen, d]);
      await pool.query('INSERT IGNORE INTO estados_cartera_transicion (origen, destino) VALUES ?', [values]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'estado_cartera_transicion', entidad_id: origen, detalle: `Transiciones de ${origen} → [${destinos.join(', ')}]`, meta: { origen, destinos } });
    res.json({ success: true, data: { origen, destinos }, error: null });
  } catch (e) { console.error('[estado-cartera setTransiciones]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/estado-cartera/parametros → umbrales en días (mora/vencido/castigo) */
const setParametros = async (req, res) => {
  try {
    const claves = ['mora_desde', 'vencido_desde', 'castigo_sugerido'];
    const vals = {};
    for (const k of claves) {
      const n = parseInt(req.body[k], 10);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${k}` });
      vals[k] = n;
    }
    if (!(vals.mora_desde <= vals.vencido_desde && vals.vencido_desde <= vals.castigo_sugerido))
      return res.status(400).json({ success: false, data: null, error: 'Debe cumplirse mora ≤ vencido ≤ castigo' });
    for (const k of claves) {
      await pool.query('INSERT INTO cartera_parametros (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(vals[k])]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'cartera_parametros', entidad_id: 'umbrales', detalle: `Umbrales cartera: mora≥${vals.mora_desde}, vencido>${vals.vencido_desde - 1}, castigo>${vals.castigo_sugerido - 1}`, meta: vals });
    res.json({ success: true, data: vals, error: null });
  } catch (e) { console.error('[estado-cartera setParametros]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, actualizar, eliminar, setTransiciones, setParametros };
