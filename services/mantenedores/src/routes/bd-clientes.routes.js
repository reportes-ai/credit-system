'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/bd-clientes.controller');
const F = 'mantenedores_bd_clientes', GOD = 'mantenedores_solo_dios';

router.get('/columns',           verifyToken, requireFunc(F, GOD), ctrl.getColumns);
router.get('/',                  verifyToken, requireFunc(F, GOD), ctrl.getAll);
router.get('/:id/operaciones',   verifyToken, requireFunc(F, GOD), ctrl.getOperaciones);
router.put('/:id',               verifyToken, requireFunc(F, GOD), ctrl.update);   // analista: modificar
router.delete('/',               verifyToken, requireFunc(GOD), ctrl.remove);      // eliminar: solo nivel Dios

module.exports = router;
