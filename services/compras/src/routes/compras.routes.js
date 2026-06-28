'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/compras.controller');

// Mantenedor de Compras (configuración) — requiere compras_mant
const mant = requireFunc('compras_mant');

// Catálogo (lo lee el mantenedor para curar por perfil)
router.get('/catalogo',          verifyToken, mant, c.catalogo);
router.get('/catalogo-ids',      verifyToken, mant, c.catalogoIds);
router.get('/categorias',        verifyToken, mant, c.categorias);
router.post('/sincronizar',      verifyToken, mant, c.sincronizar);

// Curaduría por perfil
router.get('/perfiles',          verifyToken, mant, c.perfiles);
router.get('/articulo-perfil',   verifyToken, mant, c.articuloPerfilGet);
router.post('/articulo-perfil',  verifyToken, mant, c.articuloPerfilSet);

// Direcciones de despacho (oficinas)
router.get('/direcciones',       verifyToken, mant, c.direccionesList);
router.post('/direcciones',      verifyToken, mant, c.direccionCrear);
router.put('/direcciones/:id',   verifyToken, mant, c.direccionEditar);
router.delete('/direcciones/:id',verifyToken, mant, c.direccionEliminar);

// Config por usuario (dirección + centro de costo)
router.get('/usuarios-config',   verifyToken, mant, c.usuariosConfig);
router.put('/usuarios-config/:id', verifyToken, mant, c.usuarioConfigSet);

// ── Página del usuario (Compras) — cualquiera con permiso de compras ──
const usar = requireFunc('compras', 'compras_admin', 'compras_mant');
router.get('/articulos',      verifyToken, usar, c.misArticulos);
router.get('/mis-categorias', verifyToken, usar, c.misCategorias);
router.get('/mi-config',      verifyToken, usar, c.miConfig);
router.post('/pedidos',       verifyToken, usar, c.crearPedido);
router.get('/mis-pedidos',    verifyToken, usar, c.misPedidos);

// ── Administración / consolidación de pedidos ──
const admin = requireFunc('compras_admin');
router.get('/admin/pedidos',            verifyToken, admin, c.adminPedidos);
router.post('/admin/consolidar',        verifyToken, admin, c.consolidar);
router.get('/admin/ordenes',            verifyToken, admin, c.adminOrdenes);
router.get('/admin/ordenes/:id',        verifyToken, admin, c.adminOrdenDetalle);
router.put('/admin/ordenes/:id/estado', verifyToken, admin, c.adminOrdenEstado);
router.get('/admin/reporte',            verifyToken, admin, c.reporteMensual);

module.exports = router;
