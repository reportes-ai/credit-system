'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/diseno-consulta.controller');

const puede = requireFunc('reporteria_diseno');

router.get('/tablas',        verifyToken, puede, c.tablas);
router.post('/ejecutar',     verifyToken, puede, c.ejecutar);
router.post('/sql',          verifyToken, puede, c.sqlPreview);
router.get('/guardadas',     verifyToken, puede, c.listar);
router.get('/guardadas/:id', verifyToken, puede, c.obtener);
router.post('/guardadas',    verifyToken, puede, c.guardar);
router.delete('/guardadas/:id', verifyToken, puede, c.eliminar);

module.exports = router;
