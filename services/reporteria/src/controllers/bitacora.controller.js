'use strict';
/* ───────────────────────────────────────────────────────────────────
   Bitácora de un Crédito — agregador de eventos read-only.

   Reúne en una sola línea de tiempo TODO lo que le pasó a un cliente /
   crédito: alta del cliente, informes DealerNet, antecedentes, cotizaciones,
   documentos de evaluación, ciclo completo de la Carta de Aprobación
   (creación, aprobación, excepciones, rechazo, otorgamiento, desistimiento),
   bitácora interna del crédito (auditoria_credito: creación, documentos,
   pagos, validaciones, cambios de estado), post-venta, cobranza y CRM.

   Búsqueda por RUT (cliente), N° Operación (num_op / numero_credito) o
   ID Financiera (id_financiera).

   Cada fuente va en su propio try/catch: si una tabla no existe en este
   ambiente, aporta cero eventos en vez de romper el informe.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

/* ─── Seed de la funcionalidad/permiso (paramétrico, igual que el resto) ── */
(async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/reporteria/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]]  = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rep_bitacora'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Bitácora de un Crédito', 'rep_bitacora', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ funcionalidad rep_bitacora registrada');
  } catch (e) { console.error('[bitacora seed]', e.message); }
})();

/* ─── Helpers ──────────────────────────────────────────────────────── */
const normRut = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
const RUT_SQL = col => `REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),' ','')`;
const clp = n => (n == null || isNaN(n)) ? null : '$' + Math.round(Number(n)).toLocaleString('es-CL');

// Parser tolerante para columnas JSON (mysql2 las entrega parseadas, pero por si vienen como texto)
function asJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/* ─── GET /api/bitacora?tipo=rut|op|id&valor=… ─────────────────────── */
const buscar = async (req, res) => {
  const tipo  = String(req.query.tipo || 'rut').toLowerCase();
  const valor = String(req.query.valor || '').trim();
  if (!valor) return res.json({ success: true, data: { encontrado: false }, error: null });

  try {
    let cliente = null, creditos = [], cartas = [];

    /* ── 1. Resolver el caso ─────────────────────────────────────── */
    if (tipo === 'rut') {
      const [[cl]] = await pool.query(
        `SELECT id_cliente, rut, fecha_creacion,
                COALESCE(NULLIF(TRIM(nombre_completo),''),
                         NULLIF(TRIM(CONCAT(COALESCE(nombres,''),' ',COALESCE(apellido_paterno,''),' ',COALESCE(apellido_materno,''))),'')) AS nombre
           FROM clientes WHERE ${RUT_SQL('rut')} = ? LIMIT 1`, [normRut(valor)]);
      cliente = cl || null;
    } else if (tipo === 'op') {
      const [cr] = await pool.query(
        `SELECT * FROM creditos WHERE num_op = ? OR numero_credito = ? ORDER BY id DESC LIMIT 5`,
        [valor, valor]);
      creditos = cr || [];
    } else { // id financiera
      const [cr] = await pool.query(
        `SELECT * FROM creditos WHERE id_financiera = ? ORDER BY id DESC LIMIT 5`, [valor]);
      creditos = cr || [];
    }

    /* ── 2. Completar el conjunto (cliente ↔ créditos ↔ cartas) ──── */
    if (tipo === 'rut' && cliente) {
      const [cr] = await pool.query(
        `SELECT * FROM creditos WHERE id_cliente = ? ORDER BY id DESC LIMIT 50`, [cliente.id_cliente]);
      creditos = cr || [];
      const [ca] = await pool.query(
        `SELECT * FROM cartas_aprobacion WHERE ${RUT_SQL('rut_cliente')} = ? ORDER BY id DESC LIMIT 50`,
        [normRut(cliente.rut)]);
      cartas = ca || [];
    } else if (creditos.length) {
      // cliente desde el crédito resuelto
      const idCli = creditos.find(c => c.id_cliente)?.id_cliente;
      if (idCli) {
        const [[cl]] = await pool.query(
          `SELECT id_cliente, rut, fecha_creacion,
                  COALESCE(NULLIF(TRIM(nombre_completo),''),
                           NULLIF(TRIM(CONCAT(COALESCE(nombres,''),' ',COALESCE(apellido_paterno,''),' ',COALESCE(apellido_materno,''))),'')) AS nombre
             FROM clientes WHERE id_cliente = ? LIMIT 1`, [idCli]);
        cliente = cl || null;
      }
      // cartas ligadas a estos créditos
      const ids    = creditos.map(c => c.id).filter(v => v != null);
      const nums   = creditos.map(c => c.numero_credito).filter(Boolean);
      const idfins = creditos.map(c => c.id_financiera).filter(Boolean);
      const ors = [], pars = [];
      if (ids.length)    { ors.push(`id_credito_creado IN (${ids.map(()=>'?').join(',')})`); pars.push(...ids); }
      if (nums.length)   { ors.push(`numero_credito_creado IN (${nums.map(()=>'?').join(',')})`); pars.push(...nums); }
      if (idfins.length) { ors.push(`id_financiera IN (${idfins.map(()=>'?').join(',')})`); pars.push(...idfins); }
      if (ors.length) {
        const [ca] = await pool.query(
          `SELECT * FROM cartas_aprobacion WHERE ${ors.join(' OR ')} ORDER BY id DESC LIMIT 50`, pars);
        cartas = ca || [];
      }
    }

    // ID financiera sin crédito → buscar la carta directamente
    if (tipo === 'id' && !creditos.length && !cartas.length) {
      const [ca] = await pool.query(
        `SELECT * FROM cartas_aprobacion WHERE id_financiera = ? ORDER BY id DESC LIMIT 50`, [valor]);
      cartas = ca || [];
    }
    // Resolver cliente desde la carta si aún no lo tenemos
    if (!cliente && cartas.length) {
      const rc = cartas.find(c => c.rut_cliente)?.rut_cliente;
      if (rc) {
        const [[cl]] = await pool.query(
          `SELECT id_cliente, rut, fecha_creacion,
                  COALESCE(NULLIF(TRIM(nombre_completo),''),
                           NULLIF(TRIM(CONCAT(COALESCE(nombres,''),' ',COALESCE(apellido_paterno,''),' ',COALESCE(apellido_materno,''))),'')) AS nombre
             FROM clientes WHERE ${RUT_SQL('rut')} = ? LIMIT 1`, [normRut(rc)]);
        cliente = cl || null;
      }
    }

    const encontrado = !!(cliente || creditos.length || cartas.length);
    if (!encontrado) return res.json({ success: true, data: { encontrado: false }, error: null });

    const rn        = cliente ? normRut(cliente.rut) : null;
    const creditoIds = creditos.map(c => c.id).filter(v => v != null);

    /* ── 3. Reunir eventos ───────────────────────────────────────── */
    const eventos = [];
    const ev = (fecha, cat, titulo, detalle, usuario, fuente, meta) => {
      if (!fecha) return;
      eventos.push({ fecha, cat, titulo, detalle: detalle || null, usuario: usuario || null, fuente: fuente || null, meta: meta || null });
    };

    /* a) Alta del cliente */
    if (cliente?.fecha_creacion)
      ev(cliente.fecha_creacion, 'cliente', 'Cliente registrado',
         `RUT ${cliente.rut}${cliente.nombre ? ' — ' + cliente.nombre : ''}`, null, 'clientes');

    /* b) Antecedentes laborales */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT created_at, updated_at, empleador, antiguedad_meses, renta_fija_liquida
           FROM antecedentes_laborales WHERE ${RUT_SQL('rut_cliente')} = ? LIMIT 1`, [rn]);
      r.forEach(a => {
        const det = [a.empleador && `Empleador: ${a.empleador}`, a.renta_fija_liquida && `Renta ${clp(a.renta_fija_liquida)}`].filter(Boolean).join(' · ') || null;
        ev(a.created_at, 'antecedentes', 'Antecedentes laborales cargados', det, null, 'clientes');
        if (a.updated_at && String(a.updated_at) !== String(a.created_at))
          ev(a.updated_at, 'antecedentes', 'Antecedentes laborales actualizados', det, null, 'clientes');
      });
    } catch (_) {}

    /* c) Información comercial */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT created_at, updated_at, deuda_vigente_total, deuda_morosa, protestos_vigentes_q
           FROM informacion_comercial WHERE ${RUT_SQL('rut_cliente')} = ? LIMIT 1`, [rn]);
      r.forEach(a => {
        const det = [a.deuda_vigente_total != null && `Deuda vigente ${clp(a.deuda_vigente_total)}`,
                     a.deuda_morosa && `Morosa ${clp(a.deuda_morosa)}`].filter(Boolean).join(' · ') || null;
        ev(a.created_at, 'comercial', 'Información comercial cargada', det, null, 'clientes');
        if (a.updated_at && String(a.updated_at) !== String(a.created_at))
          ev(a.updated_at, 'comercial', 'Información comercial actualizada', det, null, 'clientes');
      });
    } catch (_) {}

    /* d) Informes DealerNet (consulta WS) */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT nombre_producto, codigo_producto, created_at, usuario_nombre, retmsg
           FROM dealernet_informes WHERE ${RUT_SQL('rut')} = ? ORDER BY created_at DESC LIMIT 100`, [rn]);
      r.forEach(i => ev(i.created_at, 'informe',
        `Informe DealerNet: ${i.nombre_producto || i.codigo_producto || 'informe'}`,
        i.retmsg && i.retmsg !== 'OK' ? i.retmsg : null, i.usuario_nombre, 'dealernet'));
    } catch (_) {}

    /* e) Informes DealerNet (PDF cargado manual) */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT fecha_carga, usuario_carga, fecha_informe
           FROM informes_dealernet WHERE ${RUT_SQL('rut')} = ? ORDER BY fecha_carga DESC LIMIT 50`, [rn]);
      r.forEach(i => ev(i.fecha_carga, 'informe', 'Informe DealerNet (PDF) cargado',
        i.fecha_informe ? `Informe al ${i.fecha_informe}` : null, i.usuario_carga, 'dealernet'));
    } catch (_) {}

    /* f) Cotizaciones */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT created_at, fecha_cotizacion, monto, plazo, cuota, estado
           FROM cotizaciones WHERE ${RUT_SQL('rut_cliente')} = ? ORDER BY created_at DESC LIMIT 50`, [rn]);
      r.forEach(c => ev(c.created_at || c.fecha_cotizacion, 'cotizacion',
        `Cotización${c.estado ? ' (' + c.estado + ')' : ''}`,
        [clp(c.monto), c.plazo && `${c.plazo} cuotas`].filter(Boolean).join(' · ') || null, null, 'cotizaciones'));
    } catch (_) {}

    /* g) Documentos de evaluación crediticia */
    if (rn) try {
      const [r] = await pool.query(
        `SELECT documento, created_at, validado, validacion_texto
           FROM evaluacion_documentos WHERE ${RUT_SQL('rut_cliente')} = ? ORDER BY created_at DESC LIMIT 100`, [rn]);
      r.forEach(d => {
        const estado = d.validado == null ? null : (d.validado ? 'Validado' : 'Con observaciones');
        const det = [estado, d.validacion_texto].filter(Boolean).join(' — ') || null;
        ev(d.created_at, 'evaluacion', `Documento de evaluación: ${d.documento || '—'}`, det, null, 'evaluacion');
      });
    } catch (_) {}

    /* h) Cartas de Aprobación — ciclo completo */
    for (const ca of cartas) {
      const nom = ca.op_carta || ('#' + ca.id);
      ev(ca.fecha_creacion || ca.fecha, 'carta_crear', `Carta de aprobación ${nom} creada`,
         [ca.cliente, ca.id_financiera && `ID Fin. ${ca.id_financiera}`].filter(Boolean).join(' · ') || null,
         ca.creado_por_nombre, 'cartas');

      if (ca.fecha_aprobacion) {
        const exc = asJson(ca.excepciones);
        const nexc = Array.isArray(exc) ? exc.length : 0;
        ev(ca.fecha_aprobacion, 'carta_aprobar', `Carta ${nom} APROBADA`,
           [nexc ? `${nexc} excepción(es)` : null,
            ca.tier_uac_n ? `Tier UAC ${ca.tier_uac_n} (${ca.tier_uac_pct}%)` : null].filter(Boolean).join(' · ') || null,
           ca.aprobado_por_nombre, 'cartas');
        if (nexc) {
          const coms = asJson(ca.excepciones_comentarios) || {};
          const detalle = exc.map(e => {
            const k = (typeof e === 'string') ? e : (e?.codigo || e?.nombre || JSON.stringify(e));
            const c = coms[k] || (typeof e === 'object' ? e?.comentario : null);
            return c ? `${k}: ${c}` : k;
          }).join(' · ');
          ev(ca.fecha_aprobacion, 'carta_excepcion', `Excepción(es) aprobadas en ${nom}`, detalle, ca.aprobado_por_nombre, 'cartas');
        }
      }
      if (ca.fecha_rechazo)
        ev(ca.fecha_rechazo, 'carta_rechazar', `Carta ${nom} RECHAZADA`, ca.motivo_rechazo, ca.rechazado_por_nombre, 'cartas');
      if (ca.fecha_correccion)
        ev(ca.fecha_correccion, 'carta_correccion', `Carta ${nom} corregida y reenviada`, null, ca.corregido_por, 'cartas');
      if (ca.fecha_otorgado)
        ev(ca.fecha_otorgado, 'carta_otorgar', `Carta ${nom} otorgada → crédito`,
           ca.numero_credito_creado ? `Crédito N° ${ca.numero_credito_creado}` : null, null, 'cartas');
      if (ca.fecha_desistimiento)
        ev(ca.fecha_desistimiento, 'carta_desistir',
           `Carta ${nom} desistida${ca.desistido_auto ? ' (vencimiento automático)' : ''}`,
           ca.motivo_desistimiento, ca.desistido_por_nombre, 'cartas');
    }

    /* i) Documentos adjuntos a las cartas */
    const cartaIds = cartas.map(c => c.id).filter(v => v != null);
    if (cartaIds.length) try {
      const [r] = await pool.query(
        `SELECT id_carta, tipo, nombre, subido_por, created_at
           FROM cartas_documentos WHERE id_carta IN (${cartaIds.map(()=>'?').join(',')})`, cartaIds);
      r.forEach(d => ev(d.created_at, 'carta_doc', `Documento de carta: ${d.tipo || '—'}`, d.nombre, d.subido_por, 'cartas'));
    } catch (_) {}

    /* j) Bitácora interna del crédito (auditoria_credito) */
    if (creditoIds.length) try {
      const [r] = await pool.query(
        `SELECT id_credito, fecha, usuario, accion, detalle
           FROM auditoria_credito WHERE id_credito IN (${creditoIds.map(()=>'?').join(',')})
           ORDER BY fecha ASC LIMIT 500`, creditoIds);
      const CAT = {
        CREDITO_CREADO:'credito', DOCUMENTO_CARGADO:'documento', DOC_AF_CARGADO:'documento',
        DOC_AF_APROBADO:'doc_ok', DOC_AF_RECHAZADO:'doc_bad', DOCUMENTOS_VALIDADOS:'doc_ok',
        PAGO_REGISTRADO:'pago', PAGO_BATCH_REGISTRADO:'pago', PAGO_ODP_APROBADA:'pago',
        PAGO_ELIMINADO:'doc_bad', PAGO_REVERSADO:'doc_bad', ESTADO_CAMBIADO:'estado',
      };
      r.forEach(a => {
        const cat = CAT[a.accion] || 'credito';
        const titulo = a.accion ? a.accion.replace(/_/g, ' ').toLowerCase().replace(/^\w/, m => m.toUpperCase()) : 'Movimiento';
        ev(a.fecha, cat, titulo, a.detalle, a.usuario, 'credito');
      });
    } catch (_) {}

    /* k) Post-venta (seguimiento de saldo y comisión) */
    if (creditoIds.length) try {
      const [seg] = await pool.query(
        `SELECT id, id_credito FROM postventa_seguimiento WHERE id_credito IN (${creditoIds.map(()=>'?').join(',')})`, creditoIds);
      const segIds = seg.map(s => s.id);
      if (segIds.length) {
        const [et] = await pool.query(
          `SELECT id_seguimiento, track, etapa, usuario, fecha
             FROM postventa_etapas WHERE id_seguimiento IN (${segIds.map(()=>'?').join(',')}) ORDER BY fecha ASC LIMIT 300`, segIds);
        et.forEach(e => ev(e.fecha, 'postventa', `Post-venta [${e.track || '—'}]: ${e.etapa || '—'}`, null, e.usuario, 'postventa'));
      }
    } catch (_) {}

    /* l) Cobranza */
    if (creditoIds.length) try {
      const [r] = await pool.query(
        `SELECT id_credito, tipo_gestion, resultado, created_at
           FROM cobranza_gestiones WHERE id_credito IN (${creditoIds.map(()=>'?').join(',')}) ORDER BY created_at ASC LIMIT 200`, creditoIds);
      r.forEach(g => ev(g.created_at, 'cobranza', `Cobranza: ${g.tipo_gestion || 'gestión'}`, g.resultado, null, 'cobranza'));
    } catch (_) {}

    /* m) CRM */
    if (creditoIds.length) try {
      const [r] = await pool.query(
        `SELECT id_credito, tipo_solicitud, resultado, created_at
           FROM crm_gestiones WHERE id_credito IN (${creditoIds.map(()=>'?').join(',')}) ORDER BY created_at ASC LIMIT 200`, creditoIds);
      r.forEach(g => ev(g.created_at, 'crm', `CRM: ${g.tipo_solicitud || 'gestión'}`, g.resultado, null, 'crm'));
    } catch (_) {}

    /* ── 4. Ordenar cronológicamente ─────────────────────────────── */
    eventos.sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());

    /* ── 5. Fichas (créditos / cartas) sin blobs pesados ─────────── */
    const slimCred = c => ({
      id_credito: c.id, num_op: c.num_op, numero_credito: c.numero_credito,
      id_financiera: c.id_financiera, financiera: c.financiera, estado: c.estado,
      created_at: c.created_at, fecha_otorgamiento: c.fecha_otorgamiento,
      plazo: c.plazo, monto_financiado: c.monto_financiado, tasa_mensual: c.tasa_mensual,
      valor_vehiculo: c.valor_vehiculo, saldo_precio: c.saldo_precio, pie: c.pie,
      marca: c.marca, modelo: c.modelo, anio: c.anio, patente: c.patente,
      dealer: c.dealer, ejecutivo: c.ejecutivo, cuota: c.cuota,
    });
    const slimCarta = c => ({
      id: c.id, op_carta: c.op_carta, id_financiera: c.id_financiera, status: c.status,
      cliente: c.cliente, fecha: c.fecha, plazo: c.plazo, saldo: c.saldo, acreedor: c.acreedor,
      numero_credito_creado: c.numero_credito_creado,
    });

    return res.json({
      success: true,
      data: { encontrado: true, cliente, creditos: creditos.map(slimCred), cartas: cartas.map(slimCarta), eventos },
      error: null,
    });
  } catch (e) {
    console.error('[bitacora]', e);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { buscar };
