'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/postventa.controller');

router.post('/sync',             verifyToken, c.sync);
router.post('/marcar-historico', verifyToken, c.marcarHistorico);
router.get('/config',       verifyToken, c.getConfig);
router.put('/config/:clave',verifyToken, requireFunc('postventa_mantenedores'), c.setConfig);
router.get('/perfiles-lista', verifyToken, c.getPerfiles);
router.get('/saldos-a-pagar',       verifyToken, c.getSaldosAPagar);
router.post('/saldos-a-pagar/pagar',verifyToken, requireFunc('postventa_saldos_pagar'), c.pagarSaldos);
router.get('/',               verifyToken, c.getAll);
router.put('/:id/etapa',    verifyToken, requireFunc('postventa_seguimiento'), c.setEtapa);

module.exports = router;
