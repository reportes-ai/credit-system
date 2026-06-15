const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─── Templates HTML content ─────────────────────────────────────────────── */
const TEMPLATES = [
  {
    codigo: 'hoja_resumen',
    nombre: 'Hoja Resumen de Crédito',
    descripcion: 'Resumen ejecutivo del crédito con costos, seguros y condiciones',
    contenido: `<div class="doc-page">
<h1 class="doc-title">HOJA RESUMEN DE CRÉDITO N° {{NUM_OP}}</h1>
<p class="doc-subtitle">CAE: {{CAE}}</p>

<h3 class="sec-head">Titular</h3>
<table class="doc-table">
  <tr><td class="td-label">Nombre Titular</td><td>{{NOMBRE_COMPLETO}}</td></tr>
  <tr><td class="td-label">R.U.T</td><td>{{RUT_CLIENTE}}</td></tr>
  <tr><td class="td-label">Fecha</td><td>{{FECHA_HOY}}</td></tr>
  <tr><td class="td-label">Plazo vigencia cotización</td><td>{{FECHA_HOY}}</td></tr>
</table>

<h3 class="sec-head">Vehículo</h3>
<table class="doc-table">
  <tr><td class="td-label">Vehículo</td><td>{{TIPO_VEHICULO}}</td></tr>
  <tr><td class="td-label">Precio</td><td>{{PRECIO_VEHICULO}}</td></tr>
  <tr><td class="td-label">Pie</td><td>{{PIE}}</td></tr>
</table>

<h3 class="sec-head">Producto Principal — Crédito Automotriz AutoFácil Sin Aval</h3>
<table class="doc-table">
  <tr><td class="td-label">Saldo de Precio</td><td>{{SALDO_PRECIO}}</td></tr>
  <tr><td class="td-label">Tasa de Interés Mensual</td><td>{{TASA_MENSUAL}}</td></tr>
  <tr><td class="td-label">Plan de pago</td><td>{{PLAZO}} cuotas mensuales de {{CUOTA}}</td></tr>
  <tr><td class="td-label">Costo total del Crédito</td><td>{{COSTO_TOTAL}}</td></tr>
  <tr><td class="td-label">Carga Anual Equivalente (CAE)</td><td>{{CAE}}</td></tr>
</table>

<h3 class="sec-head">Gastos o Cargos Propios del Crédito</h3>
<table class="doc-table">
  <tr><td class="td-label">Impuesto de Timbre y Estampillas</td><td>{{GASTO_TIMBRE}}</td></tr>
  <tr><td class="td-label">Gastos Prenda</td><td>{{GASTO_PRENDA}}</td></tr>
  <tr><td class="td-label">Inscripción vehículo</td><td>{{GASTO_INSCRIPCION}}</td></tr>
  <tr><td class="td-label">Garantías Asociadas</td><td>Sí — Prenda sobre el vehículo</td></tr>
  <tr><td class="td-label">Gastos Administrativos</td><td>{{GASTO_ADMIN}}</td></tr>
  <tr><td class="td-label">Mantención GPS (rastreador)</td><td>{{GASTO_GPS}}</td></tr>
</table>

<h3 class="sec-head">Gastos por Productos o Servicios Voluntariamente Contratados</h3>
<table class="doc-table">
  <tr><td class="td-label" colspan="2"><strong>Seguro Desgravamen</strong></td></tr>
  <tr><td class="td-label">Costo Total (pesos)</td><td>{{COSTO_DESGRAVAMEN}}</td></tr>
  <tr><td class="td-label">Proveedor del servicio</td><td>BCI Seguros</td></tr>
  <tr><td class="td-label" colspan="2"><strong>Seguro de Cesantía</strong></td></tr>
  <tr><td class="td-label">Costo Total (pesos)</td><td>{{COSTO_CESANTIA}}</td></tr>
  <tr><td class="td-label">Proveedor del servicio</td><td>BCI Seguros</td></tr>
</table>

<h3 class="sec-head">Condiciones de Prepago</h3>
<table class="doc-table">
  <tr><td class="td-label">Cargo prepago</td><td>Un mes de interés calculado sobre el saldo de capital vigente</td></tr>
</table>

<h3 class="sec-head">Costos por Atraso</h3>
<table class="doc-table">
  <tr><td class="td-label">Interés Moratorio</td><td>Tasa interés máximo convencional vigente</td></tr>
  <tr><td class="td-label">Gastos de Cobranza</td><td>Vigente según normativa vigente</td></tr>
</table>

<div class="doc-important">
  <strong>Importante:</strong> El crédito Automotriz de que da cuenta esta Hoja de Resumen, requiere que el Consumidor contratante, {{NOMBRE_COMPLETO}}, acredite patrimonio o ingresos futuros suficientes para pagar su costo total de {{COSTO_TOTAL}}, cuya cuota mensual es de {{CUOTA}}, durante todo el período del crédito.
</div>

<div class="doc-firma-block">
  <div class="firma-line"></div>
  <p><strong>{{NOMBRE_COMPLETO}}</strong></p>
  <p><strong>RUT: {{RUT_CLIENTE}}</strong></p>
</div>
</div>`
  },
  {
    codigo: 'contrato',
    nombre: 'Contrato de Crédito Automotriz',
    descripcion: 'Contrato completo con 16 cláusulas y tabla de amortización',
    contenido: `<div class="doc-page">
<h1 class="doc-title">CONTRATO DE CRÉDITO AUTOMOTRIZ</h1>
<p class="doc-subtitle">N° de Operación/Pagaré: {{NUM_OP}}</p>
<p class="doc-subtitle">Costo Total del Crédito: {{COSTO_TOTAL}}</p>
<p class="doc-subtitle">Carga Anual Equivalente (CAE): {{CAE}}</p>

<p class="doc-intro">En Santiago, con fecha {{FECHA_HOY}}, entre <strong>AUTO FÁCIL SPA</strong>, sociedad dedicada al financiamiento automotriz, rol único tributario número 76.545.638-K, representado por los apoderados que suscriben, domiciliados en Isidora Goyenechea 3000 Piso 17 Of. 1701, Comuna de Las Condes, en adelante e indistintamente "AUTO FACIL" por una parte y por la otra el "Cliente" o "Deudor":</p>

<table class="doc-table">
  <tr><td class="td-label">Nombre completo</td><td>{{NOMBRE_COMPLETO}}</td></tr>
  <tr><td class="td-label">Cédula de identidad</td><td>{{RUT_CLIENTE}}</td></tr>
  <tr><td class="td-label">Domicilio</td><td>{{DOMICILIO}}</td></tr>
  <tr><td class="td-label">Correo electrónico</td><td>{{EMAIL}}</td></tr>
  <tr><td class="td-label">Teléfono</td><td>{{TELEFONO}}</td></tr>
</table>

<p class="doc-intro">se ha convenido el siguiente Crédito Automotriz (el "Crédito"):</p>

<p class="clause"><strong>PRIMERO: Antecedentes.</strong><br>
El Deudor ha solicitado a AUTO FÁCIL el otorgamiento de un crédito o mutuo de dinero, para el financiamiento de la compra del vehículo singularizado a continuación (en adelante el "Vehículo").</p>

<table class="doc-table">
  <tr><th colspan="2" class="th-sec">Datos del Vehículo</th></tr>
  <tr><td class="td-label">Marca</td><td>{{MARCA}}</td></tr>
  <tr><td class="td-label">Modelo</td><td>{{MODELO}}</td></tr>
  <tr><td class="td-label">Año</td><td>{{ANO}}</td></tr>
  <tr><td class="td-label">PPU / Patente</td><td>{{PATENTE}}</td></tr>
  <tr><td class="td-label">Tipo vehículo</td><td>{{TIPO_VEHICULO}}</td></tr>
  <tr><td class="td-label">Color</td><td>{{COLOR}}</td></tr>
  <tr><td class="td-label">N° de motor</td><td>{{MOTOR}}</td></tr>
  <tr><td class="td-label">N° Chasis / VIN</td><td>{{CHASIS}}</td></tr>
</table>

<p class="clause"><strong>SEGUNDO: Objeto del Contrato.</strong></p>

<p class="clause"><strong>2.1 Mutuo.</strong> Por el presente acto, AUTO FÁCIL entrega en mutuo al Deudor la cantidad total de pesos, para financiar la siguiente operación de compraventa de vehículo:</p>

<table class="doc-table">
  <tr><th colspan="2" class="th-sec">Precio del Vehículo</th></tr>
  <tr><td class="td-label">Precio total del Vehículo</td><td>{{PRECIO_VEHICULO}}</td></tr>
  <tr><td class="td-label">Pie</td><td>{{PIE}}</td></tr>
  <tr><td class="td-label"><strong>Saldo de Precio del Vehículo</strong></td><td><strong>{{SALDO_PRECIO}}</strong></td></tr>
  <tr><th colspan="2" class="th-sec">Seguros</th></tr>
  <tr><td class="td-label">Seguro Pérdida Total y Terceros</td><td>No Incluido</td></tr>
  <tr><td class="td-label">Seguro de desgravamen</td><td>{{COSTO_DESGRAVAMEN}}</td></tr>
  <tr><td class="td-label">Seguro de cesantía</td><td>{{COSTO_CESANTIA}}</td></tr>
  <tr><td class="td-label">Garantía Mecánica</td><td>No Incluida</td></tr>
  <tr><td class="td-label"><strong>Total Seguros</strong></td><td><strong>{{TOTAL_SEGUROS}}</strong></td></tr>
  <tr><th colspan="2" class="th-sec">Gastos Operacionales</th></tr>
  <tr><td class="td-label">Gastos Notariales, Prenda y Limitación</td><td>{{GASTO_PRENDA}}</td></tr>
  <tr><td class="td-label">Inscripción RVM / Transferencia</td><td>{{GASTO_INSCRIPCION}}</td></tr>
  <tr><td class="td-label">GPS</td><td>{{GASTO_GPS}}</td></tr>
  <tr><td class="td-label">Gastos de Administración</td><td>{{GASTO_ADMIN}}</td></tr>
  <tr><td class="td-label">Accesorios</td><td>$0</td></tr>
  <tr><td class="td-label"><strong>Total Gastos Operacionales</strong></td><td><strong>{{TOTAL_GASTOS}}</strong></td></tr>
  <tr><td class="td-label">Impuesto de Timbres y Estampillas (ITES)</td><td>{{GASTO_TIMBRE}}</td></tr>
  <tr><td class="td-label"><strong>TOTAL (Saldo Precio + Seguros + Gastos + ITES)</strong></td><td><strong>{{MONTO_FINANCIADO}}</strong></td></tr>
</table>

<p class="clause">El Deudor autoriza a AUTO FÁCIL para que, en su nombre y representación, pague directamente el saldo de precio del vehículo singularizado en la cláusula Primera precedente, al distribuidor, concesionario o vendedor, y para que, con cargo al crédito, pague cualquier otro gasto o efectúe cualquier otro desembolso relacionado a la operación descrita en la tabla 2.1.</p>

<p class="clause"><strong>2.2 Independencia del vendedor del Vehículo.</strong> Las partes dejan constancia que AUTO FÁCIL no está relacionada con el vendedor del vehículo. En consecuencia, no le es oponible a AUTO FÁCIL ninguna acción, excepción, defensa, obligación o derecho, de cualquier naturaleza que el Deudor tenga o pueda tener contra el vendedor del Vehículo.</p>

<p class="clause"><strong>2.3 Interés.</strong> La cantidad adeudada devengará un interés mensual del {{TASA_MENSUAL}}, interés que se pagará conjuntamente con el pago de cada una de las cuotas de capital. En caso de mora o simple retardo en el pago de la cantidad adeudada, o de sus intereses, el monto adeudado devengará el interés máximo convencional permitido para esta clase de operaciones, desde la fecha de la mora o simple retardo hasta la fecha de su pago efectivo.</p>

<p class="clause"><strong>2.4 Plazo y oportunidad de pago.</strong> El Deudor se obliga a pagar y restituir la cantidad recibida en cuotas. Los pagos deberán ser efectuados por el Deudor, sin necesidad de requerimiento alguno, en la fecha de vencimiento señalada en la Tabla de la sección 2.4. El pago se debe realizar según lo informado por Auto Fácil o bien lo que indique el cesionario.</p>

<p class="clause"><strong>2.5 Resumen, cuotas y calendario de pagos.</strong> En consecuencia, el Deudor se obliga al pago del monto adeudado y sus intereses, en las cuotas y fechas indicadas, a modo referencial, a continuación:</p>

<table class="doc-table">
  <tr><td class="td-label">Capital del Crédito (Monto a Financiar)</td><td>{{MONTO_FINANCIADO}}</td></tr>
  <tr><td class="td-label">Tasa de Interés Mensual</td><td>{{TASA_MENSUAL}}</td></tr>
  <tr><td class="td-label">Tasa Interés Moratorio</td><td>Interés Máximo Convencional</td></tr>
  <tr><td class="td-label">Número de cuotas</td><td>{{PLAZO}}</td></tr>
</table>

{{TABLA_AMORTIZACION}}

<p class="clause"><strong>2.6 Prelación.</strong> En caso de contradicción entre las disposiciones de la sección precedente, y cualquiera otra estipulación del presente Contrato, prevalecerán las de la sección 2.4.</p>

<p class="clause"><strong>2.7 Pagaré.</strong> Con esta misma fecha, el Deudor suscribe un pagaré que documenta las obligaciones contenidas en este Contrato (en adelante el "Pagaré"). En caso de contradicción entre las disposiciones de este Contrato y el Pagaré, prevalecerán las de este último.</p>

<p class="clause"><strong>2.8 Otras condiciones.</strong> Las demás condiciones del crédito se contienen asimismo en el Pagaré, esto es: A) Capitalización de intereses no pagados a su vencimiento; B) Fecha y lugar de pago; C) Indivisibilidad de las obligaciones; D) Pago Anticipado, entre otras.</p>

<p class="clause"><strong>2.9 Información de Contacto.</strong> El cliente se obliga a actualizar su información de contacto en caso que estos cambiaran a lo largo del contrato, como su dirección particular, correo electrónico y número telefónico.</p>

<p class="clause"><strong>TERCERO. Otras obligaciones del Deudor</strong></p>

<p class="clause"><strong>3.1 Prenda y prohibición.</strong> El Deudor deberá constituir una Prenda sobre el Vehículo adquirido, y para el cual ha obtenido el presente Crédito. Esta obligación es considerada una cláusula esencial del presente Contrato. Asimismo, el Deudor se obliga a no vender, ceder o enajenar a ningún título el Vehículo, y a constituir dicha prohibición anotada en el Registro Nacional de Vehículos Motorizados.</p>

<p class="clause"><strong>3.2 Compra inteligente.</strong> En caso de que el presente Crédito sea otorgado con la modalidad de financiamiento con el Producto Renovación, el deudor deberá suscribir una "Opción de venta sujeta a Condición", documento que se entenderá integrante al presente Contrato.</p>

<p class="clause"><strong>3.3 Permisos de circulación y otras exigencias.</strong> El Deudor se obliga a cumplir con todas las exigencias legales y reglamentarias necesarias para la circulación y mantención del vehículo, en especial el pago del permiso de circulación, del seguro obligatorio y revisión técnica.</p>

<p class="clause"><strong>3.4 Mantención del Vehículo.</strong> Asimismo, el Deudor declara conocer y aceptar que la mantención del vehículo es de su exclusivo cargo y costo.</p>

<p class="clause"><strong>3.5 Inspección del Vehículo.</strong> AUTO FÁCIL tendrá derecho a inspeccionar en cualquier momento el Vehículo por medio de las personas que designe para estos efectos.</p>

<p class="clause"><strong>CUARTO: Término Anticipado.</strong> En caso de término anticipado de todo o parte del crédito, el Deudor deberá dar un aviso previo de 3 días a la fecha de la propuesta para el referido pago anticipado. El Deudor siempre tendrá el derecho a pagar anticipadamente todo o parte del Crédito, pagando los intereses proyectados que se hayan devengado hasta la fecha en que se realice el prepago, así como la comisión de prepago, consistente en un mes de intereses pactados calculados sobre el capital que se prepaga.</p>

<p class="clause"><strong>QUINTO: Exigibilidad anticipada.</strong> Se considerará vencido el plazo de todas las obligaciones que el Deudor tenga con AUTO FÁCIL, pudiendo éste proceder al cobro total de lo adeudado y tomar posesión del bien dado en prenda para su realización en especie, en cualquiera de los siguientes casos: <strong>A)</strong> Una vez transcurridos sesenta días desde que el Deudor incurra en mora en el pago íntegro y oportuno de cualquiera de las cuotas indicadas en la Tabla de la sección 2.4 precedente y/o el Pagaré vinculado a este Contrato; <strong>B)</strong> Si el Deudor tiene la calidad de deudor en un procedimiento concursal de liquidación, o se encuentre en notoria insolvencia; <strong>C)</strong> Si se constituyere cualquier otro gravamen sobre el Vehículo, distinto de la prenda indicada en el numeral 3.1 anterior; <strong>D)</strong> Si el Vehículo se hubiese destruido o desaparecido en todo o parte o hubiere disminuido considerablemente su valor; <strong>E)</strong> Si el Deudor enajenare el Vehículo, sin previo consentimiento de AUTO FÁCIL; <strong>F)</strong> Si el Deudor impidiere o de cualquier otro modo obstaculizare la inspección del Vehículo por parte de AUTO FÁCIL; <strong>G)</strong> Si el Deudor y/o los demás obligados al pago hubieren suministrado datos maliciosamente falsos; <strong>H)</strong> Si el Deudor revoca el mandato otorgado a AUTO FÁCIL para efecto de constituir la prenda; e <strong>I)</strong> Si el Deudor incumple cualquiera de las obligaciones contenidas en el presente Contrato.</p>

<p class="clause"><strong>SEXTO: Costos por atraso.</strong></p>
<p class="clause"><strong>6.1. Interés Moratorio.</strong> En caso de mora o simple retardo en el pago de cualquiera de las cuotas conforme a la Tabla de la sección 2.4 anterior y al Pagaré, se devengará desde ese día y hasta el día de su completo y efectivo pago, el interés máximo convencional que corresponda según el monto y plazo original del Pagaré vigente a la fecha de su suscripción.</p>
<p class="clause"><strong>6.2. Gastos de Cobranza.</strong> Transcurridos 20 días desde la mora o simple retardo en el pago de cualquiera de las cuotas, serán de cargo del Deudor los gastos de cobranza: 9% respecto de deudas vencidas inferiores a 10 UF; 6% por la parte que exceda entre 10 UF y 50 UF; 3% por la parte que exceda sobre 50 UF.</p>

<p class="clause"><strong>SÉPTIMO: Costos del Crédito.</strong> Los costos asociados al Crédito son los indicados en la Tabla de la sección 2.1 de la cláusula Segunda.</p>

<p class="clause"><strong>OCTAVO: Tratamiento de Datos Personales.</strong> Por el presente, el Deudor declara que autoriza tanto a AUTO FÁCIL como a sus continuadores, cesionarios y sucesores legales, para proceder al tratamiento y todo tipo de uso respecto de la totalidad de sus datos personales, para fines relacionados con el proceso de otorgamiento, seguimiento, gestión y cobranza del Crédito contratado y mientras no se efectúe el pago completo del mismo y por ende, hasta su total extinción, junto con autorizar al acceso a su información, datos y antecedentes de carácter personal, protegidos por la ley N°19.628.</p>

<p class="clause"><strong>NOVENO: Codeudores Solidarios.</strong> Por este acto, los garantes individualizados al final de este documento (en adelante el "Garante" o los "Garantes"), se constituyen en Codeudores Solidarios del Deudor, para asegurar y garantizar el pago íntegro y oportuno de todas y cada una de las cantidades que el Deudor adeude a AUTO FÁCIL, emanadas del Contrato objeto del presente instrumento.</p>

<p class="clause"><strong>DÉCIMO: Mandato para Prenda.</strong> El(los) mandato(s) otorgado(s) por el Cliente, en instrumento aparte con esta misma fecha, tiene por objeto que se constituya prenda sin desplazamiento a favor de AUTO FÁCIL, para garantizar el cumplimiento de la obligación contenida en el Pagaré o cualquier otra presente o futura para con AUTO FÁCIL.</p>

<p class="clause"><strong>UNDÉCIMO: Contratación de PAC o PAT.</strong> En el caso de existir, el Cliente tendrá derecho a dejar sin efecto los mandatos para pago automático con cuenta corriente o tarjeta de crédito (PAC o PAT), siempre que se cumpla con la condición de solicitarlo por escrito, el que surtirá efecto en el mes subsiguiente.</p>

<p class="clause"><strong>DUODÉCIMO: Servicio al cliente.</strong> AUTO FÁCIL cuenta con un Servicio de Atención al Cliente, que recibe las consultas y reclamos de los consumidores. La forma de acceder a aquél es a través de una carta enviada por correo certificado dirigida a la dirección Isidora Goyenechea 3000 Piso 17 Of 1701, Comuna de Las Condes o por correo electrónico contacto@autofacilchile.cl.</p>

<p class="clause"><strong>DÉCIMO TERCERO: Nulidad parcial.</strong> Si cualquier cláusula del presente Contrato fuere declarada nula o inválida, por cualquier causa que fuere, ello no afectará al resto del Contrato, el que permanecerá vigente en todo aquello que no haya sido invalidado por sentencia judicial firme.</p>

<p class="clause"><strong>DÉCIMO CUARTO: Avisos y Comunicaciones.</strong> Las comunicaciones, avisos de vencimiento, promociones publicitarias, avisos y notificaciones, se enviarán al correo electrónico del Cliente indicado en la comparecencia u otro que posteriormente señale. Si el Cliente cambiare su domicilio o correo electrónico, ello solo será oponible a AUTO FÁCIL si el Cliente lo notifica por escrito al domicilio de AUTO FÁCIL o enviando aviso al correo electrónico contacto@autofacilchile.cl.</p>

<p class="clause"><strong>DÉCIMO QUINTO:</strong> El cliente autoriza a AUTO FÁCIL y a sus continuadores, cesionarios y sucesores legales, para que actuando individualmente uno cualquiera de ellos, en caso de simple retardo, mora o incumplimiento, sus datos personales y los demás derivados del presente contrato puedan ser ingresados, procesados, tratados y comunicados a cualquier tercero o base de datos de morosidad, incluyendo el Boletín Electrónico Dicom/Equifax, dando cumplimiento a la Ley N°19.628 y sus modificaciones.</p>

<p class="clause"><strong>DÉCIMO SEXTO: Domicilio y Competencia.</strong> Para todos los efectos legales, los comparecientes fijan domicilio en la ciudad de Santiago y se someten expresamente a la competencia de sus tribunales ordinarios de Justicia, o a los competentes del domicilio del Deudor Prendario, a elección de AUTO FÁCIL. El presente instrumento se extiende en dos ejemplares de idéntico tenor, quedando uno en poder de cada parte.</p>

<div class="doc-firmas-dos">
  <div class="firma-col">
    <div class="firma-line"></div>
    <p><strong>AUTO FÁCIL SPA</strong><br>RUT: 76.545.638-K<br>Por: Leonardo Sevilla Anda<br>Firma</p>
  </div>
  <div class="firma-col">
    <div class="firma-line"></div>
    <p><strong>{{NOMBRE_COMPLETO}}</strong><br>RUT: {{RUT_CLIENTE}}</p>
  </div>
</div>
</div>`
  },
  {
    codigo: 'pagare',
    nombre: 'Pagaré',
    descripcion: 'Pagaré con 7 cláusulas legales',
    contenido: `<div class="doc-page">
<h1 class="doc-title">PAGARÉ</h1>
<p class="doc-subtitle">N°: {{NUM_OP}}</p>

<p class="doc-intro">En Santiago de Chile a {{DIA}} de {{MES_NOMBRE}} de {{ANO_ACTUAL}}, <strong>{{NOMBRE_COMPLETO}}</strong>, cédula de identidad número {{RUT_CLIENTE}}, {{ESTADO_CIVIL}}, en adelante el "Deudor", debe y pagará incondicionalmente a la orden de <strong>AUTO FÁCIL SpA</strong>, R.U.T. 76.545.638-K, domiciliada en Isidora Goyenechea 3000, piso 17, oficina 1701, Las Condes, Santiago, Chile, en adelante denominada indistintamente el "Acreedor", la cantidad de <strong>{{MONTO_FINANCIADO}}</strong>, que devenga un interés mensual de <strong>{{TASA_MENSUAL}}</strong> y que se pagará en <strong>{{PLAZO}}</strong> cuotas mensuales, iguales y sucesivas de <strong>{{CUOTA}}</strong> con primer vencimiento el {{FECHA_PRIMERA_CUOTA}}.</p>

<p class="clause"><strong>PRIMERO:</strong> Los intereses se pagarán conjuntamente con el vencimiento de la cuota pactada. Los intereses que no se pagaren conjuntamente con el capital se capitalizarán conforme las normas legales pertinentes, sin perjuicio de la facultad de exigir de inmediato el total de la obligación que estuviere pendiente.</p>

<p class="clause"><strong>SEGUNDO:</strong> En caso que el deudor incurra en mora o simple retardo en el pago íntegro y oportuno de una o más cuotas indicadas precedentemente, el Acreedor tendrá derecho para exigir la totalidad de lo adeudado y sus intereses, considerándose ipso facto la obligación como de plazo vencido. Con todo, no habrá caducidad en caso de tener el Deudor calidad de deudor en un procedimiento concursal de reorganización o renegociación.</p>

<p class="clause"><strong>TERCERO:</strong> En caso de simple retardo y/o mora en el pago oportuno de la(s) cuota(s) y de los intereses que corresponden a la obligación, dará lugar a que se devengue desde el día de mora o simple retardo y hasta el de su completo y efectivo pago, el interés máximo convencional para operaciones de crédito de dinero en moneda nacional aplicable a operaciones reajustables o no reajustables según fuere el caso, que se devengará durante el tiempo de la mora o simple retardo hasta la fecha del pago efectivo, interés que se capitalizará mensualmente, devengando el importe capitalizado nuevamente el interés convencional máximo y así sucesivamente hasta que el pago efectivo se produzca, salvo en caso de aplicación del artículo 264, número 3 de la Ley 20.720.</p>

<p class="clause"><strong>CUARTO:</strong> El tenedor de este pagaré queda liberado de la obligación de protesto; sin embargo, si éste optara por efectuarlo, el Deudor se obliga a pagar los gastos e impuestos que dicha diligencia devengue.</p>

<p class="clause"><strong>QUINTO:</strong> Serán de cargo exclusivo del deudor los impuestos y demás gastos que pudieren afectar al presente Pagaré.</p>

<p class="clause"><strong>SEXTO:</strong> Las obligaciones derivadas del presente Pagaré tendrán el carácter de indivisibles, pudiendo el Acreedor cobrarlas íntegramente a cada uno de los herederos o sucesores a cualquier título, en los términos que establecen los artículos 1.526 N° 4, 1.528 y 1.531 del Código Civil.</p>

<p class="clause"><strong>SÉPTIMO:</strong> Para todos los efectos legales, judiciales y de eventual protesto de este Pagaré, el suscriptor fija su domicilio en la comuna y ciudad de Santiago, Región Metropolitana y se somete a la competencia de sus tribunales ordinarios de justicia, o a los competentes a su domicilio, a elección del Acreedor.</p>

<p style="text-align:right;margin-top:24px">Santiago, {{DIA}} de {{MES_NOMBRE}} de {{ANO_ACTUAL}}</p>

<div class="doc-firma-block">
  <div class="firma-line"></div>
  <p><strong>SUSCRIPTOR</strong></p>
  <p>Nombre: {{NOMBRE_COMPLETO}}</p>
  <p>R.U.T: {{RUT_CLIENTE}}</p>
  <p>Domicilio: {{DOMICILIO}}</p>
  <p>Firma: _______________________________</p>
</div>

<p class="doc-nota">Impuesto de Timbre y Estampillas que grava este documento se paga por ingresos mensuales de dinero en tesorería, según D.L. 3475 Art. 15 N°2.</p>
</div>`
  },
  {
    codigo: 'mandato_af',
    nombre: 'Mandato Especial — AUTO FÁCIL SpA',
    descripcion: 'Mandato especial para constituir prenda sin desplazamiento a favor de AUTO FÁCIL SpA',
    contenido: `<div class="doc-page">
<h1 class="doc-title">MANDATO ESPECIAL N° {{NUM_OP}}</h1>
<h2 class="doc-title" style="font-size:1rem">PARA CONSTITUIR PRENDA SIN DESPLAZAMIENTO DE LA LEY 20.190 Y PROHIBICIONES DE GRAVAR Y ENAJENAR</h2>
<p class="doc-subtitle">{{NOMBRE_COMPLETO}}</p>
<p class="doc-subtitle" style="font-size:1.1rem">A</p>
<p class="doc-subtitle">AUTO FACIL SpA</p>

<p class="doc-intro">A {{DIA}} de {{MES_NOMBRE}} de {{ANO_ACTUAL}}, comparece <strong>{{NOMBRE_COMPLETO}}</strong>, cédula nacional de identidad número {{RUT_CLIENTE}}, Nacionalidad {{NACIONALIDAD}}, Estado Civil {{ESTADO_CIVIL}}, con domicilio en {{DOMICILIO}}, en adelante el "Mandante", quien declara ser mayor de edad y expone lo siguiente:</p>

<p class="clause"><strong>PRIMERO:</strong> Que viene por este acto y por el presente instrumento, en conferir mandato especial e irrevocable de conformidad al artículo 241 del Código de Comercio, a Auto Fácil SpA., Rol Único Tributario N°76.545.638-K, en adelante la "Mandataria" y/o "Acreedor", para que actuando en su nombre y representación, por medio de sus propios representantes, constituya a su favor, sobre el vehículo que se singulariza más adelante, prenda sin desplazamiento, específica o con cláusula de garantía general, de conformidad con la Ley 20.190, para garantizar todas y cada una de las obligaciones actuales y/o futuras que el Mandante tenga o llegue a tener con la Mandataria. Asimismo, faculta a la Mandataria para constituir a su favor prohibiciones de gravar, enajenar y arrendar sobre el mismo vehículo; tramitar la documentación en el Registro de Prendas sin Desplazamiento y en el Registro Nacional de Vehículos Motorizados, ambos del Registro Civil e Identificación; y cobrar y percibir toda y cualquier devolución de dinero que se efectúe por parte de dichos Registros. Vehículo objeto de la prenda:</p>

<table class="doc-table">
  <tr><td class="td-label"><strong>TIPO</strong></td><td>{{TIPO_VEHICULO}}</td></tr>
  <tr><td class="td-label"><strong>MARCA</strong></td><td>{{MARCA}}</td></tr>
  <tr><td class="td-label"><strong>MODELO</strong></td><td>{{MODELO}}</td></tr>
  <tr><td class="td-label"><strong>COLOR</strong></td><td>{{COLOR}}</td></tr>
  <tr><td class="td-label"><strong>AÑO</strong></td><td>{{ANO}}</td></tr>
  <tr><td class="td-label"><strong>NÚMERO DE MOTOR</strong></td><td>{{MOTOR}}</td></tr>
  <tr><td class="td-label"><strong>NÚMERO DE CHASIS</strong></td><td>{{CHASIS}}</td></tr>
  <tr><td class="td-label"><strong>PLACA PATENTE</strong></td><td>{{PATENTE}}</td></tr>
</table>

<p class="clause"><strong>SEGUNDO:</strong> La Mandataria queda expresamente facultada para auto contratar, delegar el presente mandato y para estipular todas las cláusulas del contrato de prenda y sus modificaciones, anexos y complementos, sean de ellas de su esencia, naturaleza y/o meramente accidentales, tales como la individualización del constituyente, la singularización completa de la cosa prendada, la utilización y lugar en que ésta deberá mantenerse, las obligaciones que garantiza la prenda, el domicilio y jurisdicción, y en general, todas las demás estipulaciones que la Mandataria estime necesarias para el cabal cumplimiento de su mandato, así como para obtener la inscripción de la prenda en el Registro Nacional de Vehículos Motorizados y en el Registro de Prendas sin Desplazamiento conforme a la Ley 20.190.</p>

<p class="clause"><strong>TERCERO:</strong> El Mandante desde ya se obliga a asegurar la especie prendada por daños propios, robo, hurto, uso no autorizado, robo de accesorios, actos maliciosos, huelga y/o terrorismo, riesgos de la naturaleza y demás riesgos que la Mandataria exija, por una suma no inferior al valor comercial del vehículo prendado, mientras existan obligaciones pendientes con la Mandataria.</p>

<p class="clause"><strong>CUARTO:</strong> Declara el Mandante que la especie dada en prenda no está sujeta a gravamen o prohibición alguna, que no se encuentra dada en arrendamiento y que tiene la posesión material de ella.</p>

<p class="clause"><strong>QUINTO:</strong> Asimismo, el Mandante acepta que se considerará vencido el plazo de todas las obligaciones que tenga para con la Mandataria, operando al efecto la caducidad del plazo, pudiendo la Mandataria proceder al cobro total de lo adeudado y a tomar posesión del bien entregado en prenda para su realización en especie, en los siguientes casos: 1. Si el constituyente y/o el deudor han solicitado ante la Superintendencia de Insolvencia y Reemprendimiento la aplicación del procedimiento concursal de reorganización o se haya presentado solicitud de liquidación forzosa; 2. Si existiere otro gravamen cualquiera sobre la especie entregada en prenda o si perdiere el dominio de éste por cualquier causa; 3. Si la especie entregada en prenda se hubiera destruido o desaparecido, en todo o parte, o hubiere disminuido considerablemente su valor; y 4. Si el constituyente enajenara la especie entregada en prenda.</p>

<p class="clause"><strong>SEXTO:</strong> Este mandato no es remunerado. El Mandante podrá solicitar a la Mandataria rendición de cuenta respecto a la realización de la gestión encomendada, según lo prescrito por el artículo 16 del decreto ley N°43.</p>

<p class="clause"><strong>SÉPTIMO:</strong> El Mandante faculta a la Mandataria para subsanar tanto los errores de copia, de referencia o de cálculo numérico, como las omisiones que se hubieren cometido en la suscripción del presente contrato de mandato. También, la faculta para aclarar o complementar cualquier punto obscuro o dudoso que esté presente en alguna de las cláusulas de este contrato, y que dificulte la ejecución del mandato. Asimismo, la mandataria queda autorizada para protocolizar el presente instrumento.</p>

<p class="clause"><strong>OCTAVO:</strong> Este mandato no libera al Mandante de su obligación de constituir la prenda y prohibiciones sobre el vehículo singularizado precedentemente. No obstante el mandato que da cuenta el presente instrumento, el Mandatario podrá requerir al Mandante concurra personalmente a constituir la prenda y prohibiciones sobre el vehículo singularizado más arriba, en cualquier momento.</p>

<p class="clause"><strong>NOVENO:</strong> La revocación del mandato que da cuenta el presente instrumento, no tendrá efecto alguno en tanto la mandataria no lo haya ejecutado. Será condición para la revocación del mandato que el Mandante haya dado cabal e íntegro cumplimiento a las obligaciones que mantenga vigentes con el Mandatario. Asimismo, este mandato no se extinguirá con la muerte del Mandante, pues está igualmente destinado a ejecutarse aun ocurrida dicha circunstancia.</p>

<p class="clause"><strong>DÉCIMO:</strong> La Mandataria queda facultada para aceptar, en representación del Mandante y en los términos del artículo 1902 del Código Civil, cualquier cesión de crédito que realice Auto Fácil SpA, a cualquier título que ésta se haga, respecto de créditos que el Mandante tenga actualmente o en el futuro a favor de Auto Fácil SpA. Se incluye la facultad de aceptar la cesión de las garantías que caucionan los créditos que sean cedidos.</p>

<p class="clause"><strong>DÉCIMO PRIMERO:</strong> El Mandante autoriza a Auto Fácil SpA. para que, en caso de retardo, mora o incumplimiento de cualquier obligación contraída para con ella, proceda al tratamiento de sus datos personales en la forma prevista en la ley e ingresarlos a cualquier base de datos o sistema de información comercial de morosidad y protestos.</p>

<p class="clause"><strong>DÉCIMO SEGUNDO:</strong> La Mandataria estará expresamente facultada para ejecutar el mandato que da cuenta el presente instrumento por sí o por terceros especialmente designados al efecto, encontrándose en consecuencia expresamente facultada para delegarlo.</p>

<p class="clause"><strong>DÉCIMO TERCERO:</strong> Para los efectos del presente mandato, se entenderá cumplida la obligación de la Mandataria de rendir cuenta al Mandante, por el hecho de remitir a este último, dentro de los plazos establecidos en la ley, una copia del instrumento que da cuenta de la constitución de la prenda sobre el vehículo a favor de Auto Fácil SpA al correo electrónico señalado por el Mandante o a su domicilio indicado en la comparecencia.</p>

<p class="clause"><strong>DÉCIMO CUARTO:</strong> El Mandante y la Mandataria declaran que el presente mandato no constituye compromiso de ninguna especie por parte de Auto Fácil SpA, ni constituirá la constitución de la prenda. Los gastos, derechos e impuestos que se originen con motivo de la suscripción del presente contrato, como asimismo, las inscripciones, anotaciones, de la escritura que dé cuenta de la prenda serán de cargo del Mandante.</p>

<p class="clause"><strong>DÉCIMO QUINTO:</strong> Para los efectos del presente mandato, se entenderá cumplida la obligación de la Mandante por el solo hecho de remitir el mandante, dentro de los plazos establecidos en la ley, una copia del instrumento que dé cuenta de la constitución de la prenda sobre el vehículo a favor de Auto Fácil SpA al correo electrónico o al domicilio del mandante indicado en la comparecencia.</p>

<div class="doc-firma-block">
  <div class="firma-line"></div>
  <p><strong>FIRMA MANDANTE</strong></p>
  <p>{{NOMBRE_COMPLETO}}</p>
  <p>RUT: {{RUT_CLIENTE}}</p>
</div>
</div>`
  },
  {
    codigo: 'mandato_ga',
    nombre: 'Mandato Especial — GESTIONES AUTOMOTRICES SPA',
    descripcion: 'Mandato para constituir prenda a favor de GESTIONES AUTOMOTRICES SPA (Art. 14 Ley 20.190)',
    contenido: `<div class="doc-page">
<h1 class="doc-title">MANDATO ESPECIAL PARA CONSTITUIR PRENDA SIN DESPLAZAMIENTO</h1>
<h2 class="doc-title" style="font-size:1rem">ARTÍCULO 14 DE LA LEY 20.190</h2>
<p class="doc-subtitle">{{NOMBRE_COMPLETO}}</p>
<p class="doc-subtitle" style="font-size:1.1rem">A</p>
<p class="doc-subtitle">GESTIONES AUTOMOTRICES SPA</p>

<p class="doc-intro">En Santiago de Chile, a {{DIA}} de {{MES_NOMBRE}} de {{ANO_ACTUAL}}, comparece <strong>{{NOMBRE_COMPLETO}}</strong>, cédula de identidad número {{RUT_CLIENTE}}, domiciliado para estos efectos en {{DOMICILIO}}, en adelante e indistintamente el "Mandante"; el compareciente quien acredita su identidad con la cédula antes mencionada, y expone:</p>

<p class="clause"><strong>PRIMERO:</strong> {{NOMBRE_COMPLETO}} es dueño del siguiente vehículo (en adelante el "Vehículo"):</p>

<table class="doc-table">
  <tr><td class="td-label">Tipo</td><td>{{TIPO_VEHICULO}}</td></tr>
  <tr><td class="td-label">Marca</td><td>{{MARCA}}</td></tr>
  <tr><td class="td-label">Modelo</td><td>{{MODELO}}</td></tr>
  <tr><td class="td-label">Color</td><td>{{COLOR}}</td></tr>
  <tr><td class="td-label">Año</td><td>{{ANO}}</td></tr>
  <tr><td class="td-label">NÚMERO DE MOTOR</td><td>{{MOTOR}}</td></tr>
  <tr><td class="td-label">NÚMERO DE CHASIS</td><td>{{CHASIS}}</td></tr>
  <tr><td class="td-label">PPU / Patente</td><td>{{PATENTE}}</td></tr>
</table>

<p class="clause"><strong>SEGUNDO:</strong> Que por el presente instrumento otorga mandato especial, conforme con el artículo 241 del Código de Comercio, a <strong>GESTIONES AUTOMOTRICES SPA</strong> rol único tributario número 76.602.837-3, con domicilio en Renato Sánchez 3481, comuna de Las Condes, ciudad de Santiago, en adelante e indistintamente la "Mandataria" para que actuando por medio de cualquiera de sus representantes, en su nombre y representación constituya, sobre el automóvil singularizado en la cláusula anterior, prenda sin desplazamiento conforme al artículo 14 de la Ley 20.190 y a su respectivo reglamento, y prohibición de gravar y enajenar a favor de Auto Fácil SpA.</p>

<p class="clause"><strong>TERCERO:</strong> La Mandataria queda expresamente facultada para estipular todas las cláusulas del contrato de prenda y sus modificaciones, anexos y complementarios posteriores, sean de su esencia, naturaleza y/o meramente accidentales, tales como la identidad del constituyente, la individualización completa de la cosa prendada, la suma a la que se limitare la garantía prendaria, la utilización y lugar en que esta deberá mantenerse, las obligaciones que garantiza la prenda, su inspección, responsabilidad de custodia y conservación, domicilio y competencia, y en general, todas las demás estipulaciones que la Mandataria estime necesarias para el cabal cumplimiento de su mandato, así como para requerir u obtener la inscripción en el Registro de Prenda sin Desplazamiento o cualquier otro registro, pudiendo ejecutar los actos, celebrar todas las convenciones y otorgar los instrumentos públicos y privados que sean conducentes a la constitución de la prenda y la prohibición de gravar y enajenar descritas. Sin perjuicio de lo anterior, el Mandante declara desde ya su conformidad con los términos del contrato de Prenda cuyo modelo se anexa a este instrumento.</p>

<p class="clause"><strong>CUARTO:</strong> Asimismo, la Mandataria estará facultada para otorgar y suscribir las minutas o los instrumentos públicos o privados que eventualmente fuesen necesarios para aclarar o complementar los puntos oscuros o dudosos, salvar omisiones y rectificar o enmendar los errores de copia, de referencia o de cálculos numéricos que aparezcan de manifiesto en el instrumento constitutivo o inscripción, en relación, por ejemplo, con el crédito, con la correcta individualización del vehículo, ya sea de su motor, chasis, placa patente única u otro dato identificatorio, como la correcta individualización de los comparecientes o cualquier otro antecedente solicitado por el Registro Nacional de Vehículos Motorizados, Registro de Prenda sin Desplazamiento u otro del Servicio de Registro Civil e Identificación para inscribir adecuadamente la prenda y la prohibición.</p>

<p class="clause"><strong>QUINTO:</strong> Declara el Mandante que la especie dada en prenda no está sujeta a gravamen o prohibición alguna, que no se encuentra dada en arrendamiento y que tiene la posesión material de ella.</p>

<p class="clause"><strong>SEXTO:</strong> Este mandato no es remunerado. El Mandante faculta expresamente a la Mandataria para protocolizar y/o reducir a escritura pública el presente instrumento.</p>

<p class="clause"><strong>SÉPTIMO:</strong> Se entenderá como suficiente rendición de cuenta, el informar al Mandante por escrito su cumplimiento y enviar copia de la escritura de prenda suscrita en su representación y de sus modificaciones posteriores si las hubiere, o certificado de anotaciones en que conste la prenda, a través del medio físico o tecnológico que el Mandante hubiere elegido.</p>

<div class="doc-firma-block">
  <div class="firma-line"></div>
  <p><strong>FIRMA MANDANTE</strong></p>
  <p>{{NOMBRE_COMPLETO}}</p>
  <p>RUT: {{RUT_CLIENTE}}</p>
  <p>Domicilio: {{DOMICILIO}}</p>
</div>
</div>`
  }
];

/* ─── Ensure table + seed ────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plantillas_documento (
        id_plantilla  INT AUTO_INCREMENT PRIMARY KEY,
        codigo        VARCHAR(60)  NOT NULL UNIQUE,
        nombre        VARCHAR(200) NOT NULL,
        descripcion   VARCHAR(500) NULL,
        contenido     LONGTEXT     NOT NULL,
        activo        TINYINT(1)   DEFAULT 1,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Seed defaults if table is empty
    const [cnt] = await pool.query('SELECT COUNT(*) as n FROM plantillas_documento');
    if (cnt[0].n === 0) {
      for (const t of TEMPLATES) {
        await pool.query(
          'INSERT INTO plantillas_documento (codigo, nombre, descripcion, contenido) VALUES (?,?,?,?)',
          [t.codigo, t.nombre, t.descripcion, t.contenido]
        );
      }
    }
  } catch (e) {
    if (e.errno !== 1050) console.error('[plantillas migration]', e.message);
  }
})();

/* ─── Controllers ────────────────────────────────────────────────────────── */
const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id_plantilla, codigo, nombre, descripcion, activo, updated_at FROM plantillas_documento ORDER BY id_plantilla'
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getByCodigo = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM plantillas_documento WHERE codigo = ?', [req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ success: false, data: null, error: 'Plantilla no encontrada' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const update = async (req, res) => {
  try {
    const { nombre, descripcion, contenido, activo } = req.body;
    if (!contenido) return res.status(400).json({ success: false, data: null, error: 'contenido es requerido' });
    await pool.query(
      'UPDATE plantillas_documento SET nombre=?, descripcion=?, contenido=?, activo=? WHERE codigo=?',
      [nombre, descripcion || null, contenido, activo !== false ? 1 : 0, req.params.codigo]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'plantilla', entidad_id: req.params.codigo, detalle: `Editó la plantilla de documento "${req.params.codigo}"` });
    res.json({ success: true, data: { codigo: req.params.codigo }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const resetDefault = async (req, res) => {
  try {
    const tpl = TEMPLATES.find(t => t.codigo === req.params.codigo);
    if (!tpl) return res.status(404).json({ success: false, data: null, error: 'Plantilla no encontrada' });
    await pool.query(
      'UPDATE plantillas_documento SET nombre=?, descripcion=?, contenido=? WHERE codigo=?',
      [tpl.nombre, tpl.descripcion, tpl.contenido, tpl.codigo]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'plantilla', entidad_id: tpl.codigo, detalle: `Restauró la plantilla "${tpl.codigo}" a su versión por defecto` });
    res.json({ success: true, data: { codigo: tpl.codigo }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getAll, getByCodigo, update, resetDefault };
