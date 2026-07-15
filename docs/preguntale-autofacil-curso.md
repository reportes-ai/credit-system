# Curso de "Pregúntale a AutoFácil" — 12.000 preguntas, 43 categorías

> Entrenamiento realizado por Claude (Fable 5) el 2026-07-14, replicando el método de
> [Pregúntale a Finanzas](finanzas-ia-curso.md). Banco de **12.000 preguntas** desde 4
> perfiles (gerente comercial/director, ejecutivo comercial, analista de cobranza, persona
> sin conocimientos), combinando 12 ejecutivos reales, 15 dealers top, 10 parques, 3
> canales, 6 estados del pipeline, 6 métricas y 31 períodos (19 meses + trimestres + años).
> Las recetas verificadas contra la BD quedaron en el GLOSARIO + CURSO ACELERADO de
> `services/ia/src/controllers/consulta.controller.js`.
> Banco completo: [preguntale-autofacil-banco.json](preguntale-autofacil-banco.json).

## Composición

| Perfil | Preguntas | Ejemplo |
|---|---|---|
| Ejecutivo comercial | 9.279 | "¿Cuántas operaciones nos dio Alvearautos en marzo 2026?" |
| Gerente / director | 1.942 | "¿Cuál es la conversión de aprobado a otorgado? Para el comité." |
| Analista de cobranza | 413 | "Mora por tramo con provisión, separado prejudicial y judicial" |
| Lego | 366 | "¿Qué es una carta de aprobación? Con peras y manzanas." |

Incluye **60 preguntas prohibidas** (finanzas de la empresa e información personal de
empleados) y **40 trampas** (estados en columna equivocada, tablas vacías, simulaciones).

## Bugs REALES encontrados por el entrenamiento (corregidos en v125.2)

1. **"¿Cuántos rechazados?" respondía 0**: el glosario mandaba a usar `creditos.estado`,
   que está NULL en todo lo no otorgado. La columna real del pipeline es
   **`estado_credito`** (RECHAZADO 6.060, DESISTIDO 5.468, APROBADO 726, DIGITADO 325…),
   con valores en mayúscula mixta ('Digitado') → siempre `UPPER()`.
2. **Canal Unidad = 0 filas**: en BD es `'UNIDAD DE CREDITO'`, no `'UNIDAD'` (mismo bug
   que se corrigió en Finanzas). Valores reales: AUTOFIN · UNIDAD DE CREDITO · AUTOFACIL ·
   AFA · NO APLICA.
3. **`dealers.nombre` no existe**: el nombre es `nombre_razon` / `nombre_indexa`.
4. **`cartas_aprobacion` no tiene columna estado**: vigente = todas las fechas de
   desenlace (otorgado/desistimiento/anulación/eliminación/rechazo) en NULL.

## Qué aprendió (resumen de recetas)

- **Pipeline**: conteos por `UPPER(estado_credito)`; tasa de aprobación y conversión con
  denominador explícito; mes contable = `creditos.mes`.
- **Matriz entidad×período** (7.440 preguntas): operaciones/monto/ticket/participación de
  cualquier ejecutivo, dealer (`nombre_razon` con `UPPER LIKE`), parque (`ccs_parque`) o
  canal en cualquier mes/trimestre/año; comparación contra período anterior.
- **Cobranza**: mora/provisión/castigo SIEMPRE vía herramientas (motor de Reportería
  Cobranzas); `cobranza_gestiones` y `pagos_credito` están vacías hoy → decirlo, no
  responder "0" como dato; cuotas y saldo insoluto en `cuotas_credito`.
- **Histórico**: ~14.000 operaciones desde dic-2016 (incluye cartera INDEXA), ~16.000
  clientes, ritmo actual ~55-95 otorgadas/mes; mes en curso incompleto.
- **Lego**: sin jerga, analogía + ejemplo con números reales.
- **Límites**: no simula escenarios, no evalúa créditos, no aconseja inversiones.

## Prohibiciones (pedidas por Pato, v125.2)

1. **Finanzas de la empresa** (resultados, gastos, presupuesto, balance, caja, EBITDA,
   proveedores, remuneraciones, deuda matriz): deriva a **Pregúntale a Finanzas**
   (Contabilidad) y no lo aproxima con tablas de créditos.
2. **Información personal de colaboradores** (sueldo, RUT, teléfono, correo, edad,
   dirección, salud, AFP, licencias): **nunca**, a nadie — solo producción comercial
   agregada. Blindaje doble: regla en el prompt **+** filtro técnico (el esquema solo
   expone id/nombre/apellido/perfil/estado de `usuarios` y el guard SQL rechaza las
   columnas personales aunque la IA intente).

Cupo de lecciones 👎 inyectadas al prompt: 40 → 80.
