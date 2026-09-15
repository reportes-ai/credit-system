'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/comisiones-parques.controller');

const ver = requireFunc('postventa_comisiones_parques');

router.get('/',         verifyToken, ver, c.listar);
router.get('/detalle',  verifyToken, ver, c.detalle);
router.post('/aprobar', verifyToken, requireFunc('pv_parques_aprobar'), c.aprobar);
router.post('/emitir',  verifyToken, requireFunc('pv_parques_emitir'),  c.emitir);
router.post('/pagar',   verifyToken, requireFunc('pv_parques_pagar'),   c.pagar);

// Cartolas Parque (módulo Emisión de Cartolas Parque)
const cartola = requireFunc('postventa_cartolas_parque');
router.get('/cartola-estado',            verifyToken, cartola, c.cartolaEstado);
router.post('/cartola/emitir',           verifyToken, cartola, c.cartolaEmitir);
router.post('/cartola/aprobar',          verifyToken, requireFunc('pv_parques_aprobar'), c.cartolaAprobar);
router.post('/cartola/enviar',           verifyToken, cartola, c.cartolaEnviar);
router.post('/cartola/factura',          verifyToken, cartola, c.facturaRegistrar);
router.get('/cartolas-enviadas',         verifyToken, cartola, c.cartolasEnviadas);
router.delete('/cartolas-enviadas/:id',  verifyToken, requireFunc('pv_parques_aprobar'), c.cartolaReversarEnvio);

// Reversas (con motivo, auditadas)
// Comisiones Parques a Pagar — espejo de Comisiones Dealer a Pagar (15-09-2026)
router.get ('/atribuciones',            verifyToken, c.getAtribucionesParques);
router.get ('/a-pagar',                 verifyToken, ver, c.aPagar);
router.get ('/a-pagar/fondos',          verifyToken, ver, c.getFondosParques);
router.put ('/a-pagar/fondos',          verifyToken, requireFunc('pv_parques_fondos_definir'), c.setFondosParques);
router.post('/a-pagar/enviar-a-pago',   verifyToken, requireFunc('pv_parques_seleccionar'),    c.enviarAPagoParques);
router.post('/a-pagar/pagar',           verifyToken, requireFunc('pv_parques_pagar'),          c.pagarParques);
router.post('/a-pagar/desmarcar',       verifyToken, requireFunc('pv_parques_revertir'),       c.desmarcarParques);
router.post('/anular-odp',    verifyToken, requireFunc('pv_parques_emitir'), c.anularODP);
router.post('/revertir-pago', verifyToken, requireFunc('pv_parques_pagar'),  c.revertirPago);

module.exports = router;
