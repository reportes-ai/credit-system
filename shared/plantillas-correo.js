'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO de plantillas de correo paramétricas.

   El texto de un correo del sistema es un dato de negocio, no código: quién lo
   recibe, qué dice y si se manda o no lo decide el Administrador desde el
   mantenedor (Principio Rector: parametrizar el contenido, no la estructura).

   Cada plantilla vive en `correos_plantillas` con:
     · asunto y cuerpo con variables {ASI}   · activo (interruptor)
     · para_perfiles → perfiles que lo reciben (además del destinatario que
       pase el código, por ejemplo el correo del parque)
     · cc → copia fija, editable, separada por comas

   El envío sale por el motor único de correo (shared/mailer), así que queda en
   `correos_log` y se ve en Auditoría → Correos Enviados.
   ═══════════════════════════════════════════════════════════════════════════ */
const pool = require('./config/database');

/* Registro de plantillas del sistema: se siembran una vez y desde ahí las edita
   el Administrador. Agregar una plantilla nueva = agregar acá su semilla. */
const SEMILLAS = [
  {
    codigo: 'parque_odp_contabilidad',
    ambito: 'Post Venta — Parques',
    nombre: 'Orden de Pago de parque → Contabilidad',
    descripcion: 'Se manda al EMITIR la orden de pago de la comisión de un parque. Es el aviso a Contabilidad y Tesorería de que hay una ODP por pagar.',
    asunto: 'OP {ODP} — Comisión Parque {PARQUE} {PERIODO} ({TOTAL})',
    cuerpo: `<h2 style="color:#012d70">Orden de Pago {ODP} — Comisión Parque</h2>
<p><b>Parque:</b> {PARQUE}<br><b>Período:</b> {PERIODO}</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #e2e8f0">
  <tr style="background:#012d70;color:#fff"><th align="left">Concepto</th><th align="right">Monto</th></tr>
  <tr><td>Arriendo mensual</td><td align="right">{ARRIENDO}</td></tr>
  <tr><td>Comisión por créditos ({OPS} operaciones)</td><td align="right">{COMISION}</td></tr>
  <tr style="font-weight:700;background:#f1f5f9"><td>TOTAL A PAGAR</td><td align="right">{TOTAL}</td></tr>
</table>
<p>Emitida por {QUIEN}. La orden queda <b>por pagar</b> en el módulo Órdenes de Pago.</p>`,
    para_perfiles: 'Administrador,Tesorero',
    cc: '',
    variables: '{ODP} {PARQUE} {PERIODO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {QUIEN}',
  },
  {
    codigo: 'parque_pago_aviso',
    ambito: 'Post Venta — Parques',
    nombre: 'Pago realizado → aviso al PARQUE',
    descripcion: 'Se manda al CONFIRMAR el pago de la comisión de un parque. Va al correo de la ficha del parque (contacto financiero, o el correo de confirmación).',
    asunto: 'AutoFácil — Pago de comisión y arriendo {PERIODO} ({TOTAL})',
    cuerpo: `<h2 style="color:#012d70">Pago realizado — {PARQUE}</h2>
<p>Estimados,</p>
<p>Les informamos que se realizó el pago correspondiente al período <b>{PERIODO}</b>, según el siguiente detalle:</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #e2e8f0">
  <tr style="background:#012d70;color:#fff"><th align="left">Concepto</th><th align="right">Monto</th></tr>
  <tr><td>Arriendo mensual</td><td align="right">{ARRIENDO}</td></tr>
  <tr><td>Comisión por créditos ({OPS} operaciones)</td><td align="right">{COMISION}</td></tr>
  <tr style="font-weight:700;background:#f1f5f9"><td>TOTAL PAGADO</td><td align="right">{TOTAL}</td></tr>
</table>
<p>Orden de pago N° <b>{ODP}</b>.</p>
<p>Ante cualquier consulta, quedamos a su disposición.</p>
<p>Saludos cordiales,<br><b>AutoFácil — Crédito Automotriz</b></p>`,
    para_perfiles: '',
    cc: '',
    variables: '{PARQUE} {PERIODO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {ODP} {QUIEN}',
  },
  {
    codigo: 'parque_pago_jefe_comercial',
    ambito: 'Post Venta — Parques',
    nombre: 'Pago realizado → aviso interno (Jefe Comercial)',
    descripcion: 'Se manda al CONFIRMAR el pago de la comisión de un parque, al equipo comercial, para que sepan que el parque ya recibió su pago.',
    asunto: 'Comisión pagada — {PARQUE} {PERIODO} ({TOTAL})',
    cuerpo: `<h2 style="color:#012d70">Comisión de parque pagada</h2>
<p>Se confirmó el pago de la comisión y arriendo del parque <b>{PARQUE}</b>, período <b>{PERIODO}</b>.</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #e2e8f0">
  <tr style="background:#012d70;color:#fff"><th align="left">Concepto</th><th align="right">Monto</th></tr>
  <tr><td>Arriendo mensual</td><td align="right">{ARRIENDO}</td></tr>
  <tr><td>Comisión por créditos ({OPS} operaciones)</td><td align="right">{COMISION}</td></tr>
  <tr style="font-weight:700;background:#f1f5f9"><td>TOTAL PAGADO</td><td align="right">{TOTAL}</td></tr>
</table>
<p>Orden de pago N° <b>{ODP}</b> · confirmada por {QUIEN}.</p>`,
    para_perfiles: 'Jefe Comercial',
    cc: '',
    variables: '{PARQUE} {PERIODO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {ODP} {QUIEN}',
  },
];

require('./migrate').enFila('correos-plantillas', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS correos_plantillas (
    codigo        VARCHAR(60)  NOT NULL PRIMARY KEY,
    ambito        VARCHAR(60)  NOT NULL DEFAULT 'General',
    nombre        VARCHAR(160) NOT NULL,
    descripcion   VARCHAR(500) NULL,
    asunto        VARCHAR(250) NOT NULL,
    cuerpo        TEXT NOT NULL,
    para_perfiles VARCHAR(300) NOT NULL DEFAULT '',
    cc            VARCHAR(500) NOT NULL DEFAULT '',
    variables     VARCHAR(500) NULL,
    activo        TINYINT(1) NOT NULL DEFAULT 1,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  /* INSERT IGNORE: la semilla define el texto ORIGINAL, nunca pisa lo que el
     Administrador haya editado después (ese es el punto de tenerlo en mantenedor). */
  for (const p of SEMILLAS) {
    await pool.query(
      `INSERT IGNORE INTO correos_plantillas
         (codigo, ambito, nombre, descripcion, asunto, cuerpo, para_perfiles, cc, variables, activo)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [p.codigo, p.ambito, p.nombre, p.descripcion, p.asunto, p.cuerpo, p.para_perfiles, p.cc, p.variables]);
    // La descripción y las variables son documentación, no contenido editable: se refrescan.
    await pool.query('UPDATE correos_plantillas SET descripcion=?, variables=?, ambito=?, nombre=? WHERE codigo=?',
      [p.descripcion, p.variables, p.ambito, p.nombre, p.codigo]);
  }
});

const obtener = async codigo => {
  const [[p]] = await pool.query('SELECT * FROM correos_plantillas WHERE codigo=?', [codigo]);
  return p || null;
};

/* Reemplaza {VARIABLE} por su valor. Lo que no venga en datos queda vacío, nunca
   como "{VARIABLE}" a la vista del destinatario. */
const render = (texto, datos = {}) =>
  String(texto || '').replace(/\{([A-Z_0-9]+)\}/g, (_, k) => (datos[k] == null ? '' : String(datos[k])));

/* Correos de los usuarios activos de una lista de perfiles (CSV). */
async function correosDePerfiles(csv) {
  const perfiles = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!perfiles.length) return [];
  const [us] = await pool.query(
    `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
      WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado <> 'inactivo') AND u.email IS NOT NULL`,
    [perfiles]);
  return us.map(u => u.email).filter(Boolean);
}

/* Envía una plantilla. Devuelve { enviado, motivo?, to, cc }.
   NUNCA lanza: un correo que falla no puede voltear la operación que lo dispara. */
async function enviar({ codigo, to = [], datos = {}, adjuntos } = {}) {
  try {
    const p = await obtener(codigo);
    if (!p) return { enviado: false, motivo: 'plantilla inexistente: ' + codigo };
    if (!p.activo) return { enviado: false, motivo: 'plantilla desactivada en el mantenedor' };

    const { enviarCorreo, mailConfigurado, envolverHTML } = require('./mailer');
    if (!mailConfigurado()) return { enviado: false, motivo: 'correo no configurado' };

    const dest = [...new Set([...(Array.isArray(to) ? to : [to]), ...(await correosDePerfiles(p.para_perfiles))]
      .map(s => String(s || '').trim()).filter(Boolean))];
    if (!dest.length) return { enviado: false, motivo: 'sin destinatarios' };
    const cc = String(p.cc || '').split(',').map(s => s.trim()).filter(Boolean);

    await enviarCorreo({
      to: dest, cc: cc.length ? cc : undefined,
      subject: render(p.asunto, datos),
      html: envolverHTML(render(p.cuerpo, datos)),
      attachments: adjuntos,
    });
    return { enviado: true, to: dest, cc };
  } catch (e) {
    console.error('[plantillas-correo ' + codigo + ']', e.message);
    return { enviado: false, motivo: e.message };
  }
}

module.exports = { enviar, obtener, render, correosDePerfiles, SEMILLAS };
