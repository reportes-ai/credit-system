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
  /* ── Cartolas y comisiones de DEALER ──────────────────────────────────────
     Vivían en postventa_config como JSON {asunto,cuerpo,firma,activo}, editables
     en Post Venta → Mantenedores. Se traen acá para que TODOS los correos del
     sistema se administren en un solo lugar. `importarDe` hace que la semilla
     tome el texto que ya estaba configurado, en vez de pisarlo con el default.
     El envío no cambió: sigue saliendo de comisiones@ con su CC dinámico
     (ejecutivos de la cartola + Jefes Comerciales), al que ahora se suma el CC
     fijo de la plantilla. */
  {
    codigo: 'dealer_cartola_envio',
    ambito: 'Post Venta — Dealers',
    nombre: 'Cartola mensual → al DEALER (con PDF adjunto)',
    descripcion: 'Se manda al pulsar "Enviar Cartola" en Emisión de Cartolas (Cartas de Aprobación → Revisión Cartolas). Sale desde comisiones@ con la cartola en PDF adjunta. Además del CC de acá, siempre copia a los ejecutivos de las operaciones y a los Jefes Comerciales.',
    importarDe: 'correo_cartola_dealer',
    asunto: 'Cartola de comisiones {mes} — {dealer}',
    cuerpo: `Estimados {dealer}:

Junto con saludar, adjuntamos la cartola de comisiones correspondiente a {mes}, por un total de {total}.

Favor emitir la factura por el total indicado.

Saludos cordiales,
AutoFácil Crédito Automotriz`,
    para_perfiles: '',
    cc: 'comisiones@autofacilchile.cl',
    variables: '{dealer} {mes} {total}',
  },
  {
    codigo: 'dealer_comision_pagada',
    ambito: 'Post Venta — Dealers',
    nombre: 'Comisión pagada → al DEALER',
    descripcion: 'Se manda al confirmar el pago de la comisión de un dealer, una vez por factura. Sale desde comisiones@ al correo del dealer.',
    importarDe: 'correo_comision_pagada',
    asunto: 'Pago de comisión — {dealer}',
    cuerpo: `Estimados {dealer}:

Les informamos que se realizó el pago de la comisión correspondiente a su {doc} N° {numero_factura}, a la {tipo_cuenta} N° {num_cuenta} del {banco}.

Operaciones incluidas: {ops}

Saludos cordiales,
AutoFácil Crédito Automotriz`,
    para_perfiles: '',
    cc: 'comisiones@autofacilchile.cl',
    variables: '{dealer} {doc} {numero_factura} {tipo_cuenta} {num_cuenta} {banco} {ops}',
  },
  {
    codigo: 'parque_cartola_envio',
    ambito: 'Post Venta — Parques',
    nombre: 'Cartola mensual → al PARQUE (con PDF adjunto)',
    descripcion: 'Se manda al pulsar "Enviar cartola" en Emisión de Cartolas Parque. Lleva la cartola en PDF adjunta, con el detalle de cada operación y la línea de arriendo. Es el documento con el que el parque emite su factura.',
    asunto: 'CARTOLA COMISIONES {PERIODO_LARGO} — {PARQUE}',
    cuerpo: `<p>Estimados {PARQUE}:</p>
<p>Junto con saludar, adjuntamos la <b>cartola de comisiones y arriendo</b> correspondiente a {PERIODO_LARGO}, con el detalle de las operaciones del período.</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #e2e8f0">
  <tr style="background:#012d70;color:#fff"><th align="left">Concepto</th><th align="right">Monto</th></tr>
  <tr><td>Comisión por créditos ({OPS} operaciones)</td><td align="right">{COMISION}</td></tr>
  <tr><td>Arriendo mensual</td><td align="right">{ARRIENDO}</td></tr>
  <tr style="font-weight:700;background:#f1f5f9"><td>TOTAL BRUTO A PAGAR (IVA incluido)</td><td align="right">{TOTAL}</td></tr>
</table>
<p>Favor emitir la <b>factura por el total indicado</b> a:<br>
<b>AUTOFACIL SPA</b> — RUT 76.545.638-K<br>
Av. Presidente Kennedy N° 5757, Piso 16 Of. 1601, Las Condes.</p>
<p>Recibida la factura, el pago se procesa vía Orden de Pago.</p>
<p>Cualquier duda quedamos atentos.</p>
<p>Saludos cordiales,<br><b>AutoFácil — Crédito Automotriz</b></p>`,
    para_perfiles: '',
    cc: 'operaciones@autofacilchile.cl',
    variables: '{PARQUE} {PERIODO} {PERIODO_LARGO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {QUIEN}',
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
    let { asunto, cuerpo, cc } = p, activo = 1;
    /* Plantilla que ya existía en postventa_config: se importa TAL COMO ESTÁ
       configurada hoy (con su firma pegada al cuerpo y su interruptor), para
       que mudarla de mantenedor no cambie ni una coma de lo que se envía. */
    if (p.importarDe) {
      try {
        const [[old]] = await pool.query('SELECT valor FROM postventa_config WHERE clave=?', [p.importarDe]);
        const v = old ? JSON.parse(old.valor) : null;
        if (v) {
          if (v.asunto) asunto = v.asunto;
          if (v.cuerpo) cuerpo = v.cuerpo + (v.firma ? '\n\n' + v.firma : '');
          if (v.activo === false) activo = 0;
        }
      } catch (e) { console.error('[correos importar ' + p.importarDe + ']', e.message); }
    }
    await pool.query(
      `INSERT IGNORE INTO correos_plantillas
         (codigo, ambito, nombre, descripcion, asunto, cuerpo, para_perfiles, cc, variables, activo)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [p.codigo, p.ambito, p.nombre, p.descripcion, asunto, cuerpo, p.para_perfiles, cc, p.variables, activo]);
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
/* Acepta {MAYUSCULAS} y {minusculas} (las plantillas de dealer usan minúscula).
   Una variable sin dato queda vacía, nunca "{VARIABLE}" a la vista del que recibe. */
const render = (texto, datos = {}) =>
  String(texto || '').replace(/\{(\w+)\}/g, (_, k) =>
    (datos[k] != null ? String(datos[k])
      : datos[k.toUpperCase()] != null ? String(datos[k.toUpperCase()])
      : datos[k.toLowerCase()] != null ? String(datos[k.toLowerCase()]) : ''));

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

/* Adaptador para los envíos que ya tenían su propia mecánica (cartola y comisión
   pagada del dealer: remitente comisiones@, CC dinámico con los ejecutivos y los
   Jefes Comerciales, cuerpo en texto plano). Devuelve el MISMO shape que traían
   de postventa_config, así que solo cambia DE DÓNDE sale la plantilla — el envío
   queda intacto. `firma` va vacía porque al importar quedó pegada al cuerpo.
   Si la plantilla aún no existe, cae a postventa_config y nada se detiene. */
async function comoTpl(codigo, claveLegado) {
  const p = await obtener(codigo);
  if (p) return { asunto: p.asunto, cuerpo: p.cuerpo, firma: '', activo: !!p.activo, cc: p.cc || '' };
  if (claveLegado) {
    const [[old]] = await pool.query('SELECT valor FROM postventa_config WHERE clave=?', [claveLegado]).catch(() => [[null]]);
    if (old) { try { return { ...JSON.parse(old.valor), cc: '' }; } catch (_) {} }
  }
  return { asunto: '', cuerpo: '', firma: '', activo: true, cc: '' };
}

module.exports = { enviar, obtener, render, correosDePerfiles, comoTpl, SEMILLAS };
