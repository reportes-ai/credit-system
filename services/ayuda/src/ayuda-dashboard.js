'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   AYUDA DEL DASHBOARD — una entrada por pestaña (Pato, 25-09-2026).

   El botón "?" del dashboard mostraba el mismo texto genérico en todas las
   pestañas ("Tablero de indicadores… filtra por período… revisa el
   presupuesto"), escrito cuando el dashboard tenía tres. Hoy tiene veinte, y
   cada una responde una pregunta distinta.

   · Clave: '/dashboard/<id de la vista>/' — la misma que usa showV() en
     dashboard/app.js, que llama a afAyudaSet() al cambiar de pestaña.
   · Fuente: el Glosario del dashboard (/dashboard/glosario/) y los cuadros
     reales de cada pestaña. Las DEFINICIONES viven en el Glosario; acá se
     explica para qué sirve cada pantalla y cómo se lee. Si una definición
     cambia, cambia allá: esto la cita, no la redefine.
   · Convergencia: se escribe en cada arranque sobre las filas con
     origen='SISTEMA'. Cuando el Administrador edita una ayuda en el
     mantenedor, la fila pasa a origen='USUARIO' y el código deja de pisarla
     (mismo patrón que el banco Dónde·Cómo·Quién).
   · Cada entrada es también un curso de la Academia: por eso los títulos
     empiezan con "Dashboard ·" y quedan agrupados en el catálogo.
   ───────────────────────────────────────────────────────────────────────────── */

const PERIODO = { titulo: 'Elige el período', detalle: 'Arriba, Desde y Hasta, y Aplicar. Todas las pestañas agrupan por MES CONTABLE de la operación, no por el día exacto del curse: una operación cursada el 30-06 con mes contable julio cuenta en julio.' };

module.exports = [
  {
    ruta: '/dashboard/', titulo: 'Dashboard', icono: 'bi-bar-chart-line',
    descripcion: 'El tablero comercial del negocio, calculado en vivo desde la base: cuánto se ingresó, se aprobó y se cursó, con qué financiera, dealer y ejecutivo, cuánto se ganó y cómo va el mes contra el presupuesto. Cada pestaña mira el mismo universo desde un ángulo distinto, y esta ayuda cambia según la pestaña en que estés.',
    pasos: [
      PERIODO,
      { titulo: 'Elige la pestaña según la pregunta', detalle: 'Otorgados = la venta. Aprobados = el pipeline por rematar. Rentabilidades = lo que se gana. Proyección Pro = dónde cierra el mes. Ejecutivos y Funnel = la gestión de cada persona.' },
      { titulo: 'Si dos cuadros no cuadran', detalle: 'Revisa las 4 reglas base del Glosario: ¿mismo período?, ¿misma definición de aprobada?, ¿mes contable o fecha de curse? Si con eso no cuadra, es un error: repórtalo, no ajustes el número a mano.' },
    ],
    submodulos: [
      { nombre: 'Venta', para_que: 'Otorgados, Aprobados, Funnel, Prospección, Ejecutivos y Comparativo.' },
      { nombre: 'Resultado', para_que: 'Rentabilidades, Rent. x Ejec., P&L Operativo y Seguros.' },
      { nombre: 'Tiempo y meta', para_que: 'Tendencia, Historia, Evolución, Presupuesto y Proyección Pro.' },
      { nombre: 'Red comercial', para_que: 'Dealers, Parques y Saldo Precio.' },
      { nombre: 'Resumen y Glosario', para_que: 'El cockpit del mes en una pantalla, y la definición de cada variable.' },
    ],
    siguiente: 'Antes de sacar conclusiones de un número, míralo en el Glosario (última pestaña): qué es, cómo se calcula, qué incluye y qué no.',
  },

  {
    ruta: '/dashboard/resumen/', titulo: 'Dashboard · Resumen Ejecutivo', icono: 'bi-lightning-charge-fill',
    descripcion: 'El cockpit del mes en una sola pantalla, pensado para mirarlo en un minuto: otorgadas, monto financiado, ingreso neto operacional y ticket promedio, el avance contra el presupuesto, la carrera del mes día a día y los rankings. Usa la misma fuente que el Dashboard.',
    pasos: [
      { titulo: 'Lee los KPIs contra el mes anterior', detalle: 'Cada KPI se compara con el mes anterior a IGUAL DÍA, no con el mes completo: así el día 10 no se ve "peor" solo porque el mes pasado ya terminó.' },
      { titulo: 'Mira el presupuesto', detalle: 'El medidor muestra el real, la proyección al ritmo actual (tono claro) y la brecha que falta (rojo). "A este ritmo el mes cierra en…" es un ritmo, no una promesa.' },
      { titulo: 'Sigue la carrera del mes', detalle: 'La curva acumulada compara el mes en curso contra el mes anterior (gris, recorrido completo) y contra el ritmo que exige el presupuesto. El pulso diario marca el real y la meta de cada día.' },
    ],
    submodulos: [
      { nombre: 'Presupuesto · Pulso diario', para_que: 'Avance contra la meta y el ritmo requerido por día.' },
      { nombre: 'La carrera del mes', para_que: 'Acumulado día a día contra el mes anterior y el ritmo del presupuesto.' },
      { nombre: 'Mes contra mes · Año contra año', para_que: 'Si el mes viene mejor o peor que el anterior y que el mismo mes del año pasado.' },
      { nombre: 'Embudo del mes · Mix por institución', para_que: 'Ingresadas → aprobadas → otorgadas, y el reparto AutoFin / Unidad.' },
      { nombre: 'Podios y Salón de récords', para_que: 'Mejores ejecutivos y dealers del mes, y los récords históricos (avisa si el mes va camino a superarlos).' },
    ],
    siguiente: 'Para el detalle de cualquier número, vuelve al Dashboard completo. La meta mensual se edita en Mantenedores → Presupuesto.',
  },

  {
    ruta: '/dashboard/glosario/', titulo: 'Dashboard · Glosario', icono: 'bi-book',
    descripcion: 'La definición única de cada variable y de cada cuadro del Dashboard: qué es, cómo se calcula, qué incluye, qué no incluye y para qué sirve. Es la referencia cuando dos números "de lo mismo" no coinciden.',
    pasos: [
      { titulo: 'Lee primero las 4 reglas base', detalle: 'Mes contable, qué es aprobada, qué es otorgada y qué pasa con una anulada. Casi todas las diferencias entre pantallas se explican con ellas.' },
      { titulo: 'Busca la variable', detalle: 'Ingresadas, Aprobadas, Otorgadas, TA, TC, Monto Financiado, Saldo Precio, Com. Dealer, Ing. x Colocaciones, Ing. x Seguros, 200 UF.' },
      { titulo: 'Busca el cuadro', detalle: 'Cada pestaña con su universo: qué operaciones considera y cuáles deja fuera.' },
    ],
    submodulos: [],
    siguiente: 'Si con las reglas base dos cuadros siguen sin cuadrar, es un error del sistema: repórtalo en vez de corregir el número a mano.',
  },

  {
    ruta: '/dashboard/v1b/', titulo: 'Dashboard · Otorgados', icono: 'bi-check2-square',
    descripcion: 'La foto de la VENTA: solo las operaciones que se cursaron de verdad en el período (la financiera giró la plata). Cuánto se colocó, con qué financiera, cuánto le toca al dealer y cuánto ingresa AutoFácil por colocación y por seguros.',
    pasos: [
      PERIODO,
      { titulo: 'Lee los KPIs de arriba', detalle: 'Monto financiado, operaciones otorgadas (con "ver detalle" operación por operación), comisión dealer, ingreso por colocaciones e ingreso por seguros.' },
      { titulo: 'Compara contra el mes anterior a igual día', detalle: '"Mismos días faltantes" muestra el mes pasado cortado en el mismo punto del mes: es la comparación justa mientras el mes no termina.' },
      { titulo: 'Baja al detalle', detalle: 'Rankings de dealers, ejecutivos y jefes comerciales. La camarita copia la tabla lista para WhatsApp y el detalle se exporta a Excel.' },
    ],
    submodulos: [
      { nombre: 'Financieras — Solo Otorgados', para_que: 'Ops, monto, promedio, saldo precio, comisión dealer e ingresos por AutoFin y Unidad.' },
      { nombre: 'Mismos días faltantes — Mes anterior', para_que: 'El mes pasado cortado al mismo día: comparación a igual avance.' },
      { nombre: 'Composición 200 UF · Plazo y monto promedio · Ing. AFA', para_que: 'Mezcla de la cartera por tramo, plazo, ticket e ingreso por financiera.' },
      { nombre: 'Resumen Mes Anterior — Otorgados', para_que: 'El cierre del mes pasado de punta a cabo, hasta el Ingreso Neto AutoFácil.' },
      { nombre: 'Dealers, Ejecutivos y Jefes Comerciales', para_que: 'Quién trae y quién cursa la venta. Un jefe que también coloca cuenta bajo su propio nombre.' },
      { nombre: 'Estado Comercial · Evolución', para_que: 'En qué quedó lo ingresado y la serie de otorgadas en el tiempo.' },
    ],
    siguiente: 'Para ver cuánto de esta venta es ganancia, ve a Rentabilidades. Para saber si el mes llega a la meta, a Proyección Pro.',
  },

  {
    ruta: '/dashboard/v1/', titulo: 'Dashboard · Aprobados', icono: 'bi-clipboard-data',
    descripcion: 'El pipeline: todo lo que la financiera APROBÓ en el período, se haya cursado o no. Lo aprobado y no otorgado es venta potencial que hay que rematar antes de que el cliente compre con otro.',
    pasos: [
      PERIODO,
      { titulo: 'Recuerda qué cuenta como aprobada', detalle: 'Solo estado APROBADO, OTORGADO o CURSADO. Una pendiente o "en evaluación" NO es aprobada. Por eso Aprobadas es siempre mayor o igual que Otorgadas.' },
      { titulo: 'Busca lo que falta rematar', detalle: 'En Motivo, "CONFIRMACIÓN CLIENTE" son aprobadas esperando al cliente: esa es la lista de trabajo comercial.' },
    ],
    submodulos: [
      { nombre: 'Financieras', para_que: 'Las aprobadas repartidas entre AutoFin y Unidad.' },
      { nombre: 'Estado Comercial', para_que: 'TODAS las ingresadas del período clasificadas (aprobado, rechazado, anulado, pendiente). Por eso su total es mayor que las aprobadas.' },
      { nombre: 'Motivo', para_que: 'En qué quedó cada ingresada: FIRMADO = otorgada · CONFIRMACIÓN CLIENTE = aprobada sin cursar · DESISTE = rechazada o desistida.' },
      { nombre: 'Dealers y Ejecutivos — Aprobadas', para_que: 'Quién tiene pipeline abierto.' },
    ],
    siguiente: 'Para ver en qué etapa se pierde cada ejecutivo (le rechazan o no cierra), ve a Funnel.',
  },

  {
    ruta: '/dashboard/v2/', titulo: 'Dashboard · Rentabilidades', icono: 'bi-cash-coin',
    descripcion: 'Cuánto GANA AutoFácil con lo que coloca, no cuánto vende. Ingreso por colocación y por seguros menos comisión dealer, comisión parque y arriendo prorrateado: el Ingreso Neto Operacional de cada operación, calculado con el motor único de rentabilidad.',
    pasos: [
      PERIODO,
      { titulo: 'Filtra', detalle: 'Por dealer, por tramo (mayor o menor a 200 UF) y por financiera, para ver qué negocio rinde más.' },
      { titulo: 'Compara ingreso contra monto', detalle: '"Ing. AFA vs Monto Fin." muestra si el ingreso crece al mismo ritmo que la colocación, o si se está vendiendo más con menos margen.' },
      { titulo: 'Revisa operación por operación', detalle: 'El Detalle de Operaciones Otorgadas lista cada crédito con sus ingresos y costos. Exporta a Excel o copia con la camarita.' },
    ],
    submodulos: [
      { nombre: 'Ingresos AutoFácil · Composición Colocaciones', para_que: 'De dónde viene el ingreso y cómo se reparte.' },
      { nombre: 'Com. por tipo · Ops por mes', para_que: 'Peso de cada comisión y volumen mensual.' },
      { nombre: 'Detalle Operaciones Otorgadas', para_que: 'La rentabilidad de cada crédito.' },
    ],
    siguiente: 'Ojo con los dos netos: el Ingreso Neto Operacional (por operación, acá) no resta la comisión de ejecutivos ni el arriendo de parques sin colocación; el Ing. Neto AutoFácil del P&L Operativo sí. Mismo motor, distinto alcance de gastos.',
  },

  {
    ruta: '/dashboard/vrentej/', titulo: 'Dashboard · Rentabilidad por Ejecutivo', icono: 'bi-person-badge',
    descripcion: 'Cuánto deja cada ejecutivo y si eligió bien la financiera. La rentabilidad realizada es el Ingreso Neto Operacional de sus operaciones cursadas. La rentabilidad perdida es cuánto MÁS habrían dejado esas mismas operaciones si se hubieran colocado en la otra financiera (AutoFin o Unidad), estimado con el calculador de rentabilidad. Realizada más perdida es su potencial.',
    pasos: [
      PERIODO,
      { titulo: 'Mira el % en la más rentable', detalle: 'Qué parte de sus operaciones colocó en la financiera que más dejaba. Una operación con rentabilidad perdida cero es una colocación óptima.' },
      { titulo: 'Compara realizado contra potencial', detalle: 'Un ejecutivo con mucha venta puede dejar plata en la mesa si coloca por costumbre en la financiera que rinde menos para ese crédito.' },
      { titulo: 'Mira la curva de 12 meses', detalle: '% realizado y % perdido suman 100. La lectura bajo el gráfico dice la tendencia, el mejor y el peor mes.' },
    ],
    submodulos: [
      { nombre: 'Rentabilidad realizada por ejecutivo', para_que: 'El ranking de lo que efectivamente dejó cada uno.' },
      { nombre: 'Realizado vs potencial', para_que: 'Cuánto de lo posible se concretó.' },
      { nombre: 'Evolución mensual', para_que: 'Realizado y perdido en pesos y en %, últimos 12 meses.' },
      { nombre: 'Detalle por ejecutivo', para_que: 'El desglose de cada persona.' },
    ],
    siguiente: 'La rentabilidad perdida se recupera eligiendo la financiera antes de cursar: el ejecutivo la ve en la PWA ¿Dónde Curso? y en la preferencia financiera de la carta. Es un estimado del calculador, no un monto contable.',
  },

  {
    ruta: '/dashboard/v2pl/', titulo: 'Dashboard · P&L Operativo', icono: 'bi-clipboard2-data',
    descripcion: 'El estado de resultado del negocio brokerage del período: ingresos por colocación y seguros, menos comisión dealer, comisión parque, arriendos y comisión de ejecutivos, hasta el Ing. Neto AutoFácil. Es la mirada del MES, no de cada operación.',
    pasos: [
      PERIODO,
      { titulo: 'Lee de arriba hacia abajo', detalle: 'Cada línea resta un costo hasta llegar al neto. Filtra por financiera, ejecutivo o dealer para ver qué parte del negocio deja más.' },
      { titulo: 'Baja al detalle', detalle: 'El Detalle de Operaciones Otorgadas se exporta a Excel o se copia con la camarita.' },
    ],
    submodulos: [
      { nombre: 'Ingresos AutoFácil · Composición', para_que: 'La parte de arriba del P&L.' },
      { nombre: 'Com. por tipo', para_que: 'Cuánto se lleva cada costo comercial.' },
      { nombre: 'Detalle Operaciones Otorgadas', para_que: 'Las operaciones que forman el resultado.' },
    ],
    siguiente: 'El Ing. Neto AutoFácil de acá resta además la comisión de ejecutivos y el arriendo de parques sin colocación; por eso es menor que la suma de Rentabilidades. No es un error: son dos alcances distintos del mismo motor.',
  },

  {
    ruta: '/dashboard/v3/', titulo: 'Dashboard · Tendencia', icono: 'bi-graph-up',
    descripcion: 'Las variables del negocio en el tiempo, mes a mes: operaciones otorgadas, monto promedio, ingreso contra comisión dealer y tasa de conversión. Sirve para separar un mes malo de una tendencia mala.',
    pasos: [
      { titulo: 'Mira la forma, no un punto', detalle: 'Un mes bajo después de tres al alza es ruido; tres meses cayendo es tendencia.' },
      { titulo: 'Cruza volumen con promedio', detalle: 'Si las operaciones suben y el monto promedio baja, se está vendiendo más pero más chico.' },
      { titulo: 'Vigila el margen', detalle: 'Si la comisión dealer crece más rápido que el ingreso, el negocio se está encareciendo.' },
    ],
    submodulos: [
      { nombre: 'Operaciones Otorgadas por Mes', para_que: 'El volumen.' },
      { nombre: 'Monto Promedio por Operación', para_que: 'El ticket.' },
      { nombre: 'Ingresos AFA vs Com. Dealer', para_que: 'La distancia entre lo que entra y lo que se paga al dealer.' },
      { nombre: 'Tasa de Conversión · Resumen por Mes', para_que: 'Otorgadas sobre ingresadas, y la tabla con todos los números.' },
    ],
    siguiente: 'Para la serie por financiera ve a Evolución; para el patrón por día de la semana, a Historia.',
  },

  {
    ruta: '/dashboard/v5/', titulo: 'Dashboard · Ejecutivos', icono: 'bi-person-lines-fill',
    descripcion: 'El desempeño de cada ejecutivo mes a mes: ingresadas, aprobadas, otorgadas, rechazadas, tasa de aprobación, tasa de conversión y monto promedio. Es la base de la conversación de gestión con cada persona.',
    pasos: [
      { titulo: 'Lee los colores', detalle: 'El fondo de cada celda compara al ejecutivo contra el resto del equipo ese mes (percentiles): verde está arriba, rojo está abajo.' },
      { titulo: 'Abre el día a día', detalle: 'Clic en un número de Ing, Apro u Ot abre el desglose día por día de ese mes. La camarita lo copia para WhatsApp.' },
      { titulo: 'Distingue los dos problemas', detalle: 'TA baja = le rechazan lo que ingresa (calidad del cliente o de la documentación). TC baja = le aprueban pero no cierra.' },
    ],
    submodulos: [
      { nombre: 'Desempeño por Ejecutivo', para_que: 'Ing · Apro · Ot · Rec · TC · TA · Prom por mes.' },
    ],
    siguiente: 'Para ver en qué etapa se pierde cada uno, ve a Funnel. Para la meta de ingresos diarios, a Prospección.',
  },

  {
    ruta: '/dashboard/v7/', titulo: 'Dashboard · Funnel', icono: 'bi-funnel',
    descripcion: 'El embudo ingresadas → aprobadas → otorgadas del período, total y por ejecutivo, con tasa de aprobación (TA) y de conversión (TC). Dice DÓNDE se pierde cada ejecutivo.',
    pasos: [
      PERIODO,
      { titulo: 'Lee las dos tasas por separado', detalle: 'TA = aprobadas ÷ ingresadas: calidad de lo que ingresa. TC = otorgadas ÷ aprobadas: capacidad de cierre. Responden preguntas distintas: no se suman ni se comparan entre sí.' },
      { titulo: 'Busca el cuello de botella', detalle: '"Dónde se pierde cada ejecutivo" marca si su problema es de aprobación o de conversión.' },
    ],
    submodulos: [
      { nombre: 'Embudo por Ejecutivo', para_que: 'Los tres números de cada persona.' },
      { nombre: 'Dónde se pierde cada ejecutivo', para_que: 'El diagnóstico: aprobación o conversión.' },
      { nombre: 'Tasa de Conversión Total · Referencia', para_que: 'El promedio del equipo contra el cual se compara.' },
    ],
    siguiente: 'Los tres números son los mismos de Otorgados y Aprobados (definición única). Si comparas con un pantallazo anterior al 21-08-2026, el "Aprobados" viejo venía inflado con pendientes.',
  },

  {
    ruta: '/dashboard/v7p/', titulo: 'Dashboard · Prospección', icono: 'bi-bullseye',
    descripcion: 'La parte alta del embudo: si cada ejecutivo está ingresando suficientes solicitudes. La meta es 2 ingresos por día hábil (lunes a sábado; en el mes en curso cuentan solo los días transcurridos hasta hoy).',
    pasos: [
      PERIODO,
      { titulo: 'Mira Ing./día', detalle: 'Ingresadas ÷ días hábiles. Verde desde 2,00; naranjo desde 1,50; rojo bajo eso.' },
      { titulo: 'Lee el problema clave', detalle: 'En orden de prioridad: Prospección si no llega a 2 ingresos diarios · Aprobación si su TA está bajo el 70% del promedio del equipo · Conversión si su TC está bajo el 70% · OK si cumple todo.' },
    ],
    submodulos: [
      { nombre: 'Embudo por Ejecutivo', para_que: 'Ingresos, aprobadas y otorgadas contra la meta.' },
      { nombre: 'Ingresos por día hábil vs meta', para_que: 'El cumplimiento de la meta de digitación.' },
      { nombre: 'Dónde se pierde cada ejecutivo', para_que: 'El diagnóstico con semáforo contra el promedio del equipo.' },
      { nombre: 'Parámetros y cómo se calcula cada uno', para_que: 'La explicación de cada columna, al pie de la pestaña.' },
    ],
    siguiente: 'Un ejecutivo que no llega a la meta de ingresos no tiene cómo llegar a la de ventas: se trabaja primero la prospección.',
  },

  {
    ruta: '/dashboard/v6/', titulo: 'Dashboard · Saldo Precio', icono: 'bi-credit-card',
    descripcion: 'El pipeline del pago al dealer de las operaciones otorgadas: fundantes → liberado a pago → orden emitida → pagado, con los montos en tránsito. El saldo precio es plata de paso: la financiera la gira y se entrega íntegra al dealer, no es ingreso de AutoFácil.',
    pasos: [
      { titulo: 'Filtra por financiera', detalle: 'Todas, AutoFin o Unidad.' },
      { titulo: 'Busca dónde está atascada la plata', detalle: 'Cada etapa muestra cuántas operaciones y cuánto monto hay detenido ahí.' },
      { titulo: 'Exporta', detalle: 'El detalle se descarga a Excel.' },
    ],
    submodulos: [
      { nombre: 'Estado Saldo Precio — Créditos Otorgados', para_que: 'Operaciones y montos por etapa del pago.' },
    ],
    siguiente: 'En AutoFin el monto a pagar suma Transferencia y Limitación de Dominio, y excluye la Limitación si los fundantes van sin limitación. El pago se opera en Post Venta → Saldos Precios a Pagar.',
  },

  {
    ruta: '/dashboard/v8/', titulo: 'Dashboard · Comparativo', icono: 'bi-layout-split',
    descripcion: 'El mismo set de métricas en dos períodos lado a lado, por ejecutivo y a mismos días de cierre. Responde "¿mejoramos o empeoramos?" sin sacar la calculadora.',
    pasos: [
      PERIODO,
      { titulo: 'Compara a igual avance', detalle: 'Los dos períodos se cortan en el mismo día del mes, para que el mes en curso no se vea peor solo porque no ha terminado.' },
      { titulo: 'Lee la diferencia', detalle: 'Por ejecutivo: ingresadas, aprobadas, otorgadas, pendientes y rechazadas de cada período, y la diferencia entre ambos.' },
    ],
    submodulos: [
      { nombre: 'Comparativo Ejecutivos — Mismos Días Cierre', para_que: 'INGRESADAS = todo lo digitado · APROBADAS = aprobadas + otorgadas · OTORGADAS = solo otorgadas.' },
    ],
    siguiente: 'Para la tendencia de más meses, ve a Tendencia o Evolución.',
  },

  {
    ruta: '/dashboard/vhist/', titulo: 'Dashboard · Historia', icono: 'bi-calendar3',
    descripcion: 'Los patrones de la colocación en el calendario: qué días de la semana, qué semana del mes y qué días del mes se cursa más. Sirve para planificar el esfuerzo comercial y leer bien un mes en curso.',
    pasos: [
      PERIODO,
      { titulo: 'Busca los patrones', detalle: 'Si la mayor parte se cursa la última semana, un día 15 flojo no es alarma. Si un día de la semana rinde poco, ahí hay espacio para trabajar.' },
    ],
    submodulos: [
      { nombre: 'Créditos por Día de la Semana', para_que: 'Lunes a domingo.' },
      { nombre: 'Créditos por Semana del Mes', para_que: 'Primera a cuarta semana.' },
      { nombre: 'Créditos por Día del Mes', para_que: 'Del 1 al 31.' },
    ],
    siguiente: 'Proyección Pro usa estos patrones (curva de días hábiles, feriados) para estimar el cierre del mes.',
  },

  {
    ruta: '/dashboard/vppto/', titulo: 'Dashboard · Presupuesto', icono: 'bi-bullseye',
    descripcion: 'El real de cada mes contra la meta, en número de créditos otorgados y en monto colocado. Es el seguimiento del compromiso comercial del año.',
    pasos: [
      { titulo: 'Lee el cumplimiento mes a mes', detalle: 'Cada fila compara lo otorgado contra el presupuesto de ese mes, en cantidad y en millones.' },
      { titulo: 'Mira el mes en curso con cuidado', detalle: 'Un mes abierto siempre se ve por debajo: para saber si llegará, ve a Proyección Pro.' },
    ],
    submodulos: [
      { nombre: 'N° Créditos Otorgados vs Presupuesto', para_que: 'Cumplimiento en cantidad.' },
      { nombre: 'Montos Colocados (MM$) vs Presupuesto', para_que: 'Cumplimiento en plata.' },
    ],
    siguiente: 'La meta mensual se edita en Mantenedores → Presupuesto; el cambio se ve aquí y en el Resumen Ejecutivo.',
  },

  {
    ruta: '/dashboard/vevol/', titulo: 'Dashboard · Evolución', icono: 'bi-bar-chart-steps',
    descripcion: 'La historia completa de las operaciones otorgadas mes a mes, separada por financiera. Muestra cómo cambió el peso de AutoFin y Unidad en el tiempo.',
    pasos: [
      { titulo: 'Compara las financieras', detalle: 'Si una crece y la otra cae, el negocio se está concentrando: importa para negociar condiciones.' },
    ],
    submodulos: [
      { nombre: 'Operaciones Otorgadas Mensuales — por Financiera', para_que: 'La tabla mes a mes.' },
      { nombre: 'Tendencia Histórica', para_que: 'El gráfico de la serie completa.' },
    ],
    siguiente: 'Para la participación del período actual, ve a Otorgados → Participación % por Financiera.',
  },

  {
    ruta: '/dashboard/vseg/', titulo: 'Dashboard · Seguros', icono: 'bi-shield-check',
    descripcion: 'La penetración de los seguros AutoFin (RDH, cesantía y reparaciones) y el ingreso que generan, mes a mes, sobre las operaciones cursadas del mes. La penetración se mide sobre las operaciones ELEGIBLES para cada seguro: un crédito que no puede llevar cesantía no castiga el %.',
    pasos: [
      { titulo: 'Mira el seguro más débil', detalle: 'El % de comisión del mes lo define el tramo que alcanza el seguro con MENOR penetración, y ese % se aplica parejo a las primas de los tres. Los tramos están escritos bajo el título de la pestaña.' },
      { titulo: 'Lee el ingreso', detalle: 'Se calcula con la tabla vigente del mantenedor Comisiones de Seguro.' },
    ],
    submodulos: [
      { nombre: 'Cumplimiento e Ingresos por Mes', para_que: 'Penetración por seguro, tramo alcanzado e ingreso.' },
      { nombre: 'Histórico mensual', para_que: 'La serie completa.' },
    ],
    siguiente: 'Subir el seguro más débil sube la comisión de los tres: es la palanca con más efecto en el ingreso por seguros. Es el mismo cruce que paga los bonos de los ejecutivos.',
  },

  {
    ruta: '/dashboard/vdealers/', titulo: 'Dashboard · Dealers', icono: 'bi-shop',
    descripcion: 'Las colocaciones de cada dealer mes a mes, en cantidad y en monto, ordenadas por las ventas del último mes. Muestra quién trae el negocio y quién se está enfriando.',
    pasos: [
      { titulo: 'Elige el horizonte', detalle: 'Todo, últimos 3, 6 o 12 meses, o un año.' },
      { titulo: 'Filtra por categoría', detalle: 'SP = Super Partner, P = Partner, S = Socio. Pinchar una categoría muestra solo esos dealers; Todas vuelve a la lista completa.' },
      { titulo: 'Busca los que se enfrían', detalle: 'Un dealer que vendía todos los meses y se detuvo es una alerta comercial.' },
      { titulo: 'Exporta', detalle: 'La tabla se descarga a Excel.' },
    ],
    submodulos: [
      { nombre: 'Otorgados por dealer y mes', para_que: 'Cantidad y monto de cada dealer en cada mes.' },
    ],
    siguiente: 'La categoría del dealer define su comisión y el plazo en que se le paga el saldo precio (Socio 72 h hábiles, Partner 48, Super Partner 24). Se revisa en Mantenedores → Categoría y Potencial Dealer.',
  },

  {
    ruta: '/dashboard/vparques/', titulo: 'Dashboard · Parques', icono: 'bi-p-square',
    descripcion: 'Las colocaciones de cada parque automotriz mes a mes, en cantidad y en monto, más la curva mensual de cada uno (incluye CALLE: lo que no viene de un parque).',
    pasos: [
      { titulo: 'Elige el horizonte', detalle: 'Todo, últimos 3, 6 o 12 meses, o un año.' },
      { titulo: 'Compara parques', detalle: 'La curva muestra cuál crece, cuál se estanca y cuánto pesa la venta de calle.' },
      { titulo: 'Exporta', detalle: 'La tabla se descarga a Excel.' },
    ],
    submodulos: [
      { nombre: 'Otorgados por parque y mes', para_que: 'Cantidad y monto de cada parque.' },
      { nombre: 'Curva mensual por parque', para_que: 'La serie de cada parque, incluida CALLE.' },
    ],
    siguiente: 'El parque de cada operación viene del Excel de carga, no del mantenedor: si la carga no trae parque, esa venta no se le atribuye a ninguno.',
  },

  {
    ruta: '/dashboard/vproy2/', titulo: 'Dashboard · Proyección Pro', icono: 'bi-magic',
    descripcion: 'Dónde va a cerrar el mes al ritmo actual, por institución, y cuánto hay que colocar por día para cumplir el presupuesto. Combina tres métodos y ajusta por días hábiles, feriados, clima y dotación del equipo.',
    pasos: [
      { titulo: 'Usa la Mezcla', detalle: 'Es la recomendada: al inicio del mes pesa más la tendencia de los últimos cierres; a fin de mes pesa más el avance real. Usa días hábiles y mediana, para que un mes raro no la distorsione.' },
      { titulo: 'Mira si los métodos convergen', detalle: 'Si los tres métodos dan parecido, el cierre es confiable. Si divergen mucho, el mes viene atípico: mira la curva para saber hacia dónde.' },
      { titulo: 'Revisa el ritmo requerido', detalle: 'Cuánto hay que colocar por día hábil desde hoy para llegar a la meta. El pulso diario marca el real y la meta de cada día.' },
    ],
    submodulos: [
      { nombre: 'Proyección por institución', para_que: 'El cierre estimado de AutoFin y Unidad.' },
      { nombre: 'Ritmo requerido · Pulso diario', para_que: 'Lo que falta por día para cumplir.' },
      { nombre: 'Los 3 métodos comparados', para_que: 'Curva de avance, tendencia y mezcla, lado a lado.' },
      { nombre: 'Q y monto — histórico, proyectado y avance por día hábil', para_que: 'El mes en curso contra lo esperado día a día.' },
      { nombre: 'Clima y feriados', para_que: 'El efecto medido en la colocación: la lluvia no baja la venta; un feriado entre semana rinde menos de la mitad.' },
      { nombre: 'Cómo leer estos métodos', para_que: 'Explicación completa, ventajas y cuándo confiar en cada uno.' },
    ],
    siguiente: 'La proyección es un RITMO, no una promesa: un fin de mes fuerte o débil la mueve. Los primeros días del mes confía más en la tendencia; desde la segunda semana, en la curva.',
  },

  {
    ruta: '/dashboard/vadmin/', titulo: 'Dashboard · Administración', icono: 'bi-gear',
    descripcion: 'La configuración del propio Dashboard: quién lo usa y qué perfil ve cada pestaña. Solo para el Administrador.',
    pasos: [
      { titulo: 'Marca las pestañas por perfil', detalle: 'En Control de Acceso por Pestaña, cada columna es un perfil. Guarda los cambios; Restaurar por defecto vuelve a la configuración original.' },
    ],
    submodulos: [
      { nombre: 'Usuarios del Sistema', para_que: 'Lista de usuarios, alta de uno nuevo y exportación.' },
      { nombre: 'Control de Acceso por Pestaña', para_que: 'Qué perfil ve qué pestaña del Dashboard.' },
    ],
    siguiente: 'Los permisos generales de cada perfil se administran en Usuarios → Perfiles y Permisos.',
  },
];
