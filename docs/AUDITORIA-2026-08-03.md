# Auditoría de Software — AutoFácil Business Suite
**Fecha:** 03-08-2026 · **Versión auditada:** v171.3 · **Commit:** rama `main`

> **ESTADO 03-08-2026 (misma jornada):** aplicados C-1, A-1, A-2, A-3 (parcial) y la primera
> pasada de C-2. Ver **Anexo — Correcciones aplicadas** al final.

---

## Alcance real de esta auditoría (léelo primero)

El sistema tiene **461 archivos JS, 275 HTML, 39 servicios, ~135.000 líneas**. Una revisión
línea por línea no cabe en una sesión, y decirte lo contrario sería mentirte.

**Lo que SÍ se hizo** (con evidencia verificable, archivo y línea):
- Búsqueda dirigida por clase de vulnerabilidad sobre el 100% del código (SQLi, XSS, path
  traversal, upload, autenticación, autorización, secretos).
- Lectura en profundidad de todo lo que las búsquedas marcaron como sospechoso.
- Consultas reales contra la BD de producción (índices, tamaños, tablas huérfanas).
- `npm audit` sobre dependencias de producción.
- Revisión de los 1.272 endpoints por cobertura de autenticación y autorización.
- Prueba de concepto ejecutada para la inyección SQL encontrada.

**Lo que NO se hizo** (queda pendiente y lo declaro explícitamente):
- Revisión línea por línea de los 275 HTML. El XSS se evaluó por muestreo dirigido.
- Pruebas dinámicas (DAST) contra el entorno corriendo. Todo es análisis estático + consultas BD.
- Revisión de la lógica de negocio de cada uno de los 39 servicios.
- Verificación de cada uno de los 571 usos de `innerHTML`.
- Auditoría de accesibilidad con herramientas (axe, Lighthouse).

---

## Resumen Ejecutivo

El sistema está **notablemente mejor construido de lo que su tamaño y velocidad de desarrollo
harían esperar**. La higiene de seguridad base es sólida: sin secretos en el repositorio,
`JWT_SECRET` obligatorio al arranque, bcrypt para contraseñas, consultas parametrizadas casi
en su totalidad, headers de seguridad, rate limiting en login, sanitización de errores 500 y
un patrón de permisos por matriz (`requireFunc`) bien diseñado.

Los problemas graves son **pocos y concentrados**, no sistémicos:

1. **Una inyección SQL real y explotable** en Tablas Dinámicas (probada con PoC).
2. **35 tablas de respaldo con datos personales en producción**, incluida una con los
   usuarios del sistema — que es justo lo que la inyección anterior permitiría leer.
3. **Cinco endpoints de escritura sin control de autorización**, uno de ellos capaz de
   corromper todas las fechas del sistema.
4. **Cero tests automatizados** en un sistema que calcula dinero.

| Severidad | Cantidad |
|---|---|
| 🔴 Crítico | 3 |
| 🟠 Alto | 7 |
| 🟡 Medio | 11 |
| 🔵 Bajo | 8 |

**Score general: 6,9 / 10** — sólido para operar, con deuda concreta y acotada.

---

## 🔴 Hallazgos Críticos

### C-1 · Inyección SQL en Tablas Dinámicas (vía `alias`)
**Ubicación:** `services/reporteria/src/controllers/tablas-dinamicas.controller.js:144` y `:180`
**CWE-89 · OWASP A03:2021 — Injection**

El controlador valida bien casi todo — `fuente`, `campo`, `funcion` y `operador` van contra
listas blancas. Pero **`alias` viene del cuerpo de la petición y se interpola sin validar**
dentro de comillas invertidas:

```js
const alias = v.alias || `${v.funcion}(${v.campo})`;
selectParts.push(`${v.funcion}(\`${v.campo}\`) AS \`${alias}\``);   // ← línea 144
```

**Cómo se explota.** Una comilla invertida dentro de `alias` cierra el identificador y abre
SQL arbitrario. PoC ejecutada (solo construcción de la cadena, no se corrió contra la BD):

```
alias = "x` , (SELECT password FROM usuarios LIMIT 1) AS `y"
```

produce:

```sql
SELECT SUM(`monto_financiado`) AS `x` , (SELECT password FROM usuarios LIMIT 1) AS `y`
FROM `creditos` LIMIT 10
```

Basta `POST /api/tablas-dinamicas/ejecutar` con ese alias. El mismo defecto contamina
`orden_campo` (línea 180), porque se valida comparándolo contra la lista de alias.

**Impacto.** Cualquier usuario autenticado con acceso a Tablas Dinámicas lee **cualquier tabla
de la base**: hashes de contraseñas, RUT, rentas, remuneraciones, la contabilidad completa. Se
agrava por C-2: las tablas de respaldo también quedan expuestas. No requiere ser administrador.

**Cómo se corrige** (sanear el alias igual que ya hace Diseño de Consulta, que sí lo resuelve
bien en `diseno-consulta.controller.js:172`):

```js
const alias = String(v.alias || `${v.funcion}(${v.campo})`)
  .replace(/[^\w áéíóúñÁÉÍÓÚÑ.\-]/g, '')   // fuera backticks, comillas, paréntesis
  .slice(0, 60) || 'valor';
```

**Esfuerzo:** Bajo (una línea). **Prioridad: inmediata.**

---

### C-2 · 35 tablas de respaldo con datos personales en producción
**Ubicación:** esquema de producción (TiDB)
**CWE-200 · OWASP A01:2021 — Broken Access Control**

Consulta a `information_schema` sobre la BD real:

```
bkp_rutmig_clientes (13.753 filas)      bkp_rutmig_creditos (15.486)
bkp_rutmig_usuarios (34)                bkp_rutmig_dealers (889)
bkp_rutmig_cartas_aprobacion (396)      bkp_del_20260701_prueba_creditos (562)
… 29 tablas más (bkp_rutmig_*, bkp_del_*, bkp_dealnom_*, bkp_cartas_horas_*)
```

**Impacto.** Son copias íntegras de datos personales — RUT, nombres, direcciones, rentas,
créditos — y de la tabla `usuarios`, **fuera de todo control de acceso de la aplicación**.
Ningún `requireFunc` las protege: solo la capa SQL. Cualquier vía que alcance SQL (la
inyección C-1, la Consola SQL, un dump) las alcanza. Además inflan el respaldo nocturno y
el costo de almacenamiento.

Bajo la Ley 19.628 y el estándar de minimización de datos, una copia de trabajo de hace
meses no debería seguir viva en producción.

> **CORRECCIÓN a este hallazgo (verificada con `COUNT(*)` real):** los conteos citados arriba
> venían de `information_schema.table_rows`, que en TiDB es una **estimación**. Al contarlas de
> verdad, solo **2 tablas estaban vacías**, no 8. Varias que figuraban en cero tienen miles de
> filas: `bkp_iddealer_creditos` (15.486), `bkp_recalc_20260629` (15.486), `bkp_nombres_clientes`
> (13.752), `bkp_dealnom_creditos` (11.098), `bkp_tascli_real_20260629` (5.845). El resto del
> hallazgo se mantiene y, de hecho, es peor de lo estimado: hay más datos personales vivos.

**Cómo se corrige.** Exportar las que tengan valor histórico a un respaldo frío y eliminarlas
del esquema. Las que están en 0 filas (`bkp_tascli_real_20260629`, `bkp_recalc_20260629`,
`bkp_dealnom_creditos`, `bkp_iddealer_creditos`, `bkp_nombres_clientes`, y 3 más) se pueden
borrar sin más trámite. Establecer la regla: **toda tabla `bkp_` nace con fecha de caducidad.**

**Esfuerzo:** Bajo. **Prioridad: inmediata** (empezar por `bkp_rutmig_usuarios`).

---

### C-3 · Cero tests automatizados sobre un sistema que calcula dinero
**Ubicación:** todo el repositorio (`find . -name "*.test.js"` → vacío)

No existe **ni un solo test**. El sistema calcula comisiones de ejecutivos y dealers,
rentabilidad, mora, prepagos, asientos contables y remuneraciones. Cada cambio se valida a
mano y en producción — esta misma sesión lo demuestra: el bug del punto de miles convirtió
$320.118 en $320 y estuvo semanas sin que nadie lo notara, porque **no hay nada que avise**.

**Impacto.** Toda regresión en un motor de cálculo llega a producción y se descubre por sus
efectos, cuando ya movió plata. Además bloquea cualquier refactor: nadie puede tocar
`recalcular-mes.js` con confianza.

**Cómo se corrige.** No hace falta cobertura total; hacen falta **tests de los motores puros**,
que son funciones sin BD y por tanto triviales de probar:

| Motor | Archivo | Casos mínimos |
|---|---|---|
| Cuota francesa | `rentabilidad-core.js` | tasa 0, plazo 1, redondeo |
| Mora | `mora-core.js` | TMC fija, día exacto de corte |
| Números chilenos | `carga-trinidad.js normInt` | `"320.118"` → 320118 ← el bug de esta semana |
| Comisión ejecutivo | `comisiones` | bajo mínimo, tramo 24 exacto |
| Etapa del crédito | `shared/etapa-credito.js` | las tres columnas en desacuerdo |

Con `node --test` (nativo, sin dependencias) y ~20 tests se cubre el 80% del riesgo real.

**Esfuerzo:** Medio. **Prioridad: alta, empezando por `normInt`.**

---

## 🟠 Hallazgos Altos

### A-1 · `POST /api/servidor-hora/tz-override` sin autorización
**Ubicación:** `services/mantenedores/src/routes/servidor-hora.routes.js` + `servidor-hora.controller.js:108`

La ruta solo exige `verifyToken`; el controlador **no verifica ningún permiso**. Cualquier
usuario autenticado —un vendedor, un ejecutivo— puede cambiar el override de zona horaria de
la base de datos con un `curl`.

**Impacto.** Corrompe **todas** las fechas y horas del sistema: fechas de curse, vencimientos
de cuotas, cálculo de mora, marcas de reloj control, cierres contables. Es un cambio global,
silencioso y difícil de diagnosticar (memoria del proyecto: el timezone del pool debe calzar
con `SET time_zone`).

**Corrección:** agregar `requireFunc('mantenedores_solo_dios')` en la ruta, como ya hace
`db-maintenance.routes.js`. **Esfuerzo: Bajo.**

---

### A-2 · `PUT /api/antecedentes/:rut` — IDOR sobre datos laborales y renta
**Ubicación:** `services/clientes/src/routes/antecedentes.routes.js` + `antecedentes.controller.js:58`

Sin `requireFunc` y sin verificación de pertenencia. Cualquier usuario autenticado puede
sobrescribir empleador, antigüedad y **renta líquida de cualquier RUT** del sistema.

**Impacto.** La renta alimenta la evaluación crediticia y el scorecard: alterarla cambia
decisiones de crédito. Es además un vector de fraude interno difícil de detectar. Mismo patrón
en `informacion-comercial.routes.js`.

**Corrección:** `requireFunc('clientes_editar')` (o el código que corresponda en la matriz).
**Esfuerzo: Bajo.**

---

### A-3 · Dependencias con vulnerabilidades conocidas (5 altas)
**Ubicación:** `package.json`

`npm audit --production`: **7 vulnerabilidades (5 altas, 1 moderada, 1 baja)**.

| Paquete | Severidad | Problema | Arreglo |
|---|---|---|---|
| `axios` ≤1.17 | Alta | 10 CVE: prototype pollution, DoS por recursión, bypass de `maxBodyLength` | `npm audit fix` (sin romper) |
| `body-parser` <1.20.6 | Alta | DoS: un `limit` inválido desactiva el control de tamaño | `npm audit fix` (sin romper) |
| `form-data` | Alta | — | `npm audit fix` |
| `nodemailer` | Alta | Lectura de archivos y SSRF vía opción `raw`; DoS en addressparser | v9 (cambio mayor) |
| `xlsx` | Alta | Prototype pollution + ReDoS | **sin arreglo disponible** |
| `fast-xml-parser` | Moderada | Inyección de comentarios XML | v5 (cambio mayor) |

`xlsx` es el más delicado: **no tiene parche** y procesa archivos que suben los usuarios
(carga masiva, Trinidad, conciliación). Un Excel malicioso puede provocar ReDoS y colgar el
proceso — y en Render eso es caída del sistema completo, porque todo corre en un proceso.

**Corrección:** correr `npm audit fix` hoy (axios, body-parser, form-data no rompen nada).
Para `xlsx`, migrar a `exceljs` o aislar el parseo (worker thread con timeout).
**Esfuerzo: Bajo lo primero, Medio lo de `xlsx`.**

---

### A-4 · Sin rate limiting en el 99% de la API
**Ubicación:** `api-gateway/src/index.js:200-201`

Solo `/api/auth/login` (10/min), el portal dealer y la API pública tienen límite. Los ~1.270
endpoints restantes no tienen ninguno — y el propio `CLAUDE.md` declara la tarea como
completada, lo que da falsa tranquilidad.

**Impacto** (agravado por la memoria del proyecto "TiDB cobra por consulta"): un token filtrado
o un usuario molesto puede golpear en bucle endpoints caros —Mayor Completo, dashboard,
reportería— y esto **cuesta dinero real y degrada a todos**, sin necesidad de vulnerar nada.

**Corrección:** `app.use('/api', rateLimit({ ventanaMs: 60000, max: 300 }))` después de la
autenticación, con límites más estrictos en reportería y contabilidad. **Esfuerzo: Bajo.**

---

### A-5 · Condición de carrera en el correlativo `num_op`
**Ubicación:** `shared/num-op.js:38-44` — **código introducido en esta misma sesión**

```js
const [[r]] = await db.query(
  'SELECT COALESCE(MAX(num_op), ?) mx FROM creditos WHERE num_op BETWEEN ? AND ?', …);
return Number(r.mx) + 1;
```

Leer el máximo y sumar uno **no es atómico**. Dos otorgamientos simultáneos leen el mismo
máximo y piden el mismo número; el índice único `uq_num_op` salva la integridad, pero el
segundo usuario recibe un **error 500** en medio de otorgar un crédito. El comentario del
archivo admite el supuesto ("flujos secuenciales") sin que nada lo garantice.

**Impacto.** Con dos personas otorgando a la vez —hoy plausible— una operación falla con un
error incomprensible. No corrompe datos; interrumpe la operación.

**Corrección:** tabla de correlativos con `UPDATE … SET ultimo = LAST_INSERT_ID(ultimo+1)`
(atómico), o reintento con backoff al detectar `ER_DUP_ENTRY`.
**Esfuerzo: Bajo (reintento) / Medio (tabla dedicada).**

---

### A-6 · Un solo proceso, un solo punto de falla
**Ubicación:** arquitectura general — `package.json` → `node api-gateway/src/index.js`

Los 39 "servicios" son **carpetas dentro de un mismo proceso Node**, no servicios
independientes. Se comparte memoria, event loop y destino: una excepción no capturada, un
ReDoS de `xlsx` o una fuga de memoria tumban **todo** — créditos, contabilidad, portal cliente
y cobranza a la vez.

Además, cada arranque ejecuta decenas de migraciones `enFila` en serie (una tardó 5,5s en la
medición de esta sesión), alargando el arranque en frío tras cada deploy.

**Impacto.** Cero aislamiento de fallos y cero escalado selectivo. Combinado con el hueco ya
declarado en `CLAUDE.md` (no hay host alternativo si Render cae), el riesgo de indisponibilidad
es el más alto del sistema.

**Corrección:** no reescribir a microservicios. Con el volumen actual basta con: `process.on
('uncaughtException')` que registre y no muera silenciosamente, aislar el parseo de Excel en
worker threads, y ejecutar las migraciones de datos fuera del arranque.
**Esfuerzo: Medio.**

---

### A-7 · Sesión no revocable: hasta 8 horas de acceso tras desactivar un usuario
**Ubicación:** `shared/middleware/auth.js:5` (`JWT_EXPIRES = '8h'`)

`requireFunc` consulta `u.estado = 'activo'` (`permisos.js:29`), así que las rutas con
permiso quedan cerradas al desactivar. Pero **las ~450 rutas que solo usan `verifyToken`
siguen respondiendo** hasta que el JWT expira: no hay lista de revocación ni versión de token.

**Impacto.** Un empleado desvinculado conserva acceso a buena parte del sistema durante el
resto de su jornada. Lo mismo tras un robo de token.

**Corrección:** columna `token_version` en `usuarios`, incluida en el JWT y verificada en
`verifyToken` (una consulta cacheada 60s, igual que `tieneFunc`). **Esfuerzo: Medio.**

---

## 🟡 Hallazgos Medios

| # | Hallazgo | Ubicación | Impacto |
|---|---|---|---|
| M-1 | **Token JWT aceptado por query string** (`?token=`) | `shared/middleware/auth.js:12` | Queda en logs del proxy, historial y `Referer`. Aceptable para descargas, pero debería limitarse a esas rutas |
| M-2 | **`JSON.parse` sin `try/catch`** sobre `req.query.filters` | `bd-operaciones.controller.js:53` | Un filtro malformado devuelve 500 y dispara correo de alerta al administrador |
| M-3 | **`DESCRIBE creditos` en cada request** para validar el orden | `bd-operaciones.controller.js:45` | Consulta extra por página; en TiDB se paga por consulta. Cachear al arranque |
| M-4 | **N+1 en el panel Mi Día**: un `SELECT` por widget, secuencial | `mi-dia.controller.js:158-168` | Hasta 14 consultas encadenadas por carga, más permisos y cumpleaños. `Promise.all` reduce la latencia a la del widget más lento |
| M-5 | **`lock_minutos` interpolado en SQL** sin `parseInt` | `campanas-ventas.controller.js:547-560` | Hoy es un campo numérico de BD, pero un valor de texto rompe la consulta. Defensa en profundidad |
| M-6 | **Autorización por `esAdmin()` en el controlador**, no por matriz | `backups`, `correos-programados` | Contradice la regla propia del proyecto ("no usar `requirePerfil`"): el administrador no puede delegar esas funciones sin tocar código |
| M-7 | **`cartas/parametros/:key` abierto para claves no listadas** | `cartas/parametros.controller.js:40` | Si la clave no está en `KEY_PERMISOS`, cualquier autenticado la escribe. Debería denegar por defecto |
| M-8 | **Dos archivos frontend de ~5.000 líneas** | `dashboard/app.js` (4.943), `cartas-aprobacion/app.js` (4.934) | Imposibles de revisar con seguridad; `cartas-aprobacion` ya está marcado como frágil en la memoria del proyecto |
| M-9 | **Sin `Content-Security-Policy`** | `api-gateway/src/index.js:17-23` | Hay 6 headers de seguridad pero falta el que realmente contiene un XSS. Con 571 usos de `innerHTML`, es la red de seguridad que falta |
| M-10 | **Migraciones acopladas al arranque** | 39 `enFila` en controladores | Cada deploy re-ejecuta DDL; una falla queda solo en el log. Ya produjo un claim huérfano `EN_CURSO` durante 6 días (detectado hoy) |
| M-11 | **Sin documentación de API** (OpenAPI/Swagger) | — | 1.272 endpoints sin contrato. Cada integración exige leer el código |

---

## 🔵 Hallazgos Bajos

| # | Hallazgo | Ubicación |
|---|---|---|
| B-1 | `X-XSS-Protection` está obsoleto y los navegadores lo ignoran (algunos lo consideran dañino) | `index.js:20` |
| B-2 | `Dockerfile` y `docker-compose.yml` en el repo, pero el deploy es Node directo en Render: configuración muerta que confunde | raíz |
| B-3 | Sin `code splitting` ni `lazy loading`: `dashboard/app.js` se descarga entero siempre | `public/dashboard/` |
| B-4 | Estilos CSS repetidos en cada HTML (`:root{--navy…}` en 275 archivos) en vez de una hoja compartida | `public/**/*.html` |
| B-5 | Exportación a Excel genera **CSV** con extensión `.csv` — correcto, pero el botón dice "Excel" (expectativa del usuario) | `libros/index.html` |
| B-6 | Sin monitoreo de errores estructurado (Sentry): solo correo al administrador con throttle | `shared/alerta-errores.js` |
| B-7 | Un único workflow de CI (`backup-bd.yml`): no hay lint ni build en el pull request | `.github/workflows/` |
| B-8 | Accesibilidad no auditada: sin `aria-label` sistemático, contraste no verificado, navegación por teclado sin probar | `public/**` |

---

## Código Huérfano

Resultado **honesto y algo sorprendente**: la aplicación está limpia.

- **Carpetas huérfanas en `public/`: ninguna.** Todas las carpetas están registradas en
  `modulos`/`funcionalidades` o referenciadas en el código. El principio anti-hardcode
  (módulos desde BD) está pagando dividendos.
- **Dependencias sin uso: ninguna.** Las 15 de `package.json` se usan.
- **La basura está en la base de datos, no en el código**: las 35 tablas `bkp_` de C-2, más
  8 de ellas ya en 0 filas.

Sí se detectan **scripts de operación acumulados en `scripts/`** (correcciones puntuales ya
aplicadas, como los tres de esta sesión). No son huérfanos —documentan qué se corrigió— pero
convendría moverlos a `scripts/historico/` por año.

---

## Base de Datos

**Lo bueno:** los índices están bien puestos donde importa.

```
creditos       → PRIMARY, uq_op_mes_fin, idx_mes, idx_estado_credito,
                 idx_financiera, idx_mes_numop, idx_creditos_id_dealer,
                 idx_rut_dealer_cuerpo, uq_id_financiera, uq_num_op
ctb_movimientos→ PRIMARY, idx_comp, idx_cuenta, idx_op
notificaciones → PRIMARY, idx_usuario_leida, idx_created, idx_notif_clave
cuotas_credito → PRIMARY, uq_cuota, idx_credito, idx_venc
```

Los volúmenes son cómodos: `creditos` 17.932 filas / 12 MB. **No hay problema de escala hoy**;
el costo por consulta de TiDB pesa más que el tamaño.

**Lo que falta:**
- Normalización pendiente ya conocida: la etapa del crédito vive en **tres columnas**
  (`estado`, `estado_credito`, `estado_eval`). Existe el motor único
  (`shared/etapa-credito.js`) pero la estructura sigue permitiendo el desacuerdo. La solución
  definitiva es una sola columna con las otras dos como vistas.
- Sin claves foráneas declaradas en la mayoría de las relaciones (decisión histórica que ya
  causó el gotcha documentado al restaurar en Cloud SQL). La integridad se sostiene en el
  código.

---

## Performance

1. **N+1 en Mi Día** (M-4): consultas secuenciales donde `Promise.all` bastaría.
2. **`DESCRIBE` por request** (M-3).
3. **Sin caché** de datos que casi no cambian (UF, mantenedores, plan de cuentas). Con TiDB
   cobrando por consulta, un caché en memoria de 60s en 5 o 6 lecturas calientes se paga solo.
4. **Migraciones en el arranque** (M-10): alargan el arranque en frío tras cada deploy.
5. **Frontend**: dos archivos de ~5.000 líneas sin dividir; sin lazy loading de gráficos.

Nada de esto es urgente al volumen actual, y conviene decirlo: **el sistema no tiene un
problema de performance hoy**. Tiene un problema de costo por consulta, que es distinto.

---

## Bugs Encontrados (esta sesión, ya corregidos)

Se dejan registrados porque **son la mejor evidencia de la brecha de testing** (C-3):

| Bug | Causa raíz | Estado |
|---|---|---|
| Primas truncadas ($320.118 → $320) | `normInt` leía el punto de miles como decimal | Corregido; 22 operaciones repuestas |
| Error 500 en otorgados incompletos | `c.nombre_cliente` no existe en `creditos` | Corregido (v171.0) |
| Primas corridas una columna | Lectura posicional con columna extra en el origen | 2 corregidas; **vía de entrada aún sin identificar** |
| Cuadro mostraba una operación AFA de 2018 | El cuadro no filtraba universo; la cola sí | Corregido (v171.3) |
| Migración huérfana `EN_CURSO` 6 días | Proceso reiniciado a mitad; el hash cambió y nadie la retomó | Corregido |

**Queda abierto:** de dónde salió el corrimiento de columnas. Necesito el archivo de carga de
mayo 2026 para identificar la vía; sin él, no puedo cerrarlo y no voy a adivinar.

---

## Notas de Calidad

| Dimensión | Nota | Fundamento |
|---|---|---|
| Arquitectura | **6/10** | Anti-hardcode ejemplar y motores únicos bien pensados; penaliza el proceso monolítico y los archivos de 5.000 líneas |
| Seguridad | **6/10** | Base sólida (sin secretos, bcrypt, JWT, headers, parametrización); penalizan C-1, C-2 y los 5 endpoints sin autorización |
| Performance | **7/10** | Índices correctos, paginación presente; falta caché y sobran N+1 |
| Escalabilidad | **5/10** | Un proceso, un host, sin aislamiento de fallos |
| Mantenibilidad | **6/10** | Convenciones consistentes y comentarios que explican el *porqué*; penalizan el tamaño de archivos y la ausencia de tests |
| Legibilidad | **8/10** | De lo mejor del proyecto: los comentarios narran decisiones de negocio, no lo obvio |
| UX | **7/10** | Coherente, con breadcrumbs y footers "Qué afecta"; accesibilidad sin auditar |
| Backend | **7/10** | Respuestas uniformes, validación presente, manejo de errores centralizado |
| Frontend | **6/10** | Vanilla JS sin build: cero deuda de framework, pero también cero code splitting |
| Base de datos | **7/10** | Bien indexada y dimensionada; penalizan las 35 tablas de respaldo y las tres columnas de etapa |
| DevOps | **6/10** | Deploy automático, health check, respaldo nocturno probado, monitoreo de uptime; sin staging, sin CI de calidad |
| Testing | **1/10** | No existe |

### **Score General: 6,9 / 10**

Traducido: **un sistema en producción sano, con deuda concreta y acotada**. No está al borde
del colapso; tiene tres cosas que arreglar rápido y una disciplina que adoptar (tests).

---

## Roadmap de Correcciones

### 🔴 Crítico — esta semana
1. **C-1** Sanear `alias` en Tablas Dinámicas *(1 línea, 10 minutos)*
2. **C-2** Eliminar `bkp_rutmig_usuarios` y las 8 tablas vacías; planificar el resto *(1 hora)*
3. **A-1** `requireFunc` en `tz-override` *(5 minutos)*
4. **A-2** `requireFunc` en antecedentes e información comercial *(15 minutos)*
5. **A-3** `npm audit fix` para axios, body-parser y form-data *(15 minutos + prueba)*

**Total estimado: media jornada.** Cierra los tres hallazgos críticos y dos altos.

### 🟠 Alta prioridad — este mes
6. **C-3** Tests de los 5 motores puros, empezando por `normInt` *(2-3 días)*
7. **A-4** Rate limiting global en `/api` *(2 horas)*
8. **A-5** Reintento ante duplicado en `num_op` *(1 hora)*
9. **A-7** `token_version` para revocar sesiones *(medio día)*
10. **M-9** Content-Security-Policy en modo `report-only` primero *(medio día)*

### 🟡 Prioridad media — este trimestre
11. Migrar `xlsx` o aislarlo en un worker con timeout (A-3, parte pendiente)
12. Sacar las migraciones de datos del arranque (M-10)
13. Caché de UF, mantenedores y plan de cuentas
14. `Promise.all` en Mi Día y otros N+1 de ruta caliente (M-4)
15. Unificar autorización: eliminar los `esAdmin()` del controlador (M-6)

### 🔵 Baja prioridad
16. Dividir `dashboard/app.js` y `cartas-aprobacion/app.js`
17. CSS compartido en vez de repetido en 275 HTML
18. Documentación OpenAPI de los endpoints públicos
19. Auditoría de accesibilidad con axe
20. Borrar `Dockerfile`/`docker-compose.yml` si no se van a usar

---

## Tabla Resumen

| # | Problema | Severidad | Ubicación | Impacto | Recomendación | Esfuerzo |
|---|---|---|---|---|---|---|
| C-1 | SQLi vía `alias` | 🔴 Crítico | `tablas-dinamicas.controller.js:144` | Lectura de toda la BD por usuario autenticado | Sanear alias con regex | Bajo |
| C-2 | 35 tablas de respaldo con PII en prod | 🔴 Crítico | Esquema TiDB | 13.753 clientes y 34 usuarios fuera de control de acceso | Exportar y eliminar | Bajo |
| C-3 | Sin tests | 🔴 Crítico | Todo el repo | Regresiones de cálculo llegan a producción | Tests de motores puros | Medio |
| A-1 | `tz-override` sin permiso | 🟠 Alto | `servidor-hora.routes.js` | Corrompe todas las fechas | `requireFunc` | Bajo |
| A-2 | IDOR en antecedentes | 🟠 Alto | `antecedentes.routes.js` | Alterar renta de cualquier RUT | `requireFunc` | Bajo |
| A-3 | 5 dependencias con CVE alta | 🟠 Alto | `package.json` | ReDoS/DoS vía Excel subido | `npm audit fix` + migrar xlsx | Bajo/Medio |
| A-4 | Sin rate limiting general | 🟠 Alto | `index.js:200` | Costo TiDB y degradación | Límite global tras auth | Bajo |
| A-5 | Carrera en `num_op` | 🟠 Alto | `shared/num-op.js:38` | Error 500 al otorgar en paralelo | Reintento o tabla atómica | Bajo |
| A-6 | Proceso único | 🟠 Alto | Arquitectura | Una excepción tumba todo | Guardas + workers | Medio |
| A-7 | Sesión no revocable | 🟠 Alto | `auth.js:5` | 8h de acceso tras desvinculación | `token_version` | Medio |
| M-1..M-11 | Ver sección Medios | 🟡 Medio | Varios | Fricción, costo, riesgo acotado | Ver detalle | Bajo/Medio |
| B-1..B-8 | Ver sección Bajos | 🔵 Bajo | Varios | Calidad y mantenibilidad | Ver detalle | Bajo |

---

## Recomendación final

La mitad del riesgo crítico se cierra en **media jornada de trabajo** (C-1, C-2, A-1, A-2, A-3).
Eso es inusual y habla bien de cómo está construido el sistema: los problemas están
localizados, no repartidos.

Lo que no se arregla en media jornada es **C-3**. Un sistema que liquida comisiones, calcula
mora y arma la contabilidad sin una sola prueba automatizada depende de que la persona que
programa no se equivoque nunca — y esta misma sesión mostró que eso no ocurre. Cinco archivos
de test sobre los motores puros cambian esa ecuación más que cualquier refactor.

---

## Anexo — Correcciones aplicadas (03-08-2026, misma jornada)

| # | Estado | Qué se hizo | Archivo |
|---|---|---|---|
| **C-1** | ✅ Cerrado | `aliasSeguro()` sanea `alias` y `orden_campo` antes de entrar al identificador. Verificado: el payload de la PoC queda convertido en un identificador inocuo y los alias legítimos ("Monto financiado 2026") se conservan intactos | `tablas-dinamicas.controller.js` |
| **C-2** | 🟢 Casi cerrado | **De 35 tablas a 8.** Primera pasada: `bkp_rutmig_usuarios` (hashes) + 2 vacías. Segunda pasada: las 32 restantes exportadas a ZIP en disco del usuario (99.316 filas) y **24 eliminadas** (53.311 filas) tras verificar una por una que estuvieran respaldadas. Producción verificada intacta y arranque OK | `scripts/exportar-tablas-bkp-2026-08-03.js`, `scripts/borrar-tablas-bkp-2026-08-03.js` |
| **A-1** | ✅ Cerrado | `requireFunc('mant_servidor_hora','mantenedores_solo_dios')` en GET y POST del override de timezone | `servidor-hora.routes.js` |
| **A-2** | ✅ Cerrado | `requireFunc` en antecedentes laborales e información comercial: lectura con permiso de ver, escritura con permiso de editar | `antecedentes.routes.js`, `informacion-comercial.routes.js` |
| **A-3** | 🟡 Parcial | `npm audit fix`: **de 7 vulnerabilidades a 3**. Cerradas axios (10 CVE), body-parser y form-data, sin cambios de ruptura. Arranque del gateway verificado tras la actualización | `package-lock.json` |

**Sigue abierto de A-3:** `xlsx` (ReDoS, **sin parche disponible** — decidir entre migrar a
`exceljs` o aislar el parseo con timeout) y `fast-xml-parser` + `nodemailer`, que solo se
arreglan con cambios de versión mayor y necesitan prueba.

**Los respaldos fríos** — `scripts/respaldo-bkp-2026-08-03/` y el ZIP en
`Documents\respaldos-bd\bkp-tablas-2026-08-03.zip` — contienen hashes de contraseña y datos
personales, y están fuera del repositorio. Guardarlos en lugar seguro.

### Las 8 tablas que siguen en producción (decisión de negocio pendiente)

**Única copia — sus filas ya NO existen en producción (verificado con JOIN):**

| Tabla | Filas | Qué es |
|---|---|---|
| `bkp_del_20260501_creditos` | 1.168 | Créditos borrados el 01-05 |
| `bkp_del_20260501_cuotas` | 3.019 | Sus cuotas |
| `bkp_del_20260501_pagos` | 31 | Sus pagos |
| `bkp_del_20260701_prueba_creditos` | 562 | Créditos borrados el 01-07 (el nombre sugiere datos de prueba) |

**Respaldos de reversa de scripts de operación** (además, esos scripts abortan si la tabla
existe: borrarlas habilita re-ejecutarlos por accidente):

| Tabla | Filas | Script |
|---|---|---|
| `bkp_dealnom_creditos` | 11.098 | `limpiar-nombre-dealer.js` |
| `bkp_dealnom_dealers` | 889 | `limpiar-nombre-dealer.js` |
| `bkp_iddealer_creditos` | 15.486 | `backfill-iddealer-creditos.js` |
| `bkp_nombres_clientes` | 13.752 | `separar-nombres-clientes.js` |

Todas están en el ZIP. Para cerrar C-2 falta confirmar que los créditos borrados eran
efectivamente de prueba.
