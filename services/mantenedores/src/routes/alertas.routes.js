'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl       = require('../controllers/alertas.controller');

// Montado en /api/alertas-vencimiento (alertas de vencimiento de crédito).
// Separado del motor de campana en /api/alertas para no compartir prefijo.
router.get('/', verifyToken, ctrl.getVencimientos);

// Config paramétrica de los avisos del popup (mantenedor de Alertas)
router.get('/config', verifyToken, requireFunc('mantenedores_alertas'), ctrl.getVencConfig);
router.put('/config', verifyToken, requireFunc('mantenedores_alertas'), ctrl.setVencConfig);

module.exports = router;
