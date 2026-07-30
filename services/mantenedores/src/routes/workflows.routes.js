'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/workflows.controller');

router.use(verifyToken, requireFunc('workflows_mant'));
router.get('/', c.getAll);
router.put('/:codigo', c.setUno);

module.exports = router;
