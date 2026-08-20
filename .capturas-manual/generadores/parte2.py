# -*- coding: utf-8 -*-
"""Parte II: ingreso de la producción — carga masiva, diferencias, digitación, Trinidad."""
from estilo import *

def agregar(doc):
    # ── Cap 3: carga masiva ──────────────────────────────────────────────────
    h1(doc, '3. Carga masiva de la producción')
    p(doc, 'La producción del brokerage entra al sistema por un archivo Excel que exporta el canal. La '
           'carga masiva lo valida, lo inserta sin duplicar y deja el rastro completo de qué entró y qué '
           'no. Es la puerta de entrada de la mayoría de las operaciones, así que un error acá se '
           'multiplica aguas abajo.')
    ficha(doc,
          'Analista de Operaciones',
          'Acceso al módulo Créditos → Carga Masiva',
          'Equivalencia de Ejecutivos al día · Equivalencias Trinidad con los estados del archivo',
          'Créditos → Carga Masiva')
    h2(doc, '3.1 Antes de cargar: las dos equivalencias')
    p(doc, 'Las dos equivalencias explican casi todas las sorpresas de una carga. Revisarlas toma un '
           'minuto y ahorra una tarde:')
    vineta(doc, 'traduce los estados del archivo del canal a nuestras etapas. Un estado que no esté mapeado entra como DIGITADO — si tras cargar aparecen muchas digitadas de golpe, ese es el motivo, no un problema del archivo.', bold_hasta='Equivalencias Trinidad: ')
    vineta(doc, 'traduce el nombre del ejecutivo tal como viene en el archivo al nombre oficial. Un ejecutivo no mapeado se guarda tal cual viene, y por eso el mismo vendedor puede figurar escrito de dos formas en los informes.', bold_hasta='Equivalencia de Ejecutivos: ')
    p(doc, 'Ambas se corrigen dentro del mismo módulo de Carga Masiva y la siguiente carga ya entra bien.')
    captura(doc, 'Créditos → Carga Masiva → Equivalencias', 'Las dos tablas de equivalencia, con un ejemplo de estado y de ejecutivo mapeados.')
    h2(doc, '3.2 Paso a paso')
    paso(doc, 1, 'Subir el archivo', 'Créditos → Carga Masiva → Cargar. Se arrastra o selecciona el '
         'Excel del canal. El sistema lee las filas y las presenta antes de insertar nada.')
    paso(doc, 2, 'Revisar el validador', 'El validador con IA marca anomalías ANTES de insertar: RUT '
         'mal formados, montos fuera de rango, dealers desconocidos, fechas imposibles. Cada anomalía '
         'se revisa en pantalla; se puede corregir el archivo y volver a subirlo, o confirmar si la '
         'observación no aplica.')
    captura(doc, 'Carga Masiva → validador', 'El informe de anomalías del validador con al menos una observación de ejemplo.')
    paso(doc, 3, 'Confirmar la carga', 'Recién al confirmar se insertan las filas. El log de la carga '
         'lista una a una: insertada, actualizada u omitida, con el motivo.')
    paso(doc, 4, 'Resolver las diferencias', 'Si el archivo trae valores distintos a los ya digitados en '
         'operaciones existentes, aparece el informe de Diferencias con la Carga (capítulo 4). Se '
         'resuelve en el momento o queda pendiente en su pantalla.')
    paso(doc, 5, 'Revisar la cola de faltantes', 'Las operaciones que entraron incompletas quedan en '
         'Digitación de Datos Faltantes (capítulo 5). El recálculo de comisiones corre solo.')
    h2(doc, '3.3 Reglas de la carga')
    vineta(doc, 'a cada ID de financiera nuevo se le asigna el correlativo AutoFácil (AAMM####) al momento de insertarlo; el número de la institución queda como ID Financiera. Las cargas siguientes reconocen la operación por ese ID, así que recargar el mismo archivo no duplica ni renumera.', bold_hasta='N° OP nuestro desde que nace: ')
    vineta(doc, 'rechazadas y desistidas entran igual, porque sirven para la estadística de conversión. La única excepción son las filas con fecha de otorgamiento o mes futuro, que se omiten y quedan listadas en el log como "⏭ Omitido".', bold_hasta='Se cargan todas las filas, no solo las otorgadas: ')
    vineta(doc, 'la carga nunca pisa los montos de una operación que ya existe: se digitaron y revisaron acá. Lo que sí hace es acusar la discrepancia (capítulo 4).', bold_hasta='Los montos digitados mandan: ')
    vineta(doc, 'cada carga queda en el Historial de Cargas y en Auditoría, con quién y cuándo.', bold_hasta='Todo queda registrado: ')
    advertencia(doc, 'Si la carta de una operación dice parque y el crédito quedó como calle (o al '
                     'revés), la pantalla lo muestra en ámbar y NO corrige sola: esa diferencia cambia '
                     'el tramo de comisión del dealer, así que la decide una persona.')
    flujo(doc, 'EXCEL → VALIDADO → INSERTADO → COLA FALTANTES → COMPLETO')
    p(doc, 'Afecta: dashboard, comisiones y todo lo aguas abajo de un crédito. Depende de: las dos '
           'equivalencias y los mantenedores de dealers y estados.')

    # ── Cap 4: diferencias con la carga ─────────────────────────────────────
    h1(doc, '4. Diferencias con la Carga')
    p(doc, 'La carga no pisa lo digitado, pero tampoco se calla la discrepancia. Cuando el archivo trae '
           'otro valor en un campo contrastado, el caso queda con los dos valores enfrentados y una '
           'persona decide. Esta pantalla es donde viven esos casos hasta que alguien los resuelve.')
    ficha(doc,
          'Analista de Operaciones',
          'Acceso a Carga Masiva',
          'Haber corrido una carga · mes de la operación abierto',
          'Créditos → Carga Masiva → Diferencias con la Carga')
    h2(doc, '4.1 Qué campos se contrastan')
    tabla(doc, ('Grupo', 'Campos'),
          (('Montos', 'Precio venta, pie, saldo precio, monto del pagaré'),
           ('Fechas', 'Fecha de otorgamiento'),
           ('Operación', 'Dealer, vendedor, producto'),
           ('Vehículo', 'Marca, modelo')),
          (3.5, 13.0))
    regla(doc, 'La comisión del dealer NO se contrasta: la columna "Comision Dealer" del export de '
               'Trinidad no es la nuestra (ver capítulo 6). Copiarla habría triplicado la deuda con los '
               'dealers.')
    h2(doc, '4.2 Cómo se resuelve cada caso')
    p(doc, 'El informe aparece al terminar la carga, agrupado por tipo y con la elección al costado de '
           'cada par. Para cada diferencia hay tres salidas:')
    vineta(doc, 'el valor digitado en el sistema se confirma y la diferencia se cierra.', bold_hasta='Dejar el nuestro: ')
    vineta(doc, 'el valor del Excel reemplaza al digitado. La cuota se recalcula sola con el motor único.', bold_hasta='Tomar el del archivo: ')
    vineta(doc, 'cuando ninguno de los dos calza con el pagaré — que es el documento que manda — se escribe el valor correcto a mano.', bold_hasta='Digitar un tercero: ')
    p(doc, 'Lo que no se elige en el momento queda pendiente en esta pantalla. Cada decisión queda con '
           'autor y fecha en el historial.')
    captura(doc, 'Carga Masiva → Diferencias con la Carga', 'Un par enfrentado (valor sistema vs valor archivo) con los tres botones de decisión.')
    h2(doc, '4.3 El período que se compara')
    p(doc, 'El contraste mira solo el período que se está cargando: el mes en curso y el anterior '
           '(parámetro configurable). Los meses ya cerrados están cuadrados y su ruido taparía los casos '
           'nuevos; se informan pero no se tocan. El informe declara siempre qué período comparó y '
           'cuántas operaciones quedaron fuera.')
    caso(doc, 'La OP 6251839 quedó con precio, pie, saldo y pagaré malos desde el alta, y veinte cargas '
              'después seguían igual: la diferencia no se mostraba en ninguna parte. De ahí nació esta '
              'pantalla.')

    # ── Cap 5: digitación de faltantes ──────────────────────────────────────
    h1(doc, '5. Digitación de Datos Faltantes')
    p(doc, 'Las operaciones que entran incompletas por la carga van a una cola común. Los digitadores '
           'las toman de a una, completan lo que falta y las devuelven completas al circuito. La cola '
           'evita que dos personas digiten la misma operación y deja claro qué falta en cada una.')
    ficha(doc,
          'Digitadores · Operaciones',
          'Acceso a Digitación de Datos Faltantes',
          'Operaciones cargadas con campos incompletos',
          'Créditos → Digitación de Datos Faltantes')
    h2(doc, '5.1 Paso a paso')
    paso(doc, 1, 'Tomar una operación', 'La cola muestra las pendientes; al abrir una queda bloqueada 20 '
         'minutos para ese usuario, así nadie más la toma mientras se digita. Los campos faltantes se '
         'ven en rojo.')
    captura(doc, 'Digitación de Datos Faltantes → cola', 'La cola con el contador de pendientes y una operación bloqueada.')
    paso(doc, 2, 'Revisar lo pre-llenado', 'Si existe una carta de aprobación con el mismo ID '
         'Financiera, sus datos de vehículo y venta llegan ya cargados y marcados "desde la carta": '
         'tipo, marca, modelo, año, patente, vendedor, RUT del dealer y parque/calle. Son editables — '
         'la carta sugiere, no manda, porque entre la carta y el curse el vehículo pudo cambiar. Solo se '
         'pre-llena lo vacío; nunca pisa un dato ya digitado. Si la carta no trae el ID Financiera '
         'grabado, el sistema la busca por el RUT del cliente antes de pedirle el dato a una persona.')
    paso(doc, 3, 'Completar y guardar', 'Se digita lo que falte según la cola (ver 5.2). Al guardar, el '
         'sistema valida la cuota (ver 5.3) y la operación sale de la cola.')
    h2(doc, '5.2 Qué se exige en cada cola')
    vineta(doc, 'todo lo que afecta ingresos — colocación, comisión, parque/calle, seguros y datos del vehículo.', bold_hasta='Cola de Otorgados: ')
    vineta(doc, 'solo el dealer. No se piden tasa, plazo ni RUT del dealer: en una operación que nunca se cursó ese dato no existe y no participa de ningún cálculo.', bold_hasta='Cola de Otros (rechazados, desistidos, no cursados): ')
    h2(doc, '5.3 La fecha de primera cuota y el aviso de cuota')
    regla(doc, 'La fecha de la primera cuota NUNCA se deriva del Informe Canal: su "Fecha Término" viene '
               'redondeada al 5 o al 10 y su "Fecha Curse" es la de generación del informe, no el curse '
               'real. El dato sale del cuadro de pago del PDF de la carta AutoFin (se lee solo al subir '
               'el documento, únicamente si el campo estaba vacío) o se digita del pagaré. Una fecha de '
               'primera cuota inventada corrompe el cálculo de la mora.')
    p(doc, 'Al guardar una operación —digitación, alta o edición— el sistema compara la cuota digitada '
           'con la cuota francesa calculada de su propio crédito (monto + tasa + plazo). Si difieren más '
           'que la tolerancia (2% por defecto, configurable), avisa mostrando ambos valores y pide '
           'confirmar. No bloquea, porque la financiera redondea.')
    caso(doc, 'En la OP 26080010 la cuota se calculó sobre el saldo precio en vez del monto del crédito '
              '($153.762 en lugar de $204.406) y se guardó sin que nadie lo notara. De ahí nació el aviso.')

    # ── Cap 6: cuadratura Trinidad ──────────────────────────────────────────
    h1(doc, '6. Cuadratura contra el Canal AutoFin (Trinidad)')
    p(doc, 'AutoFin exporta desde su sistema (Trinidad) el detalle de las operaciones cursadas en un '
           'período. Ese archivo es la fuente oficial de los MONTOS de la operación: si una operación se '
           're-evaluó o se digitó mal de nuestro lado, ahí se detecta. Un monto financiado inflado '
           'arrastra cuota, comisión del dealer, rentabilidad y cartola — la cuadratura evita pagar de más.')
    ficha(doc,
          'Analista de Operaciones detecta · quien tenga edición de créditos corrige',
          'Edición de créditos (mes abierto)',
          'Export de Trinidad (TRISolicitudWWExport-*.xlsx, filtro Fecha Curse + Estado CURSADO) · mes NO cerrado',
          'Excel del canal + Créditos')
    h2(doc, '6.1 Paso a paso')
    paso(doc, 1, 'Cruzar por ID', 'La columna ID del Excel es nuestro ID Financiera (NO el N° OP). El '
         'encabezado real del archivo está en la fila 4; las tres primeras son título del reporte.')
    paso(doc, 2, 'Comparar solo los montos', 'Saldo Precio contra saldo precio, Pie contra pie, Monto '
         'Pagare contra monto financiado. Diferencias de ±1 peso son redondeo, no errores: se filtra '
         'todo lo que esté bajo $1.000.')
    paso(doc, 3, 'Corregir y recalcular la cuota', 'Los montos se corrigen en la operación y la cuota se '
         'recalcula con el motor único (cuota francesa), nunca a mano.')
    paso(doc, 4, 'Recalcular el mes', 'La comisión del dealer y la rentabilidad se derivan del saldo '
         'precio: un monto corregido cambia lo que se le paga al dealer. Sin este paso el arreglo queda '
         'a medias.')
    regla(doc, 'La columna "Comision Dealer" del Excel NO es nuestra comisión. Es un valor por defecto '
               'del sistema de AutoFin y no corresponde a lo que ellos nos pagan (confirmado el '
               '30-07-2026). En la cuadratura de julio difería en las 57 operaciones, con una mediana de '
               '2,65 veces nuestro valor. La comisión del dealer la calcula SIEMPRE nuestro motor '
               '(tabla del dealer o pizarra), nunca el archivo del canal.')
    advertencia(doc, 'Volver a subir el archivo NO corrige una operación con monto errado: el importador '
                     'solo rellena campos vacíos, una guarda deliberada para que una carga no pise '
                     'montos ya liquidados. La corrección es siempre deliberada y acotada a las '
                     'operaciones detectadas.')
    caso(doc, 'De 57 operaciones cursadas en julio 2026, 3 tenían diferencias reales. La OP 89246 estaba '
              'inflada en $7,5 millones (financiado $19.939.048 en vez de $12.465.443) y su comisión de '
              'dealer, calculada sobre el saldo viejo, traía medio millón de más. Las otras 54 diferían '
              'en $1 por redondeo.')
    flujo(doc, 'EXPORT TRINIDAD → CRUCE POR ID FINANCIERA → DIFERENCIAS > $1.000 → CORRECCIÓN + CUOTA → RECÁLCULO DEL MES')
