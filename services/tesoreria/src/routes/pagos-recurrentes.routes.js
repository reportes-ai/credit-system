'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/pagos-recurrentes.controller');

const puede = requireFunc('pagos_recurrentes');

router.get('/catalogo',        verifyToken, puede, c.catalogo);
router.get('/previa',          verifyToken, puede, c.previa);
router.get('/',                verifyToken, puede, c.listar);
router.post('/',               verifyToken, puede, c.crear);
router.put('/:id',             verifyToken, puede, c.editar);
router.put('/:id/activo',      verifyToken, puede, c.activar);
router.delete('/:id',          verifyToken, puede, c.eliminar);
router.get('/:id/log',         verifyToken, puede, c.log);
router.post('/:id/generar',    verifyToken, puede, c.generarAhora);

module.exports = router;
