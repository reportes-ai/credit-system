'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SIMULADOR DE EXCEPCIONES — el Ejecutivo Comercial "juega" con un negocio
   (precio, pie, seguros, baja de tasa Unidad, baja de comisión dealer) y, si la
   combinación respeta el piso de rentabilidad, genera un CÓDIGO de aprobación
   de la excepción para usarlo en la Carta de Aprobación.

   Presupuesto (estrellas): exc_estrellas_mes1 el primer mes; después
   floor(otorgadas del mes anterior × exc_pct_mensual%) — redondeo HACIA ABAJO
   (el aliciente es colocar al menos 3). Generar un código consume la estrella;
   si vence sin usarse (exc_vigencia_horas, 24 h) la estrella se devuelve dentro
   del mismo mes. Las estrellas no usadas al cierre del mes expiran.

   Comodín dorado: 1 cada exc_comodin_cada (50) otorgadas ACUMULADAS; se
   acumula (es premio, no presupuesto).

   Tipos de código: PROPIO (estrella) · COMODIN (dorado) · GERENCIA (lo genera
   el Gerente de Operaciones con comentario, no descuenta estrellas).

   SEGURIDAD: el código es ALEATORIO y vive en BD con snapshot completo — no es
   derivable por fórmula. La validación compara saldo precio (± exc_tolerancia_
   saldo), primeros 3 dígitos del RUT y vigencia. Un código = un solo uso.
   Todos los parámetros: mantenedor Excepciones Comerciales (claves exc_*).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const A = require('../../../../shared/avisos');

A.registrarAviso({ evento: 'excep_gerencia_solicitada', nombre: 'Código de excepción de Gerencia solicitado',
  modulo: 'Excepciones', base_func: 'excepciones_gerencia', prioridad: 'alta',
  descripcion: 'Un ejecutivo pidió un código de excepción de Gerencia para un caso puntual; espera que el Gerente de Operaciones lo genere.' });

require('../../../../shared/migrate').enFila('excepciones-codigos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS excepciones_codigos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        codigo        VARCHAR(10)  NOT NULL,
        tipo          VARCHAR(10)  NOT NULL DEFAULT 'PROPIO',   /* PROPIO|COMODIN|GERENCIA */
        estado        VARCHAR(10)  NOT NULL DEFAULT 'VIGENTE',  /* VIGENTE|USADO|VENCIDO */
        ejecutivo     VARCHAR(150) NOT NULL,          /* dueño del código (nombre como en creditos.ejecutivo) */
        ejecutivo_id  INT NULL,
        rut_cliente   VARCHAR(15)  NOT NULL,          /* RUT completo del cliente simulado */
        saldo_precio  BIGINT       NOT NULL,
        plazo         INT NULL,
        financiera    VARCHAR(20) NULL,               /* lado elegido en la simulación */
        snapshot      JSON NULL,                      /* simulación completa al generar */
        comentario    VARCHAR(400) NULL,              /* GERENCIA: motivo obligatorio */
        generado_por  VARCHAR(150) NULL, generado_por_id INT NULL,
        generado_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        vence_at      DATETIME NOT NULL,
        usado_carta   VARCHAR(30) NULL,               /* op_carta donde se usó */
        usado_at      DATETIME NULL,
        UNIQUE KEY uq_codigo (codigo),
        INDEX idx_ejec (ejecutivo), INDEX idx_estado (estado)
      )`);

    // Card + permisos de acción
    await pool.query(`INSERT IGNORE INTO funcionalidades (id_funcionalidad, id_modulo, nombre, codigo, href, icono) VALUES
      (7930001, 300001, 'Simulador de Excepciones', 'excepciones_simulador', '/excepciones/', 'bi-stars'),
      (7930002, 300001, 'Excepciones — generar código propio/comodín', 'excepciones_generar', NULL, NULL),
      (7930003, 300001, 'Excepciones — generar código de Gerencia', 'excepciones_gerencia', NULL, NULL)`);
    const dar = async (perfilLike, funcs) => {
      const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE ? ORDER BY id_perfil LIMIT 1', [perfilLike]);
      if (!p) return;
      for (const f of funcs) {
        await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                          SELECT ?, id_funcionalidad, 1 FROM funcionalidades WHERE codigo = ?`, [p.id_perfil, f]);
        await pool.query(`UPDATE permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
                          SET pp.habilitado = 1 WHERE f.codigo = ? AND pp.id_perfil = ?`, [f, p.id_perfil]);
      }
    };
    await dar('ADMINISTRADOR',              ['excepciones_simulador', 'excepciones_generar', 'excepciones_gerencia']);
    await dar('EJECUTIVO COMERCIAL',        ['excepciones_simulador', 'excepciones_generar']);
    await dar('SUPERVISOR COMERCIAL',       ['excepciones_simulador', 'excepciones_generar']);
    await dar('JEFE COMERCIAL',             ['excepciones_simulador']);
    await dar('GERENTE DE OPERACIONES%',    ['excepciones_simulador', 'excepciones_gerencia']);
    console.log('[excepciones] tabla + card + permisos OK');
  } catch (e) { console.error('[excepciones migration]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────── */
const nombreDe = (req) => `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim();

async function params() {
  const [rows] = await pool.query("SELECT clave, valor FROM parametros_credito WHERE clave LIKE 'exc\\_%'");
  const p = {}; rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* Vencimiento perezoso: no hace falta un motor — al consultar se marcan. */
async function vencerCaducos() {
  await pool.query("UPDATE excepciones_codigos SET estado='VENCIDO' WHERE estado='VIGENTE' AND vence_at < NOW()");
}

const mesYM = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/* Presupuesto del ejecutivo (por nombre, como viene en creditos.ejecutivo). */
async function presupuesto(ejecutivo, P) {
  const hoy = new Date();
  const mesActual = mesYM(hoy);
  const mesAnt = mesYM(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1));
  const [[prev]] = await pool.query(
    `SELECT COUNT(*) n FROM creditos WHERE UPPER(estado)='OTORGADO' AND UPPER(TRIM(ejecutivo))=UPPER(?) AND DATE_FORMAT(mes,'%Y-%m')=?`,
    [ejecutivo, mesAnt]);
  const [[antes]] = await pool.query(
    `SELECT COUNT(*) n FROM creditos WHERE UPPER(estado)='OTORGADO' AND UPPER(TRIM(ejecutivo))=UPPER(?) AND DATE_FORMAT(mes,'%Y-%m') < ?`,
    [ejecutivo, mesActual]);
  const [[hist]] = await pool.query(
    `SELECT COUNT(*) n FROM creditos WHERE UPPER(estado)='OTORGADO' AND UPPER(TRIM(ejecutivo))=UPPER(?)`, [ejecutivo]);

  const esPrimerMes = (antes.n || 0) === 0;
  const estrellasTotal = esPrimerMes
    ? Math.round(P.exc_estrellas_mes1 ?? 2)
    : Math.floor((prev.n || 0) * (P.exc_pct_mensual ?? 33) / 100);

  // Consumidas este mes: PROPIO vigentes o usados (los VENCIDOS devuelven la estrella)
  const [[usadas]] = await pool.query(
    `SELECT COUNT(*) n FROM excepciones_codigos
     WHERE tipo='PROPIO' AND UPPER(ejecutivo)=UPPER(?) AND estado IN ('VIGENTE','USADO')
       AND DATE_FORMAT(generado_at,'%Y-%m')=?`, [ejecutivo, mesActual]);

  // Comodines: ganados históricos − emitidos no vencidos (se acumulan entre meses)
  const ganados = Math.floor((hist.n || 0) / Math.max(1, Math.round(P.exc_comodin_cada ?? 50)));
  const [[comUsados]] = await pool.query(
    `SELECT COUNT(*) n FROM excepciones_codigos
     WHERE tipo='COMODIN' AND UPPER(ejecutivo)=UPPER(?) AND estado IN ('VIGENTE','USADO')`, [ejecutivo]);

  return {
    ejecutivo, es_primer_mes: esPrimerMes,
    otorgadas_mes_anterior: prev.n || 0, otorgadas_historicas: hist.n || 0,
    estrellas_total: estrellasTotal, estrellas_usadas: usadas.n || 0,
    estrellas_disponibles: Math.max(0, estrellasTotal - (usadas.n || 0)),
    comodines_ganados: ganados, comodines_usados: comUsados.n || 0,
    comodines_disponibles: Math.max(0, ganados - (comUsados.n || 0)),
  };
}

function genCodigo(digitos) {
  const n = Math.max(4, Math.min(10, Math.round(digitos || 6)));
  let s = '';
  const { randomInt } = require('crypto');
  for (let i = 0; i < n; i++) s += randomInt(0, 10);
  return s;
}

const rutCuerpo3 = (rut) => String(rut || '').replace(/[^0-9]/g, '').slice(0, 3);

/* ── GET /api/excepciones/estado — estrellas y comodines del usuario ────── */
const getEstado = async (req, res) => {
  try {
    await vencerCaducos();
    const P = await params();
    // Admin/Gerencia pueden mirar el presupuesto de otro ejecutivo
    const ejecutivo = (req.query.ejecutivo && ['Administrador', 'Administrador de Sistema', 'Gerente de Operaciones y Crédito'].includes(req.usuario?.perfil_nombre))
      ? String(req.query.ejecutivo) : nombreDe(req);
    const pre = await presupuesto(ejecutivo, P);
    res.json({ success: true, data: { ...pre, params: P }, error: null });
  } catch (e) { console.error('[excepciones estado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/excepciones/generar — código PROPIO o COMODIN ────────────── */
const generar = async (req, res) => {
  try {
    await vencerCaducos();
    const P = await params();
    const { tipo = 'PROPIO', rut_cliente, saldo_precio, plazo, financiera, snapshot } = req.body || {};
    if (!['PROPIO', 'COMODIN'].includes(tipo)) return res.status(400).json({ success: false, data: null, error: 'Tipo inválido' });
    const rut = String(rut_cliente || '').trim();
    const saldo = Math.round(Number(saldo_precio) || 0);
    if (!/^[0-9.]+-?[0-9kK]?$/.test(rut) || rut.replace(/[^0-9]/g, '').length < 7)
      return res.status(400).json({ success: false, data: null, error: 'RUT del cliente inválido' });
    if (!(saldo > 0)) return res.status(400).json({ success: false, data: null, error: 'Saldo precio inválido' });

    const ejecutivo = nombreDe(req);
    const pre = await presupuesto(ejecutivo, P);
    if (tipo === 'PROPIO' && pre.estrellas_disponibles <= 0)
      return res.status(400).json({ success: false, data: null, error: `Sin estrellas disponibles este mes (${pre.estrellas_usadas}/${pre.estrellas_total} usadas). Puedes pedir un código de Gerencia para un caso puntual.` });
    if (tipo === 'COMODIN' && pre.comodines_disponibles <= 0)
      return res.status(400).json({ success: false, data: null, error: 'No tienes comodines dorados disponibles.' });

    const horas = Math.max(1, Math.round(P.exc_vigencia_horas ?? 24));
    let codigo = null;
    for (let i = 0; i < 8 && !codigo; i++) {
      const c = genCodigo(P.exc_codigo_digitos);
      const [r] = await pool.query(
        `INSERT IGNORE INTO excepciones_codigos (codigo, tipo, ejecutivo, ejecutivo_id, rut_cliente, saldo_precio, plazo, financiera, snapshot, generado_por, generado_por_id, vence_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
        [c, tipo, ejecutivo, req.usuario?.id_usuario || null, rut, saldo, parseInt(plazo) || null,
         (financiera || '').slice(0, 20) || null, snapshot ? JSON.stringify(snapshot) : null,
         ejecutivo, req.usuario?.id_usuario || null, horas]);
      if (r.affectedRows) codigo = c;
    }
    if (!codigo) return res.status(500).json({ success: false, data: null, error: 'No se pudo generar un código único, intenta de nuevo' });
    auditar({ req, accion: 'CREAR', modulo: 'excepciones', entidad: 'excepciones_codigos', entidad_id: codigo,
      detalle: `Generó código de excepción ${tipo} (saldo $${saldo.toLocaleString('es-CL')}, RUT ${rut})` });
    res.json({ success: true, data: { codigo, tipo, vence_horas: horas }, error: null });
  } catch (e) { console.error('[excepciones generar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/excepciones/generar-gerencia — código GERENCIA ───────────── */
const generarGerencia = async (req, res) => {
  try {
    const P = await params();
    const { rut_cliente, saldo_precio, plazo, ejecutivo, comentario } = req.body || {};
    const rut = String(rut_cliente || '').trim();
    const saldo = Math.round(Number(saldo_precio) || 0);
    if (!String(comentario || '').trim() || String(comentario).trim().length < 10)
      return res.status(400).json({ success: false, data: null, error: 'El comentario del motivo es obligatorio (mínimo 10 caracteres)' });
    if (rut.replace(/[^0-9]/g, '').length < 7 || !(saldo > 0))
      return res.status(400).json({ success: false, data: null, error: 'RUT y saldo precio son obligatorios' });
    const horas = Math.max(1, Math.round(P.exc_vigencia_horas ?? 24));
    let codigo = null;
    for (let i = 0; i < 8 && !codigo; i++) {
      const c = genCodigo(P.exc_codigo_digitos);
      const [r] = await pool.query(
        `INSERT IGNORE INTO excepciones_codigos (codigo, tipo, ejecutivo, rut_cliente, saldo_precio, plazo, comentario, generado_por, generado_por_id, vence_at)
         VALUES (?, 'GERENCIA', ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
        [c, String(ejecutivo || nombreDe(req)).trim(), rut, saldo, parseInt(plazo) || null,
         String(comentario).trim().slice(0, 400), nombreDe(req), req.usuario?.id_usuario || null, horas]);
      if (r.affectedRows) codigo = c;
    }
    if (!codigo) return res.status(500).json({ success: false, data: null, error: 'No se pudo generar un código único' });
    auditar({ req, accion: 'CREAR', modulo: 'excepciones', entidad: 'excepciones_codigos', entidad_id: codigo,
      detalle: `Generó código de GERENCIA para ${ejecutivo || '(sin ejecutivo)'} — ${String(comentario).trim().slice(0, 120)}` });
    res.json({ success: true, data: { codigo, tipo: 'GERENCIA' }, error: null });
  } catch (e) { console.error('[excepciones gerencia]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/excepciones/mis-codigos ───────────────────────────────────── */
const misCodigos = async (req, res) => {
  try {
    await vencerCaducos();
    const [rows] = await pool.query(
      `SELECT codigo, tipo, estado, rut_cliente, saldo_precio, plazo, financiera, comentario,
              generado_por, generado_at, vence_at, usado_carta, usado_at
       FROM excepciones_codigos WHERE UPPER(ejecutivo)=UPPER(?) ORDER BY generado_at DESC LIMIT 200`,
      [nombreDe(req)]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[excepciones mis-codigos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/excepciones/validar/:codigo — a qué operación pertenece ───── */
const validar = async (req, res) => {
  try {
    await vencerCaducos();
    const [[c]] = await pool.query('SELECT * FROM excepciones_codigos WHERE codigo=?', [String(req.params.codigo || '').trim()]);
    if (!c) return res.json({ success: true, data: { existe: false }, error: null });
    res.json({ success: true, data: {
      existe: true, codigo: c.codigo, tipo: c.tipo, estado: c.estado,
      ejecutivo: c.ejecutivo, rut_cliente: c.rut_cliente,
      saldo_precio: Number(c.saldo_precio), plazo: c.plazo, financiera: c.financiera,
      comentario: c.comentario, generado_por: c.generado_por, generado_at: c.generado_at,
      vence_at: c.vence_at, usado_carta: c.usado_carta, usado_at: c.usado_at,
    }, error: null });
  } catch (e) { console.error('[excepciones validar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/excepciones/usar — consumir un código (lo llamará la Carta) ──
   Valida: existe, VIGENTE, saldo ± tolerancia, primeros 3 dígitos del RUT. */
const usar = async (req, res) => {
  try {
    await vencerCaducos();
    const P = await params();
    const { codigo, saldo_precio, rut_cliente, op_carta } = req.body || {};
    const [[c]] = await pool.query('SELECT * FROM excepciones_codigos WHERE codigo=?', [String(codigo || '').trim()]);
    if (!c) return res.status(400).json({ success: false, data: null, error: 'El código no existe' });
    if (c.estado === 'USADO') return res.status(400).json({ success: false, data: null, error: `Código ya usado en la carta ${c.usado_carta || ''} — un código sirve una sola vez` });
    if (c.estado === 'VENCIDO') return res.status(400).json({ success: false, data: null, error: 'Código vencido (la estrella volvió al ejecutivo)' });
    const tol = Math.max(0, Math.round(P.exc_tolerancia_saldo ?? 0));
    const saldo = Math.round(Number(saldo_precio) || 0);
    if (Math.abs(saldo - Number(c.saldo_precio)) > tol)
      return res.status(400).json({ success: false, data: null, error: `El saldo precio no calza con la simulación del código ($${Number(c.saldo_precio).toLocaleString('es-CL')})` });
    if (rutCuerpo3(rut_cliente) !== rutCuerpo3(c.rut_cliente))
      return res.status(400).json({ success: false, data: null, error: 'El RUT del cliente no calza con la simulación del código' });
    await pool.query("UPDATE excepciones_codigos SET estado='USADO', usado_carta=?, usado_at=NOW() WHERE id=? AND estado='VIGENTE'",
      [(op_carta || '').slice(0, 30) || null, c.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'excepciones', entidad: 'excepciones_codigos', entidad_id: c.codigo,
      detalle: `Código ${c.tipo} usado${op_carta ? ` en carta ${op_carta}` : ''}` });
    res.json({ success: true, data: { codigo: c.codigo, tipo: c.tipo, ejecutivo: c.ejecutivo }, error: null });
  } catch (e) { console.error('[excepciones usar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/excepciones/registro — historial completo (Gerencia/Admin) ── */
const registro = async (req, res) => {
  try {
    await vencerCaducos();
    const [rows] = await pool.query(
      `SELECT codigo, tipo, estado, ejecutivo, rut_cliente, saldo_precio, plazo, financiera,
              comentario, generado_por, generado_at, vence_at, usado_carta, usado_at
       FROM excepciones_codigos ORDER BY generado_at DESC LIMIT 500`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[excepciones registro]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getEstado, generar, generarGerencia, misCodigos, validar, usar, registro };
