'use strict';
/* Motor: shared/dealernet-deuda.js — la deuda CMF que trae DealerNet viene en MILES.
   Este test cubre el incidente del 12-08-2026: el Reporte IA de un dealer informó
   "deuda vigente CLP 789 con línea disponible CLP 1.700" porque el JSON crudo del
   producto 16 se le pasaba al modelo sin convertir. Eran $789.000 y $1.700.000. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extraerDeuda, aPesos } = require('../shared/dealernet-deuda');

/* Informe real (RUT 20433976-7, junio 2026), recortado a lo que importa. */
const INFORME = () => ({
  '@_cod': '16',
  r1603: {
    r16031: { '@_anomes': '202606', '@_deuda_total': '789' },
    r16032: [{
      '@_ano_y_mes_deuda': '202606',
      '@_deuda_cred_consumo': '789', '@_deuda_direc_vig': '789',
      '@_deuda_morosa': '0', '@_deuda_cast_directa': '0', '@_deuda_venci_direc': '0',
      '@_deuda_cred_hipoteca': '0', '@_deuda_comercial': '0',
      '@_linea_cred_disponible': '1700',
      '@_nro_acree_cred_consumo': '1', '@_nro_inst_cred_com': '0',
    }],
  },
});

test('los montos van en miles: 789 son $789.000, no $789', () => {
  const d = extraerDeuda(INFORME());
  assert.equal(d.deuda_vigente_total, 789000);
  assert.equal(d.deuda_consumo, 789000);
  assert.equal(d.linea_disponible, 1700000);
});

test('los contadores de entidades NO son plata y no se multiplican', () => {
  const d = extraerDeuda(INFORME());
  assert.equal(d.deuda_consumo_inst, 1);          // una institución, no mil
  assert.equal(d.deuda_comercial_inst, 0);
  assert.equal(d.deuda_vigente_inst, 1);
});

test('aPesos convierte el JSON completo que ve la IA', () => {
  const p = aPesos(INFORME());
  assert.equal(p.r1603.r16031['@_deuda_total'], '789000');
  assert.equal(p.r1603.r16032[0]['@_deuda_cred_consumo'], '789000');
  assert.equal(p.r1603.r16032[0]['@_linea_cred_disponible'], '1700000');
  assert.equal(p.r1603.r16032[0]['@_nro_acree_cred_consumo'], '1');  // contador intacto
});

test('aPesos no muta el informe original (se sigue guardando crudo)', () => {
  const orig = INFORME();
  aPesos(orig);
  assert.equal(orig.r1603.r16032[0]['@_deuda_cred_consumo'], '789');
});

test('un informe que no es de deuda pasa sin tocarse', () => {
  const otro = { '@_cod': '2101', REGCIVRNDPAHTTP: { d: { '@_inddeu': 'Sin deuda' } } };
  assert.equal(aPesos(otro), otro);
  assert.equal(extraerDeuda(otro), null);
});

test('un período único (no array) también se convierte', () => {
  const inf = INFORME();
  inf.r1603.r16032 = inf.r1603.r16032[0];
  assert.equal(extraerDeuda(inf).deuda_vigente_total, 789000);
  assert.equal(aPesos(inf).r1603.r16032['@_deuda_cred_consumo'], '789000');
});
