# Pruebas automatizadas

```bash
npm test
```

Sin dependencias: usa `node --test`, que viene incluido en Node. Corren en menos
de un segundo y **no tocan la base de datos** — todas prueban motores puros.

## Por qué existen

Hasta el 03-08-2026 el sistema no tenía ni una prueba. Estos son los defectos que
llegaron a producción en una sola semana y que estas pruebas habrían detenido:

| Defecto | Consecuencia | Prueba que lo cubre |
|---|---|---|
| `"320.118"` leído como 320 | 22 operaciones con primas de $1 a $500 durante semanas; ingreso por seguros en cero | `num-chile.test.js` |
| Etapa escrita en 2 de 3 columnas | OP 89343 se veía otorgada pero quedaba fuera de cartolas y comisiones | `etapa-credito.test.js` |
| `MAX()+1` no atómico | Error 500 al usuario si dos personas otorgan a la vez | `num-op.test.js` |

## Qué se cubre

| Archivo | Motor | Qué protege |
|---|---|---|
| `num-chile.test.js` | `shared/num-chile.js` | Lectura de montos en formato chileno (punto = miles) |
| `rentabilidad-core.test.js` | `public/js/rentabilidad-core.js` | Cuota francesa, tabla de desarrollo, tramo 200 UF |
| `mora-core.test.js` | `public/js/mora-core.js` | Días de mora, umbral de gastos día 21, PREPAGADO vs TERMINADO |
| `rut-core.test.js` | `public/js/rut-core.js` | DV módulo 11, forma canónica, casos `K` y `0` |
| `etapa-credito.test.js` | `shared/etapa-credito.js` | Las tres columnas se escriben juntas; cartera ≠ etapa |
| `num-op.test.js` | `shared/num-op.js` | Correlativo AAMM####, reintento ante carrera |
| `mora-calc.test.js` | `shared/mora-calc.js` | Interés por mora a TMC fija al otorgar; gastos por tramos marginales |
| `comision-ejecutivo.test.js` | `shared/comision-ejecutivo.js` | Piso del mes, tramo de 24 cuotas exactas, umbrales de cruce, calidad todo o nada |

## Reglas para agregar pruebas

1. **Solo motores puros.** Si necesita base de datos, no va acá: usa un doble
   (ver `fakeDb` en `num-op.test.js`).
2. **Cada prueba nombra la regla de NEGOCIO**, no la función. `'el día 21 de mora
   habilita los gastos de cobranza'` sirve; `'test gastos()'` no.
3. **Cuando un bug llegue a producción, primero la prueba que lo reproduce**, y
   después el arreglo. Así no vuelve.
4. **Si una prueba falla, primero sospecha de la prueba.** Al escribir estas, tres
   fallaron por suposiciones equivocadas del autor y no por defectos del motor
   (el campo era `valor_cuota` y no `monto`; todo pagado da `TERMINADO`/`PREPAGADO`
   y no `VIGENTE`). Verificar contra el código antes de "corregir" el motor.

## Motores que hubo que liberar para poder probarlos

Dos cálculos vivían dentro de controllers que **corren migraciones al importarse**:
probarlos habría significado levantar la base de producción. Se movieron a `shared/`
tal cual, sin cambiar una línea de lógica, y el controller los sigue consumiendo desde
ahí — no hay una segunda copia (Máxima 1).

| Se movió | De | A |
|---|---|---|
| Interés por mora + gasto de cobranza | `cobranza.controller.js` | `shared/mora-calc.js` |
| Comisión del ejecutivo | `comisiones.controller.js` | `shared/comision-ejecutivo.js` |

`comision-ejecutivo.js` además carga `semana-corrida` de forma **perezosa**: ese módulo
arrastra la tabla de feriados, que se siembra contra la BD al importarse.

**Si un motor no se puede probar sin la base, ese es el hallazgo** — no una excusa para
no probarlo.

## Lo que todavía NO se cubre

- Comisión de **dealer** (tabla individual del dealer, depende de BD).
- Motor de asientos contables.
- Penetración de seguros y rentabilidad por carta.
- Todo lo que toque base de datos, HTTP o el DOM.

Para eso está `docs/qa-plan-produccion.md`, que son pruebas manuales.
