'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/score-mora.controller');

router.get('/config',    verifyToken, requireFunc('score_mora'), ctrl.getConfigHttp);
router.put('/config',    verifyToken, requireFunc('score_mora'), ctrl.setConfig);
router.get('/segmentos', verifyToken, requireFunc('score_mora'), ctrl.segmentos);
router.get('/evaluar',   verifyToken, ctrl.evaluar);   // consumible por evaluación/preaprobación

module.exports = router;
