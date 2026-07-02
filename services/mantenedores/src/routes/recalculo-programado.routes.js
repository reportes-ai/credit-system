'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/recalculo-programado.controller');

const F = 'mant_recalculo_prog';   // Admin (bypass) + quien tenga la funcionalidad
router.get('/',        verifyToken, requireFunc(F), ctrl.get);
router.put('/',        verifyToken, requireFunc(F), ctrl.set);
router.post('/run',    verifyToken, requireFunc(F), ctrl.runNow);

module.exports = router;
