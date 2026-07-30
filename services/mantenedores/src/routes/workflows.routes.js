'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/workflows.controller');

router.use(verifyToken, requireFunc('workflows_mant'));
router.get('/', c.getAll);
router.get('/paso/:func', c.pasoGet);
router.put('/paso/:func', c.pasoSet);
router.get('/:codigo/estancados', c.estancadosDetalle);
router.get('/:codigo/log', c.logGet);
router.put('/:codigo', c.setUno);

module.exports = router;
