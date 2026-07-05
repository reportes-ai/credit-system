# Plan QA — Certificación pre-producción AutoFácil Business Suite

> **Objetivo:** probar y certificar TODAS las funcionalidades antes del paso a producción.
> **Cómo usar:** cada caso se marca ✅ (pasa), ❌ (falla, abrir corrección) o ➖ (no aplica). Un módulo se **certifica** cuando todos sus P0 y P1 pasan.
> **Prioridades:** **P0** = bloquea salida (dinero, datos de clientes, legal). **P1** = debe funcionar, tolera workaround corto. **P2** = cosmético/secundario.
> **Regla de oro:** todo lo que envíe algo a un cliente real (correo, WhatsApp) se prueba primero con **Modo Desarrollo ACTIVO**.

---

## 0. Preparación del ambiente de pruebas

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 0.1 | Activar Modo Desarrollo (BG-ADMIN) | Cinta "DESARROLLO" visible en todas las páginas; todo correo sale solo a los 3 correos de prueba | P0 |
| 0.2 | Verificar versión desplegada | Badge de `app-version.js` coincide con el último commit en Render | P0 |
| 0.3 | `GET /api/health` o equivalente / logs Render sin errores al boot | Servicio arriba, migraciones IIFE sin error en logs | P0 |
| 0.4 | Backup TiDB verificado | Backup diario activo + una restauración de prueba documentada | P0 |
| 0.5 | Variables de entorno en Render (DB_*, JWT_SECRET, WSP_*, MAIL_*, CMF, ANTHROPIC, GOOGLE_MAPS) | Presentes, ninguna en el código ni en .env commiteado | P0 |

## 1. Autenticación, usuarios y permisos (transversal)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 1.1 | Login correcto / clave errada / usuario suspendido | Entra / rechaza / rechaza con mensaje | P0 |
| 1.2 | Expiración de token JWT | Redirige a login, sin pantalla rota | P1 |
| 1.3 | Cambiar contraseña desde el chip de usuario | Cambia y permite re-login | P1 |
| 1.4 | Crear usuario nuevo + asignar perfil | Ve SOLO las cards/funciones de su perfil (probar con perfil Ejecutivo y Analista) | P0 |
| 1.5 | Matriz de permisos: quitar una funcionalidad a un perfil | La card desaparece y la API responde 403 (probar 2-3 códigos: cartas, comisiones, mantenedores) | P0 |
| 1.6 | `node scripts/audit-permisos.js` | Sin duplicados ni huérfanos | P1 |
| 1.7 | Cuenta break-glass admin@admin.cl | Funciona (protegida, no tocar) | P0 |
| 1.8 | Visibilidad de ejecutivos (`ambito_ejecutivos` asignados) | Supervisor con asignados ve solo los suyos en Comisiones/Fundantes/Post Venta | P1 |
| 1.9 | Módulo Auditoría | Login y 2-3 acciones críticas del día quedan registradas | P1 |

## 2. Créditos (núcleo)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 2.1 | Carga masiva Excel (archivo real del mes) | Filas cargadas = filas del Excel; errores reportados con motivo | P0 |
| 2.2 | Digitación AutoFin / Unidad / AutoFácil | Guarda; campos $ con formato miles; validación RUT (DV) | P0 |
| 2.3 | Cola Digitación Datos Faltantes | Toma el más antiguo, bloqueo 20 min funciona entre 2 usuarios | P1 |
| 2.4 | Editar crédito broker (revisar.html) | Prefill correcto, guarda, montos con formato | P1 |
| 2.5 | Estados: DIGITADO→APROBADO→OTORGADO y RECHAZADO→APELADO | Transiciones según mapa del mantenedor Estado Créditos | P0 |
| 2.6 | **Crédito otorgado es inmutable** | Capital/fecha/cuotas/gastos NO cambian tras otorgar; calendario leído de `cuotas_credito` | P0 |
| 2.7 | Numeración: `num_op` correlativo único; `id_financiera` de la financiera | Nunca se repite un num_op | P0 |
| 2.8 | Recálculo automático (comisiones/ingresos) al editar por cualquier vía | Recalcula; **respeta forzados (rojo) y meses cerrados** | P0 |
| 2.9 | Paginación server-side + stats totales | Conteos correctos con filtro por financiera | P1 |
| 2.10 | Alertas de análisis (EN_ANALISIS → pool; aprobar/rechazar → creador) | Campana notifica a quien corresponde | P1 |

## 3. Cartas de Aprobación (módulo frágil — probar SIN tocar código)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 3.1 | Crear carta completa + imprimir PDF | PDF correcto, comisión pactada snapshot al emitir | P0 |
| 3.2 | Autofill desde PDFs de Unidad | Autocompleta y adjunta para el analista | P1 |
| 3.3 | Cartas Vigentes: Otorgar → crédito OTORGADO + cartola; Desistir → DESISTIDO | Flujo completo con plazo de 5 días corridos | P0 |
| 3.4 | Vencimiento automático → DESISTIDA (no imprimible) | Carta vencida no se puede imprimir | P1 |
| 3.5 | Rentabilidad por carta (permiso aprob_rentabilidad) | AutoFin vs UAC con motor compartido; restringido a quien tiene permiso | P1 |
| 3.6 | Cuadro Preferencia Financiera | Elegibilidad bloquea grabar; 1ª opción solo sugiere | P1 |

## 4. Cotizaciones / Evaluación crediticia

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 4.1 | Simulador: cuota francesa con tasa/plazo/pie conocidos | Cuota = cálculo manual (validar 2 casos contra Excel) | P0 |
| 4.2 | Cotización guardada muestra Pie/Plazo/Cuota completos | Grilla completa | P2 |
| 4.3 | Evaluación por RUT: ficha + pull DealerNet | Trae informes (caché 15 días), sin cobrar consultas duplicadas | P1 |
| 4.4 | IA liquidaciones de sueldo + informe DealerNet | Extrae datos correctos de un caso conocido | P1 |

## 5. Comisiones y cierres

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 5.1 | Revisión mensual de un ejecutivo contra cálculo manual | Piso + incentivo + ajustes NCNU/calidad cuadran | P0 |
| 5.2 | Campos forzados (rojo) sobreviven al recálculo | No se pisan | P0 |
| 5.3 | Mes cerrado no se recalcula | Bloqueado | P0 |
| 5.4 | Comisión dealer: tabla individual manda; pizarra default; carta manda si trae participación | Verificar 1 caso de cada tipo | P0 |
| 5.5 | Bono Jefe Comercial (BSC) | Score y curva coinciden con parámetros | P2 |

## 6. Tesorería (dinero — todo P0)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 6.1 | Pago de cuota en caja (individual y lote) | Estampa pago, timbre PAGADO con caja/fecha/hora, comprobante | P0 |
| 6.2 | Mora + gastos de cobranza al día en el pago | Mismo valor que certificado y portal (motor único) | P0 |
| 6.3 | ODP de cuotas: emitir → cola → aprobar registra pago + correo BCC cobranza@ | Flujo completo | P0 |
| 6.4 | Prepago en caja | Monto = certificado de prepago (mismo motor); marca PREPAGADO; condonación según atribuciones y ORDEN (gastos→intereses, nunca capital) con registro | P0 |
| 6.5 | Órdenes de pago: correlativo OP- único global; anular NO libera número | Verificar | P0 |
| 6.6 | Factura de comisión vs cartola: descuadre avisa en ROJO | Verificar con monto errado a propósito | P0 |
| 6.7 | Cuentas transitorias: cargo/abono con formato $ | Cuadra | P1 |
| 6.8 | Plan Liquidez (anticipos Super Partner) | A=min(C,tope), descuento en ODP, abono al pagarse | P1 |

## 7. Cobranza + Ley del Consumidor (legal — P0)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 7.1 | Pre-judicial: tramos, días de mora, montos vs 2 casos calculados a mano | Cuadra con motor único | P0 |
| 7.2 | Gastos de cobranza solo desde día 21, tramos UF marginales | Verificar caso día 15 (sin gasto) y día 25 (con gasto) | P0 |
| 7.3 | Tope semanal de gestiones: 1 telefónica/presencial + 2 remotas (≥2 días entre remotas) | El sistema BLOQUEA la gestión de más | P0 |
| 7.4 | Judicial 91+ días: expedientes y acciones | Registra | P1 |
| 7.5 | Compromisos de pago en bitácora del crédito | Quedan | P1 |
| 7.6 | Tabla full-width sin scroll horizontal (fix v89.0) | Se ve completa | P2 |

### 7b. Automatizaciones de Cobranza (mantenedor unificado)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 7b.1 | Correo: "Correr ahora (prueba)" | Lista candidatos por tramo sin enviar | P0 |
| 7b.2 | Correo: "Correr y enviar" con Modo Desarrollo | Llega SOLO a correos de prueba con [DESARROLLO]; queda en historial Y en crm_gestiones del cliente | P0 |
| 7b.3 | Cooldown: correr 2 veces seguidas | Segunda corrida salta los ya enviados | P0 |
| 7b.4 | WhatsApp: armar secuencia (2 plantillas APROBADAS, N°1 y N°2, variables mapeadas) | Se guarda; estatus Meta visible | P0 |
| 7b.5 | WhatsApp: probar → correr (a un teléfono propio de prueba) | Llega plantilla N°1 con datos correctos; segunda corrida al día siguiente manda N°2; NUNCA repite | P0 |
| 7b.6 | Webhook estados: tras leer el mensaje en el teléfono | Historial y crm_gestiones pasan a ENTREGADO→LEIDO | P0 |
| 7b.7 | Secuencia agotada | No envía más a ese crédito | P1 |
| 7b.8 | Ambos motores nacen DESACTIVADOS tras deploy | Verificar switches | P0 |

## 8. WhatsApp Facilito (bot)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 8.1 | Conversación de venta 5 pasos desde un celular externo | Guion completo, cotización con aviso "solo referencial" | P0 |
| 8.2 | Guardia de RUT: pedir dónde-pagar sin dar RUT | Pide el RUT; NUNCA muestra datos de otro RUT del historial | P0 |
| 8.3 | Dónde pagar por financiera (AUTOFACIL/UNIDAD/AUTOFIN) | Datos correctos desde fuente única | P0 |
| 8.4 | Límites anti-abuso preevaluaciones DealerNet | Al superar, deriva a ejecutivo | P1 |
| 8.5 | Aviso vencimiento: probar con caso real | Elige plantilla simple vs mora correctamente; montos al día | P0 |
| 8.6 | Derivación a humano + oportunidad por mail fuera de horario | Llega notificación/mail | P1 |
| 8.7 | Crear plantilla HSM con revisión IA obligatoria | No deja enviar sin revisar; llega a Meta como PENDING | P1 |

## 9. Campañas Masivas

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 9.1 | Campaña MAIL venta: BD paramétrica (monto mín, renta estimada) → control por deciles → enviar con Modo Desarrollo | Solo correos de prueba; grupo CONTROL no recibe | P0 |
| 9.2 | Píxel de lectura | Abrir el mail marca LEIDO (y la vista previa NO) | P1 |
| 9.3 | Campaña WSP con plantilla HSM mapeada | Llega a teléfono de prueba con variables correctas | P0 |
| 9.4 | Análisis política + informes (opcionales e independientes) + exclusiones | Excluye lo marcado | P1 |
| 9.5 | Contactos DealerNet (perfil 3435): revisión uno a uno | Nombre DN vs nuestro; asigna mail / 1-3 teléfonos | P1 |
| 9.6 | Conversión y champion-challenger | Recalcular cruza contra ventas/pagos; uplift se muestra | P1 |
| 9.7 | Cada envío queda en crm_gestiones | Verificar | P0 |

## 10. Portales externos (clientes/dealers ven esto)

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 10.1 | Portal Cliente: OTP al correo → clave → ve SOLO sus créditos | Aislamiento total (probar con 2 RUTs) | P0 |
| 10.2 | Portal Cliente: valores de cuota al día = caja/certificado | Motor único | P0 |
| 10.3 | Portal Dealer: aislamiento cross-dealer por JWT | Dealer A jamás ve operaciones del B | P0 |
| 10.4 | Atención Remota (chat dealers) | Mensajes en vivo, 3 paralelos | P1 |
| 10.5 | Verificador QR /verificar/<código> | Muestra datos mínimos; documento adulterado se detecta (FES hash) | P0 |

## 11. Reportería y Dashboard

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 11.1 | Dashboard: totales del mes vs Excel fuente | Cuadran (dedup por num_op, mayor/menor 200UF con UF de fecha_otorgado) | P0 |
| 11.2 | Cartera de Créditos + Cobranza y Mora (gráficos 3D) | Números = BD; charts renderizan | P1 |
| 11.3 | Bitácora de un Crédito (por RUT/OP) | Timeline completo | P1 |
| 11.4 | Comparaciones (vs mes anterior, presupuesto, caída por ejecutivo) | Números verificables | P1 |
| 11.5 | Exportaciones Excel | Abren sin corrupción, cifras iguales a pantalla | P1 |

## 12. Mantenedores y parámetros

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 12.1 | UF/UTM/dólar sync CMF | Valor del día correcto vs cmfchile.cl | P0 |
| 12.2 | Cambiar una tasa/parámetro → repercute donde el footer "Qué afecta" dice | Probar 3 mantenedores al azar | P1 |
| 12.3 | Impuestos (IVA/retención) alimentan cálculos de boleta/factura | Verificar 1 caso | P0 |
| 12.4 | Estado Créditos: editar transición NO bloquea aún (fase configurativa) | Según diseño | P2 |
| 12.5 | Alertas (central + Post Venta): activar/desactivar surte efecto | Campana obedece | P1 |
| 12.6 | Correos programados: Informe Diario de Ventas con Modo Desarrollo | Llega a prueba, horario Chile correcto | P1 |
| 12.7 | Backups/suplencias: activar suplente hereda funciones | Verificar 1 caso | P2 |
| 12.8 | Consola SQL: solo SELECT, auditada | UPDATE es rechazado | P1 |

## 13. Módulos de soporte

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 13.1 | Fundantes: subir doc → validar/rechazar con comentario | Flujo completo, matriz por antigüedad | P1 |
| 13.2 | RRHH: solicitud vacaciones → aprobar → alerta | Flujo completo | P2 |
| 13.3 | Tickets TI: crear → SLA → escalar → correos | Flujo completo | P2 |
| 13.4 | Compras: pedido por perfil + copiar para Dimerc | Funciona | P2 |
| 13.5 | Mi Día: widgets por perfil + colocaciones | Datos reales | P2 |
| 13.6 | Dealers: incorporación (cadena de aprobación), visitas, mapa | Flujos completos | P1 |
| 13.7 | Certificados (5 tipos) + firma electrónica antigüedad | PDF + QR verificable | P1 |

## 14. Integraciones externas (probar conectividad y fallback)

| # | Integración | Prueba | Prio |
|---|------------|--------|------|
| 14.1 | DealerNet SOAP | Consulta RUT real; caché 15 días evita segunda consulta pagada | P0 |
| 14.2 | Meta WhatsApp Cloud | Enviar/recibir + webhook estados | P0 |
| 14.3 | Brevo SMTP | Correo real llega (dominio autenticado, no spam) | P0 |
| 14.4 | CMF API | UF del día | P0 |
| 14.5 | Anthropic | Una extracción IA funciona; con IA apagada el sistema NO se cae (degrada con mensaje) | P1 |
| 14.6 | Caída simulada: DealerNet/Meta/Brevo sin token | Error claro al usuario, sin pantalla blanca ni crash | P0 |

## 15. Seguridad y robustez

| # | Prueba | Esperado | Prio |
|---|--------|----------|------|
| 15.1 | API sin token / con token de perfil bajo a rutas de escritura sensibles | 401/403 (probar 5 rutas: config, permisos, caja, cartas, SQL console) | P0 |
| 15.2 | Webhook WhatsApp con verify token errado | 403 | P1 |
| 15.3 | Píxel de campañas con token adulterado | No marca nada | P1 |
| 15.4 | HTTPS forzado + .env fuera del repo + JWT_SECRET rotado si estuvo expuesto | Verificar | P0 |
| 15.5 | Rate limit en /api/auth/login | ✅ Implementado (v89.2): 10 intentos/min por IP → 429; también portal cliente (solicitar-codigo, activar, login). Probar: 11 logins fallidos seguidos → el 11° da 429 | P1 |
| 15.6 | Query pesada (reportería año completo) | Responde o timeoutea con gracia, no cuelga el server | P1 |

## 16. Criterios de salida (checklist final)

- [ ] Todos los **P0** en ✅ (sin excepciones)
- [ ] Todos los **P1** en ✅ o con workaround documentado y aceptado por Pato
- [ ] Motores automáticos (cobranza correo/WhatsApp, aviso vencimiento, correos programados) **verificados y luego DESACTIVADOS** hasta el go-live
- [ ] Modo Desarrollo: plan de apagado el día del go-live (quién, cuándo)
- [ ] Backup + restauración probada esa misma semana
- [ ] Deploy congelado 48h antes del go-live (solo hotfix P0)
- [ ] Responsables y teléfono de emergencia definidos para el día 1

---
*Actualizar este documento con cada módulo nuevo. Fecha de creación: 2026-07-04 (v89.1).*
