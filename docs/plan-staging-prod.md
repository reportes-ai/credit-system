# Plan: Separación Staging / Producción

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
