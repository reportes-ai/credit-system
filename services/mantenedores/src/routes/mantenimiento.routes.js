'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const C = require('../controllers/mantenimiento.controller');

router.get('/', verifyToken, C.getEstado);   // estado para el overlay (cualquier usuario)
router.put('/', verifyToken, C.setEstado);   // activar/editar — SOLO BG-ADMIN (gate en el controller)

router.get('/dev', verifyToken, C.getDev);   // config Modo Desarrollo — SOLO BG-ADMIN (gate en controller)
router.put('/dev', verifyToken, C.setDev);   // activar/editar Modo Desarrollo — SOLO BG-ADMIN

router.put('/juego', verifyToken, C.setJuego);  // Humoradas: lanzar/apagar juego para todos — SOLO BG-ADMIN

module.exports = router;
