'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/ayuda.controller');

// Academia (autocapacitación) — solo requiere sesión: es para todos.
router.get('/academia/cursos', verifyToken, c.academiaCursos);
router.post('/academia/progreso', verifyToken, c.academiaProgreso);
router.get('/dcq', verifyToken, c.dcqListar);   // Dónde·Cómo·Quién: banco completo
// Mantención del banco: cuando falta una respuesta se agrega en el momento.
router.post('/dcq',         verifyToken, requireFunc('mantenedores_ayuda'), c.dcqCrear);
router.put('/dcq/:slug',    verifyToken, requireFunc('mantenedores_ayuda'), c.dcqActualizar);
router.delete('/dcq/:slug', verifyToken, requireFunc('mantenedores_ayuda'), c.dcqEliminar);

router.get('/todas', verifyToken, requireFunc('mantenedores_ayuda'), c.listAyuda);
router.get('/', verifyToken, c.getAyuda);
// Edición desde el mantenedor de Ayuda
router.put('/:ruta?', verifyToken, requireFunc('mantenedores_ayuda'), c.upsertAyuda);

module.exports = router;
