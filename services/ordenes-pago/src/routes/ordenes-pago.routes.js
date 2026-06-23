'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/ordenes-pago.controller');

// Proveedores
router.get('/proveedores',        verifyToken, c.listarProveedores);
router.post('/proveedores',       verifyToken, requireFunc('ordenes_pago_proveedores'), c.crearProveedor);
router.put('/proveedores/:id',    verifyToken, requireFunc('ordenes_pago_proveedores'), c.actualizarProveedor);
router.delete('/proveedores/:id', verifyToken, requireFunc('ordenes_pago_proveedores'), c.eliminarProveedor);

// Órdenes de pago
router.get('/ordenes',            verifyToken, c.listarOrdenes);
router.get('/ordenes/:id',        verifyToken, c.getOrden);
router.post('/ordenes',           verifyToken, requireFunc('ordenes_pago_emitir'), c.crearOrden);
router.put('/ordenes/:id/estado', verifyToken, requireFunc('ordenes_pago_emitir'), c.cambiarEstadoOrden);
router.post('/ordenes/:id/enviar-correo', verifyToken, requireFunc('ordenes_pago_emitir'), c.enviarCorreoOrden);
router.post('/ordenes/:id/pagar',         verifyToken, c.pagarOrden);   // gate real = Caja Activa (en el controller)
router.get('/mi-caja',                    verifyToken, c.miCajaOP);

// Estadísticas
router.get('/estadisticas',       verifyToken, c.estadisticas);

module.exports = router;
