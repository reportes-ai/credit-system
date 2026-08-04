# RUNBOOK DE EMERGENCIAS — AutoFácil Business Suite

> **Documento autocontenido.** Se lo puedes pasar tal cual a un técnico, a un colega o
> pegárselo a la IA de desarrollo (Claude) para que ejecute los pasos. No requiere
> conocer el resto del sistema.
>
> Última verificación real: **2026-07-27** (restauración de BD probada de punta a punta).

---

## MAPA: ¿qué se cayó? → ¿a dónde ir?

| Síntoma | Qué falló | Ir a | Estado del plan |
|---|---|---|---|
| El sistema abre pero da errores de datos / no carga nada | **TiDB (base de datos)** | Secciones 0 a 8 | ✅ **Probado 27-07-2026** |
| El sitio no abre / error 502 / "service unavailable" | **Render (servidor)** | Sección 11 · si no vuelve → **11-bis** | ✅ Probado (Cloud Run, 04-08-2026) |
| No se puede desplegar; no llegó el respaldo de anoche | **GitHub** | Sección 12 | ✅ Mitigado |
| No se puede bajar el respaldo del bucket | **Google Cloud Storage** | Sección 13 | ✅ Mitigado |
| El dominio no resuelve (el sitio "no existe") | **DNS / dominio** | Sección 14 | ⚠️ Verificar registrador |
| Alguien borró o corrompió datos (el sistema funciona) | **Error humano** | Sección 15 | ✅ Mismo procedimiento |
| Se filtró una clave / acceso indebido | **Seguridad** | Sección 16 | ⚠️ Sin plan probado |
| No salen correos / WhatsApp / IA / UF desactualizada | **Servicio externo** | Sección 17 | ✅ Degrada solo |

> **Diagnóstico rápido antes de actuar**: abre `https://<dominio>/api/health`.
> Responde `{status:'ok', db:true}` si el servidor y la base están vivos.
> - **No responde nada** → problema de Render o de DNS (secciones 11 / 14).
> - **Responde con `db:false` o error 503** → Render está bien, la base cayó (sección 0).

---

# PARTE A — Caída de la base de datos (TiDB)

## 0. Qué pasó y qué vas a hacer

El sistema (AutoFácil Business Suite, en Render) usa **TiDB Cloud** como base de datos.
Si TiDB cae de forma prolongada, el sistema queda inutilizable.

La contingencia es una **instancia MySQL en Google Cloud SQL, ya creada y con los datos
adentro, que vive apagada**. El plan es: encenderla, poner los datos al día y apuntar el
sistema hacia ella. Vuelve a operar en ~15 minutos.

**Qué se pierde**: el respaldo automático corre a las **02:17 de la mañana (hora Chile)**.
En el peor caso se pierde lo digitado desde esa hora hasta el momento de la caída. La
restauración deja el sistema **al cierre de la noche anterior**.

---

## 1. Datos que necesitas antes de empezar

| Qué | Valor |
|---|---|
| Proyecto Google Cloud | `AutoFacil BS` (`autofacil-bs`) — consola: console.cloud.google.com |
| Instancia de contingencia | `autofacil-contingencia` (Cloud SQL → MySQL 8.4, región Santiago) |
| Host / IP pública | `34.176.225.253` |
| Puerto | `3306` |
| Usuario | `root` |
| Contraseña root | **La tiene Pato en su gestor de contraseñas** (se generó al crear la instancia). No está escrita en ningún archivo, a propósito. |
| Base de datos | `credit_system` |
| Bucket con los respaldos | `gs://autofacil-respaldos-bd` (Cloud Storage, mismo proyecto) |
| Respaldo alternativo | GitHub → repo `reportes-ai/credit-system` → pestaña **Actions** → workflow *Backup BD nocturno* → Artifacts (30 días) |
| Panel del servidor | dashboard.render.com → servicio del **api-gateway** |

⚠️ **Antes de tocar Render, copia y guarda en un bloc de notas los valores actuales de
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`** — los vas a necesitar para volver a TiDB
cuando se recupere.

---

## 2. Encender la instancia de contingencia

1. Entra a console.cloud.google.com con la cuenta de Pato.
2. Selecciona arriba el proyecto **AutoFacil BS**.
3. Menú → **SQL** (o busca "Cloud SQL" en el buscador).
4. Entra a `autofacil-contingencia` → botón **Iniciar**. Tarda unos minutos.
5. Cuando esté verde, ve a **Conexiones → Redes** y agrega la IP pública del computador
   desde el que vas a trabajar, en formato `TU.IP.AQUI/32`
   (para saber tu IP: busca en Google *"cual es mi ip"*). **Guardar**.

> La instancia ya tiene datos restaurados del **27-07-2026**. Si esa foto te sirve
> (por ejemplo, para revisar algo puntual), puedes saltarte el paso 3. Para operar de
> verdad, sigue al paso 3 y carga el respaldo más reciente.

---

## 3. Bajar el respaldo más reciente

1. En la misma consola de Google → **Cloud Storage** → bucket **`autofacil-respaldos-bd`**.
2. Descarga el archivo más nuevo: `backup-AAAAMMDD.sql.gz` (uno por día, ~50 MB).
   - *Si Cloud Storage también estuviera caído*: usa GitHub → Actions → *Backup BD nocturno*
     → última corrida → sección **Artifacts** → descargar el `.zip`.
3. Descomprímelo. En Windows no existe `gunzip`; usa 7-Zip, o este comando en PowerShell
   (ajusta la fecha del archivo):

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$in=[IO.File]::OpenRead("$env:USERPROFILE\Downloads\backup-20260727.sql.gz")
$out=[IO.File]::Create("$env:USERPROFILE\Downloads\backup-20260727.sql")
(New-Object IO.Compression.GZipStream($in,[IO.Compression.CompressionMode]::Decompress)).CopyTo($out)
$out.Close(); $in.Close()
```

---

## 4. ⚠️ PASO OBLIGATORIO: arreglar los nombres de llaves foráneas

**No te saltes esto.** TiDB nombra las restricciones de llave foránea de forma genérica
(`fk_1`, `fk_2`, …) y **repite esos nombres en varias tablas**. TiDB lo permite; MySQL real
(Cloud SQL) exige que sean únicos en todo el esquema.

**Si restauras sin este arreglo, el restore falla a medias y tablas críticas —
incluida `usuarios`— quedan VACÍAS, y el error es fácil de pasar por alto.**

Guarda este archivo como `fix-fk-names.js` (en la misma carpeta del respaldo) y ejecútalo
con Node (`node fix-fk-names.js <archivo.sql> <archivo-fixed.sql>`):

```js
const fs = require('fs');
const data = fs.readFileSync(process.argv[2], 'utf8');
let n = 0;
const fixed = data.replace(/CONSTRAINT `fk_\d+`/g, () => `CONSTRAINT \`fk_auto_${++n}\``);
fs.writeFileSync(process.argv[3], fixed, 'utf8');
console.log('Reemplazos hechos:', n);
```

Ejemplo:

```powershell
node fix-fk-names.js "$env:USERPROFILE\Downloads\backup-20260727.sql" "$env:USERPROFILE\Downloads\backup-20260727-fixed.sql"
```

> Los nombres nuevos (`fk_auto_N`) no afectan en nada al sistema: el código nunca
> referencia las restricciones por nombre.

---

## 5. Restaurar los datos

Si no tienes el cliente MySQL instalado:

```powershell
winget install --id Oracle.MySQL --silent --accept-package-agreements --accept-source-agreements
```

Queda en `C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe`.

**5.1 — Vaciar y recrear la base** (te pedirá la contraseña root):

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 34.176.225.253 -P 3306 -u root -p --ssl-mode=REQUIRED -e "DROP DATABASE IF EXISTS credit_system; CREATE DATABASE credit_system;"
```

**5.2 — Cargar el respaldo corregido** (tarda varios minutos, ~220 MB):

```powershell
Get-Content "$env:USERPROFILE\Downloads\backup-20260727-fixed.sql" | & "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 34.176.225.253 -P 3306 -u root -p --ssl-mode=REQUIRED --force credit_system 2>"$env:USERPROFILE\Downloads\restore-errores.log"
```

**5.3 — Verificar que quedó completa** (los números deben parecerse a estos):

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -h 34.176.225.253 -P 3306 -u root -p --ssl-mode=REQUIRED credit_system -e "SELECT COUNT(*) tablas FROM information_schema.tables WHERE table_schema='credit_system'; SELECT COUNT(*) usuarios FROM usuarios; SELECT COUNT(*) creditos FROM creditos;"
```

Referencia del 27-07-2026: **386 tablas · 39 usuarios · 17.511 créditos**.
Si `usuarios` sale 0 o la cuenta de tablas es mucho menor → el paso 4 no se hizo bien.
Revisa también `restore-errores.log`: debe estar vacío.

---

## 6. Apuntar el sistema a la base de contingencia

Este es el paso que devuelve el sistema a la vida.

1. Entra a **dashboard.render.com** → servicio del **api-gateway**.
2. Pestaña **Environment**.
3. ✅ **Primero copia los valores actuales a un bloc de notas** (los necesitas para volver).
4. Cambia estas cuatro variables:

```
DB_HOST     = 34.176.225.253
DB_PORT     = 3306
DB_USER     = root
DB_PASSWORD = (la contraseña root de la instancia)
```

5. **Guardar**. Render redespliega solo (~2-3 minutos).
6. Entra al sistema y verifica que carguen el dashboard y el listado de créditos.
7. **Avisa a todo el equipo** que se está operando en modo contingencia y que lo digitado
   después de las 02:17 del día de la caída debe volver a ingresarse.

---

## 7. Cuando TiDB se recupere (volver a la normalidad)

1. En Render → Environment → restaura las **cuatro variables originales** que guardaste.
2. Guardar → redeploy automático.
3. **Ojo con los datos digitados durante la contingencia**: quedaron en Cloud SQL y **no se
   sincronizan solos** a TiDB. Si la ventana fue corta, lo más simple es reingresarlos a
   mano. Si fue larga, pídele a la IA de desarrollo que arme la migración de esas filas.
4. Vuelve a **Detener** la instancia en Cloud SQL (Cloud SQL → autofacil-contingencia →
   **Detener**), o seguirás pagando el cómputo.

---

## 8. Costos (para decidir sin miedo)

| Estado | Costo |
|---|---|
| Detenida (lo normal) | ~**US$2,4 / mes** — solo el disco de 10 GB |
| Encendida | US$0,20 / hora ≈ **US$4,8 / día** (≈US$146/mes si quedara 24/7) |

Por eso **siempre hay que volver a detenerla** al terminar la emergencia.

---

## 9. Por qué existe esta instancia si ya hay respaldos

Los respaldos en GitHub y en Cloud Storage son **archivos** (`.sql.gz`). Un archivo no
levanta el sistema: hay que restaurarlo dentro de un motor de base de datos real. Tener la
instancia ya creada y provisionada convierte una emergencia de *"armar un servidor bajo
presión"* en *"encender y cambiar cuatro variables"*.

Se eligió **2 vCPU / 8 GB (Edición Enterprise)** porque apagada no se cobra CPU ni RAM
—solo el disco—, así que una máquina holgada cuesta lo mismo que una chica mientras está
detenida, y cuando de verdad se ocupa: la base completa (54 MB) cabe en memoria, restaura
rápido y aguanta con holgura a los ~39 usuarios. Se descartó el núcleo compartido (pensado
para pruebas, se ahoga con carga real) y la edición Enterprise Plus (fija la serie de
máquina y luego no deja bajar de tamaño).

---

## 10. Resumen ultracorto (si tienes prisa)

1. Cloud SQL → `autofacil-contingencia` → **Iniciar** + autorizar tu IP.
2. Bajar el `.sql.gz` más nuevo del bucket `autofacil-respaldos-bd` y descomprimir.
3. **Correr el fix de llaves foráneas** (paso 4). ← si no, `usuarios` queda vacía.
4. `DROP`/`CREATE` la base y cargar el `.sql` corregido.
5. Verificar: 386 tablas / 39 usuarios / ~17.500 créditos.
6. Render → Environment → cambiar `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD` → guardar.
7. Al recuperar TiDB: revertir variables y **detener** la instancia.

---

# PARTE B — Otras emergencias

> Honestidad sobre el estado de estos planes: están probados de punta a punta **la caída de
> la base (Parte A)** y **la caída de Render (punto 11-bis, host alternativo en Cloud Run,
> ensayado el 04-08-2026)**. El resto es el análisis de qué hacer en cada caso, con las
> mitigaciones que sí existen hoy y los huecos declarados como tales. Donde dice
> "SIN PLAN PROBADO", es literal: hay que decidirlo y ensayarlo antes de necesitarlo.

## 11. Se cayó Render (el servidor de la aplicación)

**Síntoma**: el sitio no abre, error 502/503, o `/api/health` no responde nada.

**Datos del servicio (verificados 27-07-2026):**

| | |
|---|---|
| Nombre del servicio | `credit-system-1` (workspace *Reportes's*, proyecto *My project* → *Production*) |
| **🔑 URL DIRECTA (sin dominio)** | **`https://credit-system-1-zydf.onrender.com`** ← por acá entra todo el mundo si el dominio falla |
| **Link al panel** | `dashboard.render.com/web/srv-d9lovbu417fc73dbaf6g` ← guárdalo, evita buscar en crisis |
| Región | **Virginia (US East)** — la MISMA que TiDB, a propósito (latencia 4 ms vs 74 ms desde Oregon). Si se recrea el servicio, debe quedar en Virginia. |
| Plan | **Standard — 1 CPU, 2 GB** (Start Command con `--max-old-space-size=1536`; ese valor va calibrado al tamaño de la instancia) |
| Repo conectado | `reportes-ai/credit-system`, rama `main` (push a main = deploy automático) |
| Dirección interna | `credit-system-1:10000` — solo red privada de Render, **no sirve desde el navegador** |

**ACCIÓN INMEDIATA (2 minutos, resuelve la mayoría de los casos):**
dashboard.render.com → servicio → **Manual Deploy → Deploy latest commit**.
Reinicia el proceso y levanta el sistema en ~3 minutos. Si vuelve, listo; después
investigas la causa con calma en los Logs.

**Si el redeploy no lo levanta, en este orden:**
1. **status.render.com** — si es caída global de Render, no hay nada que hacer más que
   comunicar y esperar. No sigas tocando.
2. **Logs** del servicio: busca el motivo real de la muerte del proceso.
   - `JavaScript heap out of memory` o reinicios repetidos → **memoria** (ver punto 3).
   - Un error de código en el último despliegue → **Rollback**: en la pestaña Events,
     buscar el deploy anterior que sí funcionaba y hacer *Redeploy* de ese commit.
3. **Metrics**: el plan es de **2 GB** (Standard, desde el 30-07-2026) y el uso normal ronda los **200 MB (~10%)**. Si está
   sostenidamente sobre 70%, hay que **subir de plan** — es la señal documentada en el
   informe semanal de Salud del Sistema.

**Dato clave**: los datos NO viven en Render, viven en TiDB. Una caída de Render es tiempo
fuera de servicio, **nunca pérdida de información**. Cuando vuelve, vuelve tal cual estaba.

**✅ HOST ALTERNATIVO LISTO Y ENSAYADO (04-08-2026) — Google Cloud Run.**
Ver el procedimiento completo en la sección 11-bis, más abajo. En una línea: existe un
servicio dormido en Cloud Run que se promueve con UN comando y toma el control.

**Lo que SÍ está a favor**: los datos no corren riesgo — viven en TiDB, no en Render. Cuando
Render vuelve, el sistema vuelve tal cual estaba.

**🐳 Salvavidas que SÍ existe (nunca ensayado en emergencia, pero está armado): levantar la
Suite en un computador cualquiera con Docker.** No reemplaza a un host público —solo sirve en
la red local— pero permite seguir operando internamente mientras Render no vuelve:

```bash
node scripts/volcar-bd.js       # vuelca la BD (usa el .env actual) → docker/init/dump.sql
docker-compose up -d --build    # levanta MySQL 8 + la app en http://localhost:3000
```

Requiere Docker Desktop instalado y el repositorio clonado. El `Dockerfile` y el
`docker-compose.yml` del repo existen **solo para esto** (producción corre como servicio Node,
no con Docker). Pendiente: ensayarlo una vez de verdad y cronometrar cuánto toma.

---

## 11-bis. Promover el host alternativo (Google Cloud Run)

> **Cuándo usar esto**: Render lleva horas caído y el punto 11 no lo levantó. Si la caída es
> de minutos, espera — promover y volver atrás cuesta más que esperar.

**Qué existe hoy** (creado y verificado el 04-08-2026):

| | |
|---|---|
| Servicio | `afbs-standby` · proyecto `autofacil-bs` · región `us-east4` (Virginia, al lado de TiDB) |
| **🔑 URL** | **`https://afbs-standby-821999538473.us-east4.run.app`** |
| Panel | `console.cloud.google.com/run/detail/us-east4/afbs-standby` |
| Estado normal | **dormido**: escala a cero, `MOTORES=off`, apunta a la base de PRODUCCIÓN |
| Costo dormido | ~US$1/mes · promovido ~US$27/mes, prorrateado por hora |
| Credenciales | Secret Manager: `afbs-db-user`, `afbs-db-password`, `afbs-jwt-secret`, `afbs-mail-user`, `afbs-mail-pass` |

**El standby ya está sirviendo la aplicación completa contra los datos reales** — solo tiene
los motores automáticos apagados. Comparte el `JWT_SECRET` con producción, así que **las
sesiones abiertas siguen valiendo**: nadie tiene que volver a entrar.

### Paso 1 — Comprobar que responde (10 segundos)

```bash
curl https://afbs-standby-821999538473.us-east4.run.app/api/health
```

Debe decir `"db":true` y `"entorno":"produccion"`. La primera petición puede demorar
**hasta un minuto** porque despierta de cero: es normal, no insistas.

### Paso 2 — Promoverlo (un comando)

```bash
gcloud run services update afbs-standby --region us-east4 \
  --remove-env-vars MOTORES --min-instances 1 --no-cpu-throttling --memory 2Gi
```

Eso enciende los 27 motores automáticos y lo deja permanentemente despierto. Verifica:

```bash
curl https://afbs-standby-821999538473.us-east4.run.app/api/health
```

`"motores_apagados"` debe venir **vacío**: `[]`.

### Paso 3 — Mandar a la gente ahí

Reparte la URL del standby. Si la caída va para largo, apunta el dominio: en el panel DNS
de **Wix** (no NIC, no Google — ver punto 14), cambia el CNAME de `afbs` al dominio que
entrega Cloud Run.

### Paso 4 — Cuando Render vuelva

**En este orden, y no al revés:**

1. **Primero apaga los motores del standby** — si los dos quedan encendidos contra la misma
   base, cada reloj dispara dos veces y el daño es silencioso (una comisión aprobada dos
   veces no avisa):
   ```bash
   gcloud run services update afbs-standby --region us-east4 \
     --update-env-vars MOTORES=off --min-instances 0
   ```
2. Recién entonces levanta Render y devuelve el tráfico.
3. Confirma que Render diga `"motores_apagados":[]` y el standby los tenga todos apagados.

### ⚠️ Lo que el standby NO puede hacer

Tiene las **16 variables del núcleo** (base de datos, sesiones, correo), pero **no** las de
las integraciones. Promovido hoy:

- ✅ **Funciona**: créditos, clientes, cartas, cobranza, contabilidad, tesorería, comisiones,
  post venta, portales, y el correo saliente.
- ❌ **No funciona**: sincronización de indicadores (falta `CMF_API_KEY`), IA
  (`ANTHROPIC_API_KEY`), WhatsApp (`WSP_*`), DealerNet, SII y Workera.

Para una caída de horas es una degradación aceptable y **deliberada**. Si quieres cobertura
total, hay que cargar esas claves como secretos — está pendiente.

### Cómo se reconstruye la imagen (si hiciera falta)

```bash
gcloud builds submit --tag us-east4-docker.pkg.dev/autofacil-bs/autofacil/suite:v1
gcloud run services update afbs-standby --region us-east4 \
  --image us-east4-docker.pkg.dev/autofacil-bs/autofacil/suite:v1
```

**El standby NO se actualiza solo.** Su imagen quedó congelada en la versión del día en que
se construyó. Antes de una promoción larga, conviene reconstruirla para llevar los últimos
cambios.

## 12. Se cayó GitHub

**Qué se rompe**: (a) no se puede desplegar código nuevo, y (b) **no corre el respaldo
nocturno**, que es una GitHub Action.

**Qué NO se rompe**: la aplicación en Render sigue funcionando con normalidad, y la base
también. No es una emergencia operativa, es una emergencia de *respaldo*.

**Qué hacer:**
1. Si la caída dura más de un día, **haz un respaldo manual** para no quedar sin copia
   fresca: ejecuta el `mysqldump` desde tu PC contra TiDB y súbelo a mano al bucket de
   Google Cloud Storage. Pídele el comando exacto a la IA de desarrollo (está en el
   workflow `.github/workflows/backup-bd.yml`).
2. Para restaurar mientras GitHub está caído, usa **el bucket de Google Cloud Storage**,
   que tiene los mismos dumps con 90 días de retención (sección 3).
3. Los despliegues quedan en pausa; no fuerces nada.

---

## 13. Se cayó Google Cloud (Storage y/o Cloud SQL)

**Si cayó Cloud Storage** (no puedes bajar el `.sql.gz`): usa **GitHub → Actions → Backup BD
nocturno → Artifacts** (30 días de retención). Es exactamente el mismo dump.

**Si cayó Cloud SQL** (no puedes encender la instancia de contingencia) y **además** TiDB
está caído: queda restaurar en un **cluster o branch nuevo de TiDB Cloud** (si TiDB está
parcialmente operativo) o crear una instancia MySQL en otro proveedor. El dump es MySQL
estándar; el único requisito especial es el arreglo de llaves foráneas de la sección 4.

**Regla de oro de por qué hay tres copias**: TiDB, GitHub y Google son tres proveedores
independientes. Que caigan los tres a la vez es prácticamente imposible; siempre queda uno
desde donde recuperar.

---

## 14. El dominio no resuelve (DNS)

**Síntoma**: `afbs.autofacilchile.cl` no abre en ninguna red, pero la URL directa de Render
(`*.onrender.com`) sí funciona.

**Datos del dominio (verificados 27-07-2026):**

| | |
|---|---|
| Dominio | `autofacilchile.cl` |
| Registrador | **NIC Chile** — administrar en **nic.cl** ("Sistema de Inscripción y Gestión de Dominios" → Mis Dominios) |
| Titular | **Auto Facil SpA** |
| Estado | Vigente ✅ |
| **Vence** | **17-05-2029** |
| Subdominios en uso | `afbs.` (suite interna) · `clientes.` (portal cliente) · `dealers.` (portal dealer) |

**ACCIÓN INMEDIATA (30 segundos):** manda al equipo esta dirección —

### 👉 `https://credit-system-1-zydf.onrender.com`

El sistema funciona idéntico, solo cambia la dirección. Los tres subdominios apuntan a este
mismo servicio, así que esa URL sirve para la suite interna, el portal de clientes y el de
dealers por igual.

**Luego, en orden:**
1. **Render → Settings → Custom Domains**: que los tres subdominios sigan verificados y con
   certificado vigente. Un certificado vencido da el mismo síntoma que un DNS caído.
2. **nic.cl → Mis Dominios**: confirma que el dominio siga vigente (no debería vencer antes
   de mayo 2029) y revisa los registros DNS apuntando a Render.
3. Si es una caída de NIC Chile (el registro `.cl` completo), no hay nada que arreglar:
   se opera por la URL de Render hasta que se restablezca.

---

## 15. Alguien borró o corrompió datos (el sistema funciona bien)

Este es **más probable que cualquier caída** y no requiere contingencia de servidores: la
infraestructura está sana, el problema son los datos.

**ACCIÓN INMEDIATA: que nadie siga trabajando sobre los datos afectados.** Avisa al equipo
por el canal más rápido que tengas. Cada minuto de digitación encima complica la
recuperación. **No intentes "arreglarlo" a mano todavía.**

1. **Determina el alcance antes de tocar nada**: qué tabla, cuántas filas, desde qué hora.
   Ve a **Auditoría** (`/auditoria/`) — ahí está quién hizo qué y cuándo.
2. **No restaures encima de producción.** Levanta el respaldo en la instancia de
   contingencia (Parte A, secciones 2 a 5) y **compara** ahí lo que había antes.
3. Recupera **solo las filas afectadas** desde esa copia, no la base completa: restaurar
   todo haría perder el trabajo legítimo hecho después del respaldo.
4. Para elegir el respaldo correcto: los dumps son diarios (02:17), así que necesitas el
   del día **anterior** al error. El bucket guarda 90 días.
5. Revisa **Auditoría** (`/auditoria/`) para saber quién hizo qué y cuándo — ahí está el
   registro de las acciones críticas.

---

## 16. Sospecha de acceso indebido o clave filtrada

**ACCIÓN INMEDIATA: cambia `JWT_SECRET` en Render → Environment por cualquier texto largo
al azar y guarda.** En ~3 minutos **todas las sesiones activas quedan invalidadas** —
incluida la del intruso. Todo el equipo tendrá que volver a entrar con su clave; avísales
que es a propósito. Es lo más rápido que puedes hacer para cerrarle la puerta a alguien.

**⚠️ SIN PLAN PROBADO** — los pasos siguientes son los recomendados, nunca ejecutados en la
práctica:

1. (Ya hecho arriba: rotar `JWT_SECRET`.)
2. **Cambia la contraseña de la base** en TiDB Cloud y actualiza `DB_PASSWORD` en Render.
3. **Rota las claves de terceros** que estén comprometidas: `ANTHROPIC_API_KEY`,
   `WSP_TOKEN`, credenciales de correo, `CMF_API_KEY`, DealerNet.
4. Revisa **Auditoría** y los usuarios activos; desactiva las cuentas sospechosas desde
   Usuarios (hay bloqueo por intentos fallidos configurable).
5. Recuerda que `admin@admin.cl` es una **cuenta break-glass intencional**, no un intruso.

---

## 17. Se cayó un servicio externo (correo, WhatsApp, IA, indicadores)

Ninguno de estos tumba el sistema: **degradan solo** y el resto sigue operando.

| Servicio | Qué deja de funcionar | Comportamiento |
|---|---|---|
| **Brevo (SMTP)** | Correos del sistema, informes programados, alertas | Se registra el error; el resto opera |
| **Meta / WhatsApp** | Bot Facilito, campañas, avisos de cobranza | Sin credenciales válidas queda en **modo SIMULADO** (registra sin enviar) |
| **Anthropic (IA)** | Lectura de PDFs escaneados, informes IA, asistentes | Cada funcionalidad IA se puede **apagar desde su mantenedor**; el sistema avisa y sigue |
| **CMF** | Actualización de UF, UTM, dólar, TMC | Quedan los últimos valores cargados; se pueden **ingresar a mano** en el mantenedor |
| **DealerNet** | Informes comerciales nuevos | Los ya consultados quedan en caché |
| **Fintoc** | Saldos y cartolas automáticas | La cartola se puede **cargar manualmente por Excel** |

**Regla general**: si un servicio externo está caído, avisa al equipo qué función queda
temporalmente manual y sigue operando. No es una emergencia de contingencia.

---

## 18. Qué hacer SIEMPRE, sea cual sea la emergencia

1. **Avisa al equipo primero** — qué no funciona, qué sí, y qué no deben hacer mientras tanto.
2. **Anota la hora exacta** en que empezó el problema: define qué datos pueden haberse perdido.
3. **No improvises sobre producción.** Toda restauración va primero a una copia; se valida; después se decide.
4. **Registra lo que hiciste** — al terminar, actualiza este runbook con lo aprendido. Este
   documento nació de una restauración real y así es como sigue sirviendo.

---

*Guía para no técnicos también disponible dentro del sistema:*
**Mantenedores → Definiciones → "Respaldo de la Base de Datos"**.
*Detalle técnico:* **Mantenedores → Documentación → Técnica → Seguridad y operación**.
