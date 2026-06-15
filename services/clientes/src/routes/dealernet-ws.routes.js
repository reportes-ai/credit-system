'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const C = require('../controllers/dealernet-ws.controller');

/* ── Mantenedor de productos ─────────────────────────────────────────────── */
router.get('/productos',        verifyToken, requireFunc('mant_dealernet_productos'), C.getProductos);
router.post('/productos',       verifyToken, requireFunc('mant_dealernet_productos'), C.addProducto);
router.put('/productos/:id',    verifyToken, requireFunc('mant_dealernet_productos'), C.updateProducto);
router.delete('/productos/:id', verifyToken, requireFunc('mant_dealernet_productos'), C.deleteProducto);

/* ── Consulta a la Central de Información ─────────────────────────────────── */
router.post('/consultar', verifyToken, requireFunc('dealernet_consultar'), C.consultar);
router.get('/consultas',  verifyToken, requireFunc('mant_dealernet_productos'), C.listConsultas);

module.exports = router;
