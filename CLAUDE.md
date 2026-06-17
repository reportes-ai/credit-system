# Credit System — AutoFácil Crédito Automotriz

## Estilo de Respuestas (OBLIGATORIO)
- Respuestas CORTAS: solo lo necesario, sin tablas ni secciones decorativas
- No repetir lo que el usuario ya sabe ni explicar lo obvio
- Ahorrar tokens: ir directo al resultado y al siguiente paso si existe

## Stack
- Backend: Express.js + Node.js (servicios independientes en /services/)
- BD: TiDB Cloud (MySQL-compatible) — pool compartido en shared/config/database.js
- Frontend: HTML/CSS/JS vanilla en api-gateway/public/
- Deploy: GitHub main → Render (auto-deploy)
- Auth: JWT (shared/middleware/auth.js → verifyToken)

## Convenciones
- Tablas BD: snake_case
- Rutas HTTP: kebab-case
- Funciones JS: camelCase
- Archivos: kebab-case.js
- Versión en badge HTML: subir en cada cambio (<!-- v1.x -->) — OBLIGATORIO, nunca omitir
- **Versión global**: SIEMPRE actualizar `api-gateway/public/js/app-version.js` (`APP_VERSION`) en cada commit con cambios frontend. Este archivo controla el badge que aparece en TODAS las páginas (topnav, login, etc.) y es la forma de confirmar que el deploy en Render ya se aplicó. Subir menor si es fix/mejora (v6.1 → v6.2), subir mayor si es feature importante (v6.x → v7.0). Nunca dejar esta versión desactualizada.

## Reglas Importantes
1. SIEMPRE: `const pool = require('../../../shared/config/database');`
2. Validar entrada en TODAS las rutas
3. Respuesta uniforme: `{ success: true, data: {...}, error: null }`
4. Migraciones: bloque `(async () => { ... })()` al inicio del controller
5. Tabla creditos: PK es `id` (NO `id_credito` — ese es solo alias en SELECT)

## Estructura de Servicios
```
services/
  creditos/        → operaciones de crédito, carga masiva Excel
  clientes/        → datos personales + antecedentes_laborales + informacion_comercial
  comisiones/      → cálculo mensual de comisiones por ejecutivo
  dashboard/       → API datos dashboard (GET /api/dashboard/datos)
  usuarios/        → auth, perfiles, permisos
  mantenedores/    → UF, tasas, parques, dealers, etc.
  tesoreria/       → cuentas transitorias, cajas, brokerage
  reporteria/      → endpoints para reportería Tailor Made
  cotizaciones/    → simulador de créditos
  cobranza/        → gestión de cobranza
  cartas/          → generación de cartas
  crm/             → gestiones CRM
api-gateway/
  public/          → HTML/JS frontend de cada módulo
  index.js         → proxy y rutas estáticas
shared/
  config/database.js
  middleware/auth.js
```

## Tablas Clave
- `creditos` → operaciones de crédito (PK: id, clave negocio: num_op)
- `clientes` → datos personales (PK: id_cliente, UNIQUE: rut)
- `antecedentes_laborales` → situación laboral (FK: rut_cliente)
- `informacion_comercial` → perfil deudas (FK: rut_cliente)
- `comisiones_variables` → parámetros configurables de comisiones
- `uf` → valores históricos UF (fecha, valor)
- `dashboard_config` → config permisos tabs del dashboard
- `estados_credito` → máquina de estados paramétrica (PK: ambito+codigo; nombre, color, orden, es_inicial, es_final)
- `estados_transicion` → transiciones permitidas (ambito, origen, destino) — mantenedor Estado Créditos
- `usuarios`, `perfiles`, `permisos_perfil`, `funcionalidades`, `modulos`

## Estados del Crédito (mantenedor Estado Créditos, /mantenedores/estado-creditos/)
- Máquina de estados PARAMÉTRICA por `ambito` (hoy `brokerage` = AutoFin+Unidad; a futuro `autofacil` = recursos propios).
- API `/api/estado-creditos` (controller/routes en services/mantenedores). CRUD estados + `PUT /:codigo/transiciones`.
- Fase actual: **solo configura y dibuja el flujo; NO bloquea transiciones en créditos** (activar el enforcement cuando el mapa esté validado).
- El **Flujo Brokerage** (`/mantenedores/flujo-brokerage/`) lee estos estados/transiciones en vivo.
- Mapa brokerage sembrado: **iniciales** DIGITADO (digitación/carga masiva) y CARTA_APROBACION (vía cartas). DIGITADO→{APROBADO,RECHAZADO}; APROBADO→{CARTA_APROBACION,OTORGADO,DESISTIDO}; RECHAZADO→{APELADO,OTORGADO,RECHAZADO}; CARTA_APROBACION→{OTORGADO,DESISTIDO}; OTORGADO→{PREPAGADO,ANULADO}.

## Principio Rector: Aplicación Paramétrica (FILOSOFÍA CENTRAL)
> La meta del sistema es que el **usuario Administrador pueda hacer la mayor cantidad
> de modificaciones posible desde los mantenedores, sin tocar código y sin alterar el
> espíritu ni el flujo de los procesos.** Así se ha construido la mayoría hasta ahora
> (módulos, permisos, etapas Post Venta, UF, tasas, dealers, etc.).

Reglas de diseño que se derivan de este principio:
- **Antes de hardcodear un valor de negocio, preguntarse: "¿esto debería poder cambiarlo
  el Administrador sin programador?"** Si la respuesta es sí → va a un mantenedor (tabla
  de configuración + UI), no al código.
- **Datos de negocio = BD/mantenedor. Solo lógica = código.** Montos, tramos, nombres de
  estados, etapas, plazos, textos de plantillas, listas de opciones, mapeos → configurables.
- **El flujo se respeta, los parámetros se ajustan.** Parametrizar NO significa permitir
  romper el proceso: el orden de las etapas, las validaciones y las atribuciones siguen
  protegidas; lo que se abre es el *contenido* (valores, textos, umbrales), no la *estructura*.
- **Cada parámetro nuevo se expone en su mantenedor** con su permiso (`requireFunc`) y
  respetando la matriz de Perfiles. Nunca un valor de negocio enterrado en un `.js`.
- Cuando se detecte algo hardcodeado que el negocio podría querer cambiar, **proponerlo
  como mantenedor** en vez de dejarlo fijo (ver lista de candidatos más abajo si existe).

### Footer "Qué afecta este mantenedor" (OBLIGATORIO en cada mantenedor)
- **Cada página de mantenedor debe terminar con un recuadro "Qué afecta este mantenedor"**
  que liste, por variable/sección, **qué página y proceso impacta cada cambio, con link**
  para verlo. Así queda trazable qué toca cada modificación.
- **Revisar/actualizar este footer SIEMPRE que** se modifique un mantenedor, se agregue una
  card nueva, o se agregue una variable dentro de un mantenedor. Si una variable nueva no
  aparece en el footer, el cambio está incompleto.
- Patrón visual: recuadro gris con borde izquierdo azul, título con ícono `bi-diagram-3` y
  una lista `<ul>` de `<b>Variable</b> → proceso/página <a href="…">enlace</a>` (ver
  `tasas/index.html` y `cobranza-parametros/index.html` como referencia).

## Reglas Anti-Hardcode (NO negociables)
1. **Módulos y sub-items SIEMPRE desde BD** — nunca listas JS con rutas/íconos fijos
   - Módulos principales → tabla `modulos` (nombre, icono, ruta, orden)
   - Sub-items de sección → tabla `funcionalidades` (nombre, codigo, href, icono)
   - El frontend los lee via `GET /api/auth/mis-permisos` → `funcionalidadesInfo`
2. **Agregar módulo nuevo = solo BD**, sin tocar código:
   - INSERT en `modulos` + INSERT en `funcionalidades` con href e icono
   - Asignar permisos en `permisos_perfil`
3. **Nunca duplicar en HOME_FALLBACK ni ITEMS_ALL** — si algo no aparece, el problema está en BD o permisos, no en el código
4. **Descripciones largas** (texto presentación) pueden ir en un mapa JS local `DESCS{}` — no son datos de negocio
5. **Cobranza es excepción justificada** — sus cards tienen HTML único con stats por card

## Decisiones de Arquitectura Tomadas
- dashboard/getDatos: deduplicación por num_op via ROW_NUMBER() OVER PARTITION
- MAYOR/MENOR 200UF: se recalcula con UF de fecha_otorgado (no campo BD)
  - tabla uf se carga completa en memoria, lookup en JS: getUF(fecha)
- derInstitucion(financiera, producto): AUTOFIN es el default (todas las ops son del negocio)
- calcResumen (frontend): usa TODAS las aprobadas (no filtra por institución)
- JOIN cuentas_transitorias → creditos: usar `c.id` (NO `c.id_credito`)
- Permisos perfiles: migrations v8 y v9 en perfiles.controller.js

## Páginas Frontend Importantes
- /dashboard/ → Dashboard principal (v3.8)
- /comisiones/revision/ → Revisión comisiones ejecutivos (v5.3)
- /usuarios/ → Gestión usuarios y permisos
- /reporteria/ → Reportería Tailor Made
- /tesoreria/cuentas-transitorias/ → Cuentas transitorias

## Flujo de Datos Dashboard
1. Excel carga masiva → tabla creditos (via /api/creditos/carga-masiva)
2. GET /api/dashboard/datos → lee creditos + clientes, calcula institucion/mayor_menor
3. Frontend aplica filtros por fecha y recalcula resúmenes en calcResumen()
4. RAW_DATA en window.RAW_DATA, resúmenes en window.DASH.feb/jan

## Filosofía de Cambios (MUY IMPORTANTE)
- **Cambios quirúrgicos siempre** — editar solo las líneas necesarias, nunca reescribir archivos completos
- **Leer antes de tocar** — siempre leer el archivo completo antes de modificarlo
- **Un cambio a la vez** — hacer, verificar, luego continuar. No encadenar 5 cambios sin confirmar
- **Si algo funciona, no tocarlo** — aunque se pueda "mejorar", el riesgo no vale
- **Nunca cambiar algo que el usuario no pidió** — fue lo que rompió cartas-aprobacion (se tocó app.js sin que se pidiera)

## Errores Frecuentes (aprendidos en producción)
- `creditos` PK es `id`, NO `id_credito` (ese es solo alias en SELECT)
- `Promise.all` con `pool.query`: destructurar `[[rows], [rows]]` NO `[[rows, rows]]`
- Modal transparente → usar `<dialog>` nativo con `showModal()`, no divs custom
- `</script>` accidental en un .js rompe toda la página sin mensaje de error claro
- Stats de página vs stats totales: siempre query separada sin LIMIT para conteos reales

## Flujo de Deploy
- Push a main → Render detecta y deploya automáticamente (~2-3 min)
- Si no deploya → entrar a Render → Manual Deploy → "Deploy latest commit"
- Confirmar deploy: el hash del commit aparece en los logs de Render

## Convenciones de Permisos
- Administrador → ve todo sin restricciones
- `funcionalidades` con `href NULL` → permisos de acción (crear, editar, eliminar)
- `funcionalidades` con `href` definido → generan sub-items en menús de sección
- `usuario_ejecutivos` → tabla que controla qué ejecutivos ve cada usuario en comisiones
- **APIs sensibles: usar `requireFunc('codigo')`** de `shared/middleware/permisos.js` —
  valida contra la matriz de Perfiles y Permisos en BD (Admin bypass, override
  individual, caché 60s). NO usar `requirePerfil('NombrePerfil')` en código nuevo:
  hardcodea nombres de perfil y no obedece la matriz.
- **Landing pages con submódulos**: las cards deben ocultarse según
  `mis-permisos` (ver patrón en `comisiones/index.html`). Nunca cards fijas.
- **Auditoría**: `node scripts/audit-permisos.js` revisa integridad completa
  (duplicados, huérfanos, matriz por perfil). Correr tras cambios de permisos
  o creación de perfiles/usuarios masivos.
- `perfiles.nombre` tiene UNIQUE KEY (v18) — los seeds usan INSERT IGNORE seguro

## Paginación Créditos
- Server-side: 100 registros/página, máximo 500
- Stats totales en `j.stats {ESTADO: count}` — nunca filtrar array local del cliente
- Filtro financiera server-side: `?financiera=AUTOFIN|UNIDAD|AUTOFACIL`

## Gestión de Contexto de Sesión (MUY IMPORTANTE)

### Cuándo compactar (`/compact`)
- Ejecutar `/compact` cuando el uso de contexto llegue al **80-85%**
- No esperar al 90% — compactar tarde puede colapsar la sesión y perder el hilo
- Compactar proactivamente después de completar un bloque grande de trabajo

### Alerta de cambio de sesión
- Cuando el contexto supere el **90%** después de compactar → avisar al usuario:
  > ⚠️ **Contexto casi lleno.** Para continuar sin riesgo, inicia una nueva sesión. El resumen de esta sesión quedará disponible en el historial.
- Si se acerca al límite sin posibilidad de compactar → avisar de inmediato
- **Nunca colapsar en silencio** — siempre avisar antes de que sea tarde

### Rutina recomendada
1. Al inicio de cada sesión: revisar si hay sesión anterior relevante en historial
2. Durante la sesión: compactar al ~80% de contexto
3. Al cerrar: hacer push si hay cambios pendientes

## APIs Externas / Dependencias
- TiDB Cloud (BD en la nube)
- Render (servidor producción)
- GitHub (repositorio: reportes-ai/credit-system)

---

## Pendientes de Madurez del Sistema
> Estas tareas no son urgentes pero deben abordarse antes de considerar el sistema "producción estable".
> Ordenadas por prioridad. Marcar con ✅ cuando se implementen.

### 🔴 Crítico (seguridad y datos)

- [ ] **Verificar backups automáticos en TiDB Cloud**
  - Confirmar que los backups diarios están activos en el panel de TiDB Cloud
  - Hacer una prueba de restauración al menos una vez
  - Documentar el procedimiento de recuperación ante desastre

- [ ] **Auditar variables de entorno**
  - Verificar que `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET` estén en Render como env vars, NO en el código ni en `.env` commiteado
  - Revisar `.gitignore` para asegurar que ningún `.env` esté en el repositorio
  - Rotar el `JWT_SECRET` si alguna vez estuvo expuesto en GitHub

- [ ] **Rate limiting en el API Gateway**
  - Agregar `express-rate-limit` en `api-gateway/src/index.js` para evitar abuso
  - Límite sugerido: 200 req/min por IP en rutas públicas, 500 req/min en rutas autenticadas
  - Proteger especialmente `/api/auth/login` (máx 10 intentos/min por IP)

- [ ] **HTTPS forzado**
  - Verificar que Render redirige HTTP → HTTPS automáticamente (debería estarlo)
  - Agregar header `Strict-Transport-Security` en respuestas

### 🟡 Importante (estabilidad y operación)

- [ ] **Logs de errores en producción**
  - Integrar **Sentry** (gratuito hasta cierto volumen) o **LogTail** en el api-gateway
  - Objetivo: recibir mail/alerta cuando ocurre un error 500 en producción, antes de que el usuario avise
  - Instalación: `npm install @sentry/node`, 3 líneas en index.js

- [ ] **Health check endpoint**
  - Crear `GET /api/health` que retorne `{ status:'ok', db: true/false, uptime: X }`
  - Permite a Render detectar si el servicio cayó y reiniciarlo automáticamente
  - También útil para monitoreo manual

- [ ] **Manejo de reconexión de BD**
  - Agregar manejo de errores de pool en `shared/config/database.js` (reconexión automática si TiDB Cloud reinicia)
  - Actualmente un corte de BD deja el servidor colgado sin error claro

- [ ] **Timeout en queries largas**
  - Configurar `connectTimeout` y `queryTimeout` en el pool de BD
  - Evita que una query lenta bloquee el servidor indefinidamente

### 🟢 Mejora de calidad (profesionalismo)

- [ ] **Documentar reglas de negocio en el código**
  - Para cada cálculo no obvio (comisiones, tramos UF, instituciones), agregar comentario:
    `// Regla negocio: [descripción]. Ver [documento de referencia]`
  - Especialmente en: `comisiones/`, `dashboard/getDatos`, cálculo mayor/menor 200 UF

- [ ] **Checklist de pruebas manuales pre-deploy**
  - Crear archivo `docs/test-checklist.md` con ~15 casos críticos a verificar antes de deploy importante
  - Ejemplos: carga Excel de prueba, revisión de comisiones de un mes, generación de carta
  - No requiere código, solo disciplina de proceso

- [ ] **Paginación y límites en todos los endpoints**
  - Auditar endpoints que hacen `SELECT *` sin `LIMIT` — con volumen alto pueden timeoutear
  - Agregar `LIMIT` defensivo en endpoints de reportería y búsquedas

- [ ] **Logs de auditoría para acciones críticas**
  - Registrar en una tabla `audit_log` las acciones: quién hizo qué y cuándo
  - Acciones mínimas a auditar: cerrar mes, eliminar crédito, cambiar permisos de perfil, carga masiva
  - Esquema sugerido: `id, id_usuario, accion, detalle JSON, ip, created_at`

### 🔵 Futuro (cuando el volumen lo justifique)

- [ ] **Caché de consultas frecuentes**
  - Si el dashboard o reportería se vuelven lentos, agregar Redis o caché en memoria para datos que no cambian cada minuto (UF, tablas de mantenedores)

- [ ] **Separar servicio de archivos estáticos**
  - A futuro, servir HTML/CSS/JS desde un CDN (Cloudflare Pages, Vercel) en lugar del api-gateway
  - Mejora performance y reduce carga en Render

- [ ] **Tabla de contactos múltiples para cobranza**
  - Si cobranza necesita registrar titular + aval + familiar, agregar `cobranza_contactos`
  - NO tocar tabla `clientes` — mantener solo el contacto principal ahí

- [ ] **2FA para usuarios administradores**
  - Agregar autenticación de dos factores (TOTP/Google Authenticator) para perfiles críticos
  - Librerías: `speakeasy` + `qrcode` en Node.js
