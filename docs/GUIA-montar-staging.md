# Guía — montar el ambiente de staging

> Complemento operativo de `docs/plan-staging-prod.md`.
> **La Fase 4 (blindajes en código) YA ESTÁ HECHA** — v172.2, 03-08-2026.
> Lo que queda son los paneles de TiDB, Render y GitHub, que son tuyos.

---

## Estado actual

| Fase | Qué es | Estado |
|---|---|---|
| **4** | Blindajes en código (`ENTORNO=staging`) | ✅ **Hecho** |
| **1a** | Rama `staging` | ✅ **Creada** |
| **1b** | Proteger `main` en GitHub | ⏸ Pendiente — **hacerlo al final**, ver más abajo |
| **2** | Base de datos espejo en TiDB | ⏸ Tu panel |
| **3** | Servicio staging en Render | ⏸ Tu panel |
| **5** | Disciplina de trabajo diario | ⏸ Después de la 3 |

## Qué hacen los blindajes ya implementados

Con `ENTORNO=staging` en las variables del servicio, el sistema:

1. **Fuerza el Modo Desarrollo** — correo redirigido, WhatsApp simulado. No depende
   de la base de datos ni de que alguien lo prenda: si `ENTORNO=staging`, está activo.
   Aunque alguien lo apague desde el mantenedor, sigue activo.
2. **No programa los motores de envío** — cobranza automática, aviso de vencimiento,
   seguimiento de cartas, correos programados y motor de mora **ni siquiera se registran**.
   En el log de Render se ve: `⏸ [scheduler] "mora-motor" NO se programa (entorno staging)`.
3. **Pinta una banda morada** arriba de todas las páginas: *STAGING — AMBIENTE DE
   PRUEBAS · NADA DE LO QUE HAGAS ACÁ LLEGA A UN CLIENTE*.
4. **`/api/health` informa el entorno**: `{"entorno":"staging","motores":[...apagados]}`.

Verificado: sin `ENTORNO` definido, producción se comporta **exactamente igual que antes**.

---

## Fase 2 — Base de datos espejo (TiDB Cloud)

1. Entrar a TiDB Cloud → el cluster actual.
2. Crear la base: `CREATE DATABASE credit_system_staging;`
3. Copiar los datos. Dos caminos:
   - **Completo** (recomendado para QA realista): export de `credit_system` e import
     a `credit_system_staging` desde el panel.
   - **Liviano**: solo estructura + mantenedores + un subconjunto de créditos.
4. **Enmascarar los datos de contacto.** Este paso es el que hace que un error en
   staging no pueda alcanzar a una persona real. Con la base espejo ya cargada:

```sql
USE credit_system_staging;
UPDATE clientes SET email = CONCAT('prueba+', id_cliente, '@autofacilchile.cl'),
                    telefono = NULL, celular = NULL;
UPDATE dealers  SET email = CONCAT('dealer+', id_dealer, '@autofacilchile.cl'),
                    telefono = NULL;
UPDATE usuarios SET email = CONCAT('user+', id_usuario, '@autofacilchile.cl')
 WHERE email NOT LIKE '%@autofacilchile.cl';
```

> Ajusta los nombres de columna si alguno no existe; la idea es que **ningún dato de
> contacto real quede en la base de pruebas**.

5. Refrescar el espejo antes de cada QA grande (manual, no automático).

## Fase 3 — Servicio staging (Render)

1. **New → Web Service** → mismo repositorio → **rama `staging`** → plan **Free**.
2. Nombre: `credit-system-staging`. Health Check Path: `/api/health`.
3. Variables de entorno — copiar las de producción y **cambiar estas**:

| Variable | Valor en staging | Por qué |
|---|---|---|
| `ENTORNO` | `staging` | **La clave de todo.** Activa los 4 blindajes |
| `DB_NAME` | `credit_system_staging` | La base espejo |
| `JWT_SECRET` | **distinto** al de producción | Un token de staging no debe servir en producción ni al revés |
| `WSP_TOKEN` | vacío | Jamás el número real de WhatsApp |
| `WSP_PHONE_ID` | vacío | Ídem |
| `DEV_CORREOS_FALLBACK` | tu correo | Destino de respaldo si algo intenta enviar |
| `ALERTA_ERRORES_MAIL` | tu correo | Los errores 500 de staging también avisan |
| `CORS_ORIGIN` | la URL de staging | Si no, el navegador bloquea las llamadas |
| `APP_URL` | la URL de staging | Para que los enlaces de los correos apunten acá |

Las demás (`MAIL_*`, `CMF_API_KEY`, `DEALERNET_*`, etc.) se copian igual: el Modo
Desarrollo forzado ya impide que salgan mensajes reales.

4. Desplegar y **verificar en este orden**:
   - `GET /api/health` responde `"entorno":"staging"`.
   - En el log de Render aparece el recuadro `ENTORNO: STAGING` y los `⏸ [scheduler]`.
   - Al abrir cualquier página se ve la **banda morada**.
   - Enviar un correo de prueba desde el sistema → llega a tu casilla con `[DESARROLLO]`.

> Si alguna de las cuatro falla, **no sigas**: revisa que `ENTORNO=staging` esté escrito
> exactamente así en Render.

## Fase 1b — Proteger `main` (déjalo para el final)

**Recomendación: hacerlo recién cuando staging esté funcionando.** Si proteges `main`
antes, te quedas sin ruta de despliegue mientras montas las fases 2 y 3.

Una vez que staging ande:

```bash
gh api -X PUT repos/reportes-ai/credit-system/branches/main/protection \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[contexts][]=verificar" \
  -F "enforce_admins=false" \
  -F "required_pull_request_reviews=null" \
  -F "restrictions=null"
```

Eso exige que el CI (`.github/workflows/ci.yml`) pase antes de aceptar cambios en `main`.
Con `enforce_admins=false` conservas la salida de emergencia para un hotfix.

## Fase 5 — La disciplina diaria

1. Todo commit va a `staging` → se despliega solo al servicio de pruebas.
2. El QA (`docs/qa-plan-produccion.md`) **se ejecuta en staging**, no en producción.
3. A `main` solo se mergea lo certificado:
   ```bash
   git checkout main && git merge staging && git push
   ```
4. Hotfix urgente: se permite directo a `main`, pero **se retro-mergea a `staging` el
   mismo día**, o las ramas se separan y el próximo merge trae sorpresas.

---

## Prueba de que el blindaje funciona (hazla el día 1)

En staging, con el Modo Desarrollo supuestamente activo:

1. Ve al mantenedor de Mantención de Sistema e intenta **apagar** el Modo Desarrollo.
2. Envía un correo desde cualquier módulo.
3. **Debe llegar igual a la casilla de prueba, con `[DESARROLLO]` en el asunto.**

Si llega a un destinatario real, el blindaje no está puesto: revisa `ENTORNO` en Render.
