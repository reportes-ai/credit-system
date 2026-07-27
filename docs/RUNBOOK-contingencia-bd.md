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
| El sitio no abre / error 502 / "service unavailable" | **Render (servidor)** | Sección 11 | ⚠️ Sin plan probado |
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

> Honestidad sobre el estado de estos planes: **solo la caída de la base (Parte A) está
> probada de punta a punta**. Lo de abajo es el análisis de qué hacer en cada caso, con las
> mitigaciones que sí existen hoy y los huecos declarados como tales. Donde dice
> "SIN PLAN PROBADO", es literal: hay que decidirlo y ensayarlo antes de necesitarlo.

## 11. Se cayó Render (el servidor de la aplicación)

**Síntoma**: el sitio no abre, error 502/503, o `/api/health` no responde nada.

**Primero, descartar que sea culpa nuestra:**
1. Revisa **status.render.com** — si es una caída global de Render, no hay nada que arreglar,
   solo esperar y comunicar.
2. Entra a **dashboard.render.com** → servicio → pestaña **Logs**. Si el proceso murió por
   un error de código o por memoria (out of memory), aparece ahí.
3. Prueba **Manual Deploy → Deploy latest commit**. Reinicia el servicio y suele resolver
   cuelgues de proceso.
4. Si fue por memoria (el plan es de 512 MB y el uso normal ronda los 200 MB), revisa
   **Metrics**; un salto sostenido sobre 70% significa que hay que subir de plan.

**⚠️ SIN PLAN PROBADO — si Render cae por muchas horas:** hoy **no existe** un host alternativo
configurado. La aplicación es Node/Express estándar y podría levantarse en otro proveedor
(Railway, Fly.io, una VM), pero eso **nunca se ha ensayado** y requiere recrear todas las
variables de entorno. Decisión pendiente: definir y probar un host secundario, o aceptar
que una caída larga de Render es tiempo fuera de servicio.

**Lo que SÍ está a favor**: los datos no corren riesgo — viven en TiDB, no en Render. Cuando
Render vuelve, el sistema vuelve tal cual estaba.

---

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

**Síntoma**: `afbs.autofacilchile.cl` no abre en ningún navegador ni red, pero la URL
directa de Render (`*.onrender.com`) sí funciona.

**Qué hacer:**
1. **Solución inmediata**: avisa al equipo que entren por la **URL directa de Render**
   (está en dashboard.render.com, arriba del servicio). El sistema funciona igual; solo
   cambia la dirección.
2. Revisa en Render → **Settings → Custom Domains** que el dominio siga verificado y el
   certificado vigente (un certificado vencido produce el mismo síntoma).
3. Entra al panel del registrador del dominio `autofacilchile.cl` y verifica los registros
   DNS y que el dominio **no esté vencido** (una renovación impaga es una causa clásica).

**⚠️ VERIFICAR Y ANOTAR AQUÍ**: quién es el registrador de `autofacilchile.cl`, con qué
cuenta se administra y **cuándo vence**. Ese dato no está documentado hoy y es justo el que
se necesita a las 3 de la mañana. *(Pendiente de completar.)*

---

## 15. Alguien borró o corrompió datos (el sistema funciona bien)

Este es **más probable que cualquier caída** y no requiere contingencia de servidores: la
infraestructura está sana, el problema son los datos.

1. **Detén el daño primero**: si fue un proceso o una carga masiva mal hecha, que nadie siga
   trabajando sobre esos datos hasta entender el alcance.
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

**⚠️ SIN PLAN PROBADO** — pasos mínimos recomendados, nunca ejecutados en la práctica:

1. **Rota `JWT_SECRET`** en Render. Efecto inmediato: **todas las sesiones se invalidan** y
   todo el mundo debe volver a entrar. Es molesto y es exactamente lo que quieres si alguien
   robó un token.
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
