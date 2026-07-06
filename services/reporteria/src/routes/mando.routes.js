'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/mando.controller');

router.get('/', verifyToken, ctrl.mando);
router.get('/config', verifyToken, ctrl.getConfig);
router.put('/config', verifyToken, requireFunc('mant_horarios_analistas'), ctrl.setConfig);

module.exports = router;
