'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CASTIGO CONTABLE DE SALDO (cartera propia AFA / AutoFácil)
   Da de baja contablemente una operación incobrable. Flujo:
     1. SOLICITAR  — sobre una op de cartera propia se registra el castigo con
        motivo (INCOBRABLE / NEGOCIACION / OTROS) + comentario. Snapshot del saldo
        insoluto con el motor único calcularPrepago. Queda PENDIENTE.
     2. APROBAR    — requiere DOS firmas de gerencia, cada una de un rol:
          · FINANZAS     → Gerente de Administración y Finanzas
          · OPERACIONES  → Gerente de Operaciones y Riesgo
        El Gerente General puede reemplazar a cualquiera (tiene ambos permisos).
        Las dos firmas deben ser de personas DISTINTAS. Al completar ambas, se
        aplica el castigo: la op pasa a estado_cartera='CASTIGADO' (baja).
        Si cualquier firma RECHAZA, el castigo queda RECHAZADO (no aplica).
   Historial completo (fecha/hora, motivo, comentario, aprobadores) en Tesorería.
   Autorización paramétrica (funcionalidades + matriz de Perfiles), nada hardcodeado.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { calcularPrepago } = require('../../../certificados/src/controllers/certificados.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

const MOTIVOS = ['INCOBRABLE', 'NEGOCIACION', 'OTROS'];
const ROLES = { FINANZAS: 'castigo_aprobar_finanzas', OPERACIONES: 'castigo_aprobar_operaciones' };

/* ── Migración ──────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS castigos_contables (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        num_op        VARCHAR(20) NOT NULL,
        id_credito    INT NULL,
        motivo        ENUM('INCOBRABLE','NEGOCIACION','OTROS') NOT NULL,
        comentario    VARCHAR(1000) NULL,
        saldo_castigado DECIMAL(16,2) NULL,          -- snapshot del saldo insoluto al solicitar
        snapshot      JSON NULL,                     -- desglose del motor de prepago
        estado        ENUM('PENDIENTE','APROBADO','RECHAZADO','ANULADO') DEFAULT 'PENDIENTE',
        solicitado_por INT NULL,
        solicitado_por_nombre VARCHAR(160) NULL,
        solicitado_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        aplicado_at   DATETIME NULL,
        INDEX ix_op (num_op), INDEX ix_estado (estado)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS castigos_aprobaciones (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_castigo    INT NOT NULL,
        rol           ENUM('FINANZAS','OPERACIONES') NOT NULL,
        decision      ENUM('APROBADO','RECHAZADO') NOT NULL,
        comentario    VARCHAR(600) NULL,
        aprobado_por  INT NULL,
        aprobado_por_nombre VARCHAR(160) NULL,
        aprobado_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_castigo_rol (id_castigo, rol)   -- un slot por rol
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contab_saldos_mensuales (
        mes    CHAR(7) NOT NULL,                          -- '2026-07'
        cuenta VARCHAR(20) NOT NULL,                      -- 'PROVISIONES' | 'CASTIGOS'
        saldo  DECIMAL(16,2) NOT NULL,                    -- saldo final del mes (snapshot al cierre)
        guardado_por INT NULL, guardado_por_nombre VARCHAR(160) NULL,
        guardado_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (mes, cuenta)
      )`);

    // Funcionalidades (menú + permisos). Historial vive en Tesorería.
    const seedFunc = async (idMod, nombre, codigo, href, icono) => {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) return ex.id_funcionalidad;
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [idMod, nombre, codigo, href, icono]);
      return r.insertId;
    };
    const perfilId = async nombre => { const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre=? LIMIT 1', [nombre]); return p && p.id_perfil; };
    const grant = async (idF, ...perfiles) => {
      for (const nom of perfiles) { const id = await perfilId(nom); if (id) await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [id, idF]); }
    };
    const [[modC]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '/creditos%' OR nombre='Créditos' LIMIT 1");
    const [[modT]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (modC) {
      const fSol = await seedFunc(modC.id_modulo, 'Solicitar Castigo de Saldo', 'castigo_solicitar', null, 'bi-file-earmark-minus');
      const fFin = await seedFunc(modC.id_modulo, 'Aprobar Castigo — Finanzas', 'castigo_aprobar_finanzas', null, 'bi-check2-square');
      const fOps = await seedFunc(modC.id_modulo, 'Aprobar Castigo — Operaciones y Riesgo', 'castigo_aprobar_operaciones', null, 'bi-check2-square');
      await grant(fSol, 'Gerente General', 'Gerente de Finanzas', 'Gerente de Operaciones y Crédito', 'Tesorero');
      await grant(fFin, 'Gerente de Finanzas', 'Gerente General');
      await grant(fOps, 'Gerente de Operaciones y Crédito', 'Gerente General');
    }
    if (modT) {
      const fHist = await seedFunc(modT.id_modulo, 'Castigos de Saldo (Historial)', 'castigos_historial', '/tesoreria/castigos', 'bi-file-earmark-minus');
      await grant(fHist, 'Gerente General', 'Gerente de Finanzas', 'Gerente de Operaciones y Crédito', 'Tesorero', 'Auditor');
    }
    console.log('[castigos] módulo listo');
  } catch (e) { console.error('[castigos migration]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const ORIGENES_PROPIA = ['CARTERA_AFA', 'CARTERA_XLSX'];

async function creditoPropio(num_op) {
  const [[c]] = await pool.query(
    `SELECT c.id, c.num_op, c.origen, c.estado_cartera,
            COALESCE(cl.nombre_completo, cl.nombre, '') AS nombre, cl.rut
       FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE c.num_op = ? LIMIT 1`, [num_op]);
  return c || null;
}

async function conAprobaciones(castigos) {
  if (!castigos.length) return castigos;
  const ids = castigos.map(c => c.id);
  const [aps] = await pool.query('SELECT * FROM castigos_aprobaciones WHERE id_castigo IN (?)', [ids]);
  const byId = {};
  for (const a of aps) (byId[a.id_castigo] = byId[a.id_castigo] || []).push(a);
  return castigos.map(c => ({ ...c, aprobaciones: byId[c.id] || [] }));
}

/* ── Solicitar ──────────────────────────────────────────────────────────────── */
const solicitar = async (req, res) => {
  try {
    const { num_op, motivo, comentario } = req.body || {};
    if (!num_op || !motivo) return fail(res, 'num_op y motivo son obligatorios', 400);
    if (!MOTIVOS.includes(motivo)) return fail(res, 'Motivo inválido', 400);

    const c = await creditoPropio(num_op);
    if (!c) return fail(res, 'Operación no encontrada', 404);
    if (!ORIGENES_PROPIA.includes(String(c.origen))) return fail(res, 'El castigo de saldo solo aplica a operaciones de cartera propia.', 400);
    if (String(c.estado_cartera).toUpperCase() === 'CASTIGADO') return fail(res, 'La operación ya está castigada.', 409);

    const [[pend]] = await pool.query("SELECT id FROM castigos_contables WHERE num_op=? AND estado='PENDIENTE' LIMIT 1", [num_op]);
    if (pend) return fail(res, 'Ya existe un castigo pendiente para esta operación.', 409);

    let snap = null, saldo = null;
    try { snap = await calcularPrepago(num_op); saldo = snap.saldo_insoluto; } catch (_) { /* sin calendario → saldo null */ }

    const [r] = await pool.query(
      `INSERT INTO castigos_contables (num_op, id_credito, motivo, comentario, saldo_castigado, snapshot, solicitado_por, solicitado_por_nombre)
       VALUES (?,?,?,?,?,?,?,?)`,
      [num_op, c.id, motivo, (comentario || '').slice(0, 1000), saldo, snap ? JSON.stringify(snap) : null,
       req.usuario.id_usuario, nombreUsuario(req)]);
    auditar({ req, accion: 'CREAR', modulo: 'creditos', entidad: 'castigos_contables', entidad_id: r.insertId, detalle: `Solicitó castigo op ${num_op} (${motivo})`, meta: { num_op, motivo, saldo } });
    ok(res, { id: r.insertId, num_op, motivo, saldo_castigado: saldo, estado: 'PENDIENTE' });
  } catch (e) { fail(res, e.message); }
};

/* ── Aprobar / rechazar una firma ───────────────────────────────────────────── */
const aprobar = async (req, res) => {
  try {
    const { rol, decision, comentario } = req.body || {};
    if (!ROLES[rol]) return fail(res, 'Rol inválido (FINANZAS u OPERACIONES)', 400);
    if (!['APROBADO', 'RECHAZADO'].includes(decision)) return fail(res, 'Decisión inválida', 400);
    if (!(await tieneFunc(req.usuario.id_usuario, ROLES[rol])))
      return fail(res, 'No tienes atribución para firmar el rol ' + rol + '.', 403);

    const [[cas]] = await pool.query('SELECT * FROM castigos_contables WHERE id=? LIMIT 1', [req.params.id]);
    if (!cas) return fail(res, 'Castigo no encontrado', 404);
    if (cas.estado !== 'PENDIENTE') return fail(res, 'El castigo ya está ' + cas.estado.toLowerCase() + '.', 409);

    const [aps] = await pool.query('SELECT * FROM castigos_aprobaciones WHERE id_castigo=?', [req.params.id]);
    if (aps.some(a => a.rol === rol)) return fail(res, 'El rol ' + rol + ' ya firmó este castigo.', 409);
    // Dos firmas de personas DISTINTAS (el GG no puede firmar ambos roles solo).
    if (aps.some(a => a.aprobado_por === req.usuario.id_usuario)) return fail(res, 'Ya firmaste este castigo con otro rol; se requieren dos gerentes distintos.', 409);

    await pool.query(
      'INSERT INTO castigos_aprobaciones (id_castigo, rol, decision, comentario, aprobado_por, aprobado_por_nombre) VALUES (?,?,?,?,?,?)',
      [req.params.id, rol, decision, (comentario || '').slice(0, 600), req.usuario.id_usuario, nombreUsuario(req)]);

    let estadoFinal = 'PENDIENTE';
    if (decision === 'RECHAZADO') {
      await pool.query("UPDATE castigos_contables SET estado='RECHAZADO' WHERE id=?", [req.params.id]);
      estadoFinal = 'RECHAZADO';
    } else {
      const firmas = aps.filter(a => a.decision === 'APROBADO').map(a => a.rol).concat(rol);
      if (firmas.includes('FINANZAS') && firmas.includes('OPERACIONES')) {
        // Ambas firmas → aplicar el castigo (baja de la operación).
        await pool.query("UPDATE creditos SET estado_cartera='CASTIGADO' WHERE id=? OR num_op=?", [cas.id_credito, cas.num_op]);
        await pool.query("UPDATE castigos_contables SET estado='APROBADO', aplicado_at=NOW() WHERE id=?", [req.params.id]);
        estadoFinal = 'APROBADO';
      }
    }
    auditar({ req, accion: 'EDITAR', modulo: 'creditos', entidad: 'castigos_contables', entidad_id: req.params.id, detalle: `Firma ${rol}=${decision} castigo op ${cas.num_op}${estadoFinal === 'APROBADO' ? ' → APLICADO (baja)' : ''}`, meta: { rol, decision } });
    ok(res, { estado: estadoFinal });
  } catch (e) { fail(res, e.message); }
};

/* ── Anular una solicitud pendiente ─────────────────────────────────────────── */
const anular = async (req, res) => {
  try {
    const [[cas]] = await pool.query('SELECT * FROM castigos_contables WHERE id=? LIMIT 1', [req.params.id]);
    if (!cas) return fail(res, 'Castigo no encontrado', 404);
    if (cas.estado !== 'PENDIENTE') return fail(res, 'Solo se puede anular un castigo pendiente.', 409);
    await pool.query("UPDATE castigos_contables SET estado='ANULADO' WHERE id=?", [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'creditos', entidad: 'castigos_contables', entidad_id: req.params.id, detalle: `Anuló solicitud de castigo op ${cas.num_op}` });
    ok(res, { estado: 'ANULADO' });
  } catch (e) { fail(res, e.message); }
};

/* ── Consultas ──────────────────────────────────────────────────────────────── */
// Castigo vigente (pendiente/aprobado) de una operación — alimenta el botón en la ficha.
const porOperacion = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM castigos_contables WHERE num_op=? AND estado IN ('PENDIENTE','APROBADO') ORDER BY id DESC LIMIT 1", [req.params.numop]);
    const [conAp] = await Promise.all([conAprobaciones(rows)]);
    ok(res, conAp[0] || null);
  } catch (e) { fail(res, e.message); }
};

// Historial completo (Tesorería). Filtro opcional por estado/motivo.
const historial = async (req, res) => {
  try {
    const { estado, motivo } = req.query;
    const cond = ['1=1']; const args = [];
    if (estado) { cond.push('c.estado=?'); args.push(estado); }
    if (motivo) { cond.push('c.motivo=?'); args.push(motivo); }
    const [rows] = await pool.query(
      `SELECT c.*, COALESCE(cl.nombre_completo, cl.nombre) AS cliente, cl.rut
         FROM castigos_contables c
         LEFT JOIN creditos cr ON cr.id = c.id_credito
         LEFT JOIN clientes cl ON cl.id_cliente = cr.id_cliente
        WHERE ${cond.join(' AND ')} ORDER BY c.solicitado_at DESC LIMIT 1000`, args);
    ok(res, await conAprobaciones(rows));
  } catch (e) { fail(res, e.message); }
};

/* ── Movimiento contable: Provisiones y Castigos (debe/haber) ───────────────────
   Modelo (mensual):
     Cuenta PROVISIONES (saldo acreedor):
       saldo_inicial  + Haber(constitución del período)  − Debe(uso por castigos)  = saldo_final
       · saldo_final = stock de provisión actual (motor cobranza) para el mes en curso,
         o el snapshot guardado al cierre para meses pasados.
       · Debe (uso por castigos)  = Σ castigos aplicados en el mes (el castigo va contra provisiones).
       · Haber (constitución)     = (saldo_final − saldo_inicial) + castigos_mes  ⇒ = Cargo a Resultado.
     Cuenta CASTIGOS (acumulada): saldo_inicial + Debe(castigos_mes) = saldo_final.
     Cargo a Resultado = constitución de provisión del período (= variación neta + castigo).
   El saldo_inicial sale del snapshot del mes anterior (0 si aún no se ha guardado ninguno).
   ───────────────────────────────────────────────────────────────────────────── */
const CUENTAS = ['PROVISIONES', 'CASTIGOS'];
const mesAnterior = mes => { let [y, m] = mes.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };

async function snapshot(mes, cuenta) {
  const [[r]] = await pool.query('SELECT saldo FROM contab_saldos_mensuales WHERE mes=? AND cuenta=? LIMIT 1', [mes, cuenta]);
  return r ? Number(r.saldo) : null;
}

const ultimoDiaMes = mes => { const [y, m] = mes.split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`; };

const contable = async (req, res) => {
  try {
    const hoyISO = new Date().toISOString().slice(0, 10);
    const mesActual = hoyISO.slice(0, 7);
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesActual;
    const esMesActual = mes === mesActual;
    const mesAnt = mesAnterior(mes);
    const inicioMes = mes + '-01';
    const finMesPasado = ultimoDiaMes(mesAnt);             // cierre del mes pasado
    const corte = esMesActual ? hoyISO : ultimoDiaMes(mes); // "al día de hoy" (mes en curso) o cierre del mes elegido

    // ── CASTIGOS: acumulados por fecha (no requieren snapshot) ──
    // Saldo inicial = todo lo castigado hasta el cierre del mes pasado; período = lo del mes hasta el corte.
    const [[ci]] = await pool.query(
      "SELECT COALESCE(SUM(saldo_castigado),0) s FROM castigos_contables WHERE estado='APROBADO' AND DATE(aplicado_at) < ?", [inicioMes]);
    const [[cm]] = await pool.query(
      "SELECT COALESCE(SUM(saldo_castigado),0) s, COUNT(*) n FROM castigos_contables WHERE estado='APROBADO' AND DATE(aplicado_at) BETWEEN ? AND ?", [inicioMes, corte]);
    const SI_cast = Number(ci.s) || 0;
    const castigos_mes = Number(cm.s) || 0;
    const SF_cast = SI_cast + castigos_mes;

    // ── PROVISIONES: saldo inicial = cierre del mes pasado (snapshot); saldo final = stock de hoy (mes en curso). ──
    let provStock = null;
    try { const REP = require('../../../cobranza/src/controllers/reportes.controller'); provStock = (await REP._datos.datosMoraStock()).total.provision; } catch (_) {}
    const SI_prov = (await snapshot(mesAnt, 'PROVISIONES')) || 0;   // cierre del mes pasado (0 si aún no se ha guardado)
    const snapProvFin = await snapshot(mes, 'PROVISIONES');
    const aprox = !esMesActual && snapProvFin == null;              // mes pasado sin cierre → aproxima con stock actual
    const SF_prov = esMesActual ? (provStock || 0) : (snapProvFin != null ? snapProvFin : (provStock || 0));

    const debe_prov = castigos_mes;                        // el castigo va contra provisiones
    const haber_prov = (SF_prov - SI_prov) + castigos_mes; // constitución del período
    const cargo_resultado = haber_prov;                    // provisión (variación neta) + castigo

    const [rows] = await pool.query(
      `SELECT c.num_op, c.saldo_castigado, c.motivo, c.aplicado_at,
              COALESCE(cl.nombre_completo, cl.nombre) AS cliente
         FROM castigos_contables c
         LEFT JOIN creditos cr ON cr.id=c.id_credito LEFT JOIN clientes cl ON cl.id_cliente=cr.id_cliente
        WHERE c.estado='APROBADO' AND DATE(c.aplicado_at) BETWEEN ? AND ? ORDER BY c.aplicado_at`, [inicioMes, corte]);

    ok(res, {
      mes, aprox, corte, cierre_mes_pasado: finMesPasado, es_mes_actual: esMesActual,
      provisiones: { saldo_inicial: Math.round(SI_prov), debe: Math.round(debe_prov), haber: Math.round(haber_prov), saldo_final: Math.round(SF_prov) },
      castigos:    { saldo_inicial: Math.round(SI_cast), debe: Math.round(castigos_mes), haber: 0, saldo_final: Math.round(SF_cast) },
      cargo_resultado: Math.round(cargo_resultado),
      castigos_mes: Math.round(castigos_mes), n_castigos: cm.n,
      movimientos: rows.map(r => ({ ...r, saldo_castigado: Math.round(Number(r.saldo_castigado) || 0) })),
    });
  } catch (e) { fail(res, e.message); }
};

// Guarda el snapshot de saldos finales del mes (para que el mes siguiente tenga saldo inicial).
const cerrarMesContable = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.body.mes || '') ? req.body.mes : new Date().toISOString().slice(0, 7);
    // Recalcula los saldos finales del mes con la misma lógica del cuadro
    req.query = { mes };
    let payload = null;
    await contable(req, { json: d => { payload = d.data; }, status: () => ({ json: () => {} }) });
    if (!payload) return fail(res, 'No se pudo calcular el cuadro para cerrar.');
    for (const cuenta of CUENTAS) {
      const saldo = cuenta === 'PROVISIONES' ? payload.provisiones.saldo_final : payload.castigos.saldo_final;
      await pool.query(
        `INSERT INTO contab_saldos_mensuales (mes, cuenta, saldo, guardado_por, guardado_por_nombre)
         VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE saldo=VALUES(saldo), guardado_por=VALUES(guardado_por), guardado_por_nombre=VALUES(guardado_por_nombre), guardado_at=NOW()`,
        [mes, cuenta, saldo, req.usuario.id_usuario, nombreUsuario(req)]);
    }
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'tesoreria', entidad: 'contab_saldos_mensuales', detalle: `Cerró saldos contables ${mes} (prov ${payload.provisiones.saldo_final}, castigo ${payload.castigos.saldo_final})` });
    ok(res, { mes, guardado: true, provisiones: payload.provisiones.saldo_final, castigos: payload.castigos.saldo_final });
  } catch (e) { fail(res, e.message); }
};

// Resuelve num_op → id de crédito (para el atajo "CASTIGAR SALDO" en Tesorería).
const resolver = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT id, num_op, origen FROM creditos WHERE num_op=? LIMIT 1', [req.params.numop]);
    if (!c) return fail(res, 'Operación no encontrada', 404);
    ok(res, { id_credito: c.id, num_op: c.num_op, propia: ORIGENES_PROPIA.includes(String(c.origen)) });
  } catch (e) { fail(res, e.message); }
};

function nombreUsuario(req) {
  const u = req.usuario || {};
  return `${u.nombre || ''} ${u.apellido || ''}`.trim() || u.email || ('Usuario ' + u.id_usuario);
}

module.exports = { solicitar, aprobar, anular, porOperacion, historial, resolver, contable, cerrarMesContable };
