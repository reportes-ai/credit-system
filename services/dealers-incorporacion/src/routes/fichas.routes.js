'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/fichas.controller');

// Nombres elegibles para el campo "Ejecutivo" (Ejecutivo/Jefe Comercial, Analista de Operaciones).
router.get('/ejecutivos',        verifyToken, requireFunc('dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.ejecutivos);

// Comisiones pactadas por defecto (derivadas de la pizarra Parque/Calle).
router.get('/com-default',       verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.comisionesDefault);

// ¿El dealer ya existe? (para Creación vs Modificación de Dealer).
router.get('/dealer-buscar',     verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.dealerBuscar);

// Lectura: cualquiera con acceso al módulo (el controller filtra por rol).
router.get('/fichas',            verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.listar);
router.get('/fichas/:id',        verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.obtener);
router.get('/fichas/:id/archivo', verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.verFicha);

// Informes comerciales (empresa/socios) — listar/ver con acceso de lectura; subir/borrar solo el creador.
router.get('/fichas/:id/archivos',              verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.listarArchivos);
router.get('/fichas/:id/archivos/:archivoId',   verifyToken, requireFunc('dealer_inc_ver', 'dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.verArchivo);
router.post('/fichas/:id/archivos',             verifyToken, requireFunc('dealer_ficha_crear'), ctrl.subirArchivo);
router.delete('/fichas/:id/archivos/:archivoId', verifyToken, requireFunc('dealer_ficha_crear'), ctrl.eliminarArchivo);

// Ejecutivo Comercial: crear, editar, enviar a autorización, subir ficha firmada (post-autorización), eliminar borrador.
router.post('/fichas',            verifyToken, requireFunc('dealer_ficha_crear'), ctrl.crear);
router.put('/fichas/:id',         verifyToken, requireFunc('dealer_ficha_crear'), ctrl.editar);
router.post('/fichas/:id/archivo', verifyToken, requireFunc('dealer_ficha_crear'), ctrl.subirFicha);
router.post('/fichas/:id/enviar',  verifyToken, requireFunc('dealer_ficha_crear'), ctrl.enviar);
router.post('/fichas/:id/enviar-firmada', verifyToken, requireFunc('dealer_ficha_crear'), ctrl.enviarFirmada);
router.delete('/fichas/:id',      verifyToken, requireFunc('dealer_ficha_crear', 'dealer_ficha_revisar'), ctrl.eliminar);

// Cadena de autorización: autorizar/rechazar validan el permiso del NIVEL actual dentro del controller (paramétrico).
router.post('/fichas/:id/autorizar', verifyToken, ctrl.autorizar);
router.post('/fichas/:id/rechazar',  verifyToken, ctrl.rechazar);
// Cierre (Analista de Operaciones/Crédito): tomar (claim) + cerrar (crea/actualiza el dealer).
router.post('/fichas/:id/tomar',   verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.tomar);
router.post('/fichas/:id/cerrar',  verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.cerrar);

// Mantenedor de niveles de aprobación (restringible por usuario).
router.get('/niveles',          verifyToken, requireFunc('dealer_aprob_config'), ctrl.nivelesListar);
router.post('/niveles',         verifyToken, requireFunc('dealer_aprob_config'), ctrl.nivelGuardar);
router.put('/niveles/:id',      verifyToken, requireFunc('dealer_aprob_config'), ctrl.nivelGuardar);
router.delete('/niveles/:id',   verifyToken, requireFunc('dealer_aprob_config'), ctrl.nivelEliminar);

module.exports = router;
