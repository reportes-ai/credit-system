'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const C = require('../controllers/dealernet-ws.controller');

/* ── Mantenedor de productos ─────────────────────────────────────────────── */
router.get('/productos',        verifyToken, requireFunc('mant_dealernet_productos'), C.getProductos);
router.post('/productos',       verifyToken, requireFunc('mant_dealernet_productos'), C.addProducto);
router.put('/productos/orden',  verifyToken, requireFunc('mant_dealernet_productos'), C.reordenarProductos);
router.put('/productos/:id',    verifyToken, requireFunc('mant_dealernet_productos'), C.updateProducto);
router.delete('/productos/:id', verifyToken, requireFunc('mant_dealernet_productos'), C.deleteProducto);

/* ── Consulta a la Central de Información ─────────────────────────────────── */
router.get('/estado',     verifyToken, requireFunc('mant_dealernet_productos'), C.estado);
router.post('/consultar', verifyToken, requireFunc('dealernet_consultar'), C.consultar);
router.get('/consultas',  verifyToken, requireFunc('mant_dealernet_productos'), C.listConsultas);

/* ── Umbrales paramétricos (mantenedor) ──────────────────────────────────── */
router.get('/config', verifyToken, requireFunc('mant_dealernet_productos'), C.getConfigEndpoint);
router.put('/config', verifyToken, requireFunc('mant_dealernet_productos'), C.updateConfigEndpoint);

/* ── Informes DealerNet: repositorio compartido ──────────────────────────── */
// Ver repositorio = gratis (dealernet_informes_ver). Solicitar = gasta saldo (dealernet_consultar).
router.post('/informes/verificar', verifyToken, requireFunc('dealernet_informes_ver'), C.verificarRepositorio);
router.post('/informes/solicitar', verifyToken, requireFunc('dealernet_consultar'),    C.solicitarInformes);
router.get('/informes/productos',  verifyToken, requireFunc('dealernet_informes_ver'), C.productosActivos);
router.get('/informes',            verifyToken, requireFunc('dealernet_informes_ver'), C.historicos);
router.get('/informes/:id(\\d+)',     verifyToken, requireFunc('dealernet_informes_ver'), C.verInforme);
router.get('/informes/:id(\\d+)/pdf', verifyToken, requireFunc('dealernet_informes_ver'), C.descargarPdf);

module.exports = router;
