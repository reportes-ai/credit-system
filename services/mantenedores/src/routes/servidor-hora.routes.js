const router = require('express').Router();
const ctrl   = require('../controllers/servidor-hora.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Auditoría 03-08-2026 (A-1): el override de timezone NO tenía permiso — cualquier
// usuario autenticado podía cambiar la hora de la BD y corromper TODAS las fechas
// del sistema (curses, vencimientos, mora, reloj control, cierres contables).
router.get('/',             verifyToken, requireFunc('mant_servidor_hora', 'mantenedores_solo_dios'), ctrl.getInfo);
router.post('/tz-override', verifyToken, requireFunc('mant_servidor_hora', 'mantenedores_solo_dios'), ctrl.setTZOverride);

module.exports = router;
