'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/bd-antecedentes.controller');
const F = 'mant_bd_antecedentes', GOD = 'mantenedores_solo_dios';

router.get('/columns', verifyToken, requireFunc(F, GOD), ctrl.getColumns);
router.get('/',        verifyToken, requireFunc(F, GOD), ctrl.getAll);
router.put('/:id',     verifyToken, requireFunc(F, GOD), ctrl.update);   // analista: modificar

module.exports = router;
