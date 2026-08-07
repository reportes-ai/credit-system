'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   AJUSTES DE COMISIÓN POR OPERACIÓN — modificar la comisión de un Ejecutivo
   Comercial en una operación puntual, con segregación de funciones:
     · SOLICITA un Analista de Operaciones (permiso com_ejec_mod_solicitar)
     · APRUEBA el Gerente de Operaciones o su backup (com_ejec_mod_aprobar),
       y nunca la misma persona que solicitó.
   Cada ajuste exige comentario con la aprobación y sus respaldos (ej: "mail
   del 14/02/2026 de Patricio Escobar a Operaciones").

   Un ajuste APROBADO es LA comisión de esa operación en todas partes:
     · calcularMes (Revisión de Comisiones) lo aplica como línea de ajuste
     · la rentabilidad de la operación (informe y dashboard) usa el monto
       modificado como comisión ejecutivo vía /ajustes-vigentes
   Solo se puede ajustar el mes en curso o el anterior, mientras el mes no
   esté cerrado y la comisión del ejecutivo no esté aprobada.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

require('../../../../shared/migrate').enFila('comisiones-ajustes', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_ajustes_op (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        mes                  CHAR(7)      NOT NULL,          /* YYYY-MM */
        num_op               BIGINT       NOT NULL,
        ejecutivo            VARCHAR(150) NOT NULL,
        comision_normal      DECIMAL(15,2) NOT NULL DEFAULT 0,  /* snapshot al solicitar */
        comision_modificada  DECIMAL(15,2) NOT NULL,
        comentario           TEXT         NOT NULL,          /* quién aprobó + respaldos */
        estado               VARCHAR(12)  NOT NULL DEFAULT 'PENDIENTE',  /* PENDIENTE|APROBADA|RECHAZADA */
        solicitado_por_id    INT, solicitado_por VARCHAR(150), solicitado_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        aprobado_por_id      INT, aprobado_por  VARCHAR(150), aprobado_at  DATETIME NULL,
        rechazo_motivo       VARCHAR(300) NULL,
        UNIQUE KEY uq_mes_op (mes, num_op, estado)
      )`);

    // Card + permisos en la matriz (la card no aparece sin permisos_perfil)
    await pool.query(`INSERT IGNORE INTO funcionalidades (id_funcionalidad, id_modulo, nombre, codigo, href, icono) VALUES
      (7800002, 150001, 'Modificar Comisión Ejecutivo', 'com_ejec_mod', '/comisiones/ajustes/', 'bi-pencil-square'),
      (7800003, 150001, 'Modificar Comisión — solicitar (Analista de Operaciones)', 'com_ejec_mod_solicitar', NULL, NULL),
      (7800004, 150001, 'Modificar Comisión — aprobar (Gerente de Operaciones o backup)', 'com_ejec_mod_aprobar', NULL, NULL)`);
    const dar = async (perfil, funcs) => {
      // LIKE: el nombre real es "Gerente de Operaciones y Crédito"
      const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE ? ORDER BY id_perfil LIMIT 1', [perfil]);
      if (!p) return;
      for (const f of funcs)
        await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad)
                          SELECT ?, id_funcionalidad FROM funcionalidades WHERE codigo = ?`, [p.id_perfil, f]);
    };
    await dar('ADMINISTRADOR',             ['com_ejec_mod', 'com_ejec_mod_solicitar', 'com_ejec_mod_aprobar']);
    await dar('ANALISTA DE OPERACIONES',   ['com_ejec_mod', 'com_ejec_mod_solicitar']);
    await dar('GERENTE DE OPERACIONES%',   ['com_ejec_mod', 'com_ejec_mod_aprobar']);
    console.log('[comisiones-ajustes] tabla + permisos OK');
  } catch (e) { console.error('[comisiones-ajustes migration]', e.message); }
});

/* Meses editables: el en curso y el anterior, siempre que no estén cerrados. */
async function mesEditable(mes) {
  const hoy = new Date();
  const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const curso = ym(hoy);
  const ant   = ym(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1));
  if (mes !== curso && mes !== ant) return { ok: false, motivo: `Solo se puede modificar el mes en curso (${curso}) o el anterior (${ant}).` };
  const [[cerrado]] = await pool.query('SELECT 1 c FROM meses_cerrados WHERE mes = ? AND cerrado = 1 LIMIT 1', [mes]).catch(() => [[null]]);
  if (cerrado) return { ok: false, motivo: `El mes ${mes} está cerrado.` };
  return { ok: true };
}

async function comisionAprobada(mes, ejecutivo) {
  const [[a]] = await pool.query(
    "SELECT estado FROM comisiones_aprobaciones WHERE mes = ? AND ejecutivo = ? AND UPPER(estado) IN ('APROBADA','APROBADO') LIMIT 1",
    [mes, ejecutivo]);
  return !!a;
}

/* ── GET /ajustes?mes= — los ajustes del mes (todas los estados) ── */
const listar = async (req, res) => {
  try {
    const mes = String(req.query.mes || '').slice(0, 7);
    const [rows] = await pool.query(
      'SELECT * FROM comisiones_ajustes_op WHERE mes = ? ORDER BY solicitado_at DESC', [mes]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── GET /ajustes-vigentes — mapa num_op → comisión modificada (APROBADAS).
   Lo consumen el informe de Rentabilidad y la pestaña Rent x Ejec. ── */
const vigentes = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT num_op, mes, comision_normal, comision_modificada FROM comisiones_ajustes_op WHERE estado = 'APROBADA'");
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── POST /ajustes — solicitar (Analista de Operaciones) ── */
const solicitar = async (req, res) => {
  try {
    const { mes, num_op, comision_normal, comision_modificada, comentario } = req.body || {};
    const m = String(mes || '').slice(0, 7);
    if (!m || !num_op || comision_modificada == null) return res.status(400).json({ success: false, data: null, error: 'mes, num_op y comision_modificada son obligatorios' });
    if (!String(comentario || '').trim() || String(comentario).trim().length < 15)
      return res.status(400).json({ success: false, data: null, error: 'El comentario es obligatorio: indica quién aprobó y los respaldos (ej: "mail del 14/02/2026 de Patricio Escobar a Operaciones").' });
    const ed = await mesEditable(m);
    if (!ed.ok) return res.status(400).json({ success: false, data: null, error: ed.motivo });

    const [[cr]] = await pool.query(
      "SELECT num_op, ejecutivo, UPPER(estado) estado FROM creditos WHERE num_op = ? LIMIT 1", [num_op]);
    if (!cr) return res.status(404).json({ success: false, data: null, error: `Operación ${num_op} no existe` });
    if (cr.estado !== 'OTORGADO') return res.status(400).json({ success: false, data: null, error: `La operación ${num_op} no está OTORGADA` });
    if (await comisionAprobada(m, cr.ejecutivo))
      return res.status(400).json({ success: false, data: null, error: `La comisión de ${cr.ejecutivo} del mes ${m} ya está aprobada: no se puede modificar.` });
    const [[dup]] = await pool.query(
      "SELECT id FROM comisiones_ajustes_op WHERE mes = ? AND num_op = ? AND estado IN ('PENDIENTE','APROBADA') LIMIT 1", [m, num_op]);
    if (dup) return res.status(400).json({ success: false, data: null, error: `La operación ${num_op} ya tiene un ajuste pendiente o aprobado en ${m}` });

    const nombre = req.usuario.nombre || req.usuario.email;
    const [r] = await pool.query(
      `INSERT INTO comisiones_ajustes_op (mes, num_op, ejecutivo, comision_normal, comision_modificada, comentario, solicitado_por_id, solicitado_por)
       VALUES (?,?,?,?,?,?,?,?)`,
      [m, num_op, cr.ejecutivo, Number(comision_normal) || 0, Number(comision_modificada), String(comentario).trim(), req.usuario.id_usuario, nombre]);
    auditar({ req, accion: 'CREAR', modulo: 'comisiones', entidad: 'ajuste_comision_op', entidad_id: String(r.insertId),
      detalle: `Solicitó ajuste comisión op ${num_op} (${cr.ejecutivo}, ${m}): $${Math.round(comision_normal || 0).toLocaleString('es-CL')} → $${Math.round(comision_modificada).toLocaleString('es-CL')}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[ajustes solicitar]', e.message); res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── POST /ajustes/:id/resolver — aprobar/rechazar (Gerente de Operaciones) ── */
const resolver = async (req, res) => {
  try {
    const { accion, motivo } = req.body || {};
    const [[a]] = await pool.query("SELECT * FROM comisiones_ajustes_op WHERE id = ? LIMIT 1", [req.params.id]);
    if (!a) return res.status(404).json({ success: false, data: null, error: 'Ajuste no existe' });
    if (a.estado !== 'PENDIENTE') return res.status(400).json({ success: false, data: null, error: 'El ajuste ya fue resuelto' });
    if (a.solicitado_por_id === req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Quien solicita no puede aprobar su propio ajuste (segregación de funciones)' });
    if (accion === 'rechazar' && !String(motivo || '').trim())
      return res.status(400).json({ success: false, data: null, error: 'El rechazo requiere motivo' });
    const ed = await mesEditable(a.mes);
    if (accion === 'aprobar' && !ed.ok) return res.status(400).json({ success: false, data: null, error: ed.motivo });

    const nombre = req.usuario.nombre || req.usuario.email;
    await pool.query(
      `UPDATE comisiones_ajustes_op SET estado = ?, aprobado_por_id = ?, aprobado_por = ?, aprobado_at = NOW(), rechazo_motivo = ? WHERE id = ?`,
      [accion === 'aprobar' ? 'APROBADA' : 'RECHAZADA', req.usuario.id_usuario, nombre, accion === 'rechazar' ? String(motivo).trim() : null, a.id]);
    auditar({ req, accion: accion === 'aprobar' ? 'APROBAR' : 'RECHAZAR', modulo: 'comisiones', entidad: 'ajuste_comision_op', entidad_id: String(a.id),
      detalle: `${accion === 'aprobar' ? 'Aprobó' : 'Rechazó'} ajuste comisión op ${a.num_op} (${a.ejecutivo}, ${a.mes})${accion === 'rechazar' ? ': ' + motivo : ''}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) { console.error('[ajustes resolver]', e.message); res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── GET /ajustes/historia — agrupada mes → ejecutivo → operaciones ── */
const historia = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM comisiones_ajustes_op WHERE estado IN ('APROBADA','RECHAZADA') ORDER BY mes DESC, ejecutivo, solicitado_at DESC`);
    const meses = {};
    for (const r of rows) {
      const m = meses[r.mes] || (meses[r.mes] = { mes: r.mes, total_dif: 0, n: 0, ejecutivos: {} });
      const e = m.ejecutivos[r.ejecutivo] || (m.ejecutivos[r.ejecutivo] = { ejecutivo: r.ejecutivo, n: 0, total_dif: 0, ops: [] });
      const dif = Number(r.comision_modificada) - Number(r.comision_normal);
      const pct = Number(r.comision_normal) ? dif / Number(r.comision_normal) * 100 : null;
      e.ops.push({ ...r, dif, pct });
      e.n++; m.n++;
      if (r.estado === 'APROBADA') { e.total_dif += dif; m.total_dif += dif; }
    }
    const data = Object.values(meses).map(m => ({ ...m, ejecutivos: Object.values(m.ejecutivos) }));
    res.json({ success: true, data, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { listar, vigentes, solicitar, resolver, historia };
