'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ¿QUÉ DICE AUTOFÁCIL? — concurso de capacitación estilo "¿Qué Dice Chile?"
   Tablero de respuestas ocultas con puntaje. Para onboarding y capacitación:
   se juega en equipo (modo animador, proyectado) o solo (modo práctica).
   PARAMÉTRICO: las preguntas y respuestas se mantienen desde la misma página
   (permiso concurso_editar), sin tocar código.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración + seed ───────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('concurso-quedice', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS concurso_preguntas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    categoria VARCHAR(60) DEFAULT 'General',
    pregunta VARCHAR(300) NOT NULL,
    activa TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS concurso_respuestas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_pregunta INT NOT NULL,
    texto VARCHAR(160) NOT NULL,
    sinonimos VARCHAR(300) NULL,
    puntos INT NOT NULL DEFAULT 10,
    orden INT DEFAULT 0,
    INDEX idx_preg (id_pregunta)
  )`);

  // Funcionalidades: jugar (todos) + editar preguntas (Admin/RRHH)
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    let [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='concurso' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, '¿Qué Dice AutoFácil?', 'concurso', '/concurso/', 'bi-controller')`, [modRRHH.id_modulo]);
      f = { id_funcionalidad: r.insertId };
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p`, [f.id_funcionalidad]);
    }
    let [[fe]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='concurso_editar' LIMIT 1`);
    if (!fe) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Concurso — editar preguntas', 'concurso_editar', NULL, NULL)`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }

  // Seed inicial (solo si está vacío): preguntas de onboarding del negocio
  const [[n]] = await pool.query(`SELECT COUNT(*) n FROM concurso_preguntas`);
  if (!n.n) {
    const SEED = [
      ['Onboarding', 'Nombra un documento que se le pide al cliente para evaluar su crédito', [
        ['Cédula de identidad', 'carnet|cedula', 30], ['Liquidaciones de sueldo', 'liquidacion|sueldo', 28],
        ['Cotizaciones AFP', 'afp|cotizacion', 18], ['Contrato de trabajo', 'contrato', 14], ['Comprobante de domicilio', 'domicilio', 10]]],
      ['Onboarding', '¿Qué revisa un analista antes de aprobar un crédito?', [
        ['La renta del cliente', 'renta|sueldo|ingreso', 30], ['Los informes comerciales', 'dicom|informe|deuda', 26],
        ['La carga cuota/renta', 'carga|capacidad de pago', 20], ['La antigüedad laboral', 'antiguedad', 14], ['El pie del auto', 'pie', 10]]],
      ['Onboarding', 'Nombra una financiera o canal con el que trabaja AutoFácil', [
        ['AutoFin', 'autofin', 40], ['Unidad de Crédito', 'unidad|uac', 32], ['AutoFácil (recursos propios)', 'autofacil|propia|cartera propia', 28]]],
      ['Crédito', 'Nombra un gasto operacional de un crédito automotriz', [
        ['Inscripción de prenda', 'prenda', 28], ['Impuesto de timbres', 'timbre|impuesto', 24],
        ['GPS', 'gps', 20], ['Gastos de notaría', 'notaria', 16], ['Gastos administrativos', 'administrativo', 12]]],
      ['Crédito', 'Nombra un seguro que puede llevar un crédito automotriz', [
        ['Desgravamen', 'desgravamen', 40], ['Cesantía', 'cesantia', 32], ['RDH (robo, daños y hurto)', 'rdh|robo', 28]]],
      ['Cobranza', '¿Qué hace AutoFácil cuando un cliente se atrasa en su cuota?', [
        ['Lo llama por teléfono', 'llama|telefono|llamada', 28], ['Le manda un WhatsApp', 'whatsapp|wsp', 24],
        ['Le envía un correo', 'correo|mail|email', 20], ['Registra la gestión en CRM', 'crm|gestion|bitacora', 16], ['Le ofrece un compromiso de pago', 'compromiso', 12]]],
      ['Cultura', '¿Dónde puede pagar su cuota un cliente AutoFácil?', [
        ['En la caja (oficina)', 'caja|oficina|presencial', 34], ['Por transferencia', 'transferencia|banco', 30],
        ['En el portal del cliente', 'portal|web|mis creditos', 22], ['Con el ejecutivo de cobranza', 'ejecutivo|cobranza', 14]]],
      ['Cultura', 'Nombra un módulo del Business Suite que uses todos los días', [
        ['Mi Día', 'mi dia', 26], ['Créditos', 'creditos', 22], ['Dashboard', 'dashboard', 18],
        ['Cartas de Aprobación', 'cartas|aprobaciones', 14], ['WhatsApp', 'whatsapp|facilito', 12], ['El Café ☕', 'cafe', 8]]],
    ];
    for (const [cat, preg, resps] of SEED) {
      const [r] = await pool.query(`INSERT INTO concurso_preguntas (categoria, pregunta) VALUES (?,?)`, [cat, preg]);
      let i = 0;
      for (const [texto, sin, pts] of resps)
        await pool.query(`INSERT INTO concurso_respuestas (id_pregunta, texto, sinonimos, puntos, orden) VALUES (?,?,?,?,?)`,
          [r.insertId, texto, sin, pts, i++]);
    }
    console.log('✓ concurso: seed ¿Qué Dice AutoFácil? (8 preguntas)');
  }
});

/* ── Juego ──────────────────────────────────────────────────────────────────── */
// GET /api/concurso/preguntas — lista para jugar (respuestas incluidas: el match es client-side)
exports.getPreguntas = async (req, res) => {
  try {
    const [pregs] = await pool.query(`SELECT id, categoria, pregunta FROM concurso_preguntas WHERE activa=1 ORDER BY categoria, id`);
    const [resps] = pregs.length
      ? await pool.query(`SELECT id, id_pregunta, texto, sinonimos, puntos FROM concurso_respuestas WHERE id_pregunta IN (?) ORDER BY puntos DESC, orden`, [pregs.map(p => p.id)])
      : [[]];
    const editor = await tieneFunc(req.usuario.id_usuario, 'concurso_editar').catch(() => false);
    ok(res, {
      editor,
      preguntas: pregs.map(p => ({ ...p, respuestas: resps.filter(r => r.id_pregunta === p.id) })),
    });
  } catch (e) { fail(res, e.message); }
};

/* ── Mantenedor (concurso_editar) ───────────────────────────────────────────── */
async function exigirEditor(req, res) {
  const puede = await tieneFunc(req.usuario.id_usuario, 'concurso_editar').catch(() => false);
  if (!puede) { fail(res, 'Sin permiso para editar el concurso', 403); return false; }
  return true;
}

// POST /api/concurso/preguntas  { id?, categoria, pregunta, activa, respuestas:[{texto, sinonimos, puntos}] }
exports.guardarPregunta = async (req, res) => {
  try {
    if (!await exigirEditor(req, res)) return;
    const { id, categoria, pregunta, activa = 1, respuestas = [] } = req.body || {};
    if (!String(pregunta || '').trim()) return fail(res, 'Falta la pregunta', 400);
    if (!Array.isArray(respuestas) || !respuestas.filter(r => String(r.texto || '').trim()).length)
      return fail(res, 'Agrega al menos una respuesta', 400);
    let idP = parseInt(id) || 0;
    if (idP) {
      await pool.query(`UPDATE concurso_preguntas SET categoria=?, pregunta=?, activa=? WHERE id=?`,
        [String(categoria || 'General').slice(0, 60), String(pregunta).slice(0, 300), activa ? 1 : 0, idP]);
      await pool.query(`DELETE FROM concurso_respuestas WHERE id_pregunta=?`, [idP]);
    } else {
      const [r] = await pool.query(`INSERT INTO concurso_preguntas (categoria, pregunta, activa) VALUES (?,?,?)`,
        [String(categoria || 'General').slice(0, 60), String(pregunta).slice(0, 300), activa ? 1 : 0]);
      idP = r.insertId;
    }
    let i = 0;
    for (const r of respuestas.filter(r => String(r.texto || '').trim()).slice(0, 8))
      await pool.query(`INSERT INTO concurso_respuestas (id_pregunta, texto, sinonimos, puntos, orden) VALUES (?,?,?,?,?)`,
        [idP, String(r.texto).slice(0, 160), String(r.sinonimos || '').slice(0, 300) || null, Math.max(1, parseInt(r.puntos) || 10), i++]);
    ok(res, { id: idP });
  } catch (e) { fail(res, e.message); }
};

// DELETE /api/concurso/preguntas/:id
exports.eliminarPregunta = async (req, res) => {
  try {
    if (!await exigirEditor(req, res)) return;
    const id = parseInt(req.params.id);
    await pool.query(`DELETE FROM concurso_respuestas WHERE id_pregunta=?`, [id]);
    await pool.query(`DELETE FROM concurso_preguntas WHERE id=?`, [id]);
    ok(res, { id });
  } catch (e) { fail(res, e.message); }
};
