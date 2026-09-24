# Auditoría contable independiente — Provisiones por Devengo (24-09-2026)

> Revisión hecha por un agente independiente actuando como auditor contable senior chileno (IFRS para PYMES / NIC 37,
> normativa SII, práctica de cierre mensual), sobre el módulo construido ese mismo día. Solo lectura de código; no tocó
> datos. Se conserva íntegro como evidencia de revisión y como lista de trabajo. Lo marcado ✅ se corrigió el mismo día
> (v271.1); lo marcado ⏳ requiere decisión de Pato o del contador (política contable) y está en `PENDIENTES.md` 2.13.

## 1. Veredicto general

**Con reparos.** El concepto de fondo es correcto y defendible: reconocer el gasto de comisión dealer/parque en el mes de
curse y el de comisiones/sueldos en el mes en que se devengan, con un pasivo acumulado que se reversa cuando entra el
documento definitivo, es lo que pide la base devengada (IFRS para PYMES §2.36, NIC 37.11 sobre devengos) y lo que el SII
acepta como gasto adeudado (art. 31 LIR: "pagados o adeudados"). La mecánica del motor (una fila por origen, refs
idempotentes, diferencia al resultado del mes de liberación) es sana.

Los reparos no invalidan el diseño, pero dos generaban gasto duplicado y debían corregirse antes de informar septiembre.

## 2. Hallazgos por severidad

### ALTA

**A1 ⏳ `REMUNERACIONES` duplica el gasto de comisiones y deja 2106060 sin rebajar.** La regla manda TODOS los haberes a
4001060; la liquidación de mes M incluye la comisión de M-1, que ya devengó por `COMISION_EJECUTIVOS` (4001100 / 2106060).
Gasto dos veces y pasivo 2106060 que nunca se debita. Qué hacer: campos `sueldos` (haberes − comisiones → 4001060) y
`comisiones` (DEBE 2106060) en la regla, alimentados desde `rh_liquidaciones.detalle.comisiones`. Mientras el libro lo
contabilice AVSOFT, el contador debe hacer ese asiento con la comisión contra 2106060 y no contra gasto.

**A2 ✅ Facturas que cubren varias OP (réplicas) no liberaban la provisión de las OP hermanas.** `documentoDealer` exigía
`monto_liquido` en la fila, que solo tiene la titular. Corregido: JOIN a la titular por `id_titular`, liberación de cada
réplica en `replicarFacturaComision`, y el chequeo PROVISION_DEALER del cierre cuenta las réplicas como documento.

**A3 ⏳ Detalle AVSOFT: liberación con asiento de filas que el contador pudo haber rebajado ya.** El detalle ($183,4 M)
supera la cuenta en ~$60 M al cargarse (hoy −$3,6 M tras la conciliación del 24-09). Cada liberación de una fila que ya
estaba rebajada abona gasto que no existe. Qué hacer: conciliar el auxiliar con el saldo de 2106011 al 31-08-2026 y
marcar CONCILIACION (sin asiento) las filas no ubicadas; hasta entonces, vigilar `saldo_historico` en la card.

**A4 ✅ Liberación de sueldos fechada "hoy" contra un libro fechado el último día del mes.** Corregido: la liberación usa la
fecha del comprobante del libro y la emisión de liquidaciones contabiliza `REMUNERACIONES` al último día del mes.

### MEDIA

**M1 ⏳ Naturaleza y nombre de las cuentas.** 2106011/13/14/15 son pasivos acumulados (devengos), no provisiones NIC 37.
Renombrar en el mantenedor ("COMISIONES DEALER DEVENGADAS POR FACTURAR", etc.) y mapearlas a Cuentas por pagar en el
balance clasificado. Política contable a dejar escrita.

**M2 ⏳ Provisión del dealer siempre al NETO aunque el dealer emita boleta.** Con boleta el gasto real es el bruto (4002081).
Opción: provisionar al bruto si la ficha o el historial del dealer indica boleta.

**M3 ✅ Retención cuando "el emisor retiene".** `contabilizarComision` fuerza retención 0 y líquido = honorario si
`emisor_retiene=1`.

**M4 ⏳ Ajustes -AJn siguen moviendo el mes anterior después de informado.** Definir fecha límite (informe a la matriz o
candado) a partir de la cual el ajuste va al mes actual.

**M5 ✅ Fila creada antes del asiento.** Si el motor no contabiliza (regla desactivada, descuadre, error), la constitución
se borra y la liberación vuelve a CONSTITUIDA.

**M6 ⏳ Aportes patronales: se provisionan pero el libro real (regla REMUNERACIONES) no los contabiliza.** Extender la
regla con `sis`, `afc_emp`, `mutual` (DEBE 4001093/4001091/4001092, HABER 2210904).

**M7 ⏳ Cuenta de gasto con año (4001127 "COMISIONES DEALER 2023") y "SUELDO BASE" para todos los haberes.** Renombrar en
el mantenedor; a mediano plazo separar haberes imponibles / no imponibles / gratificación.

**M8 ⏳ Filas AVSOFT de comisión de parque provisionadas en 2106011 se liberan contra 4001127** mientras el devengo real
del parque va a 4001100. Neto cero en resultado; documentar en la conciliación o reclasificar.

### BAJA

**B1** Idempotencia correcta (refs únicas, UNIQUE por origen). Si un comprobante se anula a mano, una resincronización lo
vuelve a generar: avisarlo en el manual. `origen_ref` ampliado a 100 caracteres (verificado en la base).
**B2 ✅** La liberación nunca antes de la constitución (filas del motor).
**B3 ✅** Rama vieja de EJECUTIVO por crédito eliminada del chequeo `_provision` del cierre.
**B4 ⏳** Las leyes sociales patronales sobre comisiones caen en la provisión de sueldos de M+1 (timing pequeño). Política.
**B5** `fechaContable` mueve a hoy con mes cerrado: correcto; agregar al log cuándo pasó.

## 3. Lo que está bien hecho

Un solo motor con reglas paramétricas y cuentas propias; motor de asientos que nunca bloquea y deja log; liberación
íntegra con diferencia al resultado del mes de liberación; dealer al neto con factura; ejecutivos por el mismo motor
que paga RRHH; cuadro leído desde la cuenta con separación motor/histórico y `liberada_contra`; corte por parámetro
`prov_*_desde` y conciliación sin asiento de las 180 filas AVSOFT ya pagadas.

## 4. Checklist de cierre septiembre 2026 (contador)

1. **2106060 en cero al pagar el libro**: `SELECT SUM(haber-debe) FROM ctb_movimientos WHERE cuenta='2106060'`; cruzar con
   la suma de comisiones en las liquidaciones de septiembre (A1).
2. **Comisiones de agosto una sola vez**: mayor de 4001100 y 4001060 de septiembre; los COMEJ-*-2026-08 no deben
   reaparecer dentro del libro REM-2026-09 / traspaso AVSOFT.
3. **Réplicas sin liberar**: `SELECT p.num_op, p.monto FROM ctb_provisiones p JOIN postventa_facturas_comision fc ON
   fc.num_op=p.num_op WHERE p.concepto='DEALER' AND p.estado='CONSTITUIDA' AND fc.es_replica=1` → debe dar cero (A2).
4. **Conciliación 2106011 al 31-08 y al 30-09**: card Provisiones → Dealer → pop-ups CUENTA vs VIGENTE; `saldo_historico`
   no puede ser negativo (A3). Exportar Excel y firmar.
5. **Sueldos, un solo gasto en septiembre**: mayor 4001060: libro (REM-2026-09 o traspaso AVSOFT fechado 30-09) o
   provisión PROV-SUELDOS-2026-09, nunca ambos vigentes con fecha de septiembre (A4). Chequeo PROVISION_SUELDOS.
6. **Aportes patronales presentes**: mayor 4001093/4001091/4001092 tras liberar la provisión vs Archivo Previred (M6).
7. **Asientos del motor calzan con sus filas**: chequeos PROVISION_* del Cierre de Mes con `dif` 0, y
   `SELECT COUNT(*) FROM ctb_provisiones WHERE origen_tipo<>'AVSOFT' AND (id_comprobante_constitucion IS NULL OR
   (estado='LIBERADA' AND id_comprobante_liberacion IS NULL AND motivo_liberacion NOT IN ('CONCILIACION')))` = 0 (M5).
8. **Retenciones de boletas vs F29**: Libros Auxiliares → Honorarios; toda boleta con `emisor_retiene=1` con retención 0 (M3).
9. **Ajustes -AJn después de informar**: `SELECT origen_ref, fecha, created_at FROM ctb_comprobantes WHERE origen_ref
   LIKE 'PROV-%-AJ%' AND fecha<='2026-09-30' AND created_at > '<fecha del informe>'` (M4).

**Políticas contables que la empresa debe dejar escritas**: clasificación de 2106011-15 como devengos vs provisiones (M1);
dealers con boleta al bruto o al neto (M2); leyes sociales patronales sobre comisiones (B4); fecha límite para ajustar
un mes ya informado (M4).
