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
router.put('/admin/pedidos/:id/items/:itemId',    verifyToken, admin, c.adminItemEditar);
router.delete('/admin/pedidos/:id/items/:itemId', verifyToken, admin, c.adminItemEliminar);
router.post('/admin/consolidar',        verifyToken, admin, c.consolidar);
router.get('/admin/ordenes',            verifyToken, admin, c.adminOrdenes);
router.get('/admin/ordenes/:id',        verifyToken, admin, c.adminOrdenDetalle);
router.put('/admin/ordenes/:id/estado', verifyToken, admin, c.adminOrdenEstado);
router.post('/admin/ordenes/:id/decidir',      verifyToken, admin, c.adminOrdenDecidir);
router.get('/admin/aprobacion-niveles',        verifyToken, admin, c.nivelesGet);
router.put('/admin/aprobacion-niveles/:nivel', verifyToken, requireFunc('compras_mant'), c.nivelesSet);
router.get('/admin/reporte',            verifyToken, admin, c.reporteMensual);

// ── Bandeja de Revisión de Órdenes (el firmante) — la guardia real es ser
//    firmante del nivel (puedeFirmarNivel), no un permiso de admin ──
router.get('/revision',              verifyToken, c.revisionBandeja);
router.get('/revision/:id',          verifyToken, c.revisionDetalle);
router.post('/revision/:id/decidir', verifyToken, c.adminOrdenDecidir);

// ── OTRAS COMPRAS (ODC): proveedores + workflow supervisor → Finanzas ──
const odc = require('../controllers/otras-compras.controller');
const puedeODC = requireFunc('otras_compras', 'compras');
router.get('/otras/datos',            verifyToken, puedeODC, odc.getDatos);
router.get('/otras',                  verifyToken, puedeODC, odc.listar);
router.post('/otras',                 verifyToken, puedeODC, odc.crear);
router.post('/otras/:id/resolver',    verifyToken, puedeODC, odc.resolver);
router.post('/otras/:id/adjunto',     verifyToken, puedeODC, odc.adjuntar);
router.post('/otras/:id/reenviar',    verifyToken, puedeODC, odc.reenviar);
router.get('/otras/:id/documento',    verifyToken, puedeODC, odc.documento);

module.exports = router;

