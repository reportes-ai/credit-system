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
router.get('/cartolas-enviadas',         verifyToken, cartola, c.cartolasEnviadas);
router.delete('/cartolas-enviadas/:id',  verifyToken, requireFunc('pv_parques_aprobar'), c.cartolaReversarEnvio);

// Reversas (con motivo, auditadas)
router.post('/anular-odp',    verifyToken, requireFunc('pv_parques_emitir'), c.anularODP);
router.post('/revertir-pago', verifyToken, requireFunc('pv_parques_pagar'),  c.revertirPago);

module.exports = router;
