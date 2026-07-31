'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/fundantes-seg.controller');

router.get('/',                         verifyToken, c.listar);
router.get('/resumen',                  verifyToken, c.resumen);
router.get('/devueltos',                verifyToken, c.devueltos);
router.post('/:id/devolver',            verifyToken, requireFunc('fundantes_validar', 'fundantes_operaciones'), c.devolver);
router.get('/historial',                verifyToken, requireFunc('fundantes_historial', 'fundantes_operaciones', 'fundantes_validar'), c.historial);
router.get('/popup',                    verifyToken, c.popup);
router.post('/popup/:id/comentar',      verifyToken, c.popupComentar);
router.get('/:id/bitacora',             verifyToken, c.bitacora);
router.post('/:id/bitacora',            verifyToken, c.comentar);
router.get('/doc/:docId/download',      verifyToken, c.descargar);
router.get('/:id/docs',                 verifyToken, c.listarDocs);
router.get('/:id/zip',                  verifyToken, c.descargarZip);
router.post('/:id/doc',                 verifyToken, c.subirDoc);
router.delete('/:id/doc/:codigo',       verifyToken, c.eliminarDoc);
router.post('/:id/enviar',              verifyToken, c.enviar);
router.post('/:id/validar',             verifyToken, requireFunc('fundantes_validar', 'fundantes_operaciones'), c.validar);

module.exports = router;
