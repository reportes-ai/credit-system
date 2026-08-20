# -*- coding: utf-8 -*-
"""Parte III: originación, curse y fundantes, revisor automático, excepciones."""
from estilo import *

def agregar(doc):
    # ── Cap 7: originación ───────────────────────────────────────────────────
    h1(doc, '7. Originación: de la cotización al otorgamiento')
    p(doc, 'La originación convierte un interesado en un crédito otorgado, con la financiera correcta y '
           'dentro de la política. La ejecuta principalmente el área comercial, pero Operaciones necesita '
           'dominarla porque todo lo que llega al área nace aquí — y varios pasos (revisión de cartas, '
           'corrección, otorgamiento) son suyos.')
    ficha(doc,
          'Ejecutivo comercial (cotiza y arma la carta) · Analista de Crédito (evalúa y aprueba) · el '
          'dealer o Facilito pueden originar la punta',
          'Según el paso: emisión, revisión (pool de analistas), corrección',
          'Dealer con ficha aprobada · cliente en la BD (o se crea) · tasas y parámetros vigentes · '
          'Preferencia Financiera configurada',
          'Cotizaciones · Evaluación Crediticia · Cartas de Aprobación · Cartas Vigentes')
    h2(doc, '7.1 Paso a paso')
    paso(doc, 1, 'Cotizar', 'En Cotizaciones, el Simulador Rápido, el portal del dealer o Facilito: '
         'precio, pie y plazo entregan la cuota con gastos, seguros y CAE. La cotización queda guardada '
         'al RUT del cliente.')
    paso(doc, 2, 'Evaluar', 'En Evaluación Crediticia: el RUT trae la ficha completa; si los '
         'antecedentes tienen más de 30 días se cargan nuevos. La IA cruza renta, informes DealerNet y '
         'política, y entrega el análisis para la decisión.')
    advertencia(doc, 'Un informe DealerNet con sello rojo "SIN INFORMACIÓN — Intente más tarde" llegó '
                     'vacío: NO significa sin deuda y no sirve para concluir. Tampoco ocupa el bloqueo '
                     'de 15 días — se puede volver a pedir de inmediato.')
    paso(doc, 3, 'Emitir la carta', 'En Cartas de Aprobación: la carta se autocompleta desde el PDF de '
         'la financiera. La Preferencia Financiera bloquea combinaciones fuera de política, y el módulo '
         'de Rentabilidad compara AutoFin contra UAC (permiso especial). La carta emitida pasa al pool '
         'de analistas — o al Revisor Automático si está encendido (capítulo 9).')
    captura(doc, 'Cartas de Aprobación → generador', 'El formulario de la carta con los datos autocompletados desde el PDF de la financiera.')
    paso(doc, 4, 'Otorgar o desistir', 'En Cartas Vigentes: la carta vive 5 días (configurable). '
         'Otorgarla crea el crédito en etapa OTORGADO con todo congelado — la comisión de la carta '
         'manda — y nace su movimiento de cartola. Si el negocio no se concreta, se desiste; si nadie '
         'hace nada, el desistimiento automático la vence al cumplirse el plazo.')
    captura(doc, 'Cartas Vigentes', 'La bandeja con una carta por vencer y los botones Otorgar / Desistir.')
    regla(doc, 'Al otorgar, TODO queda congelado: calendario de cuotas, tasa, comisión. Un crédito '
               'otorgado es inmutable — cualquier corrección posterior pasa por los procesos formales '
               '(corrección de carta, anulación), nunca por editar el crédito.')
    h2(doc, '7.2 La fecha de primera cuota')
    p(doc, 'Al subir el documento CARTA_AUTOFIN, el sistema lee el CUADRO DE PAGO del PDF y escribe la '
           'primera fecha de vencimiento en el crédito enlazado — solo si estaba vacía, nunca pisa lo '
           'digitado. Es el único origen automático del dato. Si la carta viene escaneada o sin cuadro '
           'legible, la operación cae a Digitación de Datos Faltantes para ingresarla del pagaré.')
    h2(doc, '7.3 Corregir una carta ya emitida')
    p(doc, 'Una carta emitida ya salió al dealer con su QR y su firma electrónica: no se edita. '
           'Corregirla emite una carta NUEVA con sufijo -C1, -C2…, y la anterior queda REEMPLAZADA con '
           'el mensaje "Reemplazada por la carta N° X". En la verificación pública, el QR y la firma de '
           'la vieja pasan a no vigentes con ese mismo texto.')
    vineta(doc, 'monto del crédito, saldo precio, tasa y cuotas. Definen la operación: si alguno cambia, ya no es la misma operación — se anula por el flujo de Operaciones y se emite una carta nueva. Además se valida que precio venta − pie siga dando el saldo.', bold_hasta='Qué NO se puede corregir: ')
    vineta(doc, 'la que aún no salió en cartola sigue a la carta nueva; una ya enviada al dealer es historia y no se toca.', bold_hasta='Qué pasa con la comisión: ')
    vineta(doc, 'quién, cuándo, qué campos y el motivo quedan auditados. El permiso es restringido (hoy solo Administrador). La carta debe estar APROBADA u OTORGADA — una pendiente o rechazada se corrige con el lápiz normal.', bold_hasta='Trazabilidad: ')
    h2(doc, '7.4 Corregir el dealer de una carta aprobada')
    p(doc, 'Caso típico: la carta manual dice que el concesionario es el parque y la carga trajo la '
           'automotora del local. El botón de corrección (permiso propio, motivo obligatorio) alcanza '
           'la carta, sus movimientos de cartola aún no enviados y el crédito — los tres a la vez, para '
           'que no queden dos verdades del mismo hecho. Meses cerrados no se tocan y todo queda auditado.')
    flujo(doc, 'COTIZACIÓN → EVALUACIÓN → CARTA APROBADA → OTORGADO / DESISTIDA')

    # ── Cap 8: curse y fundantes ────────────────────────────────────────────
    h1(doc, '8. Curse y fundantes')
    p(doc, 'Los fundantes son los documentos que respaldan la operación otorgada para que la financiera '
           'libere los fondos. Sin fundantes cerrados no hay plata: este proceso es la diferencia entre '
           'una venta en el papel y la plata en el banco.')
    ficha(doc,
          'Ejecutivo comercial (sube documentos) · Analista de Operaciones (valida)',
          'Seguimiento Fundantes, vistas Ejecutivo y Operaciones',
          'Crédito con etapa OTORGADO · matriz de documentos por financiera (mantenedor Tipos de Documento)',
          'Seguimiento Fundantes')
    advertencia(doc, 'La fecha de otorgamiento NO basta como filtro: viene poblada también en aprobadas '
                     'sin cursar, rechazadas y desistidas (3.161 aprobadas la tenían), que se colaban a '
                     'la cola pidiendo fundantes de un negocio que nunca existió. El filtro correcto es '
                     'la ETAPA.')
    h2(doc, '8.1 Paso a paso')
    paso(doc, 1, 'Subir (vista Ejecutivo)', 'Se suben los documentos que exige la matriz de la '
         'financiera. El sistema los renombra automático (tipo + operación). Al completar, botón Enviar.')
    captura(doc, 'Seguimiento Fundantes → Ejecutivo', 'La matriz de documentos de una operación con algunos subidos y el botón Enviar.')
    paso(doc, 2, 'Validar (vista Operaciones)', 'CERRADO aprueba. RECHAZADO exige comentario y avisa al '
         'ejecutivo para corregir y reenviar.')
    paso(doc, 3, 'Seguir los fondos', 'Cada etapa queda con fecha — alimenta el flujo de caja y marca '
         'sola la etapa FUNDANTES RECIBIDOS del Post Venta.')
    flujo(doc, 'RECIBIDOS → ENVIADOS → FONDOS LIBERADOS → FONDOS RECIBIDOS')
    h2(doc, '8.2 Devolución de la financiera')
    p(doc, 'Distinta del rechazo interno: la operación ya estaba cerrada y enviada, pero la financiera '
           'la devuelve (por ejemplo, un dato mal escrito en el contrato). Desde Historial de Fundantes, '
           'el botón Devolver (motivo obligatorio) la regresa a Fundantes Pendientes para que el mismo '
           'ejecutivo corrija y reenvíe por el flujo normal, con campanita a él y a Operaciones.')
    flujo(doc, 'CERRADO → financiera devuelve → POR CORREGIR → corrige y reenvía → ENVIADO → CERRADO')
    vineta(doc, 'la card muestra TODAS las operaciones devueltas alguna vez, con su estado ACTUAL (POR CORREGIR / ENVIADO / CERRADO). No salen de la lista al corregirse: la marca queda como historia. El filtro "Solo POR CORREGIR" viene marcado por defecto.', bold_hasta='Card Fundantes Devueltos: ')
    vineta(doc, 'al pinchar el N° de OP se abre la línea de tiempo con lo que el sistema registró solo (envío, aprobación, rechazo, devolución) más los comentarios de gestión que cualquiera puede agregar. Ahí se lee por qué se demoró cada operación.', bold_hasta='Bitácora por operación: ')
    h2(doc, '8.3 El pop-up de rendición semanal')
    p(doc, 'Al ejecutivo con fundantes PENDIENTES se le abre automáticamente un pop-up bloqueante con su '
           'operación pendiente más antigua: sin un comentario de mínimo 3 palabras no se cierra, y el '
           'comentario va a la bitácora de la operación. Sale una vez a la semana por operación; si hay '
           'más casos, el siguiente espera 2 horas. Solo lo ven usuarios con visibilidad acotada '
           '(ejecutivos), nunca Admin ni Gerencia. Todo es paramétrico en Mantenedores → Correos '
           'Programados: on/off, días, frecuencia, espera y mínimo de palabras.')

    # ── Cap 9: revisor automático ───────────────────────────────────────────
    h1(doc, '9. Revisor Automático de Cartas')
    p(doc, 'Business Suite revisa y aprueba sola las cartas que cuadran, y deriva al Analista de Crédito '
           'solo las que no. Reemplaza la pregunta rutinaria —¿el documento de la financiera dice lo '
           'mismo que se digitó?— por una validación de motor con respaldo firmado. El analista queda '
           'para los casos con diferencias, que es donde su criterio vale.')
    ficha(doc,
          'El ejecutivo digita y sube documentos (igual que siempre) · Business Suite revisa · el '
          'Analista de Crédito ve solo las derivadas · el Administrador enciende/apaga cada motor',
          'Interruptores en Mantenedores → Excepciones Comerciales → Revisor Automático',
          'Switch UNIDAD y switch AUTOFIN encendidos (independientes; parten apagados) · tolerancia en $ '
          'configurada · tasas y UF vigentes · tabla de comisión del dealer al día',
          'Transparente — actúa al subir los documentos de la carta')
    h2(doc, '9.1 Documentos que exige')
    vineta(doc, 'Carta Compromiso + Cotización (PDF). El servidor los lee al subirlos y guarda lo leído junto al documento; si el texto no deja leer las claves, la IA lo interpreta.', bold_hasta='UNIDAD: ')
    vineta(doc, 'Carta de Aprobación (PDF) + pantallazo del sistema AutoFin mostrando la solicitud puntual con su estado. El generador ofrece el botón "Capturar pantalla" (elige la ventana de AutoFin y toma el cuadro completo) o pegar con Ctrl+V. La IA lee ID y Estado del print al subirlo; si es un listado o no se ve el estado, avisa al ejecutivo al tiro.', bold_hasta='AUTOFIN: ')
    h2(doc, '9.2 Qué valida')
    tabla(doc, ('Validación', 'Detalle'),
          (('Documento vs sistema', 'ID financiera, RUT del cliente, saldo precio, plazo, monto bruto y tasa cursada — lo que dice el documento contra lo digitado (tolerancia en $ paramétrica)'),
           ('Tasa pizarra/cursada', 'Rebaja máxima paramétrica (5% relativo) sobre la pizarra del tramo; toda rebaja exige código de excepción'),
           ('Comisión dealer', 'Calle/parque y monto contra el motor único, bruta contra bruta. Solo una comisión MAYOR al motor exige código; la menor pasa sola porque es a favor de AutoFácil'),
           ('Código de excepción', 'Re-verifica el snapshot: nivel correcto de la escalera, estrellas cobradas, mínimo absoluto y financiera. Código de Gerencia vale por sí mismo'),
           ('Solo AUTOFIN', 'El pantallazo debe mostrar la solicitud en Revisión Firma o Cursado —ningún otro estado emite carta— y su ID debe calzar con la carta')),
          (4.2, 12.3))
    h2(doc, '9.3 Resultado')
    vineta(doc, 'carta APROBADA por "Business Suite (automática)" con un checklist firmado adjunto a sus documentos: cada validación con documento vs sistema, fecha y hora, timbre APROBACIÓN AUTOMÁTICA, firma electrónica simple y QR verificable con hash. Campanita al ejecutivo.', bold_hasta='Todo cuadra → ')
    vineta(doc, 'la carta queda PENDIENTE en la cola del analista como siempre, con un banner rojo en la revisión mostrando exactamente qué falló.', bold_hasta='Algo no cuadra (o el motor está apagado) → ')
    captura(doc, 'Aprobaciones → revisión de carta', 'El banner rojo de una carta derivada, con el detalle de la validación que no cuadró.')
    p(doc, 'La bitácora del revisor (card en el módulo de Aprobaciones) es un registro inmutable de cada '
           'revisión — aprobadas y derivadas, con el detalle íntegro, el código de excepción y los links '
           'al checklist y a su verificación. El motor solo agrega filas; nunca edita ni borra.')
    flujo(doc, 'CARTA PENDIENTE + DOCS → REVISOR (MOTOR) → APROBADA AUTO + CHECKLIST / DERIVADA AL ANALISTA → BITÁCORA (SIEMPRE)')

    # ── Cap 10: excepciones ─────────────────────────────────────────────────
    h1(doc, '10. Excepciones Comerciales: el código que aprueba la jugada')
    p(doc, 'El ejecutivo "juega" con un negocio (precio, pie, seguros, baja de tasa Unidad, baja de '
           'comisión dealer) en el Simulador de Excepciones y, si la combinación respeta el piso de '
           'rentabilidad, el sistema mismo le autoriza la excepción con un código único — sin mail al '
           'gerente para los casos normales. Operaciones necesita entender el mecanismo porque el código '
           'llega a la carta y el Revisor lo valida.')
    ficha(doc,
          'Ejecutivo Comercial y Supervisor simulan y generan códigos propios/comodín · el código de '
          'Gerencia lo genera solo el Gerente de Operaciones o su backup, con motivo obligatorio',
          'Acceso al simulador · el Validador lo consulta cualquiera con acceso',
          'Parámetros en Mantenedores → Excepciones Comerciales (piso 75%, rebaja máx. 5% relativo, '
          'estrellas, comodín, vigencia 24 h) · tasas y UF vigentes',
          '/excepciones/ · el simulador oficial vive en ¿Dónde Curso? 2.0')
    h2(doc, '10.1 La escalera de estrellas')
    tabla(doc, ('Nivel', 'Qué aprueba', 'Condición extra'),
          (('1 ⭐', 'Jugadas que rentan ≥ 75% de la mejor alternativa', '—'),
           ('2 ⭐', 'Hasta el 50% de la mejor alternativa', '—'),
           ('3 ⭐', 'Hasta el 25% de la mejor alternativa', 'Rentabilidad ≥ la comisión más alta (dealer o ejecutivo) y nunca bajo $200.000'),
           ('👔 Gerencia', 'Caso fuera de escalera', 'Motivo obligatorio; transferible entre ejecutivos')),
          (2.6, 7.4, 6.5))
    p(doc, 'Presupuesto de estrellas: 3 de regalo el primer mes; después, ⌊otorgadas del mes anterior × '
           '33%⌋. Las estrellas vuelven si el código vence sin usar (24 horas); al cierre del mes expiran. '
           'El nivel lo decide el SERVIDOR según la rentabilidad real de la jugada — declarar un nivel '
           'más barato por API no sirve: se cobran las estrellas del nivel real.')
    h2(doc, '10.2 Del código a la carta')
    p(doc, 'El código se ingresa en la Carta de Aprobación. El sistema valida saldo precio (con '
           'tolerancia), primeros dígitos del RUT, vigencia, y que la carta sea del ejecutivo dueño del '
           'código — un código propio no sirve en la carta de un colega; los de Gerencia sí son '
           'transferibles. La carta queda "aprobada por código del sistema". Un código = un solo uso, '
           'blindado incluso contra dos cartas guardadas en el mismo instante.')
    p(doc, 'Trazabilidad: pestañas "Mis códigos" (del ejecutivo) y "Registro completo" (Gerencia). El '
           'Validador dice de qué operación es cualquier código, quién lo generó y si ya se usó.')
    flujo(doc, 'SIMULAR → CUMPLE PISO → CÓDIGO (⭐/🏆/👔) → CARTA CON CÓDIGO → USADO (UN SOLO USO)')

    # ── Cap 11 + 12 breves ──────────────────────────────────────────────────
    h1(doc, '11. Regla del 60%: excepción por rechazo de la financiera')
    p(doc, 'Cuando una financiera rechaza, la operación puede cursarse en la otra en las mismas '
           'condiciones ofrecidas al cliente — sin renegociar — siempre que a AutoFácil le quede al '
           'menos el 60% del ingreso total. Vigente desde el 11-08-2026.')
    ficha(doc,
          'El Ejecutivo pide la excepción · el Jefe Comercial autoriza las condiciones por correo · el '
          'Analista de Crédito aprueba en el sistema (ese registro es el respaldo formal)',
          'Aprobación del analista dentro del horario de atención; fuera de horario autoriza el Jefe Comercial',
          'Operación rechazada por una financiera · Simulador de Rentabilidad con la comisión de dealer '
          'que se piensa ofrecer',
          'Simulador de Rentabilidad')
    regla(doc, 'Ingreso Total − Comisión Dealer − Comisión Parque − Comisión Ejecutivo ≥ 60% del '
               'Ingreso Total. Si no llega, se puede rebajar SOLO la comisión del dealer hasta '
               'alcanzarlo (parque y ejecutivo no se tocan). Bajo el 60% no se aprueba: no hay excepción '
               'de la excepción.')
    p(doc, 'El Simulador de Rentabilidad muestra la distribución porcentual del ingreso (AutoFácil · '
           'dealer · parque · ejecutivo) y permite editar la comisión del dealer para ver al instante si '
           'cumple.')
    flujo(doc, 'RECHAZADA EN UNA FINANCIERA → SIMULAR EN LA OTRA → ¿AUTOFÁCIL ≥ 60%? → EXCEPCIÓN APROBADA / NO SE APRUEBA')
