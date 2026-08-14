'use strict';
/* ─────────────────────────────────────────────────────────────────
   MOTOR ÚNICO — qué campos de dealer puede editar cada perfil

   El Administrador define en el mantenedor (Mantenedores › Dealers ›
   Permisos de edición) qué perfil edita qué campo, en las dos pantallas
   donde se toca un dealer:
     · FICHA  → EDITAR un borrador o CORREGIR una ficha rechazada (nuevo.html?id=…).
       Crear una ficha nueva no pasa por aquí: eso es dealer_ficha_crear.
     · DEALER → el modal "Editar Dealer" de Dealers vigentes (mantencion.html)

   Reglas:
   - **Por omisión NADA está permitido**: un perfil nuevo nace sin poder editar
     nada, y el Administrador va marcando lo que cada uno puede tocar. La tabla
     guarda lo HABILITADO (`puede_editar=1`); lo que no figura, no se edita.
   - `Administrador` nunca se bloquea (misma convención que el resto del sistema).
   - `__ACCESO__` es el campo especial que decide si el perfil ve el botón
     (Editar / Corregir) de esa pantalla.
   - El frontend pinta los campos bloqueados en gris (se ven, no se editan) y
     **el backend los ignora al guardar**: sin esa segunda mitad el candado
     sería decorativo.
   ───────────────────────────────────────────────────────────────── */
const pool = require('./config/database');
const { enFila } = require('./migrate');

const PANTALLAS = ['FICHA', 'DEALER'];
const ACCESO = '__ACCESO__';

/* Catálogo de campos: es ESTRUCTURA (qué existe en cada formulario), no dato de
   negocio — el mantenedor decide quién los edita, no cuáles hay. */
const CAMPOS = {
  DEALER: [
    { campo: 'rut',             label: 'RUT',                grupo: 'Identificación' },
    { campo: 'nombre_razon',    label: 'Nombre Razón Social',grupo: 'Identificación' },
    { campo: 'nombre_indexa',   label: 'Nombre Dealer',      grupo: 'Identificación' },
    { campo: 'ccs_parque',      label: 'Categoría (CCS/Parque)', grupo: 'Identificación' },
    { campo: 'direccion',       label: 'Dirección',          grupo: 'Contacto' },
    { campo: 'contacto',        label: 'Contacto',           grupo: 'Contacto' },
    { campo: 'telefono',        label: 'Teléfono',           grupo: 'Contacto' },
    { campo: 'correo',          label: 'Correo',             grupo: 'Contacto' },
    { campo: 'banco',           label: 'Banco',              grupo: 'Datos de pago' },
    { campo: 'num_cuenta',      label: 'N° Cuenta',          grupo: 'Datos de pago' },
    { campo: 'rut_pago',        label: 'RUT Pago',           grupo: 'Datos de pago' },
    { campo: 'tiene_factura',   label: 'Emite Factura',      grupo: 'Datos de pago' },
    { campo: 'activo',          label: 'Activo',             grupo: 'Estado' },
    { campo: 'observaciones',   label: 'Observaciones',      grupo: 'Estado' },
  ],
  FICHA: [
    { campo: 'rut',             label: 'RUT',                     grupo: 'Identificación' },
    { campo: 'nombre_razon',    label: 'Razón social',            grupo: 'Identificación' },
    { campo: 'nombre_fantasia', label: 'Nombre de fantasía',      grupo: 'Identificación' },
    { campo: 'direccion',       label: 'Dirección',               grupo: 'Ubicación' },
    { campo: 'comuna',          label: 'Comuna',                  grupo: 'Ubicación' },
    { campo: 'provincia',       label: 'Provincia',               grupo: 'Ubicación' },
    { campo: 'region',          label: 'Región',                  grupo: 'Ubicación' },
    { campo: 'nombre_parque',   label: 'Parque',                  grupo: 'Ubicación' },
    { campo: 'direccion_parque',label: 'Dirección del parque',    grupo: 'Ubicación' },
    { campo: 'comuna_parque',   label: 'Comuna del parque',       grupo: 'Ubicación' },
    { campo: 'cc_nombre',       label: 'Contacto comercial',      grupo: 'Contactos' },
    { campo: 'cc_telefono',     label: 'Teléfono comercial',      grupo: 'Contactos' },
    { campo: 'cc_email',        label: 'Correo comercial',        grupo: 'Contactos' },
    { campo: 'cf_nombre',       label: 'Contacto finanzas',       grupo: 'Contactos' },
    { campo: 'cf_telefono',     label: 'Teléfono finanzas',       grupo: 'Contactos' },
    { campo: 'cf_email',        label: 'Correo finanzas',         grupo: 'Contactos' },
    { campo: 'rl_nombre',       label: 'Representante legal',     grupo: 'Contactos' },
    { campo: 'rl_telefono',     label: 'Teléfono rep. legal',     grupo: 'Contactos' },
    { campo: 'rl_email',        label: 'Correo rep. legal',       grupo: 'Contactos' },
    { campo: 'com_6_12',        label: 'Comisión 6 a 12',         grupo: 'Comisiones' },
    { campo: 'com_13_24',       label: 'Comisión 13 a 24',        grupo: 'Comisiones' },
    { campo: 'com_25_36',       label: 'Comisión 25 a 36',        grupo: 'Comisiones' },
    { campo: 'com_37',          label: 'Comisión 37 y +',         grupo: 'Comisiones' },
    { campo: 'com_parque_6_12', label: 'Comisión parque 6 a 12',  grupo: 'Comisiones' },
    { campo: 'com_parque_13_24',label: 'Comisión parque 13 a 24', grupo: 'Comisiones' },
    { campo: 'com_parque_25_36',label: 'Comisión parque 25 a 36', grupo: 'Comisiones' },
    { campo: 'com_parque_37',   label: 'Comisión parque 37 y +',  grupo: 'Comisiones' },
    { campo: 'banco',           label: 'Banco',                   grupo: 'Datos de pago' },
    { campo: 'tipo_cuenta',     label: 'Tipo de cuenta',          grupo: 'Datos de pago' },
    { campo: 'num_cuenta',      label: 'N° de cuenta',            grupo: 'Datos de pago' },
    { campo: 'nombre_cuenta',   label: 'Titular de la cuenta',    grupo: 'Datos de pago' },
    { campo: 'rut_cuenta',      label: 'RUT de la cuenta',        grupo: 'Datos de pago' },
    { campo: 'tipo_documento',  label: 'Documento (factura/boleta)', grupo: 'Datos de pago' },
    { campo: 'correo_confirmacion', label: 'Correo de confirmación', grupo: 'Datos de pago' },
    { campo: 'observaciones',   label: 'Observaciones',           grupo: 'Otros' },
  ],
};

enFila('dealer-campos-permisos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_campos_permisos (
    id_perfil INT NOT NULL,
    pantalla VARCHAR(10) NOT NULL,
    campo VARCHAR(60) NOT NULL,
    puede_editar TINYINT NOT NULL DEFAULT 1,
    actualizado DATETIME NULL,
    actualizado_por VARCHAR(120) NULL,
    PRIMARY KEY (id_perfil, pantalla, campo)
  )`);

  // Card en el landing de Creación/Mantenedor de Dealer (módulo 370001) + permiso.
  // Va por BD, como todas: nada de listas fijas en el frontend.
  try {
    const codigo = 'dealer_campos_permisos';
    const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (370001, 'Permisos de Edición', ?, '/dealers-incorporacion/permisos.html', 'bi-shield-lock')`, [codigo]);
      idf = r.insertId;
    }
    for (const idp of [1]) {   // solo Administrador: reparte atribuciones sobre los demás perfiles
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
  } catch (e) { console.error('[dealer_campos_permisos funcionalidad]', e.message); }
});

/* Lo PERMITIDO de un perfil: { FICHA: Set(campos), DEALER: Set(campos) }.
   La tabla guarda lo habilitado; lo que no está, no se edita. Caché corta —
   la matriz cambia poco y se consulta en cada apertura de ficha. */
let cache = { ts: 0, filas: null };
const CACHE_MS = 60 * 1000;

async function permitidosDe(idPerfil) {
  if (!cache.filas || Date.now() - cache.ts > CACHE_MS) {
    const [rows] = await pool.query('SELECT id_perfil, pantalla, campo FROM dealer_campos_permisos WHERE puede_editar=1');
    cache = { ts: Date.now(), filas: rows };
  }
  const out = { FICHA: new Set(), DEALER: new Set() };
  cache.filas.forEach(r => { if (r.id_perfil === idPerfil && out[r.pantalla]) out[r.pantalla].add(r.campo); });
  return out;
}

function invalidarCache() { cache = { ts: 0, filas: null }; }

const esAdmin = (usuario) => (usuario && usuario.perfil_nombre) === 'Administrador';

/* Permisos del usuario que hace la petición, listos para el frontend. */
async function permisosDe(usuario) {
  const todo = { FICHA: { acceso: true, bloqueados: [] }, DEALER: { acceso: true, bloqueados: [] } };
  if (esAdmin(usuario) || !usuario || !usuario.id_perfil) return todo;
  const ok = await permitidosDe(usuario.id_perfil);
  const out = {};
  PANTALLAS.forEach(p => {
    out[p] = {
      acceso: ok[p].has(ACCESO),
      bloqueados: (CAMPOS[p] || []).map(c => c.campo).filter(c => !ok[p].has(c)),
    };
  });
  return out;
}

/* Deja fuera del cuerpo los campos que este usuario NO puede editar, para que un
   POST armado a mano no pase por encima del mantenedor. Devuelve los quitados. */
async function filtrarCuerpo(usuario, pantalla, body) {
  if (esAdmin(usuario) || !usuario || !usuario.id_perfil) return { body, quitados: [] };
  const ok = (await permitidosDe(usuario.id_perfil))[pantalla] || new Set();
  const quitados = [];
  const limpio = { ...body };
  (CAMPOS[pantalla] || []).forEach(({ campo }) => {
    if (!ok.has(campo) && Object.prototype.hasOwnProperty.call(limpio, campo)) { delete limpio[campo]; quitados.push(campo); }
  });
  return { body: limpio, quitados };
}

async function puedeAcceder(usuario, pantalla) {
  if (esAdmin(usuario) || !usuario || !usuario.id_perfil) return true;
  return (await permitidosDe(usuario.id_perfil))[pantalla].has(ACCESO);
}

module.exports = { CAMPOS, PANTALLAS, ACCESO, permisosDe, filtrarCuerpo, puedeAcceder, invalidarCache };
