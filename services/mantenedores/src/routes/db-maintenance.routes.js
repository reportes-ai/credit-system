'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl       = require('../controllers/db-maintenance.controller');
const ctrlX      = require('../controllers/db-maintenance-extra');

router.get('/',                    verifyToken, ctrl.getDiagnostico);
router.get('/historial',           verifyToken, ctrl.getHistorial);
router.post('/run',                verifyToken, ctrl.ejecutarMantenimiento);
router.get('/indices',             verifyToken, ctrl.verificarIndices);
router.post('/indices/baseline',   verifyToken, ctrl.capturarBaseline);
router.post('/indices/restaurar',  verifyToken, ctrl.restaurarIndices);

// Módulos adicionales
router.get('/slow-queries',        verifyToken, ctrlX.getSlowQueries);
router.get('/crecimiento',         verifyToken, ctrlX.getCrecimiento);
router.get('/integridad',          verifyToken, ctrlX.getIntegridad);
router.get('/conexiones',          verifyToken, ctrlX.getConexiones);

module.exports = router;
