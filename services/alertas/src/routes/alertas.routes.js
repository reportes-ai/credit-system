'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/alertas.controller');

// Cancelar alerta de una carta al abrirla (cualquier usuario autenticado del flujo)
router.post('/visto/:id', verifyToken, c.marcarVisto);

router.get('/meta',    verifyToken, requireFunc('mantenedores_alertas'), c.getMeta);
// Anuncios push en pantalla (banner que baja desde arriba)
router.get('/anuncios', verifyToken, requireFunc('mantenedores_alertas'), c.getAnuncios);
router.put('/anuncios', verifyToken, requireFunc('mantenedores_alertas'), c.saveAnuncios);
router.get('/',        verifyToken, requireFunc('mantenedores_alertas'), c.listAlertas);
router.post('/',       verifyToken, requireFunc('mantenedores_alertas'), c.saveAlerta);
router.delete('/:id',  verifyToken, requireFunc('mantenedores_alertas'), c.deleteAlerta);

module.exports = router;
