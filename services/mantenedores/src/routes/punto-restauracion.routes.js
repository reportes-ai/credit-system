'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/punto-restauracion.controller');

// Nivel Dios: borra datos de operaciones — solo Admin (mantenedores_solo_dios)
router.get('/',           verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.estado);
router.post('/crear',     verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.crear);
router.post('/restaurar', verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.restaurar);

module.exports = router;
