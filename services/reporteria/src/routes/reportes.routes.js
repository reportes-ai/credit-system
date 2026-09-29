'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/reportes.controller');

router.get('/cartera',           verifyToken, c.cartera);
router.get('/cobranza-mora',     verifyToken, c.cobranzaMora);
router.get('/cluster-comercial', verifyToken, c.clusterComercial);
// Respaldos de excepción de Rentabilidad Créditos (mismo permiso que la página)
router.get('/rentabilidad/respaldos',          verifyToken, requireFunc('aprob_rentabilidad'), c.respaldosListar);
router.post('/rentabilidad/respaldo',          verifyToken, requireFunc('aprob_rentabilidad'), c.respaldoSubir);
router.get('/rentabilidad/respaldo/:id/ver',   verifyToken, requireFunc('aprob_rentabilidad'), c.respaldoVer);
router.delete('/rentabilidad/respaldo/:id',    verifyToken, requireFunc('aprob_rentabilidad'), c.respaldoBorrar);

module.exports = router;
