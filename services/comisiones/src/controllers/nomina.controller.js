'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   NÓMINA DE COMISIONES — lo que se paga en la liquidación (Pato, 08-09-2026)

   Qué hace: por mes, lista a cada ejecutivo con su monto a pagar (el cálculo del
   motor: incentivo + semana corrida − descuentos ± ajustes), el estado de la
   aprobación del supervisor y la respuesta del ejecutivo (aceptado / enviado a
   revisión, con su comentario). El Analista de Operaciones revisa, corrige lo
   que haga falta (Revisión, Modificar Comisión) y cuando está conforme GENERA
   LA NÓMINA: una FOTO inmutable (comisiones_nomina + _detalle) que se manda por
   correo a Recursos Humanos y que es lo que lee el libro de remuneraciones.

   Regla de oro: generada la nómina, lo que se paga NO se recalcula por cambios
   en los créditos. Solo se regenera ex profeso (botón Regenerar, permiso
   comisiones_nomina_generar), quedando la versión anterior en el historial.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, error, status = 400) => res.status(status).json({ success: false, data: null, error });
const R = v => Math.round(Number(v) || 0);
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const mesLargo = mes => { const [y, m] = String(mes).split('-'); return `${MESES[parseInt(m, 10) - 1]} ${y}`; };
const mesMas = (mes, n) => { let [y, m] = String(mes).split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
const clp = v => '$' + R(v).toLocaleString('es-CL');

require('../../../../shared/migrate').enFila('comisiones-nomina', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS comisiones_nomina (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mes CHAR(7) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    vigente TINYINT(1) NOT NULL DEFAULT 1,
    n_ejecutivos INT NOT NULL DEFAULT 0,
    total_pagar DECIMAL(15,0) NOT NULL DEFAULT 0,
    pendientes_aprobacion INT NOT NULL DEFAULT 0,
    generada_por VARCHAR(160) NULL,
    id_generada_por INT NULL,
    motivo VARCHAR(400) NULL,
    enviada_a VARCHAR(500) NULL,
    enviada_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX (mes, vigente)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS comisiones_nomina_detalle (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_nomina INT NOT NULL,
    ejecutivo VARCHAR(120) NOT NULL,
    rut VARCHAR(20) NULL,
    total_creditos INT NOT NULL DEFAULT 0,
    total_financiado DECIMAL(15,0) NOT NULL DEFAULT 0,
    cumple_minimo TINYINT(1) NOT NULL DEFAULT 0,
    exento_minimo TINYINT(1) NOT NULL DEFAULT 0,
    incentivo_final DECIMAL(15,2) NOT NULL DEFAULT 0,
    factor_semana_corrida DECIMAL(8,4) NULL,
    con_semana_corrida DECIMAL(15,2) NOT NULL DEFAULT 0,
    descuentos DECIMAL(15,2) NOT NULL DEFAULT 0,
    ajustes DECIMAL(15,2) NOT NULL DEFAULT 0,
    monto_pagar DECIMAL(15,0) NOT NULL DEFAULT 0,
    estado_aprobacion VARCHAR(20) NULL,
    notas_aprobacion VARCHAR(500) NULL,
    ejec_estado VARCHAR(20) NULL,
    ejec_comentario VARCHAR(1000) NULL,
    INDEX (id_nomina)
  )`);
  // Card + permiso de acción, todo desde BD (anti-hardcode)
  const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/comisiones/' LIMIT 1").catch(() => [[null]]);
  const idMod = mod ? mod.id_modulo : 150001;
  await pool.query(`INSERT IGNORE INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Nómina de Comisiones', 'comisiones_nomina', '/comisiones/nomina/', 'bi-file-earmark-spreadsheet')`, [idMod]);
  await pool.query(`INSERT IGNORE INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Nómina de Comisiones — generar y enviar a RRHH (Analista de Operaciones)', 'comisiones_nomina_generar', NULL, NULL)`, [idMod]);
  // Aprobar/rechazar comisiones en Revisión: antes solo perfil Administrador (hardcode); ahora permiso paramétrico
  await pool.query(`INSERT IGNORE INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Revisión — aprobar/rechazar comisiones (Operaciones)', 'comisiones_aprobar', NULL, NULL)`, [idMod]);
  const [[fAp]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='comisiones_aprobar' LIMIT 1");
  if (fAp) await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre IN ('Administrador','Analista de Operaciones')`, [fAp.id_funcionalidad]);
  // Destinatario paramétrico (mismo mantenedor del resumen)
  await pool.query(`CREATE TABLE IF NOT EXISTS comisiones_resumen_config (clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(500) NOT NULL DEFAULT '', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query("INSERT IGNORE INTO comisiones_resumen_config (clave, valor) VALUES ('nomina_para', 'recursos.humanos@autofacilchile.cl'), ('nomina_cc', '')");
});

/* Filas "vivas" del mes desde el motor único, resumidas para la nómina */
async function filasVivas(mes) {
  const { calcularMes } = require('./comisiones.controller');
  const datos = await calcularMes(mes);
  const [usrs] = await pool.query("SELECT UPPER(TRIM(CONCAT(COALESCE(nombre,''),' ',COALESCE(apellido,'')))) nom, rut FROM usuarios").catch(() => [[]]);
  const rutDe = {}; usrs.forEach(u => { rutDe[u.nom] = u.rut; });
  return datos.filter(d => !d.renta_fija && !d.externo).map(d => {   // renta FIJA (ficha RRHH) y externos (no usuarios) no van en la nómina
    const cumple = !!d.cumple_minimo;
    const pagar = cumple ? R(d.con_semana_corrida) : 0;
    return {
      ejecutivo: d.ejecutivo, rut: rutDe[String(d.ejecutivo).toUpperCase().trim()] || null,
      total_creditos: d.total_creditos || 0, total_financiado: R(d.total_financiado),
      cumple_minimo: cumple ? 1 : 0, exento_minimo: d.exento_minimo ? 1 : 0,
      incentivo_final: cumple ? Number(d.incentivo_final || 0) : 0,
      factor_semana_corrida: d.factor_semana_corrida || null,
      con_semana_corrida: cumple ? Number(d.con_semana_corrida_bruto || d.con_semana_corrida || 0) : 0,
      descuentos: Number(d.descuento_aplicado || 0), ajustes: Number(d.total_ajustes_op || 0),
      monto_pagar: pagar,
      estado_aprobacion: d.estado || 'pendiente', notas_aprobacion: d.notas || null,
      ejec_estado: d.ejec_estado || 'pendiente', ejec_comentario: d.ejec_comentario || null,
    };
  }).filter(f => f.total_creditos > 0 || f.monto_pagar > 0 || f.descuentos > 0);
}

async function nominaVigente(mes) {
  const [[n]] = await pool.query('SELECT * FROM comisiones_nomina WHERE mes=? AND vigente=1 ORDER BY version DESC LIMIT 1', [mes]);
  if (!n) return null;
  const [det] = await pool.query('SELECT * FROM comisiones_nomina_detalle WHERE id_nomina=? ORDER BY ejecutivo', [n.id]);
  return { ...n, detalle: det };
}

/* GET /api/comisiones/nomina?mes=YYYY-MM */
const getNomina = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    if (!mes) return fail(res, 'Mes inválido (YYYY-MM)');
    const vig = await nominaVigente(mes);
    if (String(req.query.solo || '') === 'vigente') return ok(res, { mes, vigente: vig ? { id: vig.id, version: vig.version, generada_por: vig.generada_por, created_at: vig.created_at, enviada_at: vig.enviada_at } : null });
    const vivas = await filasVivas(mes);
    const [hist] = await pool.query('SELECT id, version, vigente, n_ejecutivos, total_pagar, pendientes_aprobacion, generada_por, motivo, enviada_a, enviada_at, created_at FROM comisiones_nomina WHERE mes=? ORDER BY version DESC', [mes]);
    const [[cfg]] = await pool.query("SELECT (SELECT valor FROM comisiones_resumen_config WHERE clave='nomina_para') para, (SELECT valor FROM comisiones_resumen_config WHERE clave='nomina_cc') cc");
    // Diferencias entre lo congelado y lo que hoy daría el motor (para que el analista decida si regenera)
    let difs = [];
    if (vig) {
      const mapV = {}; vivas.forEach(v => { mapV[v.ejecutivo] = v; });
      difs = vig.detalle.map(d => ({ ejecutivo: d.ejecutivo, nomina: R(d.monto_pagar), motor: R((mapV[d.ejecutivo] || {}).monto_pagar), dif: R((mapV[d.ejecutivo] || {}).monto_pagar) - R(d.monto_pagar) }))
        .concat(vivas.filter(v => !vig.detalle.some(d => d.ejecutivo === v.ejecutivo)).map(v => ({ ejecutivo: v.ejecutivo, nomina: 0, motor: R(v.monto_pagar), dif: R(v.monto_pagar), nuevo: true })))
        .filter(x => x.dif !== 0);
    }
    ok(res, { mes, mes_pago: mesMas(mes, 1), vigente: vig, filas: vig ? vig.detalle : vivas, vivas, diferencias: difs, historial: hist, destinatarios: { para: cfg?.para || '', cc: cfg?.cc || '' } });
  } catch (e) { console.error('[nomina get]', e.message); fail(res, 'Error interno del servidor', 500); }
};

function htmlNomina(mes, n, filas) {
  const tot = filas.reduce((s, f) => s + R(f.monto_pagar), 0);
  const estAp = e => e === 'aprobado' ? '<span style="color:#166534;font-weight:700">Aprobada</span>' : e === 'rechazado' ? '<span style="color:#991b1b;font-weight:700">Rechazada</span>' : '<span style="color:#92400e;font-weight:700">Pendiente</span>';
  const estEj = e => e === 'aceptado' ? '<span style="color:#166534">Aceptó</span>' : e === 'en_revision' ? '<span style="color:#b45309">Enviado a revisión</span>' : '<span style="color:#64748b">Sin respuesta</span>';
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = filas.map((f, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(f.ejecutivo)}<div style="font-size:.72rem;color:#64748b">${esc(f.rut || '')}</div></td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${f.total_creditos}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${clp(f.total_financiado)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${clp(f.incentivo_final)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${clp(f.con_semana_corrida)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#991b1b">${Number(f.descuentos) ? '−' + clp(f.descuentos) : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(f.ajustes) ? (Number(f.ajustes) > 0 ? '+' : '−') + clp(Math.abs(f.ajustes)) : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:800;color:#0141A2">${clp(f.monto_pagar)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${estAp(f.estado_aprobacion)}${f.notas_aprobacion ? `<div style="font-size:.72rem;color:#64748b">${esc(f.notas_aprobacion)}</div>` : ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${estEj(f.ejec_estado)}${f.ejec_comentario ? `<div style="font-size:.72rem;color:#64748b">"${esc(f.ejec_comentario)}"</div>` : ''}</td>
    </tr>`).join('');
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:980px;margin:0 auto;color:#1e293b">
    <div style="background:linear-gradient(135deg,#012d70,#0141A2 50%,#009AFE);border-radius:14px;color:#fff;padding:20px 26px;margin-bottom:16px">
      <div style="font-size:1.15rem;font-weight:800">Nómina de Comisiones — producción ${mesLargo(mes)}</div>
      <div style="font-size:.85rem;opacity:.85">Para cargar en las liquidaciones de sueldo de <b>${mesLargo(mesMas(mes, 1))}</b> por concepto de comisiones · versión ${n.version} · generada por ${esc(n.generada_por)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#eff6ff;color:#0141A2"><th style="padding:8px 10px;text-align:left">Ejecutivo</th><th style="text-align:right">Créditos</th><th style="text-align:right">Financiado</th><th style="text-align:right">Incentivo</th><th style="text-align:right">Con semana corrida</th><th style="text-align:right">Descuentos</th><th style="text-align:right">Ajustes</th><th style="text-align:right">A PAGAR</th><th style="text-align:left">Aprobación</th><th style="text-align:left">Ejecutivo</th></tr></thead>
      <tbody>${rows}<tr style="background:#0f2d6b;color:#fff;font-weight:800"><td style="padding:9px 10px" colspan="7">TOTAL (${filas.length} ejecutivos)</td><td style="padding:9px 10px;text-align:right">${clp(tot)}</td><td colspan="2"></td></tr></tbody>
    </table>
    <div style="font-size:.76rem;color:#64748b;line-height:1.5;margin-top:12px">"A pagar" = incentivo con semana corrida legal, menos descuentos por prepago/anulación, más/menos ajustes aprobados por operación. Es el monto <b>imponible</b> que va en la liquidación como Comisiones. ${n.pendientes_aprobacion ? `<b style="color:#b45309">Ojo: ${n.pendientes_aprobacion} ejecutivo(s) con comisión aún sin aprobación del supervisor.</b>` : 'Todas las comisiones con monto están aprobadas.'}</div>
    <div style="margin-top:16px;padding-top:10px;border-top:1px dashed #cbd5e1;font-size:.76rem;color:#64748b">Emitido por <b>Auto Fácil Business Suite</b> · Comisión Ejecutivos → Nómina de Comisiones. Esta nómina queda congelada: no cambia por modificaciones posteriores en los créditos.</div>
  </div>`;
}

async function enviarNomina(req, mes, n, filas) {
  const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');
  if (!mailConfigurado()) return { enviado: false, error: 'El correo del sistema no está configurado (MAIL_*)' };
  const [rows] = await pool.query("SELECT clave, valor FROM comisiones_resumen_config WHERE clave IN ('nomina_para','nomina_cc')");
  const cfg = {}; rows.forEach(r => { cfg[r.clave] = r.valor; });
  const split = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
  const para = split(cfg.nomina_para), cc = split(cfg.nomina_cc);
  if (!para.length) return { enviado: false, error: 'Sin destinatario configurado (nomina_para)' };
  const tot = filas.reduce((s, f) => s + R(f.monto_pagar), 0);
  const r = await enviarCorreo({ to: para.join(','), cc: cc.length ? cc.join(',') : undefined,
    subject: `Nómina de Comisiones ${mesLargo(mes)} — v${n.version} — total ${clp(tot)} (para liquidaciones de ${mesLargo(mesMas(mes, 1))})`,
    html: htmlNomina(mes, n, filas) });
  if (r && r.ok !== false) {
    await pool.query('UPDATE comisiones_nomina SET enviada_a=?, enviada_at=NOW() WHERE id=?', [[...para, ...cc].join(', ').slice(0, 500), n.id]);
    return { enviado: true, para, cc };
  }
  return { enviado: false, error: (r && r.error) || 'No se pudo enviar' };
}

/* POST /api/comisiones/nomina/generar { mes, motivo? }  — genera (o REGENERA ex profeso) */
const generar = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const mes = /^\d{4}-\d{2}$/.test(b.mes || '') ? b.mes : null;
    if (!mes) return fail(res, 'Mes inválido (YYYY-MM)');
    const previa = await nominaVigente(mes);
    if (previa && !String(b.motivo || '').trim()) return fail(res, `La nómina de ${mesLargo(mes)} ya está generada (v${previa.version}). Para regenerarla indica el motivo: es una decisión ex profeso del Analista de Operaciones.`);
    // Liquidaciones EMITIDAS del mes de pago: ya no hay vuelta
    const [[emit]] = await pool.query("SELECT COUNT(*) c FROM rh_liquidaciones WHERE mes=? AND estado='EMITIDA'", [mesMas(mes, 1)]).catch(() => [[{ c: 0 }]]);
    if (emit && emit.c > 0) return fail(res, `Las liquidaciones de ${mesLargo(mesMas(mes, 1))} ya fueron EMITIDAS: esta nómina no se puede regenerar.`, 423);
    const filas = await filasVivas(mes);
    if (!filas.length) return fail(res, 'No hay ejecutivos con producción ni descuentos en el mes');
    const pend = filas.filter(f => f.monto_pagar > 0 && f.estado_aprobacion !== 'aprobado').length;
    const total = filas.reduce((s, f) => s + R(f.monto_pagar), 0);
    const nombre = `${u.nombre || ''} ${u.apellido || ''}`.trim() || 'Sistema';
    const version = previa ? Number(previa.version) + 1 : 1;
    if (previa) await pool.query('UPDATE comisiones_nomina SET vigente=0 WHERE mes=?', [mes]);
    const [ins] = await pool.query(
      'INSERT INTO comisiones_nomina (mes, version, vigente, n_ejecutivos, total_pagar, pendientes_aprobacion, generada_por, id_generada_por, motivo) VALUES (?,?,1,?,?,?,?,?,?)',
      [mes, version, filas.length, total, pend, nombre, u.id_usuario || null, previa ? String(b.motivo).trim().slice(0, 400) : null]);
    const idN = ins.insertId;
    for (const f of filas) {
      await pool.query(
        `INSERT INTO comisiones_nomina_detalle (id_nomina, ejecutivo, rut, total_creditos, total_financiado, cumple_minimo, exento_minimo, incentivo_final, factor_semana_corrida, con_semana_corrida, descuentos, ajustes, monto_pagar, estado_aprobacion, notas_aprobacion, ejec_estado, ejec_comentario)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [idN, f.ejecutivo, f.rut, f.total_creditos, f.total_financiado, f.cumple_minimo, f.exento_minimo, f.incentivo_final, f.factor_semana_corrida, f.con_semana_corrida, f.descuentos, f.ajustes, f.monto_pagar, f.estado_aprobacion, f.notas_aprobacion, f.ejec_estado, f.ejec_comentario]);
    }
    const n = { id: idN, version, generada_por: nombre, pendientes_aprobacion: pend };
    const envio = await enviarNomina(req, mes, n, filas);
    auditar({ req, accion: previa ? 'EDITAR' : 'CREAR', modulo: 'comisiones', entidad: 'nomina', entidad_id: idN,
      detalle: `Nómina de comisiones ${mes} v${version}${previa ? ' REGENERADA (' + String(b.motivo).trim().slice(0, 200) + ')' : ''}: ${filas.length} ejecutivos, total a pagar ${clp(total)}${pend ? `, ${pend} sin aprobar` : ''}${envio.enviado ? ' — enviada a ' + envio.para.join(', ') : ' — correo NO enviado: ' + envio.error}` });
    ok(res, { id: idN, version, total, n_ejecutivos: filas.length, pendientes_aprobacion: pend, envio });
  } catch (e) { console.error('[nomina generar]', e.message); fail(res, 'Error interno del servidor', 500); }
};

/* POST /api/comisiones/nomina/:id/reenviar — reenvía el correo de la versión vigente */
const reenviar = async (req, res) => {
  try {
    const [[n]] = await pool.query('SELECT * FROM comisiones_nomina WHERE id=?', [req.params.id]);
    if (!n) return fail(res, 'Nómina no encontrada', 404);
    if (!n.vigente) return fail(res, 'Esta versión ya no está vigente');
    const [det] = await pool.query('SELECT * FROM comisiones_nomina_detalle WHERE id_nomina=? ORDER BY ejecutivo', [n.id]);
    const envio = await enviarNomina(req, n.mes, n, det);
    if (!envio.enviado) return fail(res, envio.error);
    auditar({ req, accion: 'ENVIAR', modulo: 'comisiones', entidad: 'nomina', entidad_id: n.id, detalle: `Nómina de comisiones ${n.mes} v${n.version} reenviada a ${envio.para.join(', ')}` });
    ok(res, envio);
  } catch (e) { console.error('[nomina reenviar]', e.message); fail(res, 'Error interno del servidor', 500); }
};

/* PUT /api/comisiones/nomina/destinatarios { para, cc } */
const destinatarios = async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.para === 'string') await pool.query("INSERT INTO comisiones_resumen_config (clave, valor) VALUES ('nomina_para', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [b.para.trim().slice(0, 500)]);
    if (typeof b.cc === 'string') await pool.query("INSERT INTO comisiones_resumen_config (clave, valor) VALUES ('nomina_cc', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [b.cc.trim().slice(0, 500)]);
    auditar({ req, accion: 'EDITAR', modulo: 'comisiones', entidad: 'nomina_config', detalle: `Destinatarios de la nómina de comisiones: ${b.para || ''}${b.cc ? ' (CC ' + b.cc + ')' : ''}` });
    ok(res, { guardado: true });
  } catch (e) { fail(res, 'Error interno del servidor', 500); }
};

/* Motor único para Remuneraciones: monto a pagar por ejecutivo si hay nómina generada */
async function montosNomina(mes) {
  const vig = await nominaVigente(mes).catch(() => null);
  if (!vig) return null;
  const m = {};
  vig.detalle.forEach(d => { m[String(d.ejecutivo).toUpperCase().trim()] = R(d.monto_pagar); });
  return { version: vig.version, generada_por: vig.generada_por, created_at: vig.created_at, montos: m };
}

module.exports = { getNomina, generar, reenviar, destinatarios, montosNomina, nominaVigente };
