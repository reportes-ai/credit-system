'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/bd-clientes.controller');

router.get('/columns',           verifyToken, ctrl.getColumns);
router.get('/',                  verifyToken, ctrl.getAll);
router.get('/:id/operaciones',   verifyToken, ctrl.getOperaciones);
router.put('/:id',               verifyToken, ctrl.update);
router.delete('/',               verifyToken, ctrl.remove);  // body: { ids:[...] }

module.exports = router;
