'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   LÍNEA DE CRÉDITO UNIDAD (Tesorería) — línea rotativa de una financiera; hoy UCA

   Qué hace: lleva la cuenta corriente de la línea que la financiera abre a
   AutoFácil y genera SOLO el Certificado de Saldo Insoluto que exige la
   cláusula Cuarta del contrato.
     · GIRO: la financiera transfiere fondos con cargo a la línea (se registra
       a mano al llegar la plata) → sube el saldo insoluto.
     · COMPENSACIÓN: cada operación de esa financiera que se otorga deja un saldo
       de precio que la financiera nos debe; en vez de pagarlo, se compensa
       contra el capital de la línea. El motor la detecta, la registra, emite el
       certificado (PDF verificable con QR) y, si está encendido, lo manda por
       correo a la casilla de la financiera (Anexo 3 del contrato).
     · PAGO: devolución en efectivo del capital (prepago o vencimiento).
   La financiera tiene N días hábiles para aceptar u objetar cada certificado;
   la respuesta se marca acá. Recién ACEPTADO el monto vuelve a ser cupo.

   Motores que reusa (Máxima 1): montoSaldoOrden() de Post Venta para el monto
   del saldo de precio, registrarVerificable() para el folio QR, contabilizar()
   para los asientos (LINEA_GIRO / LINEA_COMPENSACION / LINEA_PAGO — Máxima 4),
   plantillas-correo para el correo y datosEmpresa() para los datos de AutoFácil.
   ═══════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { programar, porEvento } = require('../../../../shared/scheduler');
const fc = require('../../../../shared/fecha-chile');
const { ES_ETAPA } = require('../../../../shared/etapa-credito');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, error, code = 500) => res.status(code).json({ success: false, data: null, error });
const norm = s => String(s ?? '').trim();
const HOST = process.env.APP_URL || 'https://afbs.autofacilchile.cl';
const USUARIO_SISTEMA = 'Sistema — Línea de Crédito';
const fmtCLP = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
const fmtD = s => s ? String(s).slice(0, 10).split('-').reverse().join('-') : '—';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const EMAILS = s => String(s || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
const EMAIL_OK = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Compensaciones vivas: las que rebajan el saldo. OBJETADO / SIN_SALDO no.
const COMP_VIVAS = "('EMITIDO','ENVIADO','ACEPTADO')";

/* ── Migración (idempotente, por el capataz) ─────────────────────────────── */
require('../../../../shared/migrate').enFila('linea-credito', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS linea_credito (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        nombre             VARCHAR(80)  NOT NULL,
        financiera         VARCHAR(60)  NOT NULL,
        acreedor_nombre    VARCHAR(150) NOT NULL,
        acreedor_rut       VARCHAR(20)  NULL,
        limite             BIGINT       NOT NULL DEFAULT 0,
        umbral_pct         DECIMAL(5,2) NOT NULL DEFAULT 80,
        dias_respuesta     TINYINT      NOT NULL DEFAULT 2,
        contrato_fecha     DATE         NULL,
        fecha_inicio       DATE         NULL,
        fecha_vencimiento  DATE         NULL,
        correo_para        VARCHAR(300) NULL,
        correo_cc          VARCHAR(300) NULL,
        envio_automatico   TINYINT(1)   NOT NULL DEFAULT 0,
        firmante_nombre    VARCHAR(120) NULL,
        firmante_cargo     VARCHAR(120) NULL,
        activa             TINYINT(1)   NOT NULL DEFAULT 0,
        updated_por        VARCHAR(150) NULL,
        created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_fin (financiera)
      )`);
    /* Movimientos. `ref_unica` = 'COMP-<id_credito>' para la compensación vigente de una operación:
       así dos barridos simultáneos no compensan dos veces la misma OP (gana el INSERT). Al reemitir
       una objetada, la vieja libera la referencia. Giros y pagos la dejan NULL. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS linea_credito_movs (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        id_linea           INT          NOT NULL,
        tipo               VARCHAR(15)  NOT NULL,
        fecha              DATE         NOT NULL,
        monto              BIGINT       NOT NULL DEFAULT 0,
        saldo_precio       BIGINT       NULL,
        exceso             BIGINT       NULL,
        saldo_anterior     BIGINT       NULL,
        saldo_nuevo        BIGINT       NULL,
        id_credito         INT          NULL,
        num_op             VARCHAR(30)  NULL,
        cert_numero        INT          NULL,
        cert_codigo        VARCHAR(40)  NULL,
        estado             VARCHAR(15)  NOT NULL,
        enviado_at         DATETIME     NULL,
        enviado_a          VARCHAR(400) NULL,
        respuesta_at       DATETIME     NULL,
        respuesta_por      VARCHAR(150) NULL,
        motivo             VARCHAR(400) NULL,
        id_cuenta_bancaria INT          NULL,
        glosa              VARCHAR(300) NULL,
        ref_unica          VARCHAR(40)  NULL,
        usuario            VARCHAR(150) NULL,
        created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ref (ref_unica),
        INDEX idx_linea (id_linea, tipo, estado), INDEX idx_cred (id_credito), INDEX idx_op (num_op)
      )`);
    /* Semilla: la línea UCA nace APAGADA y sin fecha de inicio — no hace nada hasta que el
       contrato esté firmado y Tesorería la encienda. Datos del contrato y del Anexo 3 (editables). */
    await pool.query(
      `INSERT IGNORE INTO linea_credito (nombre, financiera, acreedor_nombre, acreedor_rut, limite, umbral_pct, dias_respuesta,
         fecha_vencimiento, correo_para, correo_cc, envio_automatico, firmante_nombre, firmante_cargo, activa)
       VALUES ('Línea UCA', 'UNIDAD DE CREDITO', 'UNIDAD CRÉDITOS S.A.', '76.697.501-1', 100000000, 80, 2,
         '2026-12-14', 'erick.rodriguez@unidadcreditos.cl', 'juan.bustamante@autofacilchile.cl', 0,
         'Juan Manuel Bustamante', 'Gerente de Finanzas', 0)`);
    // Texto del certificado editable (pestaña Parámetros). NULL = el texto por defecto del contrato.
    await pool.query('ALTER TABLE linea_credito ADD COLUMN IF NOT EXISTS cert_texto_intro TEXT NULL');
    await pool.query('ALTER TABLE linea_credito ADD COLUMN IF NOT EXISTS cert_texto_cierre TEXT NULL');
    // Solicitud de reposición del cupo al llegar al umbral (Pato, 01-10-2026): se marca en el ABONO del ciclo.
    await pool.query('ALTER TABLE linea_credito ADD COLUMN IF NOT EXISTS aviso_reposicion_auto TINYINT(1) NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE linea_credito_movs ADD COLUMN IF NOT EXISTS aviso_reposicion_at DATETIME NULL');
    await pool.query('ALTER TABLE linea_credito_movs ADD COLUMN IF NOT EXISTS aviso_reposicion_a VARCHAR(400) NULL');
    // Cada solicitud de reposición enviada queda como fila SOLICITUD en la Cartola (no mueve saldo), con el
    // correo tal como salió, para verlo después (Pato, 01-10-2026).
    await pool.query('ALTER TABLE linea_credito_movs ADD COLUMN IF NOT EXISTS correo_html MEDIUMTEXT NULL');
    /* Documentos firmados del acuerdo (Pato, 01-10-2026). El archivo va al bucket (shared/almacen-docs.js);
       `archivo` solo se llena si el host no tiene bucket. Reemplazar NO borra: la versión anterior queda
       con vigente=0 y quién/cuándo la reemplazó — un contrato firmado nunca se pierde. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS linea_credito_docs (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        id_linea          INT          NOT NULL,
        tipo              VARCHAR(20)  NOT NULL,
        titulo            VARCHAR(150) NULL,
        nombre_archivo    VARCHAR(255) NOT NULL,
        mime              VARCHAR(120) NULL,
        archivo           LONGBLOB     NULL,
        doc_storage       VARCHAR(10)  NOT NULL DEFAULT 'db',
        doc_ruta          VARCHAR(500) NULL,
        doc_bytes         BIGINT       NULL,
        fecha_firma       DATE         NULL,
        nota              VARCHAR(300) NULL,
        vigente           TINYINT(1)   NOT NULL DEFAULT 1,
        reemplazado_at    DATETIME     NULL,
        reemplazado_por   VARCHAR(150) NULL,
        subido_por        VARCHAR(150) NULL,
        created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_linea (id_linea, tipo, vigente)
      )`);

    // Card en Tesorería + permisos (anti-hardcode: módulos y cards salen de la BD)
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      for (const [codigo, nombre, href, icono] of [
        ['linea_credito', 'Línea de Crédito Unidad', '/tesoreria/linea-credito', 'bi-bank'],
        ['linea_credito_gestionar', 'Línea de Crédito: registrar giros, respuestas y configuración', null, 'bi-pencil-square'],
      ]) {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
        let idF = ex && ex.id_funcionalidad;
        if (!idF) {
          const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
            [mod.id_modulo, nombre, codigo, href, icono]);
          idF = r.insertId;
        } else if (codigo === 'linea_credito') {
          // Renombrada a "Línea de Crédito Unidad" (Pato, 01-10-2026)
          await pool.query("UPDATE funcionalidades SET nombre=? WHERE id_funcionalidad=? AND nombre='Línea de Crédito Financiera'", [nombre, idF]);
        }
        // Admin, Tesorero, Analista Financiero, Gerente de Finanzas — el resto por la matriz de Perfiles
        for (const idp of [1, 30001, 90003, 90007])
          await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idF]);
      }
    }
    /* Parche (01-10-2026): la primera semilla del correo pedía "responder este correo", pero el pie
       corporativo dice "no respondas" y la casilla no recibe. Solo si el texto sigue siendo el de fábrica. */
    await pool.query(
      `UPDATE correos_plantillas SET cuerpo = REPLACE(REPLACE(cuerpo,
         'dentro de {DIAS} días hábiles bancarios respondiendo este correo.', 'dentro de {DIAS} días hábiles bancarios, escribiendo a {RESPONDER_A}.'),
         '

Atentamente,
AutoFácil Crédito Automotriz — Finanzas', ''),
         variables = REPLACE(variables, '{DIAS} {LINK}', '{DIAS} {RESPONDER_A} {LINK}')
       WHERE codigo='linea_certificado_saldo' AND cuerpo LIKE '%respondiendo este correo.%'`).catch(() => {});
    // Sin la línea de verificación en el cuerpo (Pato, 01-10-2026): el folio y el QR ya van en el PDF adjunto.
    await pool.query(
      `UPDATE correos_plantillas SET cuerpo = REPLACE(cuerpo, '

Verificación del documento: {LINK}', '')
       WHERE codigo='linea_certificado_saldo' AND cuerpo LIKE '%Verificación del documento: {LINK}%'`).catch(() => {});
    console.log('[linea-credito] módulo listo');
  } catch (e) { console.error('[linea-credito migration]', e.message); }
});

/* ── Saldo de la línea (motor único) ─────────────────────────────────────
   insoluto = giros − pagos − compensaciones vivas (lo que se debe hoy)
   firme    = giros − pagos − compensaciones ACEPTADAS (base del cupo girable) */
async function saldoLinea(idLinea, db = pool) {
  const [[s]] = await db.query(`
    SELECT COALESCE(SUM(CASE WHEN tipo='GIRO' AND estado='REGISTRADO' THEN monto END),0) giros,
           COALESCE(SUM(CASE WHEN tipo='PAGO' AND estado='REGISTRADO' THEN monto END),0) pagos,
           COALESCE(SUM(CASE WHEN tipo='COMPENSACION' AND estado IN ${COMP_VIVAS} THEN monto END),0) comps,
           COALESCE(SUM(CASE WHEN tipo='COMPENSACION' AND estado='ACEPTADO' THEN monto END),0) comps_firmes,
           SUM(tipo='COMPENSACION' AND estado IN ('EMITIDO','ENVIADO')) pendientes
      FROM linea_credito_movs WHERE id_linea=?`, [idLinea]);
  const giros = Number(s.giros), pagos = Number(s.pagos);
  return {
    giros, pagos, comps: Number(s.comps), comps_firmes: Number(s.comps_firmes), pendientes: Number(s.pendientes) || 0,
    insoluto: giros - pagos - Number(s.comps),
    firme: giros - pagos - Number(s.comps_firmes),
  };
}
/* uso_pct = saldo insoluto / monto máximo (lo que muestra el certificado).
   La REPOSICIÓN no se mide con eso: se mide con el CICLO del último abono (ver cicloActual). */
function estadoLinea(l, s, ciclo = null) {
  const limite = Number(l.limite) || 0;
  const uso = limite ? (s.insoluto / limite) * 100 : 0;
  return { ...s, limite, disponible: Math.max(0, limite - s.firme), uso_pct: Math.round(uso * 10) / 10,
    umbral_pct: Number(l.umbral_pct), ciclo,
    puede_girar: !!(ciclo && ciclo.consumo_pct >= Number(l.umbral_pct)) };
}

/* Ciclo de reposición: desde el ÚLTIMO abono (giro) registrado. Saldo inicial = saldo de la línea
   recién hecho ese abono; operaciones = compensaciones vivas posteriores. Consumo = compensado ÷ saldo
   inicial. Al llegar al umbral (80%) se pide a la financiera reponer lo compensado (letra C/ Tres.Uno). */
async function cicloActual(idLinea) {
  const [[g]] = await pool.query(
    "SELECT * FROM linea_credito_movs WHERE id_linea=? AND tipo='GIRO' AND estado='REGISTRADO' ORDER BY id DESC LIMIT 1", [idLinea]);
  if (!g) return null;
  const [ops] = await pool.query(
    `SELECT m.id, m.num_op, m.monto, m.cert_numero, m.estado, DATE_FORMAT(m.fecha,'%Y-%m-%d') fecha,
            c.id_financiera, cl.rut, cl.nombre_completo cliente
       FROM linea_credito_movs m
       LEFT JOIN creditos c ON c.id = m.id_credito
       LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE m.id_linea=? AND m.tipo='COMPENSACION' AND m.id > ? AND m.estado IN ${COMP_VIVAS}
      ORDER BY m.id`, [idLinea, g.id]);
  const inicial = Number(g.saldo_nuevo) || 0;
  let acum = 0;
  const filas = ops.map(o => {
    acum += Number(o.monto);
    return { ...o, monto: Number(o.monto), pct: inicial ? Math.round(Number(o.monto) / inicial * 1000) / 10 : 0,
      pct_acum: inicial ? Math.round(acum / inicial * 1000) / 10 : 0 };
  });
  return { id_giro: g.id, fecha_abono: fc.isoDeBD(g.fecha), monto_abono: Number(g.monto), saldo_inicial: inicial,
    compensado: acum, saldo_actual: inicial - acum, consumo_pct: inicial ? Math.round(acum / inicial * 1000) / 10 : 0,
    aviso_at: g.aviso_reposicion_at || null, aviso_a: g.aviso_reposicion_a || null, operaciones: filas };
}

/* ── Anular el asiento de un movimiento (mes abierto) ──────────────────── */
async function anularAsiento(evento, ref, usuario, motivo) {
  const [[c]] = await pool.query(
    "SELECT id, fecha FROM ctb_comprobantes WHERE origen=? AND origen_ref=? AND estado='CONTABILIZADO' ORDER BY id DESC LIMIT 1", [evento, ref]);
  if (!c) return { anulado: false };
  const mes = fc.isoDeBD(c.fecha).slice(0, 7);
  const [[cerrado]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [mes]);
  if (cerrado) return { anulado: false, mesCerrado: mes, id_comprobante: c.id };
  const [r] = await pool.query("UPDATE ctb_comprobantes SET estado='ANULADO', anulado_por=?, anulado_motivo=? WHERE id=? AND estado='CONTABILIZADO'",
    [usuario, String(motivo || '').slice(0, 400), c.id]);
  return { anulado: !!r.affectedRows };
}

/* ── Texto del certificado (paramétrico) ─────────────────────────────────
   Variables: {ACREEDOR} {RUT_ACREEDOR} {DEUDOR} {RUT_DEUDOR} {FECHA_CONTRATO} {DIAS} */
const TEXTO_INTRO_DEF = 'Señores {ACREEDOR}, RUT {RUT_ACREEDOR}: en cumplimiento de la cláusula Cuarta del Contrato de Apertura de Línea de Crédito suscrito con {DEUDOR} (RUT {RUT_DEUDOR}) con fecha {FECHA_CONTRATO}, certificamos el saldo de capital insoluto de la línea una vez aplicada la Compensación del Saldo de Precio de la operación que se indica.';
const TEXTO_CIERRE_DEF = 'Conforme a la letra d/ del numeral Cuatro.Dos del Contrato, {ACREEDOR} dispone de {DIAS} días hábiles bancarios para manifestar su conformidad o disconformidad con este certificado. Aceptado, la Compensación queda firme y el monto compensado queda disponible como cupo de la línea.';
const VARIABLES_TEXTO = ['{ACREEDOR}', '{RUT_ACREEDOR}', '{DEUDOR}', '{RUT_DEUDOR}', '{FECHA_CONTRATO}', '{DIAS}'];
const renderTexto = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] != null && v[k] !== '' ? String(v[k]) : m === '{FECHA_CONTRATO}' ? '—' : m));

/* ── Snapshot del certificado (lo que se congela en el folio verificable) ── */
async function datosCertificado(l, m) {
  const E = await require('../../../../shared/empresa').datosEmpresa();
  const [[op]] = await pool.query(
    `SELECT c.num_op, c.id_financiera, DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado, cl.rut, cl.nombre_completo cliente
       FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente WHERE c.id=?`, [m.id_credito]);
  const limite = Number(l.limite) || 0;
  const saldoNuevo = Number(m.saldo_nuevo) || 0;
  const vars = { ACREEDOR: l.acreedor_nombre, RUT_ACREEDOR: l.acreedor_rut || '—', DEUDOR: E.razon_social, RUT_DEUDOR: E.rut_formateado || E.rut,
    FECHA_CONTRATO: fmtD(fc.isoDeBD(l.contrato_fecha)), DIAS: Number(l.dias_respuesta) || 2 };
  return {
    // Los textos se congelan ya resueltos: cambiar el parámetro no altera certificados emitidos.
    texto_intro: renderTexto(l.cert_texto_intro || TEXTO_INTRO_DEF, vars),
    texto_cierre: renderTexto(l.cert_texto_cierre || TEXTO_CIERRE_DEF, vars),
    numero: m.cert_numero, numero_txt: `CSI-${String(m.cert_numero).padStart(4, '0')}`,
    fecha_emision: fc.isoDeBD(m.created_at) || fc.hoyISO(),
    acreedor: { razon_social: l.acreedor_nombre, rut: l.acreedor_rut },
    deudor: { razon_social: E.razon_social, rut: E.rut_formateado || E.rut },
    linea: { nombre: l.nombre, limite, contrato_fecha: fc.isoDeBD(l.contrato_fecha), vencimiento: fc.isoDeBD(l.fecha_vencimiento),
      disponible: Math.max(0, limite - saldoNuevo), uso_pct: limite ? Math.round(saldoNuevo / limite * 1000) / 10 : 0 },
    operacion: { num_op: m.num_op, id_financiera: op && op.id_financiera || null, cliente: op && op.cliente || '—', rut: op && op.rut || '—',
      fecha_otorgado: op && op.fecha_otorgado || fc.isoDeBD(m.fecha) },
    saldo_anterior: Number(m.saldo_anterior), saldo_precio: Number(m.saldo_precio), compensado: Number(m.monto),
    exceso: Number(m.exceso) || 0, saldo_nuevo: saldoNuevo,
    dias_respuesta: Number(l.dias_respuesta) || 2, firmante_nombre: l.firmante_nombre, firmante_cargo: l.firmante_cargo,
  };
}

async function pdfDeMovimiento(idMov) {
  const { getVerificable } = require('../../../../shared/verificacion');
  const [[m]] = await pool.query('SELECT * FROM linea_credito_movs WHERE id=?', [idMov]);
  if (!m || !m.cert_codigo) return null;
  const v = await getVerificable(m.cert_codigo);
  if (!v || !v.datos) return null;
  const { generarCertificadoSaldoLineaPDF } = require('../../../../shared/certificado-saldo-linea-pdf');
  const buf = await generarCertificadoSaldoLineaPDF({ d: v.datos, codigo: m.cert_codigo, host: HOST });
  return { buf, nombre: `${v.datos.numero_txt}_OP${m.num_op}.pdf`, datos: v.datos, mov: m };
}

/* ── Envío a la casilla de la financiera (plantilla paramétrica) ────────── */
// Variables del correo (las mismas para el envío real y la vista previa).
const datosCorreo = (l, d, codigo) => ({
  ACREEDOR: l.acreedor_nombre, CERTIFICADO: d.numero_txt, OP: d.operacion.num_op, OP_FINANCIERA: d.operacion.id_financiera || '—',
  CLIENTE: d.operacion.cliente, SALDO_ANTERIOR: fmtCLP(d.saldo_anterior), SALDO_PRECIO: fmtCLP(d.saldo_precio),
  COMPENSADO: fmtCLP(d.compensado), EXCESO: fmtCLP(d.exceso), SALDO_NUEVO: fmtCLP(d.saldo_nuevo),
  DISPONIBLE: fmtCLP(d.linea.disponible), USO: `${d.linea.uso_pct.toLocaleString('es-CL')}%`, DIAS: d.dias_respuesta,
  LINK: `${HOST}/verificar/${codigo}`,
  // El correo sale desde una casilla que no recibe respuestas: la conformidad va a la copia de AutoFácil.
  RESPONDER_A: EMAILS(l.correo_cc).join(', ') || 'nuestro equipo de Finanzas',
});

/* Solicitud de reposición: variables de la plantilla + tabla de operaciones (HTML fijo, va después del cuerpo). */
const rutPuntos = r => { const m = String(r || '').replace(/\./g, '').match(/^(\d+)-?([\dkK])$/); return m ? m[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + m[2].toUpperCase() : (r || '—'); };
const escH = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pctTxt = n => `${(Number(n) || 0).toLocaleString('es-CL', { maximumFractionDigits: 1 })}%`;
const ANCHO_REPOSICION = 760;   // la tabla de 6 columnas no cabe en los 540 px del marco corporativo
function correoReposicion(l, ci) {
  const datos = {
    ACREEDOR: l.acreedor_nombre, FECHA_ABONO: fmtD(ci.fecha_abono), SALDO_INICIAL: fmtCLP(ci.saldo_inicial),
    N_OPERACIONES: ci.operaciones.length, TOTAL_COMPENSADO: fmtCLP(ci.compensado), USO: pctTxt(ci.consumo_pct),
    SALDO_ACTUAL: fmtCLP(ci.saldo_actual), MONTO_REPOSICION: fmtCLP(ci.compensado),
    RESPONDER_A: EMAILS(l.correo_cc).join(', ') || 'nuestro equipo de Finanzas',
  };
  const th = 'style="text-align:left;padding:6px 8px;background:#f1f5f9;color:#475569;font-size:11px;text-transform:uppercase;border-bottom:1px solid #e2e8f0"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px"';
  const tdr = 'style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;white-space:nowrap"';
  const tdn = 'style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:right;white-space:nowrap"';
  const filas = ci.operaciones.map(o => `<tr><td ${td}>${escH(o.id_financiera || '—')}</td><td ${tdr}>${escH(rutPuntos(o.rut))}</td><td ${td}>${escH(o.cliente || '—')}</td>` +
    `<td ${tdn}>${fmtCLP(o.monto)}</td><td ${tdn}>${pctTxt(o.pct)}</td><td ${tdn}>${pctTxt(o.pct_acum)}</td></tr>`).join('');
  const tabla = `<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;margin-top:4px">` +
    `<tr><td colspan="6" style="padding:6px 8px;font-size:12px;background:#eff6ff;color:#1e3a8a"><b>Saldo inicial ${fmtD(ci.fecha_abono)}: ${fmtCLP(ci.saldo_inicial)}</b></td></tr>` +
    `<tr><th ${th}>ID UCA</th><th ${th}>RUT cliente</th><th ${th}>Cliente</th><th ${th} align="right">Monto</th><th ${th} align="right">% saldo</th><th ${th} align="right">% acum.</th></tr>` +
    (filas || `<tr><td colspan="6" ${td}>Sin operaciones compensadas desde el abono.</td></tr>`) +
    `<tr><td colspan="3" style="padding:7px 8px;font-size:12px;font-weight:bold;border-top:2px solid #cbd5e1">Total compensado</td>` +
    `<td style="padding:7px 8px;font-size:12px;font-weight:bold;text-align:right;border-top:2px solid #cbd5e1">${fmtCLP(ci.compensado)}</td>` +
    `<td colspan="2" style="padding:7px 8px;font-size:12px;font-weight:bold;text-align:right;border-top:2px solid #cbd5e1">${pctTxt(ci.consumo_pct)}</td></tr>` +
    `<tr><td colspan="3" style="padding:7px 8px;font-size:12px">Saldo actual</td><td colspan="3" style="padding:7px 8px;font-size:12px;text-align:right">${fmtCLP(ci.saldo_actual)}</td></tr></table>`;
  return { datos, tabla };
}

/* El correo de reposición tal como se ve (mismo render que plantillas-correo.enviar). Para la vista previa
   y para la copia que queda en la Cartola; el logo va por URL porque en pantalla no hay adjunto cid:. */
async function htmlReposicion(l, ci) {
  const plant = require('../../../../shared/plantillas-correo');
  const t = await plant.obtener('linea_reposicion_cupo');
  if (!t) return null;
  const { datos, tabla } = correoReposicion(l, ci);
  const { envolverHTML } = require('../../../../shared/mailer');
  return { t, asunto: plant.render(t.asunto, datos),
    html: envolverHTML(plant.aHTML(plant.render(t.cuerpo, datos)) + `<div style="margin:18px 0">${tabla}</div>`, ANCHO_REPOSICION)
      .replace(/cid:aflogobs/g, '/img/logo-bs-mail.png') };
}

async function enviarReposicion(l, quien) {
  const ci = await cicloActual(l.id);
  if (!ci) return { enviado: false, motivo: 'No hay un abono registrado: no hay ciclo que reponer' };
  if (!ci.operaciones.length) return { enviado: false, motivo: 'No hay operaciones compensadas desde el último abono' };
  const para = EMAILS(l.correo_para);
  if (!para.length) return { enviado: false, motivo: 'La línea no tiene casilla de destino configurada' };
  const { datos, tabla } = correoReposicion(l, ci);
  const plant = require('../../../../shared/plantillas-correo');
  const env = await plant.enviar({ codigo: 'linea_reposicion_cupo', to: para, cc: EMAILS(l.correo_cc), datos, htmlExtra: tabla, ancho: ANCHO_REPOSICION });
  if (!env.enviado) return { enviado: false, motivo: env.motivo };
  const dest = [...env.to, ...(env.cc || [])].join(', ').slice(0, 400);
  await pool.query('UPDATE linea_credito_movs SET aviso_reposicion_at=NOW(), aviso_reposicion_a=? WHERE id=?', [dest, ci.id_giro]);
  // Fila SOLICITUD en la Cartola: monto = lo pedido (informativo, no mueve el saldo) + copia del correo.
  const copia = await htmlReposicion(l, ci).catch(() => null);
  await pool.query(
    `INSERT INTO linea_credito_movs (id_linea, tipo, fecha, monto, saldo_anterior, saldo_nuevo, estado, enviado_at, enviado_a, glosa, correo_html, usuario)
     VALUES (?, 'SOLICITUD', ?, ?, ?, ?, 'ENVIADO', NOW(), ?, ?, ?, ?)`,
    [l.id, fc.hoyISO(), ci.compensado, ci.saldo_actual, ci.saldo_actual, dest,
     `${ci.operaciones.length} operaciones · ${pctTxt(ci.consumo_pct)} del abono del ${fmtD(ci.fecha_abono)} (${fmtCLP(ci.saldo_inicial)})`.slice(0, 300),
     copia && copia.html, quien || USUARIO_SISTEMA]).catch(e => console.error('[linea-credito solicitud→cartola]', e.message));
  auditar({ accion: 'ENVIAR', modulo: 'linea-credito', entidad: 'solicitud_reposicion', entidad_id: String(ci.id_giro),
    detalle: `Solicitud de reposición (${pctTxt(ci.consumo_pct)} del abono del ${fmtD(ci.fecha_abono)}; ${ci.operaciones.length} OP por ${fmtCLP(ci.compensado)}) a ${env.to.join(', ')} por ${quien || USUARIO_SISTEMA}` });
  return { enviado: true, to: env.to, cc: env.cc, ciclo: ci };
}

/* Automático: tras cada compensación, si el ciclo llegó al umbral y aún no se pidió. La marca se toma
   ANTES de enviar (UPDATE atómico): dos corridas a la vez no mandan dos correos; si el envío falla, se devuelve. */
async function revisarReposicion(l) {
  if (!l.aviso_reposicion_auto) return;
  const ci = await cicloActual(l.id);
  if (!ci || ci.aviso_at || !ci.operaciones.length || ci.consumo_pct < Number(l.umbral_pct)) return;
  const [cl] = await pool.query("UPDATE linea_credito_movs SET aviso_reposicion_at=NOW(), aviso_reposicion_a='(enviando)' WHERE id=? AND aviso_reposicion_at IS NULL", [ci.id_giro]);
  if (!cl.affectedRows) return;
  const env = await enviarReposicion(l).catch(e => ({ enviado: false, motivo: e.message }));
  if (!env.enviado) {
    await pool.query('UPDATE linea_credito_movs SET aviso_reposicion_at=NULL, aviso_reposicion_a=NULL WHERE id=?', [ci.id_giro]).catch(() => {});
    console.warn('[linea-credito] solicitud de reposición no enviada:', env.motivo);
  }
}

async function enviarCertificado(idMov, quien) {
  const [[m]] = await pool.query('SELECT * FROM linea_credito_movs WHERE id=? AND tipo=\'COMPENSACION\'', [idMov]);
  if (!m) return { enviado: false, motivo: 'Movimiento no encontrado' };
  if (!['EMITIDO', 'ENVIADO'].includes(m.estado)) return { enviado: false, motivo: `El certificado está ${m.estado}` };
  const [[l]] = await pool.query('SELECT * FROM linea_credito WHERE id=?', [m.id_linea]);
  const para = EMAILS(l && l.correo_para);
  if (!para.length) return { enviado: false, motivo: 'La línea no tiene casilla de destino configurada' };
  const pdf = await pdfDeMovimiento(idMov);
  if (!pdf) return { enviado: false, motivo: 'No se pudo armar el PDF del certificado' };
  const d = pdf.datos;
  const plant = require('../../../../shared/plantillas-correo');
  const env = await plant.enviar({
    codigo: 'linea_certificado_saldo', to: para, cc: EMAILS(l.correo_cc),
    datos: datosCorreo(l, d, m.cert_codigo),
    adjuntos: [{ filename: pdf.nombre, content: pdf.buf, contentType: 'application/pdf' }],
  });
  if (!env.enviado) return { enviado: false, motivo: env.motivo };
  await pool.query("UPDATE linea_credito_movs SET estado='ENVIADO', enviado_at=NOW(), enviado_a=? WHERE id=? AND estado IN ('EMITIDO','ENVIADO')",
    [[...env.to, ...(env.cc || [])].join(', ').slice(0, 400), idMov]);
  auditar({ accion: 'ENVIAR', modulo: 'linea-credito', entidad: 'certificado_saldo', entidad_id: String(idMov),
    detalle: `${d.numero_txt} (OP ${d.operacion.num_op}) enviado a ${env.to.join(', ')} por ${quien || USUARIO_SISTEMA}` });
  return { enviado: true, to: env.to, cc: env.cc };
}

/* ── El motor: compensa cada OP otorgada de la financiera y emite el certificado ──
   Solo con la línea ACTIVA y con fecha de inicio: toma las OP de esa financiera otorgadas desde esa
   fecha, con saldo de precio y sin compensación vigente, en orden de otorgamiento. Con saldo insoluto en
   cero la OP queda SIN_SALDO (la financiera paga ese saldo en efectivo) y no se vuelve a mirar. */
async function compensarUna(l, c, fijos) {
  const { montoSaldoOrden } = require('../../../postventa/src/controllers/postventa.controller');
  const saldoPrecio = Math.round(montoSaldoOrden(c.financiera, c.saldo_precio, fijos, false));
  if (!(saldoPrecio > 0)) return null;
  const conn = await pool.getConnection();
  let mov;
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM linea_credito WHERE id=? FOR UPDATE', [l.id]);   // serializa el cálculo del saldo
    const s = await saldoLinea(l.id, conn);
    const comp = Math.max(0, Math.min(saldoPrecio, s.insoluto));
    const [[n]] = await conn.query("SELECT COALESCE(MAX(cert_numero),0)+1 sig FROM linea_credito_movs WHERE id_linea=?", [l.id]);
    const fecha = fc.isoDeBD(c.fecha_otorgado) || fc.hoyISO();
    const [r] = await conn.query(
      `INSERT IGNORE INTO linea_credito_movs (id_linea, tipo, fecha, monto, saldo_precio, exceso, saldo_anterior, saldo_nuevo,
         id_credito, num_op, cert_numero, estado, ref_unica, usuario)
       VALUES (?, 'COMPENSACION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.id, fecha, comp, saldoPrecio, saldoPrecio - comp, s.insoluto, s.insoluto - comp, c.id, c.num_op,
       comp > 0 ? n.sig : null, comp > 0 ? 'EMITIDO' : 'SIN_SALDO', `COMP-${c.id}`, USUARIO_SISTEMA]);
    await conn.commit();
    if (!r.affectedRows) return null;                                       // otro barrido ya la tomó
    [[mov]] = await pool.query('SELECT * FROM linea_credito_movs WHERE id=?', [r.insertId]);
  } catch (e) { await conn.rollback().catch(() => {}); throw e; }
  finally { conn.release(); }
  if (mov.estado === 'SIN_SALDO') return mov;

  // Folio verificable (snapshot inmutable) + asiento + envío
  const datos = await datosCertificado(l, mov);
  const { registrarVerificable } = require('../../../../shared/verificacion');
  const codigo = await registrarVerificable({ tipo: 'CERT_SALDO_LINEA', ref_tabla: 'linea_credito_movs', ref_id: mov.id,
    num_op: mov.num_op, rut: datos.operacion.rut, nombre: datos.operacion.cliente, datos, emitido_por: USUARIO_SISTEMA,
    firmante: { nombre: l.firmante_nombre, cargo: l.firmante_cargo } });
  await pool.query('UPDATE linea_credito_movs SET cert_codigo=? WHERE id=?', [codigo, mov.id]);
  // Se asienta el día de la emisión (no el del otorgamiento): un otorgado que se detecta tarde no
  // puede caer en un mes ya cerrado y perder su asiento.
  await require('../../../contabilidad/src/motor-asientos').contabilizar({
    evento: 'LINEA_COMPENSACION', fecha: fc.hoyISO(),
    glosa: `Compensación saldo precio OP ${mov.num_op} contra ${l.nombre} — ${datos.numero_txt}`.slice(0, 300),
    ref: `LCOMP-${mov.id}`, montos: { monto: Number(mov.monto) }, num_op: mov.num_op, detalle: `${datos.numero_txt} · ${l.acreedor_nombre}` });
  auditar({ accion: 'CREAR', modulo: 'linea-credito', entidad: 'certificado_saldo', entidad_id: String(mov.id),
    detalle: `${datos.numero_txt}: OP ${mov.num_op} compensa ${fmtCLP(mov.monto)} (saldo de precio ${fmtCLP(mov.saldo_precio)}); saldo insoluto ${fmtCLP(mov.saldo_anterior)} → ${fmtCLP(mov.saldo_nuevo)}` });
  if (l.envio_automatico) {
    const env = await enviarCertificado(mov.id);
    if (!env.enviado) console.warn(`[linea-credito] ${datos.numero_txt} no se envió:`, env.motivo);
  }
  await revisarReposicion(l).catch(e => console.error('[linea-credito reposición]', e.message));
  return mov;
}

async function procesarLineas() {
  const [lineas] = await pool.query('SELECT * FROM linea_credito WHERE activa=1 AND fecha_inicio IS NOT NULL');
  let n = 0;
  for (const l of lineas) {
    const [ops] = await pool.query(
      `SELECT c.id, c.num_op, c.financiera, c.saldo_precio, c.fecha_otorgado
         FROM creditos c
        WHERE UPPER(c.financiera) = UPPER(?) AND ${ES_ETAPA('OTORGADO', 'c')}
          AND c.fecha_otorgado >= ? AND c.saldo_precio > 0
          AND NOT EXISTS (SELECT 1 FROM linea_credito_movs m WHERE m.ref_unica = CONCAT('COMP-', c.id))
        ORDER BY c.fecha_otorgado, c.id LIMIT 200`, [l.financiera, fc.isoDeBD(l.fecha_inicio)]);
    if (!ops.length) continue;
    const { getFijosAutoFin } = require('../../../postventa/src/controllers/postventa.controller');
    const fijos = await getFijosAutoFin();
    for (const c of ops) {
      try { if (await compensarUna(l, c, fijos)) n++; }
      catch (e) { console.error(`[linea-credito] OP ${c.num_op}:`, e.message); }
    }
  }
  if (n) console.log(`[linea-credito] ${n} operación(es) procesada(s)`);
  return n;
}
/* Gatillo + red de seguridad (Pato, 01-10-2026): otorgar una carta, la carga masiva de cartas y la
   edición del crédito a OTORGADO llaman a procesarTrasEvento() y el certificado sale segundos después.
   No hay un único punto donde una OP pasa a OTORGADO (~8 caminos de escritura), así que el reloj de
   1 hora barre lo que haya entrado por un camino sin gatillo. Nunca duplica: ref_unica por OP. */
programar('linea-credito', procesarLineas, 60 * 60 * 1000, { arranqueMs: 2 * 60 * 1000 });
let _eventoPend = null;
function procesarTrasEvento() {
  if (!porEvento('linea-credito')) return;   // MOTORES=off (host en espera) o staging: igual que el reloj
  if (_eventoPend) return;                    // ráfaga (carga masiva): una sola corrida
  _eventoPend = setTimeout(() => {
    _eventoPend = null;
    procesarLineas().catch(e => console.error('[linea-credito evento]', e.message));
  }, 1500);
}

/* Post Venta → FONDOS RECIBIDOS: la parte compensada no entra al banco (ya la asentó la compensación). */
async function compensadoDeOp(numOp) {
  if (!numOp) return 0;
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(monto),0) n FROM linea_credito_movs WHERE tipo='COMPENSACION' AND num_op=? AND estado IN ${COMP_VIVAS}`, [String(numOp)]);
  return Number(r.n) || 0;
}

/* ── API ─────────────────────────────────────────────────────────────────── */
const quien = req => { const u = req.usuario || {}; return [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || 'usuario'; };

exports.resumen = async (req, res) => {
  try {
    const [lineas] = await pool.query('SELECT * FROM linea_credito ORDER BY id');
    const out = [];
    for (const l of lineas) {
      const s = estadoLinea(l, await saldoLinea(l.id), await cicloActual(l.id));
      const [[venc]] = await pool.query(
        `SELECT COUNT(*) n FROM linea_credito_movs WHERE id_linea=? AND tipo='COMPENSACION' AND estado IN ('EMITIDO','ENVIADO')
            AND created_at < NOW() - INTERVAL ? DAY`, [l.id, Number(l.dias_respuesta) || 2]);
      out.push({ ...l, contrato_fecha: fc.isoDeBD(l.contrato_fecha), fecha_inicio: fc.isoDeBD(l.fecha_inicio),
        fecha_vencimiento: fc.isoDeBD(l.fecha_vencimiento), estado: s, sin_respuesta: Number(venc.n) || 0,
        texto_intro_def: TEXTO_INTRO_DEF, texto_cierre_def: TEXTO_CIERRE_DEF, variables_texto: VARIABLES_TEXTO });
    }
    ok(res, out);
  } catch (e) { fail(res, e.message); }
};

exports.movimientos = async (req, res) => {
  try {
    const id = parseInt(req.params.id); if (!id) return fail(res, 'Línea inválida', 400);
    const tipo = norm(req.query.tipo).toUpperCase();
    if (tipo && !['GIRO', 'COMPENSACION', 'PAGO'].includes(tipo)) return fail(res, 'Tipo inválido', 400);
    const [rows] = await pool.query(
      `SELECT m.*, DATE_FORMAT(m.fecha,'%Y-%m-%d') fecha, cl.nombre_completo cliente, cb.nombre cuenta_nombre
         FROM linea_credito_movs m
         LEFT JOIN creditos c ON c.id = m.id_credito
         LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
         LEFT JOIN cuentas_bancarias cb ON cb.id_cuenta = m.id_cuenta_bancaria
        WHERE m.id_linea=? ${tipo ? 'AND m.tipo=?' : ''}
        ORDER BY m.id DESC LIMIT 500`, tipo ? [id, tipo] : [id]);
    for (const r of rows) { r.tiene_correo = !!r.correo_html; delete r.correo_html; }   // el correo se pide aparte
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.guardarConfig = async (req, res) => {
  try {
    const id = parseInt(req.params.id); const b = req.body || {};
    const limite = Math.round(Number(b.limite));
    if (!(limite > 0)) return fail(res, 'El monto máximo de la línea debe ser mayor a 0', 400);
    const umbral = Number(b.umbral_pct);
    if (!(umbral > 0 && umbral <= 100)) return fail(res, 'El umbral de reposición debe estar entre 1 y 100%', 400);
    const dias = parseInt(b.dias_respuesta);
    if (!(dias >= 1 && dias <= 30)) return fail(res, 'El plazo de respuesta debe estar entre 1 y 30 días hábiles', 400);
    for (const k of ['contrato_fecha', 'fecha_inicio', 'fecha_vencimiento'])
      if (b[k] && !ISO.test(String(b[k]))) return fail(res, `Fecha inválida: ${k}`, 400);
    const para = EMAILS(b.correo_para), cc = EMAILS(b.correo_cc);
    if ([...para, ...cc].some(e => !EMAIL_OK(e))) return fail(res, 'Hay un correo con formato inválido', 400);
    const activa = b.activa ? 1 : 0, auto = b.envio_automatico ? 1 : 0, autoRep = b.aviso_reposicion_auto ? 1 : 0;
    if (activa && !b.fecha_inicio) return fail(res, 'Para activar la línea indica la fecha de inicio (desde qué otorgamiento se compensa)', 400);
    if (auto && !para.length) return fail(res, 'Para el envío automático indica la casilla de la financiera', 400);
    if (!norm(b.acreedor_nombre)) return fail(res, 'La razón social del acreedor es obligatoria', 400);
    // Texto igual al por defecto (o vacío) se guarda NULL: sigue al default si este cambia.
    const txtIntro = norm(b.cert_texto_intro), txtCierre = norm(b.cert_texto_cierre);
    if (txtIntro.length > 2000 || txtCierre.length > 2000) return fail(res, 'Cada texto del certificado admite hasta 2.000 caracteres', 400);
    const [r] = await pool.query(
      `UPDATE linea_credito SET nombre=?, acreedor_nombre=?, acreedor_rut=?, limite=?, umbral_pct=?, dias_respuesta=?, contrato_fecha=?,
         fecha_inicio=?, fecha_vencimiento=?, correo_para=?, correo_cc=?, envio_automatico=?, firmante_nombre=?, firmante_cargo=?, activa=?, updated_por=?,
         cert_texto_intro=?, cert_texto_cierre=?, aviso_reposicion_auto=?
       WHERE id=?`,
      [norm(b.nombre) || 'Línea', norm(b.acreedor_nombre), norm(b.acreedor_rut) || null, limite, umbral, dias, b.contrato_fecha || null,
       b.fecha_inicio || null, b.fecha_vencimiento || null, para.join(', ') || null, cc.join(', ') || null, auto,
       norm(b.firmante_nombre) || null, norm(b.firmante_cargo) || null, activa, quien(req),
       (txtIntro && txtIntro !== TEXTO_INTRO_DEF) ? txtIntro : null, (txtCierre && txtCierre !== TEXTO_CIERRE_DEF) ? txtCierre : null, autoRep, id]);
    if (!r.affectedRows) return fail(res, 'Línea no encontrada', 404);
    auditar({ req, accion: 'EDITAR', modulo: 'linea-credito', entidad: 'linea_credito', entidad_id: String(id),
      detalle: `Configuración: límite ${fmtCLP(limite)}, umbral ${umbral}%, ${dias} días, inicio ${b.fecha_inicio || '—'}, vence ${b.fecha_vencimiento || '—'}, ${activa ? 'ACTIVA' : 'apagada'}, envío ${auto ? 'automático' : 'manual'} a ${para.join(', ') || '—'}` });
    ok(res, { id });
    if (activa) procesarTrasEvento();
  } catch (e) { fail(res, e.message); }
};

/* GIRO / PAGO en efectivo: se registran cuando el dinero se mueve en el banco. */
async function registrarMov(req, res, tipo) {
  try {
    const id = parseInt(req.params.id); const b = req.body || {};
    const monto = Math.round(Number(b.monto));
    if (!(monto > 0)) return fail(res, 'El monto debe ser mayor a 0', 400);
    if (!ISO.test(String(b.fecha || ''))) return fail(res, 'Fecha inválida', 400);
    if (b.fecha > fc.hoyISO()) return fail(res, 'La fecha no puede ser futura', 400);
    const idCta = parseInt(b.id_cuenta_bancaria) || null;
    let cta = null;
    if (idCta) {
      [[cta]] = await pool.query('SELECT id_cuenta, nombre, cuenta_contable FROM cuentas_bancarias WHERE id_cuenta=? AND activo=1', [idCta]);
      if (!cta) return fail(res, 'Cuenta bancaria inválida o inactiva', 400);
    }
    const [[l]] = await pool.query('SELECT * FROM linea_credito WHERE id=?', [id]);
    if (!l) return fail(res, 'Línea no encontrada', 404);
    const s = estadoLinea(l, await saldoLinea(id));
    if (tipo === 'GIRO' && monto > s.disponible)
      return fail(res, `El giro excede el cupo disponible (${fmtCLP(s.disponible)}). Las compensaciones sin aceptar todavía no reponen cupo.`, 400);
    if (tipo === 'PAGO' && monto > s.insoluto) return fail(res, `El pago excede el saldo insoluto (${fmtCLP(s.insoluto)})`, 400);
    const glosa = norm(b.glosa).slice(0, 300) || null;
    const [r] = await pool.query(
      `INSERT INTO linea_credito_movs (id_linea, tipo, fecha, monto, saldo_anterior, saldo_nuevo, estado, id_cuenta_bancaria, glosa, usuario)
       VALUES (?,?,?,?,?,?,'REGISTRADO',?,?,?)`,
      [id, tipo, b.fecha, monto, s.insoluto, s.insoluto + (tipo === 'GIRO' ? monto : -monto), idCta, glosa, quien(req)]);
    await require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: tipo === 'GIRO' ? 'LINEA_GIRO' : 'LINEA_PAGO', fecha: b.fecha,
      glosa: `${tipo === 'GIRO' ? 'Giro' : 'Pago'} ${l.nombre}${glosa ? ' — ' + glosa : ''}`.slice(0, 300),
      ref: `L${tipo}-${r.insertId}`, montos: { monto }, detalle: [l.acreedor_nombre, cta && cta.nombre].filter(Boolean).join(' · '),
      reemplazos: cta && cta.cuenta_contable ? { '1101090': cta.cuenta_contable } : null });
    auditar({ req, accion: 'CREAR', modulo: 'linea-credito', entidad: tipo.toLowerCase(), entidad_id: String(r.insertId),
      detalle: `${tipo} ${l.nombre} ${fmtCLP(monto)} del ${b.fecha}${glosa ? ' (' + glosa + ')' : ''}` });
    ok(res, { id: r.insertId });
    // Un giro con OP otorgadas pendientes no las compensa hacia atrás: el barrido solo toma las nuevas.
  } catch (e) { fail(res, e.message); }
}
exports.registrarGiro = (req, res) => registrarMov(req, res, 'GIRO');
exports.registrarPago = (req, res) => registrarMov(req, res, 'PAGO');

exports.anularMov = async (req, res) => {
  try {
    const idMov = parseInt(req.params.idMov); const motivo = norm((req.body || {}).motivo);
    if (!motivo) return fail(res, 'Indica el motivo de la anulación', 400);
    const [[m]] = await pool.query("SELECT * FROM linea_credito_movs WHERE id=? AND tipo IN ('GIRO','PAGO')", [idMov]);
    if (!m) return fail(res, 'Movimiento no encontrado', 404);
    if (m.estado !== 'REGISTRADO') return fail(res, 'El movimiento ya está anulado', 400);
    const a = await anularAsiento(m.tipo === 'GIRO' ? 'LINEA_GIRO' : 'LINEA_PAGO', `L${m.tipo}-${m.id}`, quien(req), `Anulación ${m.tipo} línea: ${motivo}`);
    if (a.mesCerrado) return fail(res, `El asiento es del mes ${a.mesCerrado}, que está cerrado. Reábrelo en Contabilidad o regulariza con un asiento manual.`, 409);
    const [r] = await pool.query("UPDATE linea_credito_movs SET estado='ANULADO', motivo=? WHERE id=? AND estado='REGISTRADO'", [motivo.slice(0, 400), idMov]);
    if (!r.affectedRows) return fail(res, 'El movimiento cambió mientras tanto; recarga la página', 409);
    auditar({ req, accion: 'ANULAR', modulo: 'linea-credito', entidad: m.tipo.toLowerCase(), entidad_id: String(idMov),
      detalle: `${m.tipo} ${fmtCLP(m.monto)} del ${fc.isoDeBD(m.fecha)} anulado: ${motivo}` });
    ok(res, { id: idMov });
  } catch (e) { fail(res, e.message); }
};

/* Respuesta de la financiera al certificado: ACEPTADO (repone el cupo) u OBJETADO (se anula la
   compensación y su asiento; se corrige el dato en la ficha del crédito y se reemite). */
exports.responder = async (req, res) => {
  try {
    const idMov = parseInt(req.params.idMov); const b = req.body || {};
    const resp = norm(b.respuesta).toUpperCase(); const motivo = norm(b.motivo);
    if (!['ACEPTADO', 'OBJETADO'].includes(resp)) return fail(res, 'Respuesta inválida', 400);
    if (resp === 'OBJETADO' && !motivo) return fail(res, 'Indica qué objetó la financiera', 400);
    const [[m]] = await pool.query("SELECT * FROM linea_credito_movs WHERE id=? AND tipo='COMPENSACION'", [idMov]);
    if (!m) return fail(res, 'Certificado no encontrado', 404);
    if (!['EMITIDO', 'ENVIADO'].includes(m.estado)) return fail(res, `El certificado ya está ${m.estado}`, 400);
    if (resp === 'OBJETADO') {
      const a = await anularAsiento('LINEA_COMPENSACION', `LCOMP-${m.id}`, quien(req), `Certificado objetado: ${motivo}`);
      if (a.mesCerrado) return fail(res, `El asiento de la compensación es del mes ${a.mesCerrado}, que está cerrado. Reábrelo en Contabilidad antes de registrar la objeción.`, 409);
    }
    const [r] = await pool.query(
      "UPDATE linea_credito_movs SET estado=?, respuesta_at=NOW(), respuesta_por=?, motivo=? WHERE id=? AND estado IN ('EMITIDO','ENVIADO')",
      [resp, quien(req), motivo.slice(0, 400) || null, idMov]);
    if (!r.affectedRows) return fail(res, 'El certificado cambió mientras tanto; recarga la página', 409);
    if (resp === 'OBJETADO' && m.cert_codigo)
      await require('../../../../shared/verificacion').anularVerificable(m.cert_codigo, `Objetado por la financiera: ${motivo}`).catch(() => {});
    auditar({ req, accion: resp === 'ACEPTADO' ? 'APROBAR' : 'RECHAZAR', modulo: 'linea-credito', entidad: 'certificado_saldo', entidad_id: String(idMov),
      detalle: `CSI-${String(m.cert_numero).padStart(4, '0')} (OP ${m.num_op}) ${resp}${motivo ? ': ' + motivo : ''}` });
    ok(res, { id: idMov, estado: resp });
  } catch (e) { fail(res, e.message); }
};

/* Reemitir: libera la referencia de la compensación objetada (o de una SIN_SALDO mal tomada, p. ej.
   porque el giro se registró tarde) y el motor la vuelve a procesar con los datos actuales del crédito. */
exports.reemitir = async (req, res) => {
  try {
    const idMov = parseInt(req.params.idMov);
    const [[m]] = await pool.query("SELECT * FROM linea_credito_movs WHERE id=? AND tipo='COMPENSACION'", [idMov]);
    if (!m) return fail(res, 'Movimiento no encontrado', 404);
    if (!['OBJETADO', 'SIN_SALDO'].includes(m.estado)) return fail(res, 'Solo se reemite un certificado objetado o una operación sin saldo', 400);
    if (!m.ref_unica) return fail(res, 'Esta operación ya se reemitió', 400);
    const [r] = await pool.query('UPDATE linea_credito_movs SET ref_unica=NULL WHERE id=? AND ref_unica IS NOT NULL', [idMov]);
    if (!r.affectedRows) return fail(res, 'Esta operación ya se reemitió', 409);
    auditar({ req, accion: 'EDITAR', modulo: 'linea-credito', entidad: 'certificado_saldo', entidad_id: String(idMov),
      detalle: `OP ${m.num_op}: se libera para reprocesar (estaba ${m.estado})` });
    const n = await procesarLineas();
    ok(res, { id: idMov, procesadas: n });
  } catch (e) { fail(res, e.message); }
};

exports.enviar = async (req, res) => {
  try {
    const env = await enviarCertificado(parseInt(req.params.idMov), quien(req));
    if (!env.enviado) return fail(res, env.motivo || 'No se pudo enviar', 400);
    ok(res, env);
  } catch (e) { fail(res, e.message); }
};

exports.pdf = async (req, res) => {
  try {
    const pdf = await pdfDeMovimiento(parseInt(req.params.idMov));
    if (!pdf) return fail(res, 'Certificado no encontrado', 404);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.nombre}"`);
    res.send(pdf.buf);
  } catch (e) { fail(res, e.message); }
};

exports.procesarAhora = async (req, res) => {
  try { ok(res, { procesadas: await procesarLineas() }); }
  catch (e) { fail(res, e.message); }
};

/* ── Vista previa (pestaña Parámetros) ─────────────────────────────────────
   Arma el certificado y el correo con los parámetros que están en pantalla (aunque no se hayan
   guardado) y una operación de ejemplo: el último certificado emitido o, si no hay, la última OP
   de la financiera otorgada. Mismos motores que la emisión real; nada se graba. */
async function datosPreview(id, b = {}) {
  const [[base]] = await pool.query('SELECT * FROM linea_credito WHERE id=?', [id]);
  if (!base) return null;
  const l = { ...base };
  for (const k of ['acreedor_nombre', 'acreedor_rut', 'firmante_nombre', 'firmante_cargo', 'correo_para', 'correo_cc', 'nombre'])
    if (b[k] != null) l[k] = norm(b[k]);
  if (Number(b.limite) > 0) l.limite = Math.round(Number(b.limite));
  if (parseInt(b.dias_respuesta) >= 1) l.dias_respuesta = parseInt(b.dias_respuesta);
  for (const k of ['contrato_fecha', 'fecha_vencimiento']) if (b[k] !== undefined) l[k] = ISO.test(String(b[k] || '')) ? b[k] : null;
  if (b.cert_texto_intro !== undefined) l.cert_texto_intro = norm(b.cert_texto_intro) || null;
  if (b.cert_texto_cierre !== undefined) l.cert_texto_cierre = norm(b.cert_texto_cierre) || null;
  let [[m]] = await pool.query(
    "SELECT * FROM linea_credito_movs WHERE id_linea=? AND tipo='COMPENSACION' AND cert_numero IS NOT NULL ORDER BY id DESC LIMIT 1", [id]);
  if (m) m = { ...m, created_at: new Date() };
  else {
    const [[c]] = await pool.query(
      `SELECT c.id, c.num_op, c.financiera, c.saldo_precio, c.fecha_otorgado FROM creditos c
        WHERE UPPER(c.financiera)=UPPER(?) AND c.saldo_precio > 0 AND c.fecha_otorgado IS NOT NULL
        ORDER BY c.fecha_otorgado DESC, c.id DESC LIMIT 1`, [l.financiera]);
    if (!c) return { l, d: null };
    const { montoSaldoOrden, getFijosAutoFin } = require('../../../postventa/src/controllers/postventa.controller');
    const sp = Math.round(montoSaldoOrden(c.financiera, c.saldo_precio, await getFijosAutoFin(), false));
    const ant = Math.round((Number(l.limite) || 0) * 0.6);                 // saldo de ejemplo: 60% de la línea
    const comp = Math.min(sp, ant);
    m = { id_credito: c.id, num_op: c.num_op, fecha: c.fecha_otorgado, saldo_anterior: ant, saldo_precio: sp, monto: comp,
      exceso: sp - comp, saldo_nuevo: ant - comp, created_at: new Date() };
  }
  const [[n]] = await pool.query('SELECT COALESCE(MAX(cert_numero),0)+1 sig FROM linea_credito_movs WHERE id_linea=?', [id]);
  m.cert_numero = n.sig;
  return { l, d: await datosCertificado(l, m) };
}

exports.previewPdf = async (req, res) => {
  try {
    const p = await datosPreview(parseInt(req.params.id), req.body || {});
    if (!p) return fail(res, 'Línea no encontrada', 404);
    if (!p.d) return fail(res, 'No hay ninguna operación de la financiera para armar el ejemplo', 400);
    const { generarCertificadoSaldoLineaPDF } = require('../../../../shared/certificado-saldo-linea-pdf');
    const buf = await generarCertificadoSaldoLineaPDF({ d: p.d, codigo: 'VISTA-PREVIA', host: HOST, preview: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="vista-previa-certificado.pdf"');
    res.send(buf);
  } catch (e) { fail(res, e.message); }
};

exports.previewCorreo = async (req, res) => {
  try {
    const p = await datosPreview(parseInt(req.params.id), req.body || {});
    if (!p) return fail(res, 'Línea no encontrada', 404);
    if (!p.d) return fail(res, 'No hay ninguna operación de la financiera para armar el ejemplo', 400);
    const plant = require('../../../../shared/plantillas-correo');
    const t = await plant.obtener('linea_certificado_saldo');
    if (!t) return fail(res, 'La plantilla linea_certificado_saldo no existe en Correos del Sistema', 400);
    const datos = datosCorreo(p.l, p.d, 'VISTA-PREVIA');
    const cuerpo = plant.render(t.cuerpo, datos);
    const { envolverHTML } = require('../../../../shared/mailer');
    ok(res, {
      para: EMAILS(p.l.correo_para), cc: [...new Set([...EMAILS(p.l.correo_cc), ...EMAILS(t.cc)])],
      asunto: plant.render(t.asunto, datos),
      // El logo del correo real va incrustado (cid:); en pantalla se muestra el mismo archivo por URL.
      html: envolverHTML(plant.aHTML(cuerpo)).replace(/cid:aflogobs/g, '/img/logo-bs-mail.png'),
      adjunto: `${p.d.numero_txt}_OP${p.d.operacion.num_op}.pdf`, activa: !!t.activo, ejemplo_op: p.d.operacion.num_op,
    });
  } catch (e) { fail(res, e.message); }
};

// Envío manual de la solicitud de reposición (botón en la Cartola). Se puede repetir (p. ej. si Unidad no contestó).
exports.enviarReposicion = async (req, res) => {
  try {
    const [[l]] = await pool.query('SELECT * FROM linea_credito WHERE id=?', [parseInt(req.params.id)]);
    if (!l) return fail(res, 'Línea no encontrada', 404);
    const env = await enviarReposicion(l, quien(req));
    if (!env.enviado) return fail(res, env.motivo || 'No se pudo enviar', 400);
    ok(res, { to: env.to, cc: env.cc });
  } catch (e) { fail(res, e.message); }
};

/* Vista previa de la solicitud de reposición: el ciclo real si hay abono con operaciones; si no, un
   ejemplo con las últimas OP de la financiera hasta el umbral sobre el monto máximo. Nada se graba. */
exports.previewReposicion = async (req, res) => {
  try {
    const p = await datosPreview(parseInt(req.params.id), req.body || {});
    if (!p) return fail(res, 'Línea no encontrada', 404);
    const l = p.l;
    let ci = await cicloActual(l.id), ejemplo = false;
    if (!ci || !ci.operaciones.length) {
      ejemplo = true;
      const inicial = Number(l.limite) || 0, meta = inicial * (Number(req.body && req.body.umbral_pct) || Number(l.umbral_pct) || 80) / 100;
      const [cs] = await pool.query(
        `SELECT c.num_op, c.id_financiera, c.saldo_precio monto, cl.rut, cl.nombre_completo cliente
           FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
          WHERE UPPER(c.financiera)=UPPER(?) AND c.saldo_precio > 0 AND c.fecha_otorgado IS NOT NULL
          ORDER BY c.fecha_otorgado DESC, c.id DESC LIMIT 60`, [l.financiera]);
      let acum = 0; const ops = [];
      for (const c of cs) { if (acum >= meta) break; acum += Number(c.monto); ops.push({ ...c, monto: Number(c.monto) }); }
      let a2 = 0;
      ci = { fecha_abono: fc.hoyISO(), saldo_inicial: inicial, compensado: acum, saldo_actual: inicial - acum,
        consumo_pct: inicial ? Math.round(acum / inicial * 1000) / 10 : 0,
        operaciones: ops.map(o => { a2 += o.monto; return { ...o, pct: Math.round(o.monto / inicial * 1000) / 10, pct_acum: Math.round(a2 / inicial * 1000) / 10 }; }) };
    }
    const h = await htmlReposicion(l, ci);
    if (!h) return fail(res, 'La plantilla linea_reposicion_cupo no existe en Correos del Sistema', 400);
    const t = h.t;
    ok(res, {
      para: EMAILS(l.correo_para), cc: [...new Set([...EMAILS(l.correo_cc), ...EMAILS(t.cc)])], asunto: h.asunto,
      html: h.html,
      adjunto: null, activa: !!t.activo, ejemplo_op: ejemplo ? 'ejemplo con las últimas OP de Unidad (no hay ciclo real aún)' : `ciclo real del abono del ${fmtD(ci.fecha_abono)}`,
    });
  } catch (e) { fail(res, e.message); }
};

// Correo de una solicitud de reposición tal como se envió (popup de la Cartola).
exports.correoSolicitud = async (req, res) => {
  try {
    const [[m]] = await pool.query("SELECT id, glosa, enviado_at, enviado_a, correo_html, monto, usuario FROM linea_credito_movs WHERE id=? AND tipo='SOLICITUD'", [parseInt(req.params.idMov)]);
    if (!m) return fail(res, 'Solicitud no encontrada', 404);
    ok(res, m);
  } catch (e) { fail(res, e.message); }
};

/* ── Documentos firmados del acuerdo ──────────────────────────────────────
   Uno vigente por tipo (OTRO admite varios). Cargar sobre un tipo que ya tiene documento = reemplazar. */
const TIPOS_DOC = {
  CONTRATO: 'Contrato de Apertura de Línea de Crédito',
  ANEXO_1:  'Anexo 1 — Solicitud de Desembolso',
  ANEXO_2:  'Anexo 2 — Pagaré',
  ANEXO_3:  'Anexo 3 — Notificaciones',
  CONVENIO: 'Convenio Comercial',
  OTRO:     'Otro documento (modificación, prórroga, poder…)',
};
const MIME_DOC = /^(application\/pdf|image\/(png|jpe?g|webp)|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/msword)$/;
const MAX_DOC = 10 * 1024 * 1024;

exports.documentos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, tipo, titulo, nombre_archivo, mime, doc_bytes, DATE_FORMAT(fecha_firma,'%Y-%m-%d') fecha_firma, nota, vigente,
              reemplazado_at, reemplazado_por, subido_por, created_at
         FROM linea_credito_docs WHERE id_linea=? ORDER BY vigente DESC, id DESC`, [parseInt(req.params.id)]);
    ok(res, { tipos: TIPOS_DOC, documentos: rows });
  } catch (e) { fail(res, e.message); }
};

exports.subirDocumento = async (req, res) => {
  try {
    const id = parseInt(req.params.id); const b = req.body || {};
    const tipo = norm(b.tipo).toUpperCase();
    if (!TIPOS_DOC[tipo]) return fail(res, 'Tipo de documento inválido', 400);
    const nombre = norm(b.nombre_archivo).slice(0, 255);
    if (!nombre) return fail(res, 'Falta el nombre del archivo', 400);
    const mime = norm(b.mime).toLowerCase();
    if (!MIME_DOC.test(mime)) return fail(res, 'Formato no permitido: sube PDF, Word o imagen', 400);
    if (!b.data) return fail(res, 'Falta el archivo', 400);
    const buffer = Buffer.from(String(b.data), 'base64');
    if (!buffer.length) return fail(res, 'El archivo está vacío', 400);
    if (buffer.length > MAX_DOC) return fail(res, 'El archivo supera los 10 MB', 400);
    if (b.fecha_firma && !ISO.test(String(b.fecha_firma))) return fail(res, 'Fecha de firma inválida', 400);
    const titulo = tipo === 'OTRO' ? (norm(b.titulo).slice(0, 150) || null) : null;
    if (tipo === 'OTRO' && !titulo) return fail(res, 'Indica qué documento es', 400);
    const [[l]] = await pool.query('SELECT id FROM linea_credito WHERE id=?', [id]);
    if (!l) return fail(res, 'Línea no encontrada', 404);
    const col = await require('../../../../shared/almacen-docs').colocar({ ambito: 'linea-credito', clave: `${id}-${tipo}`, buffer, mime, nombre });
    const [r] = await pool.query(
      `INSERT INTO linea_credito_docs (id_linea, tipo, titulo, nombre_archivo, mime, archivo, doc_storage, doc_ruta, doc_bytes, fecha_firma, nota, subido_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tipo, titulo, nombre, mime, col.blob, col.storage, col.ruta, col.bytes, b.fecha_firma || null, norm(b.nota).slice(0, 300) || null, quien(req)]);
    // Reemplazo: el anterior del mismo tipo deja de ser vigente (se conserva; nunca se borra un firmado)
    let reemplazo = 0;
    if (tipo !== 'OTRO') {
      const [u] = await pool.query(
        'UPDATE linea_credito_docs SET vigente=0, reemplazado_at=NOW(), reemplazado_por=? WHERE id_linea=? AND tipo=? AND vigente=1 AND id<>?',
        [quien(req), id, tipo, r.insertId]);
      reemplazo = u.affectedRows;
    }
    auditar({ req, accion: reemplazo ? 'EDITAR' : 'CREAR', modulo: 'linea-credito', entidad: 'documento', entidad_id: String(r.insertId),
      detalle: `${reemplazo ? 'Reemplazó' : 'Cargó'} ${titulo || TIPOS_DOC[tipo]}: ${nombre} (${Math.round(buffer.length / 1024)} KB)${b.fecha_firma ? ', firmado el ' + b.fecha_firma : ''}` });
    ok(res, { id: r.insertId, reemplazados: reemplazo });
  } catch (e) { fail(res, e.message); }
};

exports.verDocumento = async (req, res) => {
  try {
    const [[d]] = await pool.query('SELECT nombre_archivo, mime, archivo, doc_ruta FROM linea_credito_docs WHERE id=?', [parseInt(req.params.idDoc)]);
    if (!d) return fail(res, 'Documento no encontrado', 404);
    await require('../../../../shared/almacen-docs').servir(res, { ruta: d.doc_ruta, blob: d.archivo, nombre: d.nombre_archivo, mime: d.mime });
  } catch (e) { fail(res, e.message); }
};

exports.procesarLineas = procesarLineas;
exports.procesarTrasEvento = procesarTrasEvento;
exports.compensadoDeOp = compensadoDeOp;
exports.saldoLinea = saldoLinea;
