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
router.get('/atribuciones',   verifyToken, c.getAtribuciones);
router.get('/alertas-config', verifyToken, c.getAlertasConfig);
router.put('/alertas-config', verifyToken, requireFunc('postventa_mantenedores'), c.setAlertasConfig);
router.get('/orden-pago',             verifyToken, c.getOrdenPago);
router.get('/orden-pago/:id/correlativo', verifyToken, c.correlativoOrden);
router.post('/orden-pago/emitir',     verifyToken, requireFunc('pv_orden_emitir'), c.emitirOrdenPago);
router.get('/saldos-a-pagar',       verifyToken, c.getSaldosAPagar);
router.get('/saldos-a-pagar/fondos',verifyToken, c.getFondos);
router.put('/saldos-a-pagar/fondos',verifyToken, requireFunc('pv_fondos_definir'), c.setFondos);
router.post('/saldos-a-pagar/enviar-a-pago', verifyToken, requireFunc('pv_saldos_seleccionar'), c.enviarAPago);
router.post('/saldos-a-pagar/pagar',verifyToken, requireFunc('postventa_saldos_pagar'), c.pagarSaldos);
router.post('/saldos-a-pagar/desmarcar', verifyToken, requireFunc('pv_saldos_revertir'), c.desmarcarSaldos);
router.get('/',               verifyToken, c.getAll);
router.put('/:id/etapa',    verifyToken, requireFunc('postventa_seguimiento'), c.setEtapa);

module.exports = router;
