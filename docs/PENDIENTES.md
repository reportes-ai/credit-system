# Pendientes del Business Suite — vista consolidada

> **Actualizado: 07-09-2026.** Este archivo es la **única lista completa** de lo que está
> abierto. Antes vivía repartido: la sección "Pendientes de Madurez" de `CLAUDE.md`, los
> backlogs de memoria, y lo que cada módulo dejó anotado por su cuenta. Ahora todo
> converge acá, y las otras ubicaciones apuntan a este archivo.
>
> Versión navegable para el equipo: **Mantenedores → Documentación → Pendientes Abiertos**
> (`/mantenedores/documentacion/pendientes.html`).
>
> **Regla**: cuando algo se cierra, se marca ✅ con la fecha y el commit — no se borra.
> Cuando nace un pendiente nuevo, entra acá en el mismo momento en que se detecta.

---

## 1. Seguridad e infraestructura

| # | Pendiente | Estado / detalle |
|---|---|---|
| 1.1 | **Claves de integración en el host de contingencia** | El standby de Cloud Run (`afbs2.autofacilchile.cl`) tiene las 16 variables del núcleo, pero no `CMF_API_KEY`, `ANTHROPIC_API_KEY`, `WSP_*`, `DEALERNET_*`, `GOOGLE_*`, `FINTOC_*`, `SII_*`, `SIMPLEAPI_KEY` ni `WORKERA_*`. Promovido opera todo el negocio; **no** operan indicadores, IA, WhatsApp, DealerNet ni SII. Degradación deliberada. Ver `docs/CONTINGENCIA-cloud-run.md` §6. |
| 1.2 | **Repositorio de GitHub es público** | Propuesto hacerlo privado (Settings → Danger Zone → Make private); Render sigue funcionando igual. **Sin respuesta de Pato.** No hay secretos commiteados (auditado), pero la lógica de negocio completa es visible. |
| 1.3 | **Aseo de Descargas tras el rescate del certificado SII** | Copiar `certificado-sii-3des.pfx` a pendrive/caja fuerte, la clave al gestor de contraseñas, y **borrar** `certificado-sii-nuevo.pfx`, `cert-base64.txt`, `cert-base64 (1).txt`, `cert-base64-3des.txt`. Regla permanente: el .pfx y su clave viven separados. |
| 1.4 | **MFA obligatorio para todo el equipo** | La cuenta que administra la infraestructura ya tiene verificación en dos pasos (04-08-2026, con códigos de respaldo en papel). Falta exigirlo desde la consola de Workspace a ~40 personas: necesita aviso, plazo y acompañamiento. |
| 1.5 | **Prueba de restauración real del respaldo** | El dump nocturno (GitHub Action `backup-bd.yml`, 30 días de retención) nunca se ha restaurado de verdad. Hacerlo contra un branch de TiDB. |
| 1.6 | **2FA para perfiles administradores del sistema** | `speakeasy` + `qrcode`. Distinto de 1.4 (eso es Google Workspace; esto es el login del Suite). |
| 1.8 | **Alertar cuando hay dos hosts de producción a la vez** (detectado 04-09-2026) | El servicio viejo de Render (`credit-system`, Oregon, `credit-system-45em`) quedó suspendido el 30-07 y **volvió a vivir el 12-08-2026** con auto-deploy desde main, `ENTORNO=produccion` y **los 28 motores encendidos** contra la misma base; nadie lo notó hasta que Pato abrió un PDF por esa URL (sin `GCS_BUCKET` → 500). Se suspendió el 04-09. **Revisado en BD**: 15 correos automáticos duplicados (Fundantes Pendientes, Informe Diario, Cierre de Mes, Salud, Guardián) y **ningún dato duplicado** (asientos, provisiones, desistimientos, cobranza: los motores escriben con marca "ya corrió"). Servicio **borrado el 04-09-2026** (queda solo `credit-system-1`, Virginia). ✅ **Alerta de doble host** (v222.26): `shared/latido-host.js` — cada proceso late por minuto en `host_latidos`; si otro host con motores encendidos latió en los últimos 3 min, correo a `ALERTA_ERRORES_MAIL` (máx. 1 cada 6 h) y `/api/health → doble_host`. El standby con `MOTORES=off` late pero no cuenta. Ojo: un servidor local con motores contra la base de producción también dispara la alerta — y con razón. |
| 1.9 | ✅ **Cambio de hora en Chile corría 1 h todas las fechas** (06-09-2026) | El offset de mysql2 se fija al crear el pool; a medianoche Chile pasó a UTC-3 y las conexiones nuevas se abrían con -03:00 sobre un pool de -04:00: escrituras una hora atrás, lecturas una hora adelante, 15 correos del vigía de relojes. **Cerrado v222.34**: las conexiones usan SIEMPRE el offset del pool y el motor infra `vigia-cambio-hora` reinicia el proceso cuando el offset real cambia (Render/Cloud Run lo relanzan solos; en la laptop lo levanta uno). Runbook §17-bis. |
| 1.10 | **Buscadores — segunda tanda al motor único** (10-09-2026) | Pato pidió que TODOS busquen por ID financiera, N° OP, ODP, RUT (con o sin puntos), nombre, dealer, ejecutivo. ✅ Primera tanda con `api-gateway/public/js/busqueda-core.js`: Créditos/Caja, Aprobaciones (6), Post Venta (9), Cuentas transitorias, Fundantes, Historial ODP. **Faltan** (inventario del 10-09): Cobranza prejudicial/judicial (+ IDF, dealer, ejecutivo; en judicial.html el input no dispara búsqueda), Mantenedor cobranza judicial (+ IDF), Reporte cartera cobranza (+ N° OP), Anulaciones (+ cliente, dealer, ejecutivo), Aplicación de fondos (+ IDF), Saldo precio en proceso (+ cliente/RUT cliente), Fundantes historial/devueltos/bitácora de atrasados, Bitácora de un crédito (+ cliente, carta, ODP, números parciales), Corrección de cartas (+ dealer, ejecutivo), Preaprobaciones (+ cliente), Clientes (+ apellido materno), Certificados (+ IDF), Portal del dealer (+ IDF). |
| 1.7 | **Logs de auditoría de acciones críticas** | Existe `shared/audit.js` + módulo Auditoría. Falta confirmar cobertura explícita de: cerrar mes, eliminar crédito, cambiar permisos de perfil, carga masiva. |

## 2. Contabilidad (el reemplazo de AVSOFT)

| # | Pendiente | Estado / detalle |
|---|---|---|
| 2.1 | **Disparador contable de comisiones internas y colocación** | Tres reglas **creadas y editables, pero que nadie dispara**: `COMISION_EJECUTIVOS` (4001100 / 2106060), `COMISION_PARQUES` (4002100 / 2106012), `CREDITO_OTORGADO_AF` (1104010 / 1101090). **Dudas a resolver con Pato**: (a) el endpoint `aprobar` de comisiones solo guarda `incentivo_final`, no el total del mes — ¿recalcular con el motor al aprobar, o contabilizar al emitir la ODP? (b) ¿`CREDITO_OTORGADO_AF` se activa al marcar OTORGADO, y sale contra banco directo o cuenta transitoria? |
| 2.1b | ✅ **Disparador de `ODP_PAGADA` (y ANTICIPO/PRESTAMO/FINIQUITO_PAGADO)** (cerrado 27-08-2026, v218.18) | Detectado al agregar la "Cuenta de cargo" al pago de ODP: las reglas de egreso existían activas pero nadie las disparaba. **Cableado en `pagarOrden` (origen GENERAL)**: el evento sale del concepto (proveedor / anticipo / préstamo / finiquito), idempotente por ref `ODP-<numero>`. Devengo confirmado: facturas → `cuenta_cxp` del auxiliar de compras (cuentas POR AÑO, herencia AVSOFT — el asiento reemplaza la 2102010 genérica por la CxP real de la factura, matcheada por RUT+folio o RUT+monto); finiquitos → 2106070 (FINIQUITO_EMITIDO); anticipo/préstamo no devengan (el desembolso crea la CxC 1105010/1105020). El banco del HABER es la cuenta de cargo elegida al pagar. Ojo futuro: cuando el RCV proponga cuentas nuevas, la máxima "cuentas sin año" aplica — hoy se respeta la CxP donde el devengo quedó de verdad. |
| 2.2 | **Traer al auxiliar el RCV ya sincronizado** | Desde v210.4 existe "Traer del SII al auxiliar". Falta **correrlo**: 88 documentos de agosto pendientes, más los meses anteriores que se vayan sincronizando. Partir marcando pocos para revisar los asientos. |
| 2.2b | ✅ **El auxiliar de compras no tiene los folios reales** (cerrado 21-08-2026) | Los documentos importados de AVSOFT quedaron con el folio igual al tipo de documento ("33-33") por el bug del parser (corregido). **Re-importado el 21-08-2026**: el export original "Documentos de Compras (1 Línea)" seguía en Descargas (`2026-07-14-135018.csv`) — 1.453 documentos, **14 meses 2025-01 → 2026-07 reemplazados completos**, con folios reales. Con esto el anti-duplicados del importador del RCV vuelve a ver y septiembre queda despejado para traer los 12 meses del RCV (2.2c). |
| 2.2c | **La lectura del SII está pausada hasta el 1° de septiembre** | La apikey gratuita de SimpleAPI da **30 consultas al mes** y en agosto se hicieron **812**: no fueron sincronizaciones sino el motor reintentando durante los 12 días en que el certificado no abría, una vez a los 45 s de cada arranque. No está vencida (se generó en junio y dura un año), así que **el 1° de septiembre el contador se reinicia y vuelve sola** — no hay que pagar ni regenerar. Ya se corrigió la causa: ahora la espera crece con cada falla consecutiva (30 min a 12 h) y el primer resultado bueno borra el castigo. **En septiembre**: traer los 12 meses del RCV (12 consultas) — los folios del 2.2b ya quedaron reparados el 21-08. |
| 2.2d | **Balance al 31-07-2026 vs AVSOFT** (diagnosticado 04-09-2026) | **Corregido lo nuestro**: el importador incremental grababa los comprobantes AVSOFT como `VIGENTE` y el balance solo suma `CONTABILIZADO` → 601 comprobantes de 2026 (256 de julio, 339 de agosto) estaban invisibles; se activaron y el script ya graba `CONTABILIZADO` desde 2025 (la historia 2020-2024 sigue `VIGENTE` a propósito: la apertura 2025 ya trae esos saldos). **Quedan 2 diferencias legítimas**: (a) **asientos propios del motor que AVSOFT no tiene** — provisión de incobrables jun-26 (1.204 M, cuentas 4001190/1104050), provisión de vacaciones jul-26 (39,3 M), finiquito (895 k), saldos precio por cuentas transitorias 2102045 (fondos recibidos 51,9 M / pagados 38,3 M), comisión Fenix (364 k): mientras la contabilidad corra en paralelo, o AVSOFT las registra igual o se decide cuál manda; (b) **comprobantes que el contador modificó en AVSOFT después del import** (T-25 y T-37 jul, T-1000 y T-1002 ago-2026 + otros de julio: 2102026/2102040 ±33,8 M, 2103050/4001020 ±5,4 M, 1101030/2103013 ±800 k, 2102022/2102024 ±1,5 M): **pedir un CSV fresco de jul-ago 2026, borrar esos comprobantes y reimportar**. Falta además que el contador corrija T-1000 dic-2023 (descuadrado en origen). |
| 2.3 | **Notas de crédito (61) del RCV** | Quedan fuera del importador: en el auxiliar van con signo negativo y el motor de ingreso exige total > 0. Hoy se digitan aparte; automatizarlo es trabajo pendiente. |
| 2.4 | **Nunca se ha cerrado un mes** | `ctb_meses_cerrados` está vacío, así que el candado `MES_CERRADO` del motor **jamás ha actuado**: nada impide hoy digitar sobre un período ya informado. Decidir desde qué mes se empieza a cerrar. |
| 2.5 | **Conciliación y pagos al día** | Al corte de julio: **112 movimientos bancarios sin conciliar** y **4 ODP en estado EMITIDA impagas**. |
| 2.6 | **Facturación electrónica (emitir DTE)** | Proyecto mayor acordado y **no contratado** (OpenFactura). Hoy el ingreso se contabiliza contra la solicitud por correo; con DTE real el asiento saldría con el folio del SII. SimpleAPI solo **lee** el RCV, no emite. |
| 2.7 | ✅ **Mes contable vs fecha de curse** (definido por Pato 21-08-2026) | La convención: **la comisión se atribuye por FECHA DE CURSE**, pero INDEXA no dejaba digitar con fechas distintas y los meses históricos se ajustaron vía `mes` (mes contable) — esos ajustes siguen mandando hacia atrás. Regla implementada (motor único `shared/mes-atribucion.js`): meses **hasta jul-2026** → mes contable ajustado; **desde ago-2026** → fecha de otorgamiento. Corte paramétrico en `parametros_credito.mes_corte_curse`. Aplicado en Comisión Ejecutivos y Bono Jefe (pilares 1 y 2); dashboard y cartolas ya usaban mes contable y no cambian. Caso que lo destapó: op 88786 de Brandon Barbas (cursada 30-06, mes contable jul) — con fecha de curse quedaba bajo el piso de $35M y perdía la comisión completa de julio. | **Ajuste 07-09-2026 (v222.45)**: el dashboard y las cartolas siguen contando por `mes`, y 7 ops cursadas el 03/04-09 quedaron con mes agosto (fecha prellenada por Trinidad + carta otorgada sin mover el mes): agosto pasó de 104 a 111 después del cierre. Ahora `mes` sigue a `fecha_otorgado` desde el corte por `SET_MES_SQL` (motor único) en cartas/otorgar, carga Trinidad (sincronizado, existente, Informe Canal) y resolución de diferencias; las 7 se movieron a septiembre (ninguna estaba en cartola). |
| 2.10 | **Declaraciones Juradas anuales** (iniciado 10-09-2026) | ✅ **DJ 1879** (honorarios) en /contabilidad/declaraciones-juradas/ desde el auxiliar de honorarios, con factores paramétricos (2025 cargados). **Falta**: (a) validar al peso contra la 1879 presentada en marzo 2026 (pedir a Pato el PDF o el archivo de AVSOFT); (b) probar el CSV en el importador del SII — el **orden de columnas ya está confirmado** contra el Formato de Registro oficial AT2026 v1.8 (alerce.sii.cl, 1887 largo 341 / 1879 largo 204) y el **método de actualización** (redondear cada mes × factor y sumar) se validó 38/38 al peso contra el `.887` que presentó AVSOFT en AT2025. El `.887` de ancho fijo es el canal Upload y exige código de casa de software asignado por el SII (el folio de AVSOFT empieza con su código 11): por eso la Suite genera el CSV del importador; (c) ✅ **DJ 1887** (sueldos) hecha (v231.0): importador LIBREMUN extendido + motor único `shared/base-tributable.js` (validado 216/216 al peso vs impuesto AVSOFT ene–ago 2026). Falta: **re-importar el LIBREMUN 2026** en Libros Auxiliares → Remuneraciones (llena las columnas nuevas y completa jul–sep), completar la jornada de 8 trabajadores sin horas en la ficha RRHH, confirmar meses de finiquito inferidos de ex trabajadores sin ficha, y validar contra la 1887 presentada en marzo 2026 (para AT2026 hay que re-importar el LIBREMUN 2025); (d) **Certificados N°1 y N°6** (plazo 14 de marzo) sobre el mismo motor; (e) cargar los factores 2026 cuando el SII los publique (enero 2027); (f) completar honorarios de julio 2026 (el auxiliar tiene 1 boleta). |
| 2.9 | ✅ **Precios DealerNet completos** (07-09-2026) | Se cargaron desde la "TABLA Propuesta de Servicios DealerNET" los 6 productos que estaban en 0 (110, 107, 16, 3901, 3440, 3408) y, desde el detalle de la factura real, el **Boletín Deudores de Pensión de Alimentos (2101) a 0,0025 UF** (solo se conoce el precio del tramo 40; quedó igual en los 4 tramos) y el Buscador Múltiple a 0,0007 en el tramo 40. **Dato clave de esa factura: consumo real de un mes = 78,3 UF con 10.895 consultas**, casi el doble del plan de 40 UF; revisar en Facturación si conviene subir a 80 UF. |
| 2.8 | **Costos de servicios por escenario** | La vista única ya existe (Mantenedores → Salud y Uptime → "Gastos mensuales por servicio", tabla `servicios_costos`). Falta el pedido original: costo en **contingencia**, si **crece el volumen**, y qué pasa si se **deja de pagar**. Medidos: Render US$8,30 (decidido subir a Standard US$25), TiDB US$9,60 variable, Cloud SQL US$2,40 detenida / US$4,80 día encendida, GCS US$0,05, IA ~US$3,95. Por confirmar en cada panel (**no inventar**): Brevo, Meta WhatsApp, DealerNet, SimpleAPI, Workera, NIC Chile. Evaluar que viva en Órdenes de Pago como gasto recurrente real. |

## 3. Datos y migraciones

| # | Pendiente | Estado / detalle |
|---|---|---|
| 3.1 | **Cartera INDEXA — Etapa 3** | Migradas 4.425 + 1.319 operaciones; falta la etapa final. |
| 3.2 | **26 huérfanos del bucket** | Objetos en `gs://autofacil-docs` sin fila que los apunte, del barrido de migración de documentos. |
| 3.3 | **Historial de mora INDEXA para el Score de Mora** | El módulo está construido pero le falta el histórico para calibrar por segmento. |
| 3.4 | **Ops a nombre de un ejecutivo suspendido** | Se siguen digitando operaciones con el nombre de Carlo Moreno (usuario 120005, inactivo desde ~mayo), en variantes "CARLOS MORENO" y "CARLO ANDRÉS". Revisar con Operaciones a quién corresponden de verdad — afecta atribución y comisión. |
| 3.5 | **Actividades económicas del SII** | 674 códigos cargados; falta cablearlos a los giros de clientes y proveedores. |
| 3.6 | **`cartas_aprobacion.id_credito_creado` huérfano** (07-09-2026) | 382 de 600 cartas apuntaban a ids de `creditos` anteriores a la re-migración de la tabla; el envío de cartola no encontraba Post Venta y la op no recibía CARTOLA ENVIADA (las 7 ops de agosto se marcaron a mano). **Barrido hecho el 07-09-2026**: 378 re-apuntadas por ID Financiera + RUT (`scripts/reapuntar-cartas-huerfanas-2026-09-07.js` y `-pares-`, respaldo `respaldo-cartas-huerfanas-2026-09-07.json`). El envío de cartola ya valida el id (v222.44). **Quedan 4 sin resolver**: 3 cartas de prueba UAT (26465475AS, 26454545AS, 262612345AS) y la carta 265870924KF, cuyo RUT (18237103-3) no calza con el del crédito 87862 (19237103-1): revisar cuál está mal digitado. |

## 4. Módulos con fase pendiente

| # | Módulo | Qué falta |
|---|---|---|
| 4.1 | **Plan de Liquidez** | Falta el motor de cálculo del anticipo de comisiones (Super Partner). |
| 4.2 | **Portal del Cliente** | Falta la sección de datos bancarios. |
| 4.3 | **Atención Remota** | Falta el video (chat y documentos ya operan). |
| 4.4 | **Excepciones Comerciales** | Fase 2 sin construir. |
| 4.5 | **Seguimiento de Cartas por WhatsApp** | Construido; falta **aprobar la plantilla en Meta** y activar el toggle. |
| 4.6 | **Mi Día — calendario** | Falta que Pato cree el Client ID/Secret de Google y se carguen en Render. |
| 4.7 | **Conector Workera** | Fase 1 lista; faltan las env vars en Render y la Fase 2 (atrasos). |
| 4.8 | **Conexiones Bancarias (Fintoc)** | En sandbox, **no contratado**. |
| 4.9 | **Fusión de cards de Mantenedores** | 7 fusiones aprobadas en concepto, ninguna ejecutada (implican redirects + permisos + footer "Qué afecta"). Partir por **Avisos + Alertas + Alertas de Saldos → "Avisos y Alertas"**, la de mayor valor. |
| 4.10 | **Dealer multi-local (2 parques + calle)** | ✅ Fase 1 (v218.0): `dealer_locales` + `dealer_comisiones` por ubicación, motor `comision-dealer.js` cableado (fila del local de la op manda, fallback legacy → pizarra), gestión de locales en la ficha del mantenedor Dealers. ✅ Fase 2 (v218.4): la carta ofrece al dealer en CADA parque donde tenga local y en CALLE; `tipoVsFichaDealer` valida contra locales vigentes; la comisión sugerida usa la tabla del local (`?ubicacion=`); la herencia carta→crédito escribe el NOMBRE del parque de la carta en `creditos.parque` (el placeholder 'PARQUE'/'CALLE'/'NO APLICA' se considera vacío). ✅ Fase 3 (v218.6): la cartola del dealer (una por RUT) se corta en secciones por ubicación con subtotal cuando cursó en más de un local — la `ubicacion` se deriva al leer (crédito → carta), sin columna nueva. Decisión Pato 26-08-2026: una cartola por dealer; comisiones fijadas por separado por cada parque y para calle. **CERRADO** — mejora futura opcional: sugerir la tabla pactada del local en el Generador de Cartas (hoy sugiere pizarra a propósito, flujo de excepciones). |
| 4.11 | **WhatsApp: usernames y BSUID** | ✅ Nombre reservado 21-08-2026: **@facilito.autofacil** (WhatsApp Manager, WABA 1044493808034066). ✅ Bot adaptado (v215.4): webhook captura `user_id`/`from_user_id`/`username`, la conversación se reconoce por teléfono O BSUID (columnas `bsuid`/`username` en wsp_conversaciones), y `enviarWhatsApp` responde al BSUID cuando no hay teléfono (recipient_type/recipient, doc Business-scoped user IDs). **Queda:** probar end-to-end cuando la función se active en Chile (hoy no llegan webhooks con BSUID reales) y decidir si campañas/cobranza usan BSUID además del teléfono. |

## 5. Backlog aprobado, sin construir

| # | Idea | Origen |
|---|---|---|
| 5.1 | **Agente de voz para cobranza** | Roadmap disruptivo #1, **en pausa**: Fase 1 definida = nota de voz por WhatsApp; faltan las credenciales del servicio de Pato. Ojo compliance Ley 21.484 y usar Modo Desarrollo para no contactar deudores reales. |
| 5.2 | **Simulador what-if** | "Cómo afecta un alza de tasa a los créditos < y > 200 UF" no es texto-a-SQL sino simulación: módulo aparte sobre el motor de rentabilidad. Sin priorizar. |
| 5.3 | **Onboarding 100% digital del cliente** | Firma con FES + verificación de identidad con foto de cédula e IA. |
| 5.4 | **Motor de pricing dinámico** | Tasa sugerida por perfil de riesgo (scorecard) + rentabilidad objetivo. |
| 5.5 | **Predicción de mora con IA** | Probabilidad de caer en mora el mes siguiente → cobranza preventiva. |
| 5.6 | **Simulador público embebible** | Cotizador para el sitio web/Instagram que capture leads directo al CRM de Campañas. |
| 5.7 | **Detección de duplicados al digitar** | Avisar en vivo "este RUT + monto parecido ya existe como op NNNNN" antes de guardar. |

## 6. Calidad y proceso

| # | Pendiente | Detalle |
|---|---|---|
| 6.1 | **Paso a producción formal** | Hoy **push a main = producción**. Staging ya existe (`credit-system-staging`). Falta la separación real de ambientes con su procedimiento. Pato lo postergó ("nadie está conectado"), sigue abierto como pendiente mayor. |
| 6.2 | **Checklist de pruebas manuales pre-deploy** | `docs/test-checklist.md` con ~15 casos críticos. No requiere código, solo disciplina. |
| 6.3 | **Documentar reglas de negocio en el código** | Comentario `// Regla negocio: […]` en cada cálculo no obvio. Prioridad: comisiones, `dashboard/getDatos`, tramos de 200 UF. |
| 6.4 | **Caché de consultas frecuentes** | Solo cuando el volumen lo justifique (UF, mantenedores). TiDB cobra por consulta, así que tiene retorno directo. |
| 6.5 | **Servir estáticos desde CDN** | Sacar HTML/CSS/JS del api-gateway a futuro. |
| 6.6 | **Tabla de contactos múltiples para cobranza** | `cobranza_contactos` (titular + aval + familiar). **No** tocar `clientes`. |
| 6.7 | **Consolidar las 3 copias del documento "Solicitud de Pago"** (anotado 20-08-2026, para el 21-08) | El motor único es `api-gateway/public/js/odp-documento.js` (lo usan Órdenes de Pago → Historial y Saldos Precios a Pagar), pero las pantallas de **emisión** tienen cada una su **propia copia** del HTML: `postventa/orden-pago/index.html` y `postventa/orden-pago-comision/index.html`. Consecuencia inmediata: el **pie de trazabilidad** (v213.76) no aparece en esas dos, y cualquier cambio de formato hay que hacerlo tres veces. Ojo al consolidar: esas copias se **envían por correo**, así que los estilos deben seguir siendo inline, y la de comisión trae el aviso de descuadre factura↔cartola. Máxima 1. |

## 7. Herramientas y agenda

| # | Pendiente | Detalle |
|---|---|---|
| 7.1 | **Modo enseñanza de Claude** | No disponible en la sesión actual; probar en una sesión nueva de la app de escritorio. |
| 7.2 | **`/code-review ultra`** | Quedan 2 revisiones gratis del ciclo. Lo lanza Pato antes de cambios grandes. |
| 7.3 | **Demo a la auditora Noelia** | Lunes **17-08-2026, 17:00**, en staging. Guion en Word (`Documentos/guion-demo-auditoria.docx`) y como Artifact; ambiente alineado y proveedor de prueba creado. |
| 7.4 | **Estreno del Revisor Automático Autofin** | Solicitud 6261184 (ID verificado libre); los switches del motor deben quedar encendidos en Mantenedores → Excepciones Comerciales. |

## 8. Auditoría de consistencia de términos — hallazgos que MUEVEN NÚMEROS (24-08-2026)

> Los renombres cosméticos ya se aplicaron (v217.8 dashboard + v217.9 toda la app,
> commits `886b4cbf` y `b99a3dde`). Lo de abajo quedó **sin tocar** porque cambia
> montos mostrados o conducta de procesos: revisar con Pato uno a uno.

| # | Pendiente | Estado / detalle |
|---|---|---|
| 8.1 | ✅ **Com. Dealer no obedece "la carta manda"** | **CERRADO 25-08-2026** (regla de Pato: *manda la carta a no ser que se fuerce un valor a nivel BD* → precedencia `forzado > carta vigente > cálculo` en TODOS los motores). El recálculo mensual ya la tenía desde el fix de los 13 descuadres (01-08); se completó: (a) `calcular-operacion.js` ahora prefiere `part_bruto` de la carta APROBADA al crear/editar por API de operaciones; (b) `marcarForzadosCalculo` compara contra el valor de la carta cuando existe, así un monto que viene de la carta ya NO se marca como "forzado a mano" (antes ese falso forzado congelaba el valor viejo si la carta cambiaba después). El tooltip del dashboard y el glosario ("manda la carta") ahora son verdaderos. |
| 8.2 | **`arriendo_parque` guarda dos magnitudes** | Al digitar, `calcular-operacion.js` guarda el arriendo mensual COMPLETO; `recalcular-mes.js` lo deja PRORRATEADO (arriendo ÷ otorgadas del mes). Misma columna, mismo rótulo. Entre digitación y recálculo la op carga el arriendo íntegro y su ingreso neto sale subestimado. Fix probable: prorratear (o dejar 0) al digitar y que el recálculo mande. |
| 8.3 | **Penetración con tres denominadores** | (a) Motor `penetracion.js` = universo elegible por seguro (lo que paga AutoFin). (b) Tarjeta del dashboard = un solo denominador, sin exclusiones EMPRESA/INDEPENDIENTE. (c) Correo "Alerta Penetración" = incluye APROBADO, CORFO y ops sin ningún seguro informado → hunde el % y puede gatillar la alerta "bajo 40%" en falso. El glosario del dashboard promete universo elegible (hoy falso para la tarjeta). Fix: cablear tarjeta y correo al motor. |
| 8.4 | **`saldo_insoluto` transporta el monto de prepago** | `calcularPrepago` (certificados.controller.js) devuelve `saldo_insoluto: total` = capital + mora + intereses + gastos + comisión de prepago; los certificados de deuda vigente devuelven capital puro bajo la misma clave. El placeholder `{saldo}` de las plantillas editables puede imprimir el prepago rotulado como saldo insoluto. Fix: clave propia (`monto_prepago`) manteniendo compatibilidad de plantillas. |
| 8.5 | **Pestañas "Rentabilidades" con motores propios** | `creditos/app.js` (credCalcFull) y `cotizaciones/index.html` calculan inline, divergen entre sí y del motor AF_RENT: CORFO y bono como COSTO (en AF_RENT CORFO es INGRESO), com. ejecutivo sobre `saldoPrecio` en Cotizaciones vs `montoFin` en el resto, seguros con fórmula distinta. Máxima 1 (un solo motor): consolidar ambos en AF_RENT/CORE. |
| 8.6 | **Menores** | (a) Filtro "Estado" de Reportería mezcla etapa y estado de cartera en un solo control. (b) Desplegable de `creditos/revisar.html` ofrece OTORGADO y CURSADO como dos etapas elegibles para el mismo hecho (ver cuántas ops tienen CURSADO antes de retirar la opción). (c) Alias `rentab_afa` en la API del dashboard = ingreso bruto por colocación, nombre engañoso para consumidores nuevos. (d) "Comisión Neta" significa neto de IVA (cartolas), efecto neto en rentabilidad (excepciones) y markup de seguro (factores-seguro) — cada uso está explicado en su contexto, pero son tres significados. |

## 9. Brechas contra el RFP de software core (07-09-2026)

> Origen: revisión punto a punto del "RFP Inicial - Software Crédito Automotriz Autofacil -
> Portcoll" contra el sistema en producción (v222.43). Documento completo: `Cobertura RFP -
> AutoFacil Business Suite.docx` en la carpeta del RFP (OneDrive). De 122 requisitos: 59 cubre,
> 34 parcial, 29 no cubre. Acá van solo las brechas (parciales y no cubiertas), agrupadas por
> módulo y **sin priorizar**: el RFP está escrito para una entidad supervisada por la CMF, así
> que varias no aplican mientras AutoFácil no lo sea (marcadas *no aplica hoy*).

| # | Brecha | Estado / detalle |
|---|---|---|
| 9.1 | **Originación — productos y solicitud** | (a) Solo crédito en cuotas: sin compra inteligente (cuota balón), leasing, líneas de crédito, flotillas ni subsidios de planta/distribuidor. (b) Sin constructor de formularios por tipo de solicitante/vehículo (los campos son paramétricos, el formulario no). (c) Borrador general de solicitud: hoy solo la preaprobación del dealer y la cola de Datos Faltantes guardan a medias. |
| 9.2 | **Originación — fraude y cumplimiento** | (a) PEP: producto DealerNet 3450 en catálogo pero inactivo, sin tratamiento. (b) Sin listas negras internas ni cruce con listas de sancionados. (c) Sin verificación de encargo por robo del vehículo (solo texto en la política). (d) Ver 5.7 (duplicados al digitar). |
| 9.3 | **Originación — documentos y firma** | (a) Contrato, pagaré, hoja resumen y mandatos se cargan y validan; no se generan desde plantilla con los datos del crédito. (b) Firma: FES propia con QR/SHA-256; sin Firma Electrónica Avanzada de proveedor (relacionado con 5.3 onboarding digital). |
| 9.4 | **Dealer — integración y mensajería** | (a) API pública solo cotiza; no expone estados de solicitud para DMS del dealer. (b) Sin hilo de mensajes por solicitud dentro del Portal del Dealer (Atención Remota es un chat general). (c) Reportes de desempeño del dealer (aprobación, tiempos) no expuestos en su portal. |
| 9.5 | **Servicing — modificaciones contractuales** | Sin reestructuración, refinanciamiento, cambio de fecha de pago, meses de gracia, novación ni cesión individual. Cada una necesita flujo de aprobación, anexo de contrato y recálculo de la tabla de desarrollo por el motor único. |
| 9.6 | **Servicing — seguros y colateral** | (a) Sin registro de pólizas (compañía, vigencia, coberturas) ni alertas de vencimiento; sin integración con aseguradoras. (b) Prenda: existe el certificado de alzamiento, falta seguimiento del estado de inscripción. (c) Sin valor de mercado del vehículo ni LTV en el tiempo (tasadores). (d) Sin GPS del vehículo. |
| 9.7 | **Servicing — pagos** | (a) Sin PAC/débito automático. (b) Sin pago en línea desde el Portal del Cliente (pasarela). (c) Sin estado de cuenta periódico enviado al cliente (solo certificado a demanda). (d) Cliente no puede solicitar modificaciones ni gestionar su prepago desde el portal. |
| 9.8 | **Cobranza — canales y estrategia** | (a) Sin CTI ni marcación predictiva (solo discador manual de campañas). (b) Sin SMS. (c) Sin link de pago en correo/WhatsApp. (d) Promesas de pago sin alerta automática de incumplimiento. (e) Sin champion-challenger ni asignación de casos por reglas de segmento. (f) Guiones solo por campaña. (g) Escritorio unificado del gestor. |
| 9.9 | **Cobranza — judicial y agencias externas** | Sin flujo prejudicial/judicial (demandas, embargos, dación en pago) ni traspaso y seguimiento de agencias o estudios de abogados. Ver también 5.1 (voz). |
| 9.10 | **Activos reposeídos** | Módulo completo inexistente: registro del vehículo recuperado, custodia y costos, documentación, tasación, reparaciones, venta/remate y resultado neto contra la deuda castigada. Impacta LGD y contabilidad. |
| 9.11 | **Contabilidad y riesgo normativo** (*no aplica hoy*) | (a) Provisiones PD×LGD×EAD con matrices CMF (hoy modelo propio por tramo). (b) Interés efectivo NIIF 9. (c) Archivos MSI de la CMF. (d) Multiempresa/multimoneda. (e) Recuperos de castigados sin cuenta de utilidad específica; gastos por cuenta de clientes sin cuenta por cobrar separada. |
| 9.12 | **Riesgo — analítica** | Sin vintage/cosechas, stress testing ni concentración por segmento de riesgo o tipo de vehículo. Relacionado con 5.5 (predicción de mora) y Score de Mora sin historial INDEXA. |
| 9.13 | **PLD/FT y datos personales** | (a) Sin KYC formal, monitoreo de transacciones ni ROS a la UAF (*no aplica hoy*). (b) Ley 19.628: sin flujo de derechos ARCOP ni registro de consentimientos. |
| 9.14 | **Tesorería** | Flujo de caja proyectado (Plan Liquidez sin motor); reportes regulatorios SII más allá del F29 y el RCV. |
| 9.15 | **Seguridad y acceso** | 2FA y SSO (Google Client ID sin cargar; ya estaba en CLAUDE.md como futuro). Pentest formal. |
| 9.16 | **Plataforma** | Editor visual de reglas/flujos (low-code): todo es paramétrico pero se edita por mantenedor, no por diagrama. Pruebas de carga formales y SLA escrito. |

---

## Dónde más aparece esto

- **`CLAUDE.md`** → sección "Pendientes de Madurez del Sistema" (lo técnico-transversal), con puntero acá.
- **`/mantenedores/documentacion/pendientes.html`** → la misma lista, navegable, dentro de la Suite de Documentación.
- **Memoria del proyecto** → un archivo por pendiente grande, con su contexto y las decisiones ya tomadas que **no** hay que reabrir.
- **Footer "Qué afecta este mantenedor"** en cada mantenedor → la versión in-situ, por variable.
