# Inventario de secretos y configuración

> **Este documento NO contiene ni un solo valor, y nunca debe contenerlo.** Es el mapa:
> qué existe, dónde vive, qué se rompe si falta y **cómo se recupera**. Vive en el
> repositorio justamente porque no tiene secretos adentro.

**Última revisión: 05-08-2026** · 52 variables en uso.

---

## La idea central: casi nada se "respalda", casi todo se REEMITE

La reacción natural es querer una copia de cada valor. Es la peor opción: multiplica los
lugares donde una llave puede filtrarse, y una llave filtrada es peor que una llave
perdida. Una llave perdida cuesta veinte minutos; una filtrada puede costar la base.

Por eso la columna que importa es **Recuperación**:

- **Reemitible** — se genera una nueva en su panel, sin costo ni trámite. **No se
  respalda: se documenta dónde.** Es la mayoría.
- **Rotable con efecto** — se puede cambiar, pero algo se nota (todos los usuarios
  quedan deslogueados, un webhook deja de llegar hasta reconfigurarlo).
- **Irreemplazable** — tiene costo, trámite o plazo. **Estas sí necesitan copia guardada.**

---

## 1. Las que SÍ hay que guardar (irreemplazables o caras)

| Variable | Qué es | Por qué no basta con reemitir |
|---|---|---|
| `SII_CERT_B64` · `SII_CERT_PASS` | Certificado digital tributario | Se **compra** a un proveedor autorizado y tiene vigencia. Perderlo no es reemitir: es comprar otro y esperar. Sin él no se lee el SII |
| `SII_CLAVE` · `SII_RUT_USUARIO` | Clave tributaria de la empresa | Se recupera ante el SII, con trámite y demora |
| Códigos de respaldo de la MFA de Google | Acceso a toda la infraestructura | Ya están **en papel, en dos lugares físicos**. Sin la consola de Google no se puede promover el host de contingencia |

**Estas tres van al gestor de contraseñas** (ver §4). Son la lista corta y completa.

---

## 2. Reemitibles — no se guardan, se documenta el panel

| Variable(s) | Servicio | Dónde se reemite |
|---|---|---|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | TiDB Cloud | Panel TiDB → Cluster → Connect (la contraseña se resetea ahí mismo) |
| `GCS_CREDENCIALES` `GCS_BUCKET` `GCS_PROYECTO` | Google Cloud Storage | Consola → IAM → Cuentas de servicio → `afbs-docs@` → llave nueva |
| `GOOGLE_SA_JSON_B64` `GOOGLE_SA_PRIVATE_KEY` `GOOGLE_SA_CLIENT_EMAIL` | Cuenta de servicio Google | Igual que la anterior |
| `GOOGLE_OAUTH_CLIENT_ID` `GOOGLE_OAUTH_CLIENT_SECRET` | Login con Google | Consola → APIs y servicios → Credenciales |
| `GOOGLE_MAPS_API_KEY` | Mapa de dealers | Consola → APIs y servicios → Credenciales |
| `ANTHROPIC_API_KEY` | Subsistema de IA | console.anthropic.com → API Keys |
| `MAIL_HOST` `MAIL_PORT` `MAIL_USER` `MAIL_PASS` `MAIL_SECURE` | Correo (Brevo) | Panel Brevo → SMTP & API |
| `WSP_TOKEN` `WSP_PHONE_ID` `WSP_VERIFY` | WhatsApp (Meta Cloud) | Meta for Developers → la app → WhatsApp. `WSP_VERIFY` lo elegís vos, pero **hay que reconfigurar el webhook** si cambia |
| `CMF_API_KEY` | Indicadores (UF/UTM/dólar) | cmfchile.cl → API |
| `FINTOC_SECRET_KEY` | Conexiones bancarias | Panel Fintoc |
| `SIMPLEAPI_KEY` | RCV del SII | Panel SimpleAPI |
| `WORKERA_API_USER` `WORKERA_API_KEY` | Reloj control | Panel Workera |
| `DEALERNET_USER` `DEALERNET_PASS` `DEALERNET_ENDPOINT` `DEALERNET_TIPOCNS` | Informes DealerNet | Las da DealerNet — hay que pedirlas, no se autogestionan |

---

## 3. Rotables, pero con efecto visible

| Variable | Qué pasa al cambiarla |
|---|---|
| `JWT_SECRET` | **Todos los usuarios quedan deslogueados** al instante. Es lo esperado y es inofensivo, pero no lo hagas un lunes a las 9 |
| `WSP_VERIFY` | El webhook de Meta deja de validar hasta reconfigurarlo del otro lado |

---

## 4. Dónde se guardan las que hay que guardar

**Un gestor de contraseñas, fuera de Google y fuera de Render.** Que estén en un tercer
proveedor es el punto: si se pierde la cuenta de Google, ahí está lo necesario para volver.

Además, **en papel junto a los códigos de MFA**: la contraseña maestra del gestor y el RUT
y clave del SII. Papel en caja fuerte suena antiguo y es exactamente lo que resiste a que
te quedes sin acceso a todo lo digital a la vez.

**Lo que NO se hace, nunca:** un archivo `.env` en Drive, un mail con las llaves, una
planilla compartida, ni pegarlas en un chat. Cada copia es una superficie más.

---

## 5. Lo que NO es secreto (aunque esté en el mismo lugar)

`APP_URL` · `PORT` · `TZ` · `ENTORNO` · `MOTORES` · `CORS_ORIGIN` · `RENDER_MEM_MB` ·
`ALERTA_ERRORES_MAIL` · `MAIL_FROM` · `MAIL_FROM_COBRANZA` · `MAIL_REPLY_TO` ·
`DEV_CORREOS_FALLBACK` · `DB_NAME_STAGING` · `GCS_BUCKET` · `SII_RUT_EMPRESA`

Son configuración: se leen del `.env.example` y del runbook. Confundirlas con secretos hace
que el inventario real se pierda entre el ruido — que es la forma más común de que una
llave de verdad quede sin custodia.

**`MOTORES` merece atención propia**: no es secreto, pero puesto mal duplica los 27 motores
automáticos contra la misma base, en silencio. Ver `docs/CONTINGENCIA-cloud-run.md`.

---

## 6. Dónde vive cada una hoy

| Lugar | Qué tiene |
|---|---|
| **Render** (producción) | Las 52, en Environment |
| **GitHub → Secrets** | `DB_*` y `GCP_SA_KEY`, solo para el respaldo nocturno |
| **Cloud Run** (`afbs-standby`) | Las 16 del núcleo. **Faltan las de integraciones a propósito** — promovido opera el negocio, no manda WhatsApp ni consulta al SII |
| **Local** (`.env`) | Las de desarrollo. **Nunca se commitea** (está en `.gitignore`) |

---

## 7. Cómo se prueba que esto sirve

Un inventario que nadie ejercitó es una lista de buenas intenciones. La prueba real es
**reponer una llave a propósito**: elegir una reemitible de bajo impacto —`GOOGLE_MAPS_API_KEY`
es ideal, si falla solo se ve el mapa— generarla de nuevo, cargarla en Render y verificar
que el mapa vuelve. Media hora, y confirma que el procedimiento existe de verdad.

Igual que el respaldo de la base: **el que nunca se restauró no es un respaldo, es una
suposición.**
