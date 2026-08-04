# Plan: Separación Staging / Producción

> **ESTADO AL 04-08-2026 (Semana 3 del roadmap de certificación)**
>
> | Fase | Estado | Quién |
> |---|---|---|
> | **Fase 4** — blindajes en código | ✅ Hecha | — |
> | **Fase 1** — rama `staging` | ✅ Creada y al día con `main` | — |
> | **Fase 2** — BD espejo en TiDB | ✅ `credit_system_staging` creada y verificada | — |
> | **Fase 3** — servicio en Render | ✅ **En vivo**: `credit-system-staging.onrender.com` | — |
> | CI (`node --check` + 95 pruebas) | ✅ `.github/workflows/ci.yml` | — |
> | Fase 1.2 — proteger `main` en GitHub | 🅿️ **Postergada por decisión de Pato** | día del corte |
> | **Fase 5** — disciplina de deploy | 🅿️ **Postergada por decisión de Pato** | día del corte |
>
> **Decisión de Pato (04-08-2026):** mientras corre la UAT con usuarios, él sigue trabajando
> **directo contra producción** como hasta hoy. Proteger `main` le cambiaría el flujo diario
> justo en medio de las pruebas. El ambiente queda **configurado y andando**; el interruptor
> —protección de rama + disciplina de merge— se activa el día del corte a producción final.
>
> **Cómo entrar a staging:** tu correo de siempre pero con dominio `@staging.invalid`
> (ej. `patricio.escobar@staging.invalid`), clave `Staging2026!`.
>
> **Verificación de un vistazo:** `/api/health` informa `entorno` (`staging` vs `produccion`) y
> `motores_apagados` (en staging, los 5 que contactan clientes; en producción, `[]`).
>
> **El apagado de motores era PARCIAL hasta el 04-08-2026, y quedó resuelto ese día.** Solo 8
> temporizadores pasaban por `shared/scheduler.js`; los otros ~24 eran `setInterval` crudos
> dentro de los controllers y corrían en staging igual que en producción — aprobación
> automática de comisiones, desistimiento de aprobados vencidos, cierre de castigos, devengos
> de vacaciones, escalamiento de tickets. No alcanzaban a un cliente, pero mutaban datos.
> Hoy los **26 motores** pasan por el scheduler y obedecen a `ENTORNO` y a `MOTORES=off`.

> Objetivo: que `main` deje de ser "producción en vivo" y todo cambio pase por un ambiente
> de prueba idéntico antes de llegar a los usuarios. Ejecutar en el orden indicado;
> cada fase deja el sistema funcionando (sin big-bang).

## Arquitectura final

| | STAGING | PRODUCCIÓN |
|---|---|---|
| Rama Git | `staging` | `main` |
| Servicio Render | `credit-system-staging` (plan free) | `credit-system` (actual) |
| URL | `credit-system-staging.onrender.com` | dominio propio + URL actual |
| BD TiDB | `credit_system_staging` (espejo) | `credit_system` (actual) |
| Correo/WhatsApp | **Modo Desarrollo FORZADO** (nada sale a clientes) | normal |
| Crons/motores | **apagados por env** | normales |

## Fase 1 — Rama y flujo Git (30 min, sin riesgo)
1. Crear rama `staging` desde `main`: `git checkout -b staging && git push -u origin staging`.
2. En GitHub: proteger `main` (Settings → Branches → branch protection): no push directo,
   solo merge desde `staging` (PR o merge local). El push directo a `main` queda solo para hotfix declarado.
3. Nueva disciplina de trabajo diario: **todo commit va a `staging`**; a `main` solo se mergea
   lo certificado (`git checkout main && git merge staging && git push`).

## Fase 2 — BD staging en TiDB (1-2 h)
1. En TiDB Cloud, en el MISMO cluster, crear base `credit_system_staging`
   (un segundo cluster es mejor aislamiento, pero el plan serverless cobra por uso — evaluar).
2. Espejar datos: export/import desde el panel de TiDB (o `mysqldump`-compatible via Chat2Query).
   Alternativa liviana: solo estructura + mantenedores + un subconjunto de créditos de prueba.
3. **Enmascarar datos sensibles en staging** (opcional pero recomendado): correos de clientes
   reemplazados por casillas de prueba, teléfonos anulados — así ni un bug puede contactar a un cliente real.
4. Refrescar el espejo cada cierto tiempo (manual, antes de cada QA grande).

## Fase 3 — Servicio staging en Render (1 h)
1. New Web Service → mismo repo, **rama `staging`**, plan Free, nombre `credit-system-staging`.
2. Env vars: copiar las de prod y cambiar:
   - `DB_NAME=credit_system_staging`
   - `ENTORNO=staging` (nueva — ver Fase 4)
   - `JWT_SECRET` DISTINTO al de prod (un token de staging no sirve en prod ni al revés)
   - `WSP_TOKEN`/`WSP_PHONE_ID`: **vacíos o de un número de prueba** — jamás el número real
   - `MAIL_*`: mismas (Modo Desarrollo forzado las redirige igual)
   - `ALERTA_ERRORES_MAIL`: tu correo (los 500 de staging también avisan)
3. Health Check Path: `/api/health` en ambos servicios.

## Fase 4 — Blindajes en código (yo, ~2 h)
> Único desarrollo necesario. Una env var `ENTORNO=staging` activa:
1. **Modo Desarrollo forzado**: `shared/dev-mode.js` retorna activo=true siempre en staging
   (correo redirigido, WhatsApp simulado) — imposible contactar clientes reales desde staging.
2. **Crons apagados**: correos programados, motor de mora, sync indicadores opcionalmente —
   los schedulers consultan `ENTORNO` y no disparan envíos reales.
3. **Cinta visual "STAGING"** sobre el logo (mismo patrón que la cinta DESARROLLO) en todas
   las páginas, para que nadie confunda dónde está parado.
4. `/api/health` retorna también `entorno` para verificación rápida.

## Fase 5 — Disciplina de deploy (proceso, no código)
1. Desarrollo diario → `staging` → auto-deploy al servicio staging → probar ahí.
2. QA/certificación (docs/qa-plan-produccion.md) SE EJECUTA EN STAGING.
3. Merge a `main` solo: (a) certificado en staging, (b) fuera de horario punta si toca BD,
   (c) con el checklist de salida del plan QA.
4. Hotfix urgente: se permite directo a `main`, pero se retro-mergea a `staging` el mismo día.

## Costos
- Render Free para staging: US$0 (se duerme tras 15 min sin uso — aceptable para pruebas).
- TiDB: misma base serverless, el costo extra es el storage del espejo (bajo).
- Total: ~US$0/mes adicional.

## Orden de ejecución sugerido
1. Fase 4 primero (los blindajes se pueden commitear ya — sin `ENTORNO` definido no cambian nada en prod).
2. Fase 1 (rama + protección).
3. Fases 2 y 3 (paneles TiDB/Render — Pato, con guía).
4. Fase 5 desde el día siguiente.

---

# Cómo quedó la BD de staging (Fase 2, ejecutada 04-08-2026)

`node scripts/crear-bd-staging.js --ejecutar` construye `credit_system_staging` en el mismo
cluster de TiDB. Resultado verificado: **368 tablas, 118.106 filas**.

- **Estructura completa** (las 368 tablas, idénticas a producción).
- **Datos solo de 136 tablas de una lista EXPLÍCITA** dentro del script: permisos,
  mantenedores, indicadores (UF, tasas, feriados), máquinas de estados y maestros de negocio.
- **La cartera nace vacía**: créditos, clientes, cuotas, pagos, cartas, cobranza, RRHH y
  contabilidad tienen 0 filas. La QA crea sus propios casos.
- **Enmascarado**: los correos y teléfonos de las 4 tablas que los tienen (`dealers`,
  `usuarios`, `vendedores_dealer`, `proveedores`) conservan su parte local y cambian de
  dominio a **`@staging.invalid`**; los teléfonos quedan en `+56900000000`.
- **Ningún hash de producción**: los 40 usuarios comparten una clave de staging conocida
  (`--clave`, por defecto `Staging2026!`). Sirve para entrar con cualquier perfil sin
  arrastrar credenciales reales.

Para refrescar el espejo antes de una QA grande: `--ejecutar --recrear`.

**Por qué la lista es de lo que ENTRA y no de lo que se excluye:** la primera versión usaba
lista de exclusión y dejaba pasar respaldos, movimientos bancarios y conversaciones con
dealers. Con lista de inclusión, una tabla nueva con datos de personas no se copia sola. Si
falta algo en staging, se agrega a mano — ese costo es mucho más barato que filtrar datos de
clientes al ambiente de pruebas.

**Cuatro defectos que aparecieron al construirla** (quedan resueltos en el script, y valen como
advertencia para cualquier copia futura de esquema):
0. **Enmascarar el correo dejó a todos afuera.** La primera versión reemplazaba cada dirección
   por `staging+N@autofacilchile.cl`, y **el login del sistema es POR CORREO**: al borrar la
   dirección se borró la identidad de acceso. Un correo enmascarado tiene que ser
   **inalcanzable**, no **irreconocible**. `.invalid` es un TLD reservado por la RFC 2606 que
   ningún DNS resuelve, así que `patricio.escobar@staging.invalid` sirve para entrar y no puede
   recibir correo ni por accidente. (Colisión real: `admin@admin.cl` y `admin@sistema.cl`
   comparten parte local — la segunda en aparecer lleva sufijo.)
1. **Claves foráneas**: no se puede crear `comunas` antes que `provincias`. El script crea en
   pasadas hasta que una pasada completa no agrega nada. Es el mismo gotcha del respaldo de
   Google Cloud SQL.
2. **`INSERT IGNORE` mintió**: `usuarios` y `permisos_perfil` fallaban por FK y el `IGNORE`
   descartaba las filas **en silencio** — el log decía "40 filas" y la tabla quedaba vacía.
   Ahora se copia con las FK desactivadas y se **verifica el conteo tabla por tabla**.
3. **`clave` no significa contraseña**: en este código las tablas de configuración son
   `(clave, valor)` — `clave` es la LLAVE. Enmascarar por ese nombre reemplazaba la llave de
   cada parámetro por un hash y dejaba inservibles `config_sistema`, `cobranza_config` y
   compañía. Solo se enmascara lo que de verdad guarda una contraseña.

---

# Los dos paneles (referencia)

## A. Proteger `main` en GitHub — 5 minutos  🅿️ POSTERGADA hasta el corte final
`github.com/reportes-ai/credit-system` → **Settings → Branches → Add branch protection rule**
- Branch name pattern: `main`
- ✅ Require a pull request before merging
- ✅ Require status checks to pass → seleccionar **`verificar`** (el job de `ci.yml`)
- Dejar habilitado que tú puedas saltarlo para un hotfix declarado.

Sin esto, `git push origin main` sigue siendo despliegue inmediato a los usuarios.

## B. Crear el servicio de staging en Render — ✅ HECHA el 04-08-2026
**New → Web Service** → mismo repositorio → **rama `staging`** → plan **Free** → nombre
`credit-system-staging` → Health Check Path: `/api/health`.

Environment Variables: copiar las de producción y cambiar **solo estas cinco**:

| Variable | Valor en staging | Por qué |
|---|---|---|
| `ENTORNO` | `staging` | Es lo único que fuerza el Modo Desarrollo y apaga los motores automáticos |
| `DB_NAME` | `credit_system_staging` | La base espejo ya creada |
| `JWT_SECRET` | **uno nuevo, distinto** | Un token de staging no debe servir en producción ni al revés |
| `WSP_TOKEN` / `WSP_PHONE_ID` | **vacíos** | Jamás el número real de WhatsApp |
| `ALERTA_ERRORES_MAIL` | tu correo | Los 500 de staging también avisan |

**Cómo verificar que quedó bien** (los tres en orden, antes de usarlo):
1. `https://credit-system-staging.onrender.com/api/health` responde `"entorno":"staging"`.
2. Al abrir cualquier página aparece la **cinta morada STAGING** arriba.
3. En el log de arranque de Render sale el recuadro `ENTORNO: STAGING · Modo Desarrollo
   FORZADO · Motores automáticos APAGADOS`.

Si el punto 1 dice `produccion`, **no lo uses**: falta la variable `ENTORNO` y ese servicio
puede escribirle a clientes reales.

Entra con cualquier usuario y la clave `Staging2026!`.

---

# Línea base de regresión — meses completos de cartera en staging

`node scripts/cargar-meses-staging.js --ejecutar` carga en staging **meses completos de
cartera real** (por defecto los dos últimos meses cerrados) para poder responder, antes de
soltar un cambio, la única pregunta que importa: **¿siguen cuadrando los números?**

Sin esto, staging sirve para ver que una pantalla no reviente. Con esto, corres el mismo
informe en los dos ambientes y exiges que las cifras den idénticas.

**Cómo se elige qué traer.** El ancla son los `creditos` cuyo `mes` cae en los meses pedidos;
de ahí cuelga todo lo demás — clientes, cuotas, pagos, cartas, cartolas, post venta,
fundantes y contabilidad. **Traer media operación sería peor que no traerla**: cuadraría mal y
nadie sabría si es el cambio o la carga. La contabilidad se trae por **comprobante completo**
(no por movimiento suelto), o el asiento no cuadraría.

```bash
node scripts/cargar-meses-staging.js                       # simulación: dice qué traería
node scripts/cargar-meses-staging.js --ejecutar            # los 2 últimos meses cerrados
node scripts/cargar-meses-staging.js --ejecutar --meses=2026-05,2026-06
node scripts/cargar-meses-staging.js --ejecutar --limpiar  # vacía antes de cargar
```

**OJO con el orden**: `crear-bd-staging.js --recrear` borra la base entera, así que después de
recrear hay que **volver a cargar los meses**.

## Carga del 04-08-2026 (junio y julio) — verificada al peso

2.145 operaciones · 1.543 clientes · 19 tablas · 8.104 filas.

| Indicador | Producción | Staging |
|---|---:|---:|
| Operaciones | 2.145 | 2.145 |
| Monto financiado | 18.338.919.731 | 18.338.919.731 |
| Saldo precio | 15.733.323.239 | 15.733.323.239 |
| Comisión dealer | 938.639.703 | 938.639.703 |
| Comisión ejecutivo | 14.938.129 | 14.938.129 |
| Ingreso neto total | −7.776.767 | −7.776.767 |
| Otorgadas | 162 | 162 |
| Contabilidad debe | 6.319.469.367 | 6.319.469.367 |
| Contabilidad haber | 6.319.469.367 | 6.319.469.367 |

Integridad comprobada: **0** operaciones sin su cliente y **0** clientes con correo real.

**Los datos son reales** (nombres y RUT); lo que no viaja es la posibilidad de contactar a
alguien. Los correos y teléfonos se enmascaran en la copia, y `ENTORNO=staging` ya fuerza el
Modo Desarrollo y apaga los motores que envían. Son dos candados independientes.

## Cómo se usa antes de un cambio

1. Anota las cifras de producción del informe que vas a tocar (o usa la tabla de arriba).
2. Aplica el cambio en la rama `staging` y espera el deploy.
3. Corre el MISMO informe en staging y compara.
4. Si un número se movió y no debía moverse, el cambio tiene un efecto que no viste venir.

**Si difiere un número que nadie tocó, sospecha primero de la carga, no del sistema** — vuelve
a cargar los meses y compara de nuevo antes de salir a buscar un bug que puede no existir.

---

# Host alternativo: Google Cloud Run (decidido 04-08-2026)

Cierra el único escenario que el `docs/RUNBOOK-contingencia-bd.md` declaraba **sin plan
probado**: qué hacer si Render cae por horas. La base ya tenía contingencia ensayada
(Google Cloud SQL); lo que faltaba era **dónde correr la aplicación**.

**Precios verificados en la calculadora de Google** (región `us-east4`, 1 vCPU, 512 MiB):

| Escenario | Configuración | Costo |
|---|---|---:|
| **Standby dormido** (permanente) | request-based, escala a cero, `MOTORES=off` | **US$1,01/mes** |
| **Promovido** (durante la caída) | CPU siempre asignada, `min-instances=1`, sin `MOTORES` | **US$26,96/mes** |

Tener la contingencia lista cuesta **US$12 al año**. Dos días de caída suman **menos de US$2**.

Presupuesto del standby guardado (Google Pricing Calculator, precios al 04-08-2026):
<https://cloud.google.com/calculator?dl=CjhDaVJsWldGbE9EZzNaaTA1TnpRd0xUUm1Nell0WWpRek1TMWpPVFU1WVRKak5XVTRNRE1RQVE9PRokNzhBQzIyRjgtMDYzMC00NzU0LUI4QTEtOTlBMEFCNEEzQzQz>

Desglose: 40.000 vCPU·s = US$0,96 · 20.000 GiB·s = US$0,05 · 100.000 peticiones = US$0
(gratis hasta 2 millones). **Es conservador**: un standby real atiende una fracción de esas
peticiones, y el tier gratuito cubre 180.000 vCPU·s mensuales contra los 40.000 de acá — en la
práctica puede salir US$0.

Las dos tarifas explican por qué los escenarios difieren tanto: *request-based* cobra
US$0,000024 por vCPU·segundo, mientras que *CPU siempre asignada* cuesta cerca de la mitad
(~US$0,00001) pero se paga las 24 horas. Barato por segundo, caro por mes.
La región no altera el precio (Bélgica y Virginia son ambas Tier 1): se elige `us-east4`
solo por latencia a TiDB. **No activar el Committed Use Discount** — es un compromiso de
3 años sobre una caja de emergencia que ojalá nunca se use.

## Por qué el standby puede estar dormido

Porque lleva `MOTORES=off` y entonces **no tiene nada que hacer** hasta que alguien lo llame.
Sin esa variable habría dos opciones, ambas malas: dejarlo encendido pagando US$27 al mes por
un proceso que duplica cada reloj del principal, o no desplegarlo nunca y descubrir en plena
emergencia que no arranca.

Nombres de Google, que confunden porque describen *cómo se cobra* y no *para qué sirve*:
- *"Charged only when processing"* → el contenedor **se apaga** cuando nadie lo llama → **standby**.
- *"Charged for the entire lifecycle"* → el contenedor **queda encendido** con CPU completa → **promovido**.

En una línea: **el que duerme paga por rato, el que trabaja paga por mes.** El promovido
necesita CPU siempre asignada porque con facturación por petición Google le corta la CPU
entre llamadas, y los `setInterval` de los motores no dispararían.

**Costo del diseño:** arranque en frío de 30-60 s en la primera petición tras la promoción
(el sistema corre migraciones al arrancar). Aceptable para una emergencia.

## Pendiente

Desplegar y **ensayar la promoción de verdad al menos una vez**. Un plan no probado no es un
plan: el gotcha de las claves foráneas TiDB→MySQL solo apareció al restaurar en serio, y
habría sido fatal descubrirlo en medio de la emergencia.
