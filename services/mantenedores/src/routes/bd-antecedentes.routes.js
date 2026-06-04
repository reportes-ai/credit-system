'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/bd-antecedentes.controller');

router.get('/columns', verifyToken, ctrl.getColumns);
router.get('/',        verifyToken, ctrl.getAll);
router.put('/:id',     verifyToken, ctrl.update);

module.exports = router;
