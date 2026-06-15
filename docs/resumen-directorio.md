# AutoFácil — Plataforma de Gestión de Crédito Automotriz
### Resumen ejecutivo de funcionalidades · Presentación a Directorio

---

## 1. La idea central (mensaje para el Directorio)

> **No construimos un repositorio de créditos. Construimos la plataforma operativa
> de la compañía.**

El sistema no solo *almacena* operaciones de crédito: **administra el negocio completo
de punta a punta** — desde la cotización y aprobación, pasando por el pago al
concesionario y la comisión, hasta la cobranza y la reportería para gerencia. Todo en
un mismo lugar, en la nube, con trazabilidad y control de acceso por perfil.

**Tres ideas fuerza:**
1. **Plataforma integral, no archivo.** Reemplaza planillas Excel dispersas y procesos
   manuales por un flujo único, auditable y compartido.
2. **Software paramétrico.** El Administrador del negocio configura montos, tasas,
   estados, plazos, textos y permisos **sin depender de un programador**. El sistema
   se adapta al negocio, no al revés.
3. **Diseñado para crecer.** Cada proceso nuevo se suma como módulo; la arquitectura ya
   soporta más volumen y más áreas sin rehacer lo existente.

---

## 2. Qué hace hoy el sistema (por área de negocio)

### 📊 Dashboard y Analítica
- Tablero de indicadores del negocio: operaciones por estado, montos, instituciones,
  clasificación MAYOR/MENOR 200 UF, comparativos por período.
- Datos en tiempo real a partir de la carga de operaciones.

### 📝 Originación: Cotización y Aprobación de Crédito
- **Simulador / cotizador** de créditos.
- **Cartas de Aprobación**: generación, revisión con principio de "cuatro ojos"
  (quien crea no aprueba), historial e impresión.
- Validación de tasas contra pizarra y preferencia de financiera.

### 💳 Gestión de Créditos
- **Carga masiva** de operaciones vía Excel.
- Listado, búsqueda y paginación server-side; edición y digitación.
- Cálculo automático de tramo (MAYOR/MENOR 200 UF) con la UF de la fecha de
  otorgamiento y la Tasa Máxima Convencional (TMC) vigente.

### 👥 Clientes
- Ficha integral: datos personales, antecedentes laborales e información comercial
  (perfil de deudas).

### 🤝 Comisiones a Concesionarios (Dealers)
- Cálculo mensual de comisiones por ejecutivo y por dealer.
- **Cartolas acumulativas** por dealer (incluye pendientes de meses anteriores).
- **Boleta vs. Factura** con impuestos paramétricos (IVA 19%, Retención de Honorarios
  15,25%): el sistema calcula neto, impuesto y monto líquido a depositar.
- **Órdenes de Pago de Comisión** que agrupan operaciones de una misma boleta/factura
  en un solo documento, listo para Contabilidad.

### 🏦 Post Venta — Pago a Concesionario (Saldo Precio) y Comisión
- **Workflow por etapas** con atribuciones por perfil: Orden de Pago Emitida →
  Enviado a Pago → Pagado.
- Flujo espejo para Comisión (Cartola Emitida → Aprobada → Enviada → Factura Recibida
  → Orden de Pago → Pago), con **trazabilidad de quién hizo qué y cuándo**.

### 💰 Tesorería
- Cuentas transitorias, cajas, cierre de caja y brokerage.

### 📞 Cobranza
- Gestión de cobranza con parámetros configurables.
- Cálculo de **interés por mora** (TMC diaria por tramo) y **gasto de cobranza**
  (Ley 19.496, por tramos en UF), conforme a normativa.

### 📈 CRM y Reportería
- Registro de gestiones (CRM).
- **Reportería "Tailor Made"** para gerencia, con generación de cartas y
  exportación a Excel.
- Informe de **Desempeño de Analistas** (presencia y actividad).

---

## 3. Lo que nos diferencia (el "mucho más")

### ⚙️ Aplicación paramétrica — configuración sin programador
El Administrador modifica desde **mantenedores** (sin tocar código):
UF, tasas y umbrales, dealers, impuestos, parámetros de cobranza, estados y etapas,
textos de cartas, módulos y permisos. *El negocio cambia una regla y el sistema obedece.*

### 🔐 Seguridad y control de acceso por perfil
- Autenticación con token (JWT) y cambio de contraseña propio.
- **Matriz de Perfiles y Permisos**: cada acción sensible (emitir, pagar, reversar,
  cargar) se habilita por perfil desde una pantalla, con bypass para Administrador.
- Auditoría de integridad de permisos.

### 🧭 Trazabilidad y gobierno del proceso
- Cada etapa registra autor y fecha. El proceso tiene un orden que se respeta;
  lo que se abre a configuración son los *valores*, no la *estructura*.

### 🔔 Operación asistida en tiempo real
- **Notificaciones** (campana + push) por eventos del flujo: "fondos recibidos",
  "emitir orden de pago", alertas de alta prioridad.
- **Ayuda contextual** página por página y un **Glosario / Base de Conocimiento**
  con definiciones y fórmulas del negocio, editable por el Administrador.

### ☁️ Arquitectura moderna y escalable
- Servicios en la nube (despliegue automático), base de datos administrada,
  frontend liviano. **Disponible desde cualquier navegador, sin instalación.**

---

## 4. Beneficios para el negocio (cierre para Directorio)

| Antes (planillas / manual) | Con la plataforma |
|---|---|
| Datos dispersos en Excel | Fuente única, en la nube, compartida |
| Cálculos manuales (comisión, mora, impuestos) | Cálculo automático y parametrizado |
| Sin trazabilidad de quién aprobó/pagó | Auditoría por etapa, autor y fecha |
| Cambios requieren programador | El Administrador configura solo |
| Riesgo operacional y de control | Permisos por perfil y validaciones |

**Resultado:** menos errores, más control, procesos más rápidos y una base sólida
para escalar a nuevas áreas del negocio.

---

## 5. Hacia dónde va (roadmap breve, opcional)
- Endurecimiento de producción: respaldos, alertas de errores, health-checks.
- Auditoría de acciones críticas (quién cerró mes, cambió permisos, etc.).
- 2FA para perfiles administradores.
- Caché y CDN cuando el volumen lo justifique.

---

*Documento de apoyo para la presentación. Estructurado por secciones para traducir
directo a slides (cada ## puede ser una lámina).*
