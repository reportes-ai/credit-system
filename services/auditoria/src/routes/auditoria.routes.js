const router = require('express').Router();
const ctrl = require('../controllers/auditoria.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Solo Administrador (auditoria_ver asignado únicamente al perfil Admin)
router.get('/movimientos',        verifyToken, requireFunc('auditoria_ver'), ctrl.getMovimientos);
router.get('/movimientos/export', verifyToken, requireFunc('auditoria_ver'), ctrl.exportMovimientos);
router.get('/logins',             verifyToken, requireFunc('auditoria_ver'), ctrl.getLogins);
router.get('/logins/export',      verifyToken, requireFunc('auditoria_ver'), ctrl.exportLogins);
router.get('/dealers',            verifyToken, requireFunc('auditoria_ver'), ctrl.getBitacoraDealers);
router.get('/filtros',            verifyToken, requireFunc('auditoria_ver'), ctrl.getFiltros);
router.get('/backups',            verifyToken, requireFunc('auditoria_ver'), ctrl.getBackups);

module.exports = router;
