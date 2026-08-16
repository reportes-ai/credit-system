---
name: cuadratura-trinidad
description: Cuadra el export de Trinidad (Canal AutoFin) contra la BD - montos del export mandan, su Comision Dealer se ignora. Pedir la ruta del archivo TRISolicitudWWExport-*.xlsx si no viene.
---

# Cuadratura Trinidad (Canal AutoFin)

Documentada en procesos.html cap. 30. Si Pato no indicó el archivo, pedirle la ruta del `TRISolicitudWWExport-*.xlsx` del mes.

## Reglas de oro (NO negociables)

- **El export MANDA para los MONTOS**: `Saldo Precio`→`saldo_precio`, `Pie`→`pie`, `Monto Pagare`→`monto_financiado`.
- 🔴 **La columna `Comision Dealer` del export NO es nuestra comisión** (confirmado por Pato — es un default del sistema de ellos, en julio difería en TODAS las ops, mediana 2,65×). La comisión del dealer la calcula SIEMPRE nuestro motor. Jamás copiarla ni usarla para cuadrar.
- **Encabezado en la FILA 4** (las 3 primeras son título). La columna `ID` del export es nuestro `id_financiera`, NO el num_op.
- Diferencias bajo **$1.000 son redondeo**: filtrarlas, no reportarlas.

## Pasos

1. Leer el Excel (pandas, `header=3`). Mapear cada fila a la BD por `id_financiera`.
2. Comparar los tres montos contra `creditos`. Reportar: ops con diferencia real (≥$1.000), ops del export que no están en BD, y ops de la BD del mes (canal AutoFin) que no vienen en el export.
3. **Antes de corregir cualquier monto**: verificar que el mes NO esté en `ctb_meses_cerrados`; recordar que la carga Trinidad solo rellena vacíos (`!(Number(r[c]) > 0)`) — re-subir el archivo NO corrige una op con monto errado, hay que corregirla dirigidamente.
4. Si Pato aprueba correcciones: corregir los montos, recalcular la cuota con el motor único (cuotaFrancesa) y correr `recalcularMeses` — la comisión del dealer se deriva del saldo precio. El recálculo de un mes tarda >2 min: lanzarlo en segundo plano y avisar.
5. Entregar resumen corto: N ops cuadradas, N con diferencia (detalle op por op con antes/después), N faltantes por lado. Formato es-CL.

Referencia del caso julio 2026: 57 ops, solo 3 con diferencia real; la OP 89246 venía inflada en $7,5M y habría pagado $510.000 de más en comisión de dealer.
