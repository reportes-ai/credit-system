---
name: informe-ecuador
description: Prepara y valida el informe mensual de Cierre Contable para Casa Matriz Ecuador - verifica las 6 secciones contra BD antes de que Tesoreria lo envie.
---

# Informe mensual a Ecuador (Cierre Contable)

El informe vive en `/tesoreria/cierre-contable` (API `/api/cierre-contable?mes=YYYY-MM`). Esta skill NO envía nada: verifica que las 6 secciones estén completas y cuadradas para el mes que Pato indique (default: el mes anterior), y reporta qué falta.

## Las 6 secciones y cómo validarlas

1. **Negociaciones** (venta de cartera) — manual, casi siempre $0. Verificar que el JSON del mes exista en `cierre_contable_meses`.
2. **Cartera Vigente** — cartera propia antigua: `creditos.origen IN ('CARTERA_AFA','CARTERA_XLSX')` con capital pendiente > 0, foto al cierre desde `cuotas_credito`. Verificar: total de ops y capital contra el mes anterior (variación razonable), y que el t/c USD del mes esté cargado (es manual — si falta, es bloqueante).
3. **Producción** — otorgadas del mes con `origen IS NULL`: financiado, `comdea_real` (bruta c/IVA; neta = /1.19), `com_parque`. Verificar que no haya ops del mes sin comisión calculada.
4. **Saldos precio pendientes** — `cierre_saldos_pagados` es marca MANUAL por op: listar las ops del mes sin marcar y recordar que las anuladas quedan fuera solas.
5. **Recompras** — manual, casi siempre $0.
6. **Tablas de desarrollo** — export de `cuotas_credito` de la cartera vigente: verificar que ninguna op vigente tenga cuotas faltantes o duplicadas (gotcha: renegociaciones traían cuota 1 duplicada).

## Chequeos transversales antes de dar el visto bueno

- El mes debe estar CERRADO (candado en `ctb_meses_cerrados`) o al menos con el checklist de `/tesoreria/cierre-mes` completo — un informe sobre un mes abierto puede cambiar después de enviado.
- `ctb_eventos_log` del mes sin eventos `SIN_REGLA`/`DESCUADRE`/`ERROR`.
- Comparar los totales de la API contra una query directa (doble vía): si difieren, investigar antes de reportar.

## Entrega

Semáforo por sección (✅/🟡/🔴) + lista corta de lo manual que falta (t/c USD, negociaciones, recompras, marcas de saldos) con el responsable. Números formato es-CL. Si todo verde: "listo para que Tesorería lo envíe".
