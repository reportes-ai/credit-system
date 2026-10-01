# Motor de remuneraciones: normativa (DT / SII / Previred) vs. lo que hace la Suite

Referencia: `docs/referencias/Calculo-Remuneraciones-Chile.docx` ("Especificación Técnica: Lógica de
Motor de Remuneraciones en Chile", entregado por Pato el 11-09-2026). Este cuadro contrasta cada
punto de ese documento con el motor único `calcLiquidacion()` de
`services/rrhh/src/controllers/remuneraciones.controller.js` y sus motores satélite. Sirve para
saber qué ya está, qué se decidió distinto (y por qué) y qué falta.

| # | Punto del documento | Suite | Estado |
|---|---|---|---|
| 1 | Parámetros globales sin hardcodear (IMM, UF, UTM, topes, tasas) | `rh_config` claves `rem_*` (IMM, tope imponible UF, tope AFC UF, salud %, AFC trabajador/empleador, SIS, mutual, APV tope), `rh_afp_tasas` por AFP, `rh_impuesto_tramos` en UTM, UF de `shared/uf.js`, UTM de la tabla `utm`. Mantenedor Indicadores de Remuneraciones. | ✅ |
| 1b | UF "del último día del mes a procesar" | `indicadores(mes)` toma la UF del **último día** del mes (v231.9; si el mes no ha terminado, la última cargada). | ✅ |
| 2 | Regla de los 30 días: días a pagar = 30 − ausencias − licencias − permisos sin goce | `diasTrabajadosMes()`: 30 − ingreso parcial − baja − licencias/permisos sin goce/ausencias injustificadas (`rh_ausencias` APROBADA). Vacaciones no descuentan. | ✅ |
| 2b | Mes de ingreso: días reales trabajados (bandera Mes_Ingreso) | Ingreso el día D → 30 − (D − 1) en 30avos (ingreso 15 → 16/30). Es la convención de AVSOFT validada con Carmen y Romo (08-09-2026); el documento propone días calendario reales (17 en mes de 31). Se mantiene la nuestra. | ✅ decidido |
| 3 | Horas extras: (sueldo/30 × 28 / jornada) × 1,5; factores 45 h 0,0077777 · 44 h 0,0079545 · 40 h 0,00875 | `shared/horas-extras.js`: sueldo base × 7 ÷ (30 × jornada) × (1 + recargo). Misma fórmula (7/30 = 28/30/4). Jornada y recargo paramétricos (44 h Ley 21.561), base = sueldo base, art. 22 excluido con motivo. | ✅ |
| 4 | Semana corrida art. 45: semana a semana (comisiones de la semana ÷ días laborables reales × domingos y festivos de esa semana) | Motor `shared/semana-corrida.js`: factor **mensual** 1 + (domingos + festivos) ÷ (días L–S hábiles del mes), aplicado sobre el incentivo del mes. Decisión de Pato (07-09-2026), igual en Anexo 08-2026 y modelo anterior. Las comisiones de la Suite se devengan por mes, no por día, así que la versión semanal no aplica. | ✅ decidido |
| 5 | Gratificación art. 50: 25% del imponible con tope (4,75 IMM)/12 | `topeGrat = rem_grat_tope_imm × rem_imm / 12`; `min(25% base, tope)`. Base = sueldo proporcional + comisiones + feriado variable + otros imponibles. | ✅ |
| 5b | Tope de gratificación proporcional a los días pagados (licencias/ausencias) | Tope × días/30 con `rem_prorratea_topes = 1` (v231.9). | ✅ |
| 6 | Topes imponibles (AFP/salud/SIS y AFC) proporcionales a los días pagados | `rem_tope_imponible_uf × UF × días/30` y `rem_tope_afc_uf × UF × días/30` con `rem_prorratea_topes = 1` (v231.9). | ✅ |
| 6b | AFP = base × (10% + comisión AFP) | `rh_afp_tasas.tasa_pct` por administradora (ya incluye el 10%). | ✅ |
| 6c | Salud: Fonasa 7%; Isapre = mayor entre 7% y plan en UF | 7% legal (`rem_salud_pct`) + "adicional isapre" = max(0, plan UF × UF − 7%). Mismo resultado, mostrado en dos líneas. | ✅ |
| 6d | AFC trabajador 0,6% solo indefinido, tope AFC propio | `rem_afc_trabajador_pct` solo INDEFINIDO, base topada a `rem_tope_afc_uf`. El documento menciona "menos de 11 años": no se controla (no hay caso hoy). | ✅ |
| 7 | Impuesto único: base = imponible − AFP − salud (solo 7%) − AFC; tramos UTM (factor − rebaja) | `shared/base-tributable.js` (compartido con la DJ 1887): la salud deducible es la **pactada completa** (7% + adicional Isapre) con tope del 7% del tope imponible (art. 42 N°1 LIR / art. 18 DL 3.500) y APV régimen B rebaja hasta `rem_apv_tope_uf`. Validado contra AVSOFT (Sandra Ayala, 08-09-2026: $8.243). **El documento está simplificado en este punto; manda la ley y AVSOFT.** Tramos `rh_impuesto_tramos`, impuesto nunca negativo. | ✅ decidido |
| 8 | Vacaciones con renta variable: promedio 3 meses de variables sumado al sueldo por los días de vacaciones | Haber "feriado variable" (art. 71 CT): promedio de comisiones de los últimos 3 meses enteros trabajados × días de vacaciones / 30. | ✅ |
| 8b | Kardex de vacaciones, 1,25 días por mes (proporcional por días desde 14-09-2026); finiquito = saldo × sueldo/30 | Cuenta corriente `rh_vac_movimientos` (devengo 15 días por aniversario + progresivo art. 68 + tomados + ajustes), `saldoCuenta(id, fecha)`; el finiquito paga el saldo con la base de `services/rrhh/src/base-remuneracion.js`; los días hábiles se **proyectan en el calendario** desde el día siguiente al término (`shared/feriados.js → diasCorridosDeHabiles`): sábados, domingos y festivos comprendidos también se pagan (5,89 hábiles desde el 12-09-2026 = 9,89 corridos, hasta el 22-09). Antes ×1,4 aproximado. Saldo con 2 decimales. | ✅ |
| 8c | **Doctrina DT verificada (15-09-2026)** para la base del feriado proporcional e indemnizaciones con renta variable: art. 71 CT = sueldo + promedio de **lo percibido** en los últimos tres meses **trabajados**; las comisiones pagadas desfasadas que no entraron al promedio se pagan aparte (ORD. 5424/250 de 1995, ORD. N°495 de 21-01-2016, ORD. N°77 de 19-02-2025). Meses con licencia no cuentan (ORD. 2994/171). La **gratificación mensual NO integra el feriado** (dictamen 836/046 de 24-02-2004, ORD. 5457/316); sí integra la base del art. 172. Días: hábiles proyectados desde el día siguiente al término + sábados, domingos y festivos (consulta DT "¿Cómo se calcula el feriado proporcional?", ORD. 799/67, 1533/87). | `base-remuneracion.js`: `base` (imponible promedio, con gratificación) para art. 172 y `base_feriado` (sin gratificación) para art. 73; meses completos (excluye ingreso parcial y mes del término). NO devengo: se probó y se revirtió el mismo día. F. Contreras: base_feriado $1.431.064 → 9,89 días = $471.775. | ✅ |
| 9 | Aportes patronales: mutual (0,90% + siniestralidad), Ley Sanna 0,03%, SIS 1,54% (no si pensionado), AFC empleador 2,4% / 3,0% | `rem_mutual_pct` (una sola tasa, hoy 0,93%), `rem_sis_pct`, `rem_afc_emp_pct` / `rem_afc_emp_pfijo_pct`. Pensionados: `rh_fichas.pensionado` = sin AFP, AFC ni SIS (v231.12). Ley SANNA: `rem_sanna_pct` 0,03% → `aporte_sanna` (v231.13). | ✅ |
| 10 | Orden de cálculo (pipeline) | `calcLiquidacion()` sigue el mismo orden: días → proporcionales → variables → gratificación → imponible → bases topadas → descuentos legales → base tributable → impuesto → no imponibles → otros descuentos → líquido → aportes patronales. | ✅ |

## Pendiente 4.12 (PENDIENTES.md)
Brechas del motor contra la normativa, para decidir con Pato antes de tocar el cálculo (afectan
liquidaciones ya validadas al peso contra AVSOFT):
1. ✅ Prorrateo por días pagados de topes (v231.9, paramétrico `rem_prorratea_topes`).
2. ✅ Ley SANNA (0,03% cargo empleador) como aporte separado en costo empresa (v231.13).
3. ✅ Pensionado: bandera en la ficha, sin AFP/AFC/SIS (v231.12).
4. ✅ UF del último día del mes (v231.9).

Las decisiones tomadas distinto al documento (mes de ingreso en 30avos, semana corrida mensual,
salud deducible completa en el impuesto) quedan registradas arriba y no son brechas.

## Segundo documento: «Normativa Remuneraciones DT Chile» (01-10-2026)

Referencia: `docs/referencias/Normativa-Remuneraciones-DT-Chile.docx` (informe técnico-jurídico entregado por
Pato el 01-10-2026). Va más allá del cálculo de la liquidación: jornada, descuentos, finiquito, LRE. Los
puntos dudosos se verificaron en la Dirección del Trabajo antes de tocar nada.

| # | Punto del documento | Suite | Estado |
|---|---|---|---|
| A | Ley 21.561: 44 h (26-04-2024) → **42 h (26-04-2026)** → 40 h (26-04-2028); factor de la hora extra con 42 h = 0,0083333 | El parámetro `he_jornada_semanal` estaba en 44 (y lo decían el comentario del motor y la pantalla Jornada). Corregido a 42 por la migración `rrhh-he-jornada-42-v1`; default del motor 42; editable en Indicadores de Remuneraciones → Jornada y horas extraordinarias. La jornada de la ficha (40 h pactadas o especial) sigue mandando. | ✅ corregido |
| B | Art. 172: la base de las indemnizaciones incluye colación y movilización habituales; excluye horas extras, asignación familiar y bonos esporádicos (aguinaldos) | La base era el promedio del imponible a secas. Ahora `base` = imponible − excluidos + no imponibles habituales (`shared/finiquito-base.js`, listas `finiq_base_excluye` / `finiq_base_no_imp`). Verificado en la DT (dictamen 75/8 de 1999). `base_feriado` no cambia. | ✅ corregido |
| C | Ley 21.389 / art. 13 Ley 14.908: retener la pensión de alimentos de las indemnizaciones del finiquito y avisar al tribunal en 10 días hábiles | El finiquito solo descontaba anticipos y préstamos y además anulaba la retención judicial. Ahora: retención propuesta (pensión del mes siguiente sobre el aviso previo; % pensión ÷ ingreso sobre los años de servicio), línea y declaración en el documento, orden de pago al alimentario al cerrar, tarea de aviso al tribunal en el offboarding y aviso del término en el correo de pago. | ✅ corregido |
| D | Crédito social CCAF: descuento legal obligatorio | El motor lo contaba dentro del 15% (al registrar) y del 45% (en la prelación). La DT lo deja fuera de ambos (ORD. 4565/94 de 2011, 262/4 y 3741/36 de 2012, 558 de 2021). Corregido en `tope-descuento.js` y `calcLiquidacion`. | ✅ corregido |
| E | LRE: catálogo de códigos por concepto (haberes 2xxx, descuentos 31xx, identificación 11xx) | El archivo mandaba horas extras y aguinaldos a 2113, la semana corrida dentro de 2103, todos los descuentos a 3183, no informaba el feriado variable (2108) —la fila no cuadraba— y llevaba fijos jornada, pensionado y término. Ahora cada concepto va en su código del Suplemento LRE y la pantalla avisa si una fila no cuadra. | ✅ corregido |
| F | Tope del 45% "sobre todos los descuentos, incluidos impuestos y CCAF" | **El documento se equivoca**: la DT lo aplica solo a los descuentos facultativos de los incisos 2° y 3° del art. 58 (ORD. 558 de 2021). El motor lo aplica así. | ✅ sin cambio |
| G | Feriado proporcional valorizado con "sueldo base diario" | Simplificación del documento. Rige lo verificado el 15-09-2026: sueldo + promedio de variables, sin gratificación mensual. | ✅ sin cambio |
| H | Semana corrida semana a semana | Factor mensual por decisión de Pato (07-09-2026). | ✅ decidido |
| I | Gratificación art. 50 proporcional en licencias; topes art. 58 (15/30/45); APV régimen B; anticipos; reserva de derechos; tope 90 UF y 11 años | Ya estaba. | ✅ |
| J | Art. 22 restrictivo; colación y movilización "razonables" y sin pago durante el feriado; horas extras compensadas con descanso (1 : 1,5, máx. 5 días/año) | Hay 3 contratos con art. 22 y movilizaciones de hasta $250.000; colación y movilización se pagan completas en vacaciones (legal, más favorable); la compensación con descanso no existe en el sistema. | ⚪ decisión de Pato (PENDIENTES 4.16) |

Quedó abierto en PENDIENTES 4.16: asignación de celular en la base del art. 172, aviso automático al tribunal
cuando no hay orden de pago, texto de la declaración de alimentos (validar con abogado), causal art. 160 en el LRE.
