'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/notificaciones.controller');

router.get('/vapid-key',   verifyToken, c.getVapidKey);
router.post('/subscribe',  verifyToken, c.subscribe);
router.get('/',            verifyToken, c.getMias);
router.put('/leidas',      verifyToken, c.marcarLeidas);
router.delete('/todas',    verifyToken, c.borrarTodas);
router.delete('/:id',      verifyToken, c.borrarUna);

module.exports = router;
