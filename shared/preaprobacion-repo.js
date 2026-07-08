'use strict';
/* ───────────────────────────────────────────────────────────────────
   Repositorio ÚNICO de preaprobaciones (tabla portal_preaprobaciones).

   Todos los canales (Portal del Dealer, WhatsApp/Facilito) guardan acá,
   con un correlativo PREaammxxx (aa=año, mm=mes, xxx=correlativo del mes)
   para buscar el caso en el repositorio. Se persiste TODO: checklist de
   cumplimiento de cada parámetro, informe IA, informes DealerNet usados
   y las condiciones ofrecidas al cliente.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

/* Correlativo PREaammxxx — único global, correlativo por mes */
async function nuevoCodigo(conn) {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }); // YYYY-MM-DD
  const pref = 'PRE' + hoy.slice(2, 4) + hoy.slice(5, 7);   // PREaamm
  const [[m]] = await (conn || pool).query(
    "SELECT MAX(CAST(SUBSTRING(codigo, 8) AS UNSIGNED)) mx FROM portal_preaprobaciones WHERE codigo LIKE CONCAT(?, '%')", [pref]);
  const n = (Number(m?.mx) || 0) + 1;
  return pref + String(n).padStart(3, '0');
}

/* Guarda una preaprobación completa y retorna { id, codigo }.
   Reintenta el correlativo si dos canales chocan en el mismo instante. */
async function guardarPreaprobacion(d) {
  for (let intento = 0; intento < 3; intento++) {
    const codigo = await nuevoCodigo();
    try {
      const [ins] = await pool.query(
        `INSERT INTO portal_preaprobaciones
           (codigo, canal, id_dealer, rut_dealer, dealer_nombre, rut_cliente, precio, pie, anio,
            resultado, motivos, opciones, renta, fuente_renta, checklist, ia_informe_id, ia_nivel_riesgo, informes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [codigo, d.canal || 'PORTAL', d.id_dealer ?? null, d.rut_dealer ?? null, d.dealer_nombre ?? null,
         d.rut_cliente, d.precio ?? null, d.pie ?? null, d.anio ?? null,
         d.resultado, d.motivos ?? null, JSON.stringify(d.opciones || []),
         d.renta ?? null, d.fuente_renta ?? null,
         JSON.stringify(d.checklist || []), d.ia_informe_id ?? null, d.ia_nivel_riesgo ?? null,
         JSON.stringify(d.informes || [])]);
      return { id: ins.insertId, codigo };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY' || intento === 2) throw e;
    }
  }
}

/* Asegura los informes DealerNet + el REPORTE IA para un RUT según las políticas.
   Regla de negocio: SIN INFORME IA NO HAY APROBACIÓN (aplica a todos los canales).
   Retorna { informes:[{codigo,nombre,id?,severidad,disponible}], peorSeveridad,
             ia_informe_id, ia_nivel_riesgo, error } */
async function informesEIA(rut, POL) {
  const out = { informes: [], peorSeveridad: null, ia_informe_id: null, ia_nivel_riesgo: null, error: null };
  try {
    let [prods] = await pool.query('SELECT codigo FROM dealernet_productos WHERE activo=1');
    if (POL.informes_codigos) {
      const set = new Set(POL.informes_codigos.split(',').map(s => s.trim()));
      const filtrados = prods.filter(p => set.has(String(p.codigo)));
      if (filtrados.length) prods = filtrados;
    }
    if (!prods.length) { out.error = 'Sin productos DealerNet activos'; return out; }
    const { asegurarInformes } = require('../services/clientes/src/controllers/dealernet-ws.controller');
    const r = await asegurarInformes({ rut, productos: prods.map(p => String(p.codigo)), usuario: null });
    out.informes = (r.items || []).map(i => ({ codigo: i.codigo, nombre: i.nombre, disponible: i.disponible,
      severidad: i.severidad, nota: i.nota, fecha: i.fecha }));
    const disp = out.informes.filter(i => i.disponible);
    if (!disp.length) { out.error = r.error || 'Sin informes DealerNet disponibles'; return out; }
    const SEV = ['bueno', 'regular', 'malo', 'grave'];
    out.peorSeveridad = SEV[disp.reduce((a, i) => Math.max(a, Math.max(0, SEV.indexOf(i.severidad))), 0)];

    // Reporte IA: reciente (≤15 días) o generado ahora. OBLIGATORIO para aprobar.
    const rutN = String(rut).replace(/[.\s]/g, '').split('-')[0];
    const [[prev]] = await pool.query(
      'SELECT id, nivel_riesgo FROM ia_informes_dealernet WHERE rut=? AND fecha >= DATE_SUB(NOW(), INTERVAL 15 DAY) ORDER BY id DESC LIMIT 1', [rutN]);
    if (prev) { out.ia_informe_id = prev.id; out.ia_nivel_riesgo = prev.nivel_riesgo || null; }
    else {
      const { analizarRut } = require('../services/ia/src/controllers/informe-dealernet.controller');
      const rep = await analizarRut({ rut, modelo: POL.ia_modelo !== 'auto' ? POL.ia_modelo : undefined });
      if (rep.ok) { out.ia_informe_id = rep.id; out.ia_nivel_riesgo = rep.nivel_riesgo || null; }
      else out.error = 'No se pudo generar el informe IA (' + (rep.motivo || 'error') + ')';
    }
  } catch (e) { out.error = e.message; }
  return out;
}

module.exports = { guardarPreaprobacion, informesEIA, nuevoCodigo };
