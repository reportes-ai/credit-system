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
    // Las cuentas de las reglas NUNCA llevan año: la separación por ejercicio la da
    // el período contable, no cuentas distintas (las 'FACTURAS POR PAGAR 20XX' que
    // venían de AVSOFT obligaban a reeditar la regla cada enero).
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
        ['2102010', 'DEBE', 'monto', 'Pago a proveedor'],   // cuenta SIN año (ver nota abajo)
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      ['ANTICIPO_PERSONAL', 'Anticipo de sueldo depositado', 'Se dispara al marcar PAGADA la ODP de un anticipo de sueldo (Solicitudes RRHH). Es cuenta por cobrar al personal, NO gasto. Campos: monto (anticipo).', 'EGRESO', 1, [
        ['1105010', 'DEBE', 'monto', 'Anticipo de remuneraciones'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      ['PRESTAMO_PERSONAL', 'Préstamo al personal depositado', 'Se dispara al marcar PAGADA la ODP de un préstamo al personal (Solicitudes RRHH). Es cuenta por cobrar al personal, NO gasto. Campos: monto (capital prestado).', 'EGRESO', 1, [
        ['1105020', 'DEBE', 'monto', 'Préstamo a empleados'],
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
      ['PROVISION_LIBERACION', 'Liberación de provisión (cierre de mes)', 'Se dispara al cerrar el mes de Provisiones y Castigos cuando la provisión requerida BAJÓ (mejora de la mora): reversa el gasto por el exceso. Campos: liberacion (monto liberado).', 'TRASPASO', 1, [
        ['1104050', 'DEBE', 'liberacion', 'Liberación de provisión'],
        ['4001190', 'HABER', 'liberacion', 'Abono gasto provisión incobrables'],
      ]],
      ['PROVISION_VACACIONES', 'Provisión de vacaciones (cierre de mes)', 'Se dispara en el cierre de mes cuando la provisión de vacaciones del equipo (días disponibles × remuneración diaria, motor de la cuenta corriente de vacaciones) SUBIÓ respecto del mes anterior. Campos: constitucion (variación).', 'TRASPASO', 1, [
        ['4002030', 'DEBE', 'constitucion', 'Gasto provisión de vacaciones'],
        ['2106030', 'HABER', 'constitucion', 'Provisión de vacaciones por pagar'],
      ]],
      ['FINIQUITO_EMITIDO', 'Finiquito emitido (RRHH)', 'Se dispara al GUARDAR un finiquito en RRHH → Contratos → Finiquitos: reconoce el gasto y deja el monto en Finiquitos por Pagar (el pago posterior banco contra 2106070 se registra al pagar). Campos: total.', 'TRASPASO', 1, [
        ['4002050', 'DEBE', 'total', 'Gasto finiquito'],
        ['2106070', 'HABER', 'total', 'Finiquito por pagar'],
      ]],
      ['FINIQUITO_PAGADO', 'Finiquito pagado (ODP)', 'Se dispara al marcar PAGADA la ODP de un finiquito (generada al guardar el finiquito en RRHH): rebaja Finiquitos por Pagar contra banco. Campos: monto.', 'EGRESO', 1, [
        ['2106070', 'DEBE', 'monto', 'Rebaja finiquito por pagar'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      ['PROVISION_VAC_LIBERACION', 'Liberación provisión de vacaciones (cierre de mes)', 'Se dispara en el cierre de mes cuando la provisión de vacaciones BAJÓ (se tomaron o pagaron días): reversa el exceso. Campos: liberacion (variación).', 'TRASPASO', 1, [
        ['2106030', 'DEBE', 'liberacion', 'Rebaja provisión de vacaciones'],
        ['4002030', 'HABER', 'liberacion', 'Abono gasto provisión de vacaciones'],
      ]],
      ['REMUNERACIONES', 'Emisión de liquidaciones del mes', 'Se dispara al EMITIR las liquidaciones en RRHH. Campos: haberes (total haberes), liquido (líquidos a pagar), descuentos (AFP+salud+AFC+impuesto+otros).', 'TRASPASO', 1, [
        ['4001060', 'DEBE', 'haberes', 'Gasto remuneraciones del mes'],
        ['2104010', 'HABER', 'liquido', 'Líquidos por pagar'],
        ['2210904', 'HABER', 'descuentos', 'Leyes sociales e impuestos por pagar'],
      ]],
      /* ── COMISIÓN A DEALER ────────────────────────────────────────────────
         La comisión calculada es BRUTA (IVA incluido) y se desagrega con el motor
         AF_IMPUESTO. El gasto se reconoce al RECIBIR el documento (devengo) y el
         pago solo rebaja el pasivo. Con FACTURA el IVA es crédito fiscal; con
         BOLETA hay retención de honorarios que queda como pasivo con el SII
         hasta declararla en el F29.
         Cuenta de pasivo: CONCESIONARIOS POR PAGAR (2102040), SIN año — las cuentas
         "FACTURAS POR PAGAR ... 20XX" obligan a cambiar la regla cada enero. */
      ['COMISION_DEV_FACTURA', 'Comisión dealer devengada (factura)', 'Se dispara al registrar la FACTURA de comisión del dealer en Post Venta → Seguimiento. Campos: neto, iva, liquido (bruto a pagar).', 'TRASPASO', 1, [
        ['4001127', 'DEBE',  'neto',    'Comisión dealer (neto)'],
        ['1108010', 'DEBE',  'iva',     'IVA crédito fiscal'],
        ['2102040', 'HABER', 'liquido', 'Concesionarios por pagar'],
      ]],
      ['COMISION_DEV_BOLETA', 'Comisión dealer devengada (boleta de honorarios)', 'Se dispara al registrar la BOLETA de honorarios de comisión en Post Venta → Seguimiento. Campos: honorario (bruto de la boleta), retencion, liquido (a depositar).', 'TRASPASO', 1, [
        ['4002081', 'DEBE',  'honorario', 'Honorarios por comisiones'],
        ['2105070', 'HABER', 'retencion', 'Retención de honorarios por pagar (F29)'],
        ['2102040', 'HABER', 'liquido',   'Concesionarios por pagar'],
      ]],
      ['COMISION_PAGADA_FACTURA', 'Comisión dealer pagada (factura)', 'Se dispara al marcar COMISION PAGADA en Post Venta cuando el documento es factura: rebaja el pasivo contra banco. Campos: liquido.', 'EGRESO', 1, [
        ['2102040', 'DEBE',  'liquido', 'Pago comisión dealer'],
        ['1101090', 'HABER', 'liquido', 'Salida de banco'],
      ]],
      ['COMISION_PAGADA_BOLETA', 'Comisión dealer pagada (boleta)', 'Se dispara al marcar COMISION PAGADA en Post Venta cuando el documento es boleta: rebaja el pasivo por el LÍQUIDO (la retención queda pendiente hasta el F29). Campos: liquido.', 'EGRESO', 1, [
        ['2102040', 'DEBE',  'liquido', 'Pago comisión dealer (líquido)'],
        ['1101090', 'HABER', 'liquido', 'Salida de banco'],
      ]],
      /* ── INGRESO: la comisión que AutoFácil COBRA a la financiera ──────────
         Se devenga al solicitar la facturación del mes (Post Venta → Facturación
         AutoFácil). El monto calculado es BRUTO (IVA incluido) y se desagrega:
         el neto es el ingreso y el IVA queda como débito fiscal para el F29. */
      ['FACTURACION_AF_COLOCACION', 'Comisión por colocación facturada a la financiera', 'Se dispara al solicitar la facturación del concepto COLOCACIÓN (o ANTICIPO) en Post Venta → Facturación AutoFácil. Campos: bruto (total facturado), neto, iva.', 'INGRESO', 1, [
        ['1106013', 'DEBE',  'bruto', 'Producción comisión por cobrar'],
        ['3001073', 'HABER', 'neto',  'Comisión de producción'],
        ['2107010', 'HABER', 'iva',   'IVA débito fiscal'],
      ]],
      ['FACTURACION_AF_SEGUROS', 'Comisión por seguros facturada a la financiera', 'Se dispara al solicitar la facturación del concepto SEGUROS en Post Venta → Facturación AutoFácil. Campos: bruto, neto, iva.', 'INGRESO', 1, [
        ['1106012', 'DEBE',  'bruto', 'Producción seguros por cobrar'],
        ['3001075', 'HABER', 'neto',  'Comisión seguros'],
        ['2107010', 'HABER', 'iva',   'IVA débito fiscal'],
      ]],
      /* ── SALDO PRECIO: CUENTA DE PASO ──────────────────────────────────────
         AutoFácil es intermediario: la financiera transfiere el saldo precio y
         se entrega ÍNTEGRO al dealer. NO es ingreso ni gasto — entra y sale por
         una cuenta transitoria de pasivo, y el resultado del ejercicio no se toca. */
      ['SALDO_FONDOS_RECIBIDOS', 'Saldo precio recibido de la financiera (cuenta de paso)', 'Se dispara al marcar FONDOS RECIBIDOS en Post Venta → Seguimiento. NO es ingreso: queda como pasivo hasta pagárselo al dealer. Campos: monto (saldo precio).', 'INGRESO', 1, [
        ['1101090', 'DEBE',  'monto', 'Ingreso de fondos saldo precio'],
        ['2102045', 'HABER', 'monto', 'Saldo precio por pagar al dealer'],
      ]],
      ['SALDO_PRECIO_PAGADO', 'Saldo precio pagado al dealer (cuenta de paso)', 'Se dispara al marcar SALDO PRECIO PAGADO en Post Venta → Seguimiento. NO es gasto: rebaja el pasivo transitorio contra banco. Campos: monto.', 'EGRESO', 1, [
        ['2102045', 'DEBE',  'monto', 'Rebaja saldo precio por pagar'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      /* ── COMISIONES INTERNAS: ejecutivos y parques (devengo al aprobar el mes) ── */
      ['COMISION_EJECUTIVOS', 'Comisiones de ejecutivos aprobadas (mes)', 'Se dispara al APROBAR las comisiones del mes en Comisión Ejecutivos → Revisión. Reconoce el gasto y deja el monto por pagar (el pago se registra al emitir/pagar su ODP). Campos: monto (total aprobado del mes).', 'TRASPASO', 1, [
        ['4001100', 'DEBE',  'monto', 'Gasto comisiones de ejecutivos'],
        ['2106060', 'HABER', 'monto', 'Comisiones ejecutivos por pagar'],
      ]],
      ['COMISION_PARQUES', 'Comisiones/arriendo de parques del mes', 'Se dispara al aprobar las comisiones de parques del mes (Post Venta → Comisiones Parques). El arriendo y la comisión son gastos de naturaleza distinta y van a cuentas separadas. Campos: arriendo, comision.', 'TRASPASO', 1, [
        ['4002100', 'DEBE',  'arriendo', 'Arriendo de parque'],
        ['4001100', 'DEBE',  'comision', 'Comisión por ventas parque'],
        ['2106012', 'HABER', 'arriendo', 'Comisiones parque por pagar (arriendo)'],
        ['2106012', 'HABER', 'comision', 'Comisiones parque por pagar (comisión)'],
      ]],
      ['COMISION_PARQUES_PAGADA', 'Comisión/arriendo de parque pagada (ODP)', 'Se dispara al confirmar el pago de la ODP mensual del parque (Post Venta → Comisiones Parques a Pagar): rebaja el pasivo contra banco. Campos: monto (total de la ODP).', 'EGRESO', 1, [
        ['2106012', 'DEBE',  'monto', 'Pago comisión/arriendo parque'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
      ]],
      /* ── CARTERA PROPIA: solo créditos AUTOFÁCIL (recursos propios) ─────────
         En brokerage (AutoFin/Unidad) el crédito NO es nuestro: no hay colocación
         que activar. Solo se contabiliza cuando la operación es AUTOFACIL. */
      ['CREDITO_OTORGADO_AF', 'Crédito AutoFácil otorgado (colocación cartera propia)', 'Se dispara al otorgar un crédito de recursos propios (financiera AUTOFACIL): activa la colocación contra la salida de fondos. NO aplica a operaciones brokerage. Campos: monto (monto financiado).', 'EGRESO', 1, [
        ['1104010', 'DEBE',  'monto', 'Colocación contratos propios'],
        ['1101090', 'HABER', 'monto', 'Salida de banco'],
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
    // Parche idempotente (v187.3): COMISION_PARQUES nació con un solo campo `monto`;
    // el arriendo y la comisión son gastos distintos y se separan (4002100 / 4001100).
    // Solo si la regla conserva el default viejo Y nunca ha generado un asiento —
    // si el Administrador ya la editó o ya hay comprobantes, no se toca.
    try {
      const [[viejo]] = await pool.query(
        "SELECT COUNT(*) n FROM ctb_reglas_lineas WHERE evento='COMISION_PARQUES' AND campo='monto'");
      const [[usada]] = await pool.query(
        "SELECT COUNT(*) n FROM ctb_eventos_log WHERE evento='COMISION_PARQUES' AND estado='CONTABILIZADO'");
      if (viejo.n > 0 && usada.n === 0) {
        await pool.query("DELETE FROM ctb_reglas_lineas WHERE evento='COMISION_PARQUES'");
        for (const [cuenta, lado, campo, glosa] of [
          ['4002100', 'DEBE',  'arriendo', 'Arriendo de parque'],
          ['4001100', 'DEBE',  'comision', 'Comisión por ventas parque'],
          ['2106012', 'HABER', 'arriendo', 'Comisiones parque por pagar (arriendo)'],
          ['2106012', 'HABER', 'comision', 'Comisiones parque por pagar (comisión)'],
        ]) await pool.query('INSERT INTO ctb_reglas_lineas (evento, cuenta, lado, campo, glosa) VALUES (?,?,?,?,?)', ['COMISION_PARQUES', cuenta, lado, campo, glosa]);
        await pool.query("UPDATE ctb_reglas SET descripcion='Se dispara al aprobar las comisiones de parques del mes (Post Venta → Comisiones Parques). El arriendo y la comisión son gastos de naturaleza distinta y van a cuentas separadas. Campos: arriendo, comision.' WHERE evento='COMISION_PARQUES'");
        console.log('[contabilidad] COMISION_PARQUES: arriendo y comisión separados');
      }
    } catch (e) { console.error('[contabilidad parche parques]', e.message); }
    console.log('[contabilidad] motor de asientos listo');
  } catch (e) { console.error('[contabilidad-motor migration]', e.message); }
});

const log = (evento, ref, estado, detalle, id_comprobante = null) =>
  pool.query('INSERT INTO ctb_eventos_log (evento, ref, estado, detalle, id_comprobante) VALUES (?,?,?,?,?)',
    [evento, ref || null, estado, (detalle || '').slice(0, 400), id_comprobante]).catch(() => {});

/* Contabiliza un evento de negocio. Nunca lanza. Devuelve id del comprobante o null. */
/* `detalle` (opcional): trazabilidad que se agrega a la glosa de CADA línea del
   asiento — típicamente el N° de orden de pago y el tercero (dealer/proveedor).
   El libro mayor muestra la glosa del movimiento, no la del comprobante, así que
   sin esto las líneas salían genéricas ("Saldo precio por pagar al dealer") y no
   se podía saber a qué orden ni a qué dealer correspondía cada monto. */
async function contabilizar({ evento, fecha, glosa, ref, montos = {}, num_op = null, rut = null, detalle = null }) {
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
      const glosaLinea = [l.glosa, detalle].filter(Boolean).join(' · ').slice(0, 300);   // ctb_movimientos.glosa = varchar(300)
      movs.push({ cuenta: l.cuenta, glosa: glosaLinea, debe: l.lado === 'DEBE' ? monto : 0, haber: l.lado === 'HABER' ? monto : 0 });
      if (l.lado === 'DEBE') debe += monto; else haber += monto;
    }
    if (!debe && !haber) { await log(evento, ref, 'ERROR', 'Todos los montos en cero'); return null; }
    if (debe !== haber) { await log(evento, ref, 'DESCUADRE', `Debe ${debe} ≠ Haber ${haber} — revisa la regla`); return null; }

    const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : new Date().toISOString().slice(0, 10);
    // Candado de mes cerrado: el evento queda en el log para regularizarlo a mano
    const [[cerrado]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [f.slice(0, 7)]);
    if (cerrado) { await log(evento, ref, 'MES_CERRADO', `El mes ${f.slice(0, 7)} está cerrado con candado — asiento NO contabilizado; reabrir el mes y reprocesar, o digitarlo en el mes abierto`); return null; }
    const anio = Number(f.slice(0, 4));
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      /* `SELECT MAX(...) FOR UPDATE` NO reserva el hueco: es un agregado, y
         cuando el año/tipo aún no tiene filas no hay nada que bloquear. Dos
         eventos simultáneos del mismo tipo leían el mismo número y el segundo
         chocaba contra `uq_tipo_anio_num`; ese error subía al catch de abajo,
         que registra y devuelve null SIN reintentar. Resultado: la operación de
         negocio se completaba y el asiento sencillamente no existía — la
         contabilidad quedaba descuadrada sin que nadie se enterara hasta el
         cierre de mes (auditoría 05-08-2026, C-5).
         Mismo remedio que `shared/num-op.js` para el correlativo de operación:
         insistir con el siguiente número hasta encontrar el libre. */
      let sig = null, r = null, ultimo = null;
      for (let intento = 0; intento < 8 && !r; intento++) {
        const [[mx]] = await conn.query(
          'SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? FOR UPDATE', [regla.tipo, anio]);
        sig = Number(mx.sig) + intento;
        try {
          [r] = await conn.query(
            `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, origen, origen_ref, total, creado_por)
             VALUES (?,?,?,?,?,?,?,?,'Motor de asientos')`,
            [regla.tipo, anio, sig, f, (glosa || regla.nombre).slice(0, 300), evento, ref || null, debe]);
        } catch (e) {
          const dup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
          if (!dup) throw e;                       // otro error: no es carrera
          ultimo = e;
        }
      }
      if (!r) throw ultimo || new Error('No se pudo obtener un número de comprobante libre');
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
