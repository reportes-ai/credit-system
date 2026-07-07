'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/bd-tabla.controller');
const GOD = 'mantenedores_solo_dios';

router.get('/catalogo',        verifyToken, requireFunc(GOD), ctrl.catalogo);
router.get('/:tabla/columns',  verifyToken, requireFunc(GOD), ctrl.getColumns);
router.get('/:tabla',          verifyToken, requireFunc(GOD), ctrl.getAll);
router.put('/:tabla/:id',      verifyToken, requireFunc(GOD), ctrl.update);
router.delete('/:tabla',       verifyToken, requireFunc(GOD), ctrl.deleteMany);

module.exports = router;
