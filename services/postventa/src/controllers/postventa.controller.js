'use strict';
const pool = require('../../../../shared/config/database');
const { emitirCorrelativo, pagarCorrelativo, despagarCorrelativo } = require('../../../../shared/ordenes-pago');
const { auditar } = require('../../../../shared/audit');
/* Fundantes DEVUELTOS (rechazados por la financiera): al registrarlo se
   desmarcan FUNDANTES RECIBIDOS/ENVIADOS y queda la fecha y el motivo. */
require('../../../../shared/migrate').enFila('postventa-fundantes-devueltos', async () => {
  await pool.query('ALTER TABLE postventa_seguimiento ADD COLUMN IF NOT EXISTS fundantes_devueltos_en DATETIME NULL');
  await pool.query('ALTER TABLE postventa_seguimiento ADD COLUMN IF NOT EXISTS fundantes_devueltos_por VARCHAR(120) NULL');
  await pool.query('ALTER TABLE postventa_seguimiento ADD COLUMN IF NOT EXISTS fundantes_devueltos_motivo VARCHAR(300) NULL');
});

/* num_op de un lote de seguimientos, para el detalle de auditoría */
async function opsTxt(ids) {
  try {
    const [rows] = await pool.query('SELECT num_op FROM postventa_seguimiento WHERE id IN (?)', [ids]);
    return rows.map(r => r.num_op).filter(Boolean).join(', ') || ids.join(', ');
  } catch (_) { return ids.join(', '); }
}
const { ejecutivosVisibles: _visEjec } = require('../../../../shared/visibilidad-ejecutivos');

/* ── Migración ───────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('postventa', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_seguimiento (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_credito    INT NOT NULL,
        num_op        INT DEFAULT NULL,
        financiera    VARCHAR(60),
        rut_dealer    VARCHAR(20),
        nombre_dealer VARCHAR(200),
        ejecutivo     VARCHAR(150),
        fecha_otorgado DATE,
        saldo_precio  BIGINT,
        comision      BIGINT,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_credito (id_credito),
        INDEX idx_financiera (financiera)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_etapas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_seguimiento INT NOT NULL,
        track          ENUM('SALDO','COMISION') NOT NULL,
        etapa          VARCHAR(60) NOT NULL,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_etapa (id_seguimiento, track, etapa)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_config (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT NOT NULL
      )`);
    // Mapeo etapa → estado por defecto (editable en Mantenedores Post Venta)
    const DEF_SALDO = [
      { etapa:'FUNDANTES PENDIENTES', estado:'PENDIENTE' },
      { etapa:'FUNDANTES RECIBIDOS',  estado:'PENDIENTE' },
      { etapa:'FUNDANTES ENVIADOS',   estado:'PENDIENTE' },
      { etapa:'LIBERADO A PAGO',      estado:'PARA PAGO' },
      { etapa:'FONDOS RECIBIDOS',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'ENVIADO A PAGO',       estado:'PARA PAGO' },
      { etapa:'SALDO PRECIO PAGADO',  estado:'PAGADO' },
    ];
    const DEF_COM = [
      { etapa:'COMISION PENDIENTE',   estado:'PENDIENTE' },
      { etapa:'COMISION A PAGAR',     estado:'PENDIENTE' },
      { etapa:'CARTOLA EMITIDA',      estado:'PENDIENTE' },
      { etapa:'CARTOLA ENVIADA',      estado:'PENDIENTE' },
      { etapa:'FACTURA RECIBIDA',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'ENVIADO A PAGO',       estado:'PARA PAGO' },
      { etapa:'COMISION PAGADA',      estado:'PAGADO' },
    ];
    // El track PARQUE conserva su flujo propio (Comisiones Parques a Pagar marca
    // emitida/aprobada/enviada por parque+mes) — no hereda el rediseño del dealer.
    const DEF_PARQUE = [
      { etapa:'COMISION A PAGAR',     estado:'PENDIENTE' },
      { etapa:'CARTOLA EMITIDA',      estado:'PENDIENTE' },
      { etapa:'CARTOLA APROBADA',     estado:'PENDIENTE' },
      { etapa:'CARTOLA ENVIADA',      estado:'PENDIENTE' },
      { etapa:'FACTURA RECIBIDA',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'ENVIADO A PAGO',       estado:'PARA PAGO' },
      { etapa:'COMISION PAGADA',      estado:'PAGADO' },
    ];
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?),(?,?)',
      ['etapas_saldo', JSON.stringify(DEF_SALDO), 'etapas_comision', JSON.stringify(DEF_COM)]);

    /* ── Track PARQUE: comisión del PARQUE por operación — mismas etapas y mismas
       condiciones que la comisión del dealer. La ODP y el pago son por parque+mes
       (módulo Comisiones Parques a Pagar), que marca esas etapas en cada operación
       del parque. Las etapas de cartola las marcará el módulo Emisión de Cartolas
       Parque. */
    try { await pool.query("ALTER TABLE postventa_etapas MODIFY track ENUM('SALDO','COMISION','PARQUE') NOT NULL"); } catch (e) { console.error('[postventa track parque]', e.message); }
    try { await pool.query('ALTER TABLE postventa_seguimiento ADD COLUMN IF NOT EXISTS parque VARCHAR(120) NULL'); } catch (_) {}
    try { await pool.query('ALTER TABLE postventa_seguimiento ADD COLUMN IF NOT EXISTS com_parque BIGINT NULL'); } catch (_) {}
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?)',
      ['etapas_parque', JSON.stringify(DEF_PARQUE)]);   // flujo propio del parque (conserva CARTOLA APROBADA)
    // Plantillas editables del correo a Contabilidad al emitir la Orden de Pago (saldo y comisión).
    const CORREO_SALDO = {
      asunto: 'Orden de Pago Saldo Precio N° {nOrden} — {dealer} (OP {num_op})',
      cuerpo: 'Estimado Equipo de Contabilidad:\n\nA continuación encontrarán la Orden de Pago N° {nOrden} para el pago del Saldo Precio a {dealer} del Crédito N° {num_op} otorgado por {financiera} con fecha {fecha_otorgado}, Saldo Precio recepcionado por AutoFácil el día {fecha_recepcion}.\n\nLes recordamos que deben marcar en el módulo de Saldo Precio Pagado, de manera de informar al Ejecutivo y cerrar el flujo operativo de esta transacción.',
      firma: 'Saludos cordiales,\nÁrea de Operaciones',
    };
    const CORREO_COMISION = {
      asunto: 'Orden de Pago de Comisión N° {nOrden} — {dealer} (OP {num_op})',
      cuerpo: 'Estimado Equipo de Contabilidad:\n\nA continuación encontrarán la Orden de Pago de Comisión N° {nOrden} para el pago de la Comisión a {dealer} del Crédito N° {num_op} otorgado por {financiera}, {doc} N° {numero_factura} recepcionada por AutoFácil el día {fecha_recepcion}.\n\nLes recordamos que deben marcar en el módulo de Comisión Pagada, de manera de informar al Ejecutivo y cerrar el flujo operativo de esta transacción.',
      firma: 'Saludos cordiales,\nÁrea de Operaciones',
    };
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?),(?,?),(?,?)',
      ['correo_orden_saldo', JSON.stringify(CORREO_SALDO),
       'correo_orden_comision', JSON.stringify(CORREO_COMISION),
       'correo_contabilidad', JSON.stringify('contabilidad@autofacilchile.cl')]);
    /* Aviso al DEALER cuando Tesorería paga su saldo precio. NACE INACTIVO
       (activo:false) para que Pato revise el texto antes de que salga el primero.
       CC: ejecutivo comercial de la operación + Jefes Comerciales (por perfil,
       paramétrico) + el grupo de Operaciones (editable acá). */
    const CORREO_PAGO_SALDO = {
      activo: false,
      remitente: '',
      cc_operaciones: 'operaciones@autofacilchile.cl',
      asunto: 'Saldo Precio pagado — OP {num_op} ({dealer})',
      cuerpo: 'Estimados {dealer}:\n\nLes informamos que el Saldo Precio de la operación N° {num_op}, por {monto}, fue pagado el {fecha_pago} mediante transferencia a la {tipo_cuenta} {num_cuenta} del banco {banco}.\n\nCualquier duda, quedamos atentos.',
      firma: 'Saludos cordiales,\nAutoFácil Crédito Automotriz',
    };
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?)',
      ['correo_pago_saldo', JSON.stringify(CORREO_PAGO_SALDO)]);
    // Parche idempotente: alinear el asunto del saldo al formato de comisión (solo si conserva el default viejo).
    try {
      const [[rc]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_orden_saldo'");
      if (rc) { const v = JSON.parse(rc.valor);
        if (v && v.asunto === 'Orden de Pago N° {nOrden} — Saldo Precio {dealer} (OP {num_op})') {
          v.asunto = 'Orden de Pago Saldo Precio N° {nOrden} — {dealer} (OP {num_op})';
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave='correo_orden_saldo'", [JSON.stringify(v)]);
        }
      }
    } catch (_) {}
    // Parche idempotente: en comisión, la fecha de "recepcionada" debe ser la de RECEPCIÓN (no la de la factura).
    try {
      const [[rc]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_orden_comision'");
      if (rc) { const v = JSON.parse(rc.valor);
        if (v && typeof v.cuerpo === 'string' && v.cuerpo.includes('recepcionada por AutoFácil el día {fecha_factura}')) {
          v.cuerpo = v.cuerpo.replace('recepcionada por AutoFácil el día {fecha_factura}', 'recepcionada por AutoFácil el día {fecha_recepcion}');
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave='correo_orden_comision'", [JSON.stringify(v)]);
        }
      }
    } catch (_) {}
    // Parche: insertar ENVIADO A PAGO (antes de la etapa de pagado) en configs ya existentes.
    // claveProc = array posicional de perfiles por etapa: hay que insertar un slot vacío
    // en la misma posición para no desalinear los permisos de las etapas posteriores.
    const insertarEnviado = async (clave, antesDe, claveProc) => {
      const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave=?", [clave]);
      if (!row) return;
      const arr = JSON.parse(row.valor);
      if (arr.some(x => x.etapa === 'ENVIADO A PAGO')) return;
      const idx = arr.findIndex(x => x.etapa === antesDe);
      const at = idx >= 0 ? idx : arr.length;
      arr.splice(at, 0, { etapa:'ENVIADO A PAGO', estado:'PARA PAGO' });
      await pool.query("UPDATE postventa_config SET valor=? WHERE clave=?", [JSON.stringify(arr), clave]);
      const [[pr]] = await pool.query("SELECT valor FROM postventa_config WHERE clave=?", [claveProc]);
      if (pr) {
        const perms = JSON.parse(pr.valor);
        if (Array.isArray(perms)) {
          perms.splice(at, 0, []);
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave=?", [JSON.stringify(perms), claveProc]);
        }
      }
      console.log('[postventa] etapa ENVIADO A PAGO agregada a ' + clave);
    };
    try {
      await insertarEnviado('etapas_saldo',    'SALDO PRECIO PAGADO', 'etapa_perfiles_saldo');
      await insertarEnviado('etapas_comision', 'COMISION PAGADA',     'etapa_perfiles_comision');
    } catch (e) { console.error('[postventa patch ENVIADO A PAGO]', e.message); }
    // Órdenes de pago de saldo precio: correlativo propio (una por operación)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_ordenes (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        num_orden      VARCHAR(30) UNIQUE,
        id_seguimiento INT NOT NULL,
        num_op         INT DEFAULT NULL,
        monto          BIGINT,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_seg (id_seguimiento)
      )`);
    // Órdenes de pago de comisión: correlativo propio (una por operación)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_ordenes_comision (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        num_orden      VARCHAR(30) UNIQUE,
        id_seguimiento INT NOT NULL,
        num_op         INT DEFAULT NULL,
        monto          BIGINT,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_seg (id_seguimiento)
      )`);
    // Homologación: num_op varchar->int (datos verificados 100% numéricos)
    for (const t of ['postventa_seguimiento','postventa_ordenes','postventa_ordenes_comision']) {
      try {
        const [[c]] = await pool.query(`SELECT data_type dt FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name='num_op'`, [t]);
        if (c && String(c.dt).toLowerCase() === 'varchar') await pool.query(`ALTER TABLE \`${t}\` MODIFY COLUMN num_op INT DEFAULT NULL`);
      } catch(e){ console.error('[num_op->int '+t+']', e.message); }
    }
    // Reversas de pago fuera del día (auditoría para Riesgo Operacional)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_reversas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_seguimiento INT NOT NULL,
        etapa          VARCHAR(60) NOT NULL,
        usuario        VARCHAR(150),
        motivo         VARCHAR(400),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    // Datos de la factura/boleta de comisión (capturados al marcar FACTURA RECIBIDA)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_facturas_comision (
        id_seguimiento INT PRIMARY KEY,
        num_op         INT DEFAULT NULL,
        rut_dealer     VARCHAR(20) DEFAULT NULL,
        nombre_dealer  VARCHAR(200) DEFAULT NULL,
        fecha_factura  DATE DEFAULT NULL,
        numero_factura VARCHAR(60) DEFAULT NULL,
        monto_bruto    BIGINT DEFAULT NULL,
        es_terceros    TINYINT(1) NOT NULL DEFAULT 0,
        es_boleta      TINYINT(1) NOT NULL DEFAULT 0,
        impuesto_pct   DECIMAL(7,4) DEFAULT NULL,
        impuesto_monto BIGINT DEFAULT NULL,
        monto_liquido  BIGINT DEFAULT NULL,
        usuario        VARCHAR(150),
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    // Desglose congelado al registrar la factura/boleta (no se recalcula después)
    for (const col of ['impuesto_pct DECIMAL(7,4) DEFAULT NULL', 'impuesto_monto BIGINT DEFAULT NULL', 'monto_liquido BIGINT DEFAULT NULL']) {
      try { await pool.query(`ALTER TABLE postventa_facturas_comision ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) {}
    }
    /* ── Rediseño flujo COMISIÓN (08-2026, pedido Pato):
       COMISIÓN PENDIENTE (auto al otorgar) → COMISION A PAGAR (auto al marcar
       FONDOS RECIBIDOS del saldo) → CARTOLA EMITIDA (analista cierra la cartola)
       → CARTOLA ENVIADA (auto al enviar) → FACTURA RECIBIDA (una factura por
       cartola, replicada a las demás ops) → ODP EMITIDA → ENVIADO A PAGO →
       COMISION PAGADA (tesorero; correo automático al dealer desde comisiones@).
       CARTOLA APROBADA se elimina: nunca tuvo un aprobador real (se marcaba
       sola junto con el envío). */
    // La factura se ingresa UNA vez y se replica a las otras ops de la cartola:
    // la réplica no lleva montos (van solo en la titular, para no duplicar ni la
    // ODP ni el asiento contable).
    for (const col of ['es_replica TINYINT(1) NOT NULL DEFAULT 0', 'id_titular INT DEFAULT NULL']) {
      try { await pool.query(`ALTER TABLE postventa_facturas_comision ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) {}
    }
    try {
      // 1) Config: insertar COMISIÓN PENDIENTE al inicio y eliminar CARTOLA APROBADA
      //    (ajustando el array posicional de perfiles para no desalinear permisos).
      const [[cRow]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='etapas_comision'");
      if (cRow) {
        const arr = JSON.parse(cRow.valor);
        const [[pRow]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='etapa_perfiles_comision'");
        const perms = pRow ? JSON.parse(pRow.valor) : null;
        let cambio = false;
        const iApr = arr.findIndex(x => x.etapa === 'CARTOLA APROBADA');
        if (iApr >= 0) { arr.splice(iApr, 1); if (Array.isArray(perms)) perms.splice(iApr, 1); cambio = true; }
        if (!arr.some(x => x.etapa === 'COMISION PENDIENTE')) {
          arr.splice(0, 0, { etapa: 'COMISION PENDIENTE', estado: 'PENDIENTE' });
          if (Array.isArray(perms)) perms.splice(0, 0, []);
          cambio = true;
        }
        if (cambio) {
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave='etapas_comision'", [JSON.stringify(arr)]);
          if (Array.isArray(perms)) await pool.query("UPDATE postventa_config SET valor=? WHERE clave='etapa_perfiles_comision'", [JSON.stringify(perms)]);
          console.log('[postventa] flujo COMISION actualizado (COMISION PENDIENTE / sin CARTOLA APROBADA)');
        }
      }
      // 2) Backfill: todo otorgado con seguimiento arranca con COMISIÓN PENDIENTE.
      await pool.query(`
        INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
        SELECT s.id, 'COMISION', 'COMISION PENDIENTE', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
        FROM postventa_seguimiento s
        WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
          WHERE e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION PENDIENTE')`);
      // 3) Retro-limpieza: COMISION A PAGAR se marcaba al otorgar; ahora significa
      //    "los fondos del saldo ya llegaron". Se desmarca SOLO donde es la única
      //    marca del track (los flujos ya avanzados quedan como están) y el saldo
      //    aún no tiene FONDOS RECIBIDOS.
      await pool.query(`
        DELETE e FROM postventa_etapas e
        WHERE e.track='COMISION' AND e.etapa='COMISION A PAGAR'
          AND NOT EXISTS (SELECT 1 FROM (SELECT id_seguimiento, etapa FROM postventa_etapas WHERE track='COMISION') x
            WHERE x.id_seguimiento = e.id_seguimiento AND x.etapa NOT IN ('COMISION PENDIENTE','COMISION A PAGAR'))
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas fr
            WHERE fr.id_seguimiento = e.id_seguimiento AND fr.track='SALDO' AND fr.etapa='FONDOS RECIBIDOS')`);
    } catch (e) { console.error('[postventa flujo comision v2]', e.message); }
    // Plantilla del aviso de pago al dealer (sale desde comisiones@ al marcar COMISION PAGADA)
    const CORREO_COM_PAGADA = {
      asunto: 'Comisión pagada — {doc} N° {numero_factura} ({dealer})',
      cuerpo: 'Estimados {dealer}:\n\nLes informamos que la {doc} N° {numero_factura} ha sido pagada mediante transferencia a la {tipo_cuenta} {num_cuenta} del banco {banco}, de acuerdo a sus instrucciones.\n\nOperación(es): {ops}.',
      firma: '',   // la plantilla corporativa ya cierra con "Saludos," + logo
    };
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?)',
      ['correo_comision_pagada', JSON.stringify(CORREO_COM_PAGADA)]);
    // Plantilla del correo de CARTOLA al dealer (lo abre Gmail desde Emisión de
    // Cartolas). `activo:false` desactiva el correo sin tocar el resto del envío.
    const CORREO_CARTOLA = {
      activo: true,
      asunto: 'CARTOLA COMISIONES {mes} — {dealer}',
      cuerpo: 'Estimados {dealer}:\n\nJunto con saludar, adjuntamos la cartola de comisiones correspondiente a {mes}.\n\nTotal comisión bruta a pagar: {total}\n\nFavor emitir la factura a:\nAUTOFACIL SPA — RUT 76.545.638-K\nAv. Presidente Kennedy N° 5757, Piso 16 Of. 1601, Las Condes.\n\nCualquier duda quedamos atentos.',
      firma: '',   // el marco corporativo del mailer ya cierra con logo
    };
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?)',
      ['correo_cartola_dealer', JSON.stringify(CORREO_CARTOLA)]);
    // Parche idempotente: agregar el interruptor `activo` al aviso de pago si falta,
    // y vaciar la firma default (la plantilla corporativa ya cierra con logo).
    try {
      const [[rp]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_comision_pagada'");
      if (rp) { const v = JSON.parse(rp.valor); let dirty = false;
        if (v && v.activo === undefined) { v.activo = true; dirty = true; }
        if (v && v.firma === 'Saludos cordiales,\nComisiones AutoFácil') { v.firma = ''; dirty = true; }
        if (dirty) await pool.query("UPDATE postventa_config SET valor=? WHERE clave='correo_comision_pagada'", [JSON.stringify(v)]);
      }
    } catch (_) {}
    // Cierre: un movimiento pendiente cuya comisión YA está pagada (histórico
    // fuera del circuito) no puede volver a ofrecerse en una cartola — se le
    // estampa el mes del pago como mes_cartola (idempotente por el WHERE).
    await pool.query(`
      UPDATE cartolas_movimientos m
      LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
      JOIN creditos c ON (ca.id_credito_creado IS NOT NULL AND c.id = ca.id_credito_creado)
        OR (m.id_carta IS NULL AND (CAST(m.num_op AS CHAR) = CAST(c.num_op AS CHAR) OR CAST(m.num_op AS CHAR) = CAST(c.id_financiera AS CHAR)))
      JOIN postventa_seguimiento s ON s.id_credito = c.id
      JOIN postventa_etapas e ON e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION PAGADA'
      SET m.mes_cartola = DATE_FORMAT(e.fecha,'%Y-%m'),
          m.enviada_por = 'Histórico (comisión ya pagada)',
          m.enviada_fecha = e.fecha
      WHERE m.movimiento='COMISION' AND m.mes_cartola IS NULL`).catch(e => console.error('[postventa cierre movs pagados]', e.message));
    // Backfill: movimientos COMISION aún PENDIENTES cuyas operaciones ya están
    // COMISION A PAGAR en Post Venta → A PAGAR (idempotente por el WHERE).
    await pool.query(`
      UPDATE cartolas_movimientos m
      LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
      JOIN creditos c
        ON (ca.id_credito_creado IS NOT NULL AND c.id = ca.id_credito_creado)
        OR (m.id_carta IS NULL AND (CAST(m.num_op AS CHAR) = CAST(c.num_op AS CHAR) OR CAST(m.num_op AS CHAR) = CAST(c.id_financiera AS CHAR)))
      JOIN postventa_seguimiento s ON s.id_credito = c.id
      JOIN postventa_etapas e ON e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION A PAGAR'
      SET m.estado_comision='A PAGAR', m.estado_usuario='Sistema', m.estado_fecha=NOW()
      WHERE m.movimiento='COMISION' AND m.estado_comision='PENDIENTE'
        AND m.mes_cartola IS NULL
        AND NOT EXISTS (SELECT 1 FROM postventa_etapas pg
          WHERE pg.id_seguimiento = s.id AND pg.track='COMISION' AND pg.etapa='COMISION PAGADA')`).catch(e => console.error('[postventa backfill cartola a pagar]', e.message));
    // Idem para la cartola: ahora sale por el mailer con el marco corporativo.
    try {
      const [[rc2]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_cartola_dealer'");
      if (rc2) { const v = JSON.parse(rc2.valor);
        if (v && v.firma === 'Saludos cordiales,\nAutoFácil Crédito Automotriz') { v.firma = '';
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave='correo_cartola_dealer'", [JSON.stringify(v)]); }
      }
    } catch (_) {}
    console.log('[postventa] tablas OK');
  } catch (e) { console.error('[postventa migration]', e.message); }
});

const loginDe = u => (u?.nombre ? (u.nombre + ' ' + (u.apellido || '')).trim() : u?.email) || 'Sistema';
// Caja activa del usuario (para timbrar el pago en op_correlativos). null si no tiene.
const cajaActivaDe = async (id_usuario) => {
  try { const [[c]] = await pool.query('SELECT id_caja FROM caja_usuarios WHERE id_usuario=? AND activo=1 LIMIT 1', [id_usuario]); return c ? c.id_caja : null; }
  catch { return null; }
};

// Guarda los datos de la factura/boleta de comisión con el desglose CONGELADO
// (monto, impuesto y líquido a pagar tal como se registraron; la orden no recalcula).
const _intOrNull = v => (v != null && v !== '') ? Math.round(Number(v)) : null;
async function guardarFacturaComision(idSeguimiento, f, usuario) {
  return pool.query(
    `INSERT INTO postventa_facturas_comision
       (id_seguimiento, num_op, rut_dealer, nombre_dealer, fecha_factura, numero_factura, monto_bruto,
        es_terceros, es_boleta, impuesto_pct, impuesto_monto, monto_liquido, usuario)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       num_op=VALUES(num_op), rut_dealer=VALUES(rut_dealer), nombre_dealer=VALUES(nombre_dealer),
       fecha_factura=VALUES(fecha_factura), numero_factura=VALUES(numero_factura), monto_bruto=VALUES(monto_bruto),
       es_terceros=VALUES(es_terceros), es_boleta=VALUES(es_boleta),
       impuesto_pct=VALUES(impuesto_pct), impuesto_monto=VALUES(impuesto_monto), monto_liquido=VALUES(monto_liquido),
       usuario=VALUES(usuario), created_at=NOW()`,
    [idSeguimiento, f.num_op || null, f.rut_dealer || null, f.nombre_dealer || null,
     f.fecha_factura || null, f.numero_factura || null, _intOrNull(f.monto_bruto),
     f.es_terceros ? 1 : 0, f.es_boleta ? 1 : 0,
     (f.impuesto_pct != null && f.impuesto_pct !== '') ? Number(f.impuesto_pct) : null,
     _intOrNull(f.impuesto_monto), _intOrNull(f.monto_liquido), usuario])
    .then(() => contabilizarComision(idSeguimiento, 'DEVENGO'));
}

/* ── Centralización contable de la comisión a dealer ──────────────────────────
   DEVENGO: al registrar la factura/boleta se reconoce el GASTO y el pasivo
     (con factura, el IVA como crédito fiscal; con boleta, la retención como
      pasivo con el SII hasta declararla en el F29).
   PAGO: solo rebaja el pasivo contra banco por el LÍQUIDO depositado.
   Nunca bloquea la operación de negocio (el motor jamás lanza).
   Las boletas además entran al auxiliar de honorarios → libro de honorarios y F29. */
async function contabilizarComision(idSeguimiento, momento) {
  try {
    const [[d]] = await pool.query(
      `SELECT s.num_op, fc.numero_factura, fc.fecha_factura, fc.es_boleta, fc.rut_dealer, fc.nombre_dealer,
              fc.monto_bruto, fc.impuesto_pct, fc.impuesto_monto, fc.monto_liquido
         FROM postventa_seguimiento s
         JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
        WHERE s.id = ?`, [idSeguimiento]);
    if (!d || d.monto_liquido == null) return;            // sin documento/desglose → nada que contabilizar
    const fecha = (d.fecha_factura ? new Date(d.fecha_factura) : new Date()).toISOString().slice(0, 10);
    const doc = d.es_boleta ? 'BOLETA' : 'FACTURA';
    const evento = momento === 'DEVENGO' ? `COMISION_DEV_${doc}` : `COMISION_PAGADA_${doc}`;
    const montos = d.es_boleta
      ? { honorario: Number(d.monto_bruto) || 0, retencion: Number(d.impuesto_monto) || 0, liquido: Number(d.monto_liquido) || 0 }
      : { neto: Number(d.monto_bruto) || 0, iva: Number(d.impuesto_monto) || 0, liquido: Number(d.monto_liquido) || 0 };
    await require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento, fecha,
      glosa: `Comisión OP ${d.num_op} — ${d.nombre_dealer || ''} ${doc.toLowerCase()} ${d.numero_factura || ''}`.slice(0, 300),
      ref: `COM-${d.num_op}-${momento}`, montos, num_op: d.num_op || null, rut: d.rut_dealer || null,
    });
    // Boleta de honorarios → auxiliar (libro de honorarios y F29 de retenciones)
    if (d.es_boleta && momento === 'DEVENGO' && d.rut_dealer && d.numero_factura) {
      // La tabla no tiene UNIQUE(rut,num_boleta): se actualiza si ya está (reingreso de la boleta)
      const [[ya]] = await pool.query(
        'SELECT id FROM ctb_honorarios_aux WHERE rut=? AND num_boleta=? LIMIT 1', [d.rut_dealer, String(d.numero_factura)]);
      const datos = [fecha.slice(0, 7), String(d.nombre_dealer || '').slice(0, 200), fecha,
        `Comisión OP ${d.num_op}`.slice(0, 200), d.monto_bruto, d.impuesto_pct, d.impuesto_monto, d.monto_liquido];
      if (ya) await pool.query(
        `UPDATE ctb_honorarios_aux SET mes=?, nombre=?, fecha_emision=?, glosa=?, bruto=?, tasa_retencion=?, retencion=?, liquido=? WHERE id=?`,
        [...datos, ya.id]).catch(() => {});
      else await pool.query(
        `INSERT INTO ctb_honorarios_aux (mes, nombre, fecha_emision, glosa, bruto, tasa_retencion, retencion, liquido, rut, num_boleta, origen)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'COMISION')`,
        [...datos, d.rut_dealer, String(d.numero_factura)]).catch(() => {});
    }
  } catch (e) { console.error('[contabilizarComision]', e.message); }
}

/* Saldo precio: CUENTA DE PASO (Máxima 4). AutoFácil es intermediario — la
   financiera transfiere el saldo y se entrega ÍNTEGRO al dealer. No es ingreso ni
   gasto: entra y sale por un pasivo transitorio, sin tocar el resultado. */
// `fecha` (opcional, YYYY-MM-DD): para regularizar pagos antiguos con la fecha en
// que ocurrieron. Sin ella, el asiento se emite con la fecha de hoy.
async function contabilizarSaldoPrecio(idSeguimiento, etapa, fecha = null) {
  try {
    const [[s]] = await pool.query(`
      SELECT s.num_op, s.saldo_precio, s.financiera, po.num_orden, po.monto AS odp_monto,
             COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS nombre_dealer,
             COALESCE(c.rut_dealer, dl.rut) AS rut_dealer
        FROM postventa_seguimiento s
        LEFT JOIN creditos c ON c.id = s.id_credito
        LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
        LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
       WHERE s.id = ?`, [idSeguimiento]);
    if (!s) return;
    /* El monto contable es el TOTAL de la orden, no el saldo precio pelado: en
       AUTOFIN la financiera gira —y al dealer se le transfiere— saldo +
       Limitación + Transferencia (confirmado con Pato el 13-08-2026). Con el
       saldo pelado, la cuenta de paso 2102045 quedaba descuadrada en $45.380 por
       operación. Se usa el monto CONGELADO de la orden cuando ya existe; si aún
       no se emite (caso FONDOS RECIBIDOS), lo calcula el motor único. */
    const monto = Math.round(s.odp_monto != null
      ? Number(s.odp_monto)
      : montoSaldoOrden(s.financiera, s.saldo_precio, await getFijosAutoFin()));
    if (!monto) return;
    const recibido = etapa === 'FONDOS RECIBIDOS';
    // Trazabilidad en el libro: N° de orden de pago + dealer en cada línea del asiento.
    const detalle = [s.num_orden, s.nombre_dealer].filter(Boolean).join(' · ');
    await require('../../../contabilidad/src/motor-asientos').contabilizar({
      evento: recibido ? 'SALDO_FONDOS_RECIBIDOS' : 'SALDO_PRECIO_PAGADO',
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }),
      glosa: `Saldo precio OP ${s.num_op} — ${recibido ? 'fondos recibidos' : 'pagado a ' + (s.nombre_dealer || 'dealer')}`.slice(0, 300),
      ref: `SP-${s.num_op}-${recibido ? 'IN' : 'OUT'}`, montos: { monto }, num_op: s.num_op || null,
      rut: s.rut_dealer || null, detalle,
    });
  } catch (e) { console.error('[contabilizarSaldoPrecio]', e.message); }
}

/* ── Reversa COMPLETA del pago (Máximas 2 y 4) ────────────────────────────────
   Deshacer la etapa PAGADO debe deshacer TAMBIÉN el timbre del correlativo y el
   asiento del egreso. Antes la reversa solo borraba la etapa y quedaba un
   híbrido: la ODP "pagada en duro" (imposible de anular) y la plata rebajada en
   contabilidad sin haber salido del banco (caso ODP2610744, transferencia
   rechazada, 18-08-2026). Nunca lanza: cada pieza se reversa en lo posible. */
async function reversarPagoCentral(track, ids, usuario, motivo) {
  const out = { correlativos: 0, asientos: 0, mesCerrado: [] };
  for (const id of ids) {
    try {
      const [[s]] = await pool.query('SELECT num_op FROM postventa_seguimiento WHERE id=?', [id]);
      const tabla = track === 'SALDO' ? 'postventa_ordenes' : 'postventa_ordenes_comision';
      const [[po]] = await pool.query(`SELECT id FROM \`${tabla}\` WHERE id_seguimiento=?`, [id]);
      if (po && await despagarCorrelativo({ origen: track, origen_id: po.id })) out.correlativos++;
      if (!s || !s.num_op) continue;
      // Asiento del egreso → ANULADO (el pago no se concretó). Mes cerrado: no se toca, se reporta.
      const ref = track === 'SALDO' ? `SP-${s.num_op}-OUT` : `COM-${s.num_op}-PAGO`;
      const [[ev]] = await pool.query(
        `SELECT e.id_comprobante, c.fecha FROM ctb_eventos_log e
           JOIN ctb_comprobantes c ON c.id = e.id_comprobante
          WHERE e.ref=? AND c.estado='CONTABILIZADO' ORDER BY e.id DESC LIMIT 1`, [ref]);
      if (!ev) continue;
      const mes = String(ev.fecha instanceof Date ? ev.fecha.toISOString() : ev.fecha).slice(0, 7);
      const [[cerrado]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [mes]);
      if (cerrado) {
        out.mesCerrado.push({ id_seguimiento: id, num_op: s.num_op, id_comprobante: ev.id_comprobante, mes });
        console.warn(`[reversarPagoCentral] comprobante ${ev.id_comprobante} (OP ${s.num_op}) es del mes CERRADO ${mes}: reversar a mano en Contabilidad`);
        continue;
      }
      const [r] = await pool.query(
        "UPDATE ctb_comprobantes SET estado='ANULADO', anulado_por=?, anulado_motivo=? WHERE id=? AND estado='CONTABILIZADO'",
        [usuario, `Reversa del pago en Post Venta (${String(motivo || 'reversa del mismo día').trim()})`.slice(0, 400), ev.id_comprobante]);
      if (r.affectedRows) out.asientos++;
    } catch (e) { console.error('[reversarPagoCentral]', e.message); }
    // Si el aviso de "pago realizado" está encendido, el dealer YA recibió ese
    // correo → hay que mandarle la corrección. Fire-and-forget: nunca frena la reversa.
    notificarReversaPagoDealer(track, id, motivo).catch(e => console.error('[postventa aviso reversa]', e.message));
  }
  return out;
}

/* Corrección al dealer cuando se reversa un pago YA AVISADO: solo se manda si el
   aviso de pago correspondiente está activo (si nunca se le avisó el pago, no hay
   nada que corregir). Mismo remitente y misma copia que el aviso original. */
async function notificarReversaPagoDealer(track, idSeguimiento, motivo) {
  try {
    const { enviarCorreo, remitentePorClave, remitenteComisiones, envolverHTML } = require('../../../../shared/mailer');
    let activo = false, from, ccFijo = '';
    if (track === 'SALDO') {
      const [[tRow]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_pago_saldo'");
      const tpl = tRow ? JSON.parse(tRow.valor) : {};
      activo = tpl.activo === true; from = remitentePorClave(tpl.remitente); ccFijo = String(tpl.cc_operaciones || '').trim();
    } else {
      const tpl = await require('../../../../shared/plantillas-correo').comoTpl('dealer_comision_pagada', 'correo_comision_pagada');
      activo = tpl.activo !== false; from = remitenteComisiones(); ccFijo = String(tpl.cc || '').trim();
    }
    if (!activo) return;                             // el pago nunca se avisó → nada que corregir
    if (track === 'COMISION') {                      // una factura = un correo: la corrección la manda solo la titular
      const [[fc]] = await pool.query('SELECT es_replica FROM postventa_facturas_comision WHERE id_seguimiento=?', [idSeguimiento]);
      if (fc && fc.es_replica) return;
    }
    const [[d]] = await pool.query(`
      SELECT s.num_op, COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer,
             COALESCE(dl.correo, dl.cf_email) AS correo
      FROM postventa_seguimiento s
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
      WHERE s.id = ?`, [idSeguimiento]);
    if (!d || !d.correo) return;
    // Texto paramétrico: plantilla dealer_pago_reversado del mantenedor Correos
    // del Sistema (junto a los avisos de pago). Su interruptor también manda.
    const tplR = await require('../../../../shared/plantillas-correo').comoTpl('dealer_pago_reversado');
    if (tplR.activo === false) return;
    const datos = { dealer: d.dealer || 'dealer', num_op: d.num_op || '', que_pago: track === 'SALDO' ? 'saldo de precio' : 'comisión',
      motivo: String(motivo || '').trim() || 'Reversa del pago registrada por Tesorería' };
    const rell = t => String(t || '').replace(/\{(\w+)\}/g, (m, k) => datos[k] != null ? datos[k] : m);
    const cuerpo = rell(tplR.cuerpo) + (tplR.firma ? '\n\n' + rell(tplR.firma) : '');
    const cc = [...new Set([ccFijo, String(tplR.cc || '').trim()].join(',').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))].join(',');
    await enviarCorreo({
      from, to: d.correo, cc: cc || undefined,
      subject: rell(tplR.asunto) || `Importante — aviso de pago sin efecto · Operación ${d.num_op}`,
      html: envolverHTML(cuerpo.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')),
      text: cuerpo,
    });
  } catch (e) { console.error('[notificarReversaPagoDealer]', e.message); }
}

/* Disparo ÚNICO (pedido de Pato 18-08-2026): la reversa del pago de la
   ODP2610744 (OP 26080033, HIDALGO AUTOMOTRIZ) ocurrió ANTES de que existiera
   el aviso automático — se le manda la corrección una sola vez desde producción
   (acá viven las credenciales de correo; local no las tiene, a propósito). */
/* Fuera de la fila del capataz (la cadena de boot puede demorar/atascarse):
   claim atómico directo en _migraciones — corre UNA vez, sin DDL, al cargar. */
(async () => {
  try {
    const [r] = await pool.query("INSERT IGNORE INTO _migraciones (nombre, estado) VALUES ('aviso-reversa-hidalgo-26080033','EN_CURSO')");
    if (!r.affectedRows) return;                     // ya corrió (o corre en otra instancia)
    await notificarReversaPagoDealer('SALDO', 900002, 'Transferencia rechazada por el banco');
    await pool.query("UPDATE _migraciones SET estado='OK', aplicada_en=NOW() WHERE nombre='aviso-reversa-hidalgo-26080033'");
    console.log('[postventa] corrección de reversa enviada a Hidalgo (ODP2610744)');
  } catch (e) { console.error('[postventa aviso-reversa-hidalgo]', e.message); }
})();

/* ── Alertas de proceso Saldo Precio (paramétricas, event-driven) ──────────────
   Cada transición del workflow genera una alerta (campana) a destinatarios
   configurables por evento: perfiles + el ejecutivo de la operación + usuarios extra. */
/* `sucede`: evento del paso ANTERIOR de la misma operación. Al emitirse este
   aviso, el del paso previo se retira de la campanita de todos — ya lo atendieron,
   y su existencia es justamente la prueba de que se atendió. Sin esto, un flujo de
   5 pasos deja 5 avisos vivos por operación pidiendo cosas ya hechas.
   `porPeriodo`: el aviso es uno por día (no por operación) y el nuevo reemplaza a
   los anteriores del mismo evento. */
const EVENTOS_SALDO = [
  { evento: 'fondos_recibidos', titulo: 'Fondos recibidos — emitir Orden de Pago',
    mensaje: 'La operación {op} tiene FONDOS RECIBIDOS. Emite la Orden de Pago.', href: '/postventa/orden-pago/' },
  { evento: 'orden_emitida', titulo: 'Orden de Pago emitida — cargar montos disponibles',
    mensaje: 'Se emitió la Orden de Pago de {op}. Carga los montos disponibles para pago.', href: '/postventa/saldos-a-pagar/',
    sucede: 'fondos_recibidos' },
  { evento: 'fondos_cargados', titulo: 'Montos disponibles cargados',
    mensaje: 'Tesorería cargó los fondos disponibles para pago de saldos precio. Define qué pagar.', href: '/postventa/saldos-a-pagar/',
    porPeriodo: true },
  { evento: 'enviado_pago', titulo: 'Operaciones enviadas a pago — confirmar pago',
    mensaje: 'Se enviaron operaciones a pago. Confirma el pago en Saldos Precios a Pagar.', href: '/postventa/saldos-a-pagar/',
    sucede: 'orden_emitida' },
  { evento: 'pago_realizado', titulo: 'Saldo precio pagado',
    mensaje: 'Se registró el pago del saldo precio de {op}.', href: '/postventa/seguimiento/',
    sucede: 'enviado_pago' },
];
/* ── Alertas de proceso Comisión (paramétricas, event-driven) ──────────────
   Espejo del flujo de Saldo Precio: la comisión se alimenta de las cartolas,
   se recibe la factura del concesionario, se emite la orden de pago, se
   selecciona qué se paga (Enviar a Pago) y se paga. */
const EVENTOS_COMISION = [
  { evento: 'com_factura_recibida', titulo: 'Factura recibida — emitir Orden de Pago de Comisión',
    mensaje: 'La operación {op} tiene FACTURA RECIBIDA. Emite la Orden de Pago de comisión.', href: '/postventa/orden-pago-comision/' },
  { evento: 'com_orden_emitida', titulo: 'Orden de Pago de Comisión emitida — cargar montos disponibles',
    mensaje: 'Se emitió la Orden de Pago de comisión de {op}. Carga los montos disponibles para pago.', href: '/postventa/comisiones-a-pagar/',
    sucede: 'com_factura_recibida' },
  { evento: 'com_fondos_cargados', titulo: 'Montos disponibles cargados (Comisión)',
    mensaje: 'Tesorería cargó los fondos disponibles para pago de comisiones. Define qué pagar.', href: '/postventa/comisiones-a-pagar/',
    porPeriodo: true },
  { evento: 'com_enviado_pago', titulo: 'Comisiones enviadas a pago — confirmar pago',
    mensaje: 'Se enviaron comisiones a pago. Confirma el pago en Comisiones a Pagar.', href: '/postventa/comisiones-a-pagar/',
    sucede: 'com_orden_emitida' },
  { evento: 'com_pago_realizado', titulo: 'Comisión pagada',
    mensaje: 'Se registró el pago de la comisión de {op}.', href: '/postventa/seguimiento/',
    sucede: 'com_enviado_pago' },
];
/* ── Alertas de proceso Comisión de PARQUES (paramétricas, event-driven) ────
   Flujo de /postventa/comisiones-parques/: al emitir la Orden de Pago se avisa
   a quien paga (default Tesorero), y al pagar se avisa además SIEMPRE a los
   ejecutivos del parque (eso es del flujo, no configurable). */
const EVENTOS_PARQUE = [
  { evento: 'parque_orden_emitida', titulo: 'Orden de Pago de Parque emitida — por pagar',
    mensaje: 'Se emitió la Orden de Pago de comisión de parque. Queda por pagar en Órdenes de Pago.', href: '/ordenes-pago/' },
  { evento: 'parque_pago_realizado', titulo: 'Comisión de parque pagada',
    mensaje: 'Se registró el pago de la comisión de un parque.', href: '/postventa/comisiones-parques/',
    sucede: 'parque_orden_emitida' },
];
const SONIDOS_SALDO = ['campana', 'dingdong', 'alarma', 'aplausos'];
require('../../../../shared/migrate').enFila('postventa', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS postventa_alertas_config (
      evento            VARCHAR(40) PRIMARY KEY,
      perfiles          TEXT,
      incluir_ejecutivo TINYINT(1) NOT NULL DEFAULT 0,
      usuarios_extra    TEXT,
      activo            TINYINT(1) NOT NULL DEFAULT 1,
      prioridad         VARCHAR(10) NOT NULL DEFAULT 'normal',
      sonido            TINYINT(1) NOT NULL DEFAULT 1,
      sonido_tipo       VARCHAR(20) NOT NULL DEFAULT 'campana',
      sonido_cada_seg   INT NOT NULL DEFAULT 30,
      sonido_max_min    INT NOT NULL DEFAULT 5
    )`);
    // Columnas para instalaciones que ya tenían la tabla (mismas variables que el resto de alertas)
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS prioridad VARCHAR(10) NOT NULL DEFAULT 'normal'`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido TINYINT(1) NOT NULL DEFAULT 1`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_tipo VARCHAR(20) NOT NULL DEFAULT 'campana'`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_cada_seg INT NOT NULL DEFAULT 30`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_max_min INT NOT NULL DEFAULT 5`).catch(()=>{});
    for (const e of [...EVENTOS_SALDO, ...EVENTOS_COMISION, ...EVENTOS_PARQUE])
      await pool.query(
        `INSERT IGNORE INTO postventa_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo)
         VALUES (?,?,?,?,1)`,
        [e.evento,
         e.evento === 'parque_orden_emitida' ? 'Administrador,Tesorero' : 'Administrador',
         (e.evento === 'pago_realizado' || e.evento === 'com_pago_realizado') ? 1 : 0, '']);
    console.log('[postventa] alertas_config OK');
  } catch (e) { console.error('[postventa alertas migration]', e.message); }
});

// Resuelve destinatarios y crea las notificaciones (campana) de un evento.
async function notificarEventoSaldo(evento, { op, id_seguimiento, ejecutivo, claveExtra } = {}) {
  try {
    const def = EVENTOS_SALDO.find(e => e.evento === evento)
             || EVENTOS_COMISION.find(e => e.evento === evento)
             || EVENTOS_PARQUE.find(e => e.evento === evento);
    if (!def) return;
    const sufijo = claveExtra || id_seguimiento;

    /* El paso anterior de ESTA operación ya está atendido: su aviso se retira.
       Se hace ANTES de resolver destinatarios y fuera del `if (!ids.size)`, para
       que la limpieza ocurra incluso si este evento no le avisa a nadie. */
    if (def.sucede && sufijo != null) {
      require('../../../../shared/avisos').retirar(`pvalert:${def.sucede}:${sufijo}`)
        .catch(e => console.error('[pvalert retirar]', e.message));
    }
    const [[cfg]] = await pool.query('SELECT * FROM postventa_alertas_config WHERE evento=?', [evento]);
    if (!cfg || !cfg.activo) return;

    const ids = new Set();
    // Perfiles
    const perfiles = String(cfg.perfiles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (perfiles.length) {
      const [us] = await pool.query(
        `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
         WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado <> 'inactivo')`, [perfiles]);
      us.forEach(u => ids.add(u.id_usuario));
    }
    // Ejecutivo de la operación (vía usuario_ejecutivos)
    if (cfg.incluir_ejecutivo && ejecutivo) {
      try {
        const [us] = await pool.query('SELECT id_usuario FROM usuario_ejecutivos WHERE ejecutivo = ?', [ejecutivo]);
        us.forEach(u => ids.add(u.id_usuario));
      } catch (_) {}
    }
    // Usuarios extra (CSV de id_usuario)
    String(cfg.usuarios_extra || '').split(',').map(s => parseInt(s.trim())).filter(Boolean).forEach(id => ids.add(id));

    if (!ids.size) return;
    let dest = [...ids];
    try { dest = await require('../../../../shared/backups').expandirAlerta(dest); } catch (_) {}
    const mensaje = def.mensaje.replace('{op}', op != null ? ('N° ' + op) : 'una operación');
    /* La clave identifica el HECHO, nunca el instante: un `Date.now()` acá hacía
       que cada disparo naciera con clave nueva, así que el "ya existe" nunca daba
       y los avisos se apilaban repitiendo lo mismo. */
    const clave = `pvalert:${evento}:${sufijo != null ? sufijo : 'general'}`;
    // Aviso por período (uno por día): el nuevo reemplaza a los de días anteriores.
    if (def.porPeriodo) {
      await require('../../../../shared/avisos')
        .retirarPrefijo(`pvalert:${evento}:`, { excepto: clave })
        .catch(e => console.error('[pvalert periodo]', e.message));
    }
    const prioridad = cfg.prioridad || 'normal';
    const sonar = cfg.sonido ? 1 : 0;
    const sonTipo = SONIDOS_SALDO.includes(cfg.sonido_tipo) ? cfg.sonido_tipo : 'campana';
    const sonCada = cfg.sonido_cada_seg || 30;
    const sonMax = cfg.sonido_max_min || 5;
    for (const uid of dest) {
      const [[ex]] = await pool.query(
        'SELECT 1 FROM notificaciones WHERE id_usuario=? AND clave=? AND leida=0 LIMIT 1', [uid, clave]);
      if (ex) continue;
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar, son_cada, son_max, son_tipo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uid, 'alerta', def.titulo, mensaje, def.href, clave, prioridad, sonar, sonCada, sonMax, sonTipo]);
    }
  } catch (e) { console.error('[notificarEventoSaldo]', evento, e.message); }
}

// Lee num_op y ejecutivo de un seguimiento (para el contexto de la alerta)
async function ctxSeguimiento(id) {
  try {
    const [[r]] = await pool.query('SELECT num_op, ejecutivo FROM postventa_seguimiento WHERE id=?', [id]);
    return r || {};
  } catch (_) { return {}; }
}

/* ── POST /api/postventa/sync — incluye los otorgados nuevos ─────── */
const sync = async (req, res) => {
  try {
    const [r1] = await pool.query(`
      INSERT INTO postventa_seguimiento
        (id_credito, num_op, financiera, nombre_dealer, ejecutivo, fecha_otorgado, saldo_precio, comision)
      SELECT c.id,
             COALESCE(c.num_op, CASE WHEN c.numero_credito REGEXP '^[0-9]+$' THEN CAST(c.numero_credito AS UNSIGNED) ELSE NULL END),
             c.financiera, c.automotora, c.ejecutivo,
             DATE(c.fecha_otorgado), c.saldo_precio, c.comdea_real
      FROM creditos c
      WHERE c.fecha_otorgado IS NOT NULL
        AND c.estado_credito = 'OTORGADO'   -- Post Venta es SOLO post-otorgamiento: un rechazado/digitado/aprobado con fecha_otorgado NO debe generar seguimiento
        AND NOT EXISTS (SELECT 1 FROM postventa_seguimiento s WHERE s.id_credito = c.id)
    `);
    // N° Operación: SIEMPRE espejo de creditos (fuente única). No solo backfill de
    // NULL: si el num_op se corrige en BD Operaciones, acá debe cambiar también —
    // antes el seguimiento quedaba mostrando el número viejo para siempre.
    await pool.query(`
      UPDATE postventa_seguimiento s JOIN creditos c ON c.id = s.id_credito
      SET s.num_op = COALESCE(c.num_op, CAST(c.numero_credito AS UNSIGNED))
      WHERE (c.num_op IS NOT NULL OR c.numero_credito REGEXP '^[0-9]+$')
        AND (s.num_op IS NULL OR s.num_op <> COALESCE(c.num_op, CAST(c.numero_credito AS UNSIGNED)))
    `).catch(e => console.error('[postventa backfill num_op]', e.message));
    // Saldo precio y comisión: TAMBIÉN espejo de creditos (fuente única, Máxima 2).
    // Si Operaciones corrige el crédito después de otorgado, la ODP debe salir por
    // el valor corregido — antes el seguimiento guardaba la foto del día del sync
    // para siempre (OP 89246: ODP por $16,7M cuando el SP corregido era $11,6M).
    await pool.query(`
      UPDATE postventa_seguimiento s JOIN creditos c ON c.id = s.id_credito
      SET s.saldo_precio = c.saldo_precio, s.comision = c.comdea_real
      WHERE COALESCE(s.saldo_precio,-1) <> COALESCE(c.saldo_precio,-1)
         OR COALESCE(s.comision,-1) <> COALESCE(c.comdea_real,-1)
    `).catch(e => console.error('[postventa espejo sp/comision]', e.message));
    // Etapas "Sistema" automáticas para los nuevos
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'SALDO', 'FUNDANTES PENDIENTES', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='SALDO' AND e.etapa='FUNDANTES PENDIENTES')`);
    // COMISIÓN PENDIENTE se activa al otorgar; COMISION A PAGAR ya no (esa la
    // marca FONDOS RECIBIDOS del saldo — la comisión se paga con la plata en mano).
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'COMISION', 'COMISION PENDIENTE', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION PENDIENTE')`);
    /* Track PARQUE: atribución igual que Comisiones Parques a Pagar (dealers.ccs_parque
       vía el dealer del crédito; fallback texto creditos.parque; CALLE no es parque) y
       monto = creditos.com_parque, ya persistido por el motor único comision-dealer. */
    await pool.query(`
      UPDATE postventa_seguimiento s
        JOIN creditos c ON c.id = s.id_credito
        LEFT JOIN dealers d ON d.id_dealer = c.id_dealer
          OR (c.id_dealer IS NULL AND d.rut IS NOT NULL AND
              REPLACE(REPLACE(UPPER(d.rut),'.',''),'-','') = REPLACE(REPLACE(UPPER(COALESCE(c.rut_dealer,'')),'.',''),'-',''))
      SET s.parque = COALESCE(
            (SELECT p.nombre FROM parques_comisiones p WHERE UPPER(p.nombre) = UPPER(TRIM(COALESCE(d.ccs_parque,''))) LIMIT 1),
            (SELECT p.nombre FROM parques_comisiones p WHERE UPPER(p.nombre) = UPPER(TRIM(COALESCE(c.parque,''))) LIMIT 1)),
          s.com_parque = c.com_parque`).catch(e => console.error('[postventa sync parque]', e.message));
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'PARQUE', 'COMISION A PAGAR', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE s.parque IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM postventa_etapas e
          WHERE e.id_seguimiento = s.id AND e.track='PARQUE' AND e.etapa='COMISION A PAGAR')`);
    res.json({ success: true, data: { nuevos: r1.affectedRows }, error: null });
  } catch (e) {
    console.error('[postventa sync]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa — seguimientos + etapas marcadas ─────────── */
const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.id_credito, s.num_op, s.financiera, s.ejecutivo,
             c.id_financiera, s.parque, s.com_parque,
             s.fecha_otorgado, s.saldo_precio, s.comision,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer)  AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut, s.rut_dealer)         AS rut_dealer,
             fc.fecha_factura AS fac_fecha, fc.numero_factura AS fac_numero, fc.monto_bruto AS fac_monto,
             fc.es_terceros AS fac_terceros, fc.es_boleta AS fac_boleta,
             fc.impuesto_pct AS fac_imp_pct, fc.impuesto_monto AS fac_imp_monto,
             fc.monto_liquido AS fac_liquido,   -- lo que EFECTIVAMENTE se deposita
             s.fundantes_devueltos_en, s.fundantes_devueltos_por, s.fundantes_devueltos_motivo
      FROM postventa_seguimiento s
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      /* Una operación ANULADA no tiene saldo precio ni comisión que pagar: sale
         del seguimiento sola, sin borrar su historia. El sync solo INSERTA los
         otorgados, pero nunca sacaba a los que se anulaban después, y quedaban
         pidiendo etapas para siempre (10 casos al 07-08-2026). Se excluye solo
         ANULADO — un PREPAGADO sí sigue: su saldo precio puede estar pendiente. */
      WHERE c.id IS NULL OR COALESCE(c.estado_credito, '') <> 'ANULADO'
      ORDER BY s.fecha_otorgado DESC, s.id DESC LIMIT 1000`);
    const [etapas] = await pool.query(
      `SELECT id_seguimiento, track, etapa, usuario, fecha FROM postventa_etapas
       WHERE id_seguimiento IN (SELECT id FROM postventa_seguimiento)`);
    const map = {};
    etapas.forEach(e => (map[e.id_seguimiento] = map[e.id_seguimiento] || []).push(e));
    rows.forEach(r => r.etapas = map[r.id] || []);
    res.json({ success: true, data: rows, fijos: await getFijosAutoFin(), error: null });
  } catch (e) {
    console.error('[postventa getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── COMISION A PAGAR automática: se marca cuando el saldo precio de la misma
   operación queda con FONDOS RECIBIDOS (la comisión se paga con la plata en mano).
   Se llama desde setEtapa y desde los flujos de ODP de saldo que fuerzan esa etapa. */
async function marcarComisionAPagar(ids) {
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return;
  const vals = [];
  for (const id of ids) {
    vals.push([id, 'COMISION', 'COMISION PENDIENTE', 'Sistema']);
    vals.push([id, 'COMISION', 'COMISION A PAGAR', 'Sistema']);
  }
  await pool.query('INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?', [vals])
    .catch(e => console.error('[postventa comisionAPagar]', e.message));
  // Emisión de Cartolas: el movimiento COMISION de la operación pasa solo de
  // PENDIENTE → A PAGAR (el dropdown sigue editable; A DESCONTAR y los cambios
  // manuales no se tocan).
  // Enlace por carta (id_carta) o, para las "Otorgadas sin carta" (id_carta NULL),
  // por número: su num_op puede traer el N° Operación o el ID Financiera.
  const ph = ids.map(() => '?').join(',');
  await pool.query(`
    UPDATE cartolas_movimientos m
    LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
    JOIN creditos c
      ON (ca.id_credito_creado IS NOT NULL AND c.id = ca.id_credito_creado)
      OR (m.id_carta IS NULL AND (CAST(m.num_op AS CHAR) = CAST(c.num_op AS CHAR) OR CAST(m.num_op AS CHAR) = CAST(c.id_financiera AS CHAR)))
    JOIN postventa_seguimiento s ON s.id_credito = c.id
    SET m.estado_comision='A PAGAR', m.estado_usuario='Sistema', m.estado_fecha=NOW()
    WHERE s.id IN (${ph}) AND m.movimiento='COMISION' AND m.estado_comision='PENDIENTE'
      AND m.mes_cartola IS NULL
      AND NOT EXISTS (SELECT 1 FROM postventa_etapas pg
        WHERE pg.id_seguimiento = s.id AND pg.track='COMISION' AND pg.etapa='COMISION PAGADA')`, ids)
    .catch(e => console.error('[postventa comisionAPagar cartola]', e.message));
}

/* Rut del dealer resuelto igual que getAll (creditos → dealers → seguimiento) */
async function rutDealerDe(idSeguimiento) {
  const [[r]] = await pool.query(`
    SELECT COALESCE(c.rut_dealer, d.rut, s.rut_dealer) AS rut, s.nombre_dealer
    FROM postventa_seguimiento s
    LEFT JOIN creditos c ON c.id = s.id_credito
    LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
    WHERE s.id = ?`, [idSeguimiento]);
  return r || {};
}

/* ── La factura es UNA por cartola: al registrarla en una operación se replica
   a las demás ops del mismo dealer que ya tienen CARTOLA ENVIADA y aún no tienen
   factura. La réplica lleva el número y la fecha pero NO los montos (esos viven
   solo en la titular: una sola ODP y un solo asiento contable). ── */
async function replicarFacturaComision(idTitular, usuario) {
  const [[fac]] = await pool.query('SELECT * FROM postventa_facturas_comision WHERE id_seguimiento=?', [idTitular]);
  if (!fac || fac.es_replica) return 0;
  const dl = await rutDealerDe(idTitular);
  if (!dl.rut && !dl.nombre_dealer) return 0;
  const [sibs] = await pool.query(`
    SELECT s.id, s.num_op FROM postventa_seguimiento s
    LEFT JOIN creditos c ON c.id = s.id_credito
    LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
    JOIN postventa_etapas ec ON ec.id_seguimiento = s.id AND ec.track='COMISION' AND ec.etapa='CARTOLA ENVIADA'
    WHERE s.id <> ?
      AND (
        (? IS NOT NULL AND REPLACE(REPLACE(UPPER(COALESCE(c.rut_dealer, d.rut, s.rut_dealer,'')),'.',''),'-','') = REPLACE(REPLACE(UPPER(?),'.',''),'-',''))
        OR (? IS NULL AND s.nombre_dealer = ?)
      )
      AND NOT EXISTS (SELECT 1 FROM postventa_etapas ef
        WHERE ef.id_seguimiento = s.id AND ef.track='COMISION' AND ef.etapa='FACTURA RECIBIDA')`,
    [idTitular, dl.rut || null, dl.rut || '', dl.rut || null, dl.nombre_dealer || '']);
  for (const s of sibs) {
    await pool.query(
      `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), fecha=NOW()`,
      [s.id, 'COMISION', 'FACTURA RECIBIDA', usuario]);
    await pool.query(
      `INSERT INTO postventa_facturas_comision
         (id_seguimiento, num_op, rut_dealer, nombre_dealer, fecha_factura, numero_factura,
          es_terceros, es_boleta, es_replica, id_titular, usuario)
       VALUES (?,?,?,?,?,?,?,?,1,?,?)
       ON DUPLICATE KEY UPDATE fecha_factura=VALUES(fecha_factura), numero_factura=VALUES(numero_factura),
         es_replica=1, id_titular=VALUES(id_titular), usuario=VALUES(usuario)`,
      [s.id, s.num_op, fac.rut_dealer, fac.nombre_dealer, fac.fecha_factura, fac.numero_factura,
       fac.es_terceros ? 1 : 0, fac.es_boleta ? 1 : 0, idTitular, usuario]);
  }
  return sibs.length;
}

/* ── Aviso automático al dealer cuando su comisión queda PAGADA: sale desde
   comisiones@ (remitenteComisiones), plantilla paramétrica en postventa_config
   'correo_comision_pagada'. Se envía UNA vez por factura (por la titular).
   Nunca lanza: un correo caído no puede frenar el pago. ── */
/* Aviso al DEALER cuando Tesorería paga su SALDO PRECIO (gatillado por pagarOrden
   de origen SALDO). Plantilla correo_pago_saldo del mantenedor — nace INACTIVA.
   CC: ejecutivo comercial de la operación + Jefes Comerciales activos (por perfil)
   + grupo de Operaciones (editable en el mantenedor). */
async function notificarPagoSaldoDealer(idSeguimiento) {
  try {
    const [[tRow]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_pago_saldo'");
    const tpl = tRow ? JSON.parse(tRow.valor) : {};
    if (tpl.activo !== true) return;                 // nace inactivo: solo manda si Pato lo enciende
    const [[d]] = await pool.query(`
      SELECT s.num_op, s.saldo_precio, s.ejecutivo, s.financiera,
             po.monto AS odp_monto, po.num_orden,
             COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer,
             COALESCE(dl.correo, dl.cf_email) AS correo,
             COALESCE(dl.tipo_cuenta, dl.cuenta_tipo) AS tipo_cuenta, dl.num_cuenta, dl.banco
      FROM postventa_seguimiento s
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
      LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
      WHERE s.id = ?`, [idSeguimiento]);
    if (!d) return;
    if (!d.correo) { console.warn('[postventa aviso pago saldo] dealer sin correo — OP', d.num_op); return; }

    // CC: ejecutivo de la operación (email desde usuarios) + Jefes Comerciales + grupo Operaciones
    const cc = new Set();
    if (String(tpl.cc_operaciones || '').trim()) cc.add(String(tpl.cc_operaciones).trim().toLowerCase());
    try {
      const [[ej]] = await pool.query(
        `SELECT email FROM usuarios WHERE UPPER(TRIM(CONCAT(nombre,' ',COALESCE(apellido,'')))) = UPPER(TRIM(?)) AND email IS NOT NULL LIMIT 1`,
        [d.ejecutivo || '']);
      if (ej && ej.email) cc.add(String(ej.email).toLowerCase());
    } catch (_) {}
    try {
      const [jefes] = await pool.query(
        `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
         WHERE p.nombre = 'Jefe Comercial' AND u.estado = 'activo' AND u.email IS NOT NULL`);
      jefes.forEach(j => cc.add(String(j.email).toLowerCase()));
    } catch (_) {}

    const fmt = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
    /* {monto} = lo que se le TRANSFIRIÓ al dealer, no el saldo precio pelado: en
       AUTOFIN la orden suma Limitación + Transferencia, y el correo avisaba un
       monto menor al depositado. Manda el monto congelado de la orden; si aún no
       existe, el motor único lo calcula igual que al emitirla. */
    const montoPagado = d.odp_monto != null
      ? Number(d.odp_monto)
      : montoSaldoOrden(d.financiera, d.saldo_precio, await getFijosAutoFin());
    const datos = {
      dealer: d.dealer || '', num_op: d.num_op || '', monto: fmt(montoPagado),
      saldo_precio: fmt(d.saldo_precio), num_orden: d.num_orden || '',
      fecha_pago: new Date().toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }),
      financiera: d.financiera || '',
      tipo_cuenta: (d.tipo_cuenta || 'cuenta corriente').toLowerCase(),
      num_cuenta: d.num_cuenta || '—', banco: d.banco || '—',
    };
    const rell = t => String(t || '').replace(/\{(\w+)\}/g, (m, k) => datos[k] != null ? datos[k] : m);
    const { enviarCorreo, remitentePorClave, envolverHTML } = require('../../../../shared/mailer');
    const escH = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cuerpo = rell(tpl.cuerpo) + (tpl.firma ? '\n\n' + rell(tpl.firma) : '');
    await enviarCorreo({
      from: remitentePorClave(tpl.remitente),
      to: d.correo,
      cc: [...cc].join(','),
      subject: rell(tpl.asunto) || 'Saldo Precio pagado',
      html: envolverHTML(escH(cuerpo).replace(/\n/g, '<br>')),
      text: cuerpo,
    });
  } catch (e) { console.error('[postventa aviso pago saldo]', e.message); }
}

async function notificarPagoComisionDealer(idSeguimiento) {
  try {
    const [[d]] = await pool.query(`
      SELECT s.num_op, fc.numero_factura, fc.es_boleta, fc.es_replica,
             COALESCE(NULLIF(dl.nombre_indexa,''), dl.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer,
             COALESCE(dl.correo, dl.cf_email) AS correo,
             COALESCE(dl.tipo_cuenta, dl.cuenta_tipo) AS tipo_cuenta, dl.num_cuenta, dl.banco
      FROM postventa_seguimiento s
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  dl ON dl.id_dealer = c.id_dealer
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      WHERE s.id = ?`, [idSeguimiento]);
    if (!d) return;
    if (d.es_replica) return;                       // el aviso lo manda la titular (una factura = un correo)
    if (!d.correo) { console.warn('[postventa aviso pago] dealer sin correo — OP', d.num_op); return; }
    // OPs cubiertas por la factura (titular + réplicas)
    const [reps] = await pool.query(
      'SELECT num_op FROM postventa_facturas_comision WHERE id_titular=? AND es_replica=1', [idSeguimiento]);
    const ops = [d.num_op, ...reps.map(r => r.num_op)].filter(Boolean).join(', ') || String(d.num_op || '');
    // La plantilla vive en el mantenedor único Correos del Sistema (antes en postventa_config)
    const tpl = await require('../../../../shared/plantillas-correo').comoTpl('dealer_comision_pagada', 'correo_comision_pagada');
    if (tpl.activo === false) return;               // interruptor del mantenedor: aviso desactivado
    const datos = {
      doc: d.es_boleta ? 'boleta' : 'factura',
      numero_factura: d.numero_factura || '—',
      dealer: d.dealer || '',
      tipo_cuenta: (d.tipo_cuenta || 'cuenta corriente').toLowerCase(),
      num_cuenta: d.num_cuenta || '—',
      banco: d.banco || '—',
      ops,
    };
    const rell = t => String(t || '').replace(/\{(\w+)\}/g, (m, k) => datos[k] != null ? datos[k] : m);
    const { enviarCorreo, remitenteComisiones, envolverHTML } = require('../../../../shared/mailer');
    const escH = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cuerpo = rell(tpl.cuerpo) + (tpl.firma ? '\n\n' + tpl.firma : '');
    await enviarCorreo({
      from: remitenteComisiones(),
      to: d.correo,
      cc: tpl.cc || undefined,              // copia fija del mantenedor
      subject: rell(tpl.asunto) || 'Comisión pagada',
      html: envolverHTML(escH(cuerpo).replace(/\n/g, '<br>')),
      text: cuerpo,
    });
  } catch (e) { console.error('[postventa aviso pago dealer]', e.message); }
}

/* ── POST /api/postventa/probar-correos — envía las DOS plantillas de correo al
   dealer (cartola y aviso de pago) con datos de ejemplo, a los destinatarios
   indicados. `adjunto` (base64, opcional) viaja en el correo de cartola.
   Solo mantenedores (requireFunc en la ruta). ── */
const probarCorreos = async (req, res) => {
  try {
    const to = String(req.body.to || '').trim();
    if (!to) return res.status(400).json({ success: false, data: null, error: 'Destinatarios requeridos' });
    const { enviarCorreo, remitente, remitenteComisiones, envolverHTML } = require('../../../../shared/mailer');
    const escH = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const aHtml = t => escH(t).replace(/\n/g, '<br>');
    const rell = (t, datos) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => datos[k] != null ? datos[k] : m);
    // Las plantillas viven en el mantenedor único Correos del Sistema
    const _plant = require('../../../../shared/plantillas-correo');
    const tCta = await _plant.comoTpl('dealer_cartola_envio', 'correo_cartola_dealer');
    const tPag = await _plant.comoTpl('dealer_comision_pagada', 'correo_comision_pagada');
    const dCta = { dealer: 'AUTOMOTORA DE PRUEBA SPA', mes: 'Agosto 2026', total: '$1.234.567' };
    const dPag = { doc: 'factura', numero_factura: '12345', dealer: 'AUTOMOTORA DE PRUEBA SPA',
                   tipo_cuenta: 'cuenta corriente', num_cuenta: '00-123-45678-9', banco: 'BANCO DE CHILE', ops: '26080001, 26080002' };
    const adj = [];
    if (req.body.adjunto && req.body.adjunto.base64)
      adj.push({ filename: req.body.adjunto.nombre || 'cartola.pdf', content: Buffer.from(req.body.adjunto.base64, 'base64') });
    const cuerpoCta = rell(tCta.cuerpo, dCta) + (tCta.firma ? '\n\n' + rell(tCta.firma, dCta) : '');
    const cuerpoPag = rell(tPag.cuerpo, dPag) + (tPag.firma ? '\n\n' + rell(tPag.firma, dPag) : '');
    const r1 = await enviarCorreo({
      from: remitente(), to,
      subject: '[PRUEBA] ' + (rell(tCta.asunto, dCta) || 'Cartola'),
      html: envolverHTML(aHtml(cuerpoCta)), text: cuerpoCta, attachments: adj });
    const r2 = await enviarCorreo({
      from: remitenteComisiones(), to,
      subject: '[PRUEBA] ' + (rell(tPag.asunto, dPag) || 'Comisión pagada'),
      html: envolverHTML(aHtml(cuerpoPag)), text: cuerpoPag });
    res.json({ success: r1.ok && r2.ok, data: { cartola: r1, pagada: r2 }, error: (!r1.ok && r1.error) || (!r2.ok && r2.error) || null });
  } catch (e) {
    console.error('[postventa probarCorreos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* Grupo de la factura: la titular + sus réplicas (para propagar ODP/envío/pago) */
async function idsGrupoFactura(id) {
  const [[f]] = await pool.query('SELECT es_replica, id_titular FROM postventa_facturas_comision WHERE id_seguimiento=?', [id]);
  const titular = f && f.es_replica && f.id_titular ? f.id_titular : Number(id);
  const [reps] = await pool.query('SELECT id_seguimiento FROM postventa_facturas_comision WHERE id_titular=? AND es_replica=1', [titular]);
  return [...new Set([Number(id), titular, ...reps.map(r => Number(r.id_seguimiento))])];
}

/* ── PUT /api/postventa/:id/etapa { track, etapa, marcar } ───────── */
const ETAPAS_SISTEMA = ['FUNDANTES PENDIENTES', 'COMISION PENDIENTE'];
const setEtapa = async (req, res) => {
  try {
    const { track, etapa, marcar } = req.body;
    if (!['SALDO','COMISION','PARQUE'].includes(track) || !etapa)
      return res.status(400).json({ success: false, data: null, error: 'track y etapa requeridos' });
    if (ETAPAS_SISTEMA.includes(etapa))
      return res.status(400).json({ success: false, data: null, error: 'Etapa de sistema — no editable' });
    // En PARQUE la primera etapa sigue siendo COMISION A PAGAR (la marca el sync)
    if (track === 'PARQUE' && etapa === 'COMISION A PAGAR')
      return res.status(400).json({ success: false, data: null, error: 'Etapa de sistema — no editable' });
    if (track === 'COMISION' && etapa === 'COMISION A PAGAR')
      return res.status(400).json({ success: false, data: null, error: '"COMISION A PAGAR" se marca automáticamente al marcar FONDOS RECIBIDOS en el track Saldo Precio de la operación' });
    if (track === 'COMISION' && etapa === 'CARTOLA ENVIADA')
      return res.status(400).json({ success: false, data: null, error: '"CARTOLA ENVIADA" se marca automáticamente al enviar la cartola al dealer (Emisión de Cartolas)' });
    // Etapas automáticas: solo se marcan desde sus módulos dedicados
    if (track === 'SALDO' && etapa === 'FUNDANTES RECIBIDOS')
      return res.status(400).json({ success: false, data: null, error: `"FUNDANTES RECIBIDOS" se marca automáticamente al aprobar los fundantes en Seguimiento Fundantes (Operaciones)` });
    if (track === 'SALDO' && ['ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO'].includes(etapa))
      return res.status(400).json({ success: false, data: null, error: `"${etapa}" se marca automáticamente desde su módulo (Emisión Orden de Pago / Saldos Precios a Pagar)` });
    if (track === 'COMISION' && ['ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'].includes(etapa))
      return res.status(400).json({ success: false, data: null, error: `"${etapa}" se marca automáticamente desde su módulo (Emisión Orden de Pago Comisión / Comisiones a Pagar)` });
    if (track === 'PARQUE' && ['ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'].includes(etapa))
      return res.status(400).json({ success: false, data: null, error: `"${etapa}" se marca automáticamente desde Comisiones Parques a Pagar (al emitir la ODP del parque y al pagarla)` });

    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);

    // Cargar config para orden y permisos
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave = ?`,
      [track === 'SALDO' ? 'etapas_saldo' : track === 'PARQUE' ? 'etapas_parque' : 'etapas_comision']);
    const listaEtapas = cfgRow ? JSON.parse(cfgRow.valor) : [];
    const idxEtapa = listaEtapas.findIndex(x => x.etapa === etapa);
    if (idxEtapa < 0) return res.status(400).json({ success: false, data: null, error: 'Etapa no reconocida' });

    // Validar permisos de perfil para esta etapa
    if (!esAdmin) {
      const cfgKey = track === 'SALDO' ? 'etapa_perfiles_saldo' : track === 'PARQUE' ? 'etapa_perfiles_parque' : 'etapa_perfiles_comision';
      const [[permRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave = ?`, [cfgKey]);
      if (permRow) {
        const permisos = JSON.parse(permRow.valor); // array de arrays, índice = posición etapa
        const permitidos = permisos[idxEtapa] || [];
        if (permitidos.length && !permitidos.includes(req.usuario?.perfil_nombre))
          return res.status(403).json({ success: false, data: null, error: `Tu perfil no tiene permiso para marcar "${etapa}"` });
      }
    }

    // Etapas actualmente marcadas para este seguimiento
    const [marcadas] = await pool.query(
      `SELECT etapa, fecha FROM postventa_etapas WHERE id_seguimiento = ? AND track = ?`,
      [req.params.id, track]);
    const marcadasSet = new Set(marcadas.map(m => m.etapa));

    if (marcar) {
      // Validación secuencial: la etapa anterior debe estar marcada
      if (idxEtapa > 0) {
        const etapaAnterior = listaEtapas[idxEtapa - 1].etapa;
        if (!marcadasSet.has(etapaAnterior))
          return res.status(400).json({ success: false, data: null, error: `Debes marcar primero "${etapaAnterior}"` });
      }
      // La cartola se emite con las operaciones hasta el último día del mes
      // anterior: una otorgada este mes entra recién en la cartola siguiente.
      if (track === 'COMISION' && etapa === 'CARTOLA EMITIDA' && !esAdmin) {
        const [[sg]] = await pool.query('SELECT fecha_otorgado FROM postventa_seguimiento WHERE id=?', [req.params.id]);
        const ini = new Date(); ini.setDate(1);
        if (sg && sg.fecha_otorgado && new Date(sg.fecha_otorgado) >= new Date(ini.toISOString().slice(0, 10)))
          return res.status(400).json({ success: false, data: null, error: 'La cartola incluye operaciones hasta el último día del mes anterior — esta operación se otorgó este mes y entra en la cartola siguiente' });
      }
      await pool.query(
        `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE usuario = VALUES(usuario), fecha = NOW()`,
        [req.params.id, track, etapa, usuario]);
      // FACTURA RECIBIDA de comisión: guardar datos de la factura/boleta (incl. excepciones)
      // y replicarla a las demás operaciones de la misma cartola (una factura por cartola).
      if (track === 'COMISION' && etapa === 'FACTURA RECIBIDA' && req.body.factura) {
        const f = req.body.factura;
        await guardarFacturaComision(req.params.id, f, usuario);
        const n = await replicarFacturaComision(Number(req.params.id), usuario)
          .catch(e => { console.error('[postventa replicar factura]', e.message); return 0; });
        if (n) console.log(`[postventa] factura replicada a ${n} operación(es) de la cartola`);
      }
    } else {
      // Validación desmarcar: debe ser la última marcada
      let lastIdx = -1;
      listaEtapas.forEach((x, i) => { if (marcadasSet.has(x.etapa)) lastIdx = i; });
      if (idxEtapa !== lastIdx)
        return res.status(400).json({ success: false, data: null, error: 'Solo puedes desmarcar la última etapa marcada' });

      // Validación mismo día (solo no-admin)
      if (!esAdmin) {
        const fechaMarca = marcadas.find(m => m.etapa === etapa)?.fecha;
        if (fechaMarca) {
          const F = require('../../../../shared/fecha-chile');
          const hoy = F.hoyISO(), diaM = F.isoDe(fechaMarca); // día de Chile: con UTC no se podía desmarcar de noche lo marcado en la tarde
          if (diaM !== hoy)
            return res.status(403).json({ success: false, data: null, error: 'Solo puedes desmarcar etapas marcadas hoy' });
        }
      }
      await pool.query(
        'DELETE FROM postventa_etapas WHERE id_seguimiento = ? AND track = ? AND etapa = ?',
        [req.params.id, track, etapa]);
      // Al desmarcar FACTURA RECIBIDA de comisión, borrar los datos de la factura
      // (si era la titular, también sus réplicas: la factura es una sola).
      if (track === 'COMISION' && etapa === 'FACTURA RECIBIDA') {
        const [reps] = await pool.query(
          'SELECT id_seguimiento FROM postventa_facturas_comision WHERE id_titular=? AND es_replica=1', [req.params.id]);
        for (const r of reps) {
          await pool.query(`DELETE FROM postventa_etapas WHERE id_seguimiento=? AND track='COMISION' AND etapa='FACTURA RECIBIDA'`, [r.id_seguimiento]);
          await pool.query('DELETE FROM postventa_facturas_comision WHERE id_seguimiento=?', [r.id_seguimiento]);
        }
        await pool.query('DELETE FROM postventa_facturas_comision WHERE id_seguimiento = ?', [req.params.id]);
      }
      // Al desmarcar FONDOS RECIBIDOS del saldo, revertir la COMISION A PAGAR
      // automática (solo si la comisión no avanzó más allá) — y el movimiento de
      // cartola que el automatismo dejó A PAGAR vuelve a PENDIENTE (simétrico).
      if (track === 'SALDO' && etapa === 'FONDOS RECIBIDOS') {
        await pool.query(`
          DELETE e FROM postventa_etapas e
          WHERE e.id_seguimiento=? AND e.track='COMISION' AND e.etapa='COMISION A PAGAR'
            AND NOT EXISTS (SELECT 1 FROM (SELECT id_seguimiento, etapa FROM postventa_etapas WHERE track='COMISION') x
              WHERE x.id_seguimiento = e.id_seguimiento AND x.etapa NOT IN ('COMISION PENDIENTE','COMISION A PAGAR'))`,
          [req.params.id]).catch(() => {});
        await pool.query(`
          UPDATE cartolas_movimientos m
          LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
          JOIN creditos c
            ON (ca.id_credito_creado IS NOT NULL AND c.id = ca.id_credito_creado)
            OR (m.id_carta IS NULL AND (CAST(m.num_op AS CHAR) = CAST(c.num_op AS CHAR) OR CAST(m.num_op AS CHAR) = CAST(c.id_financiera AS CHAR)))
          JOIN postventa_seguimiento s ON s.id_credito = c.id
          SET m.estado_comision='PENDIENTE', m.estado_usuario='Sistema', m.estado_fecha=NOW()
          WHERE s.id=? AND m.movimiento='COMISION' AND m.estado_comision='A PAGAR'
            AND m.estado_usuario='Sistema' AND m.mes_cartola IS NULL
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas ap
              WHERE ap.id_seguimiento = s.id AND ap.track='COMISION' AND ap.etapa='COMISION A PAGAR')`,
          [req.params.id]).catch(() => {});
      }
    }
    // Al marcar FONDOS RECIBIDOS: la comisión de la misma operación pasa a COMISION A PAGAR
    if (marcar && track === 'SALDO' && etapa === 'FONDOS RECIBIDOS')
      await marcarComisionAPagar(req.params.id);
    // Alerta event-driven: al marcar FONDOS RECIBIDOS avisar para emitir Orden de Pago
    if (marcar && track === 'SALDO' && etapa === 'FONDOS RECIBIDOS') {
      const c = await ctxSeguimiento(req.params.id);
      await notificarEventoSaldo('fondos_recibidos', { op: c.num_op, id_seguimiento: Number(req.params.id) });
    }
    // Alerta event-driven: al marcar FACTURA RECIBIDA avisar para emitir Orden de Pago de comisión
    if (marcar && track === 'COMISION' && etapa === 'FACTURA RECIBIDA') {
      const c = await ctxSeguimiento(req.params.id);
      await notificarEventoSaldo('com_factura_recibida', { op: c.num_op, id_seguimiento: Number(req.params.id) });
    }
    // Saldo precio = CUENTA DE PASO: entra de la financiera y sale íntegro al dealer
    if (marcar && track === 'SALDO' && ['FONDOS RECIBIDOS', 'SALDO PRECIO PAGADO'].includes(etapa))
      await contabilizarSaldoPrecio(Number(req.params.id), etapa);
    auditar({ req, accion: 'EDITAR', modulo: 'postventa', entidad: 'etapa', entidad_id: req.params.id,
      detalle: `${marcar ? 'Marcó' : 'Desmarcó'} "${etapa}" (${track}) — op ${await opsTxt([req.params.id])}` });
    res.json({ success: true, data: { id: Number(req.params.id), etapa, marcado: !!marcar, usuario }, error: null });
  } catch (e) {
    console.error('[postventa etapa]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/:id/fundantes-devueltos { motivo } ──────────────────
   La financiera RECHAZÓ y devolvió los fundantes: se desmarcan FUNDANTES
   RECIBIDOS y ENVIADOS y queda registrada la fecha de devolución. Solo procede
   si el flujo no avanzó más allá (con fondos recibidos o pagado ya no aplica). */
const fundantesDevueltos = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const motivo = String(req.body?.motivo || '').trim().slice(0, 300) || null;
    const usuario = loginDe(req.usuario);
    const [[seg]] = await pool.query('SELECT id, num_op FROM postventa_seguimiento WHERE id=?', [id]);
    if (!seg) return res.status(404).json({ success: false, data: null, error: 'Seguimiento no encontrado' });
    const [[{ avanzadas }]] = await pool.query(
      `SELECT COUNT(*) avanzadas FROM postventa_etapas
        WHERE id_seguimiento=? AND track='SALDO'
          AND etapa IN ('LIBERADO A PAGO','FONDOS RECIBIDOS','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO')`, [id]);
    if (avanzadas > 0)
      return res.status(400).json({ success: false, data: null,
        error: 'El flujo ya avanzó más allá de los fundantes (liberado/fondos/orden/pago): desmarca primero esas etapas.' });
    const [r] = await pool.query(
      `DELETE FROM postventa_etapas WHERE id_seguimiento=? AND track='SALDO'
        AND etapa IN ('FUNDANTES RECIBIDOS','FUNDANTES ENVIADOS')`, [id]);
    if (!r.affectedRows)
      return res.status(400).json({ success: false, data: null, error: 'No hay fundantes recibidos/enviados que devolver.' });
    await pool.query(
      'UPDATE postventa_seguimiento SET fundantes_devueltos_en=NOW(), fundantes_devueltos_por=?, fundantes_devueltos_motivo=? WHERE id=?',
      [usuario, motivo, id]);
    // Auditoría (misma tabla que las reversas de etapas)
    await pool.query('INSERT INTO postventa_reversas (id_seguimiento, etapa, usuario, motivo) VALUES (?,?,?,?)',
      [id, 'FUNDANTES DEVUELTOS', usuario, motivo || 'Fundantes rechazados y devueltos']).catch(() => {});
    auditar({ req, accion: 'ANULAR', modulo: 'postventa', entidad: 'fundantes', entidad_id: id,
      detalle: `Fundantes DEVUELTOS — op ${seg.num_op}${motivo ? '. Motivo: ' + motivo : ''}` });
    res.json({ success: true, data: { id, desmarcadas: r.affectedRows }, error: null });
  } catch (e) {
    console.error('[postventa fundantesDevueltos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/perfiles-lista ─── */
const getPerfiles = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
    res.json({ success: true, data: rows.map(r => r.nombre), error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── Atribuciones del flujo Saldos Precio: qué perfiles pueden cada acción ──
   Alimenta las notas "Solo pueden modificar: …" en el front. Administrador
   siempre puede (no se lista por separado: ya aparece habilitado en la matriz). */
const CODIGOS_ATRIB = ['pv_fondos_definir','pv_saldos_seleccionar','postventa_saldos_pagar','pv_nomina_generar','pv_orden_emitir','pv_saldos_revertir'];
const getAtribuciones = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.codigo, p.nombre AS perfil
       FROM funcionalidades f
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad AND pp.habilitado = 1
       JOIN perfiles p ON p.id_perfil = pp.id_perfil
       WHERE f.codigo IN (?)
       ORDER BY p.nombre`, [CODIGOS_ATRIB]);
    const out = {};
    CODIGOS_ATRIB.forEach(c => out[c] = []);
    rows.forEach(r => { (out[r.codigo] = out[r.codigo] || []).push(r.perfil); });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Atribuciones del flujo Comisión: espejo de Saldo Precio, permisos propios ── */
const CODIGOS_ATRIB_COM = ['pv_com_fondos_definir','pv_com_seleccionar','pv_com_pagar','pv_com_nomina_generar','pv_com_orden_emitir','pv_com_revertir'];
const getAtribucionesComision = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.codigo, p.nombre AS perfil
       FROM funcionalidades f
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad AND pp.habilitado = 1
       JOIN perfiles p ON p.id_perfil = pp.id_perfil
       WHERE f.codigo IN (?)
       ORDER BY p.nombre`, [CODIGOS_ATRIB_COM]);
    const out = {};
    CODIGOS_ATRIB_COM.forEach(c => out[c] = []);
    rows.forEach(r => { (out[r.codigo] = out[r.codigo] || []).push(r.perfil); });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Fondos disponibles del día (compartido): Finanzas/Tesorería digita,
   Comercial decide qué pagar. Se guarda en postventa_config; el front valida
   que fecha_dia sea hoy (se "borra" al cambiar de día sin tocar BD). ── */
// ── Config de alertas del proceso Saldo Precio (mantenedor) ──
const getAlertasConfig = async (req, res) => {
  try {
    const lista = req.query.track === 'parque' ? EVENTOS_PARQUE
                : req.query.track === 'comision' ? EVENTOS_COMISION : EVENTOS_SALDO;
    const [rows] = await pool.query('SELECT * FROM postventa_alertas_config');
    const map = {}; rows.forEach(r => { map[r.evento] = r; });
    // Devuelve en el orden del workflow, con título/descripción del evento
    const data = lista.map(e => {
      const c = map[e.evento] || {};
      return { evento: e.evento, titulo: e.titulo,
        perfiles: c.perfiles || '', incluir_ejecutivo: !!c.incluir_ejecutivo,
        usuarios_extra: c.usuarios_extra || '', activo: c.activo === undefined ? 1 : c.activo,
        prioridad: c.prioridad || 'normal', sonido: c.sonido === undefined ? 1 : c.sonido,
        sonido_tipo: c.sonido_tipo || 'campana', sonido_cada_seg: c.sonido_cada_seg || 30,
        sonido_max_min: c.sonido_max_min || 5 };
    });
    res.json({ success: true, data, sonidos: SONIDOS_SALDO, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setAlertasConfig = async (req, res) => {
  try {
    const lista = Array.isArray(req.body?.config) ? req.body.config : [];
    const EVENTOS_TODOS = [...EVENTOS_SALDO, ...EVENTOS_COMISION, ...EVENTOS_PARQUE];
    for (const c of lista) {
      if (!EVENTOS_TODOS.find(e => e.evento === c.evento)) continue;
      const sonTipo = SONIDOS_SALDO.includes(c.sonido_tipo) ? c.sonido_tipo : 'campana';
      await pool.query(
        `INSERT INTO postventa_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo, prioridad, sonido, sonido_tipo, sonido_cada_seg, sonido_max_min)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE perfiles=VALUES(perfiles), incluir_ejecutivo=VALUES(incluir_ejecutivo),
           usuarios_extra=VALUES(usuarios_extra), activo=VALUES(activo), prioridad=VALUES(prioridad),
           sonido=VALUES(sonido), sonido_tipo=VALUES(sonido_tipo), sonido_cada_seg=VALUES(sonido_cada_seg), sonido_max_min=VALUES(sonido_max_min)`,
        [c.evento, String(c.perfiles || ''), c.incluir_ejecutivo ? 1 : 0,
         String(c.usuarios_extra || ''), c.activo ? 1 : 0,
         c.prioridad === 'alta' ? 'alta' : 'normal', c.sonido ? 1 : 0, sonTipo,
         Math.max(5, parseInt(c.sonido_cada_seg) || 30), Math.max(1, parseInt(c.sonido_max_min) || 5)]);
    }
    res.json({ success: true, data: { actualizados: lista.length }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const getFondos = async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='fondos_disp'");
    let d = null; if (row) { try { d = JSON.parse(row.valor); } catch (_) {} }
    res.json({ success: true, data: d, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setFondos = async (req, res) => {
  try {
    const { monto, fecha_iso, fecha_dia } = req.body || {};
    const usuario = ((req.usuario?.nombre || '') + ' ' + (req.usuario?.apellido || '')).trim() || 'Usuario';
    const valor = { monto: Number(monto) || 0, fecha_iso: fecha_iso || new Date().toISOString(), fecha_dia, usuario };
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES ('fondos_disp', ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [JSON.stringify(valor)]);
    // Alerta: montos cargados → Gerente Comercial decide qué pagar (una vez al día)
    if (valor.monto > 0)
      await notificarEventoSaldo('fondos_cargados', { claveExtra: valor.fecha_dia || new Date().toISOString().slice(0, 10) });
    res.json({ success: true, data: valor, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Fondos disponibles para pago de COMISIONES (compartido, válido solo hoy) ── */
const getFondosComision = async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='fondos_disp_comision'");
    let d = null; if (row) { try { d = JSON.parse(row.valor); } catch (_) {} }
    res.json({ success: true, data: d, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setFondosComision = async (req, res) => {
  try {
    const { monto, fecha_iso, fecha_dia } = req.body || {};
    const usuario = ((req.usuario?.nombre || '') + ' ' + (req.usuario?.apellido || '')).trim() || 'Usuario';
    const valor = { monto: Number(monto) || 0, fecha_iso: fecha_iso || new Date().toISOString(), fecha_dia, usuario };
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES ('fondos_disp_comision', ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [JSON.stringify(valor)]);
    if (valor.monto > 0)
      await notificarEventoSaldo('com_fondos_cargados', { claveExtra: valor.fecha_dia || new Date().toISOString().slice(0, 10) });
    res.json({ success: true, data: valor, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Config (mantenedor etapa → estado) ──────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM postventa_config');
    const out = {};
    rows.forEach(r => { try { out[r.clave] = JSON.parse(r.valor); } catch (_) {} });
    // Cuentas remitente habilitadas (motor único shared/mailer) para los selects del mantenedor
    try { out._cuentas_remitente = require('../../../../shared/mailer').cuentasRemitente().map(c => ({ clave: c.clave, label: c.label })); } catch (_) {}
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setConfig = async (req, res) => {
  try {
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'valor requerido' });
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES (?,?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [req.params.clave, JSON.stringify(valor)]);
    res.json({ success: true, data: { clave: req.params.clave }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/saldos-a-pagar — ops liberadas a pago, no pagadas ── */
const normRutSaldo = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const getSaldosAPagar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.saldo_precio, s.financiera,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS nombre_dealer,
             c.id_financiera,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             COALESCE(NULLIF(d.categoria_asignada,''), NULLIF(d.categoria_propuesta,''), '') AS categoria,
             oc.id AS orden_id, oc.numero AS num_orden,
             d.num_cuenta, d.banco,
             efr.fecha AS fecha_fondos,
             efu.fecha AS fecha_fundantes,
             DATEDIFF(CURDATE(), efr.fecha) AS dias,
             (esp.id IS NOT NULL) AS pagado_hoy,
             (eev.id IS NOT NULL) AS enviado,
             eev.usuario AS enviado_por
      FROM postventa_seguimiento s
      JOIN postventa_etapas eop
        ON eop.id_seguimiento = s.id AND eop.track='SALDO' AND eop.etapa='ORDEN DE PAGO EMITIDA'
      LEFT JOIN postventa_etapas eev
        ON eev.id_seguimiento = s.id AND eev.track='SALDO' AND eev.etapa='ENVIADO A PAGO'
      LEFT JOIN postventa_etapas efr
        ON efr.id_seguimiento = s.id AND efr.track='SALDO' AND efr.etapa='FONDOS RECIBIDOS'
      LEFT JOIN postventa_etapas efu
        ON efu.id_seguimiento = s.id AND efu.track='SALDO' AND efu.etapa='FUNDANTES RECIBIDOS'
      LEFT JOIN postventa_etapas esp
        ON esp.id_seguimiento = s.id AND esp.track='SALDO' AND esp.etapa='SALDO PRECIO PAGADO'
           AND DATE(esp.fecha) = CURDATE()
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
      LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
      LEFT JOIN op_correlativos  oc ON oc.origen='SALDO' AND oc.origen_id = po.id AND oc.anulada = 0
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='SALDO' AND ep.etapa='SALDO PRECIO PAGADO'
              AND DATE(ep.fecha) < CURDATE())
      ORDER BY efr.fecha ASC, s.num_op ASC
    `);
    // Respaldo por RUT: créditos sin id_dealer enlazado quedaban sin cuenta/banco/
    // categoría aunque la ficha del dealer exista (mismo RUT en otra operación sí
    // los traía). Una sola fuente: la ficha; aquí solo se busca por otra llave.
    const sinDatos = rows.filter(r => r.rut_dealer && (!r.num_cuenta || !r.banco || !r.categoria));
    if (sinDatos.length) {
      const ruts = [...new Set(sinDatos.map(r => normRutSaldo(r.rut_dealer)))];
      const [ds] = await pool.query(
        `SELECT rut, num_cuenta, banco,
                COALESCE(NULLIF(categoria_asignada,''), NULLIF(categoria_propuesta,''), '') AS categoria,
                COALESCE(NULLIF(nombre_indexa,''), nombre_razon) AS nombre
           FROM dealers WHERE activo=1 OR activo IS NULL`);
      const mapa = new Map();
      ds.forEach(d => { const k = normRutSaldo(d.rut); if (k && !mapa.has(k)) mapa.set(k, d); });
      sinDatos.forEach(r => {
        const d = mapa.get(normRutSaldo(r.rut_dealer)); if (!d) return;
        if (!r.num_cuenta) r.num_cuenta = d.num_cuenta;
        if (!r.banco) r.banco = d.banco;
        if (!r.categoria) r.categoria = d.categoria;
        if (!r.nombre_dealer) r.nombre_dealer = d.nombre;
      });
    }
    // AUTOFIN: el monto a pagar/disponer = saldo + Transferencia + Limitación (la orden ya lo registra así).
    const fijos = await getFijosAutoFin();
    /* Fecha comprometida de pago según el SLA de la categoría del dealer
       (motor único shared/sla-saldo: horas hábiles + hora de corte del
       mantenedor Categoría y Potencial Dealer, desde FUNDANTES RECIBIDOS). */
    const SLAM = require('../../../../shared/sla-saldo');
    const slaCfg = await SLAM.config();
    const isoD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const hoyCL = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    rows.forEach(r => {
      r.monto_pagar = montoSaldoOrden(r.financiera, r.saldo_precio, fijos);
      const v = SLAM.vencimiento(r.fecha_fundantes, r.categoria, slaCfg);
      r.fecha_pago_sla = v ? isoD(v.fecha) : null;
      // Días respecto del SLA: negativo = falta, 0 = vence hoy, positivo = vencido
      r.dias_sla = v ? Math.round((new Date(isoD(hoyCL)) - new Date(isoD(v.fecha))) / 86400000) : null;
    });
    res.json({ success: true, data: rows, fijos, error: null });
  } catch (e) {
    console.error('[postventa saldosAPagar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Montos fijos de AutoFin (Transferencia/inscripción + Limitación de dominio) ──
 *  Para Saldo Precio de AUTOFIN la Orden de Pago = saldo_precio + estos dos fijos.
 *  Viven en el mantenedor parametros_credito (claves autofin_inscripcion/limitacion). */
async function getFijosAutoFin() {
  try {
    const [rows] = await pool.query(
      "SELECT clave, valor FROM parametros_credito WHERE clave IN ('autofin_inscripcion','autofin_limitacion')");
    const f = { autofin_inscripcion: 0, autofin_limitacion: 0 };
    rows.forEach(r => { f[r.clave] = parseFloat(r.valor) || 0; });
    return f;
  } catch (_) { return { autofin_inscripcion: 0, autofin_limitacion: 0 }; }
}
const esAutoFin = fin => String(fin || '').toUpperCase() === 'AUTOFIN';
// Monto total a pagar de la Orden de Saldo Precio (AUTOFIN suma los dos fijos al saldo base).
function montoSaldoOrden(financiera, saldoBase, fijos) {
  const base = Number(saldoBase) || 0;
  return esAutoFin(financiera) ? base + (fijos.autofin_inscripcion || 0) + (fijos.autofin_limitacion || 0) : base;
}

/* ── GET /api/postventa/orden-pago — casos en FONDOS RECIBIDOS sin ORDEN DE PAGO EMITIDA ── */
const getOrdenPago = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.saldo_precio, s.financiera, s.fecha_otorgado,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut, dn.rut) AS rut_dealer,
             COALESCE(d.num_cuenta, dn.num_cuenta) AS num_cuenta,
             COALESCE(d.banco, dn.banco) AS banco,
             COALESCE(d.rut_pago, dn.rut_pago) AS rut_pago,
             COALESCE(d.tipo_cuenta, d.cuenta_tipo, dn.tipo_cuenta, dn.cuenta_tipo) AS tipo_cuenta,
             COALESCE(d.nombre_cuenta, dn.nombre_cuenta) AS nombre_cuenta,
             efr.fecha AS fecha_fondos,
             DATEDIFF(CURDATE(), efr.fecha) AS dias
      FROM postventa_seguimiento s
      JOIN postventa_etapas efr
        ON efr.id_seguimiento = s.id AND efr.track='SALDO' AND efr.etapa='FONDOS RECIBIDOS'
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
      -- Fallback: créditos sin id_dealer → dealer por razón social del seguimiento
      LEFT JOIN dealers  dn ON d.id_dealer IS NULL AND (dn.nombre_razon = s.nombre_dealer OR dn.nombre_indexa = s.nombre_dealer)
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='SALDO' AND ep.etapa='ORDEN DE PAGO EMITIDA')
      ORDER BY efr.fecha ASC, s.num_op ASC
    `);
    // Montos fijos AutoFin (inscripción + limitación) desde el mantenedor de parámetros
    const fijos = await getFijosAutoFin();
    res.json({ success: true, data: { rows, fijos }, error: null });
  } catch (e) {
    console.error('[postventa getOrdenPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Asegura la Orden de Pago de SALDO PRECIO: crea (si falta) la fila en
 *    postventa_ordenes y su correlativo global en op_correlativos. Idempotente.
 *    Así, marcar "ORDEN DE PAGO EMITIDA" SIEMPRE registra la orden en el módulo
 *    Órdenes de Pago. Devuelve num_orden o null si la operación no existe. ── */
async function asegurarOrdenSaldo(id, reqUsuario) {
  const [[ya]] = await pool.query('SELECT id, num_orden FROM postventa_ordenes WHERE id_seguimiento=?', [id]);
  if (ya && ya.num_orden) return ya.num_orden;
  const [[seg]] = await pool.query('SELECT num_op, saldo_precio, financiera FROM postventa_seguimiento WHERE id=?', [id]);
  if (!seg) return null;
  const fijos = await getFijosAutoFin();
  const monto = montoSaldoOrden(seg.financiera, seg.saldo_precio, fijos);   // AUTOFIN: + Transferencia + Limitación
  let poId = ya && ya.id;
  if (!poId) {
    try {
      const [ins] = await pool.query(
        'INSERT INTO postventa_ordenes (id_seguimiento, num_op, monto, usuario) VALUES (?,?,?,?)',
        [id, seg.num_op, monto, loginDe(reqUsuario)]);
      poId = ins.insertId;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      const [[r]] = await pool.query('SELECT id, num_orden FROM postventa_ordenes WHERE id_seguimiento=?', [id]);
      if (r && r.num_orden) return r.num_orden;
      poId = r && r.id;
    }
  }
  const { numero } = await emitirCorrelativo({
    origen: 'SALDO', origen_id: poId, concepto: 'Saldo Precio OP ' + (seg.num_op || ''),
    monto, id_usuario: reqUsuario && reqUsuario.id_usuario, usuario_nombre: loginDe(reqUsuario) });
  await pool.query('UPDATE postventa_ordenes SET num_orden=? WHERE id=?', [numero, poId]);
  return numero;
}

/* ── GET /api/postventa/orden-pago/:id/correlativo — crea o devuelve el N° de orden ── */
const correlativoOrden = async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const num = await asegurarOrdenSaldo(id, req.usuario);
    if (!num) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    res.json({ success: true, data: { num_orden: num }, error: null });
  } catch (e) {
    console.error('[postventa correlativoOrden]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/orden-pago/emitir { ids:[] } — marca ORDEN DE PAGO EMITIDA ── */
const emitirOrdenPago = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    // Marca ORDEN DE PAGO EMITIDA (y FONDOS RECIBIDOS por si faltara, para mantener secuencia)
    const vals = [];
    for (const id of ids) {
      await asegurarOrdenSaldo(id, req.usuario);   // crea orden + correlativo si falta → aparece en módulo Órdenes de Pago
      vals.push([id, 'SALDO', 'FONDOS RECIBIDOS', usuario]);
      vals.push([id, 'SALDO', 'ORDEN DE PAGO EMITIDA', usuario]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    await marcarComisionAPagar(ids);   // FONDOS RECIBIDOS forzado arriba → la comisión pasa a A PAGAR
    // Alerta: orden emitida → Tesorería carga montos disponibles
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('orden_emitida', { op: c.num_op, id_seguimiento: id });
    }
    auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'orden_pago_saldo', entidad_id: ids[0],
      detalle: `Emitió Orden de Pago de saldo precio — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { emitidas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa emitirOrdenPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/saldos-a-pagar/enviar-a-pago { ids:[] } — marca ENVIADO A PAGO ──
   El Gerente Comercial (u otro con pv_saldos_seleccionar) fija la selección a pagar.
   A partir de aquí queda en cola firme para que Tesorería confirme el pago. ── */
const enviarAPago = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids) {
      vals.push([id, 'SALDO', 'FONDOS RECIBIDOS', usuario]);
      vals.push([id, 'SALDO', 'ORDEN DE PAGO EMITIDA', usuario]);
      vals.push([id, 'SALDO', 'ENVIADO A PAGO', usuario]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    await marcarComisionAPagar(ids);   // FONDOS RECIBIDOS forzado arriba → la comisión pasa a A PAGAR
    // Alerta: enviado a pago → Tesorería confirma el pago
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('enviado_pago', { op: c.num_op, id_seguimiento: id });
    }
    auditar({ req, accion: 'ENVIAR', modulo: 'postventa', entidad: 'saldo_a_pago', entidad_id: ids[0],
      detalle: `Envió a pago saldo precio — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { enviadas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa enviarAPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Segregación de funciones (shared/segregacion-pagos.js) ───────────────────
   Devuelve los num_op del lote que ESTA MISMA persona mandó a pago. Quien manda
   a pago no confirma el pago: es el control de cuatro ojos sobre el egreso.
   Si el parámetro está desactivado en el mantenedor Cajas, devuelve vacío. */
async function opsMandadasAPagoPor(ids, usuario, track = 'SALDO') {
  try {
    const seg = require('../../../../shared/segregacion-pagos');
    if (!(await seg.exigeDoblePersona())) return [];
    const [rows] = await pool.query(
      `SELECT s.num_op, pe.usuario
         FROM postventa_etapas pe JOIN postventa_seguimiento s ON s.id = pe.id_seguimiento
        WHERE pe.id_seguimiento IN (?) AND pe.track = ? AND pe.etapa = 'ENVIADO A PAGO'`,
      [ids, track]);
    const choque = [];
    for (const r of rows) {   // la comparación la hace el motor, nunca una copia local
      const v = await seg.validarPagador({ nombreEmisor: r.usuario, nombrePagador: usuario });
      if (!v.ok) choque.push(r.num_op);
    }
    return choque;
  } catch (e) { console.error('[postventa segregacion]', e.message); return []; }
}

/* ── POST /api/postventa/saldos-a-pagar/pagar { ids:[] } — marca SALDO PRECIO PAGADO ── */
const pagarSaldos = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    // Segregación de funciones: quien mandó la operación a pago no confirma su pago.
    const choque = await opsMandadasAPagoPor(ids, usuario);
    if (choque.length)
      return res.status(403).json({ success: false, data: null,
        error: `Tú mandaste a pago ${choque.length === 1 ? 'la operación' : 'las operaciones'} ${choque.join(', ')}: el pago debe confirmarlo otra persona (segregación de funciones).` });
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave='etapas_saldo'`);
    const etapas = (cfgRow ? JSON.parse(cfgRow.valor) : []).map(x => x.etapa);
    if (!etapas.length)
      return res.status(500).json({ success: false, data: null, error: 'Config de etapas no disponible' });
    const vals = [];
    for (const id of ids)
      for (const e of etapas) vals.push([id, 'SALDO', e, usuario]);
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    await marcarComisionAPagar(ids);   // el saldo quedó pagado → la comisión queda A PAGAR
    /* Contrapartida contable del egreso (Máxima 4). Este camino —el que se usa
       de verdad para pagar— marcaba la etapa con un INSERT directo y se saltaba
       la contabilización, que solo se disparaba al marcar la etapa a mano en
       Seguimiento. Resultado: la cuenta de paso 2102045 solo crecía. El motor es
       idempotente por ref (SP-<op>-OUT), así que no duplica. */
    for (const id of ids) await contabilizarSaldoPrecio(id, 'SALDO PRECIO PAGADO');
    // Registrar el PAGO en el libro central op_correlativos → timbre PAGADO en el documento
    const idCaja = await cajaActivaDe(req.usuario?.id_usuario);
    for (const id of ids) {
      await asegurarOrdenSaldo(id, req.usuario);   // garantiza orden + correlativo
      const [[po]] = await pool.query('SELECT id FROM postventa_ordenes WHERE id_seguimiento=?', [id]);
      if (po) await pagarCorrelativo({ origen: 'SALDO', origen_id: po.id, id_usuario: req.usuario?.id_usuario, usuario_nombre: usuario, id_caja: idCaja, metodo: 'Transferencia' });
    }
    // Alerta: pago realizado → Gerente/Jefe Comercial, ejecutivo de la operación y extra
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('pago_realizado', { op: c.num_op, id_seguimiento: id, ejecutivo: c.ejecutivo });
      // Aviso al dealer (plantilla correo_pago_saldo, nace inactiva) — misma señal
      // que cuando el pago entra por la ODP de Tesorería (pagarOrden origen SALDO).
      notificarPagoSaldoDealer(id).catch(e => console.error('[postventa aviso pago saldo]', e.message));
    }
    auditar({ req, accion: 'PAGAR', modulo: 'postventa', entidad: 'saldo_precio', entidad_id: ids[0],
      detalle: `Confirmó el PAGO de saldo precio — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { pagados: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa pagarSaldos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/saldos-a-pagar/desmarcar { ids:[], motivo } — revierte SALDO PRECIO PAGADO ──
   Mismo día: cualquiera con permiso. Fuera del día: solo Administrador, con motivo (auditoría). */
const desmarcarSaldos = async (req, res) => {
  try {
    const { ids, motivo } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    // Etapa a revertir: pago (default) o el envío a pago (deshacer "Enviar a Pago")
    const etapa = req.body.etapa === 'ENVIADO A PAGO' ? 'ENVIADO A PAGO' : 'SALDO PRECIO PAGADO';
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);
    const ph = ids.map(() => '?').join(',');

    // No se puede deshacer el envío de algo que ya fue pagado
    if (etapa === 'ENVIADO A PAGO') {
      const [[{ pagadas }]] = await pool.query(
        `SELECT COUNT(*) AS pagadas FROM postventa_etapas
         WHERE track='SALDO' AND etapa='SALDO PRECIO PAGADO' AND id_seguimiento IN (${ph})`, ids);
      if (pagadas > 0)
        return res.status(400).json({ success: false, data: null, error: 'No se puede deshacer el envío: la operación ya fue pagada.' });
    }

    // ¿Alguna marca NO es de hoy? → es reversa fuera del día
    const [[{ fuera }]] = await pool.query(
      `SELECT COUNT(*) AS fuera FROM postventa_etapas
       WHERE track='SALDO' AND etapa=? AND DATE(fecha) < CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);

    if (fuera > 0) {
      if (!esAdmin)
        return res.status(403).json({ success: false, data: null, error: 'Solo un Administrador puede revertir una marca de un día anterior.' });
      if (!motivo || !String(motivo).trim())
        return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo para revertir una marca de un día anterior.' });
      // Auditoría de la reversa
      const logs = ids.map(id => [id, etapa, usuario, String(motivo).trim().slice(0, 400)]);
      await pool.query('INSERT INTO postventa_reversas (id_seguimiento, etapa, usuario, motivo) VALUES ?', [logs]);
      const [r] = await pool.query(
        `DELETE FROM postventa_etapas
         WHERE track='SALDO' AND etapa=? AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
      const rev = etapa === 'SALDO PRECIO PAGADO' ? await reversarPagoCentral('SALDO', ids, usuario, motivo) : null;
      auditar({ req, accion: 'ANULAR', modulo: 'postventa', entidad: 'saldo_precio', entidad_id: ids[0],
        detalle: `REVERSÓ "${etapa}" (día anterior) — op ${await opsTxt(ids)}. Motivo: ${String(motivo).trim().slice(0, 200)}` });
      return res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: true, central: rev }, error: null });
    }

    // Mismo día: cualquiera con permiso
    const [r] = await pool.query(
      `DELETE FROM postventa_etapas
       WHERE track='SALDO' AND etapa=?
         AND DATE(fecha) = CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
    const rev = (etapa === 'SALDO PRECIO PAGADO' && r.affectedRows) ? await reversarPagoCentral('SALDO', ids, usuario, motivo) : null;
    if (r.affectedRows) auditar({ req, accion: 'ANULAR', modulo: 'postventa', entidad: 'saldo_precio', entidad_id: ids[0],
      detalle: `Desmarcó "${etapa}" (mismo día) — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: false, central: rev }, error: null });
  } catch (e) {
    console.error('[postventa desmarcarSaldos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   FLUJO COMISIÓN (espejo de Saldo Precio) — track='COMISION'
   Cartolas → FACTURA RECIBIDA → ORDEN DE PAGO EMITIDA → ENVIADO A PAGO → COMISION PAGADA
   ═══════════════════════════════════════════════════════════════════════ */

/* ── GET /api/postventa/:id/factura-comision — datos de la factura recibida ── */
const getFacturaComision = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM postventa_facturas_comision WHERE id_seguimiento = ?', [req.params.id]);
    res.json({ success: true, data: f || null, error: null });
  } catch (e) {
    console.error('[postventa getFacturaComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/postventa/:id/factura-comision — actualizar datos de la factura (sin tocar la etapa) ── */
const updateFacturaComision = async (req, res) => {
  try {
    const f = req.body || {};
    const usuario = loginDe(req.usuario);
    const [[ex]] = await pool.query(
      `SELECT 1 ok FROM postventa_etapas WHERE id_seguimiento=? AND track='COMISION' AND etapa='FACTURA RECIBIDA' LIMIT 1`,
      [req.params.id]);
    if (!ex) return res.status(400).json({ success: false, data: null, error: 'La etapa FACTURA RECIBIDA no está marcada' });
    await guardarFacturaComision(req.params.id, f, usuario);
    res.json({ success: true, data: { id: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[postventa updateFacturaComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/comisiones-a-pagar — ops con orden de pago de comisión emitida, no pagadas ── */
const getComisionesAPagar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.comision, s.financiera, s.ejecutivo,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS nombre_dealer,
             c.id_financiera,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             d.num_cuenta, d.banco,
             COALESCE(fc.fecha_factura, efa.fecha) AS fecha_factura,
             fc.numero_factura AS numero_factura, fc.monto_bruto AS monto_factura,
             fc.es_terceros AS es_terceros, fc.es_boleta AS es_boleta,
             fc.impuesto_pct AS impuesto_pct, fc.impuesto_monto AS impuesto_monto, fc.monto_liquido AS monto_liquido,
             DATEDIFF(CURDATE(), efa.fecha) AS dias,
             (epg.id IS NOT NULL) AS pagado_hoy,
             (eev.id IS NOT NULL) AS enviado,
             eev.usuario AS enviado_por
      FROM postventa_seguimiento s
      JOIN postventa_etapas eop
        ON eop.id_seguimiento = s.id AND eop.track='COMISION' AND eop.etapa='ORDEN DE PAGO EMITIDA'
      LEFT JOIN postventa_etapas eev
        ON eev.id_seguimiento = s.id AND eev.track='COMISION' AND eev.etapa='ENVIADO A PAGO'
      LEFT JOIN postventa_etapas efa
        ON efa.id_seguimiento = s.id AND efa.track='COMISION' AND efa.etapa='FACTURA RECIBIDA'
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      LEFT JOIN postventa_etapas epg
        ON epg.id_seguimiento = s.id AND epg.track='COMISION' AND epg.etapa='COMISION PAGADA'
           AND DATE(epg.fecha) = CURDATE()
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
      WHERE COALESCE(fc.es_replica, 0) = 0   -- la factura replicada se paga por su titular (una ODP por cartola)
        AND NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='COMISION' AND ep.etapa='COMISION PAGADA'
              AND DATE(ep.fecha) < CURDATE())
      ORDER BY efa.fecha ASC, s.num_op ASC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[postventa comisionesAPagar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/orden-pago-comision — ops en FACTURA RECIBIDA sin ORDEN DE PAGO EMITIDA ── */
const getOrdenPagoComision = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.comision, s.financiera, s.fecha_otorgado,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut, dn.rut) AS rut_dealer,
             COALESCE(d.num_cuenta, dn.num_cuenta) AS num_cuenta,
             COALESCE(d.banco, dn.banco) AS banco,
             COALESCE(d.rut_pago, dn.rut_pago) AS rut_pago,
             COALESCE(d.tipo_cuenta, d.cuenta_tipo, dn.tipo_cuenta, dn.cuenta_tipo) AS tipo_cuenta,
             COALESCE(d.nombre_cuenta, dn.nombre_cuenta) AS nombre_cuenta,
             COALESCE(fc.fecha_factura, efa.fecha) AS fecha_factura,
             COALESCE(fc.created_at, efa.fecha) AS fac_recepcion,
             fc.numero_factura AS numero_factura, fc.monto_bruto AS monto_factura,
             fc.es_terceros AS es_terceros, fc.es_boleta AS es_boleta,
             fc.impuesto_pct AS impuesto_pct, fc.impuesto_monto AS impuesto_monto, fc.monto_liquido AS monto_liquido,
             DATEDIFF(CURDATE(), efa.fecha) AS dias
      FROM postventa_seguimiento s
      JOIN postventa_etapas efa
        ON efa.id_seguimiento = s.id AND efa.track='COMISION' AND efa.etapa='FACTURA RECIBIDA'
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
      -- Fallback: créditos sin id_dealer → dealer por razón social del seguimiento
      LEFT JOIN dealers  dn ON d.id_dealer IS NULL AND (dn.nombre_razon = s.nombre_dealer OR dn.nombre_indexa = s.nombre_dealer)
      WHERE COALESCE(fc.es_replica, 0) = 0   -- la factura replicada se paga por su titular (una ODP por cartola)
        AND NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='COMISION' AND ep.etapa='ORDEN DE PAGO EMITIDA')
      ORDER BY efa.fecha ASC, s.num_op ASC
    `);
    res.json({ success: true, data: { rows }, error: null });
  } catch (e) {
    console.error('[postventa getOrdenPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Asegura la Orden de Pago de COMISIÓN (postventa_ordenes_comision + correlativo).
 *    Idempotente. Devuelve num_orden o null. ── */
async function asegurarOrdenComision(id, reqUsuario) {
  const [[ya]] = await pool.query('SELECT id, num_orden FROM postventa_ordenes_comision WHERE id_seguimiento=?', [id]);
  if (ya && ya.num_orden) return ya.num_orden;
  /* Monto de la ODP = LÍQUIDO A DEPOSITAR del documento recibido, no la comisión bruta.
     Factura → líquido = bruto (IVA incluido; el IVA es crédito fiscal de AutoFácil).
     Boleta  → líquido = honorario − retención (el dealer la recupera al año siguiente).
     Sin documento registrado, el líquido es la comisión (que ya es bruta). */
  const [[seg]] = await pool.query(
    `SELECT s.num_op, COALESCE(fc.monto_liquido, s.comision) AS comision
       FROM postventa_seguimiento s
       LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      WHERE s.id=?`, [id]);
  if (!seg) return null;
  let poId = ya && ya.id;
  if (!poId) {
    try {
      const [ins] = await pool.query(
        'INSERT INTO postventa_ordenes_comision (id_seguimiento, num_op, monto, usuario) VALUES (?,?,?,?)',
        [id, seg.num_op, seg.comision, loginDe(reqUsuario)]);
      poId = ins.insertId;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      const [[r]] = await pool.query('SELECT id, num_orden FROM postventa_ordenes_comision WHERE id_seguimiento=?', [id]);
      if (r && r.num_orden) return r.num_orden;
      poId = r && r.id;
    }
  }
  const { numero } = await emitirCorrelativo({
    origen: 'COMISION', origen_id: poId, concepto: 'Comisión OP ' + (seg.num_op || ''),
    monto: seg.comision, id_usuario: reqUsuario && reqUsuario.id_usuario, usuario_nombre: loginDe(reqUsuario) });
  await pool.query('UPDATE postventa_ordenes_comision SET num_orden=? WHERE id=?', [numero, poId]);
  return numero;
}

/* ── GET /api/postventa/orden-pago-comision/:id/correlativo ── */
const correlativoOrdenComision = async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const num = await asegurarOrdenComision(id, req.usuario);
    if (!num) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    res.json({ success: true, data: { num_orden: num }, error: null });
  } catch (e) {
    console.error('[postventa correlativoOrdenComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/orden-pago-comision/emitir { ids:[] } — marca ORDEN DE PAGO EMITIDA (COMISION) ── */
const emitirOrdenPagoComision = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids) {
      await asegurarOrdenComision(id, req.usuario);   // crea orden + correlativo si falta → aparece en módulo Órdenes de Pago
      // La ODP de la titular cubre TODA la cartola: la etapa avanza también en las réplicas
      for (const gid of await idsGrupoFactura(id)) {
        vals.push([gid, 'COMISION', 'FACTURA RECIBIDA', usuario]);
        vals.push([gid, 'COMISION', 'ORDEN DE PAGO EMITIDA', usuario]);
      }
    }
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_orden_emitida', { op: c.num_op, id_seguimiento: id });
    }
    auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'orden_pago_comision', entidad_id: ids[0],
      detalle: `Emitió Orden de Pago de comisión — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { emitidas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa emitirOrdenPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/enviar-a-pago { ids:[] } — marca ENVIADO A PAGO (COMISION) ── */
const enviarAPagoComision = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids)
      for (const gid of await idsGrupoFactura(id)) {
        vals.push([gid, 'COMISION', 'FACTURA RECIBIDA', usuario]);
        vals.push([gid, 'COMISION', 'ORDEN DE PAGO EMITIDA', usuario]);
        vals.push([gid, 'COMISION', 'ENVIADO A PAGO', usuario]);
      }
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_enviado_pago', { op: c.num_op, id_seguimiento: id });
    }
    auditar({ req, accion: 'ENVIAR', modulo: 'postventa', entidad: 'comision_a_pago', entidad_id: ids[0],
      detalle: `Envió a pago comisión — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { enviadas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa enviarAPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/pagar { ids:[] } — marca COMISION PAGADA ── */
const pagarComisiones = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    // Segregación de funciones: quien mandó la comisión a pago no confirma su pago.
    const choque = await opsMandadasAPagoPor(ids, usuario, 'COMISION');
    if (choque.length)
      return res.status(403).json({ success: false, data: null,
        error: `Tú mandaste a pago ${choque.length === 1 ? 'la comisión de la operación' : 'las comisiones de las operaciones'} ${choque.join(', ')}: el pago debe confirmarlo otra persona (segregación de funciones).` });
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave='etapas_comision'`);
    const etapas = (cfgRow ? JSON.parse(cfgRow.valor) : []).map(x => x.etapa);
    if (!etapas.length)
      return res.status(500).json({ success: false, data: null, error: 'Config de etapas no disponible' });
    const vals = [];
    for (const id of ids)
      for (const gid of await idsGrupoFactura(id))
        for (const e of etapas) vals.push([gid, 'COMISION', e, usuario]);
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    // Registrar el PAGO en el libro central op_correlativos → timbre PAGADO en el documento
    const idCaja = await cajaActivaDe(req.usuario?.id_usuario);
    for (const id of ids) {
      await asegurarOrdenComision(id, req.usuario);   // garantiza orden + correlativo
      const [[po]] = await pool.query('SELECT id FROM postventa_ordenes_comision WHERE id_seguimiento=?', [id]);
      if (po) await pagarCorrelativo({ origen: 'COMISION', origen_id: po.id, id_usuario: req.usuario?.id_usuario, usuario_nombre: usuario, id_caja: idCaja, metodo: 'Transferencia' });
    }
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_pago_realizado', { op: c.num_op, id_seguimiento: id, ejecutivo: c.ejecutivo });
      await contabilizarComision(id, 'PAGO');   // rebaja el pasivo contra banco (líquido)
      await notificarPagoComisionDealer(id);    // aviso al dealer desde comisiones@
    }
    auditar({ req, accion: 'PAGAR', modulo: 'postventa', entidad: 'comision', entidad_id: ids[0],
      detalle: `Confirmó el PAGO de comisión — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { pagados: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa pagarComisiones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/desmarcar { ids:[], motivo, etapa } — revierte pago/envío (COMISION) ── */
const desmarcarComisiones = async (req, res) => {
  try {
    const { ids, motivo } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const etapa = req.body.etapa === 'ENVIADO A PAGO' ? 'ENVIADO A PAGO' : 'COMISION PAGADA';
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);
    const ph = ids.map(() => '?').join(',');

    if (etapa === 'ENVIADO A PAGO') {
      const [[{ pagadas }]] = await pool.query(
        `SELECT COUNT(*) AS pagadas FROM postventa_etapas
         WHERE track='COMISION' AND etapa='COMISION PAGADA' AND id_seguimiento IN (${ph})`, ids);
      if (pagadas > 0)
        return res.status(400).json({ success: false, data: null, error: 'No se puede deshacer el envío: la comisión ya fue pagada.' });
    }

    const [[{ fuera }]] = await pool.query(
      `SELECT COUNT(*) AS fuera FROM postventa_etapas
       WHERE track='COMISION' AND etapa=? AND DATE(fecha) < CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);

    if (fuera > 0) {
      if (!esAdmin)
        return res.status(403).json({ success: false, data: null, error: 'Solo un Administrador puede revertir una marca de un día anterior.' });
      if (!motivo || !String(motivo).trim())
        return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo para revertir una marca de un día anterior.' });
      const logs = ids.map(id => [id, etapa, usuario, String(motivo).trim().slice(0, 400)]);
      await pool.query('INSERT INTO postventa_reversas (id_seguimiento, etapa, usuario, motivo) VALUES ?', [logs]);
      const [r] = await pool.query(
        `DELETE FROM postventa_etapas WHERE track='COMISION' AND etapa=? AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
      const rev = etapa === 'COMISION PAGADA' ? await reversarPagoCentral('COMISION', ids, usuario, motivo) : null;
      auditar({ req, accion: 'ANULAR', modulo: 'postventa', entidad: 'comision', entidad_id: ids[0],
        detalle: `REVERSÓ "${etapa}" (día anterior) — op ${await opsTxt(ids)}. Motivo: ${String(motivo).trim().slice(0, 200)}` });
      return res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: true, central: rev }, error: null });
    }

    const [r] = await pool.query(
      `DELETE FROM postventa_etapas WHERE track='COMISION' AND etapa=?
         AND DATE(fecha) = CURDATE() AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
    const rev = (etapa === 'COMISION PAGADA' && r.affectedRows) ? await reversarPagoCentral('COMISION', ids, usuario, motivo) : null;
    if (r.affectedRows) auditar({ req, accion: 'ANULAR', modulo: 'postventa', entidad: 'comision', entidad_id: ids[0],
      detalle: `Desmarcó "${etapa}" (mismo día) — op ${await opsTxt(ids)}` });
    res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: false, central: rev }, error: null });
  } catch (e) {
    console.error('[postventa desmarcarComisiones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/marcar-historico — marca pre-2026 como totalmente pagado ── */
const marcarHistorico = async (req, res) => {
  try {
    /* Excluye lo REVERSADO a propósito: este barrido corre en cada carga de
       Seguimiento, y sin esta exclusión volvía a marcar "pagada" una comisión
       que un Administrador acababa de reversar (ops 82933/83753, 18-08-2026:
       el cierre histórico las dio por pagadas y era falso). Una reversa
       registrada en postventa_reversas manda sobre el marcado histórico. */
    const [segs] = await pool.query(
      `SELECT id FROM postventa_seguimiento
        WHERE fecha_otorgado < '2026-01-01'
          AND id NOT IN (SELECT DISTINCT id_seguimiento FROM postventa_reversas)`
    );
    if (!segs.length) return res.json({ success: true, data: { marcados: 0 }, error: null });

    const etapasSaldo   = ['FUNDANTES PENDIENTES','FUNDANTES RECIBIDOS','FUNDANTES ENVIADOS','LIBERADO A PAGO','FONDOS RECIBIDOS','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO'];
    const etapasComision = ['COMISION PENDIENTE','COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA ENVIADA','FACTURA RECIBIDA','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'];
    const fecha = '2025-12-31 23:59:59';
    const vals = [];
    for (const s of segs) {
      for (const e of etapasSaldo)    vals.push([s.id, 'SALDO',    e, 'Sistema', fecha]);
      for (const e of etapasComision) vals.push([s.id, 'COMISION', e, 'Sistema', fecha]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha) VALUES ?`,
      [vals]
    );
    res.json({ success: true, data: { marcados: segs.length }, error: null });
  } catch (e) {
    console.error('[postventa marcarHistorico]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ════════════════════════════════════════════════════════════════
   CONSULTAS DE ESTADO (read-only) — Saldos Precio y Facturas/Comisión.
   Estado actual = etapa más avanzada del track según el orden canónico.
   ════════════════════════════════════════════════════════════════ */
const ORDEN_SALDO    = ['FUNDANTES PENDIENTES','FUNDANTES ENVIADOS','FUNDANTES RECIBIDOS','FONDOS RECIBIDOS','LIBERADO A PAGO','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO'];
const ORDEN_COMISION = ['COMISION PENDIENTE','COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA ENVIADA','FACTURA RECIBIDA','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'];

// id_seguimiento → { estado, fecha_estado, paso, etapas:[{etapa,fecha,usuario}] }
async function etapasPorTrack(ids, track, orden) {
  const map = {};
  if (!ids.length) return map;
  const [rows] = await pool.query(
    'SELECT id_seguimiento, etapa, fecha, usuario FROM postventa_etapas WHERE track=? AND id_seguimiento IN (?) ORDER BY fecha ASC',
    [track, ids]);
  for (const r of rows) {
    const m = map[r.id_seguimiento] || (map[r.id_seguimiento] = { etapas: [], estado: null, fecha_estado: null, paso: 0 });
    m.etapas.push({ etapa: r.etapa, fecha: r.fecha, usuario: r.usuario });
  }
  for (const id of Object.keys(map)) {
    const m = map[id]; let best = -1, bestEt = null, bestF = null;
    for (const e of m.etapas) { const idx = orden.indexOf(e.etapa); if (idx > best) { best = idx; bestEt = e.etapa; bestF = e.fecha; } }
    m.estado = bestEt; m.fecha_estado = bestF; m.paso = best + 1;
  }
  return map;
}

// Visibilidad por ejecutivo: regla central paramétrica (shared/visibilidad-ejecutivos),
// por ámbito del perfil ('todos' | 'asignados', vía usuario_ejecutivos). Soporta varios
// supervisores: el perfil supervisor se marca 'asignados' y se le asigna su equipo.
async function visibilidadEjecutivo(req) { return _visEjec(req.usuario); }

const consultaSaldos = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const parque = String(req.query.parque || '').trim();
    const pagados7 = req.query.pagados7 === '1' || req.query.pagados7 === 'true';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 300));
    const filt = []; const fp = [];
    const vis = await visibilidadEjecutivo(req);
    if (!vis.all) {
      if (!vis.lista.length) return res.json({ success: true, data: [], orden: ORDEN_SALDO, resumen: { pendientes: 0, monto: 0 }, error: null });
      filt.push('s.ejecutivo IN (?)'); fp.push(vis.lista);
    }
    if (q) {
      filt.push(`(s.num_op LIKE ? OR s.rut_dealer LIKE ? OR s.nombre_dealer LIKE ? OR s.ejecutivo LIKE ? OR cr.parque LIKE ? OR cr.nombre_parque_mgmt LIKE ?)`);
      const lk = '%' + q + '%'; fp.push(lk, lk, lk, lk, lk, lk);
    }
    if (parque) { filt.push(`(cr.parque LIKE ? OR cr.nombre_parque_mgmt LIKE ?)`); const lk = '%' + parque + '%'; fp.push(lk, lk); }
    const baseWhere = 'WHERE 1=1' + (filt.length ? ' AND ' + filt.join(' AND ') : '');
    const PAGADO = `EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO'`;
    const tablaWhere = baseWhere + (pagados7 ? ' AND ' + PAGADO + ' AND e.fecha >= (NOW() - INTERVAL 7 DAY))' : '');
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.financiera, s.rut_dealer,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, NULLIF(cr.automotora,''), s.nombre_dealer) AS nombre_dealer,
             s.ejecutivo, s.fecha_otorgado, s.saldo_precio,
             COALESCE(NULLIF(cr.parque,''), cr.nombre_parque_mgmt) AS parque,
             (SELECT op.num_orden FROM postventa_ordenes op WHERE op.id_seguimiento = s.id ORDER BY op.fecha DESC LIMIT 1) AS orden_pago
      FROM postventa_seguimiento s
      LEFT JOIN creditos cr ON cr.id = s.id_credito
      LEFT JOIN dealers  d  ON d.id_dealer = cr.id_dealer
      ${tablaWhere}
      ORDER BY s.fecha_otorgado DESC, s.num_op DESC
      LIMIT ?`, [...fp, limit]);
    const ids = rows.map(r => r.id);
    const etapas = await etapasPorTrack(ids, 'SALDO', ORDEN_SALDO);
    const data = rows.map(r => { const e = etapas[r.id] || {};
      return { ...r, estado: e.estado || 'SIN ETAPAS', fecha_estado: e.fecha_estado || null,
        paso: e.paso || 0, total: ORDEN_SALDO.length, etapas: e.etapas || [] }; });
    // Resumen: operaciones pendientes de pago (sin SALDO PRECIO PAGADO), sobre el filtro q/parque (sin límite).
    const [[resumen]] = await pool.query(`
      SELECT COUNT(*) AS pendientes, COALESCE(SUM(s.saldo_precio),0) AS monto
      FROM postventa_seguimiento s
      LEFT JOIN creditos cr ON cr.id = s.id_credito
      ${baseWhere} AND NOT ${PAGADO})`, fp);
    res.json({ success: true, data, orden: ORDEN_SALDO, resumen, error: null });
  } catch (e) { console.error('[consultaSaldos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const consultaFacturas = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const mes = String(req.query.mes || '').trim();          // YYYY-MM
    const factura = String(req.query.factura || '').trim();
    const pagados7 = req.query.pagados7 === '1' || req.query.pagados7 === 'true';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 300));
    const filt = []; const fp = [];
    const vis = await visibilidadEjecutivo(req);
    if (!vis.all) {
      if (!vis.lista.length) return res.json({ success: true, data: [], orden: ORDEN_COMISION, resumen: { pendientes: 0, monto: 0 }, error: null });
      filt.push('s.ejecutivo IN (?)'); fp.push(vis.lista);
    }
    if (q) {
      filt.push(`(s.num_op LIKE ? OR s.rut_dealer LIKE ? OR s.nombre_dealer LIKE ? OR s.ejecutivo LIKE ? OR f.numero_factura LIKE ?)`);
      const lk = '%' + q + '%'; fp.push(lk, lk, lk, lk, lk);
    }
    if (mes)     { filt.push(`DATE_FORMAT(f.fecha_factura,'%Y-%m') = ?`); fp.push(mes); }
    if (factura) { filt.push(`f.numero_factura LIKE ?`); fp.push('%' + factura + '%'); }
    const baseWhere = 'WHERE 1=1' + (filt.length ? ' AND ' + filt.join(' AND ') : '');
    const PAGADA = `EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='COMISION' AND e.etapa='COMISION PAGADA'`;
    const tablaWhere = baseWhere + (pagados7 ? ' AND ' + PAGADA + ' AND e.fecha >= (NOW() - INTERVAL 7 DAY))' : '');
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.financiera, s.rut_dealer,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, NULLIF(cr.automotora,''), s.nombre_dealer) AS nombre_dealer,
             s.ejecutivo, s.comision,
             f.fecha_factura, f.numero_factura, f.monto_bruto, f.monto_liquido, f.es_terceros, f.es_boleta,
             DATE_FORMAT(f.fecha_factura,'%Y-%m') AS mes_fact,
             (SELECT oc.num_orden FROM postventa_ordenes_comision oc WHERE oc.id_seguimiento = s.id ORDER BY oc.fecha DESC LIMIT 1) AS orden_comision
      FROM postventa_seguimiento s
      LEFT JOIN postventa_facturas_comision f ON f.id_seguimiento = s.id
      LEFT JOIN creditos cr ON cr.id = s.id_credito
      LEFT JOIN dealers  d  ON d.id_dealer = cr.id_dealer
      ${tablaWhere}
      ORDER BY s.fecha_otorgado DESC, s.num_op DESC
      LIMIT ?`, [...fp, limit]);
    const ids = rows.map(r => r.id);
    const etapas = await etapasPorTrack(ids, 'COMISION', ORDEN_COMISION);
    const data = rows.map(r => { const e = etapas[r.id] || {};
      return { ...r, estado: e.estado || 'SIN ETAPAS', fecha_estado: e.fecha_estado || null,
        paso: e.paso || 0, total: ORDEN_COMISION.length, etapas: e.etapas || [] }; });
    // Resumen: comisiones/facturas pendientes de pago (sin COMISION PAGADA), sobre el filtro (sin límite).
    const [[resumen]] = await pool.query(`
      SELECT COUNT(*) AS pendientes, COALESCE(SUM(s.comision),0) AS monto
      FROM postventa_seguimiento s
      LEFT JOIN postventa_facturas_comision f ON f.id_seguimiento = s.id
      ${baseWhere} AND NOT ${PAGADA})`, fp);
    res.json({ success: true, data, orden: ORDEN_COMISION, resumen, error: null });
  } catch (e) { console.error('[consultaFacturas]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const consultaFundantes = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const parque = String(req.query.parque || '').trim();
    const recibido7 = req.query.recibido7 === '1' || req.query.recibido7 === 'true';
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 300));
    const filt = []; const fp = [];
    const vis = await visibilidadEjecutivo(req);
    if (!vis.all) {
      if (!vis.lista.length) return res.json({ success: true, data: [], orden: ORDEN_SALDO, resumen: { pendientes: 0, monto: 0 }, error: null });
      filt.push('s.ejecutivo IN (?)'); fp.push(vis.lista);
    }
    if (q) {
      filt.push(`(s.num_op LIKE ? OR s.rut_dealer LIKE ? OR s.nombre_dealer LIKE ? OR s.ejecutivo LIKE ? OR cr.parque LIKE ? OR cr.nombre_parque_mgmt LIKE ?)`);
      const lk = '%' + q + '%'; fp.push(lk, lk, lk, lk, lk, lk);
    }
    if (parque) { filt.push(`(cr.parque LIKE ? OR cr.nombre_parque_mgmt LIKE ?)`); const lk = '%' + parque + '%'; fp.push(lk, lk); }
    const baseWhere = 'WHERE 1=1' + (filt.length ? ' AND ' + filt.join(' AND ') : '');
    const RECIBIDO = `EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='SALDO' AND e.etapa='FUNDANTES RECIBIDOS'`;
    // Por defecto: fundantes pendientes (aún sin recibir). Toggle: recibidos en los últimos 7 días.
    const tablaWhere = baseWhere + (recibido7 ? ' AND ' + RECIBIDO + ' AND e.fecha >= (NOW() - INTERVAL 7 DAY))' : ' AND NOT ' + RECIBIDO + ')');
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.financiera, s.rut_dealer,
             COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, NULLIF(cr.automotora,''), s.nombre_dealer) AS nombre_dealer,
             s.ejecutivo, s.fecha_otorgado, s.saldo_precio,
             COALESCE(NULLIF(cr.parque,''), cr.nombre_parque_mgmt) AS parque
      FROM postventa_seguimiento s
      LEFT JOIN creditos cr ON cr.id = s.id_credito
      LEFT JOIN dealers  d  ON d.id_dealer = cr.id_dealer
      ${tablaWhere}
      ORDER BY s.fecha_otorgado DESC, s.num_op DESC
      LIMIT ?`, [...fp, limit]);
    const ids = rows.map(r => r.id);
    const etapas = await etapasPorTrack(ids, 'SALDO', ORDEN_SALDO);
    const data = rows.map(r => { const e = etapas[r.id] || {};
      return { ...r, estado: e.estado || 'SIN ETAPAS', fecha_estado: e.fecha_estado || null,
        paso: e.paso || 0, total: ORDEN_SALDO.length, etapas: e.etapas || [] }; });
    // Resumen: fundantes pendientes (sin FUNDANTES RECIBIDOS), sobre el filtro q/parque/ejecutivo.
    const [[resumen]] = await pool.query(`
      SELECT COUNT(*) AS pendientes, COALESCE(SUM(s.saldo_precio),0) AS monto
      FROM postventa_seguimiento s
      LEFT JOIN creditos cr ON cr.id = s.id_credito
      ${baseWhere} AND NOT ${RECIBIDO})`, fp);
    res.json({ success: true, data, orden: ORDEN_SALDO, resumen, error: null });
  } catch (e) { console.error('[consultaFundantes]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// POST /api/postventa/enviar-correo-orden — envía la Orden de Pago a Contabilidad por correo.
// El destinatario es server-controlled (config correo_contabilidad); CC al usuario que la genera.
// El cuerpo (html) lo arma el frontend con la plantilla editable del mantenedor.
const enviarCorreoOrden = async (req, res) => {
  try {
    const { asunto, html, num_op, tipo } = req.body || {};
    if (!html || typeof html !== 'string' || !html.trim())
      return res.status(400).json({ success: false, data: null, error: 'Falta el contenido del correo' });
    if (html.length > 500000)
      return res.status(400).json({ success: false, data: null, error: 'El contenido del correo es demasiado grande' });
    // Check Activo del mantenedor: si la plantilla está desactivada no se envía
    try {
      const clave = tipo === 'comision' ? 'correo_orden_comision' : 'correo_orden_saldo';
      const [[pl]] = await pool.query('SELECT valor FROM postventa_config WHERE clave=?', [clave]);
      if (pl) { const v = JSON.parse(pl.valor); if (v && v.activo === false)
        return res.status(422).json({ success: false, data: null, error: 'Este correo está desactivado en Post Venta → Mantenedores' }); }
    } catch (_) {}
    let to = 'contabilidad@autofacilchile.cl';
    try {
      const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_contabilidad'");
      if (row) { const v = JSON.parse(row.valor); if (v && String(v).trim()) to = String(v).trim(); }
    } catch (_) {}
    const cc = (req.usuario && req.usuario.email) || undefined;
    const { enviarCorreo, remitentePorClave } = require('../../../../shared/mailer');
    // Remitente configurable por plantilla (mantenedor Post Venta); default sistema
    let from;
    try {
      const clave = tipo === 'comision' ? 'correo_orden_comision' : 'correo_orden_saldo';
      const [[pl]] = await pool.query('SELECT valor FROM postventa_config WHERE clave=?', [clave]);
      if (pl) { const v = JSON.parse(pl.valor); if (v && v.remitente) from = remitentePorClave(v.remitente); }
    } catch (_) {}
    const r = await enviarCorreo({ to, cc, subject: asunto || 'Orden de Pago — AutoFácil', html, from });
    if (!r.ok) return res.status(422).json({ success: false, data: null, error: r.error || 'No se pudo enviar el correo' });
    try {
      const { auditar } = require('../../../../shared/audit');
      auditar({ req, accion: 'ENVIAR', modulo: 'postventa', entidad: 'orden_pago', entidad_id: num_op || null,
        detalle: `Envió por correo la Orden de Pago ${tipo === 'comision' ? 'de Comisión ' : ''}(OP ${num_op || '—'}) a ${to}, CC ${cc || '—'}` });
    } catch (_) {}
    res.json({ success: true, data: { to, cc }, error: null });
  } catch (e) { console.error('[enviarCorreoOrden]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Saneo único (guardado por flag): órdenes ya marcadas "ORDEN DE PAGO EMITIDA"
 *    sin correlativo en op_correlativos → quedaron invisibles en el módulo Órdenes
 *    de Pago. Les asigna el ODP ahora para que aparezcan en el historial. ── */
require('../../../../shared/migrate').enFila('postventa', async () => {
  try {
    const [[flag]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='backfill_op_correlativos_v1'");
    if (flag && flag.valor === '1') return;
    const [saldo] = await pool.query(`
      SELECT DISTINCT e.id_seguimiento AS id FROM postventa_etapas e
      LEFT JOIN postventa_ordenes po ON po.id_seguimiento = e.id_seguimiento
      WHERE e.track='SALDO' AND e.etapa='ORDEN DE PAGO EMITIDA' AND po.id IS NULL`);
    for (const r of saldo) { try { await asegurarOrdenSaldo(r.id, null); } catch (e) { console.error('[saneo saldo]', r.id, e.message); } }
    const [com] = await pool.query(`
      SELECT DISTINCT e.id_seguimiento AS id FROM postventa_etapas e
      LEFT JOIN postventa_ordenes_comision po ON po.id_seguimiento = e.id_seguimiento
      WHERE e.track='COMISION' AND e.etapa='ORDEN DE PAGO EMITIDA' AND po.id IS NULL`);
    for (const r of com) { try { await asegurarOrdenComision(r.id, null); } catch (e) { console.error('[saneo comision]', r.id, e.message); } }
    await pool.query("INSERT INTO postventa_config (clave, valor) VALUES ('backfill_op_correlativos_v1','1') ON DUPLICATE KEY UPDATE valor='1'");
    if (saldo.length || com.length) console.log('[postventa] saneo op_correlativos → saldo:', saldo.length, 'comisión:', com.length);
  } catch (e) { console.error('[postventa saneo op_correlativos]', e.message); }
});

/* ── Saneo único del TIMBRE (guardado por flag): órdenes ya PAGADAS por la etapa de
 *    Post Venta pero sin pago en el libro (pagada=0) → quedan sin timbre. Les pone la
 *    fecha de su etapa de pago como fecha_pagada (sin N° de caja, porque no se registró
 *    en su momento) para que el documento muestre el timbre PAGADO + fecha. ── */
require('../../../../shared/migrate').enFila('postventa', async () => {
  try {
    const [[flag]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='backfill_pago_timbre_v1'");
    if (flag && flag.valor === '1') return;
    const [s] = await pool.query(`
      UPDATE op_correlativos oc
      JOIN postventa_ordenes po ON oc.origen='SALDO' AND po.id=oc.origen_id
      JOIN postventa_etapas e ON e.id_seguimiento=po.id_seguimiento AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO'
      SET oc.pagada=1, oc.fecha_pagada=e.fecha, oc.pagada_nombre=e.usuario, oc.metodo_pago=COALESCE(oc.metodo_pago,'Transferencia')
      WHERE oc.anulada=0 AND oc.pagada=0`);
    const [c] = await pool.query(`
      UPDATE op_correlativos oc
      JOIN postventa_ordenes_comision po ON oc.origen='COMISION' AND po.id=oc.origen_id
      JOIN postventa_etapas e ON e.id_seguimiento=po.id_seguimiento AND e.track='COMISION' AND e.etapa='COMISION PAGADA'
      SET oc.pagada=1, oc.fecha_pagada=e.fecha, oc.pagada_nombre=e.usuario, oc.metodo_pago=COALESCE(oc.metodo_pago,'Transferencia')
      WHERE oc.anulada=0 AND oc.pagada=0`);
    await pool.query("INSERT INTO postventa_config (clave, valor) VALUES ('backfill_pago_timbre_v1','1') ON DUPLICATE KEY UPDATE valor='1'");
    if (s.affectedRows || c.affectedRows) console.log('[postventa] saneo timbre pago → saldo:', s.affectedRows, 'comisión:', c.affectedRows);
  } catch (e) { console.error('[postventa saneo timbre]', e.message); }
});

/* ── Saneo único (flag): Saldo Precio de AUTOFIN — la Orden de Pago debe disponer
 *    saldo_precio + Transferencia + Limitación de dominio. Las órdenes emitidas antes
 *    guardaron solo el saldo base → se ajusta el monto del correlativo y de
 *    postventa_ordenes al total (asignación absoluta = idempotente). El documento se
 *    re-congela aparte por el bump de DOC_VERSION en ordenes-pago. ── */
require('../../../../shared/migrate').enFila('postventa', async () => {
  try {
    const [[flag]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='backfill_autofin_saldo_total_v1'");
    if (flag && flag.valor === '1') return;
    const f = await getFijosAutoFin();
    const extra = (f.autofin_inscripcion || 0) + (f.autofin_limitacion || 0);
    if (extra > 0) {
      const [oc] = await pool.query(`
        UPDATE op_correlativos oc
        JOIN postventa_ordenes po ON oc.origen='SALDO' AND po.id=oc.origen_id
        JOIN postventa_seguimiento s ON s.id=po.id_seguimiento
        SET oc.monto = s.saldo_precio + ?
        WHERE oc.anulada=0 AND UPPER(s.financiera)='AUTOFIN'`, [extra]);
      await pool.query(`
        UPDATE postventa_ordenes po
        JOIN postventa_seguimiento s ON s.id=po.id_seguimiento
        SET po.monto = s.saldo_precio + ?
        WHERE UPPER(s.financiera)='AUTOFIN'`, [extra]);
      if (oc.affectedRows) console.log('[postventa] saneo AUTOFIN saldo total → correlativos:', oc.affectedRows);
    }
    await pool.query("INSERT INTO postventa_config (clave, valor) VALUES ('backfill_autofin_saldo_total_v1','1') ON DUPLICATE KEY UPDATE valor='1'");
  } catch (e) { console.error('[postventa saneo AUTOFIN saldo]', e.message); }
});

module.exports = { sync, getAll, setEtapa, getConfig, setConfig, marcarHistorico, getPerfiles, getSaldosAPagar, enviarAPago, pagarSaldos, getOrdenPago, correlativoOrden, emitirOrdenPago, desmarcarSaldos, getAtribuciones, getFondos, setFondos, getAlertasConfig, setAlertasConfig,
  getComisionesAPagar, getOrdenPagoComision, correlativoOrdenComision, emitirOrdenPagoComision, enviarAPagoComision, pagarComisiones, desmarcarComisiones, getAtribucionesComision, getFondosComision, setFondosComision,
  getFacturaComision, updateFacturaComision, consultaSaldos, consultaFacturas, consultaFundantes, enviarCorreoOrden, fundantesDevueltos,
  // hooks para otros módulos (ordenes-pago paga la ODP de comisión; anulación/prepago desactivan la comisión)
  notificarPagoComisionDealer, notificarPagoSaldoDealer, idsGrupoFactura, marcarComisionAPagar, probarCorreos,
  contabilizarSaldoPrecio, contabilizarComision,   // el pago desde la ODP también debe generar su asiento
  getFijosAutoFin, esAutoFin, montoSaldoOrden };
