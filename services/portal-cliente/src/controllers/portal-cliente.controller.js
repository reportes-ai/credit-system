'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Portal del Cliente — autoconsulta read-only para clientes finales.
   Enrolamiento SIN Registro Civil: RUT → código OTP al correo/celular REGISTRADO
   en la base (posesión del contacto acredita identidad) → clave propia.
   Aislamiento total: cada endpoint acota por el RUT del JWT (tipo 'cliente');
   un cliente JAMÁS ve datos de otro. Motores reusados (máxima #1):
   - Tabla de desarrollo = cuotas_credito (calendario CONGELADO)
   - Valor de cuota AL DÍA DE HOY = cobranzaFullMap (mora + gastos canónicos)
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');
const { auditar } = require('../../../../shared/audit');
const { cobranzaFullMap } = require('../../../creditos/src/controllers/pagos-credito.controller');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const rutNorm = r => String(r || '').replace(/[.\s]/g, '').toUpperCase();

/* ── Migración ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_clientes (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        rut            VARCHAR(15)  NOT NULL UNIQUE,
        clave_hash     VARCHAR(100) NOT NULL,
        intentos       INT          NOT NULL DEFAULT 0,
        bloqueado_hasta DATETIME    NULL,
        ultimo_acceso  DATETIME     NULL,
        created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_clientes_otp (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        rut        VARCHAR(15) NOT NULL,
        codigo     VARCHAR(8)  NOT NULL,
        canal      VARCHAR(10) NOT NULL DEFAULT 'CORREO',
        expira     DATETIME    NOT NULL,
        usado      TINYINT(1)  NOT NULL DEFAULT 0,
        created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_rut (rut)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_cliente_config (
        clave VARCHAR(40) PRIMARY KEY, valor TEXT )`);
    const SEED = [
      ['donde_pagar', 'Puedes pagar tus cuotas por transferencia bancaria o presencialmente en nuestras oficinas de Casa Matriz.'],
      ['datos_transferencia', 'AutoFácil Crédito Automotriz\nCuenta Corriente\nBanco: (configurar)\nN° de cuenta: (configurar)\nRUT: (configurar)\nCorreo de aviso: cobranza@autofacilchile.cl\n\nEnvía el comprobante indicando tu RUT y N° de operación.'],
      ['contacto', 'WhatsApp / Teléfono: (configurar)\nCorreo: cobranza@autofacilchile.cl\nHorario: lunes a sábado de 09:00 a 19:00 hrs.'],
    ];
    for (const [k, v] of SEED) await pool.query('INSERT IGNORE INTO portal_cliente_config (clave, valor) VALUES (?,?)', [k, v]);
  } catch (e) { console.error('[portal-cliente migration]', e.message); }
})();

/* ── Middleware: sesión de cliente (JWT propio tipo=cliente) ───────────────── */
exports.verifyCliente = (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    const tk = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tk) return res.status(401).json({ success: false, error: 'Sesión requerida' });
    const p = jwt.verify(tk, JWT_SECRET);
    if (p.tipo !== 'cliente' || !p.rut) return res.status(401).json({ success: false, error: 'Sesión inválida' });
    req.clienteRut = p.rut; req.clienteNombre = p.nombre || '';
    next();
  } catch (_) { return res.status(401).json({ success: false, error: 'Sesión expirada' }); }
};

const mask = {
  correo: c => { const [u, d] = String(c || '').split('@'); return u && d ? u.slice(0, 2) + '****@' + d : null; },
  fono:   f => { const d = String(f || '').replace(/\D/g, ''); return d.length >= 4 ? '+56 9 ****' + d.slice(-4) : null; },
};

async function buscarCliente(rut) {
  const [[cli]] = await pool.query(
    'SELECT id_cliente, rut, nombre_completo, correo, email, telefono_movil FROM clientes WHERE REPLACE(REPLACE(UPPER(rut),".",""), " ", "")=? LIMIT 1',
    [rutNorm(rut)]);
  return cli || null;
}

/* ── 1) Solicitar código de verificación ───────────────────────────────────── */
exports.solicitarCodigo = async (req, res) => {
  try {
    const rut = rutNorm(req.body?.rut);
    if (!rut || rut.length < 8) return res.status(400).json({ success: false, error: 'RUT inválido' });
    // Tope: máx 3 códigos por hora por RUT (anti-abuso)
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM portal_clientes_otp WHERE rut=? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)', [rut]);
    if (n >= 3) return res.status(429).json({ success: false, error: 'Demasiados intentos. Espera una hora o contáctanos.' });
    const cli = await buscarCliente(rut);
    // Respuesta genérica si no existe (no revelar quién es cliente)
    if (!cli || !(cli.correo || cli.email)) {
      return res.json({ success: true, data: { enviado: false, mensaje: 'Si tus datos están registrados recibirás un código. Si no llega, contáctanos para actualizar tu contacto.' }, error: null });
    }
    const codigo = String(Math.floor(100000 + Math.random() * 899999));
    await pool.query("INSERT INTO portal_clientes_otp (rut, codigo, canal, expira) VALUES (?,?,'CORREO', DATE_ADD(NOW(), INTERVAL 10 MINUTE))", [rut, codigo]);
    const correo = cli.correo || cli.email;
    if (mailConfigurado()) {
      await enviarCorreo({
        to: correo,
        subject: `${codigo} es tu código — Portal Clientes AutoFácil`,
        html: `<div style="font-family:Segoe UI,sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#012d70">Portal Clientes AutoFácil</h2>
          <p>Hola ${cli.nombre_completo || ''}, tu código de verificación es:</p>
          <div style="font-size:2rem;font-weight:800;letter-spacing:8px;background:#f0f4f8;border-radius:12px;text-align:center;padding:18px;color:#0141A2">${codigo}</div>
          <p style="color:#64748b;font-size:.9rem">Vence en 10 minutos. Si no solicitaste este código, ignora este correo.</p>
        </div>`,
      });
    } else {
      console.log(`[portal-cliente] OTP para ${rut}: ${codigo} (correo no configurado — modo dev)`);
    }
    auditar({ req, accion: 'CREAR', modulo: 'portal-cliente', entidad: 'otp', entidad_id: rut, detalle: 'Código de enrolamiento enviado' });
    res.json({ success: true, data: { enviado: true, correo: mask.correo(correo), celular: mask.fono(cli.telefono_movil) }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── 2) Activar cuenta (verifica OTP + fija clave) ─────────────────────────── */
exports.activar = async (req, res) => {
  try {
    const rut = rutNorm(req.body?.rut), { codigo, clave } = req.body || {};
    if (!rut || !codigo || !clave) return res.status(400).json({ success: false, error: 'Faltan datos' });
    if (String(clave).length < 6) return res.status(400).json({ success: false, error: 'La clave debe tener al menos 6 caracteres' });
    const [[otp]] = await pool.query(
      'SELECT id FROM portal_clientes_otp WHERE rut=? AND codigo=? AND usado=0 AND expira>NOW() ORDER BY id DESC LIMIT 1', [rut, String(codigo).trim()]);
    if (!otp) return res.status(400).json({ success: false, error: 'Código inválido o vencido' });
    await pool.query('UPDATE portal_clientes_otp SET usado=1 WHERE id=?', [otp.id]);
    const hash = await bcrypt.hash(String(clave), 10);
    await pool.query('INSERT INTO portal_clientes (rut, clave_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE clave_hash=VALUES(clave_hash), intentos=0, bloqueado_hasta=NULL', [rut, hash]);
    auditar({ req, accion: 'CREAR', modulo: 'portal-cliente', entidad: 'cuenta', entidad_id: rut, detalle: 'Cuenta del portal activada' });
    const cli = await buscarCliente(rut);
    const token = jwt.sign({ tipo: 'cliente', rut, nombre: cli?.nombre_completo || '' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, data: { token, nombre: cli?.nombre_completo || '' }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── 3) Login ──────────────────────────────────────────────────────────────── */
exports.login = async (req, res) => {
  try {
    const rut = rutNorm(req.body?.rut), clave = String(req.body?.clave || '');
    const [[cta]] = await pool.query('SELECT * FROM portal_clientes WHERE rut=?', [rut]);
    if (!cta) return res.status(401).json({ success: false, error: 'Cuenta no registrada. Usa "Primera vez" para crearla.' });
    if (cta.bloqueado_hasta && new Date(cta.bloqueado_hasta) > new Date())
      return res.status(429).json({ success: false, error: 'Cuenta bloqueada temporalmente por intentos fallidos. Intenta más tarde.' });
    const ok = await bcrypt.compare(clave, cta.clave_hash);
    if (!ok) {
      const intentos = (cta.intentos || 0) + 1;
      await pool.query('UPDATE portal_clientes SET intentos=?, bloqueado_hasta=? WHERE id=?',
        [intentos, intentos >= 5 ? new Date(Date.now() + 15 * 60000) : null, cta.id]);
      return res.status(401).json({ success: false, error: 'RUT o clave incorrecta' });
    }
    await pool.query('UPDATE portal_clientes SET intentos=0, bloqueado_hasta=NULL, ultimo_acceso=NOW() WHERE id=?', [cta.id]);
    const cli = await buscarCliente(rut);
    const token = jwt.sign({ tipo: 'cliente', rut, nombre: cli?.nombre_completo || '' }, JWT_SECRET, { expiresIn: '8h' });
    auditar({ req, accion: 'LOGIN', modulo: 'portal-cliente', entidad: 'cuenta', entidad_id: rut, detalle: 'Ingreso al portal de clientes' });
    res.json({ success: true, data: { token, nombre: cli?.nombre_completo || '' }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── 4) Resumen: mis créditos ──────────────────────────────────────────────── */
exports.resumen = async (req, res) => {
  try {
    const cli = await buscarCliente(req.clienteRut);
    if (!cli) return res.json({ success: true, data: { nombre: '', creditos: [] }, error: null });
    const [creds] = await pool.query(
      `SELECT c.id, c.num_op, c.numero_credito, c.financiera, c.estado, c.estado_credito, c.estado_cartera,
              c.monto_financiado, c.cuota, c.plazo,
              DATE_FORMAT(COALESCE(c.fecha_otorgado, c.fecha_estado, c.mes),'%d-%m-%Y') fecha,
              (SELECT COUNT(*) FROM cuotas_credito q WHERE q.id_credito=c.id) tiene_cal,
              (SELECT COUNT(*) FROM cuotas_credito q WHERE q.id_credito=c.id AND q.estado_cuota='PAGADA') pagadas_cal,
              (SELECT COUNT(DISTINCT p.numero_cuota) FROM pagos_credito p WHERE p.id_credito=c.id AND (p.estado_pago IS NULL OR p.estado_pago!='REVERSADO')) pagadas_app
         FROM creditos c
        WHERE c.id_cliente=? AND c.estado_credito='OTORGADO'
          AND c.financiera IN ('AUTOFACIL','AUTOFIN','UNIDAD')
        ORDER BY COALESCE(c.fecha_otorgado, c.fecha_estado, c.mes) DESC LIMIT 20`, [cli.id_cliente]);
    res.json({ success: true, data: { nombre: cli.nombre_completo, creditos: creds }, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── 5) Detalle: tabla de desarrollo + valores AL DÍA DE HOY + comprobantes ── */
exports.detalle = async (req, res) => {
  try {
    const cli = await buscarCliente(req.clienteRut);
    const [[cred]] = await pool.query(
      `SELECT c.* FROM creditos c
        WHERE c.id=? AND c.id_cliente=? AND c.financiera='AUTOFACIL' AND c.estado_credito='OTORGADO' LIMIT 1`,
      [req.params.id, cli?.id_cliente || -1]);
    if (!cred) return res.status(404).json({ success: false, error: 'Crédito no encontrado' }); // no es tuyo o no es cartera AutoFácil

    // Tabla de desarrollo: calendario CONGELADO (fuente única cuotas_credito)
    const [cal] = await pool.query(
      `SELECT numero_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') fecha_vencimiento, valor_cuota,
              interes, amortizacion, saldo_insoluto, estado_cuota, DATE_FORMAT(fecha_pago,'%d-%m-%Y') fecha_pago
         FROM cuotas_credito WHERE id_credito=? ORDER BY numero_cuota`, [req.params.id]);

    // Pagos registrados en la app (comprobantes)
    const [pagos] = await pool.query(
      `SELECT id_pago, numero_cuota, DATE_FORMAT(fecha_pago,'%d-%m-%Y') fecha_pago, monto_cuota, interes_mora, gastos_cobranza, total_pagado
         FROM pagos_credito WHERE id_credito=? AND (estado_pago IS NULL OR estado_pago!='REVERSADO') ORDER BY fecha_pago DESC, id_pago DESC LIMIT 60`, [req.params.id]);
    const pagadasApp = new Set(pagos.map(p => Number(p.numero_cuota)));

    // Valor AL DÍA DE HOY de cuotas impagas vencidas: MOTOR ÚNICO mora+gastos
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
    const pendientes = cal.filter(q => q.estado_cuota !== 'PAGADA' && !pagadasApp.has(Number(q.numero_cuota)))
      .map(q => ({ numero_cuota: q.numero_cuota, monto_cuota: q.valor_cuota, fecha_vencimiento: q.fecha_vencimiento }));
    let fullMap = new Map();
    try { fullMap = await cobranzaFullMap(cred.id, pendientes, hoy); } catch (_) {}

    const tabla = cal.map(q => {
      const pagada = q.estado_cuota === 'PAGADA' || pagadasApp.has(Number(q.numero_cuota));
      const f = !pagada ? fullMap.get(Number(q.numero_cuota)) : null;
      const vencida = !pagada && q.fecha_vencimiento < hoy;
      return {
        numero_cuota: q.numero_cuota,
        fecha_vencimiento: q.fecha_vencimiento,
        valor_cuota: Math.round(parseFloat(q.valor_cuota) || 0),
        interes: Math.round(parseFloat(q.interes) || 0),
        amortizacion: Math.round(parseFloat(q.amortizacion) || 0),
        saldo_insoluto: Math.round(parseFloat(q.saldo_insoluto) || 0),
        estado: pagada ? 'PAGADA' : (vencida ? 'VENCIDA' : 'PENDIENTE'),
        fecha_pago: q.fecha_pago || null,
        mora_hoy: f ? f.mora : 0,
        gastos_hoy: f ? f.gastos : 0,
        total_hoy: Math.round(parseFloat(q.valor_cuota) || 0) + (f ? f.mora + f.gastos : 0),
      };
    });

    const deudaHoy = tabla.filter(t => t.estado === 'VENCIDA').reduce((a, t) => a + t.total_hoy, 0);
    res.json({
      success: true, error: null,
      data: {
        credito: {
          id: cred.id, num_op: cred.num_op, numero_credito: cred.numero_credito, financiera: cred.financiera,
          monto_financiado: Math.round(parseFloat(cred.monto_financiado) || 0), cuota: Math.round(parseFloat(cred.cuota) || 0),
          plazo: cred.plazo, estado_cartera: cred.estado_cartera,
          fecha_otorgado: cred.fecha_otorgado ? new Date(cred.fecha_otorgado).toISOString().slice(0, 10) : null,
          vehiculo: [cred.marca, cred.modelo, cred.anio].filter(Boolean).join(' ') || null,
        },
        tabla, pagos, deuda_hoy: deudaHoy, calculado_al: hoy,
      },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ── 6) Dónde pagar / contacto (paramétrico) ───────────────────────────────── */
exports.infoPago = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM portal_cliente_config');
    const out = {}; rows.forEach(r => { out[r.clave] = r.valor; });
    // Datos de transferencia desde la FUENTE ÚNICA (cuentas_bancarias, mantenedor Cuentas Bancarias),
    // no duplicados en el config: así el N° de cuenta es siempre el mismo en toda la app.
    try {
      const [[cta]] = await pool.query(
        "SELECT razon_social, rut, banco, tipo_cuenta, numero_cuenta FROM cuentas_bancarias WHERE activo=1 ORDER BY id_cuenta LIMIT 1");
      if (cta) {
        out.datos_transferencia =
          `${cta.razon_social}\n${cta.tipo_cuenta} ${cta.banco}\nN° de cuenta: ${cta.numero_cuenta}\nRUT: ${cta.rut}\n` +
          `Correo de aviso: contacto@autofacilchile.cl\n\nEnvía el comprobante indicando tu RUT y N° de operación.`;
      }
    } catch (_) { /* si no hay cuenta activa, queda el texto del config */ }
    res.json({ success: true, data: out, error: null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};
