# Credit System — AutoFácil Crédito Automotriz

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
- `usuarios`, `perfiles`, `permisos_perfil`, `funcionalidades`, `modulos`

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
