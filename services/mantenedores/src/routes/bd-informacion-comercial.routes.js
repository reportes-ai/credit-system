'use strict';
const router = require('express').Router();
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/bd-informacion-comercial.controller');
const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/columns', verifyToken, ctrl.getColumns);
router.get('/',        verifyToken, ctrl.getAll);
router.put('/:id',     verifyToken, soloAdmin, ctrl.update);

module.exports = router;
