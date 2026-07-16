'use strict';
const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/visitas-terreno.controller');

// Mismos permisos que el módulo de visitas (el ejecutivo opera SUS visitas)
const puede = requireFunc('visitas_dealers', 'visitas_supervisar');
const upFoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/mi-dia',                    verifyToken, puede, c.miDia);
router.post('/visitas/:id/checkin',      verifyToken, puede, c.checkin);
router.post('/visitas/:id/foto',         verifyToken, puede, upFoto.single('foto'), c.subirFoto);
router.get('/visitas/:id/fotos',         verifyToken, puede, c.listarFotos);
router.get('/fotos/:idFoto',             verifyToken, puede, c.verFoto);
router.delete('/fotos/:idFoto',          verifyToken, puede, c.borrarFoto);

module.exports = router;
