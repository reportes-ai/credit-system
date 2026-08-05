'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/ordenes-pago.controller');

/* Auditoría 05-08-2026 (A-3): las lecturas estaban solo con verifyToken
   mientras las escrituras sí exigían permiso. Pero LEER acá también expone:
   `proveedores` trae banco y número de cuenta, y el documento de la orden trae
   el destino de pago completo — el insumo exacto del fraude por cambio de datos
   bancarios. Se acepta cualquiera de los tres permisos del módulo. */
const puedeVer = requireFunc('ordenes_pago_ver', 'ordenes_pago_emitir', 'ordenes_pago_proveedores');

// Proveedores
router.get('/proveedores',        verifyToken, puedeVer, c.listarProveedores);
router.post('/proveedores',       verifyToken, requireFunc('ordenes_pago_proveedores'), c.crearProveedor);
router.put('/proveedores/:id',    verifyToken, requireFunc('ordenes_pago_proveedores'), c.actualizarProveedor);
router.delete('/proveedores/:id', verifyToken, requireFunc('ordenes_pago_proveedores'), c.eliminarProveedor);

// Órdenes de pago
router.get('/ordenes',            verifyToken, puedeVer, c.listarOrdenes);
router.get('/ordenes/:id/documento', verifyToken, puedeVer, c.getDocumento);   // :id = op_correlativos.id (cualquier origen)
router.get('/ordenes/:id',        verifyToken, puedeVer, c.getOrden);
router.post('/ordenes',           verifyToken, requireFunc('ordenes_pago_emitir'), c.crearOrden);
router.put('/ordenes/:id/estado', verifyToken, requireFunc('ordenes_pago_emitir'), c.cambiarEstadoOrden);
router.post('/ordenes/:id/enviar-correo', verifyToken, requireFunc('ordenes_pago_emitir'), c.enviarCorreoOrden);
router.post('/ordenes/:id/pagar',         verifyToken, c.pagarOrden);   // gate real = Caja Activa (en el controller)
// Anular una orden de POST VENTA (Saldo Precio / Comisión). El gate real es
// Administrador + motivo, validado en el controller; `requireFunc` deja fuera
// a quien ni siquiera puede emitir.
router.put('/ordenes/:id/anular-postventa', verifyToken, requireFunc('ordenes_pago_emitir'), c.anularOrdenPostventa);
router.get('/mi-caja',                    verifyToken, c.miCajaOP);

// Estadísticas
router.get('/estadisticas',       verifyToken, c.estadisticas);

module.exports = router;
