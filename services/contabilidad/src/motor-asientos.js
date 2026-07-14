'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR DE ASIENTOS AUTOMÁTICOS — Fase 2 Contabilidad (centralización)
   Motor ÚNICO: cada evento de negocio de la Suite genera su comprobante
   contable según REGLAS PARAMÉTRICAS (mantenedor Reglas de Centralización).

   contabilizar({ evento, fecha, glosa, ref, montos, num_op, rut })
   · Busca la regla del evento (ctb_reglas + ctb_reglas_lineas).
   · Cada línea de regla dice: cuenta, lado (DEBE/HABER) y CAMPO de monto;
     el monto sale de `montos[campo]`. Líneas en $0 se omiten.
   · Valida partida doble; inserta el comprobante con origen=evento y
     origen_ref=ref (idempotencia: si ya existe un comprobante CONTABILIZADO
     con ese origen+ref, no duplica).
   · NUNCA lanza: registra el resultado en ctb_eventos_log
     (CONTABILIZADO / SIN_REGLA / DESACTIVADA / DESCUADRE / ERROR / DUPLICADO)
     — la operación de negocio jamás se cae por contabilidad.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../shared/migrate').enFila('contabilidad-motor', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_reglas (
        evento      VARCHAR(40) PRIMARY KEY,
        nombre      VARCHAR(150) NOT NULL,
        descripcion VARCHAR(400) NULL,          -- qué dispara el evento y qué campos trae
        tipo        VARCHAR(10) NOT NULL DEFAULT 'TRASPASO',  -- tipo de comprobante que genera
        activa      TINYINT NOT NULL DEFAULT 0,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_reglas_lineas (
        id      INT AUTO_INCREMENT PRIMARY KEY,
        evento  VARCHAR(40) NOT NULL,
        cuenta  VARCHAR(20) NOT NULL,
        lado    VARCHAR(5) NOT NULL,            -- DEBE / HABER
        campo   VARCHAR(40) NOT NULL,           -- clave dentro de montos{}
        glosa   VARCHAR(200) NULL,
        INDEX idx_evento (evento)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_eventos_log (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        evento         VARCHAR(40) NOT NULL,
        ref            VARCHAR(60) NULL,
        estado         VARCHAR(15) NOT NULL,
        detalle        VARCHAR(400) NULL,
        id_comprobante INT NULL,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_evento (evento, created_at)
      )`);

    // Reglas semilla con el plan REAL de AVSOFT (editable 100% en el mantenedor).
    // Nacen ACTIVAS: los comprobantes generados son visibles y anulables.
    const R = [
      ['PAGO_CAJA', 'Pago de cuotas en Caja', 'Se dispara al registrar un pago de cuotas en Caja. Campos: total (lo cobrado), cuota (capital+interés de cuotas), mora (interés de mora), gastos (gastos de cobranza).', 'INGRESO', 1, [
        ['1101090', 'DEBE', 'total', 'Recaudación caja'],
        ['1104010', 'HABER', 'cuota', 'Abono a contratos'],
        ['3001040', 'HABER', 'mora', 'Interés de mora'],
        ['3001020', 'HABER', 'gastos', 'Gastos de cobranza'],
      ]],
      ['PREPAGO', 'Prepago de crédito en Caja', 'Se dispara al saldar completo un crédito en Caja. Campos: total (lo cobrado), cuota (capital+interés de cuotas), mora (interés de mora + comisión de prepago), gastos (gastos de cobranza).', 'INGRESO', 1, [
        ['1101090', 'DEBE', 'total', 'Recaudación prepago'],
        ['1104010', 'HABER', 'cuota', 'Abono a contratos'],
        ['3001090', 'HABER', 'mora', 'Ingresos por prepago'],
        ['3001020', 'HABER', 'gastos', 'Gastos de cobranza'],
      ]],
      ['ODP_PAGADA', 'Orden de Pago pagada', 'Se dispara al marcar PAGADA una Orden de Pago a proveedor. Campos: monto (total de la orden).', 'EGRESO', 1, [
        ['2102022', 'DEBE', 'monto', 'Pago a proveedor'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      ['CASTIGO', 'Castigo de saldo aprobado', 'Se dispara cuando el castigo recibe ambas firmas gerenciales. Campos: monto (saldo castigado).', 'TRASPASO', 1, [
        ['1104050', 'DEBE', 'monto', 'Uso de provisión por castigo'],
        ['1104020', 'HABER', 'monto', 'Baja del contrato'],
      ]],
      ['PROVISION_CIERRE', 'Constitución de provisión (cierre de mes)', 'Se dispara al cerrar el mes contable de Provisiones y Castigos. Campos: constitucion (cargo a resultado del período).', 'TRASPASO', 1, [
        ['4001190', 'DEBE', 'constitucion', 'Gasto provisión incobrables'],
        ['1104050', 'HABER', 'constitucion', 'Constitución de provisión'],
      ]],
      ['REMUNERACIONES', 'Emisión de liquidaciones del mes', 'Se dispara al EMITIR las liquidaciones en RRHH. Campos: haberes (total haberes), liquido (líquidos a pagar), descuentos (AFP+salud+AFC+impuesto+otros).', 'TRASPASO', 1, [
        ['4001060', 'DEBE', 'haberes', 'Gasto remuneraciones del mes'],
        ['2104010', 'HABER', 'liquido', 'Líquidos por pagar'],
        ['2210904', 'HABER', 'descuentos', 'Leyes sociales e impuestos por pagar'],
      ]],
    ];
    for (const [evento, nombre, desc, tipo, activa, lineas] of R) {
      const [r] = await pool.query('INSERT IGNORE INTO ctb_reglas (evento, nombre, descripcion, tipo, activa) VALUES (?,?,?,?,?)',
        [evento, nombre, desc, tipo, activa]);
      if (r.affectedRows) {
        for (const [cuenta, lado, campo, glosa] of lineas)
          await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)',
            [evento, cuenta, lado, campo, glosa]);
      }
    }
    console.log('[contabilidad] motor de asientos listo');
  } catch (e) { console.error('[contabilidad-motor migration]', e.message); }
});

const log = (evento, ref, estado, detalle, id_comprobante = null) =>
  pool.query('INSERT INTO ctb_eventos_log (evento, ref, estado, detalle, id_comprobante) VALUES (?,?,?,?,?)',
    [evento, ref || null, estado, (detalle || '').slice(0, 400), id_comprobante]).catch(() => {});

/* Contabiliza un evento de negocio. Nunca lanza. Devuelve id del comprobante o null. */
async function contabilizar({ evento, fecha, glosa, ref, montos = {}, num_op = null, rut = null }) {
  try {
    const [[regla]] = await pool.query('SELECT * FROM ctb_reglas WHERE evento=?', [evento]);
    if (!regla) { await log(evento, ref, 'SIN_REGLA', 'Evento sin regla configurada'); return null; }
    if (!regla.activa) { await log(evento, ref, 'DESACTIVADA', 'Regla desactivada en el mantenedor'); return null; }
    const [lineas] = await pool.query('SELECT * FROM ctb_reglas_lineas WHERE evento=? ORDER BY id', [evento]);
    if (!lineas.length) { await log(evento, ref, 'SIN_REGLA', 'Regla sin líneas'); return null; }

    // Idempotencia por origen+ref
    if (ref) {
      const [[dup]] = await pool.query(
        "SELECT id FROM ctb_comprobantes WHERE origen=? AND origen_ref=? AND estado='CONTABILIZADO' LIMIT 1", [evento, ref]);
      if (dup) { await log(evento, ref, 'DUPLICADO', `Ya contabilizado en comprobante id ${dup.id}`, dup.id); return null; }
    }

    const movs = [];
    let debe = 0, haber = 0;
    for (const l of lineas) {
      const monto = Math.round(Number(montos[l.campo]) || 0);
      if (!monto) continue;
      if (monto < 0) { await log(evento, ref, 'ERROR', `Campo ${l.campo} negativo (${monto})`); return null; }
      movs.push({ cuenta: l.cuenta, glosa: l.glosa, debe: l.lado === 'DEBE' ? monto : 0, haber: l.lado === 'HABER' ? monto : 0 });
      if (l.lado === 'DEBE') debe += monto; else haber += monto;
    }
    if (!debe && !haber) { await log(evento, ref, 'ERROR', 'Todos los montos en cero'); return null; }
    if (debe !== haber) { await log(evento, ref, 'DESCUADRE', `Debe ${debe} ≠ Haber ${haber} — revisa la regla`); return null; }

    const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : new Date().toISOString().slice(0, 10);
    const anio = Number(f.slice(0, 4));
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ sig }]] = await conn.query(
        'SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? FOR UPDATE', [regla.tipo, anio]);
      const [r] = await conn.query(
        `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, origen, origen_ref, total, creado_por)
         VALUES (?,?,?,?,?,?,?,?,'Motor de asientos')`,
        [regla.tipo, anio, sig, f, (glosa || regla.nombre).slice(0, 300), evento, ref || null, debe]);
      for (const m of movs)
        await conn.query('INSERT INTO ctb_movimientos (id_comprobante, cuenta, glosa, debe, haber, num_op, rut) VALUES (?,?,?,?,?,?,?)',
          [r.insertId, m.cuenta, m.glosa, m.debe, m.haber, num_op, rut]);
      await conn.commit();
      await log(evento, ref, 'CONTABILIZADO', `${regla.tipo[0]}-${anio}-${String(sig).padStart(5, '0')} por $${debe.toLocaleString('es-CL')}`, r.insertId);
      return r.insertId;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally { conn.release(); }
  } catch (e) {
    console.error(`[motor-asientos] ${evento} ${ref || ''}:`, e.message);
    await log(evento, ref, 'ERROR', e.message);
    return null;
  }
}

module.exports = { contabilizar };
