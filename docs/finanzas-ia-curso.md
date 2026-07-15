# Curso de "Pregúntale a Finanzas" — 10.000 preguntas, 33 recetas

> Entrenamiento realizado por Claude (Fable 5) el 2026-07-14. Se generó un banco de
> **10.000 preguntas** desde 3 perfiles reales (persona de finanzas, director de empresa,
> persona que no entiende de finanzas), combinando las **68 cuentas de gasto**, 13 de
> ingreso, 9 rubros gerenciales, 15 proveedores top, 10 bancos, 3 canales y los 18 meses
> con libros (2025-01 → 2026-06). Cada pregunta es instancia de una **categoría**; la
> respuesta correcta de cada categoría se verificó contra la BD y se destiló en el
> **CURSO ACELERADO** del system prompt del motor
> (`services/contabilidad/src/controllers/finanzas-ia.controller.js`).
> Banco completo: [finanzas-ia-banco-preguntas.json](finanzas-ia-banco-preguntas.json).

## Composición del banco

| Perfil | Preguntas | Ejemplo |
|---|---|---|
| Finanzas (analista/contador) | 9.019 | "¿Cuánto gastamos en arriendos en marzo 2026?" |
| Director de empresa | 456 | "¿Cómo vamos contra el presupuesto? Para el directorio de mañana." |
| Lego (no sabe de finanzas) | 525 | "¿La empresa está bien o mal de plata? Con peras y manzanas." |

## Las 33 recetas (cómo se responde bien cada categoría)

### Perfil finanzas
1. **gasto_cuenta_mes** (3.672): buscar la cuenta por nombre `LIKE` en `ctb_cuentas`, sumar `debe-haber` de movimientos CONTABILIZADOS del mes, excluir `CIERRE_EJERCICIO`.
2. **gasto_cuenta_evolucion** (1.224): mismo filtro agrupado por `DATE_FORMAT(c.fecha,'%Y-%m')`; gráfico de barras por mes.
3. **gasto_cuenta_comparacion** (1.224): mes vs mes anterior con variación % es-CL.
4. **gasto_cuenta_yoy** (408): mismo mes año anterior; `pyg_rubros` si es a nivel rubro.
5. **gasto_cuenta_ppto** (408): real vs `ctb_presupuesto` (sentido natural, positivo) de la misma cuenta/mes.
6. **gasto_cuenta_anual** (136) y 7. **gasto_cuenta_trimestre** (408): rangos de fechas; Q1=ene-mar… año calendario.
8. **gasto_cuenta_movs** (68): detalle de movimientos con glosa y comprobante, LIMIT.
9. **ingreso_cuenta_mes/evolucion** (702): igual pero `haber-debe`.
10. **proveedor_total/mes/detalle** (120): `ctb_compras_aux` por `razon_social` (ahí sí existe esa columna).
11. **top_proveedores_mes / top_gastos_mes** (36): ranking con LIMIT; ideal para gráfico.
12. **iva_mes** (18): `SUM(iva)` de `ctb_compras_aux` del mes (IVA crédito).
13. **remun_mes** (18): `ctb_remun_aux`: líquidos + `COUNT(DISTINCT rut)` personas.
14. **honorarios_mes** (18): `ctb_honorarios_aux` — columna `nombre`, NO `razon_social`; bruto/retención/líquido.
15. **balance_fecha** (18): herramienta `balance_general` al último día del mes.
16. **eerr_mes** (18): herramienta `estado_resultados` primer-último día.
17. **desviacion_ppto** (18): herramienta `pyg_rubros` (trae real, año anterior y ppto).
18. **saldo_banco / saldo_banco_mes / caja_total** (153): saldo = `SUM(debe-haber)` acumulado; negativo = línea de crédito girada (BICE), no error; meses de caja = caja ÷ gasto mensual promedio.
19. **rubro_mes** (324): SIEMPRE con `pyg_rubros`, nunca armado a mano.
20. **ventas_mes** (18): `ctb_ventas_aux`; ~93% se factura a AUTOFIN S.A. (comisión de producción).

### Perfil director
21. **gestion** (200): 2-3 cifras clave + tendencia + comparación (ppto y año anterior) + recomendación. Sin maquillar: 2026 viene bajo presupuesto en ingresos y con pérdida mensual.
22. **gestion_mes** (75): igual, anclado al mes pedido; advertir hitos (jun-25 extraordinario, dic-25 ajustes de cierre, jun-26 capitalización).
23. **rubro_periodo / rubro_analisis** (63): rubro sobre ingresos (peso %), tendencia y cierre proyectado contra ppto anual.
24. **produccion_canal / monto_canal** (144): herramienta `produccion_mensual`; en BD Unidad = `UNIDAD DE CREDITO` (el motor traduce). Nunca contar asientos como operaciones.
25. Proyecciones: promedio últimos 3 meses reales × meses restantes + acumulado, declarado como proyección simple.

### Perfil lego
26. **educativa** (375): definir sin jerga, con analogía doméstica y un ejemplo con números nuestros. Balance = foto de lo que se tiene y se debe; EERR = película de lo que entró y salió; depreciación no es plata que se paga.
27. **cuenta_explicada** (68): qué es la cuenta + cuánto llevamos este año.
28. **simple_mes** (72): "entró X, salió Y, resultado Z" en millones, una frase de contexto.

### Trampas (30, los 3 perfiles)
29. Operaciones ≠ asientos contables (~10× menos): usar `produccion_mensual`.
30. No hay libros 2024: decirlo, no inventar. Mes en curso incompleto: advertirlo.
31. Solo lectura: no puede borrar/modificar; no da consejos de inversión personal.
32. Sueldos por persona: entregar agregados/promedios, no el detalle individual.
33. Fuera de ámbito (clientes, cobranza, producción comercial fina) → derivar a "Pregúntale a AutoFácil".

## Qué cambió en el motor (v125.1)
- **Bug corregido**: `produccion_mensual` con `financiera='UNIDAD'` devolvía 0 filas (en BD es `UNIDAD DE CREDITO`); ahora se mapea.
- **CURSO ACELERADO** agregado al system prompt: hitos (jun-25, dic-25, capitalización jun-26), realidad 2026 vs ppto, adaptación del registro por perfil, punto de equilibrio, EBITDA aproximado, UF futura, columnas reales de los auxiliares, bancos en negativo, trimestres, límites (solo lectura, sin datos 2024).
- Cupo de lecciones activas inyectadas al prompt: 40 → 80 (las correcciones 👎 de los usuarios no se desplazan).
