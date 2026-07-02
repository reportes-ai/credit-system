'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc }  = require('../../../../shared/middleware/permisos');
const ctrl       = require('../controllers/db-maintenance.controller');
const ctrlX      = require('../controllers/db-maintenance-extra');
// Nivel Dios: matriz de permisos (Admin bypass incluido) — reemplaza requirePerfil deprecado
const soloAdmin  = requireFunc('mantenedores_solo_dios');

router.get('/',                    verifyToken, soloAdmin, ctrl.getDiagnostico);
router.get('/historial',           verifyToken, soloAdmin, ctrl.getHistorial);
router.post('/run',                verifyToken, soloAdmin, ctrl.ejecutarMantenimiento);
router.get('/indices',             verifyToken, soloAdmin, ctrl.verificarIndices);
router.post('/indices/baseline',   verifyToken, soloAdmin, ctrl.capturarBaseline);
router.post('/indices/restaurar',  verifyToken, soloAdmin, ctrl.restaurarIndices);

// Módulos adicionales
router.get('/slow-queries',        verifyToken, soloAdmin, ctrlX.getSlowQueries);
router.get('/crecimiento',         verifyToken, soloAdmin, ctrlX.getCrecimiento);
router.get('/integridad',          verifyToken, soloAdmin, ctrlX.getIntegridad);
router.get('/conexiones',          verifyToken, soloAdmin, ctrlX.getConexiones);

module.exports = router;
