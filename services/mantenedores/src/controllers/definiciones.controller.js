'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

// Glosario de definiciones de negocio usadas en el sistema (editable por el Admin).
require('../../../../shared/migrate').enFila('definiciones', async () => {
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
});

// Carga incremental de la base de conocimiento (idempotente: inserta solo los
// términos que aún no existen, por nombre). Concentra glosario + fórmulas por tema.
require('../../../../shared/migrate').enFila('definiciones', async () => {
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

      // ── Estados del Crédito (mantenedor Estado Créditos, ámbito brokerage) ──
      ['Estados del Crédito (Brokerage)', 'Máquina de estados paramétrica del crédito para operaciones brokerage (AutoFin y Unidad), administrada en el mantenedor Estado Créditos. Puertas de entrada: DIGITADO (por digitación o Carga Masiva) y CARTA DE APROBACIÓN (vía Cartas de Aprobación). Flujo: Digitado → Aprobado / Rechazado; Aprobado → Carta de Aprobación / Otorgado / Desistido; Rechazado → Apelado / Otorgado / Rechazado; Carta de Aprobación → Otorgado / Desistido; Otorgado → Prepagado / Anulado.', 'Estados del Crédito'],
      ['Estado: Digitado', 'Estado inicial cuando el crédito nace por digitación manual o por Carga Masiva. Desde Digitado el crédito pasa a Aprobado o Rechazado.', 'Estados del Crédito'],
      ['Estado: Aprobado', 'El crédito digitado fue aprobado en la evaluación. Puede pasar a Carta de Aprobación, Otorgado o Desistido.', 'Estados del Crédito'],
      ['Estado: Rechazado', 'El crédito digitado fue rechazado en la evaluación. Puede pasar a Apelado (si se apela), a Otorgado (si se revierte) o mantenerse Rechazado.', 'Estados del Crédito'],
      ['Estado: Apelado', 'Resultado de apelar un crédito rechazado. Estado final en la fase actual del flujo.', 'Estados del Crédito'],
      ['Estado: Carta de Aprobación', 'Estado inicial cuando el crédito ingresa vía Cartas de Aprobación (Unidad y AutoFácil). Pasa a Otorgado o Desistido.', 'Estados del Crédito'],
      ['Estado: Otorgado', 'El crédito fue cursado/otorgado. Posteriormente puede quedar Prepagado o Anulado.', 'Estados del Crédito'],
      ['Estado: Desistido', 'La operación se desiste antes de cursarse. Estado final.', 'Estados del Crédito'],
      ['Estado: Prepagado', 'Crédito otorgado que se paga anticipadamente en su totalidad. Estado final.', 'Estados del Crédito'],
      ['Estado: Anulado', 'Crédito otorgado que se anula. Estado final.', 'Estados del Crédito'],

      // ── Cálculos: campos calculados vs forzados ─────────────────────────
      ['Campo Calculado', 'Campo cuyo valor lo determina el sistema con una fórmula (no se digita): Ing x Colocaciones (monto_comision_fin), Comisión Dealer (comdea_real), Comisión Parque (com_parque), Arriendo Parque, Ingreso por Seguros e Ingreso Neto Total. Se recalculan en recalcular-mes.js a partir de parámetros (tasas, UF, % dealer/parque, tramos). En pantalla se muestran en AZUL.', 'Cálculos'],
      ['Campo Forzado', 'Campo que DEBERÍA ser calculado pero fue digitado manualmente, sobrescribiendo la fórmula. Ocurre por una negociación puntual que cambia las condiciones de esa operación. En pantalla se muestra en ROJO. Al recalcular, los campos forzados se RESPETAN (no se sobrescriben); solo se recalculan los no forzados de esa operación.', 'Cálculos'],
      ['Ingreso por Crédito (Colocaciones)', 'monto_comision_fin: utilidad por la colocación. Se calcula por valor presente del spread (tasa cliente − costo de fondo) sobre el monto capitalizado a lo largo del plazo, usando la tasa/TMC vigente y el tramo MENOR/MAYOR 200 UF de la fecha de otorgamiento.', 'Cálculos'],
      ['Ingreso por Seguros', 'Comisión que AutoFácil gana por los seguros intermediados (com_rdh + com_cesantia + com_reparaciones). Alimenta el Ingreso Neto Total. Si se digita a mano queda forzado (rojo).', 'Cálculos'],
      ['Recálculo (cuándo corre)', 'Los campos calculados se recalculan cuando cambia un parámetro que afecta el ingreso por crédito o por seguros (tasas, UF, % dealer/parque, tramos, o los datos de la operación). Si no cambia nada que afecte el cálculo, no se recalcula. En operaciones con campos forzados, el recálculo toca solo los campos no forzados.', 'Cálculos'],

      // ── Cartera y Cobranza: las dos dimensiones del crédito ─────────────
      ['Etapa (del crédito)', 'PRIMERA dimensión: en qué punto del proceso de originación está la operación (Digitado, Aprobado, Otorgado, Rechazado, Desistido, Anulado, etc.). En los créditos de cartera propia (AutoFácil) la Etapa se congela en OTORGADO y, desde ahí, manda el Estado de Cartera. Se administra en el mantenedor "Etapas y Estados".', 'Cartera y Cobranza'],
      ['Estado de Cartera', 'SEGUNDA dimensión, solo para créditos de recursos propios (AutoFácil): la situación de pago del crédito vivo. Arranca en VIGENTE al otorgar y lo mueve un motor según los días de atraso. Es distinto de la Etapa (originación): un crédito puede tener Etapa=Otorgado y Estado=Vencido.', 'Cartera y Cobranza'],
      ['Estado: Vigente / En Mora / Vencido', 'Estados automáticos de cartera según los días de atraso de la cuota impaga más antigua: VIGENTE (al día), EN MORA (≥ umbral de mora, típ. 1 día), VENCIDO (> umbral de vencido, típ. 90 días). Suben y bajan solos según el atraso real. Los umbrales son paramétricos (mantenedor Etapas y Estados → AutoFácil).', 'Cartera y Cobranza'],
      ['Estado: Terminado / Prepagado / Castigado', 'Cierres del crédito de cartera: TERMINADO (pagó todas las cuotas a plazo), PREPAGADO (pagó anticipadamente, saldo 0 antes del plazo) y CASTIGADO (incobrable, write-off — marca MANUAL; se sugiere desde ~180 días pero no es automático).', 'Cartera y Cobranza'],
      ['Saldo Insoluto', 'CAPITAL ADEUDADO: lo que falta amortizar del crédito según las cuotas efectivamente pagadas. Sistema francés: B_p = P·((1+i)^n − (1+i)^p) / ((1+i)^n − 1), con i = tasa mensual, n = plazo, p = cuotas pagadas. A medida que se pagan cuotas, baja. Distinto del Monto en Mora (solo las cuotas impagas).', 'Cartera y Cobranza'],
      ['Monto en Mora', 'Lo atrasado: suma de las cuotas impagas vencidas (cuotas en mora × valor cuota), más intereses por mora y gastos de cobranza al gestionarlas. NO es el capital total: para eso está el Saldo Insoluto.', 'Cartera y Cobranza'],
      ['Provisión de Cobranza', 'Estimación de pérdida esperada por morosidad. Se calcula como un porcentaje del SALDO INSOLUTO (capital adeudado), NO de las cuotas morosas, escalonado por tramo de días de atraso (ej.: 1-15d 1%, 16-30d 5%, 31-60d 20%, 61-90d 40%, 91+d 80%).', 'Cartera y Cobranza'],

      // ── Órdenes de Pago ─────────────────────────────────────────────────
      ['Orden de Pago (ODP) / N° ODP', 'Documento con que AutoFácil paga a un proveedor o a un dealer. Su número es el correlativo ÚNICO y global ODP260001 (ODP + año de 2 dígitos + correlativo de 4, reinicia en 0001 cada enero) y NUNCA se reutiliza: si una orden se anula, el número queda reservado y marcado como anulado con quién la anuló y cuándo. Lo comparten las tres clases de orden: Saldo Precio y Comisión (Post Venta) y las generales (Otros, a proveedores). NO confundir el N° ODP con el N° OP de Operación del crédito.', 'Órdenes de Pago'],
      ['Orden de Pago en Duro (inmutable)', 'Cuando una Orden de Pago se PAGA, su documento "Solicitud de Pago" se congela: se guarda una copia exacta (snapshot) y desde ese momento NO se vuelve a rearmar desde las bases de datos (dealer, comisión, factura, proveedor). Aunque después cambien esos datos, la orden pagada se mantiene idéntica a como se pagó. Una orden pagada NO se puede modificar ni anular: queda "en duro". Las órdenes aún no pagadas sí reflejan los datos en vivo (todavía no son definitivas).', 'Órdenes de Pago'],
      ['Pago de Orden de Pago (egreso de caja)', 'Una Orden de Pago se paga desde el Historial. Solo pueden pagar los usuarios con Caja Activa; el pago se registra como EGRESO y aparece en el Cierre de Caja, donde el Total recaudado = ingresos − egresos. Al pagar se cierra además la etapa correspondiente en Post Venta (Saldo Precio Pagado / Comisión Pagada) y la orden queda en duro. Solo el Administrador puede anular una orden, y solo mientras no esté pagada.', 'Órdenes de Pago'],

      // ── Comisiones de ejecutivo y seguros ───────────────────────────────
      ['NCNU', 'Universo sobre el que se mide el CRUCE DE SEGUROS del EJECUTIVO para su bono: operaciones AUTOFIN que NO son CORFO. Sobre ese conjunto se calcula qué % de clientes llevó cesantía y reparaciones.', 'Comisiones'],
      ['Cruce de Seguros (ejecutivo)', 'Indicador del bono del ejecutivo: % de su NCNU (AUTOFIN no-CORFO) que tomó cada seguro. Si supera el umbral configurado, suma un ajuste a su incentivo. NO aplica exclusiones de empresa/independiente: mide el cumplimiento del ejecutivo, NO lo que nos paga AutoFin. Es distinto de la Penetración de Seguros.', 'Comisiones'],
      ['Penetración de Seguros (mensual)', 'Por cada seguro y por mes: % de operaciones AUTOFIN con prima > 0 en ese seguro, sobre el universo que PODÍA tomarlo. Universo por seguro: RDH excluye EMPRESA; Cesantía excluye EMPRESA e INDEPENDIENTE; Reparaciones entran todas las AUTOFIN. Define el % de comisión que AutoFácil recibe por colocar seguros (a mayor penetración, mayor comisión que paga AutoFin). Distinta del Cruce del ejecutivo. La de independiente queda dormida hasta que se capture la ocupación del cliente AUTOFIN.', 'Comisiones'],
      ['RDH (Seguro RDH+E / Desgravamen)', 'Seguro que en el sistema agrupa Desgravamen + RDH (campo seguro_rdh, etiqueta "RDH+E"). Tiene su propia tabla de penetración. Su universo excluye a las EMPRESAS (no aplican desgravamen/cesantía).', 'Comisiones'],
      ['Cumplimiento de Comisión (ejecutivo)', 'Para ganar bono el ejecutivo primero pasa el PISO: total financiado de sus OTORGADOS del mes ≥ mínimo (comisiones_variables.minimo_monto). Cumplido el piso, el incentivo base (monto financiado × % por tramo de plazo) se ajusta con los indicadores de cruce de cesantía, reparaciones y calidad, cada uno solo si supera su umbral.', 'Comisiones'],
      ['Calidad (Meta UNIDAD)', 'Indicador del bono del ejecutivo: créditos UNIDAD colocados en el mes ÷ meta, con tope 100%. La meta es paramétrica (comisiones_variables.meta_unidad, por defecto 3) y pesa según comisiones_variables.peso_calidad.', 'Comisiones'],
      ['Tier UAC', 'Escalón de comisión de las operaciones UNIDAD (UAC) según cuántas se colocan en el mes: a más operaciones, mayor %. El REGISTRO de la operación se recalcula con el tier dinámico del mes (para proyectar el cierre y lo que se nos pagará). La CARTA de aprobación congela su propio snapshot del tier (cartas_aprobacion.tier_uac_*) para respaldar con qué rentabilidad se tomó la decisión: eso lo muestra el botón Rentabilidad de la carta.', 'Comisiones'],

      // ── Comisión dealer y parque ────────────────────────────────────────
      ['Comisión Dealer', 'Lo que AutoFácil paga al dealer (concesionario) por la operación. Se calcula con la TABLA INDIVIDUAL de cada dealer (su % pactado por plazo, para parque y/o calle; hay dealers con locales en ambos). Esa tabla manda en el cálculo de la comisión y de la rentabilidad. La carta debe respetarla.', 'Comisiones'],
      ['Pizarra de Comisiones', 'Valores DEFAULT de comisión dealer por plazo (parametros_credito: dealer_pct_* para parque, dealer_calle_pct_* para calle). Es la semilla que toma la ficha de un dealer NUEVO; si el dealer quiere un % distinto, debe solicitar la excepción respectiva en la cadena de aprobación de dealers. No es lo que se aplica si el dealer ya tiene su tabla pactada.', 'Comisiones'],
      ['Tabla del Dealer (parque/calle)', 'Las comisiones pactadas de cada dealer por tramo de plazo, en dos tablas: PARQUE (local dentro de un parque automotriz) y CALLE (local propio). Un dealer puede tener ambas si opera en los dos formatos. Es la fuente que manda para calcular comisión dealer y rentabilidad.', 'Comisiones'],
      ['Comisión Parque', 'Lo que se le paga al DUEÑO del parque automotriz (NO al dealer): un ARRIENDO fijo + un PORCENTAJE del saldo precio, paramétrico según el mantenedor de parques (parques_comisiones, por parque). Es independiente de la comisión del dealer.', 'Comisiones'],
      ['Cambio de Participación (excepción)', 'Pagar al dealer un % distinto al de su tabla pactada en una operación puntual (más o menos). Se activa explícitamente en la carta y la operación queda marcada como EXCEPCIÓN. Sin cambio de participación, rige la tabla del dealer.', 'Comisiones'],
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
});

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
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'definicion', entidad_id: ins.insertId, detalle: `Creó la definición "${termino}"`, meta: { termino, categoria } });
    res.json({ success: true, data: { id: ins.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const actualizar = async (req, res) => {
  try {
    const { termino, definicion, categoria } = req.body || {};
    if (!termino || !definicion) return res.status(400).json({ success: false, data: null, error: 'término y definición requeridos' });
    await pool.query('UPDATE definiciones SET termino=?, definicion=?, categoria=? WHERE id=?',
      [termino, definicion, categoria || 'General', req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'definicion', entidad_id: req.params.id, detalle: `Editó la definición #${req.params.id} ("${termino}")` });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM definiciones WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'definicion', entidad_id: req.params.id, detalle: `Eliminó la definición #${req.params.id}` });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, actualizar, eliminar };
