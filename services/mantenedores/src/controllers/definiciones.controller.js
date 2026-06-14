'use strict';
const pool = require('../../../../shared/config/database');

// Glosario de definiciones de negocio usadas en el sistema (editable por el Admin).
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS definiciones (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      termino     VARCHAR(120) NOT NULL,
      definicion  TEXT NOT NULL,
      categoria   VARCHAR(60) DEFAULT 'General',
      orden       INT DEFAULT 0,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM definiciones');
    if (n === 0) {
      const seed = [
        ['Umbral UF (tramo MENOR/MAYOR)', 'Valor en UF (por defecto 200) que separa las operaciones en tramo MENOR o MAYOR. Se recalcula con la UF de la fecha de otorgamiento. Editable en Tasas → Modificar Umbrales.', 'Créditos'],
        ['MAYOR / MENOR 200 UF', 'Clasificación de una operación según si el saldo precio (en UF de su fecha de otorgamiento) supera o no el umbral. Determina la tasa/TMC aplicada.', 'Créditos'],
        ['TMC (Tasa Máxima Convencional)', 'Tasa máxima legal por período y por tramo (menor/mayor 200 UF), cargada por rango de fechas en el mantenedor de Tasas. Base del ingreso por tasa y del interés por mora.', 'Créditos'],
        ['Saldo Precio', 'Monto que AutoFin/financiera paga al concesionario por la operación. Se gestiona en Post Venta (orden de pago, envío a pago, pago).', 'Post Venta'],
        ['Orden de Pago Emitida', 'Etapa Post Venta: se generó la orden de pago del saldo precio (correlativo OP-AAAA-NNNNN) y se envió a Contabilidad. Se marca automáticamente desde Emisión Orden de Pago.', 'Post Venta'],
        ['Enviado a Pago', 'Etapa Post Venta intermedia: el Gerente Comercial (u otro habilitado) fijó la selección de operaciones a pagar. Quedan firmes en cola para que Tesorería confirme el pago.', 'Post Venta'],
        ['Gasto de Cobranza', 'Cargo por gestión de cobranza (Ley 19.496), aplicable solo tras 20 días corridos del vencimiento (día 21). Se calcula por tramos marginales sobre la deuda en UF: hasta 10 UF → 9%, 10–50 UF → 6%, sobre 50 UF → 3%. La UF se fija en el día 21.', 'Cobranza'],
        ['Interés por Mora', 'Interés diario simple (no compuesto) sobre el valor de la cuota original. Tasa diaria = TMC mensual / 30, usando el tramo (menor/mayor 200 UF) del crédito original. Cada día de atraso usa la TMC vigente de su mes (si la mora cruza meses, cada tramo de días aplica la TMC de ese mes). Se acumula desde el día siguiente al vencimiento.', 'Cobranza'],
      ];
      let orden = 1;
      for (const [termino, definicion, categoria] of seed)
        await pool.query('INSERT INTO definiciones (termino, definicion, categoria, orden) VALUES (?,?,?,?)', [termino, definicion, categoria, orden++]);
    }
    console.log('✓ Mantenedores: tabla definiciones verificada');
  } catch (e) { console.error('✗ definiciones migración:', e.message); }
})();

// Carga incremental de la base de conocimiento (idempotente: inserta solo los
// términos que aún no existen, por nombre). Concentra glosario + fórmulas por tema.
(async () => {
  try {
    const KB = [
      // ── Glosario e identificadores ──────────────────────────────────────
      ['N° Operación', 'Número del crédito en AutoFácil (campos num_op / numero_credito). Es el identificador propio del negocio y la llave usada en todo el sistema. NO es lo mismo que el ID Financiera.', 'Glosario'],
      ['ID Financiera', 'Folio del crédito en la institución financiera (op_origen / id_financiera), el número que asigna la financiera (AUTOFIN, etc.). Distinto del N° Operación de AutoFácil.', 'Glosario'],
      ['Dealer', 'Concesionario o automotora que origina la operación. Término homologado (antes "Concesionario"/"Automotora"). Llave: rut_dealer.', 'Glosario'],
      ['Ejecutivo', 'Ejecutivo comercial responsable de la operación. Determina a quién se notifica y qué comisiones ve cada usuario (tabla usuario_ejecutivos).', 'Glosario'],
      ['Cliente', 'Deudor del crédito. Llave: rut_cliente. Sus datos viven en clientes, antecedentes_laborales e informacion_comercial.', 'Glosario'],

      // ── Créditos ────────────────────────────────────────────────────────
      ['Institución / Financiera', 'Entidad que cursa el crédito. AUTOFIN es el default (todas las operaciones son del negocio); también UNIDAD y AUTOFACIL.', 'Créditos'],
      ['UF de fecha de otorgamiento', 'Para clasificar MENOR/MAYOR 200 UF, el saldo precio se convierte a UF usando el valor de la UF de la fecha_otorgado (lookup en tabla uf, no un campo guardado).', 'Créditos'],

      // ── Comisiones ──────────────────────────────────────────────────────
      ['Comisión Dealer', 'Participación que AutoFácil paga al dealer por la operación. La participación que RIGE es la de la Carta de Aprobación (negociación especial); si la carta no la trae, se calcula por parámetros.', 'Comisiones'],
      ['Comisión Bruta', 'Comisión con IVA incluido (la que traen las cartas de aprobación). Neto = Bruto / (1 + IVA).', 'Comisiones'],
      ['% Participación / % Comisión', 'Proporción de la comisión sobre el saldo precio. Fórmula: % = Comisión / Saldo Precio.', 'Comisiones'],

      // ── Impuestos (paramétricos en Mantenedor Impuestos) ────────────────
      ['IVA', 'Impuesto al Valor Agregado, 19% (paramétrico en Mantenedor Impuestos). Sobre el neto: IVA = Neto × 19%; Bruto = Neto × 1,19. Todos los cálculos leen la tabla impuestos.', 'Impuestos'],
      ['Retención de Honorarios', 'Retención de 15,25% (paramétrica). Aplica cuando el dealer emite Boleta de Honorarios en vez de Factura. Retención = Neto × 15,25%.', 'Impuestos'],
      ['Factura (afecta)', 'Documento con IVA. Sobre el monto neto: IVA = Neto × 19% y Total Bruto = Neto × 1,19. AutoFácil deposita el bruto (el IVA lo entera el emisor).', 'Impuestos'],
      ['Boleta de Honorarios', 'Excepción autorizada: el dealer emite boleta en vez de factura. La boleta se emite por el Monto Neto (líquido de la factura). Afecta a Retención 15,25%. Monto a depositar = Neto − Retención.', 'Impuestos'],
      ['Monto a Depositar / A Pagar', 'Lo que efectivamente se transfiere al dealer. Con Factura: el Total Bruto. Con Boleta: Neto − Retención de Honorarios.', 'Impuestos'],

      // ── Cartolas ────────────────────────────────────────────────────────
      ['Cartola', 'Estado de cuenta acumulativo por dealer con las comisiones pendientes (estado A PAGAR), sin importar el mes de origen (cross-mes). Al enviarla se estampa el Mes Cartola y se marca CARTOLA ENVIADA en Post Venta.', 'Cartolas'],
      ['Mes Cartola', 'Período en que se EMITE la cartola. Una cartola de un mes puede incluir operaciones otorgadas en meses anteriores que seguían pendientes.', 'Cartolas'],
      ['Estado Comisión', 'PENDIENTE (recién creada) → A PAGAR (lista para salir en cartola) / A DESCONTAR (prepago o anulación) → PAGADO (comisión pagada).', 'Cartolas'],
      ['Movimiento (cartola)', 'Tipo de fila en la cartola: COMISION (normal), PREPAGO o ANULACION (ajustes manuales, quedan en estado A DESCONTAR).', 'Cartolas'],
      ['Reversar Envío de Cartola', 'Acción sensible (permiso aprob_cartola_reversar; solo Admin por defecto) que deshace un envío: borra el registro, limpia el Mes Cartola de los movimientos y quita la etapa CARTOLA ENVIADA, dejando las operaciones listas para reenviar.', 'Cartolas'],

      // ── Post Venta (flujos y etapas) ────────────────────────────────────
      ['Flujo Saldo Precio', 'Secuencia de etapas (track SALDO): Fundantes Pendientes → Fundantes Recibidos → … → Orden de Pago Emitida → Enviado a Pago → Saldo Precio Pagado.', 'Post Venta'],
      ['Flujo Comisión', 'Secuencia de etapas (track COMISION): Comisión a Pagar → Cartola Emitida → Cartola Aprobada → Cartola Enviada → Factura Recibida → Orden de Pago Emitida → Enviado a Pago → Comisión Pagada.', 'Post Venta'],
      ['Factura Recibida (Comisión)', 'Etapa donde se captura la boleta/factura del dealer: RUT y nombre del dealer, fecha, N° de documento y monto neto. Botones "Boleta" y "Factura de terceros" para las excepciones (exigen certificación al grabar).', 'Post Venta'],
      ['Desglose Congelado', 'Al registrar la boleta/factura se guardan el % de impuesto, el monto del impuesto y el líquido a pagar. La Orden de Pago LEE esos valores y no recalcula, aunque luego cambie el % en el mantenedor Impuestos.', 'Post Venta'],
      ['Orden de Pago de Comisión', 'Documento "Solicitud de Pago" que agrupa en una sola orden las operaciones que comparten la misma boleta/factura del mismo dealer. Muestra por operación Monto Total, Retención/IVA y A Pagar, con el total sumado.', 'Post Venta'],
    ];
    let [[{ mx }]] = await pool.query('SELECT COALESCE(MAX(orden),0) AS mx FROM definiciones');
    let nuevas = 0;
    for (const [termino, definicion, categoria] of KB) {
      const [[ex]] = await pool.query('SELECT id FROM definiciones WHERE termino = ? LIMIT 1', [termino]);
      if (ex) continue;
      await pool.query('INSERT INTO definiciones (termino, definicion, categoria, orden) VALUES (?,?,?,?)',
        [termino, definicion, categoria, ++mx]);
      nuevas++;
    }
    if (nuevas) console.log(`✓ definiciones: base de conocimiento cargada (+${nuevas})`);
  } catch (e) { console.error('✗ definiciones KB:', e.message); }
})();

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM definiciones ORDER BY categoria, orden, termino');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const crear = async (req, res) => {
  try {
    const { termino, definicion, categoria } = req.body || {};
    if (!termino || !definicion) return res.status(400).json({ success: false, data: null, error: 'término y definición requeridos' });
    const [[{ mx }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS mx FROM definiciones');
    const [ins] = await pool.query('INSERT INTO definiciones (termino, definicion, categoria, orden) VALUES (?,?,?,?)',
      [termino, definicion, categoria || 'General', mx]);
    res.json({ success: true, data: { id: ins.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const actualizar = async (req, res) => {
  try {
    const { termino, definicion, categoria } = req.body || {};
    if (!termino || !definicion) return res.status(400).json({ success: false, data: null, error: 'término y definición requeridos' });
    await pool.query('UPDATE definiciones SET termino=?, definicion=?, categoria=? WHERE id=?',
      [termino, definicion, categoria || 'General', req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM definiciones WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, actualizar, eliminar };
