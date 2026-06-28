'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/visitas.controller');

const verVisitas = requireFunc('visitas_dealers', 'visitas_supervisar');
const gestionar  = requireFunc('visitas_dealers', 'visitas_supervisar');

router.get('/config',          verifyToken, verVisitas, c.getConfig);
router.put('/config',          verifyToken, requireFunc('visitas_supervisar'), c.putConfig);
router.get('/dealers',         verifyToken, verVisitas, c.getDealers);
router.get('/planificador',    verifyToken, verVisitas, c.planificador);
router.get('/',                verifyToken, verVisitas, c.listar);
router.post('/',               verifyToken, gestionar,  c.crear);
router.put('/:id/gestion',     verifyToken, gestionar,  c.gestionar);
router.delete('/:id',          verifyToken, gestionar,  c.eliminar);

module.exports = router;
