'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CUENTA CORRIENTE DE VACACIONES (estilo AVSOFT "Consulta Vacaciones")
   · ABONOS automáticos: 15 días legales al cumplir cada aniversario (período
     desde/hasta) + FERIADO PROGRESIVO (art. 68 CT): con más de 10 años
     trabajados (previos declarados + antigüedad en la empresa), 1 día extra
     por cada 3 nuevos años — depositado por período, como AVSOFT.
   · CARGOS: cada solicitud de vacaciones APROBADA descuenta sus días hábiles.
   · AJUSTES: RRHH cuadra el saldo histórico contra AVSOFT una sola vez.
   Saldo disponible = movimientos + devengo proporcional del período en curso
   (1,25/mes). ESTE es el motor único: lo usan el formulario de vacaciones,
   el módulo Ausencias y el finiquito.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const isoF = f => f == null ? null
  : (f instanceof Date ? new Date(f.getTime() - f.getTimezoneOffset() * 60000).toISOString() : String(f)).slice(0, 10);

require('../../../../shared/migrate').enFila('rrhh-vac-cuenta', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_vac_movimientos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NOT NULL,
    tipo VARCHAR(12) NOT NULL,               -- DEVENGO | PROGRESIVO | TOMADO | AJUSTE
    dias DECIMAL(6,1) NOT NULL,              -- + abono / − cargo
    periodo_desde DATE NULL, periodo_hasta DATE NULL,
    glosa VARCHAR(300) NULL,
    id_ref INT NULL,                         -- id de rh_vacaciones cuando es TOMADO
    creado_por INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_u (id_usuario), INDEX idx_ref (tipo, id_ref)
  )`);
  await pool.query(`ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS anos_trabajados_previos TINYINT NOT NULL DEFAULT 0`).catch(() => {});
  // tipo nuevo de ausencia (causal art. 160 N°3)
  const [[t]] = await pool.query("SELECT valor FROM rh_config WHERE clave='ausencia_tipos'");
  if (t && !t.valor.includes('AUSENCIA INJUSTIFICADA'))
    await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',AUSENCIA INJUSTIFICADA') WHERE clave='ausencia_tipos'");
  // tipo de documento para respaldar los años previos (feriado progresivo)
  const [[dt]] = await pool.query("SELECT valor FROM rh_config WHERE clave='doc_tipos'");
  if (dt && !dt.valor.includes('CERTIFICADO AFP'))
    await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',CERTIFICADO AFP (AÑOS COTIZADOS)') WHERE clave='doc_tipos'");
  console.log('[rrhh-vac-cuenta] listo');
});

/* ── Alegato SEMANAL: años previos declarados SIN certificado AFP ───────────── */
const _w = d => { const t = new Date(d); t.setHours(0,0,0,0); t.setDate(t.getDate()+3-((t.getDay()+6)%7)); const w1 = new Date(t.getFullYear(),0,4); return t.getFullYear()+'-S'+String(1+Math.round(((t-w1)/86400000-3+((w1.getDay()+6)%7))/7)).padStart(2,'0'); };
async function alegarSinCertificadoAFP() {
  try {
    const [pend] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, f.anos_trabajados_previos
         FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario AND u.estado='activo'
        WHERE f.anos_trabajados_previos > 0
          AND NOT EXISTS (SELECT 1 FROM rh_documentos d WHERE d.id_usuario=f.id_usuario AND d.tipo LIKE 'CERTIFICADO AFP%')`);
    if (!pend.length) return;
    const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
    const [rr] = await pool.query(
      `SELECT DISTINCT u.id_usuario FROM usuarios u
        JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
        JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
       WHERE f.codigo='rh_colaboradores' AND u.estado='activo'`);
    const lista = pend.slice(0, 5).map(p => `${p.nombre} (${p.anos_trabajados_previos} años)`).join(', ') + (pend.length > 5 ? '…' : '');
    notificar(rr.map(x => x.id_usuario), {
      tipo: 'RRHH', prioridad: 'alta',
      titulo: `${pend.length} colaborador(es) con años previos SIN certificado AFP`,
      mensaje: `El feriado progresivo declara años trabajados que deben respaldarse con el certificado de cotizaciones de la AFP: ${lista}. Súbelo a la carpeta digital (tipo "CERTIFICADO AFP").`,
      href: '/recursos-humanos/colaboradores/',
      clave: 'afp_cert_pendiente_' + _w(new Date()),
    });
  } catch (e) { console.error('[alegato cert AFP]', e.message); }
}
setTimeout(alegarSinCertificadoAFP, 140 * 1000);
setInterval(alegarSinCertificadoAFP, 24 * 60 * 60 * 1000);

/* ── Generación de devengos: cada aniversario cumplido deposita su período ──── */
function progresivoDelPeriodo(previos, periodoN) {
  // años trabajados al inicio del período = previos + (períodoN − 1) en la empresa
  return Math.max(0, Math.floor(((previos || 0) + (periodoN - 1) - 10) / 3));
}

async function generarDevengos() {
  try {
    const [[cfgV]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
    const anuales = parseFloat(cfgV?.valor) || 15;
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const [users] = await pool.query(
      `SELECT u.id_usuario, DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fi, COALESCE(f.anos_trabajados_previos,0) previos
         FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario
        WHERE u.estado='activo' AND u.fecha_ingreso IS NOT NULL`);
    for (const u of users) {
      const [devs] = await pool.query(
        `SELECT tipo, DATE_FORMAT(periodo_desde,'%Y-%m-%d') pd FROM rh_vac_movimientos WHERE id_usuario=? AND tipo IN ('DEVENGO','PROGRESIVO')`, [u.id_usuario]);
      const tieneDev = new Set(devs.filter(d => d.tipo === 'DEVENGO').map(d => d.pd));
      const tieneProg = new Set(devs.filter(d => d.tipo === 'PROGRESIVO').map(d => d.pd));
      const fi = new Date(u.fi + 'T12:00:00');
      // el período N se DEPOSITA al cumplirse (aniversario N): períodos cuyo fin ya pasó o hoy
      for (let n = 1; n < 60; n++) {
        const pd = new Date(fi); pd.setFullYear(fi.getFullYear() + (n - 1));
        const ph = new Date(fi); ph.setFullYear(fi.getFullYear() + n); ph.setDate(ph.getDate() - 1);
        const finPeriodo = new Date(fi); finPeriodo.setFullYear(fi.getFullYear() + n);   // aniversario N
        if (isoF(finPeriodo) > hoy) break;                        // período aún no cumplido
        const pdIso = isoF(pd);
        if (!tieneDev.has(pdIso))
          await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, periodo_desde, periodo_hasta, glosa)
            VALUES (?,?,?,?,?,?)`, [u.id_usuario, 'DEVENGO', anuales, pdIso, isoF(ph), `Período ${n} (${pdIso} → ${isoF(ph)})`]);
        // el progresivo se backfillea aparte (ej: al cargar los años previos después)
        const prog = progresivoDelPeriodo(u.previos, n);
        if (prog > 0 && !tieneProg.has(pdIso))
          await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, periodo_desde, periodo_hasta, glosa)
            VALUES (?,?,?,?,?,?)`, [u.id_usuario, 'PROGRESIVO', prog, pdIso, isoF(ph), `Feriado progresivo período ${n} (art. 68)`]);
      }
    }
  } catch (e) { console.error('[vac devengos]', e.message); }
}
setTimeout(generarDevengos, 100 * 1000);
setInterval(generarDevengos, 24 * 60 * 60 * 1000);
exports.generarDevengos = generarDevengos;

/* ── MOTOR ÚNICO de saldo: movimientos + proporcional del período en curso ──── */
async function saldoCuenta(idUsuario, aFecha) {
  const fecha = aFecha || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const [[m]] = await pool.query(
    `SELECT COALESCE(SUM(dias),0) s,
            COALESCE(SUM(CASE WHEN dias>0 THEN dias END),0) abonos,
            COALESCE(SUM(CASE WHEN dias<0 THEN -dias END),0) cargos
       FROM rh_vac_movimientos WHERE id_usuario=?`, [idUsuario]);
  // proporcional del período en curso (desde el último aniversario, 30avos → anuales/12 por mes completo)
  const [[u]] = await pool.query(
    `SELECT DATE_FORMAT(u.fecha_ingreso,'%Y-%m-%d') fi, COALESCE(f.anos_trabajados_previos,0) previos
       FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.id_usuario=?`, [idUsuario]);
  let proporcional = 0;
  if (u?.fi) {
    const [[cfgV]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
    const anuales = parseFloat(cfgV?.valor) || 15;
    const fi = new Date(u.fi + 'T12:00:00'), h = new Date(fecha + 'T12:00:00');
    let mesesTot = (h.getFullYear() - fi.getFullYear()) * 12 + (h.getMonth() - fi.getMonth());
    if (h.getDate() < fi.getDate()) mesesTot--;
    mesesTot = Math.max(0, mesesTot);
    const mesesEnCurso = mesesTot % 12;
    const n = Math.floor(mesesTot / 12) + 1;
    const progAnual = progresivoDelPeriodo(u.previos, n);
    proporcional = Math.round(mesesEnCurso * ((anuales + progAnual) / 12) * 10) / 10;
  }
  return {
    saldo_periodos: Number(m.s), abonos: Number(m.abonos), cargos: Number(m.cargos),
    proporcional, disponibles: Math.round((Number(m.s) + proporcional) * 10) / 10,
  };
}
exports.saldoCuenta = saldoCuenta;

/* Cargo automático al aprobar una solicitud (llamado desde resolverVacaciones) */
async function registrarTomado(solicitud) {
  try {
    const [[ya]] = await pool.query(`SELECT id FROM rh_vac_movimientos WHERE tipo='TOMADO' AND id_ref=?`, [solicitud.id]);
    if (ya) return;
    // días hábiles L-V del rango
    let d = new Date(isoF(solicitud.fecha_desde) + 'T12:00:00');
    const h = new Date(isoF(solicitud.fecha_hasta) + 'T12:00:00');
    let habiles = 0;
    for (; d <= h; d.setDate(d.getDate() + 1)) if (d.getDay() >= 1 && d.getDay() <= 5) habiles++;
    await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, glosa, id_ref)
      VALUES (?,?,?,?,?)`, [solicitud.id_usuario, 'TOMADO', -habiles,
      `Vacaciones ${isoF(solicitud.fecha_desde)} al ${isoF(solicitud.fecha_hasta)} (${habiles} hábiles)`, solicitud.id]);
  } catch (e) { console.error('[vac tomado]', e.message); }
}
exports.registrarTomado = registrarTomado;

/* ── Endpoints ──────────────────────────────────────────────────────────────── */
exports.getCuenta = async (req, res) => {
  try {
    const u = req.usuario || {};
    let objetivo = u.id_usuario;
    if (req.query.id_usuario && String(req.query.id_usuario) !== String(u.id_usuario)) objetivo = parseInt(req.query.id_usuario);
    const [movs] = await pool.query(
      `SELECT id, tipo, dias, DATE_FORMAT(periodo_desde,'%Y-%m-%d') periodo_desde, DATE_FORMAT(periodo_hasta,'%Y-%m-%d') periodo_hasta,
              glosa, DATE_FORMAT(created_at,'%Y-%m-%d') fecha FROM rh_vac_movimientos WHERE id_usuario=? ORDER BY COALESCE(periodo_desde, created_at), id`, [objetivo]);
    const saldo = await saldoCuenta(objetivo);

    // Vista cuenta corriente: los CARGOS se consumen FIFO desde el período más
    // antiguo — cada consumo se muestra DEBAJO del período que lo financió.
    const periodos = [];
    for (const m of movs.filter(x => x.dias > 0 && x.periodo_desde)) {
      let p = periodos.find(x => x.desde === m.periodo_desde);
      if (!p) { p = { desde: m.periodo_desde, hasta: m.periodo_hasta, abonos: 0, detalle_abono: [], consumos: [], saldo: 0 }; periodos.push(p); }
      p.abonos += Number(m.dias); p.saldo += Number(m.dias);
      p.detalle_abono.push({ tipo: m.tipo, dias: Number(m.dias) });
    }
    periodos.sort((a, b) => a.desde < b.desde ? -1 : 1);
    const sueltosAbono = movs.filter(x => x.dias > 0 && !x.periodo_desde)
      .map(m => ({ tipo: m.tipo, dias: Number(m.dias), glosa: m.glosa, fecha: m.fecha }));
    const cargos = movs.filter(x => x.dias < 0).map(m => ({ tipo: m.tipo, dias: -Number(m.dias), glosa: m.glosa, fecha: m.fecha }));
    const sinPeriodo = [];
    for (const c of cargos) {
      let resto = c.dias;
      for (const p of periodos) {
        if (resto <= 0) break;
        if (p.saldo <= 0) continue;
        const usa = Math.min(p.saldo, resto);
        p.saldo = Math.round((p.saldo - usa) * 10) / 10;
        resto = Math.round((resto - usa) * 10) / 10;
        p.consumos.push({ tipo: c.tipo, dias: usa, glosa: c.glosa, fecha: c.fecha });
      }
      if (resto > 0) sinPeriodo.push({ ...c, dias: resto });   // sobregiro: cargo sin período que lo cubra
    }
    // Período EN CURSO (aún no cumplido): fechas + días proporcionales a hoy
    let enCurso = null;
    const [[uf]] = await pool.query(`SELECT DATE_FORMAT(fecha_ingreso,'%Y-%m-%d') fi FROM usuarios WHERE id_usuario=?`, [objetivo]);
    if (uf?.fi && saldo.proporcional >= 0) {
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
      const fi = new Date(uf.fi + 'T12:00:00'), h = new Date(hoy + 'T12:00:00');
      let anios = h.getFullYear() - fi.getFullYear();
      const aniv = new Date(fi); aniv.setFullYear(fi.getFullYear() + anios);
      if (aniv > h) anios--;
      const pd = new Date(fi); pd.setFullYear(fi.getFullYear() + anios);
      const ph = new Date(fi); ph.setFullYear(fi.getFullYear() + anios + 1); ph.setDate(ph.getDate() - 1);
      enCurso = { desde: isoF(pd), hasta: isoF(ph), proporcional: saldo.proporcional };
    }
    ok(res, { movimientos: movs, periodos, abonos_sueltos: sueltosAbono, cargos_sin_periodo: sinPeriodo, periodo_en_curso: enCurso, ...saldo });
  } catch (e) { fail(res, e.message); }
};

exports.ajuste = async (req, res) => {
  try {
    const { id_usuario, dias, glosa } = req.body || {};
    const d = parseFloat(dias);
    if (!parseInt(id_usuario) || !d || !String(glosa || '').trim()) return fail(res, 'Faltan colaborador, días (±) o glosa', 400);
    await pool.query(`INSERT INTO rh_vac_movimientos (id_usuario, tipo, dias, glosa, creado_por) VALUES (?,?,?,?,?)`,
      [parseInt(id_usuario), 'AJUSTE', Math.round(d * 10) / 10, String(glosa).slice(0, 300), req.usuario.id_usuario]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'vac_ajuste', entidad_id: parseInt(id_usuario),
      detalle: `Ajuste vacaciones ${d > 0 ? '+' : ''}${d} días: ${glosa}` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};
