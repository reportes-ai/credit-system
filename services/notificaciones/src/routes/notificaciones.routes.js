'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/notificaciones.controller');

// Avisos en Línea (Soporte) — antes de '/:id' para no chocar con el DELETE
router.get('/aviso-linea/vigentes',  verifyToken, c.avisosVigentes);
router.get('/aviso-linea/historial', verifyToken, requireFunc('avisos_linea'), c.avisosHistorial);
router.post('/aviso-linea',          verifyToken, requireFunc('avisos_linea'), c.enviarAviso);

router.get('/vapid-key',   verifyToken, c.getVapidKey);
router.post('/subscribe',  verifyToken, c.subscribe);
router.get('/',            verifyToken, c.getMias);
router.put('/leidas',      verifyToken, c.marcarLeidas);
router.delete('/todas',    verifyToken, c.borrarTodas);
router.delete('/:id',      verifyToken, c.borrarUna);

module.exports = router;
