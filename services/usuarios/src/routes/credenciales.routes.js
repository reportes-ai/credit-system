'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/credenciales.controller');

router.get('/',    verifyToken, requireFunc('credenciales'), ctrl.listar);
router.get('/:id', verifyToken, requireFunc('credenciales'), ctrl.una);
router.put('/:id', verifyToken, requireFunc('credenciales'), ctrl.guardar);

module.exports = router;
