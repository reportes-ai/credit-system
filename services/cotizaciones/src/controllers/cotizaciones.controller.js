const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('cotizaciones', async () => {
  // 1. Crear tabla si no existe
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cotizaciones (
        id_cotizacion    INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente      VARCHAR(15)  NOT NULL,
        nombre_cliente   VARCHAR(300) NOT NULL,
        fecha_cotizacion DATETIME     DEFAULT CURRENT_TIMESTAMP,
        valor_vehiculo   BIGINT,
        pie              BIGINT,
        plazo            INT,
        tasa_mensual     DECIMAL(8,4),
        monto_financiado BIGINT,
        cuota            BIGINT,
        datos_json       JSON,
        id_usuario       INT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[cotizaciones migration create]', e.message);
  }

  // 2. Agregar columnas si la tabla existía con esquema viejo (errno 1060 = columna duplicada → ignorar)
  const cols = [
    `ALTER TABLE cotizaciones ADD COLUMN rut_cliente      VARCHAR(15)  NOT NULL DEFAULT ''`,
    `ALTER TABLE cotizaciones ADD COLUMN nombre_cliente   VARCHAR(300) NOT NULL DEFAULT ''`,
    `ALTER TABLE cotizaciones ADD COLUMN fecha_cotizacion DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE cotizaciones ADD COLUMN valor_vehiculo   BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN pie              BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN plazo            INT`,
    `ALTER TABLE cotizaciones ADD COLUMN tasa_mensual     DECIMAL(8,4)`,
    `ALTER TABLE cotizaciones ADD COLUMN monto_financiado BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN cuota            BIGINT`,
    `ALTER TABLE cotizaciones ADD COLUMN datos_json       JSON`,
    `ALTER TABLE cotizaciones ADD COLUMN id_usuario       INT`,
    `ALTER TABLE cotizaciones ADD COLUMN created_at       DATETIME DEFAULT CURRENT_TIMESTAMP`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); }
    catch (e) { if (e.errno !== 1060) console.error('[cotizaciones migration alter]', e.message); }
  }

  // Corregir columnas que puedan existir como NOT NULL sin default (bloquean el INSERT).
  // MODIFY corre UNA vez (migrarAuto): era DDL repetido en cada boot.
  require('../../../../shared/migrate').migrarAuto('cotizaciones_nullable_fix', async () => {
    const fixes = [
      `ALTER TABLE cotizaciones MODIFY COLUMN id_cliente   INT          NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN id_usuario   INT          NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN valor_vehiculo BIGINT     NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN pie            BIGINT     NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN plazo          INT        NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN tasa_mensual   DECIMAL(8,4) NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN monto_financiado BIGINT   NULL DEFAULT NULL`,
      `ALTER TABLE cotizaciones MODIFY COLUMN cuota           BIGINT    NULL DEFAULT NULL`,
    ];
    for (const sql of fixes) {
      try { await pool.query(sql); }
      catch (e) { if (e.errno !== 1054) console.error('[cotizaciones migration fix]', e.message); }
    }
  });
});

const create = async (req, res) => {
  try {
    const { rut_cliente, nombre_cliente, fecha_cotizacion, valor_vehiculo, pie, plazo,
            tasa_mensual, monto_financiado, cuota, datos_json } = req.body;

    if (!rut_cliente || !nombre_cliente)
      return res.status(400).json({ success: false, data: null,
        error: 'rut_cliente y nombre_cliente son requeridos' });

    const id_usuario = req.usuario?.id_usuario || null;

    const [r] = await pool.query(
      `INSERT INTO cotizaciones
         (rut_cliente, nombre_cliente, fecha_cotizacion, valor_vehiculo, pie, plazo,
          tasa_mensual, monto_financiado, cuota, datos_json, id_usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rut_cliente.toUpperCase().trim(),
        nombre_cliente.trim(),
        fecha_cotizacion || null,
        valor_vehiculo   || null,
        pie              || null,
        plazo            || null,
        tasa_mensual     || null,
        monto_financiado || null,
        cuota            || null,
        JSON.stringify(datos_json || {}),
        id_usuario,
      ]
    );
    res.status(201).json({ success: true, data: { id_cotizacion: r.insertId }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const getAll = async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT c.id_cotizacion, c.rut_cliente,
                      COALESCE(cl.nombre_completo, c.nombre_cliente) AS nombre_cliente, c.fecha_cotizacion,
                      c.valor_vehiculo, c.pie, c.plazo, c.tasa_mensual, c.monto_financiado, c.cuota,
                      c.datos_json, c.id_usuario, c.created_at
               FROM cotizaciones c
               LEFT JOIN clientes cl ON cl.rut = c.rut_cliente`;
    const params = [];
    if (q && q.trim()) {
      const like = `%${q.trim().toUpperCase()}%`;
      sql += ` WHERE UPPER(c.rut_cliente) LIKE ? OR UPPER(COALESCE(cl.nombre_completo, c.nombre_cliente)) LIKE ?`;
      params.push(like, like);
    }
    sql += ` ORDER BY c.created_at DESC LIMIT 500`;
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const getByRut = async (req, res) => {
  try {
    const rut = req.params.rut.toUpperCase().trim();
    const [rows] = await pool.query(
      `SELECT c.id_cotizacion, c.rut_cliente,
              COALESCE(cl.nombre_completo, c.nombre_cliente) AS nombre_cliente, c.fecha_cotizacion,
              c.valor_vehiculo, c.pie, c.plazo, c.tasa_mensual, c.monto_financiado, c.cuota,
              c.datos_json, c.created_at
       FROM cotizaciones c
       LEFT JOIN clientes cl ON cl.rut = c.rut_cliente
       WHERE c.rut_cliente = ? ORDER BY c.created_at DESC LIMIT 20`,
      [rut]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO de presentación de la cotización (imprimir + correo comparten HTML)
═══════════════════════════════════════════════════════════════════════════ */
const _fmt = v => (v == null || v === '') ? '—' : '$' + Math.round(Number(v)).toLocaleString('es-CL');
const _esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _tratamiento(nombre) {
  const primer = String(nombre || '').trim().split(/\s+/)[0]?.toUpperCase() || '';
  const masculinosConA = ['JOSE', 'ANDREA', 'NICOLA', 'ELIA', 'LUCA', 'MATIAS', 'TOBIAS', 'ELIAS', 'JEREMIAS', 'ZACARIAS'];
  if (masculinosConA.includes(primer)) return 'Estimado';
  if (primer.endsWith('A')) return 'Estimada';
  return 'Estimado';
}

function _fechaLarga(s) {
  if (!s) return new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
  return new Date(s).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Extrae inputs/resultados y arma los bloques (una sola vez, reutilizable)
function _desglose(cot) {
  let dj = {};
  try { dj = typeof cot.datos_json === 'string' ? JSON.parse(cot.datos_json) : (cot.datos_json || {}); } catch (_) {}
  const inp = dj.inputs || {}, res = dj.resultados || {};
  const gastos = [
    ['Prenda', inp.prenda], ['Retiro Gestión Auto', inp.retiro], ['Limitación de Dominio', inp.limitacion],
    ['Gastos Administración', inp.admin], ['Inscripción / Transferencia', inp.inscripcion],
    ['GPS', inp.gps], ['Reparaciones Menores', inp.reparaciones],
  ].filter(g => g[1] && g[1] > 0);
  const seguros = [
    ['Seguro Desgravamen', res.segDesg, inp.chkD], ['Seguro RDH', res.segRdh, inp.chkR], ['Seguro Cesantía', res.segCesa, inp.chkC],
  ].filter(s => s[2] && s[1] > 0).map(s => [s[0], s[1]]);
  const saldoPrecio = res.saldoPrecio ?? ((cot.valor_vehiculo || 0) - (cot.pie || 0));
  const totalGastos = res.gastosOp ?? gastos.reduce((a, g) => a + g[1], 0);
  const totalSeg = res.totalSeguros ?? seguros.reduce((a, s) => a + s[1], 0);
  return { inp, res, gastos, seguros, saldoPrecio, totalGastos, totalSeg };
}

// Párrafo resumen (el texto que pidió el negocio)
function resumenCotizacion(cot) {
  const d = _desglose(cot);
  const tieneSeg = d.seguros.length > 0;
  return `De acuerdo a lo conversado, adjunto le enviamos la cotización de un crédito para la compra de un automóvil usado ` +
    `con un valor comercial de ${_fmt(cot.valor_vehiculo)} y un pie de ${_fmt(cot.pie)}. ` +
    `La simulación incluye los gastos operacionales${tieneSeg ? ` y los seguros (${_fmt(d.totalSeg)})` : ''}, ` +
    `lo que da un valor a financiar de ${_fmt(cot.monto_financiado)}, con una cuota a ${cot.plazo} meses de ${_fmt(cot.cuota)}.`;
}

const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');

const DISCLAIMER = 'Los datos adjuntos son solo informativos y aproximados, pudiendo variar, por lo que la presente ' +
  'cotización no obliga a AutoFácil en ninguna manera. La aprobación del crédito está sujeta a la presentación de la ' +
  'documentación requerida y a las políticas de crédito vigentes de AutoFácil y/o de las financieras asociadas.';

// HTML completo y bonito de la cotización (para imprimir y para el cuerpo del correo)
function buildCotizacionHTML(cot, { ejecutivo, emailEjec, standalone = true, baseUrl = '' } = {}) {
  const d = _desglose(cot);
  const tasa = cot.tasa_mensual ? Number(cot.tasa_mensual).toFixed(2) + '%' : '—';
  const cae = d.res.cae != null ? (d.res.cae * 100).toFixed(2) + '%' : '—';
  const logo = `${baseUrl}/img/logo.png`;
  const fila = (l, v, opt = {}) => `<tr${opt.strong ? ' style="font-weight:700"' : ''}>
    <td style="padding:5px 14px;border-bottom:1px solid #eef2f7;color:#374151${opt.strong ? ';font-weight:700' : ''}">${_esc(l)}</td>
    <td style="padding:5px 14px;border-bottom:1px solid #eef2f7;text-align:right;font-variant-numeric:tabular-nums;color:#111827${opt.strong ? ';font-weight:700' : ''}">${_fmt(v)}</td></tr>`;
  const seccion = (titulo, filasHtml) => filasHtml ? `
    <tr><td colspan="2" style="padding:10px 14px 3px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#0141A2">${titulo}</td></tr>${filasHtml}` : '';

  const cuerpo = `
  <div style="max-width:620px;margin:0 auto;background:#fff;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
    <div style="background:linear-gradient(135deg,#012d70,#0141A2 55%,#009AFE);color:#fff;padding:18px 28px;border-radius:14px 14px 0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact">
      <img src="${logo}" alt="AutoFácil" style="height:30px;filter:brightness(0) invert(1)">
      <div style="opacity:.85;font-size:12.5px;margin-top:4px">Crédito Automotriz — Cotización</div>
    </div>
    <div style="padding:14px 28px 16px">
      <div style="font-size:13.5px;margin-bottom:2px"><b>${_tratamiento(cot.nombre_cliente)}(a): ${_esc(cot.nombre_cliente)}</b></div>
      <div style="font-size:12.5px;color:#6b7280">RUT: ${_esc(cot.rut_cliente)}</div>
      <div style="font-size:12.5px;color:#6b7280;margin-bottom:10px">Fecha: ${_fechaLarga(cot.fecha_cotizacion)}</div>
      <p style="font-size:12.5px;line-height:1.45;margin:0 0 12px">${resumenCotizacion(cot)}</p>

      <table style="width:100%;border-collapse:collapse;font-size:12.5px;border:1px solid #e5e9f0;border-radius:10px;overflow:hidden">
        ${seccion('Vehículo', fila('Valor Comercial del Vehículo', cot.valor_vehiculo) + fila('Pie', cot.pie) + fila('Saldo Precio', d.saldoPrecio, { strong: true }))}
        ${seccion('Gastos Operacionales', d.gastos.map(g => fila(g[0], g[1])).join('') + fila('Total Gastos Operacionales', d.totalGastos, { strong: true }))}
        ${d.seguros.length ? seccion('Seguros', d.seguros.map(s => fila(s[0], s[1])).join('') + fila('Total Seguros', d.totalSeg, { strong: true })) : ''}
        ${seccion('Financiamiento', fila('Monto a Financiar', cot.monto_financiado, { strong: true }) +
          `<tr><td style="padding:5px 14px;border-bottom:1px solid #eef2f7;color:#374151">Plazo</td><td style="padding:5px 14px;border-bottom:1px solid #eef2f7;text-align:right">${cot.plazo} meses</td></tr>` +
          `<tr><td style="padding:5px 14px;border-bottom:1px solid #eef2f7;color:#374151">Tasa Mensual</td><td style="padding:5px 14px;border-bottom:1px solid #eef2f7;text-align:right">${tasa}</td></tr>`)}
      </table>

      <table style="width:100%;border-collapse:collapse;margin-top:12px;page-break-inside:avoid">
        <tr>
          <td style="background:linear-gradient(135deg,#0141A2,#009AFE);color:#fff;padding:13px 20px;border-radius:12px 0 0 12px;width:60%;-webkit-print-color-adjust:exact;print-color-adjust:exact">
            <div style="font-size:11.5px;opacity:.85;text-transform:uppercase;letter-spacing:.05em">Cuota Mensual</div>
            <div style="font-size:25px;font-weight:800;margin-top:2px">${_fmt(cot.cuota)}</div>
          </td>
          <td style="background:#eff6ff;padding:13px 20px;border-radius:0 12px 12px 0;text-align:right;-webkit-print-color-adjust:exact;print-color-adjust:exact">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em">CAE</div>
            <div style="font-size:18px;font-weight:800;color:#0141A2">${cae}</div>
            <div style="font-size:11px;color:#64748b;margin-top:3px">${cot.plazo} meses</div>
          </td>
        </tr>
      </table>

      <p style="font-size:10.5px;line-height:1.4;color:#6b7280;margin:12px 0 0;padding:9px 12px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:6px;-webkit-print-color-adjust:exact;print-color-adjust:exact">${DISCLAIMER}</p>

      <div style="margin-top:12px;font-size:12px;color:#374151">
        Atentamente,<br>
        <b>${_esc(ejecutivo || 'Equipo AutoFácil')}</b>${emailEjec ? `<br><span style="color:#6b7280">${_esc(emailEjec)}</span>` : ''}<br>
        <span style="color:#0141A2;font-weight:700">AutoFácil</span>
      </div>
    </div>
  </div>`;

  if (!standalone) return cuerpo;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Cotización ${_esc(cot.nombre_cliente)}</title>
    <style>
      @page { size: letter; margin: 11mm 20mm; }
      html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      body { background:#f0f4f8; margin:0; padding:18px; }
      .hoja { page-break-inside:avoid; }
      @media print { body { background:#fff; padding:0; } }
    </style></head>
    <body><div class="hoja">${cuerpo}</div></body></html>`;
}

async function _cargarCot(id) {
  const [[row]] = await pool.query(
    `SELECT c.id_cotizacion, c.rut_cliente, COALESCE(cl.nombre_completo, c.nombre_cliente) AS nombre_cliente,
            c.fecha_cotizacion, c.valor_vehiculo, c.pie, c.plazo, c.tasa_mensual, c.monto_financiado, c.cuota,
            c.datos_json, cl.email AS cli_email, cl.correo AS cli_correo
     FROM cotizaciones c LEFT JOIN clientes cl ON cl.rut = c.rut_cliente
     WHERE c.id_cotizacion = ? LIMIT 1`, [id]);
  return row;
}

// GET /api/cotizaciones/:id/html → HTML imprimible (el frontend lo inyecta en la ventana de impresión)
const getHtml = async (req, res) => {
  try {
    const cot = await _cargarCot(Number(req.params.id));
    if (!cot) return res.status(404).json({ success: false, data: null, error: 'Cotización no encontrada' });
    const u = req.usuario || {};
    const ejecutivo = `${u.nombre || ''} ${u.apellido || ''}`.trim();
    res.json({ success: true, data: {
      html: buildCotizacionHTML(cot, { ejecutivo, emailEjec: u.email, baseUrl: APP_URL }),
      email_sugerido: cot.cli_email || cot.cli_correo || '',
      nombre_cliente: cot.nombre_cliente,
    }, error: null });
  } catch (e) {
    console.error('[cotizaciones getHtml]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// POST /api/cotizaciones/:id/enviar { email } → envía la cotización por correo
const enviar = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, data: null, error: 'Correo del destinatario inválido' });
    const cot = await _cargarCot(Number(req.params.id));
    if (!cot) return res.status(404).json({ success: false, data: null, error: 'Cotización no encontrada' });

    const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');
    if (!mailConfigurado()) return res.status(400).json({ success: false, data: null, error: 'El correo no está configurado en el servidor' });

    const u = req.usuario || {};
    const ejecutivo = `${u.nombre || ''} ${u.apellido || ''}`.trim();
    const html = buildCotizacionHTML(cot, { ejecutivo, emailEjec: u.email, baseUrl: APP_URL });
    const texto = `${_tratamiento(cot.nombre_cliente)}(a) ${cot.nombre_cliente}:\n\n${resumenCotizacion(cot)}\n\n${DISCLAIMER}\n\nAtentamente,\n${ejecutivo || 'AutoFácil'}`;

    const r = await enviarCorreo({
      to: email,
      replyTo: u.email || undefined,
      subject: `Cotización Crédito Automotriz — AutoFácil`,
      html, text: texto,
    });
    if (!r.ok) return res.status(502).json({ success: false, data: null, error: r.error || 'No se pudo enviar el correo' });
    res.json({ success: true, data: { enviado: true, to: r.to, dev: r.dev }, error: null });
  } catch (e) {
    console.error('[cotizaciones enviar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { create, getAll, getByRut, getHtml, enviar };
