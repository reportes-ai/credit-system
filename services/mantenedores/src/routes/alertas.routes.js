'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl       = require('../controllers/alertas.controller');

router.get('/vencimientos', verifyToken, ctrl.getVencimientos);

// Config paramétrica de los avisos del popup (mantenedor de Alertas)
router.get('/venc-config', verifyToken, requireFunc('mantenedores_alertas'), ctrl.getVencConfig);
router.put('/venc-config', verifyToken, requireFunc('mantenedores_alertas'), ctrl.setVencConfig);

module.exports = router;
