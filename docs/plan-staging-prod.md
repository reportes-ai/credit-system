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
- **Enmascarado**: correos y teléfonos de las 4 tablas que los tienen (`dealers`, `usuarios`,
  `vendedores_dealer`, `proveedores`) quedan en `staging+N@autofacilchile.cl` y `+56900000000`.
- **Ningún hash de producción**: los 40 usuarios comparten una clave de staging conocida
  (`--clave`, por defecto `Staging2026!`). Sirve para entrar con cualquier perfil sin
  arrastrar credenciales reales.

Para refrescar el espejo antes de una QA grande: `--ejecutar --recrear`.

**Por qué la lista es de lo que ENTRA y no de lo que se excluye:** la primera versión usaba
lista de exclusión y dejaba pasar respaldos, movimientos bancarios y conversaciones con
dealers. Con lista de inclusión, una tabla nueva con datos de personas no se copia sola. Si
falta algo en staging, se agrega a mano — ese costo es mucho más barato que filtrar datos de
clientes al ambiente de pruebas.

**Tres defectos que aparecieron al construirla** (quedan resueltos en el script, y valen como
advertencia para cualquier copia futura de esquema):
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
