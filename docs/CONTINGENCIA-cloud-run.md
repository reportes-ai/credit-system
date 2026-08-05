# Host de contingencia — Google Cloud Run

> **Qué es esto.** Un segundo servidor, siempre listo, que puede tomar el control si Render
> —donde vive la Suite— se cae por horas. Construido y ensayado el **04-08-2026**.
>
> Antes de esta fecha, el `RUNBOOK-contingencia-bd.md` declaraba este escenario como el
> **único sin plan probado**: los datos tenían contingencia ensayada (Google Cloud SQL), pero
> no existía **dónde correr la aplicación**.

---

## 1. Lo esencial, en diez líneas

| | |
|---|---|
| **Servicio** | `afbs-standby` · Cloud Run · proyecto `autofacil-bs` · región `us-east4` |
| **URL directa** | `https://afbs-standby-821999538473.us-east4.run.app` |
| **Dominio propio** | `https://afbs2.autofacilchile.cl` |
| **Base de datos** | la **misma** de producción (TiDB). No tiene datos propios. |
| **Estado normal** | dormido · escala a cero · `MOTORES=off` |
| **Arranque en frío** | **5 segundos** · ya despierto responde en 0,2 s |
| **Costo dormido** | **US$1/mes** (probablemente US$0: el nivel gratuito cubre el uso) |
| **Costo promovido** | US$27/mes, **prorrateado por hora** — 2 días de caída ≈ US$2 |
| **Se actualiza** | **solo, todos los días a las 05:00** de Chile |
| **Promoción** | **un comando** (sección 4) |

**Panel:** `console.cloud.google.com/run/detail/us-east4/afbs-standby`

---

## 2. Cómo funciona, y por qué así

### Dos hosts, una sola base

```
                    ┌──────────────────────┐
   afbs...cl  ────► │ Render (producción)  │ ──┐
                    │ 27 motores ENCENDIDOS│   │
                    └──────────────────────┘   │      ┌─────────────┐
                                               ├────► │    TiDB     │
                    ┌──────────────────────┐   │      │ (una sola)  │
   afbs2...cl ────► │ Cloud Run (respaldo) │ ──┘      └─────────────┘
                    │ 27 motores APAGADOS  │
                    └──────────────────────┘
```

El **código** está duplicado: Render lo despliega desde `main` en cada push; Cloud Run tiene
su propia copia dentro de una imagen de contenedor. Los **datos** no: hay una sola base, y por
eso el standby puede reemplazar a producción sin migrar ni sincronizar nada.

### El interruptor `MOTORES=off` es la pieza clave

El sistema tiene **27 motores automáticos** que no esperan a que nadie los llame: aprueban
comisiones, desisten aprobados vencidos, cierran castigos, generan devengos de vacaciones,
escalan tickets y workflows, mandan correos programados y cobranza.

**Si los dos hosts los ejecutaran a la vez contra la misma base, cada reloj dispararía dos
veces — y el daño es silencioso.** Una comisión aprobada dos veces no se queja. Un devengo
duplicado tampoco.

Por eso el standby corre con `MOTORES=off`: **atiende peticiones pero no ejecuta nada solo.**
Eso es lo que permite tenerlo desplegado, probado y despierto sin que estorbe. Sin ese
interruptor solo quedaban dos opciones, ambas malas: pagarlo encendido duplicando el trabajo
de producción, o no desplegarlo nunca y descubrir en plena emergencia que no arranca.

*(Antes del 04-08-2026 solo 8 de los 27 temporizadores eran apagables; los otros 19 eran
`setInterval` sueltos dentro de los controllers. Migrarlos todos a `shared/scheduler.js` fue
el requisito previo para que esta contingencia existiera.)*

### La cinta de aviso

Quien entre a `afbs2` mientras el respaldo está dormido ve una **banda naranja**:

> `SISTEMA DE CONTINGENCIA — NO ES EL SISTEMA EN USO · ENTRA POR afbs.autofacilchile.cl`

Se engancha al mismo interruptor que decide si ejecuta motores (`/api/health` → `standby`),
así que **no puede quedar desincronizada**: al promoverlo, desaparece sola, porque en ese
momento sí pasa a ser el sistema real.

---

## 3. Comprobar que está vivo (hazlo de vez en cuando)

```bash
curl https://afbs2.autofacilchile.cl/api/health
```

Respuesta sana **en estado de reposo**:

```json
{"status":"ok","db":true,"entorno":"produccion","standby":true,"motores_apagados":[ …27… ]}
```

| Campo | Qué significa |
|---|---|
| `db: true` | alcanza la base de producción desde Google |
| `entorno: produccion` | **no** es staging — usa datos reales |
| `standby: true` | corre con `MOTORES=off`, o sea que **no** ejecuta motores |
| `motores_apagados` | los 27 nombres. En producción esta lista viene **vacía** |

**Si `standby` viniera `false` sin que nadie lo haya promovido, hay un problema serio**:
significa que está ejecutando motores en paralelo con Render.

La primera petición puede demorar 5 segundos si estaba dormido. Si a los 30 segundos no
responde, no está despertando: algo está mal.

---

## 4. PROMOVERLO (cuando Render no vuelve)

> Antes de esto, agota el punto 11 del runbook: **Manual Deploy → Deploy latest commit** en
> Render resuelve la mayoría de los casos en 3 minutos. Promover y volver atrás cuesta más
> que esperar si la caída es de minutos.

### Paso 1 — Confirmar que responde

```bash
curl https://afbs2.autofacilchile.cl/api/health
```

### Paso 2 — Encender los motores (un comando)

```bash
gcloud run services update afbs-standby --region us-east4 \
  --remove-env-vars MOTORES --min-instances 1 --no-cpu-throttling --memory 2Gi
```

Qué hace cada parte:
- `--remove-env-vars MOTORES` → enciende los 27 motores automáticos
- `--min-instances 1` + `--no-cpu-throttling` → lo deja despierto con CPU completa, que es lo
  que los motores necesitan (con facturación por petición, Google le corta la CPU entre
  llamadas y los temporizadores no dispararían)
- `--memory 2Gi` → iguala la memoria de Render

### Paso 3 — Verificar

```bash
curl https://afbs2.autofacilchile.cl/api/health
```

Ahora `motores_apagados` debe venir **vacío** (`[]`) y `standby` en `false`. La cinta naranja
desaparece sola.

### Paso 4 — Mandar a la gente

Reparte **`https://afbs2.autofacilchile.cl`**. Ya está configurado y propagado: no hay que
tocar DNS en plena emergencia.

Si la caída se alarga y prefieres que la gente siga usando la dirección de siempre, en el
panel DNS de **Wix** (no NIC, no Google) apunta `afbs` al dominio de Cloud Run. Eso sí tarda
en propagarse; hazlo en paralelo, no como primer paso.

---

## 5. VOLVER ATRÁS (cuando Render se recupera)

> **El orden importa y no es negociable.** Si los dos quedan con los motores encendidos
> contra la misma base, cada reloj dispara dos veces.

### Paso 1 — PRIMERO apagar los motores del standby

```bash
gcloud run services update afbs-standby --region us-east4 \
  --update-env-vars MOTORES=off --min-instances 0 --cpu-throttling --memory 1Gi
```

### Paso 2 — Recién entonces levantar Render

Y devolverle el tráfico.

### Paso 3 — Confirmar que quedó uno solo mandando

```bash
curl https://afbs.autofacilchile.cl/api/health    # producción → "motores_apagados":[]
curl https://afbs2.autofacilchile.cl/api/health   # respaldo   → "standby":true, los 27 apagados
```

### Paso 4 — Lo digitado durante la contingencia

**No hay nada que migrar.** A diferencia de la contingencia de base de datos, acá los dos
hosts escriben en la MISMA base: todo lo que se hizo durante la caída ya está donde
corresponde.

---

## 6. Lo que el standby NO puede hacer

**Desde el 05-08-2026 hace prácticamente todo**: tiene **33 variables**, con las
integraciones cargadas (indicadores, IA, WhatsApp, DealerNet, Workera, Google, SimpleAPI).
Antes tenía solo las 16 del núcleo.

Lo único que sigue sin funcionar promovido:

| Falta | Por qué |
|---|---|
| **SII / RCV** (`SII_CLAVE`, `SII_RUT_USUARIO`) | Las de Render **están malas** y no sirve copiar un valor equivocado: disimularía el pendiente. Tampoco funciona hoy en producción |
| **Fintoc** (`FINTOC_SECRET_KEY`) | No está cargada en Render tampoco — la integración bancaria sigue en sandbox |
| Certificado digital SII (`SII_CERT_*`) | Igual que arriba |

### Las llaves van a Secret Manager, no como variable plana

Las 14 sensibles se guardan como secretos (`afbs-<nombre-en-minúscula>`) y el servicio las
referencia; solo la configuración inocua —URLs, puertos, RUT de la empresa, IDs públicos—
va como variable normal. Se respetó la convención que ya existía para `DB_PASSWORD` y
`JWT_SECRET`: media configuración en un lugar y media en otro es cómo se pierde el rastro
de dónde vive cada llave.

**Cómo se cargan** (no a mano — veinte copy-paste es donde uno se pega mal, y ese error
solo aparece el día que se promueve el host):

```bash
node scripts/sincronizar-env-standby.js            # compara y muestra, sin tocar nada
node scripts/sincronizar-env-standby.js --aplicar
```

Lee las variables de Render por su API y carga en Cloud Run las que faltan, **sin imprimir
ni un valor** y sin pasarlos por la línea de comandos. Necesita una API key de Render, que
se revoca apenas termina.

**Tres cosas que el script se niega a copiar, y conviene entender por qué:**

- **`MOTORES`** — el standby debe seguir apagado. Aborta si el resultado no es `off`.
- **`GCS_CREDENCIALES`** — en Cloud Run sobra: el servicio usa su propia identidad, sin
  llave que rotar ni que se pueda filtrar. Copiarla sería un retroceso.
- **`APP_URL`** — se fuerza a la del standby. Copiar la de producción haría que los correos
  del host de respaldo enlacen al servidor caído: el error más fácil de cometer y el más
  difícil de notar.

> **Trampa que costó encontrar:** `gcloud run services update --env-vars-file` **reemplaza
> todo el conjunto** y, como las referencias a Secret Manager no traen valor legible, un
> volcado ingenuo las borra — el standby se queda sin base de datos. Hay que usar
> `--update-env-vars` / `--update-secrets`, que son aditivos.

### Los documentos SÍ los alcanza (y hay que verificarlo)

Los archivos que suben los usuarios ya no viven en la base sino en el bucket
`gs://autofacil-docs` (📘 `docs/ALMACEN-documentos.md`). El standby **sí** llega a ellos,
usando su propia identidad de Cloud Run — sin llave que cargar. Se comprueba de un vistazo:

```bash
curl -s https://afbs2.autofacilchile.cl/api/health | grep -o '"documentos":{[^}]*}'
```

Debe decir `"activo":true`. **Si dijera `false`, todo documento ya migrado sería
inaccesible desde el standby** — no se perdería nada, pero no se podría abrir hasta
restablecer el acceso al bucket.

**Es una degradación deliberada, no un descuido.** Para una caída de horas es aceptable: la
operación del negocio sigue. El sistema lo informa solo en el log de arranque, listando cada
variable ausente y qué módulo deja fuera de servicio.

**Si quieres cobertura total**, hay que cargar esas claves como secretos:

```bash
printf '%s' 'VALOR' | gcloud secrets create afbs-cmf-api-key --data-file=- --replication-policy=automatic
gcloud secrets add-iam-policy-binding afbs-cmf-api-key \
  --member="serviceAccount:821999538473-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud run services update afbs-standby --region us-east4 \
  --update-secrets CMF_API_KEY=afbs-cmf-api-key:latest
```

---

## 7. Se reconstruye solo, todos los días

**El problema que resuelve:** Render se actualiza en cada push, pero la imagen de Cloud Run
queda **congelada**. Sin automatización el respaldo envejece en silencio, y el día de la
emergencia levantaría una versión vieja contra una base que ya avanzó.

```
Cloud Scheduler  ──►  activador Cloud Build  ──►  construye · despliega · VERIFICA
"standby-diario"       "standby-reconstruir"       (cloudbuild.yaml)
05:00 Chile, diario    invocación manual
```

| Pieza | Detalle |
|---|---|
| Trabajo programado | `standby-diario` · `us-east4` · `0 5 * * *` · huso `America/Santiago` |
| Activador | `standby-reconstruir` · región `global` · **invocación manual** (no en cada push) |
| Receta | `cloudbuild.yaml` en la raíz del repositorio |
| Cuenta de servicio | `cloudbuild-standby@autofacil-bs.iam.gserviceaccount.com` |
| Costo | **US$0** — Cloud Build regala 120 min/día y el build dura 33 s |

**La cuenta de servicio es dedicada y mínima a propósito.** Solo publica la imagen, actualiza
`afbs-standby` y escribe sus registros: **no lee secretos, no toca la base, no modifica nada
más del proyecto**. La consola ofrece por defecto la cuenta de Compute, que tiene rol
*Editor* — y como el `cloudbuild.yaml` vive en el repositorio, cualquiera con permiso de
escritura en `main` heredaría esos permisos.

**El último paso es una comprobación, no un adorno:** consulta `/api/health` y **falla la
compilación** si `db` no es `true` o si `standby` no es `true`.

### Comprobar que la automatización sigue viva

```bash
gcloud scheduler jobs describe standby-diario --location=us-east4
gcloud builds list --region=global --limit=5
```

Si `status.code` del trabajo viene **vacío**, la última ejecución salió bien. Cualquier
número es un fallo (7 = permiso denegado).

### Reconstruir a mano (antes de una promoción larga)

```bash
gcloud builds triggers run standby-reconstruir --region=global --branch=main
```

---

## 8. Cómo se armó (para poder rehacerlo)

Orden real de construcción, por si hay que repetirlo en otro proyecto o proveedor:

1. **APIs habilitadas**: `run`, `cloudbuild`, `artifactregistry`, `secretmanager`.
2. **Repositorio de imágenes**: `gcloud artifacts repositories create autofacil --repository-format=docker --location=us-east4`.
3. **Secretos** en Secret Manager: `afbs-db-user`, `afbs-db-password`, `afbs-jwt-secret`,
   `afbs-mail-user`, `afbs-mail-pass`. El resto (`DB_HOST`, `DB_PORT`, `MAIL_HOST`,
   `MAIL_FROM`, `ALERTA_ERRORES_MAIL`) van como variables normales: no son secretos y no
   tiene sentido pagar por cifrarlos.
4. **Imagen**: `gcloud builds submit --tag us-east4-docker.pkg.dev/autofacil-bs/autofacil/suite:v1`.
5. **Servicio**: `gcloud run deploy afbs-standby` con `MOTORES=off`, `--min-instances 0`,
   `--memory 1Gi`, `--allow-unauthenticated`.
6. **Dominio**: verificar `autofacilchile.cl` en Search Console (TXT en Wix) → mapeo de
   dominio en Cloud Run → CNAME `afbs2` → `ghs.googlehosted.com` en Wix.
7. **Automatización**: conexión de GitHub en Cloud Build → activador manual → Cloud Scheduler.

### El `JWT_SECRET` es el MISMO de producción — a propósito

Así una sesión abierta sigue valiendo cuando el standby toma el control: nadie tiene que
volver a entrar. (Staging, en cambio, tiene el suyo propio y aislado: un token de pruebas
jamás debe servir en producción.)

### Cinco tropiezos que costaron tiempo

Se dejan escritos porque volverían a aparecer en cualquier despliegue similar:

1. **Render autodetecta "Docker"** por el `Dockerfile` del repositorio, pero producción corre
   como servicio **Node**. Hay que forzarlo (ya estaba advertido dentro del propio Dockerfile).
2. **`.dockerignore` y `.gcloudignore` parecen lo mismo y hacen lo opuesto** con el
   `Dockerfile`: el primero debe excluirlo (dentro de la imagen no sirve), el segundo **jamás**
   (es la receta que Cloud Build necesita). Copiar uno sobre el otro botó una compilación con
   `lstat /workspace/Dockerfile: no such file`.
3. **Las variables de bash dentro de `cloudbuild.yaml` van con `$$`.** Con un solo signo,
   Cloud Build cree que es una sustitución suya y rechaza el archivo entero.
4. **`gcloud` no puede crear el activador** con la conexión clásica de GitHub: tanto el CLI
   como la API REST responden `INVALID_ARGUMENT` porque falta un identificador de instalación
   que solo la consola conoce. Hay que crearlo por interfaz — pero después sí se puede
   **modificar** por API (así se le cambió la cuenta de servicio sin rehacer el formulario).
5. **Una cuenta de servicio no puede actuar como sí misma** por defecto. Como el trabajo
   programado corre con la misma cuenta que usa el activador, hubo que darle
   `iam.serviceAccountUser` **sobre sí misma** o Cloud Scheduler respondía código 7.

### Por qué el `Dockerfile` no usa `npm start`

`npm start` fija el heap de Node en 1536 MB, calibrado a los 2 GB de Render. En un contenedor
de 512 MB o 1 GB eso lo mataría. Sin el flag, Node dimensiona el heap según la memoria que el
contenedor **de verdad** tiene.

Y corre **Node 22**, igual que el CI y producción: un host de contingencia que usa otro motor
no es contingencia, es una sorpresa esperando la emergencia.

---

## 9. Datos medidos (no estimados)

| Medición | Valor | Cómo se obtuvo |
|---|---|---|
| Arranque en frío | **5,0 s** | Registros: *Starting new instance* 18:22:00.553 → *API Gateway escuchando* 18:22:05.558 |
| Respuesta ya despierto | **0,2 s** | `curl` repetido a `/api/health` |
| Duración del build | **33 s** | Historial de Cloud Build |
| Costo dormido | **US$1,01/mes** | Calculadora de Google: 40.000 vCPU·s + 20.000 GiB·s + 100k peticiones |
| Costo promovido | **US$26,96/mes** | Calculadora, CPU siempre asignada, 1 vCPU / 512 MiB |

**Las migraciones no bloquean el arranque.** El gateway atiende de inmediato y la cola de
`shared/migrate.js` corre detrás unos 5 minutos. Ese diseño, que existía por otro motivo, es
lo que hace que el standby despierte casi instantáneo.

*Efecto secundario:* cada arranque en frío ejecuta toda la tanda de migraciones contra la base
de producción. Son idempotentes y no cambian nada, pero consumen ~5 minutos de consultas en
TiDB. Irrelevante para un respaldo que despierta de vez en cuando.

---

## 10. Pendientes conocidos

- [ ] **Cargar las claves de integración** como secretos, si se quiere cobertura total (§6).
- [x] ✅ **Verificación en dos pasos de Google** — activada el 04-08-2026, antes del plazo del
      20 de octubre. Ver §11 abajo: **sin acceso a la consola no se puede promover nada de
      esto**, así que el acceso de Pato es parte de la contingencia, no un trámite aparte.
- [ ] **Ensayar la promoción completa una vez al año**, idealmente contra la base de staging
      para no duplicar motores. El ensayo del 04-08-2026 se hizo así y funcionó.

---

## 11. El acceso a la consola ES parte de la contingencia

De nada sirve un host de respaldo si el día de la emergencia nadie puede entrar a Google Cloud
a promoverlo. Por eso el acceso de la cuenta se trata como una pieza más del plan.

**Estado (04-08-2026):** verificación en dos pasos **activada** en
`patricio.escobar@autofacilchile.cl`, con cuatro segundos factores:

| Factor | Estado |
|---|---|
| App de autenticación (TOTP) | ✅ configurada |
| Mensaje de Google | ✅ 2 dispositivos |
| Número de teléfono | ✅ |
| **Códigos de respaldo (papel)** | ✅ generados y guardados **en dos lugares físicos distintos** |

**Dónde están los códigos de respaldo:** deliberadamente **NO se escribe acá**. Este documento
vive en GitHub, y anotar el lugar exacto le daría a cualquiera con acceso al repositorio el
mapa para saltarse el segundo factor. **Pato sabe dónde están** — uno de los dos lugares lo
lleva encima; el otro está en la oficina.

**Por qué el papel importa más de lo que parece.** El escenario a cubrir no es "olvidé la
contraseña": es **Render caído, Pato fuera de la oficina, y el teléfono sin batería o
extraviado**. Si los tres factores viven en el mismo teléfono, ese día no hay acceso a la
consola y la contingencia queda inservible justo cuando se necesita. Los códigos en papel son
el único factor que no depende de ese aparato.

**Al usar un código de respaldo, se quema.** Son de un solo uso: hay que regenerar el juego
completo después de una emergencia.

### Pendiente relacionado

- [ ] **Exigir MFA a todo el equipo** (Workspace lo permite desde la consola de administración).
      Afecta a las ~40 personas, así que merece su propio plan: avisar, dar plazo y acompañar a
      quien se complique. Lo urgente —la cuenta que administra la infraestructura— ya está cubierto.
