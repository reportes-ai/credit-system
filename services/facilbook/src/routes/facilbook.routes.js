'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/facilbook.controller');

// Muro
router.get('/feed', verifyToken, ctrl.getFeed);
router.post('/posts', verifyToken, ctrl.crearPost);
router.delete('/posts/:id', verifyToken, ctrl.eliminarPost);
router.get('/fotos/:id', verifyToken, ctrl.verFoto);
router.post('/posts/:id/like', verifyToken, ctrl.toggleLike);
router.post('/posts/:id/comentarios', verifyToken, ctrl.comentar);
router.delete('/comentarios/:id', verifyToken, ctrl.eliminarComentario);

// Marketplace
router.get('/market', verifyToken, ctrl.getMarket);
router.post('/market', verifyToken, ctrl.crearItem);
router.put('/market/:id', verifyToken, ctrl.actualizarItem);
router.get('/market-fotos/:id', verifyToken, ctrl.verFotoMarket);

module.exports = router;
