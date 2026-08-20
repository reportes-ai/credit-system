# -*- coding: utf-8 -*-
"""Parte IV: Post Venta — cartolas dealer y parque, incorporaciones, anulación, saldos, vendedores."""
from estilo import *

def agregar(doc):
    # ── Cap 12: cartola dealer ───────────────────────────────────────────────
    h1(doc, '12. La cartola del dealer: de la comisión a la orden de pago')
    p(doc, 'La cartola es el estado de cuenta mensual de comisiones del dealer: qué operaciones cursó, '
           'cuánta comisión le corresponde y contra qué factura se le paga. Es el circuito donde '
           'Operaciones y Post Venta le pagan al canal — con respaldo tributario y cuadratura exacta.')
    ficha(doc,
          'Post Venta / Operaciones (cartolas y cuadre) · el dealer (factura) · Tesorería (paga la ODP)',
          'Post Venta → Cartolas y Facturación · emisión de ODP',
          'Créditos otorgados con comisión calculada (la carta manda) · datos bancarios del dealer en su ficha',
          'Post Venta → Cartolas')
    h2(doc, '12.1 Paso a paso')
    paso(doc, 1, 'Generar la cartola', 'Se genera acumulativa por estado A PAGAR y se envía automática '
         'al dealer con copia al ejecutivo. Al enviarse estampa el Mes Cartola — ese sello define a qué '
         'mes pertenece la comisión, no la fecha del crédito.')
    captura(doc, 'Post Venta → Cartolas', 'Una cartola generada con sus movimientos A PAGAR y el botón de envío.')
    paso(doc, 2, 'Recibir y cuadrar la factura', 'El dealer factura el TOTAL de la cartola. El sistema '
         'la registra y cuadra contra la cartola: si no calza, queda en rojo y no avanza.')
    paso(doc, 3, 'Emitir y pagar la ODP', 'Se emite la orden de pago. Si el dealer tiene Plan Liquidez, '
         'el descuento va en la ODP — nunca en la cartola. Tesorería paga; quien emite no paga '
         '(segregación de funciones).')
    flujo(doc, 'A PAGAR → CARTOLA ENVIADA → FACTURA CUADRADA → ODP → PAGADA')
    h2(doc, '12.2 Reglas de dinero')
    regla(doc, 'La comisión calculada es BRUTA (IVA incluido) y se desagrega con el motor único de '
               'impuestos — nunca se le suma IVA encima. Con factura, la ODP paga el bruto (el IVA es '
               'crédito fiscal de AutoFácil). Con boleta de honorarios, el honorario bruto es el NETO de '
               'la factura equivalente y la ODP paga el líquido (honorario − retención); la retención '
               'queda como pasivo con el SII y se declara en el F29.')
    p(doc, 'Todo se contabiliza automático: devengo al registrar el documento y pago al marcar COMISIÓN '
           'PAGADA. El ingreso del negocio también: al solicitar la facturación en Facturación AutoFácil '
           'se devenga la comisión por cobrar (neto + IVA débito fiscal).')
    h2(doc, '12.3 Una cartola por RUT, no por nombre')
    caso(doc, 'El mismo RUT escrito de dos formas —"SOCIEDAD COMERCIAL ROJAS LIMITADA" y "… LTDA"— '
              'generaba dos cartolas separadas para el mismo dealer, con dos facturas y dos pagos. Por '
              'eso las operaciones se agrupan por el RUT del dealer y el nombre impreso sale de su ficha '
              '(una sola fuente). Solo cuando el movimiento no tiene RUT se agrupa por nombre.')
    h2(doc, '12.4 La regla de oro de las cartolas')
    regla(doc, 'Una operación cuya ETAPA sea distinta de OTORGADO —anulada, desistida, rechazada, '
               'digitada o inexistente— NO puede estar en una cartola. Basta que una de las tres '
               'columnas de etapa diga OTORGADO, pero ninguna puede decir anulado/desistido/rechazado, '
               'y la fecha de otorgamiento debe existir. El motor de sincronización lo exige en sus dos '
               'barreras.')
    caso(doc, 'Una auditoría encontró 8 movimientos por $2.776.900 esperando pago sobre negocios que '
              'nunca se cursaron. Ninguno alcanzó a enviarse. De ahí la regla de oro.')
    p(doc, 'Además, el motor genera UNA comisión por OPERACIÓN, no por carta: al generar una carta nueva '
           'para el mismo ID Financiera, las anteriores vivas se anulan solas y su comisión se retira de '
           'la cartola (salvo que ya se haya enviado al dealer, que se respeta y se regulariza aparte).')

    # ── Cap 13: cartola parque ──────────────────────────────────────────────
    h1(doc, '13. La cartola del parque')
    p(doc, 'Los parques automotrices siguen el mismo circuito del dealer, agregado por parque: comisión '
           'por cada crédito cursado en el parque más el arriendo mensual, en una cartola que se emite, '
           'se factura y se paga con ODP. La diferencia está en el universo de operaciones y en la '
           '"foto" que congela el documento.')
    ficha(doc,
          'Analista de Operaciones y Gerente de Op. y Crédito operan (cartola, ODP) · Tesorero y '
          'Gerente de Finanzas pagan',
          'Emisión, aprobación y pago separados (segregación)',
          'Ficha del parque vigente con contacto de finanzas · comisión de parque calculada por el motor · '
          'arriendo mensual configurado',
          'Post Venta → Emisión de Cartolas Parque · Comisiones Parques a Pagar')
    h2(doc, '13.1 Qué entra a la cartola del mes')
    regla(doc, 'A la cartola del mes T entran las operaciones OTORGADAS en T o antes (arrastre) cuya '
               'comisión aún no se cobró y cuyo saldo precio quedó al menos LIBERADO A PAGO al cierre '
               'de T. Una operación liberada tarde no se pierde: entra sola a la cartola del mes '
               'siguiente. El corte de partida del circuito es paramétrico.')
    advertencia(doc, 'El "al cierre de T" mira las etapas del track SALDO de Post Venta, no las fechas '
                     'de la ficha del crédito. Si una operación no aparece en la cartola del mes, lo '
                     'primero es revisar las fechas de sus etapas LIBERADO A PAGO en adelante.')
    h2(doc, '13.2 Paso a paso')
    paso(doc, 1, 'Aprobar el mes', 'Queda una FOTO por operación (qué cartola cobró qué operación). Esa '
         'foto es lo que se imprime, factura y paga: el documento no cambia aunque las etapas avancen '
         'después.')
    paso(doc, 2, 'Emitir la cartola', 'Lista las operaciones más la línea de arriendo. El arriendo es '
         'del PARQUE, no de un crédito: no aparece en el track por operación.')
    captura(doc, 'Post Venta → Emisión de Cartolas Parque', 'Una cartola de parque con sus operaciones, la línea de arriendo y el total.')
    paso(doc, 3, 'Aprobar la cartola (revisión conforme) y enviarla', 'El correo sale del servidor con '
         'la cartola en PDF adjunta al contacto de finanzas de la ficha del parque, con copia a '
         'operaciones@. El cuerpo resume comisión + arriendo + total a facturar.')
    paso(doc, 4, 'Registrar la factura del parque', 'El parque factura el TOTAL de la cartola. La '
         'cuadratura es estricta: si no calza, se rechaza mostrando la diferencia. Al cuadrar se marca '
         'FACTURA RECIBIDA en todas las operaciones.')
    paso(doc, 5, 'Emitir la ODP mensual y pagar', 'En Comisiones Parques a Pagar, solo con factura en '
         'todas las operaciones. La ODP nace de la factura, igual que en dealers. Al pagar, las '
         'operaciones quedan COMISIÓN PAGADA.')
    flujo(doc, 'APROBAR MES → EMITIR → APROBAR → ENVIAR → FACTURA → ODP → PAGADA')
    h2(doc, '13.3 Reversas y avisos')
    vineta(doc, 'quita CARTOLA ENVIADA y permite reenviar.', bold_hasta='Reversar el envío: ')
    vineta(doc, 'solo si no está pagada; el correlativo queda anulado y nunca se reutiliza.', bold_hasta='Anular la ODP: ')
    vineta(doc, 'la ODP vuelve a "por pagar".', bold_hasta='Revertir el pago: ')
    p(doc, 'Toda reversa exige motivo y queda en Auditoría. Cada asiento contable es idempotente por '
           'referencia: aprobar dos veces no duplica. Los avisos por correo (a Contabilidad al emitir '
           'la ODP; al parque y al equipo comercial al pagar) son paramétricos en Post Venta → '
           'Mantenedores: texto, destinatarios, copia e interruptor de cada uno.')
    regla(doc, 'ORDEN DE PAGO EMITIDA, ENVIADO A PAGO y COMISIÓN PAGADA se marcan solas desde el módulo '
               'de pago — nunca a mano en el Seguimiento. Las etapas de cartola las marca Emisión de '
               'Cartolas Parque.')

    # ── Cap 14: otorgadas sin carta ─────────────────────────────────────────
    h1(doc, '14. Incorporar a la cartola las otorgadas sin carta')
    p(doc, 'La cartola del dealer se construye desde las cartas de aprobación. Una operación que entró '
           'por carga masiva no genera carta, así que su comisión no aparecía en ninguna cartola: el '
           'dealer no la veía ni la facturaba. Este proceso las incorpora, confirmando a mano los datos '
           'que la carga no trae confiables.')
    ficha(doc,
          'Analista de Operaciones confirma e incorpora · Analista de Crédito aprueba las que quedan '
          'con excepción',
          'cartola_incorporar (incorporar) · cartola_incorp_aprobar (aprobar)',
          'Operación OTORGADA del mes, sin carta y sin movimiento en cartola · mantenedores de Dealers, '
          'Parques y Parámetros de Crédito al día',
          'Post Venta → Cartolas → botón "Otorgadas sin carta"')
    h2(doc, '14.1 Paso a paso')
    paso(doc, 1, 'Abrir la pantalla', 'El botón trae un contador de cuántas otorgadas sin carta hay en '
         'el mes seleccionado.')
    paso(doc, 2, 'Confirmar cada fila', 'Todo es editable: dealer (autocompletado contra los dealers '
         'del sistema — al elegirlo se traen su RUT y si es parque), ubicación, saldo precio, plazo y '
         'comisión.')
    captura(doc, 'Cartolas → Otorgadas sin carta', 'La grilla de confirmación con la columna "Corresponde" y una fila en ámbar por discrepancia parque/calle.')
    paso(doc, 3, 'Mirar la columna "Corresponde"', 'Es la comisión según el motor único (tabla pactada '
         'del dealer si la tiene; si no, la pizarra) para ese saldo, plazo y parque/calle. Se recalcula '
         'al vuelo al editar cualquier campo.')
    paso(doc, 4, 'Incorporar', 'Las filas cuya comisión calza con el motor entran directo a la cartola. '
         'Las que difieren quedan PENDIENTE y disparan campanita al analista de crédito.')
    paso(doc, 5, 'Aprobar o rechazar (sub-tab "Incorporaciones por aprobar")', 'El analista ve la '
         'diferencia en pesos y la excepción redactada, y resuelve con comentario obligatorio. Al '
         'aprobar, los valores quedan guardados en la operación y RECIÉN AHÍ se crea el movimiento de '
         'cartola.')
    flujo(doc, 'OTORGADA SIN CARTA → CONFIRMACIÓN → CALZA: A CARTOLA / DIFIERE: PENDIENTE → APROBADA / RECHAZADA')
    h2(doc, '14.2 De dónde sale cada dato')
    advertencia(doc, 'La carga masiva no trae confiable si el dealer es parque o calle: ese valor se '
                     'toma de la FICHA del dealer, que es un registro mantenido; el del crédito queda '
                     'de respaldo. Si discrepan, la fila se marca en ámbar indicando de dónde salió el '
                     'valor. Y el RUT del dealer es la llave con que el motor encuentra su tabla '
                     'pactada: escribir el nombre a mano dejaría el cálculo cayendo a la pizarra '
                     'equivocada — por eso el autocompletado es obligatorio en la práctica.')
    regla(doc, 'Quien solicita una incorporación no puede aprobársela, aunque tenga ambos permisos. El '
               'bloqueo está en el servidor y no depende de cómo estén configurados los perfiles.')
    caso(doc, 'Julio 2026 tenía 29 operaciones otorgadas fuera de la cartola por $13,5 MM de comisión, '
              'y junio arrastraba 58 por $25,1 MM — el quiebre empezó cuando la carga masiva pasó a ser '
              'la vía principal de ingreso. Con el motor calculando bien, 18 de las 29 calzaban y solo '
              '11 requerían aprobación. Pendiente conocido: dealers con la tabla de comisión vacía en '
              'su ficha caen a pizarra todos los meses; si hay porcentaje pactado, cargarlo en el '
              'mantenedor de Dealers evita la excepción recurrente.')

    # ── Cap 15: anulación ───────────────────────────────────────────────────
    h1(doc, '15. Anular una operación otorgada')
    p(doc, 'Anular deja sin efecto una operación ya cursada: el cliente desistió, la financiera reversó '
           'el curse, apareció un problema legal o un fraude. No es solo cambiar un estado — la '
           'operación arrastra comisión comprometida en la cartola, y si esa plata no se retira queda '
           'esperando pago sobre un negocio que no existe.')
    ficha(doc,
          'Analista de Operaciones solicita · aprueba o rechaza OTRO Analista de Operaciones o el '
          'Gerente de Operaciones y Crédito',
          'operacion_anular_solicitar · operacion_anular_aprobar',
          'Operación en etapa OTORGADO · el mes de la operación NO puede estar cerrado',
          'Créditos → Anular Operación')
    h2(doc, '15.1 Paso a paso')
    paso(doc, 1, 'Solicitar', 'Se busca por N° de operación, ID financiera o RUT del cliente, y se '
         'escribe el motivo (obligatorio). La solicitud queda PENDIENTE y dispara campanita al pool de '
         'Operaciones.')
    captura(doc, 'Créditos → Anular Operación', 'El formulario de solicitud con el motivo y la bandeja inferior de aprobación.')
    paso(doc, 2, 'Aprobar o rechazar', 'Otra persona revisa en la bandeja inferior de la misma '
         'pantalla. Al rechazar se exige motivo y la operación sigue vigente.')
    paso(doc, 3, 'Efectos de la aprobación (un solo acto)', 'El crédito pasa a ANULADO —con el motivo y '
         'la fecha en sus comentarios— y se retira su comisión de la cartola, guardando una foto del '
         'movimiento retirado para que sea reversible y auditable.')
    regla(doc, 'Si la cartola ya se envió al dealer, el movimiento NO se toca: el sistema lo informa en '
               'pantalla y en la campanita. El dealer ya la vio — corresponde regularizar como '
               'descuento, no borrar a espaldas suyas.')
    regla(doc, 'Quien solicita no puede aprobar, aunque tenga los dos permisos. El bloqueo es por '
               'usuario y está en el servidor.')
    caso(doc, 'Hasta julio 2026 anular era cambiar el estado a mano en la digitación: sin motivo, sin '
              'segunda firma y sin tocar la cartola. Una auditoría encontró 3 operaciones anuladas con '
              '$1.901.400 de comisión viva esperando pago. El estado ANULADO sigue existiendo en la '
              'digitación, pero la vía correcta es esta pantalla — la única que retira la plata.')
    flujo(doc, 'OTORGADA → ANULACIÓN SOLICITADA → ANULADA + COMISIÓN RETIRADA / RECHAZADA (SIGUE VIGENTE)')

    # ── Cap 16: saldos precio ───────────────────────────────────────────────
    h1(doc, '16. Pago de saldos precio')
    p(doc, 'El saldo precio es la plata del vehículo que la financiera transfiere y AutoFácil le entrega '
           'al dealer. Somos intermediarios: el monto pasa por nuestras cuentas pero no es ingreso ni '
           'gasto nuestro. Pagarlo a tiempo es el compromiso operacional más sensible con el canal.')
    ficha(doc,
          'Post Venta define fondos y nómina · Tesorería emite y paga',
          'Emisión y pago separados',
          'Fondos recibidos de la financiera (capítulo 8) · etapas de Saldo Precio al día',
          'Post Venta → Saldos Precio · Tesorería')
    h2(doc, '16.1 Paso a paso')
    paso(doc, 1, 'Definir fondos', 'Se registran los fondos recibidos de la financiera.')
    paso(doc, 2, 'Seleccionar saldos y generar la nómina', 'Las operaciones con fondos disponibles se '
         'agrupan en una nómina de pago.')
    paso(doc, 3, 'Emitir la orden de pago y pagar', 'Al pagarse, el informe de saldos pagados se envía '
         'solo a Operaciones y al ejecutivo de cada operación, y el correo "Pago de Saldo Precio" le '
         'llega al dealer.')
    flujo(doc, 'SALDO PENDIENTE → EN NÓMINA → ORDEN EMITIDA → PAGADO')
    p(doc, 'El dealer sigue este mismo proceso desde su portal: las 4 tarjetas del inicio son el '
           'pipeline (Fundantes pendientes → Fundantes recibidos → Liberado a pago → Saldo precio '
           'pagado) y cada operación muestra su saldo y su comisión con estado. Menos llamadas a '
           'preguntar "¿cuándo me pagan?".')
    h2(doc, '16.2 La card "Saldo Precio en Proceso de Pago" (Tesorería)')
    p(doc, 'La planilla que Tesorería llevaba a mano se reconstruye en vivo desde las etapas de Post '
           'Venta: recepción de fundantes (con AM/PM), vencimiento por SLA, N° de ODP, carga al banco y '
           'pago. El SLA es de 24/48/72 horas hábiles según la clasificación del dealer '
           '(SUPERPARTNER / PARTNER / SOCIO); una recepción PM cuenta desde el día hábil siguiente. '
           'Todo paramétrico.')
    vineta(doc, 'sale de la ODP (saldo + gastos) — por eso la planilla histórica mostraba $45.380 sobre el saldo puro. Sin ODP aún, se muestra el saldo marcado como preliminar.', bold_hasta='El monto a pagar: ')
    vineta(doc, 'las anuladas y desistidas se excluyen por el motor de etapa.', bold_hasta='Qué se excluye: ')
    vineta(doc, 'genera el archivo con el nombre que la otra aplicación exige (Saldo Precio en Proceso de Pago AAAAMMDD.xlsx). El "CARGADO" de la planilla es nuestra etapa ENVIADO A PAGO y su "CARGAR" es ORDEN DE PAGO EMITIDA.', bold_hasta='Exportar Excel: ')
    h2(doc, '16.3 La regla contable')
    regla(doc, 'El saldo precio es una CUENTA DE PASO. Al marcar FONDOS RECIBIDOS entra banco contra el '
               'pasivo transitorio; al marcar SALDO PRECIO PAGADO se rebaja contra banco. No toca el '
               'resultado: no infla ingresos ni gastos, y el saldo de la cuenta muestra cuánta plata de '
               'dealers hay en tránsito.')

    # ── Cap 17: vendedores ──────────────────────────────────────────────────
    h1(doc, '17. Vendedores del dealer: base, ventas y trazabilidad')
    p(doc, 'El vendedor del concesionario no es un dato decorativo: es con quien Comercial trabaja el '
           'día a día del dealer. Este circuito mantiene la base de vendedores, los enlaza a cada '
           'negocio y mide su aporte.')
    ficha(doc,
          'Quien mantiene dealers carga y corrige la base · el ejecutivo elige el vendedor al digitar '
          'la carta · Comercial y Operaciones consultan',
          'aprob_vendedores (mantener la base)',
          'Ficha del dealer vigente · el vendedor se elige en la carta de aprobación',
          'Mantenedor de Dealer → Vendedores por Dealer · Cartas → Detalle Mensual · Post Venta → '
          'Vendedores con Ventas')
    h2(doc, '17.1 Las tres pantallas')
    vineta(doc, 'nombre, RUT, correo y a qué dealer pertenece. Es la ÚNICA fuente del RUT y el correo — ni la carta ni el crédito los guardan, solo el nombre. Alimenta el selector de Vendedor del generador de cartas.', bold_hasta='Base única (Vendedores por Dealer): ')
    vineta(doc, 'mes a mes, cada carta con su N° OP, ID financiera, ejecutivo, cliente y el vendedor con RUT y correo. Buscador multi-variable y Excel.', bold_hasta='Detalle Mensual de Cartas: ')
    vineta(doc, 'agrupado por vendedor + dealer de las operaciones OTORGADAS, con cantidad y monto; al pinchar la fila se despliega el detalle. Abre por defecto en el último mes CERRADO — el mes en curso está incompleto y se leería como caída de ventas. Excel con dos hojas: resumen y detalle.', bold_hasta='Vendedores con Ventas: ')
    captura(doc, 'Post Venta → Vendedores con Ventas', 'El ranking de vendedores de un mes cerrado, con una fila desplegada.')
    h2(doc, '17.2 De dónde sale el nombre del vendedor')
    advertencia(doc, 'El vendedor sale de la CARTA de aprobación, que es donde el ejecutivo lo elige. '
                     'El campo vendedor del crédito NO sirve: la carga masiva escribe ahí a NUESTRO '
                     'ejecutivo ("VENDEDOR (AFA)…"), no al del dealer — solo se usa de respaldo cuando '
                     'no hay carta y el valor no es uno de esos placeholders. Y "S/I" es ausencia de '
                     'dato, no una venta directa: confundirlos hacía aparecer dealers reales como '
                     'ventas propias.')
    p(doc, 'El cruce con la base para traer RUT y correo se hace por nombre + RUT del dealer, con '
           'respaldo por nombre solo (un vendedor puede cambiarse de concesionario). Los datos '
           'faltantes se muestran en ámbar: el sistema no inventa el dato, lo muestra faltante.')
    flujo(doc, 'CARTA (ELIGE VENDEDOR) → OPERACIÓN OTORGADA → VENDEDOR CON VENTAS')


def anexos(doc):
    # ── Anexo A: permisos ───────────────────────────────────────────────────
    h1(doc, 'Anexo A. Permisos del área')
    p(doc, 'Los permisos se piden al Administrador, que los asigna por perfil en Usuarios → Perfiles. '
           'La tabla resume los códigos que aparecen en este manual:')
    tabla(doc, ('Proceso', 'Permiso', 'Qué habilita'),
          (('Otorgadas sin carta', 'cartola_incorporar', 'Confirmar e incorporar a la cartola'),
           ('Otorgadas sin carta', 'cartola_incorp_aprobar', 'Aprobar las incorporaciones con excepción'),
           ('Anulación', 'operacion_anular_solicitar', 'Solicitar la anulación'),
           ('Anulación', 'operacion_anular_aprobar', 'Aprobar o rechazar la solicitud'),
           ('Corrección de carta', 'aprob_corregir_carta', 'Emitir la carta -C1 de reemplazo'),
           ('Corrección de dealer', 'aprob_corregir_dealer', 'Corregir el dealer de una carta aprobada'),
           ('Vendedores', 'aprob_vendedores', 'Mantener la base Vendedores por Dealer')),
          (4.2, 5.0, 7.3))
    regla(doc, 'En anulaciones e incorporaciones, tener ambos permisos NO permite auto-aprobarse: la '
               'segregación de funciones es por usuario y está en el servidor.')

    # ── Anexo B: errores frecuentes ─────────────────────────────────────────
    h1(doc, 'Anexo B. Síntomas frecuentes y su causa')
    tabla(doc, ('Síntoma', 'Causa probable', 'Dónde se arregla'),
          (('Tras una carga aparecen muchas DIGITADAS de golpe', 'Un estado del archivo no está en Equivalencias Trinidad', 'Carga Masiva → Equivalencias'),
           ('El mismo ejecutivo figura escrito de dos formas', 'No está en la Equivalencia de Ejecutivos', 'Carga Masiva → Equivalencias'),
           ('Una operación otorgada no aparece en la cartola del dealer', 'Entró por carga masiva sin carta', 'Cartolas → Otorgadas sin carta (cap. 14)'),
           ('Una operación no aparece en la cartola del parque del mes', 'Su etapa LIBERADO A PAGO quedó fechada el mes siguiente', 'Revisar el track SALDO en Post Venta (cap. 13)'),
           ('El listado muestra una etapa y otra pantalla muestra otra', 'Etapa partida entre las tres columnas', 'Reportar a TI — NO editar a mano (cap. 2)'),
           ('La cuota digitada difiere de la calculada', 'Se calculó sobre saldo precio en vez del monto, o la financiera redondeó', 'Aviso al guardar; confirmar o corregir (cap. 5)'),
           ('La comisión del dealer no calza con el archivo del canal', 'La columna del canal no es nuestra comisión', 'No copiarla jamás (cap. 6)'),
           ('Recargar el archivo no corrigió un monto errado', 'El importador solo rellena vacíos', 'Corrección manual + recálculo (cap. 6)'),
           ('El dealer reclama dos cartolas separadas', 'Movimientos con el RUT en formatos distintos o sin RUT', 'Ficha del dealer; agrupación por RUT (cap. 12)'),
           ('Una carta no fue aprobada automáticamente', 'El Revisor derivó por diferencia, o el switch está apagado', 'Banner rojo en la revisión (cap. 9)')),
          (5.6, 5.8, 5.1))

    # ── Anexo C: glosario ───────────────────────────────────────────────────
    h1(doc, 'Anexo C. Glosario')
    tabla(doc, ('Término', 'Significado'),
          (('N° OP', 'Correlativo único AutoFácil (AAMM####), asignado al nacer la operación'),
           ('ID Financiera', 'Número de la operación en el sistema de la institución (AutoFin / UAC)'),
           ('Etapa', 'Punto del ciclo de vida: DIGITADO, APROBADO, OTORGADO, ANULADO, DESISTIDO…'),
           ('Estado de cartera', 'Cómo paga un crédito propio: VIGENTE, EN MORA, VENCIDO, PREPAGADO, CASTIGADO'),
           ('Carta de aprobación', 'Documento verificable (QR + firma electrónica) que compromete las condiciones al dealer'),
           ('Fundantes', 'Documentos que respaldan el curse para que la financiera libere los fondos'),
           ('Cartola', 'Estado de cuenta mensual de comisiones de un dealer o parque'),
           ('Mes Cartola', 'Mes que estampa el envío de la cartola; define a qué mes pertenece la comisión'),
           ('ODP', 'Orden de pago, con correlativo único global'),
           ('Pizarra', 'Tabla de comisión por defecto; rige cuando el dealer no tiene tabla pactada propia'),
           ('Tabla pactada', 'Comisión negociada con un dealer específico; manda sobre la pizarra'),
           ('Saldo precio', 'Plata del vehículo que la financiera transfiere y se entrega íntegra al dealer'),
           ('Foto (snapshot)', 'Valores congelados deliberadamente en un documento; no cambian aunque el origen avance'),
           ('Pool de analistas', 'Cola común de cartas pendientes de revisión'),
           ('Campanita', 'Aviso interno del sistema; sus destinatarios se configuran en Mantenedores → Avisos'),
           ('Mes cerrado', 'Mes con candado contable: sus operaciones no se editan'),
           ('Motor único', 'Cálculo que vive en un solo lugar y usan todas las pantallas — mismo valor en todas partes')),
          (4.3, 12.2))

    # ── Anexo D: capturas pendientes ────────────────────────────────────────
    h1(doc, 'Anexo D. Capturas pendientes de esta versión')
    p(doc, 'Los recuadros grises del manual marcan el lugar de cada pantallazo. Esta lista es la guía '
           'de la sesión de captura: recorrer las pantallas en este orden y reemplazar cada recuadro.')
    tabla(doc, ('N°', 'Pantalla', 'Qué debe mostrar'),
          tuple((str(n), pant, det) for n, pant, det in CAPTURAS),
          (1.2, 6.3, 9.0))
