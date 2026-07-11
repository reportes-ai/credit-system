'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/facturacion-af.controller');

router.get('/resumen',  verifyToken, requireFunc('postventa_facturacion_af'), ctrl.resumen);
router.get('/detalle',  verifyToken, requireFunc('postventa_facturacion_af'), ctrl.detalle);
router.post('/check',   verifyToken, requireFunc('postventa_facturacion_af'), ctrl.check);
router.put('/uac',      verifyToken, requireFunc('postventa_facturacion_af'), ctrl.uacSet);

module.exports = router;
