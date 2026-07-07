'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/aplicacion-fondos.controller');

const puede   = requireFunc('aplic_fondos');           // crear / ver
const aprueba = requireFunc('aplic_fondos_aprobar');   // revisar / aprobar / procesar / anular

router.get('/catalogo',      verifyToken, puede,   c.catalogo);
router.get('/op/:num_op',    verifyToken, puede,   c.deudaOp);
router.get('/',              verifyToken, puede,   c.listar);
router.post('/',             verifyToken, puede,   c.crear);
router.get('/:id',           verifyToken, puede,   c.obtener);
router.put('/:id/avanzar',   verifyToken, aprueba, c.avanzar);
router.put('/:id/anular',    verifyToken, aprueba, c.anular);

module.exports = router;
