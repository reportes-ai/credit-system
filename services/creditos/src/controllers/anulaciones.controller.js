'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ANULACIÓN DE OPERACIONES OTORGADAS — con aprobación de un segundo par

   Problema que resuelve (detectado 31-07-2026): anular una operación era cambiar
   el estado a mano en la pantalla de digitación. Sin motivo obligatorio, sin
   segunda firma y —lo grave— sin tocar la cartola: la comisión del dealer seguía
   esperando pago en una operación que ya no existía. Encontramos 3 anuladas con
   $1.901.400 de comisión viva.

   Flujo (definido con Pato, 31-07-2026):
     1. SOLICITAR (Operaciones, permiso operacion_anular_solicitar): se pide la
        anulación de una operación OTORGADA con motivo obligatorio.
     2. APROBAR (OTRA persona de Operaciones, permiso operacion_anular_aprobar):
        quien solicita NO puede aprobar — segregación de funciones, mismo criterio
        que las excepciones de cartola.
     3. Al aprobar: el crédito pasa a ANULADO y se RETIRA su comisión de la
        cartola, guardando una foto del movimiento retirado (reversible y auditable).
        Si esa cartola YA se envió al dealer, el movimiento NO se toca: se informa
        para que se regularice como descuento, porque el dealer ya la vio.

   Nada de esto pisa el mes cerrado: si el mes de la operación está cerrado, se
   rechaza (misma regla que el resto de las escrituras sobre créditos).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const AVISOS = require('../../../../shared/avisos');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { isMesCerrado, getMesDeOp } = require('../../../../shared/utils/mes-cerrado');
// Motor único de etapa: anular escribe las TRES columnas de una sola vez.
const { SET_ETAPA_SQL, valoresEtapa } = require('../../../../shared/etapa-credito');

const nombreUsuario = req => {
  const u = req.usuario || {};
  return [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || 'Usuario';
};

/* ── Avisos (campanita). Destinatarios finales en Mantenedores → Avisos ─────── */
AVISOS.registrarAviso({
  evento: 'operacion_anulacion_pendiente', modulo: 'Créditos',
  nombre: 'Anulación de operación pendiente de aprobación',
  descripcion: 'Alguien de Operaciones pidió anular una operación otorgada. Avisa al POOL DE OPERACIONES para que otra persona la apruebe o rechace (quien solicita no puede aprobar).',
  base_func: 'operacion_anular_aprobar', prioridad: 'alta', sonido_tipo: 'dingdong',
});
AVISOS.registrarAviso({
  evento: 'operacion_anulacion_resuelta', modulo: 'Créditos',
  nombre: 'Anulación de operación aprobada o rechazada',
  descripcion: 'Se resolvió una solicitud de anulación. Avisa a quien la pidió y al pool de Operaciones, con el motivo y qué pasó con la comisión de la cartola.',
  base_func: 'operacion_anular_solicitar', prioridad: 'alta', sonido_tipo: 'campana',
});

/* ── Migración: tabla + permisos ───────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('anulaciones-operacion', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS anulaciones_operacion (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      id_credito        INT NOT NULL,
      num_op            INT NULL,
      motivo            VARCHAR(600) NOT NULL,
      estado            VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',   -- PENDIENTE | APROBADA | RECHAZADA
      estado_anterior   VARCHAR(30) NULL,
      motivo_rechazo    VARCHAR(600) NULL,
      cartola_retirada  JSON NULL,          -- foto del movimiento de comisión retirado
      cartola_nota      VARCHAR(300) NULL,  -- qué pasó con la comisión
      solicitado_por    INT NULL, solicitado_nombre VARCHAR(160) NULL,
      solicitado_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      resuelto_por      INT NULL, resuelto_nombre VARCHAR(160) NULL, resuelto_at DATETIME NULL,
      INDEX ix_estado (estado), INDEX ix_credito (id_credito))`);

    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/creditos/' LIMIT 1");
    const idMod = mod ? mod.id_modulo : null;
    // La primera lleva href → genera el sub-item en la sección Créditos (regla
    // anti-hardcode: los menús salen de BD, nunca de una lista en el JS).
    for (const [nombre, codigo, href, icono] of [
      ['Anular Operación', 'creditos_anulaciones', '/creditos/anulaciones.html', 'bi-x-octagon'],
      ['Anular operación — solicitar', 'operacion_anular_solicitar', null, null],
      ['Anular operación — aprobar (otra persona)', 'operacion_anular_aprobar', null, null],
    ]) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (!ex && idMod) await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)', [idMod, nombre, codigo, href, icono]);
    }
    /* Quién puede qué (definido con Pato, 31-07-2026):
         solicitar → Analista de Operaciones
         aprobar   → OTRO Analista de Operaciones, o el Gerente de Operaciones y Crédito
       Que el analista tenga los dos permisos NO rompe la segregación: el control es
       por USUARIO (quien solicita no puede aprobar), no por perfil. */
    const PERM = {
      creditos_anulaciones:       ['Analista de Operaciones', 'Gerente de Operaciones y Crédito'],
      operacion_anular_solicitar: ['Analista de Operaciones'],
      operacion_anular_aprobar:   ['Analista de Operaciones', 'Gerente de Operaciones y Crédito'],
    };
    for (const [codigo, perfiles] of Object.entries(PERM)) {
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT p.id_perfil, (SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?), 1
          FROM perfiles p WHERE p.nombre IN (?)`, [codigo, perfiles]);
    }
  } catch (e) { console.error('[anulaciones migration]', e.message); }
});

/* ── GET /api/anulaciones/buscar?q= → operaciones OTORGADAS candidatas ─────── */
const buscar = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/\./g, '');
    if (q.length < 3) return res.json({ success: true, data: [], error: null });
    const [rows] = await pool.query(`
      SELECT c.id, c.num_op, c.id_financiera, c.financiera, c.estado_credito, c.fecha_otorgado,
             c.automotora AS dealer, c.ejecutivo, c.monto_financiado, c.saldo_precio,
             COALESCE(NULLIF(cl.nombre_completo,''),
                      NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''))),'')) AS cliente,
             cl.rut AS rut_cliente,
             (SELECT COUNT(*) FROM anulaciones_operacion a WHERE a.id_credito=c.id AND a.estado='PENDIENTE') AS ya_solicitada
        FROM creditos c
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE UPPER(c.estado_credito)='OTORGADO'
         AND UPPER(COALESCE(c.estado,''))    <> 'ANULADO'
         AND UPPER(COALESCE(c.estado_eval,'')) <> 'ANULADO'
         AND (REPLACE(c.num_op,'.','') LIKE ? OR c.id_financiera LIKE ? OR cl.rut LIKE ?)
       ORDER BY c.fecha_otorgado DESC LIMIT 25`, ['%' + q + '%', '%' + q + '%', '%' + q + '%']);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[anulaciones buscar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/anulaciones → solicitar la anulación ────────────────────────── */
const solicitar = async (req, res) => {
  try {
    const id = Number((req.body || {}).id_credito);
    const motivo = String((req.body || {}).motivo || '').trim();
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Operación inválida' });
    if (motivo.length < 10) return res.status(400).json({ success: false, data: null, error: 'El motivo es obligatorio y debe explicar por qué se anula (mínimo 10 caracteres).' });

    const [[op]] = await pool.query('SELECT id, num_op, estado, estado_credito, estado_eval, financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    // ANULADO en CUALQUIERA de las tres columnas de etapa ya cuenta como anulada.
    if ([op.estado, op.estado_credito, op.estado_eval].some(v => String(v || '').toUpperCase() === 'ANULADO'))
      return res.status(409).json({ success: false, data: null, error: 'La operación ya está anulada.' });
    const mes = await getMesDeOp(id);
    if (mes && await isMesCerrado(mes))
      return res.status(403).json({ success: false, data: null, error: `🔒 Mes ${mes} cerrado — no se permiten modificaciones` });
    const [[dup]] = await pool.query("SELECT id FROM anulaciones_operacion WHERE id_credito=? AND estado='PENDIENTE'", [id]);
    if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya hay una solicitud de anulación pendiente para esta operación.' });

    const [ins] = await pool.query(
      `INSERT INTO anulaciones_operacion (id_credito, num_op, motivo, estado_anterior, solicitado_por, solicitado_nombre)
       VALUES (?,?,?,?,?,?)`,
      [id, op.num_op, motivo, op.estado_credito || null, req.usuario.id_usuario || null, nombreUsuario(req)]);

    auditar({ req, accion: 'SOLICITAR_ANULACION', modulo: 'creditos', entidad: 'credito', entidad_id: id,
      detalle: `Solicitó anular la OP ${op.num_op} (estaba en ${op.estado_credito}) — ${motivo}`, meta: { motivo } });

    AVISOS.avisar('operacion_anulacion_pendiente', {
      titulo: '🚫 Anulación por aprobar — OP ' + op.num_op,
      mensaje: `${nombreUsuario(req)} pidió anular la OP ${op.num_op} (${op.financiera || ''}). Motivo: ${motivo}. Debe aprobarla OTRA persona de Operaciones.`,
      href: '/creditos/anulaciones.html',
      // clave del hecho: al resolverse se retira de la campanita de todo el pool.
      clave: 'anulacion:' + ins.insertId,
    }, { excluir: [req.usuario.id_usuario] }).catch(() => {});

    res.json({ success: true, data: { id: ins.insertId }, error: null });
  } catch (e) { console.error('[anulaciones solicitar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/anulaciones?estado= → bandeja ────────────────────────────────── */
const listar = async (req, res) => {
  try {
    const est = String(req.query.estado || '').toUpperCase();
    const filt = ['PENDIENTE', 'APROBADA', 'RECHAZADA'].includes(est) ? ' WHERE a.estado=?' : '';
    const [rows] = await pool.query(`
      SELECT a.*, c.id_financiera, c.financiera, c.automotora AS dealer, c.ejecutivo,
             c.monto_financiado, c.saldo_precio, c.fecha_otorgado,
             COALESCE(NULLIF(cl.nombre_completo,''),
                      NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''))),'')) AS cliente,
             cl.rut AS rut_cliente
        FROM anulaciones_operacion a
        JOIN creditos c ON c.id = a.id_credito
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
        ${filt}
       ORDER BY a.estado='PENDIENTE' DESC, a.solicitado_at DESC LIMIT 300`, filt ? [est] : []);
    const puedeAprobar = await tieneFunc(req.usuario.id_usuario, 'operacion_anular_aprobar');
    res.json({ success: true, data: rows, yo: req.usuario.id_usuario, puede_aprobar: puedeAprobar, error: null });
  } catch (e) { console.error('[anulaciones listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/anulaciones/:id/resolver { accion, motivo_rechazo } ─────────── */
const resolver = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const accion = String((req.body || {}).accion || '').toLowerCase();
    const motivoRech = String((req.body || {}).motivo_rechazo || '').trim();
    if (!['aprobar', 'rechazar'].includes(accion))
      return res.status(400).json({ success: false, data: null, error: 'Acción inválida' });

    const [[a]] = await pool.query('SELECT * FROM anulaciones_operacion WHERE id=?', [id]);
    if (!a) return res.status(404).json({ success: false, data: null, error: 'Solicitud no encontrada' });
    if (a.estado !== 'PENDIENTE')
      return res.status(409).json({ success: false, data: null, error: 'Esta solicitud ya fue ' + a.estado.toLowerCase() + '.' });
    // Segregación de funciones: quien pide NO aprueba.
    if (Number(a.solicitado_por) === Number(req.usuario.id_usuario))
      return res.status(403).json({ success: false, data: null, error: 'No puedes aprobar una anulación que solicitaste tú. Debe resolverla otra persona de Operaciones.' });
    if (accion === 'rechazar' && !motivoRech)
      return res.status(400).json({ success: false, data: null, error: 'Indica por qué se rechaza la anulación.' });

    const [[op]] = await pool.query('SELECT id, num_op, id_financiera, estado_credito, financiera, ejecutivo FROM creditos WHERE id=?', [a.id_credito]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    if (accion === 'rechazar') {
      await pool.query(`UPDATE anulaciones_operacion SET estado='RECHAZADA', motivo_rechazo=?, resuelto_por=?, resuelto_nombre=?, resuelto_at=NOW() WHERE id=?`,
        [motivoRech, req.usuario.id_usuario || null, nombreUsuario(req), id]);
      AVISOS.retirar('anulacion:' + id).catch(() => {});   // ya no está pendiente para nadie
      auditar({ req, accion: 'RECHAZAR_ANULACION', modulo: 'creditos', entidad: 'credito', entidad_id: a.id_credito,
        detalle: `Rechazó la anulación de la OP ${op.num_op} — ${motivoRech}`, meta: { motivo_rechazo: motivoRech } });
      AVISOS.avisar('operacion_anulacion_resuelta', {
        titulo: '✅ Anulación RECHAZADA — OP ' + op.num_op,
        mensaje: `${nombreUsuario(req)} rechazó anular la OP ${op.num_op}. Motivo: ${motivoRech}. La operación sigue vigente.`,
        href: '/creditos/anulaciones.html',
      }, { excluir: [req.usuario.id_usuario], extra: a.solicitado_por ? [a.solicitado_por] : [] }).catch(() => {});
      return res.json({ success: true, data: { estado: 'RECHAZADA' }, error: null });
    }

    /* APROBAR: el mes puede haberse cerrado entre la solicitud y la aprobación. */
    const mes = await getMesDeOp(a.id_credito);
    if (mes && await isMesCerrado(mes))
      return res.status(403).json({ success: false, data: null, error: `🔒 Mes ${mes} cerrado — no se permiten modificaciones` });

    // 1) La comisión en la cartola. Se busca por ID financiera (así la referencia
    //    la cartola) y también por N° OP, que es como quedan las incorporadas sin carta.
    const [movs] = await pool.query(
      'SELECT * FROM cartolas_movimientos WHERE num_op IN (?, ?)', [op.id_financiera, String(op.num_op)]);
    const enviados = movs.filter(m => m.mes_cartola);
    const retirables = movs.filter(m => !m.mes_cartola);
    let nota;
    if (!movs.length) nota = 'La operación no tenía comisión en cartola.';
    else if (retirables.length) {
      await pool.query('DELETE FROM cartolas_movimientos WHERE id IN (?)', [retirables.map(m => m.id)]);
      nota = `Se retiraron ${retirables.length} movimiento(s) de cartola por $${retirables.reduce((s, m) => s + Number(m.comision || 0), 0).toLocaleString('es-CL')}.`;
    } else nota = '';
    if (enviados.length) {
      const tot = enviados.reduce((s, m) => s + Number(m.comision || 0), 0);
      nota += ` ATENCIÓN: ${enviados.length} movimiento(s) por $${tot.toLocaleString('es-CL')} ya salieron en la cartola ${enviados.map(m => m.mes_cartola).join(', ')} — el dealer ya los vio, hay que regularizarlos como descuento.`;
    }

    // 2) El crédito
    await pool.query(
      /* La ETAPA por el motor único (shared/etapa-credito.js): las TRES columnas
         en el mismo UPDATE. El listado resuelve la etapa con `estado` PRIMERO, así
         que escribir solo las otras dos dejaba la operación mostrándose OTORGADA. */
      `UPDATE creditos SET ${SET_ETAPA_SQL},
              comentarios=CONCAT(COALESCE(comentarios,''),' | ANULADA ',DATE_FORMAT(NOW(),'%d-%m-%Y'),': ',?)
        WHERE id=?`, [...valoresEtapa('ANULADO'), a.motivo, a.id_credito]);

    /* Post Venta: una operación anulada no pide fundantes (SALDO) ni tiene
       comisión al dealer (COMISION) ni al parque (PARQUE) que pagar. Los TRES
       tracks se apagan con el mismo criterio conservador: solo si el track no
       avanzó más allá de sus etapas iniciales — si ya se movió plata, la etapa
       se respeta y queda para regularizar a mano. El sync() de Post Venta ya
       no resiembra las iniciales de operaciones ANULADAS. */
    const INICIALES = {
      SALDO:    ['FUNDANTES PENDIENTES'],
      COMISION: ['COMISION PENDIENTE', 'COMISION A PAGAR'],
      PARQUE:   ['COMISION A PAGAR'],
    };
    for (const [track, iniciales] of Object.entries(INICIALES)) {
      await pool.query(`
        DELETE e FROM postventa_etapas e
        JOIN postventa_seguimiento s ON s.id = e.id_seguimiento
        WHERE s.id_credito = ? AND e.track = ? AND e.etapa IN (?)
          AND NOT EXISTS (SELECT 1 FROM (SELECT id_seguimiento, etapa, track FROM postventa_etapas) x
            WHERE x.id_seguimiento = e.id_seguimiento AND x.track = ? AND x.etapa NOT IN (?))`,
        [a.id_credito, track, iniciales, track, iniciales])
        .catch(err => console.error('[anulacion track ' + track + ']', err.message));
    }

    await pool.query(
      `UPDATE anulaciones_operacion SET estado='APROBADA', cartola_retirada=?, cartola_nota=?,
              resuelto_por=?, resuelto_nombre=?, resuelto_at=NOW() WHERE id=?`,
      [JSON.stringify(retirables), nota.trim(), req.usuario.id_usuario || null, nombreUsuario(req), id]);

    AVISOS.retirar('anulacion:' + id).catch(() => {});     // ya no está pendiente para nadie
    auditar({ req, accion: 'APROBAR_ANULACION', modulo: 'creditos', entidad: 'credito', entidad_id: a.id_credito,
      detalle: `Aprobó la anulación de la OP ${op.num_op} (solicitada por ${a.solicitado_nombre}) — ${a.motivo}. ${nota.trim()}`,
      meta: { motivo: a.motivo, estado_anterior: op.estado_credito, cartola: nota.trim(), movimientos_retirados: retirables.map(m => m.id) } });

    AVISOS.avisar('operacion_anulacion_resuelta', {
      titulo: '🚫 Operación ANULADA — OP ' + op.num_op,
      mensaje: `${nombreUsuario(req)} aprobó la anulación de la OP ${op.num_op} solicitada por ${a.solicitado_nombre}. Motivo: ${a.motivo}. ${nota.trim()}`,
      href: '/creditos/anulaciones.html',
    }, { excluir: [req.usuario.id_usuario], extra: a.solicitado_por ? [a.solicitado_por] : [] }).catch(() => {});

    // Anuncio push a TODA la app (paramétrico en el mantenedor de Alertas →
    // Anuncios, igual que el del crédito otorgado).
    require('../../../../shared/anuncios')
      .publicarAnuncio('operacion_anulada', {
        op: op.num_op, usuario: nombreUsuario(req),
        // mismo formato que el anuncio de otorgamiento (el ejecutivo va en Capital Case)
        ejecutivo: String(op.ejecutivo || '').trim().toLowerCase().replace(/\b\p{L}/gu, m => m.toUpperCase()),
      })
      .catch(() => {});

    res.json({ success: true, data: { estado: 'APROBADA', cartola: nota.trim() }, error: null });
  } catch (e) { console.error('[anulaciones resolver]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { buscar, solicitar, listar, resolver };
