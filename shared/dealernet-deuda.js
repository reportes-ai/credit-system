'use strict';
/**
 * Motor único — deuda CMF que trae DealerNet (producto 16 "Comportamiento Vigente").
 *
 * POR QUÉ EXISTE: DealerNet entrega ese informe en **miles de pesos (M$)**, tal como
 * lo publica la CMF. El visor lo rotula "Historial de Documentos M$" y el usuario lo
 * lee bien, pero cualquier consumidor que tome el número crudo reporta $789 donde hay
 * $789.000. Aquí vive la conversión, una sola vez, para todos los consumidores.
 *
 * Máxima 1 (un solo motor por cálculo): si mañana DealerNet cambia la unidad, se
 * corrige acá y no en cada controlador.
 */

const gp = (o, ...ks) => { for (const k of ks) { if (o == null) return undefined; o = o[k]; } return o; };
const asArr = x => x == null ? [] : (Array.isArray(x) ? x : [x]);

/* Campos del bloque r16032 que son MONTOS (van en M$ → ×1000).
   Los que cuentan entidades (nro_*) NO se convierten: son cantidades, no plata. */
const CAMPOS_MONTO = [
  'deuda_direc_vig', 'deuda_morosa', 'deuda_venci_direc', 'deuda_dir_venc_180d_3anos',
  'deuda_cast_directa', 'deuda_cred_consumo', 'deuda_cred_hipoteca', 'deuda_ope_c_pacto',
  'deuda_inv_finan', 'deuda_comercial', 'mto_deuda_com_vig_mdaext', 'mto_deuda_com_venci_mdaext',
  'deuda_indirec_vig', 'deuda_indirec_venci', 'deuda_cast_indirecta', 'linea_cred_disponible',
  'deuda_cred_contingentes', 'deuda_leasing', 'deuda_morosa_leasing',
];

const enPesos = v => { const x = Number(v); return isNaN(x) ? 0 : Math.round(x * 1000); };

/* Ficha de deuda del período más reciente, ya en PESOS. null si el informe no la trae. */
function extraerDeuda(contenido) {
  const cab = gp(contenido, 'r1603', 'r16031') || {};
  const per = asArr(gp(contenido, 'r1603', 'r16032'))[0];
  if (!per && cab['@_anomes'] == null) return null;
  const p = per || {};
  return {
    deuda_vigente_total: enPesos(p['@_deuda_direc_vig']),
    deuda_vigente_inst:  (Number(p['@_nro_acree_cred_consumo']) || 0) + (Number(p['@_nro_inst_cred_com']) || 0),
    deuda_hipotecaria:   enPesos(p['@_deuda_cred_hipoteca']),
    deuda_comercial:     enPesos(p['@_deuda_comercial']),
    deuda_comercial_inst: Number(p['@_nro_inst_cred_com']) || 0,
    deuda_consumo:       enPesos(p['@_deuda_cred_consumo']),
    deuda_consumo_inst:  Number(p['@_nro_acree_cred_consumo']) || 0,
    deuda_morosa:        enPesos(p['@_deuda_morosa']),
    deuda_vencida:       enPesos(p['@_deuda_venci_direc']),
    deuda_castigada:     enPesos(p['@_deuda_cast_directa']),
    linea_disponible:    enPesos(p['@_linea_cred_disponible']),
    anomes:              cab['@_anomes'] || p['@_ano_y_mes_deuda'] || null,
  };
}

/* Copia del informe con TODOS los montos del cód. 16 pasados a pesos, para
   entregárselo a un consumidor que lee el JSON completo (ej. el prompt de la IA).
   Devuelve el mismo objeto si no es un informe de deuda. */
function aPesos(contenido) {
  const r = gp(contenido, 'r1603');
  if (!r) return contenido;
  const c = JSON.parse(JSON.stringify(contenido));
  const rr = c.r1603;
  if (rr.r16031 && rr.r16031['@_deuda_total'] != null) rr.r16031['@_deuda_total'] = String(enPesos(rr.r16031['@_deuda_total']));
  const per = rr.r16032;
  const lista = per == null ? [] : (Array.isArray(per) ? per : [per]);
  for (const p of lista) {
    for (const k of CAMPOS_MONTO) { const key = '@_' + k; if (p[key] != null) p[key] = String(enPesos(p[key])); }
  }
  return c;
}

module.exports = { extraerDeuda, aPesos, CAMPOS_MONTO };
