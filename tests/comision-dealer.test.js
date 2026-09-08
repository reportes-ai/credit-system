'use strict';
/* Motor único de comisión dealer (api-gateway/public/js/comision-dealer.js) —
   sin BD. Cubre la precedencia "la carta manda solo hacia abajo" (08-09-2026). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { comisionDealer, comisionDealerEfectiva } = require('../api-gateway/public/js/comision-dealer');

const pizarra = { dealer_pct_6: 0, dealer_pct_12: 0, dealer_pct_24: 2.5, dealer_pct_36: 5, dealer_pct_99: 7.5,
  dealer_calle_pct_6: 2.5, dealer_calle_pct_12: 2.5, dealer_calle_pct_24: 5, dealer_calle_pct_36: 7.5, dealer_calle_pct_99: 10, patio_pct: 2.5 };

test('pizarra parque: plazo 48 paga 7,5% del saldo', () => {
  const r = comisionDealer({ saldo: 6280000, plazo: 48, esParque: true, ubicacion: 'PARQUE AUTOMALL' },
    { dealerTabla: null, dealerUbicaciones: null, parqData: { comision_pct: 0.03, arriendo: 0 }, pizarra });
  assert.equal(r.comdea_real, 471000);
  assert.equal(r.com_parque, 188400);
});

test('tabla por local manda sobre la pizarra', () => {
  const r = comisionDealer({ saldo: 17000000, plazo: 48, esParque: true, ubicacion: 'PARQUE AUTOCENTER QUILICURA' },
    { dealerTabla: null, dealerUbicaciones: [{ ubicacion: 'PARQUE AUTOCENTER QUILICURA', com_6_12: 2.5, com_13_24: 5, com_25_36: 7.5, com_37: 10 }], parqData: null, pizarra });
  assert.equal(r.comdea_real, 1700000);
});

test('carta manda solo hacia abajo', () => {
  assert.equal(comisionDealerEfectiva({ calculada: 1700000, carta: 1300000 }), 1300000, 'carta menor → se mantiene');
  assert.equal(comisionDealerEfectiva({ calculada: 471000, carta: 471000 }), 471000, 'igual → cálculo');
  assert.equal(comisionDealerEfectiva({ calculada: 400000, carta: 471000 }), 400000, 'carta mayor → rige el cálculo');
  assert.equal(comisionDealerEfectiva({ calculada: 0, carta: 299250 }), 299250, 'sin cálculo → carta');
  assert.equal(comisionDealerEfectiva({ calculada: 350000, carta: null }), 350000, 'sin carta → cálculo');
  assert.equal(comisionDealerEfectiva({ calculada: '350000', carta: '0' }), 350000, 'strings y cero');
});
