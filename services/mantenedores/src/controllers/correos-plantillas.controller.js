'use strict';
/* Mantenedor "Correos del Sistema": el Administrador edita el TEXTO de cada
   correo automático, lo activa o desactiva, y define la copia (CC).
   El envío en sí lo hace el motor único shared/plantillas-correo.js. */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const plantillas = require('../../../../shared/plantillas-correo');

/* SIN funcionalidad propia: los correos se administran DENTRO de Post Venta →
   Mantenedores (decisión de Pato 13-08-2026, "todos los correos en una sola
   parte"), así que la pantalla y el permiso son los de esa página
   (postventa_mantenedores). Una card aparte solo volvería a partir en dos lo
   que se acaba de juntar. /mantenedores/correos/ queda redirigiendo allá. */

// GET /api/correos-plantillas
const listar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM correos_plantillas ORDER BY ambito, nombre');
    const [perfiles] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
    res.json({ success: true, data: { rows, perfiles: perfiles.map(p => p.nombre) }, error: null });
  } catch (e) { console.error('[correos listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// PUT /api/correos-plantillas/:codigo  {asunto, cuerpo, para_perfiles, cc, activo}
const guardar = async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    const { asunto, cuerpo, para_perfiles, cc, cco, activo } = req.body || {};
    const [[prev]] = await pool.query('SELECT * FROM correos_plantillas WHERE codigo=?', [codigo]);
    if (!prev) return res.status(404).json({ success: false, data: null, error: 'Plantilla no encontrada' });
    if (!String(asunto || '').trim()) return res.status(400).json({ success: false, data: null, error: 'El asunto no puede quedar vacío' });
    if (!String(cuerpo || '').trim()) return res.status(400).json({ success: false, data: null, error: 'El cuerpo no puede quedar vacío' });
    // CC: se valida el formato para no descubrir el error recién cuando el correo rebota
    const ccList = String(cc || '').split(',').map(s => s.trim()).filter(Boolean);
    const ccoList = String(cco || '').split(',').map(s => s.trim()).filter(Boolean);
    const malos = [...ccList, ...ccoList].filter(m => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m));
    if (malos.length) return res.status(400).json({ success: false, data: null, error: 'Correo inválido en la copia: ' + malos.join(', ') });

    await pool.query(
      `UPDATE correos_plantillas SET asunto=?, cuerpo=?, para_perfiles=?, cc=?, cco=?, activo=? WHERE codigo=?`,
      [String(asunto).trim(), String(cuerpo).trim(), String(para_perfiles || '').trim(),
       ccList.join(', '), ccoList.join(', '), activo ? 1 : 0, codigo]);

    const cambios = [];
    if (prev.asunto !== String(asunto).trim()) cambios.push('asunto');
    if (prev.cuerpo !== String(cuerpo).trim()) cambios.push('cuerpo');
    if (prev.para_perfiles !== String(para_perfiles || '').trim()) cambios.push(`destinatarios "${prev.para_perfiles}" → "${para_perfiles}"`);
    if (prev.cc !== ccList.join(', ')) cambios.push(`copia "${prev.cc}" → "${ccList.join(', ')}"`);
    if (!!prev.activo !== !!activo) cambios.push(activo ? 'ACTIVADO' : 'DESACTIVADO');
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'correo_plantilla',
      detalle: `Editó el correo "${prev.nombre}" (${codigo}): ${cambios.join(' · ') || 'sin cambios'}` });
    res.json({ success: true, data: { codigo }, error: null });
  } catch (e) { console.error('[correos guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* POST /api/correos-plantillas/:codigo/prueba {email} — manda el correo a UNA
   casilla con datos de ejemplo. Ver el correo antes de que lo reciba un parque
   es la única forma de saber si el texto quedó bien. */
const prueba = async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    const email = String(req.body?.email || req.usuario?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ success: false, data: null, error: 'Indica un correo válido para la prueba' });
    const p = await plantillas.obtener(codigo);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Plantilla no encontrada' });

    // Ejemplos para TODAS las variables en uso (parques en MAYÚSCULA, dealer en minúscula)
    const EJEMPLO = { ODP: 'ODP2600123', PARQUE: 'PARQUE EJEMPLO', PERIODO: '2026-07',
      PERIODO_LARGO: 'julio 2026', ARRIENDO: '$250.000', COMISION: '$1.234.567',
      OPS: 8, TOTAL: '$1.484.567',
      QUIEN: req.usuario ? [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') : 'Sistema',
      dealer: 'AUTOMOTORA DE PRUEBA SPA', mes: 'julio 2026', total: '$1.234.567',
      doc: 'factura', numero_factura: '12345', tipo_cuenta: 'cuenta corriente',
      num_cuenta: '00-123-45678-9', banco: 'BANCO DE CHILE', ops: '26080001, 26080002',
      // Comprobante de cuotas al cliente
      cliente: 'CLIENTE DE PRUEBA GONZÁLEZ', num_credito: '26080001', trx: 'TRX-000123',
      fecha: new Date().toLocaleDateString('es-CL'), origen: 'Transferencia', n_cuotas: 2 };

    /* Comprobante de cuotas: la tabla y la caja del total son estructura fija que
       se agrega DESPUÉS del texto en el envío real — la prueba la incluye con
       cuotas de ejemplo para ver el correo completo (mismo motor del envío). */
    let extraHTML = '', adjuntosPrueba;
    if (codigo === 'cliente_comprobante_cuota') {
      const CUOTAS_EJ = [
        { numero_cuota: 7, fecha_vencimiento: '2026-07-05', fecha_pago: new Date().toISOString(), monto_cuota: 250000, interes_mora: 3450, gastos_cobranza: 12000, total_pagado: 265450 },
        { numero_cuota: 8, fecha_vencimiento: '2026-08-05', fecha_pago: new Date().toISOString(), monto_cuota: 250000, interes_mora: 0, gastos_cobranza: 0, total_pagado: 250000 },
      ];
      try {
        const { tablaComprobanteHTML } = require('../../../cobranza/src/controllers/odp-cuotas.controller');
        extraHTML = tablaComprobanteHTML({ cuotas: CUOTAS_EJ, total: 515450, origen: 'Transferencia' });
        EJEMPLO.total = '$515.450'; EJEMPLO.n_cuotas = 2;
      } catch (e) { console.error('[correos prueba tabla]', e.message); }
      // El PDF adjunto de la prueba: mismo motor del envío real
      try {
        const { generarComprobantePDF } = require('../../../../shared/comprobante-pago-pdf');
        const buf = await generarComprobantePDF({
          credito: { numero_credito: EJEMPLO.num_credito, nombre_cliente: EJEMPLO.cliente, rut_cliente: '12.345.678-9' },
          pagos: CUOTAS_EJ, trxNum: 123,
          horaPago: new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false }),
        });
        adjuntosPrueba = [{ filename: 'Comprobante-TRX-000123.pdf', content: buf, contentType: 'application/pdf' }];
      } catch (e) { console.error('[correos prueba pdf]', e.message); }
    }

    const { enviarCorreo, mailConfigurado, envolverHTML } = require('../../../../shared/mailer');
    if (!mailConfigurado()) return res.status(400).json({ success: false, data: null, error: 'El correo del sistema no está configurado' });
    // La prueba va SOLO a quien la pide: nunca a los perfiles ni al CC de la plantilla.
    await enviarCorreo({
      to: [email],
      subject: '[PRUEBA] ' + plantillas.render(p.asunto, EJEMPLO),
      html: envolverHTML(
        '<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:10px;margin-bottom:14px;font-size:.85rem;color:#9a3412">' +
        '<b>Correo de PRUEBA</b> — datos de ejemplo. El envío real usa los datos de la operación y va a sus destinatarios.</div>' +
        // aHTML: respeta los saltos de línea del texto plano, igual que el envío real
        plantillas.aHTML(plantillas.render(p.cuerpo, EJEMPLO)) + extraHTML),
      attachments: adjuntosPrueba,
    });
    auditar({ req, accion: 'ENVIAR', modulo: 'mantenedores', entidad: 'correo_plantilla',
      detalle: `Envió prueba del correo "${p.nombre}" (${codigo}) a ${email}` });
    res.json({ success: true, data: { email }, error: null });
  } catch (e) { console.error('[correos prueba]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, guardar, prueba };
