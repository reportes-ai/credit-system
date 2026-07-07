'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/judicial.controller');

const mant = requireFunc('cobranza_judicial_mant');

router.get('/catalogos',      verifyToken, mant, c.getCatalogos);
router.post('/catalogos',     verifyToken, mant, c.crearCatalogo);
router.put('/catalogos/:id',  verifyToken, mant, c.updateCatalogo);
router.get('/expediente/:id_credito', verifyToken, c.expediente);   // ficha CRM cobranza (read-only)
router.get('/',               verifyToken, mant, c.listar);
router.put('/:id',            verifyToken, mant, c.actualizar);

module.exports = router;
