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
    cuerpo: `Estimado Equipo de Contabilidad:

Adjunto encontrarán la Orden de Pago N° {ODP} de la comisión del parque {PARQUE}, período {PERIODO}.

Arriendo mensual: {ARRIENDO}
Comisión por créditos ({OPS} operaciones): {COMISION}
TOTAL A PAGAR: {TOTAL}

Emitida por {QUIEN}. La orden queda por pagar en el módulo Órdenes de Pago.

Saludos cordiales,
Área de Operaciones`,
    para_perfiles: 'Administrador,Tesorero',
    cc: '',
    destinatario: 'Los perfiles marcados aquí abajo (Contabilidad y Tesorería)',
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
    destinatario: 'El correo del DEALER (de su ficha) + ejecutivos de las operaciones y Jefes Comerciales',
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
    destinatario: 'El correo del DEALER (de su ficha)',
    variables: '{dealer} {doc} {numero_factura} {tipo_cuenta} {num_cuenta} {banco} {ops}',
  },
  {
    codigo: 'dealer_pago_reversado',
    ambito: 'Post Venta — Dealers',
    nombre: 'Pago reversado (aviso sin efecto) → al DEALER',
    descripcion: 'Se manda al REVERSAR un pago de saldo precio o comisión cuyo aviso de pago ya había salido (ej.: transferencia rechazada por el banco). Corrige el aviso anterior. Solo se envía si el aviso de pago correspondiente está activo.',
    asunto: 'Importante — aviso de pago sin efecto · Operación {num_op}',
    cuerpo: `Estimado {dealer}:

Te informamos que el aviso de pago del {que_pago} de la operación {num_op} queda SIN EFECTO: el pago fue reversado en nuestro sistema.

Motivo: {motivo}

Nuestro equipo de Tesorería está gestionando la regularización y recibirás un nuevo aviso cuando el pago se realice. Lamentamos el inconveniente.

Equipo AutoFácil`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo del DEALER (de su ficha), con la misma copia del aviso de pago original',
    variables: '{dealer} {num_op} {que_pago} {motivo}',
  },
  {
    codigo: 'dealer_invitacion_portal',
    ambito: 'Post Venta — Dealers',
    nombre: 'Invitación al Portal Dealer (envío masivo)',
    descripcion: 'La invitación comercial al Portal Dealer que se manda desde Atención Remota → Invitar al Portal. Al enviar desde esa pantalla, el texto editado queda GUARDADO acá (es la misma plantilla). {{nombre}} se reemplaza por la razón social de cada dealer.',
    asunto: '🚀 Llegó tu Portal Dealer AutoFácil: tu negocio con nosotros, en línea y en tiempo real',
    cuerpo: `<p>Hola <b>{{nombre}}</b>,</p>
<p>En AutoFácil invertimos en tecnología para que trabajar con nosotros sea <b>más rápido, más transparente y más rentable</b> para ti. Hoy queremos presentarte el nuevo <b>Portal Dealer AutoFácil</b>: tu oficina virtual, abierta 24/7, donde tienes el control total de tu negocio con nosotros.</p>
<p><b>¿Qué puedes hacer desde hoy en tu portal?</b></p>
<ul style="line-height:1.9">
  <li>💰 <b>Saldos de Precio</b> — mira en línea tus operaciones pendientes de pago y en qué etapa exacta va cada una. Se acabó el llamar para preguntar.</li>
  <li>📄 <b>Tus Cartolas</b> — revisa y descarga tus cartolas cuando quieras.</li>
  <li>🧾 <b>Comisiones pendientes</b> — total claridad de lo que tienes por cobrar, al día.</li>
  <li>⚡ <b>Simulador de créditos</b> — cotiza un crédito para tu cliente en segundos, con la tasa y cuota al instante, sin esperar a nadie.</li>
  <li>✅ <b>Pre-aprobación en línea</b> — evalúa a tu cliente al tiro y ciérralo en la primera visita: el que cotiza contigo, compra contigo.</li>
  <li>🤖 <b>Asistente virtual</b> — pregúntale por tus operaciones a cualquier hora y te responde en el momento; y si necesitas a una persona, nuestro equipo te atiende por chat en horario hábil.</li>
</ul>
<p><b>Ingresar es así de simple</b> (2 minutos, una sola vez):</p>
<ol style="line-height:1.9">
  <li>Entra a <a href="https://dealers.autofacilchile.cl">dealers.autofacilchile.cl</a></li>
  <li>Escribe <b>este mismo correo</b> y el <b>RUT de tu empresa</b></li>
  <li>Recibirás tu clave de acceso al instante en este correo, ¡y listo!</li>
</ol>
<p style="margin:22px 0"><a href="https://dealers.autofacilchile.cl" style="display:inline-block;background:#0141A2;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:700;font-size:16px">Quiero entrar a mi portal →</a></p>
<p>Este es el nuevo AutoFácil: <b>tecnología al servicio de tu negocio</b>. Y esto recién comienza.</p>
<p><b>Equipo AutoFácil</b><br><span style="color:#64748b;font-size:13px">Crédito automotriz que sí funciona</span></p>`,
    para_perfiles: '',
    cc: '',
    destinatario: 'Los dealers marcados en la pantalla Invitar al Portal (correo de su ficha)',
    variables: '{{nombre}}',
  },
  {
    codigo: 'odp_proveedor_contabilidad',
    ambito: 'Órdenes de Pago',
    nombre: 'ODP de proveedor emitida → Contabilidad',
    descripcion: 'Se manda automáticamente al EMITIR una Orden de Pago de proveedores (Órdenes de Pago → Emisión). Va al correo de Contabilidad (config correo_contabilidad de Post Venta) con la factura/boleta adjunta si se subió al emitir.',
    asunto: 'Orden de Pago {ODP} — {PROVEEDOR} ({TOTAL})',
    cuerpo: `Estimado Equipo de Contabilidad:

Se emitió la Orden de Pago {ODP} a {PROVEEDOR} (RUT {RUT}).

Concepto: {CONCEPTO}
Documento: {DOC}
Total a pagar: {TOTAL}
Método de pago: {METODO}

Emitida por {QUIEN}. La orden queda por pagar en el módulo Órdenes de Pago.

Saludos cordiales,
Área de Operaciones`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo de Contabilidad (config correo_contabilidad, compartida con Post Venta)',
    variables: '{ODP} {PROVEEDOR} {RUT} {CONCEPTO} {DOC} {TOTAL} {METODO} {QUIEN}',
  },
  {
    codigo: 'odc_finanzas',
    ambito: 'Otras Compras',
    nombre: 'ODC con firma del supervisor → Finanzas',
    descripcion: 'Se manda automáticamente cuando una Orden de Compra (Soporte → Otras Compras) recibe la firma del supervisor (o pasa directo a Finanzas por no tener supervisor asignado). Va al correo de Contabilidad/Finanzas (config correo_contabilidad de Post Venta) con las cotizaciones adjuntas.',
    asunto: 'Orden de Compra {ODC} por aprobar — {PROVEEDOR} ({TOTAL})',
    cuerpo: `Estimado Equipo de Administración y Finanzas:

La Orden de Compra {ODC} a {PROVEEDOR} (RUT {RUT}) tiene la firma del supervisor y espera su aprobación.

Detalle: {DETALLE}
Total: {TOTAL}
Generada por: {QUIEN}
Firma del supervisor: {SUPERVISOR}

Pueden aprobarla o devolverla desde Soporte → Otras Compras (pestaña Por aprobar).

Saludos cordiales,
Área de Operaciones`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo de Contabilidad/Finanzas (config correo_contabilidad, compartida con Post Venta)',
    variables: '{ODC} {PROVEEDOR} {RUT} {DETALLE} {TOTAL} {QUIEN} {SUPERVISOR}',
  },
  {
    codigo: 'vac_progresivas_rrhh',
    ambito: 'Recursos Humanos',
    nombre: 'Vacaciones progresivas validadas → RRHH',
    descripcion: 'Se manda automáticamente cuando un colaborador sube su certificado AFP en Solicitudes → Vacaciones Progresivas y el sistema valida que el beneficio corresponde. Va a RRHH con el informe y el certificado adjuntos; la solicitud queda en Por Aprobar con plazo de 48 horas hábiles.',
    asunto: 'Vacaciones progresivas por aprobar — {NOMBRE} ({DIAS} día/s)',
    cuerpo: `Estimado Equipo de Recursos Humanos:

{NOMBRE} solicitó el reconocimiento de sus vacaciones progresivas (art. 68 del Código del Trabajo).

El certificado de cotizaciones AFP fue validado por el sistema: acredita {ANOS_PREVIOS} años previos y le corresponden {DIAS} día(s) adicional(es) de feriado. Se adjuntan el informe de validación y el certificado.

Tienen 48 horas hábiles para aprobar o rechazar la solicitud en el sistema:
{LINK}

Al aprobar, los años previos quedan en la ficha del colaborador y los días progresivos se depositan automáticamente en su cuenta de vacaciones.

Saludos cordiales,
Auto Fácil Business Suite`,
    para_perfiles: 'Consultora Recursos Humanos',
    cc: '',
    destinatario: 'Los usuarios del perfil Consultora Recursos Humanos (editable acá)',
    variables: '{NOMBRE} {DIAS} {ANOS_PREVIOS} {LINK}',
  },
  {
    codigo: 'parque_cartola_envio',
    ambito: 'Post Venta — Parques',
    nombre: 'Cartola mensual → al PARQUE (con PDF adjunto)',
    descripcion: 'Se manda al pulsar "Enviar cartola" en Emisión de Cartolas Parque. Lleva la cartola en PDF adjunta, con el detalle de cada operación y la línea de arriendo. Es el documento con el que el parque emite su factura.',
    asunto: 'CARTOLA COMISIONES {PERIODO_LARGO} — {PARQUE}',
    cuerpo: `Estimados {PARQUE}:

Junto con saludar, adjuntamos la cartola de comisiones y arriendo correspondiente a {PERIODO_LARGO}, con el detalle de las operaciones del período.

Comisión por créditos ({OPS} operaciones): {COMISION}
Arriendo mensual: {ARRIENDO}

Favor emitir la(s) factura(s) a:
AUTOFACIL SPA — RUT 76.545.638-K
Av. Presidente Kennedy N° 5757, Piso 16 Of. 1601, Las Condes.

Recibida la factura, el pago se procesa vía Orden de Pago.

Cualquier duda quedamos atentos.

Saludos cordiales,
AutoFácil Crédito Automotriz`,
    para_perfiles: '',
    cc: 'operaciones@autofacilchile.cl',
    destinatario: 'El correo del PARQUE (contacto financiero de su ficha, o su correo de confirmación)',
    variables: '{PARQUE} {PERIODO} {PERIODO_LARGO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {QUIEN}',
  },
  {
    codigo: 'parque_pago_aviso',
    ambito: 'Post Venta — Parques',
    nombre: 'Pago realizado → aviso al PARQUE',
    descripcion: 'Se manda al CONFIRMAR el pago de la comisión de un parque. Va al correo de la ficha del parque (contacto financiero, o el correo de confirmación).',
    asunto: 'AutoFácil — Pago de comisión y arriendo {PERIODO} ({TOTAL})',
    cuerpo: `Estimados {PARQUE}:

Les informamos que se realizó el pago correspondiente al período {PERIODO}, según el siguiente detalle:

Arriendo mensual: {ARRIENDO}
Comisión por créditos ({OPS} operaciones): {COMISION}
TOTAL PAGADO: {TOTAL}

Orden de pago N° {ODP}.

Ante cualquier consulta, quedamos a su disposición.

Saludos cordiales,
AutoFácil Crédito Automotriz`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo del PARQUE (contacto financiero de su ficha, o su correo de confirmación)',
    variables: '{PARQUE} {PERIODO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {ODP} {QUIEN}',
  },
  {
    codigo: 'parque_pago_jefe_comercial',
    ambito: 'Post Venta — Parques',
    nombre: 'Pago realizado → aviso interno (Jefe Comercial)',
    descripcion: 'Se manda al CONFIRMAR el pago de la comisión de un parque, al equipo comercial, para que sepan que el parque ya recibió su pago.',
    asunto: 'Comisión pagada — {PARQUE} {PERIODO} ({TOTAL})',
    cuerpo: `Se confirmó el pago de la comisión y arriendo del parque {PARQUE}, período {PERIODO}.

Arriendo mensual: {ARRIENDO}
Comisión por créditos ({OPS} operaciones): {COMISION}
TOTAL PAGADO: {TOTAL}

Orden de pago N° {ODP} · confirmada por {QUIEN}.`,
    para_perfiles: 'Jefe Comercial',
    cc: '',
    destinatario: 'Los perfiles marcados aquí abajo (equipo comercial interno)',
    variables: '{PARQUE} {PERIODO} {ARRIENDO} {COMISION} {OPS} {TOTAL} {ODP} {QUIEN}',
  },
  {
    codigo: 'compras_pedido_aprobado',
    ambito: 'Compras de Oficina',
    nombre: 'Pedido de materiales aprobado → al SOLICITANTE',
    descripcion: 'Se manda automáticamente a CADA persona que hizo un pedido cuando la Orden de Compra del mes completa todas sus firmas. Lleva el detalle producto por producto con la cantidad solicitada y la aprobada, y dónde retirar.',
    asunto: 'Tu pedido de materiales fue aprobado ✔',
    cuerpo: `Hola {nombre}:

Tu pedido de materiales de oficina fue APROBADO. Este es el detalle:

{detalle}

Tus productos estarán disponibles en los próximos días en {despacho}.

Saludos,
Administración`,
    para_perfiles: '',
    cc: '',
    destinatario: 'Cada usuario que hizo un pedido incluido en la Orden de Compra aprobada',
    variables: '{nombre} {detalle} {despacho}',
  },
  {
    codigo: 'pago_recurrente_odp',
    ambito: 'Tesorería',
    nombre: 'Pago recurrente: Orden de Pago generada → TESORERÍA',
    descripcion: 'Sale automáticamente el día del vencimiento de un pago inscrito en Tesorería → Pagos Recurrentes, cuando el sistema emite la Orden de Pago al tipo de cambio del día. Lleva el link directo a la orden para pagarla desde la caja.',
    asunto: 'Orden de Pago {ODP} lista para pagar — {APODO}',
    cuerpo: `Hola:

Se generó automáticamente la Orden de Pago {ODP} del pago recurrente «{APODO}» ({PERIODICIDAD}), con vencimiento el {VENCIMIENTO}.

Proveedor: {PROVEEDOR} (RUT {RUT})
Glosa: {GLOSA}
Monto a pagar: {MONTO}  ·  origen: {ORIGEN}

Queda EMITIDA, pendiente de pago desde la Caja:
{LINK}

Saludos,
Business Suite — Pagos Recurrentes`,
    para_perfiles: 'Tesorero',
    cc: '',
    destinatario: 'Los perfiles marcados aquí abajo (Tesorería)',
    variables: '{APODO} {ODP} {PROVEEDOR} {RUT} {GLOSA} {MONTO} {ORIGEN} {VENCIMIENTO} {PERIODICIDAD} {LINK}',
  },
  {
    codigo: 'pago_recurrente_pagado',
    ambito: 'Tesorería',
    nombre: 'Pago recurrente PAGADO → al PROVEEDOR',
    descripcion: 'Se manda al correo del proveedor (ficha de Proveedores) cuando la Caja paga una Orden de Pago nacida de un pago recurrente. Informa la glosa del período, el monto y la fecha.',
    asunto: 'Pago realizado — {GLOSA}',
    cuerpo: `Estimados {PROVEEDOR}:

Les informamos que con fecha {FECHA_PAGO} se realizó el pago correspondiente a:

{GLOSA}
Monto: {MONTO}
Referencia interna: Orden de Pago {ODP}

Cualquier consulta, responder a este correo.

Atentamente,
AutoFácil Crédito Automotriz — Tesorería`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo del proveedor registrado en su ficha (Órdenes de Pago → Proveedores)',
    variables: '{PROVEEDOR} {GLOSA} {MONTO} {ODP} {FECHA_PAGO}',
  },
  {
    codigo: 'cliente_comprobante_cuota',
    ambito: 'Cobranza',
    nombre: 'Comprobante de pago de cuotas → al CLIENTE',
    descripcion: 'Se manda automáticamente al CLIENTE cuando se aprueba una ODP de Cuotas (Cobranza → Pago de Cuotas / Tesorería → ODP Cuotas). Sale desde la cuenta de Cobranza, con el Comprobante de Pago en PDF adjunto. En copia oculta (CCO) van SIEMPRE quien solicitó la ODP y quien aprobó el pago, más los correos del campo CCO. Después de este texto va la tabla con el detalle de las cuotas pagadas y el total — estructura fija.',
    asunto: 'Comprobante de pago — Crédito N° {num_credito} ({trx})',
    cuerpo: `Estimado(a) {cliente}:

Confirmamos el pago registrado para su crédito N° {num_credito}.
Comprobante {trx} · {fecha}.`,
    para_perfiles: '',
    cc: '',
    destinatario: 'El correo del CLIENTE (de su ficha en Clientes); BCC a quien solicitó la ODP',
    variables: '{cliente} {num_credito} {trx} {fecha} {total} {origen} {n_cuotas}',
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
    destinatario  VARCHAR(200) NULL,
    activo        TINYINT(1) NOT NULL DEFAULT 1,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  // Tablas ya creadas antes de que existiera la columna
  await pool.query('ALTER TABLE correos_plantillas ADD COLUMN IF NOT EXISTS destinatario VARCHAR(200) NULL').catch(() => {});
  // CCO (copia oculta) fija y editable por plantilla — pedido para el comprobante al cliente (26-08-2026)
  await pool.query("ALTER TABLE correos_plantillas ADD COLUMN IF NOT EXISTS cco VARCHAR(500) NOT NULL DEFAULT ''").catch(() => {});
  // Remitente paramétrico por plantilla (clave de mailer.cuentasRemitente) — pedido Pato 01-09-2026:
  // las cartolas de dealers y parques salen desde comisiones@, elegible en el mantenedor.
  await pool.query("ALTER TABLE correos_plantillas ADD COLUMN IF NOT EXISTS remitente VARCHAR(30) NOT NULL DEFAULT 'sistema'").catch(() => {});
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
    await pool.query('UPDATE correos_plantillas SET descripcion=?, variables=?, ambito=?, nombre=?, destinatario=? WHERE codigo=?',
      [p.descripcion, p.variables, p.ambito, p.nombre, p.destinatario || null, p.codigo]);
  }
});

/* CCO del comprobante al cliente: nace con contabilidad@ (pedido de Pato 26-08-2026).
   Solo se siembra una vez; después lo administra el mantenedor. */
require('./migrate').migrar('comprobante-cuota-cco-contabilidad', async () => {
  await pool.query(
    "UPDATE correos_plantillas SET cco='contabilidad@autofacilchile.cl' WHERE codigo='cliente_comprobante_cuota' AND cco=''");
});

/* dealer_pago_reversado se sembró unas horas sin {motivo}: si nadie lo editó
   (sigue igual al default viejo), se actualiza al texto con el motivo. */
require('./migrate').migrar('correo-reversa-con-motivo', async () => {
  const p = SEMILLAS.find(x => x.codigo === 'dealer_pago_reversado');
  if (p) await pool.query(
    "UPDATE correos_plantillas SET cuerpo=? WHERE codigo=? AND cuerpo NOT LIKE '%{motivo}%'",
    [p.cuerpo, p.codigo]);
});

/* Cartolas y avisos de pago a dealers y parques salen desde comisiones@ (pedido
   Pato 01-09-2026). Se siembra UNA vez; después el remitente lo elige el
   Administrador en el mantenedor Correos del Sistema. */
require('./migrate').migrar('correos-remitente-comisiones-2026-09', async () => {
  await pool.query(
    "UPDATE correos_plantillas SET remitente='comisiones' WHERE codigo IN ('dealer_cartola_envio','dealer_comision_pagada','dealer_pago_reversado','parque_cartola_envio','parque_pago_aviso')");
});

/* Los 4 correos de parques nacieron con el cuerpo en HTML crudo: en el
   mantenedor se veían como una maraña de etiquetas. Se pasan a texto plano UNA
   vez, y solo si nadie los editó todavía (siguen idénticos a como se sembraron). */
require('./migrate').migrar('correos-parques-texto-plano', async () => {
  for (const p of SEMILLAS.filter(x => x.codigo.startsWith('parque_'))) {
    await pool.query(
      "UPDATE correos_plantillas SET cuerpo=? WHERE codigo=? AND cuerpo LIKE '<%'",
      [p.cuerpo, p.codigo]);
  }
});

const obtener = async codigo => {
  const [[p]] = await pool.query('SELECT * FROM correos_plantillas WHERE codigo=?', [codigo]);
  return p || null;
};

/* Reemplaza {VARIABLE} por su valor. Lo que no venga en datos queda vacío, nunca
   como "{VARIABLE}" a la vista del destinatario. */
// Formato y variables: motor puro compartido (probado en tests/correo-formato.test.js)
const { esHTML, aHTML, render } = require('./correo-formato');

/* Correos de los usuarios activos de una lista de perfiles (CSV). */
async function correosDePerfiles(csv) {
  const perfiles = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!perfiles.length) return [];
  const [us] = await pool.query(
    `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
      WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado <> 'inactivo') AND u.email IS NOT NULL
        AND COALESCE(u.externo, 0) = 0`,
    [perfiles]);
  return us.map(u => u.email).filter(Boolean);
}

/* Envía una plantilla. Devuelve { enviado, motivo?, to, cc }.
   NUNCA lanza: un correo que falla no puede voltear la operación que lo dispara. */
async function enviar({ codigo, to = [], cc: ccExtra = [], datos = {}, adjuntos } = {}) {
  try {
    const p = await obtener(codigo);
    if (!p) return { enviado: false, motivo: 'plantilla inexistente: ' + codigo };
    if (!p.activo) return { enviado: false, motivo: 'plantilla desactivada en el mantenedor' };

    const { enviarCorreo, mailConfigurado, envolverHTML, remitentePorClave } = require('./mailer');
    if (!mailConfigurado()) return { enviado: false, motivo: 'correo no configurado' };

    const dest = [...new Set([...(Array.isArray(to) ? to : [to]), ...(await correosDePerfiles(p.para_perfiles))]
      .map(s => String(s || '').trim()).filter(Boolean))];
    if (!dest.length) return { enviado: false, motivo: 'sin destinatarios' };
    // CC = lo configurado en la plantilla + lo que agregue el llamador (ej. quien generó la orden)
    const cc = [...new Set([...String(p.cc || '').split(','), ...(Array.isArray(ccExtra) ? ccExtra : [ccExtra])]
      .map(s => String(s || '').trim().toLowerCase()).filter(Boolean))];

    const cco = String(p.cco || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const cuerpo = render(p.cuerpo, datos);
    await enviarCorreo({
      from: remitentePorClave(p.remitente),   // remitente elegido en el mantenedor
      to: dest, cc: cc.length ? cc : undefined, bcc: cco.length ? cco : undefined,
      subject: render(p.asunto, datos),
      html: envolverHTML(aHTML(cuerpo)),
      text: esHTML(cuerpo) ? undefined : cuerpo,
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
  if (p) return { asunto: p.asunto, cuerpo: p.cuerpo, firma: '', activo: !!p.activo, cc: p.cc || '', remitente: p.remitente || 'sistema' };
  if (claveLegado) {
    const [[old]] = await pool.query('SELECT valor FROM postventa_config WHERE clave=?', [claveLegado]).catch(() => [[null]]);
    if (old) { try { return { ...JSON.parse(old.valor), cc: '' }; } catch (_) {} }
  }
  return { asunto: '', cuerpo: '', firma: '', activo: true, cc: '' };
}

module.exports = { enviar, obtener, render, aHTML, esHTML, correosDePerfiles, comoTpl, SEMILLAS };
