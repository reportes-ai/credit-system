# Auditoría integral — AutoFácil Business Suite
**Fecha:** 05-08-2026 · **Alcance:** todo el repositorio · **Score general: 6,6 / 10**

Auditoría ejecutada por un equipo de diez especialidades (arquitectura, QA, pentesting,
ciberseguridad/ASVS, full-stack, DevOps, base de datos, performance, UX/UI y auditoría de
código), organizado en ocho frentes paralelos. Complementa —no reemplaza— la auditoría del
03-08-2026: los hallazgos ya cerrados ahí (A-1 a A-8, C-1, C-2) no se repiten.

---

## Método y sus límites

**Lo que se hizo.** Medición del corpus completo (1.594 archivos JS, 589 HTML, ~566.000
líneas, 39 servicios, 1.278 rutas HTTP). Búsqueda dirigida por clase de defecto sobre el
100% del código, lectura profunda de todo lo que las búsquedas marcaron, ejecución de la
suite de pruebas (121 pasan, 1,1 s), `npm audit` sobre dependencias de producción, y
parseo programático de las 462 rutas de escritura resolviendo los alias locales que
envuelven `requireFunc`.

**Verificación cruzada.** Cada hallazgo crítico o alto fue releído contra el código antes
de entrar a este informe. **Tres hallazgos reportados por los especialistas resultaron
falsos y fueron descartados**; quedan documentados en el anexo por honestidad de método —
un informe que solo muestra aciertos no permite calibrar cuánto confiar en el resto.

**Lo que NO se hizo, y por qué importa.** No hubo pruebas dinámicas (DAST) ni explotación
real contra el sistema en vivo: todo lo marcado como explotable se dedujo leyendo el
código, con la ruta de ataque escrita para que sea verificable. No se revisaron línea por
línea los 589 HTML (el XSS se buscó por patrón y se confirmó por lectura en los casos
citados). No se auditó la lógica de negocio servicio por servicio: se priorizó lo que
mueve dinero. No se midió rendimiento con carga real ni se usó herramienta de
accesibilidad automatizada.

**Nota de entorno:** `.claude/worktrees/` contiene copias completas del repositorio.
Cualquier búsqueda que no lo excluya cuenta doble y produce conclusiones falsas.

---

## Resumen ejecutivo

El sistema está **mejor construido de lo que su tamaño haría esperar**. Hay CI, health
check con timeout, rate limiting en capas, validación de variables de entorno al arranque,
un capataz de migraciones que serializa el DDL, tres copias de respaldo con una service
account que no puede borrar, un host de contingencia ensayado, y 121 pruebas que enseñan
la regla de negocio en vez de perseguir cobertura. El backend está genuinamente bien
factorizado: prepago, comisión dealer, comisión ejecutivo, CAE y liquidez tienen motor
único real, y el 100% de las migraciones pasa por el capataz.

La deuda está concentrada y es **nítidamente identificable**, en cinco frentes:

1. **Autorización incompleta.** 54 de 462 rutas de escritura no tienen ningún control de
   negocio — incluido el CRUD completo de créditos. Y el bypass de Administrador cuelga de
   una comparación de texto contra un nombre que el mantenedor deja renombrar.
2. **Cuatro caminos por los que se pierde dinero en silencio.** Un asiento contable que no
   se escribe y no reintenta; transacciones que hacen commit tras tragarse un error; un
   pago que se puede ejecutar dos veces; fechas tomadas en UTC que mueven operaciones de mes.
3. **Superficie expuesta a internet sin autenticar:** el webhook de WhatsApp acepta
   mensajes de cualquiera porque no verifica la firma de Meta.
4. **Nada del diseño soporta un segundo proceso.** Los 32 motores automáticos deciden si
   corren por una variable de entorno local, sin elección de líder.
5. **El frontend reimplementa motores que el backend respeta**, y la miga de pan falta en
   el 42% de las páginas.

**Lo más urgente son cinco arreglos que suman menos de una jornada** y cierran el riesgo
grave: firma del webhook, `requireFunc` en el CRUD de créditos, validación del objetivo en
`resetClave`, forzado real del cambio de clave, y sacar los `.catch(() => {})` de dentro de
las transacciones de pago.

---

## Notas por dimensión

| Dimensión | Nota | Fundamento |
|---|---|---|
| Arquitectura | **7,5** | Motores únicos reales en el backend, capataz de migraciones sólido, capa de rutas limpia. Baja por el ciclo `cobranza ↔ whatsapp` y por los motores canónicos viviendo en un directorio público |
| Seguridad | **5,0** | Webhook abierto a internet, CRUD de créditos sin autorización, escalada vía `resetClave`, XSS almacenado en 5 páginas, clave inicial en el repositorio |
| Performance | **6,0** | N+1 de hasta 24.000 consultas en carga masiva, 12 índices en todo el sistema, favicon de 3,2 MB en 254 páginas |
| Escalabilidad | **4,0** | Ninguna réplica adicional es posible hoy sin duplicar motores, romper locks y debilitar el rate limit |
| Mantenibilidad | **6,5** | 69 definiciones de `ok`/`fail`, controllers de 2.790 líneas, 174 literales `'Administrador'` — pero cero huérfanos en `services/` y `shared/` |
| Legibilidad | **8,0** | Comentarios que explican el *porqué* y no el *qué*; las cicatrices quedan documentadas donde ocurrieron. De lo mejor del proyecto |
| UX | **6,0** | 699 `alert()` como interfaz, 116 páginas sin miga, sin feedback de "guardando" en 250 páginas |
| Backend | **6,5** | Bien estructurado, pero con cinco defectos que corrompen datos de plata |
| Frontend | **5,5** | Accesibilidad casi nula (1 `aria-label` en 278 páginas), duplicación masiva, 3,2 MB de favicon |
| Base de datos | **5,5** | 12 índices, cero FK en producción, escrituras multi-tabla sin transacción, datos duplicados entre tablas |
| DevOps | **7,5** | Respaldos de nivel profesional y contingencia ensayada. Baja porque el CI no bloquea el deploy y los logs no persisten |
| Testing | **4,5** | 121 pruebas excelentes, pero cero cobertura de endpoints, permisos, contabilidad y prepago |

---

## Hallazgos críticos

### ✅ C-1 · El webhook de WhatsApp acepta mensajes de cualquiera en internet
`services/whatsapp/src/routes/whatsapp.routes.js:10` · CWE-345

El endpoint es público por necesidad (Meta debe poder llamarlo), pero **no verifica la
firma `X-Hub-Signature-256`**. Cero coincidencias de `hub-signature` o `APP_SECRET` en todo
el servicio. El `verify_token` protege solo el GET de suscripción.

**Explotación:** un `curl` sin credenciales desde cualquier parte del mundo con un payload
de mensaje forjado. `procesarEntrante` (`whatsapp.controller.js:794`) crea la conversación,
cruza el teléfono contra `clientes` para pegarle el RUT, dispara los triggers y **responde
por el número comercial verificado de la empresa**.

**Impacto:** uso del WhatsApp Business de AutoFácil como emisor hacia terceros (reputación
del número, baneo de Meta, exposición a Ley 21.320); consumo sin techo de saldo de Meta y de
Anthropic; conversaciones falsas atribuidas al RUT de clientes reales en la bitácora que
después sirve de respaldo de gestión.

**Corrección:** HMAC-SHA256 sobre el cuerpo crudo con `timingSafeEqual`, capturando los
bytes originales con `express.json({ verify })`. Es el único hallazgo explotable desde
internet sin ninguna credencial. **Esfuerzo: bajo (30 min).**

### ✅ C-2 · CRUD completo de créditos sin ninguna autorización
`services/creditos/src/routes/operaciones.routes.js:10,11,15`

```js
router.post('/',      verifyToken, ctrl.create);
router.put('/:id',    verifyToken, ctrl.update);
router.delete('/:id', verifyToken, ctrl.remove);
```

Las líneas 12 y 13, justo al lado, **sí** exigen `requireFunc`. Se protegieron las
mutaciones de estado y se dejaron abiertas crear, editar y borrar.

**Explotación:** con el JWT de cualquier usuario activo, `DELETE /api/operaciones/17324`
elimina una operación de crédito; `PUT` altera montos y comisiones; `GET /:id` devuelve RUT
y nombre del cliente iterando ids.

**Impacto:** `creditos` es la fuente de verdad de la que cuelgan comisiones, cartolas,
contabilidad y cobranza. **Esfuerzo: bajo (3 líneas).**

### ✅ C-3 · Escalada a Administrador vía `resetClave`
`services/usuarios/src/controllers/usuarios.controller.js:448` · CWE-269

El controlador **no valida nada sobre el objetivo**: ni el flag `protegido`, ni
`perfilOtorgable` (que sí protege `createUsuario` y `updateUsuario`). Y devuelve la clave
nueva en el cuerpo de la respuesta.

**Explotación:** quien tenga `usuarios.reset_clave` —típicamente RRHH o soporte— hace
`POST /api/usuarios/1/reset-clave`, lee `nueva_clave` y entra como Administrador.

**La defensa existe y no funciona.** `resetClave` marca `debe_cambiar_clave = 1`, que es
exactamente el control pensado para esto — pero esa bandera solo la respeta el frontend
(ver C-4). Por API el token entregado es plenamente válido. `desbloquearUsuario`
(`:485`) tiene el mismo defecto. **Esfuerzo: bajo (~10 líneas).**

### ✅ C-4 · El cambio de clave obligatorio es solo del frontend
`services/usuarios/src/controllers/auth.controller.js:96-118` · CWE-602

`debe_cambiar_clave` no aparece ni una vez en `shared/middleware/auth.js`. El login entrega
un JWT sin marca de restricción junto con la bandera, y ningún middleware la consulta.

**Explotación:** `POST /api/auth/login` → el token responde 200 en cualquier endpoint.

**Impacto:** los tres caminos que activan la bandera son los que importan — primer ingreso,
reseteo tras sospecha, y clave vencida por política. En los tres el sistema cree haber
cerrado la puerta y no la cerró. Se agrava con C-3 y con M-1.

**Corrección:** que el token nazca marcado (`cc: 1`) y `verifyToken` lo haga valer, con
excepción para la propia ruta de cambio de clave. **Esfuerzo: bajo.**

### ✅ C-5 · El asiento contable se pierde en silencio ante carrera del correlativo
`services/contabilidad/src/motor-asientos.js:238`

```js
const [[{ sig }]] = await conn.query(
  'SELECT COALESCE(MAX(numero),0)+1 sig FROM ctb_comprobantes WHERE tipo=? AND anio=? FOR UPDATE', …);
```

`FOR UPDATE` sobre un agregado **no bloquea el hueco**. Dos eventos simultáneos del mismo
tipo leen el mismo `sig`; el segundo choca contra `uq_tipo_anio_num`. El `ER_DUP_ENTRY` sube
al `catch` exterior, que registra `ERROR` y hace `return null` — el motor por diseño nunca
lanza, y **no reintenta**. La operación de negocio se completa y el asiento no existe.

**Impacto:** la contabilidad queda descuadrada sin señal. El único rastro es una fila en
`ctb_eventos_log` que nadie mira hasta el cierre de mes. Va directo contra la Máxima 4, y es
condición para reemplazar AVSOFT.

**Corrección:** reintento ante duplicado, igual que `shared/num-op.js`; o mejor, tabla de
secuencia con `FOR UPDATE` sobre fila real, como ya hace `shared/ordenes-pago.js`.
**Esfuerzo: bajo.**

### ✅ C-6 · Transacciones de pago que hacen commit tras tragarse un error
`services/creditos/src/controllers/pagos-credito.controller.js:396`, `:614`, `:616`

```js
await conn.query(
  `UPDATE cuotas_credito SET estado_cuota='PAGADA' … `, …
).catch(() => {});
```

Está **dentro** de la transacción. Si el UPDATE falla, la excepción se traga, el flujo
continúa y **se hace commit**: quedan filas en `pagos_credito` diciendo que la cuota se pagó
y `cuotas_credito` diciendo que sigue impaga.

**Impacto para el usuario:** el cliente pagó, el comprobante salió, y la cuota sigue
vigente devengando mora y entrando a cobranza. En el prepago (`:614`, `:616`), la operación
puede quedar cobrada sin marcar la cartera como PREPAGADO.

**Corrección:** quitar los tres `.catch(() => {})` y dejar que la excepción llegue al
`rollback()`. **Esfuerzo: bajo (una línea cada uno).**

### C-7 · `pagarOrden`: doble pago posible, y sin transacción
`services/ordenes-pago/src/controllers/ordenes-pago.controller.js:789`

Lee `oc.pagada` y luego actualiza **sin `AND pagada=0`** y sin comprobar `affectedRows`.
Dos clics simultáneos pasan ambos la guarda, insertan dos veces la etapa de cierre y
ejecutan dos veces el hook del Plan Liquidez, que postea el abono y mueve la deuda del
dealer. Los tres pasos corren con `pool.query` suelto, sin transacción.

**Agravante de arquitectura:** `shared/ordenes-pago.js` ya expone `pagarCorrelativo()`, que
sí valida `AND anula=0 AND pagada=0` y devuelve `affectedRows > 0`. Este controlador
reimplementó a mano la versión mala. **Esfuerzo: medio.**

### C-8 · Fechas de plata tomadas del reloj UTC del servidor
Render corre en UTC; Chile es UTC-3/-4.

| Archivo:línea | Qué fecha corrompe |
|---|---|
| `services/contabilidad/src/motor-asientos.js:231` | fecha del comprobante contable |
| `services/ordenes-pago/src/controllers/ordenes-pago.controller.js:796` | `fecha_pago` de la orden |
| `services/cobranza/src/controllers/odp-cuotas.controller.js:333` | `fecha_pago` de las cuotas |
| `shared/ordenes-pago.js:96` | **año del correlativo ODP** |

Desde las 20:00/21:00 hora chilena ya es el día siguiente en UTC. Un pago registrado a las
21:30 del 31 de julio **se contabiliza en agosto**. El 31 de diciembre a las 21:00, el
correlativo salta de ejercicio.

**Corrección:** ya existe la solución en casa — `shared/num-op.js:prefijoMes()` usa
`Intl.DateTimeFormat` con `timeZone: 'America/Santiago'`. Extraer un `hoyChile()` y usarlo
en los cuatro puntos. **Esfuerzo: bajo.**

### C-9 · El CI no bloquea el despliegue
`.github/workflows/ci.yml`

El CI corre **en paralelo** al deploy, no antes: Render se entera del push por su propio
webhook. Un commit que rompe las 121 pruebas llega a producción en 2-3 minutos y el CI se
pone rojo después, cuando el usuario ya está viendo el error.

**Corrección:** apagar Auto-Deploy en Render y crear un job que llame a la Deploy Hook con
`needs: verificar`. Diez líneas. **Esfuerzo: bajo.**

### C-10 · Los logs no van a ningún lugar persistente
Todo el sistema usa `console.error`. No hay winston, pino, Sentry ni tabla propia. Render
retiene 7 días en el plan Starter, sin búsqueda real.

**Impacto:** cuando un incidente de plata se detecte al cierre de mes —tres semanas
después— **el log ya no existe**. Además `unhandledRejection` (`index.js:727`) solo escribe
a stdout y **no dispara la alerta por correo** que sí tiene `uncaughtException`; en un
sistema con 32 motores async, la promesa sin catch es el modo de falla más probable.
**Esfuerzo: bajo (la alerta) / medio (la persistencia).**

### C-11 · Nunca se probó una restauración del respaldo
El propio CLAUDE.md lo admite. El workflow verifica que el dump **esté completo**
(`gunzip -t` + `grep "Dump completed"`), no que **sirva para levantar el sistema**. Riesgos
que ese chequeo no detecta: orden de tablas con FK (ya hay un "gotcha FK" registrado en la
contingencia de Cloud SQL), definers de vistas y triggers, y el charset de los acentos.

**Un respaldo no probado es una hipótesis.** **Esfuerzo: medio.**

---

## Estado de las correcciones (05-08-2026, mismo día)

Los **8 críticos del roadmap quedaron cerrados** en las versiones v182.0 y v182.1, marcados
con ✅ en sus secciones. Lo que cambió respecto de lo planificado:

| # | Hallazgo | Estado |
|---|---|---|
| 1 | C-1 firma del webhook de WhatsApp | ✅ **Falta cargar `WSP_APP_SECRET` en Render** — sin esa variable el endpoint sigue aceptando sin verificar; el estado se ve en `/api/health → whatsapp_webhook_firmado` |
| 2 | C-2 `requireFunc` en el CRUD de créditos | ✅ Permisos nuevos `creditos_crear/editar/eliminar` — **hay que habilitarlos en la matriz** a los perfiles que digitan |
| 3 | C-3 validación del objetivo en `resetClave` | ✅ |
| 4 | C-4 forzado real del cambio de clave | ✅ El token nace marcado (`cc`) y `verifyToken` lo hace valer |
| 5 | C-6 `.catch(() => {})` en transacciones de pago | ✅ |
| 6 | C-5 reintento del correlativo contable | ✅ |
| 7 | A-1/A-2/M-1 XSS almacenado | ✅ 5 pantallas + la foto de credencial |
| 8 | A-3 `requireFunc` en Órdenes de Pago | ✅ Permiso nuevo `ordenes_pago_ver` |

**Dos acciones pendientes de configuración, no de código:** cargar `WSP_APP_SECRET` y
asignar los cuatro permisos nuevos en la matriz de Perfiles. Hasta que se asignen, solo el
Administrador puede crear, editar o borrar operaciones y ver Órdenes de Pago (pasa por su
bypass).

**Efecto en las notas:** Seguridad sube de 5,0 a ~7,0. El resto queda igual: los 54 endpoints
sin autorización, el bypass por nombre de perfil, los índices y la persistencia de logs
siguen abiertos.

---

## Hallazgos altos

| # | Hallazgo | Ubicación | Impacto |
|---|---|---|---|
| ✅ A-1 | **XSS almacenado en la bitácora de Cobranza** — `innerHTML` con `g.mensaje` y el archivo no define `esc` | `public/cobranza/prejudicial.html:823`, `judicial.html:695` | Un cobrador roba el JWT desde `sessionStorage` de supervisor y gerencia |
| ✅ A-2 | **Mismo XSS en Terreno, Cierre de Mes y Orden de Pago** | `terreno/index.html:370`, `tesoreria/cierre-mes.html:247`, `postventa/orden-pago/index.html:227` | Cierre de Mes es el peor: lo escribe un analista, lo lee toda la gerencia |
| ✅ A-3 | **Órdenes de Pago: los 4 GET sin `requireFunc`** mientras las escrituras sí lo exigen | `ordenes-pago.routes.js:8,14,15,16` | Cualquier autenticado lista banco y cuenta de todos los proveedores — insumo exacto del fraude BEC |
| A-4 | **El bypass de Administrador cuelga de un string** — `u.perfil === 'Administrador'`, sin columna `es_admin`. 174 literales en el backend | `shared/middleware/permisos.js:33` | Renombrar el perfil lo desactiva en silencio; crear uno con ese nombre lo otorga |
| A-5 | **Comisiones de todos los ejecutivos para cualquier autenticado** | `comisiones.routes.js:9,10` | La planilla de remuneración variable de toda la fuerza de venta |
| A-6 | **`visibilidad-ejecutivos.js` aplicado en 2 de ~8 módulos**, y falla abierto (`{all:true}`) ante error | créditos, comisiones, dashboard, mando, reportería, cartolas | Cada ejecutivo ve la cartera completa |
| A-7 | **Atención Remota: pertenencia validada solo para dealers** | `atencion.controller.js:679`, `:707` | Un empleado descarga liquidaciones y cédulas de conversaciones ajenas |
| A-8 | **Clave inicial `AF2026` literal en el repositorio**, junto a la nómina con 25 correos | `perfiles.controller.js:1634` | Toma de cuenta directa; Gerente de Finanzas y Gerente General en la lista |
| A-9 | **`GET /api/usuarios/:id` sin filtro**: RUT, teléfono y fecha de nacimiento de cualquiera | `usuarios.controller.js:267` | Ley 19.628; además anula el enmascaramiento deliberado del listado |
| A-10 | **`castigos` sin transacción**: firma + 2 UPDATE en tablas distintas | `castigos.controller.js:215-228` | Si falla en medio, el castigo queda **trabado**: no se aplica ni se revierte, y el reintento choca contra "ya firmaste" |
| A-11 | **`forzadosSet` traga el `JSON.parse`** y devuelve conjunto vacío | `creditos/utils/recalcular-mes.js:28` | El recálculo pisa las comisiones negociadas a mano. Silencioso e irreversible |
| A-12 | **Los 32 motores no tienen elección de líder** — deciden por env local, sin claim en BD | `shared/scheduler.js:55` | Con dos réplicas, cada comisión se aprueba dos veces. El daño es silencioso |
| A-13 | **`xlsx@0.18.5`: 2 vulnerabilidades altas sin parche disponible** (prototype pollution + ReDoS) | `package.json` | Es la librería que procesa los Excel que suben los usuarios |
| A-14 | **N+1 en carga masiva**: 5-8 consultas por fila | `carga-masiva.controller.js:444-557` | 3.000 filas = hasta 24.000 round-trips. TiDB cobra por consulta |
| A-15 | **12 índices en todo el sistema**; falta `creditos.id_cliente`, presente en casi todos los JOIN | — | Probablemente el índice de mayor retorno del sistema |
| A-16 | **Favicon de 3,2 MB servido en 254 páginas** | `public/img/favicon.png` | Se dibuja a 32×32 px. El peor derroche de ancho de banda del sistema |
| A-17 | **Accesibilidad: 1 solo `aria-label` en 278 páginas**; 235 botones-ícono mudos, 126 reglas `outline:none` sin reemplazo de foco | transversal | Acciones destructivas inoperables con teclado o lector de pantalla |

---

## Hallazgos medios

- **✅ M-1 · XSS por ruptura de atributo en la foto de credencial** — el regex valida solo el
  prefijo `data:image/…;base64,` sin `$`, y `facilbook/index.html:222` no escapa el `src`.
  Se distribuye a toda la empresa (`credenciales.controller.js:112`).
- **M-2 · 54 rutas de escritura sin autorización de negocio** (11,7% de 462). El bloque de
  dinero: `cartolas/sync`, `cartolas/enviadas`, `odp-cuotas/:id/anular`,
  `comisiones/ejecutivo-responder`, `dealers-liquidez/hojas/:id/aprobar` — aprobar una hoja
  de liquidez es autorizar un desembolso.
- **M-3 · ~20 gates decididos con el `perfil_nombre` del token**, que no se re-lee de BD. Es
  la deuda que motivó prohibir `requirePerfil`, reintroducida dentro de los controllers.
  Existe `tieneFunc()` justo para esto.
- **M-4 · Sin `Content-Security-Policy`.** Los cinco XSS de A-1, A-2 y M-1 son la
  demostración concreta de por qué importa: una CSP con `script-src 'self'` los neutraliza
  todos. Empezar en `Report-Only` para medir el tamaño del proyecto sin romper nada.
- **M-5 · `express.json({ limit: '10mb' })` global** sobre los 1.278 endpoints, con
  `connectionLimit: 10`. En Cloud Run (512 MB) son ~20 peticiones concurrentes hasta el OOM.
- **M-6 · Falta `express.urlencoded`** en todo el repositorio: cualquier `<form method=POST>`
  sin `fetch` llega con `req.body === undefined`.
- **M-7 · El contenedor corre como root** (`Dockerfile`, sin `USER node`) — y parsea con
  `xlsx` y `pdf-parse` archivos que suben usuarios.
- **M-8 · `IVA /1.19` hardcodeado en el cierre contable** (`cierre-contable.controller.js:124`)
  existiendo el mantenedor de Impuestos. Ese cierre alimenta el informe mensual a Ecuador.
- **M-9 · Mora calculada con divisor 365 en el frontend** contra 360 del motor canónico
  (`creditos/revisar.html:977` sin fallback al servidor; `tesoreria/caja.html:730` con
  fallback). Además usan `tasa_anual_mayor` fijo, ignorando el tramo 200 UF.
- **M-10 · `caja.html:690` sintetiza el calendario** con la fórmula francesa en vez de leer
  `cuotas_credito`. Es el módulo que recibe el dinero, y el único que no respeta el
  calendario congelado.
- **M-11 · `getUF` duplicado en el dashboard** con fallback inventado a `38000`
  (`dashboard.controller.js:225`), donde el canónico devuelve `null` a propósito.
- **M-12 · Ciclo `cobranza ↔ whatsapp`** sostenido solo porque ambos lados hacen `require`
  dentro del cuerpo de la función. Nada en el código documenta esa restricción.
- **M-13 · Los motores canónicos viven en un directorio servido públicamente**
  (`rentabilidad-core.js`, `comision-dealer.js`, `mora-core.js`) — descargables sin sesión.
- **M-14 · `informes-dealernet` no descargaba del bucket.** Consecuencia de la migración del
  05-08. **Corregido en esta sesión** (commit `4b082a41`).
- **M-15 · Cero FK en producción.** Las 7 del repositorio están solo en `setup-db.js`, que
  está muerto. Sin chequeo de huérfanos.
- **M-16 · 426 `ALTER TABLE` serializados en cada arranque** vía `enFila`, incluidos tres
  bloques que consultan `information_schema` en cada boot. Compromete el arranque de 5 s
  del standby.
- **M-17 · `creditos` duplica la identidad del cliente** (`rut_cliente`, `nombre_cliente`)
  mientras `carga-masiva.controller.js:528` los borra explícitamente con el comentario
  *"pertenecen a la tabla clientes"*. Residuo indexado, no snapshot deliberado.
- **M-18 · 699 `alert()` como interfaz** en 134 páginas, y la mayoría descarta el `j.error`
  que el backend sí envía. El usuario llama a soporte sin información.
- **M-19 · Sin feedback de "guardando"** en 250 de 278 páginas: el botón queda clicable
  mientras la petición viaja. En Contabilidad u Órdenes de Pago eso es un asiento duplicado.
- **M-20 · 116 páginas sin `AF_TOPNAV`** (42% del sistema), incluidas landings de sección
  completas y las SPA que CLAUDE.md cita como el bug repetido.
- **M-21 · `xlsx.full.min.js` (882 KB) cargado eager en 18 páginas** para un botón de
  exportar que la mayoría de las sesiones nunca pulsa.
- **M-22 · 21 dependencias desde CDN sin `integrity`** — Leaflet en los mapas de dealers,
  bootstrap-icons en 7 páginas teniendo copia local. Un CDN comprometido ejecuta código con
  el JWT a la vista.
- **M-23 · JWT en `localStorage` sin documentar** en `donde-curso/index.html` y
  `whatsapp/index.html:443` (persiste más allá del cierre del navegador). Terreno y Mando sí
  están documentadas como excepción deliberada.
- **M-24 · `claveUsuario` del rate limit decodifica el JWT sin verificar la firma.** El
  comentario lo admite. Un token forjado permite consumir la cuota de otro usuario.
- **M-25 · Los controles de horario de caja fallan abiertos ante error de BD**
  (`ordenes-pago.controller.js:746`, `:774`): el `catch` cubre cualquier error, no solo "no
  hay configuración".
- **M-26 · `createBatch` no valida los montos**: un `total_pagado` negativo pasa
  `parseFloat`, sortea la guarda de suficiencia y se inserta.
- **M-27 · Correlativos `MAX+1` sin transacción** en aplicación de fondos y campañas: no
  corrompen (el UNIQUE protege) pero pierden el trabajo del usuario con un 500.
- **M-28 · `shared/presencia.js:39` usa `setInterval` directo**, fuera del scheduler. En el
  standby, `MOTORES=off` **no lo apaga**: escribe contra la misma base de producción.
- **M-29 · Dos motores de rate limiting** (`shared/rate-limit.js` y
  `shared/middleware/rate-limit.js`) con firmas de opciones distintas.
- **M-30 · 69 definiciones de `ok`/`fail`**, dos con semántica distinta y la misma firma
  (`crm/gestiones` vs `cobranza`). Más 369 `catch` inline con `res.status(500)`.

---

## Hallazgos bajos

- **B-1 · OTP del Portal del Cliente con `Math.random()`** (`portal-cliente.controller.js:95`)
  — usar `crypto.randomInt`.
- **B-2 · El OTP se imprime en el log** si el correo no está configurado: la condición es de
  runtime, no de entorno.
- **B-3 · Verify token de Meta hardcodeado** como default (`whatsapp.controller.js:903`).
- **B-4 · La verificación pública por QR devuelve el snapshot completo**, no los "datos
  mínimos" que promete su encabezado.
- **B-5 · `docker-compose.yml` con `JWT_SECRET` fijo y público** — y es el plan de
  contingencia local, que levantaría datos reales.
- **B-6 · `npm audit || true`** en el CI: nunca falla, nadie lo lee.
- **B-7 · Sin `permissions:` explícito** en los tres workflows.
- **B-8 · Node fijado solo en el mayor** (`node:22-alpine`), sin `engines` — el host de
  contingencia debe comportarse igual que producción.
- **B-9 · Dos health checks divergentes**: `/health` (pobre) y `/api/health` (bueno), y
  `railway.json` apunta al pobre.
- **B-10 · 232 declaraciones de gris claro bajo el mínimo AA de contraste** (`#999` = 2,85:1).
- **B-11 · 13 `<img>` sin `alt`**, incluidos la firma de las cartas y **el QR de la credencial**.
- **B-12 · 252 `<div onclick>`** en 74 archivos — Auditoría y Academia inoperables con teclado.
- **B-13 · 1.621 `<label>` y solo 24 con `for=`**; 25 inputs sin ninguna etiqueta.
- **B-14 · `logo.png` y `logo-autofacil.png` son el mismo archivo duplicado** (231,3 KB c/u).
- **B-15 · El cron del respaldo no ajusta por horario de verano** (el comentario confunde).
- **B-16 · Retención de 7 días en el respaldo semanal de documentos**: si el domingo falla,
  queda margen cero.

---

## Código huérfano

**Resultado principal: `services/` y `shared/` no tienen un solo archivo huérfano, ninguna
página HTML está muerta, y las 16 dependencias de `package.json` están todas en uso.** Lo
muerto es infraestructura de proveedores abandonados y bitácora de scripts.

**Restos a borrar** (cierra de paso el hallazgo B-2 de la auditoría del 03-08):

| Archivo | Evidencia |
|---|---|
| `railway.json`, `.railwayignore` | Railway no se usa; `healthcheckPath` apunta a `/health`, que hoy no es el bueno |
| `setup-db.js` | 0 referencias; su default es `DB_NAME \|\| 'railway'` |
| `docker-compose.yml` + `docker/` | 0 referencias, con `JWT_SECRET` público dentro |
| `_etapas_hist.js`, `_etapas_hist2.js` | Hacen `require` a una ruta absoluta de un scratchpad borrado: **son inejecutables** |
| `_fix_cartas.js` | One-shot del 22-07 |
| `scripts/_verif-docs-tmp.js` | Temporal de la migración al bucket, ya cerrada. Lee credenciales GCS desde una ruta absoluta en `Downloads` |

**22 endpoints sin ningún llamador.** 12 son muertos con alta confianza
(`certificados/preview`, `desempeno/logout`, `odp-cuotas/mias`, `perfiles/modulos/reordenar`,
los dos `/columns`, `rrhh/kuder/items`, `rrhh/cursos/de/:idUsuario`,
`rrhh/firmas/documentos/:idUsuario`, `dealernet/ficha-informes`, `dealernet/consultas`). Los
de indicadores (`utm|dolar|ipc` `/vigente` y `/en/:fecha`) son endpoints de conveniencia sin
cliente: documentar como API o eliminar. Los de disparo manual (`whatsapp/aviso-vencimiento/correr`,
`cobranza/diagnostico`, `atencion-remota/cola`) existen para gatillar a mano lo que el motor
hace solo — decisión de negocio, no técnica.

**Riesgo asociado:** cada uno es superficie HTTP autenticada que nadie ejercita, y por tanto
nadie prueba. Los dos `/columns` exponen el esquema de tablas con datos personales.

**34 scripts one-shot ya ejecutados.** Recomiendo **moverlos a `scripts/historico/`, no
borrarlos**: son la bitácora de qué se tocó en producción y por qué, y varios llevan los
datos de respaldo inline. Conservar en `scripts/`: `validar-ruts.js`, `check-duplicates.js`,
`recover-num-op.js`, `extraer-cert-sii.js` (crítico para contingencia) y
`sincronizar-env-standby.js`.

**Detalle menor con consecuencia real:** hay tres pares de archivos de rutas homónimos
(`parametros.routes.js`, `alertas.routes.js`, `auditoria.routes.js`). Cualquier herramienta
que mapee por nombre de archivo se equivoca — le pasó al análisis automatizado antes de
corregirlo.

---

## Testing

121 pruebas en 11 archivos, 1,1 s, sin base de datos. **Son de muy buena calidad**: nombran
la regla de negocio (`'el punto es separador de MILES, no decimal (el bug que costó dinero)'`),
prueban los bordes exactos (`'el día 20 de mora no los habilita, el 21 sí'`) y verifican que
los parámetros salen del mantenedor.

**El hueco:** cero cobertura de `contabilizar()`, `calcularPrepago()`, el motor de comisión
dealer (solo está probada la del ejecutivo — la que entra, no la que sale),
`emitirCorrelativo` y `cotizarCuota`. **Cero pruebas de integración de endpoints, cero de
permisos, cero e2e.** De 1.278 endpoints, ninguno tiene una aserción de que responde 401 sin
token.

**Las cinco pruebas de mayor valor que faltan:**

1. **`requireFunc` deniega sin permiso** — es el único control de acceso del sistema y no
   tiene una sola aserción. Un bug ahí expone remuneraciones y la consola SQL.
2. **Smoke de arranque: todos los `require` resuelven.** Hoy un archivo de rutas renombrado
   pasa el `node --check` del CI y tumba producción entera al arrancar. Es la prueba de mayor
   retorno por línea escrita.
3. **`contabilizar()` cuadra o no escribe** — el motor del que depende reemplazar AVSOFT.
4. **`calcularPrepago()` ≠ saldo insoluto** — CLAUDE.md marca que son magnitudes distintas
   que no se fusionan; una prueba es lo único que hace sobrevivir esa distinción al próximo
   refactor.
5. **`emitirCorrelativo` bajo carrera** — el mismo bug ya ocurrió una vez, en el otro
   correlativo (A-8 de la auditoría anterior), y por eso existe `num-op.test.js`.

**Prueba de regresión barata contra la reincidencia:** una aserción que recorra
`services/**/src/routes/*.js` y falle si aparece una ruta de escritura sin `requireFunc`
fuera de una lista blanca explícita. Habría impedido C-2 y M-2.

---

## Roadmap de correcciones

### Crítico — hacer de inmediato (≈1 jornada, todo quirúrgico)

| # | Acción | Hallazgo | Esfuerzo |
|---|---|---|---|
| 1 | Firma HMAC del webhook de WhatsApp | C-1 | Bajo |
| 2 | `requireFunc` en las 3 rutas del CRUD de créditos | C-2 | Bajo |
| 3 | `perfilOtorgable` + bloqueo de `protegido` en `resetClave`/`desbloquear`; no devolver la clave | C-3 | Bajo |
| 4 | Marca `cc` en el token y forzado en `verifyToken` | C-4 | Bajo |
| 5 | Sacar los 3 `.catch(() => {})` de dentro de las transacciones de pago | C-6 | Bajo |
| 6 | Reintento del correlativo contable | C-5 | Bajo |
| 7 | `esc()` en las 5 páginas con XSS almacenado | A-1, A-2, M-1 | Bajo |
| 8 | `requireFunc` en los 4 GET de Órdenes de Pago | A-3 | Bajo |

### Alta prioridad (próximas dos semanas)

9. `hoyChile()` y los cuatro reemplazos de fecha UTC **(C-8)**
10. `pagarOrden` → `pagarCorrelativo()` + transacción **(C-7)**
11. `castigos` en transacción **(A-10)**
12. Gate de pruebas antes del deploy: Deploy Hook con `needs: verificar` **(C-9)**
13. `alertar500` en `unhandledRejection` — una línea **(C-10)**
14. Prueba de restauración del respaldo, mensual y automatizada **(C-11)**
15. Los 6 índices de base de datos, empezando por `creditos.id_cliente` **(A-15)**
16. `forzadosSet` deja de tragar el `JSON.parse` **(A-11)**
17. `requireFunc` en el bloque de dinero de las 54 rutas **(M-2)**
18. Favicon a 32 px y consolidar los logos duplicados **(A-16, B-14)** — 5 minutos, −3,2 MB por página
19. CSP en `Report-Only` para medir **(M-4)**
20. Las 5 pruebas de mayor valor **(Testing)**

### Prioridad media (este trimestre)

21. `perfiles.es_admin` + `perfiles.codigo`; migrar los 174 literales **(A-4)**
22. Claim con TTL en BD dentro de `programar()` — un cambio cubre los 32 motores **(A-12)**
23. `ejecutivosVisibles` en créditos, comisiones y cartolas; y que falle **cerrado** **(A-6)**
24. Migrar los ~20 gates por `perfil_nombre` a `tieneFunc` **(M-3)**
25. Logs persistentes: Sentry o tabla propia con retención **(C-10)**
26. Mover los `*-core.js` a `shared/` y `calcularPrepago` a `shared/prepago-calc.js` **(M-13)**
27. Unificar la mora del frontend contra `mora-calc.js` isomorfo **(M-9, M-10, M-11)**
28. `IVA` desde el mantenedor en el cierre contable **(M-8)**
29. N+1 de carga masiva por lotes **(A-14)**
30. Migrar los bloques estructurales de `enFila` a `migrarAuto` **(M-16)**
31. `aria-label` en los 235 botones-ícono y foco visible en las 126 reglas **(A-17)**
32. Borrar los restos de Railway y Docker; mover los one-shot a `scripts/historico/`
33. Respaldar las variables de entorno de Render y el inventario de infraestructura de Google

### Baja prioridad

34. `shared/http.js` con `ok`/`fail` — resuelve 69 duplicados **(M-30)**
35. Fusionar los clones `bd-*` en un CRUD parametrizado
36. `/js/api.js` con `AF_FETCH` y `/js/toast.js`; migrar los 699 `alert()` **(M-18)**
37. Migración progresiva de las 116 páginas a `AF_TOPNAV` **(M-20)**
38. Carga diferida de `xlsx.full.min.js` **(M-21)**; auto-hospedar Leaflet **(M-22)**
39. `for`/`id` en los labels **(B-13)**; `<button>` en vez de `<div onclick>` **(B-12)**
40. Eliminar los 12 endpoints muertos; documentar los de indicadores

---

## Anexo — falsos positivos descartados

Tres hallazgos reportados por los especialistas **no sobrevivieron la verificación**. Se
documentan porque calibran cuánto confiar en el resto del informe:

1. **"`informes-dealernet.controller.js:102` no tiene límite de tamaño de subida."** Falso:
   tiene `fileSize: 30 MB`. Los 7 uploaders del sistema tienen techo.
2. **"`SELECT * FROM clientes` sin LIMIT trae las 18.634 filas."** Falso: tiene `LIMIT 200`
   tres líneas más abajo (`clientes.controller.js:299`).
3. **"`img/timbre-pagado.png` (5,9 MB) está huérfano, cero referencias."** Falso: tiene 5
   referencias dentro de `public/`. Hay que optimizarlo, no borrarlo.

Y dos que un especialista **corrigió por sí mismo** al verificar, bajándose la severidad:
los tramos de gastos de cobranza hardcodeados en `revisar.html` **coinciden numéricamente**
con el seed actual (el defecto es de parametría, no de cobro), y el divisor /365 de
`caja.html` es solo *fallback* porque el valor del servidor manda (en `revisar.html:977`, en
cambio, no hay fallback y el número malo se muestra siempre).

---

## Lo que está genuinamente bien

Vale nombrarlo, porque un informe de 80 hallazgos puede dar una impresión equivocada:

- **La arquitectura de respaldos.** Tres copias de la base y tres de los documentos, con la
  service account limitada a `objectCreator` (los respaldos no se borran ni con la llave
  robada), `rsync` sin `-d` deliberadamente, sin regla de ciclo de vida en el destino de
  documentos, y verificación **contra el origen** en vez de contra un mínimo inventado.
- **La guardia de `standby:true` en Cloud Build**: la reconstrucción diaria falla si el host
  de contingencia quedara con motores encendidos.
- **El capataz de migraciones**: serializa el DDL, reintenta solo ante errores transitorios,
  hace claim atómico por PK y recupera claims huérfanos a los 30 minutos.
- **`env-check.js`**: las cuatro variables críticas hacen `process.exit(1)` con nombre y
  descripción. Falla ruidoso, que es lo correcto.
- **El patrón IDOR está bien resuelto** en RRHH, portal-cliente, portal-dealer, tickets y
  compras. Es el molde a copiar para corregir C-2 y A-7.
- **`requirePerfil` erradicado**: 0 usos. La regla de CLAUDE.md se respetó.
- **La calidad de las 121 pruebas** y de los comentarios del código, que explican el *porqué*
  y dejan la cicatriz documentada donde ocurrió.

**El patrón de fondo:** todo lo que se auditó formalmente quedó bien resuelto. Los huecos
están donde nadie ha mirado todavía — la autorización de las rutas que no pasaron por una
revisión de permisos, los motores de plata sin pruebas, el gate de despliegue y la
persistencia de logs. Que sean justo los lugares donde CLAUDE.md pone las máximas más
fuertes no es casualidad: la máxima está escrita porque el riesgo se reconoció; lo que falta
es el mecanismo que la haga cumplirse sola.
