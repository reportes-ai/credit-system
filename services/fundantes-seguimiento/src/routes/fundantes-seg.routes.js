'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/fundantes-seg.controller');

// Mantenedor de tipos de documento. Va ANTES de las rutas con :id para que
// "/tipos" no lo capture ningún patrón parametrizado.
router.get('/tipos',                    verifyToken, c.tiposListar);
router.post('/tipos',                   verifyToken, requireFunc('fundantes_tipos'), c.tiposCrear);
router.put('/tipos/:id',                verifyToken, requireFunc('fundantes_tipos'), c.tiposActualizar);
router.delete('/tipos/:id',             verifyToken, requireFunc('fundantes_tipos'), c.tiposEliminar);

router.get('/',                         verifyToken, c.listar);
router.get('/resumen',                  verifyToken, c.resumen);
router.get('/devueltos',                verifyToken, c.devueltos);
router.post('/:id/devolver',            verifyToken, requireFunc('fundantes_validar', 'fundantes_operaciones'), c.devolver);
router.get('/historial',                verifyToken, requireFunc('fundantes_historial', 'fundantes_operaciones', 'fundantes_validar'), c.historial);
router.get('/popup',                    verifyToken, c.popup);
router.post('/popup/:id/comentar',      verifyToken, c.popupComentar);
router.get('/:id/bitacora',             verifyToken, c.bitacora);
router.post('/:id/bitacora',            verifyToken, requireFunc('fundantes_seguimiento', 'fundantes_validar', 'fundantes_operaciones'), c.comentar);
router.get('/doc/:docId/download',      verifyToken, c.descargar);
router.get('/:id/docs',                 verifyToken, c.listarDocs);
router.get('/:id/zip',                  verifyToken, c.descargarZip);
router.post('/:id/doc',                 verifyToken, c.subirDoc);
router.delete('/:id/doc/:codigo',       verifyToken, c.eliminarDoc);
router.post('/:id/enviar',              verifyToken, c.enviar);
router.post('/:id/sin-limitacion',      verifyToken, c.marcarSinLimitacion);
router.post('/:id/validar',             verifyToken, requireFunc('fundantes_validar', 'fundantes_operaciones'), c.validar);

module.exports = router;
