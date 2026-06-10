'use strict';
const router = require('express').Router();
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/bd-clientes.controller');
const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/columns',           verifyToken, ctrl.getColumns);
router.get('/',                  verifyToken, ctrl.getAll);
router.get('/:id/operaciones',   verifyToken, ctrl.getOperaciones);
router.put('/:id',               verifyToken, soloAdmin, ctrl.update);
router.delete('/',               verifyToken, soloAdmin, ctrl.remove);  // body: { ids:[...] }

module.exports = router;
