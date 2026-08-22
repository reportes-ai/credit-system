# Pendientes del Business Suite — vista consolidada

> **Actualizado: 20-08-2026.** Este archivo es la **única lista completa** de lo que está
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
| 1.7 | **Logs de auditoría de acciones críticas** | Existe `shared/audit.js` + módulo Auditoría. Falta confirmar cobertura explícita de: cerrar mes, eliminar crédito, cambiar permisos de perfil, carga masiva. |

## 2. Contabilidad (el reemplazo de AVSOFT)

| # | Pendiente | Estado / detalle |
|---|---|---|
| 2.1 | **Disparador contable de comisiones internas y colocación** | Tres reglas **creadas y editables, pero que nadie dispara**: `COMISION_EJECUTIVOS` (4001100 / 2106060), `COMISION_PARQUES` (4002100 / 2106012), `CREDITO_OTORGADO_AF` (1104010 / 1101090). **Dudas a resolver con Pato**: (a) el endpoint `aprobar` de comisiones solo guarda `incentivo_final`, no el total del mes — ¿recalcular con el motor al aprobar, o contabilizar al emitir la ODP? (b) ¿`CREDITO_OTORGADO_AF` se activa al marcar OTORGADO, y sale contra banco directo o cuenta transitoria? |
| 2.2 | **Traer al auxiliar el RCV ya sincronizado** | Desde v210.4 existe "Traer del SII al auxiliar". Falta **correrlo**: 88 documentos de agosto pendientes, más los meses anteriores que se vayan sincronizando. Partir marcando pocos para revisar los asientos. |
| 2.2b | **El auxiliar de compras no tiene los folios reales** | Los **2.033 documentos importados de AVSOFT** quedaron con el folio igual al tipo de documento (se muestran como "33-33"): la columna se buscaba por "documento" y eso también calzaba con "Tipo de Documento". **El parser ya está corregido**, pero los datos se cargaron antes y nunca se re-importaron. Consecuencia grave: contra esos meses **el anti-duplicados del importador del RCV es ciego** — traer el RCV de un mes ya importado lo duplicaría entero. La pantalla ahora avisa en rojo y bloquea la decisión, pero el arreglo de verdad es **re-importar el export de AVSOFT de cada mes** (la importación reemplaza el mes completo, así que es segura). Afectados: todos los meses desde 2025-08 hasta 2026-07. |
| 2.2c | **La lectura del SII está pausada hasta el 1° de septiembre** | La apikey gratuita de SimpleAPI da **30 consultas al mes** y en agosto se hicieron **812**: no fueron sincronizaciones sino el motor reintentando durante los 12 días en que el certificado no abría, una vez a los 45 s de cada arranque. No está vencida (se generó en junio y dura un año), así que **el 1° de septiembre el contador se reinicia y vuelve sola** — no hay que pagar ni regenerar. Ya se corrigió la causa: ahora la espera crece con cada falla consecutiva (30 min a 12 h) y el primer resultado bueno borra el castigo. **En septiembre**: traer los 12 meses del RCV (12 consultas) y reparar los folios del punto 2.2b. |
| 2.3 | **Notas de crédito (61) del RCV** | Quedan fuera del importador: en el auxiliar van con signo negativo y el motor de ingreso exige total > 0. Hoy se digitan aparte; automatizarlo es trabajo pendiente. |
| 2.4 | **Nunca se ha cerrado un mes** | `ctb_meses_cerrados` está vacío, así que el candado `MES_CERRADO` del motor **jamás ha actuado**: nada impide hoy digitar sobre un período ya informado. Decidir desde qué mes se empieza a cerrar. |
| 2.5 | **Conciliación y pagos al día** | Al corte de julio: **112 movimientos bancarios sin conciliar** y **4 ODP en estado EMITIDA impagas**. |
| 2.6 | **Facturación electrónica (emitir DTE)** | Proyecto mayor acordado y **no contratado** (OpenFactura). Hoy el ingreso se contabiliza contra la solicitud por correo; con DTE real el asiento saldría con el folio del SII. SimpleAPI solo **lee** el RCV, no emite. |
| 2.7 | ✅ **Mes contable vs fecha de curse** (definido por Pato 21-08-2026) | La convención: **la comisión se atribuye por FECHA DE CURSE**, pero INDEXA no dejaba digitar con fechas distintas y los meses históricos se ajustaron vía `mes` (mes contable) — esos ajustes siguen mandando hacia atrás. Regla implementada (motor único `shared/mes-atribucion.js`): meses **hasta jul-2026** → mes contable ajustado; **desde ago-2026** → fecha de otorgamiento. Corte paramétrico en `parametros_credito.mes_corte_curse`. Aplicado en Comisión Ejecutivos y Bono Jefe (pilares 1 y 2); dashboard y cartolas ya usaban mes contable y no cambian. Caso que lo destapó: op 88786 de Brandon Barbas (cursada 30-06, mes contable jul) — con fecha de curse quedaba bajo el piso de $35M y perdía la comisión completa de julio. |
| 2.8 | **Costos de servicios por escenario** | La vista única ya existe (Mantenedores → Salud y Uptime → "Gastos mensuales por servicio", tabla `servicios_costos`). Falta el pedido original: costo en **contingencia**, si **crece el volumen**, y qué pasa si se **deja de pagar**. Medidos: Render US$8,30 (decidido subir a Standard US$25), TiDB US$9,60 variable, Cloud SQL US$2,40 detenida / US$4,80 día encendida, GCS US$0,05, IA ~US$3,95. Por confirmar en cada panel (**no inventar**): Brevo, Meta WhatsApp, DealerNet, SimpleAPI, Workera, NIC Chile. Evaluar que viva en Órdenes de Pago como gasto recurrente real. |

## 3. Datos y migraciones

| # | Pendiente | Estado / detalle |
|---|---|---|
| 3.1 | **Cartera INDEXA — Etapa 3** | Migradas 4.425 + 1.319 operaciones; falta la etapa final. |
| 3.2 | **26 huérfanos del bucket** | Objetos en `gs://autofacil-docs` sin fila que los apunte, del barrido de migración de documentos. |
| 3.3 | **Historial de mora INDEXA para el Score de Mora** | El módulo está construido pero le falta el histórico para calibrar por segmento. |
| 3.4 | **Ops a nombre de un ejecutivo suspendido** | Se siguen digitando operaciones con el nombre de Carlo Moreno (usuario 120005, inactivo desde ~mayo), en variantes "CARLOS MORENO" y "CARLO ANDRÉS". Revisar con Operaciones a quién corresponden de verdad — afecta atribución y comisión. |
| 3.5 | **Actividades económicas del SII** | 674 códigos cargados; falta cablearlos a los giros de clientes y proveedores. |

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
| 4.10 | **WhatsApp: usernames y BSUID** | Reservar el nombre de usuario del número de Facilito en WhatsApp Manager (WABA 1044493808034066, portafolio "Auto Facil Chile"; reserva abierta desde 06-2026, se activa cuando llegue a Chile). Y adaptar el bot ANTES de esa activación: los webhooks traerán `user_id`/`from_user_id` (BSUID, formato `CL.xxx…`) y a veces SIN número del cliente (solo viene si hubo interacción en 30 días o está en la libreta de contactos); desde 07-2026 la API acepta enviar al BSUID. Hoy Facilito identifica solo por número → guardar/tolerar BSUID en webhooks y envíos. Doc: developers.facebook.com → Business-scoped user IDs. (Detectado 21-08-2026.) |

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

---

## Dónde más aparece esto

- **`CLAUDE.md`** → sección "Pendientes de Madurez del Sistema" (lo técnico-transversal), con puntero acá.
- **`/mantenedores/documentacion/pendientes.html`** → la misma lista, navegable, dentro de la Suite de Documentación.
- **Memoria del proyecto** → un archivo por pendiente grande, con su contexto y las decisiones ya tomadas que **no** hay que reabrir.
- **Footer "Qué afecta este mantenedor"** en cada mantenedor → la versión in-situ, por variable.
