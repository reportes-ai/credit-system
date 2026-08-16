---
name: cierre-mes
description: Revisión previa al Cierre de Mes - verifica en BD los puntos del checklist, eventos contables sin asiento y pendientes, y entrega el semáforo con lo que falta para poder cerrar.
---

# Revisión de Cierre de Mes

Objetivo: dejar a Pato un semáforo claro de qué falta para cerrar el mes. Esta skill SOLO LEE — el cierre mismo se ejecuta en la pantalla /tesoreria/cierre-mes (permiso `cierre_mes_cerrar`), nunca desde aquí.

El mes a revisar es el que Pato indique; si no indica, el mes calendario anterior al actual (hora de Chile).

## Pasos

1. **Estado del checklist paramétrico**: consultar `cierre_checklist_items` (activos) y `cierre_mes_checks` del mes — listar cada punto con su responsable, si está OK y si venció su día hábil límite. Ver si el mes ya está en `ctb_meses_cerrados` (si ya está cerrado, reportarlo y parar).

2. **Eventos contables sin asiento**: `ctb_eventos_log` del mes con `estado <> 'CONTABILIZADO'` — agrupar por estado (SIN_REGLA / DESCUADRE / ERROR) y tipo de evento. Cada SIN_REGLA es una regla que falta cablear en Reglas de Centralización: nombrarla.

3. **Chequeos espejo de los check_auto** (mismas fuentes que usa la pantalla):
   - Conciliación: `banco_movimientos` del mes sin conciliar.
   - Transitorias: cuentas activas con saldo sin aplicar.
   - ODP: órdenes EMITIDAS sin pagar del mes.
   - Provisiones: snapshot del mes presente en `contab_saldos_mensuales`.

4. **Coherencia de fechas**: correr el vigía (`require('./shared/vigia-relojes').revisar()`) para descartar marcas del futuro antes de congelar el mes.

5. **Cuadratura de comisiones y cartolas**: verificar que no queden cartas OTORGADAS con crédito en estado distinto (gotcha op 26080532: comparar SIEMPRE con UPPER()) y que las cartolas del mes estén emitidas.

## Entrega

Tabla-semáforo: punto → estado (✅ listo / 🟡 pendiente con responsable / 🔴 bloqueante) → dónde se resuelve (link a la pantalla). Cerrar con la lista corta de acciones que faltan y quién las hace. Español chileno, corto, números formato es-CL.

Recordatorio final si todo está verde: el botón CERRAR MES está en /tesoreria/cierre-mes, exige los obligatorios OK, congela el acta en `cierre_mes_actas`, pone el candado en `ctb_meses_cerrados` y manda el acta por correo.
