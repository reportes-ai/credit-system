'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/actividades-economicas.controller');

router.get('/',           verifyToken, c.getAll);
router.post('/',          verifyToken, requireFunc('mantenedores_actividades_economicas'), c.crear);
router.put('/:codigo',    verifyToken, requireFunc('mantenedores_actividades_economicas'), c.update);
router.delete('/:codigo', verifyToken, requireFunc('mantenedores_actividades_economicas'), c.remove);

module.exports = router;
