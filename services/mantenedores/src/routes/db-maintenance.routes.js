'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl       = require('../controllers/db-maintenance.controller');

router.get('/',          verifyToken, ctrl.getDiagnostico);
router.get('/historial', verifyToken, ctrl.getHistorial);
router.post('/run',      verifyToken, ctrl.ejecutarMantenimiento);

module.exports = router;
