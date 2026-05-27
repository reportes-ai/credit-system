const router = require('express').Router();
const ctrl = require('../controllers/perfiles.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

router.get('/',    verifyToken, ctrl.getAllPerfiles);
router.post('/',   verifyToken, requirePerfil('Administrador'), ctrl.createPerfil);
router.delete('/:id', verifyToken, requirePerfil('Administrador'), ctrl.deletePerfil);
router.get('/modulos-funcionalidades', verifyToken, ctrl.getModulosConFuncionalidades);
router.get('/:id/permisos',  verifyToken, ctrl.getPermisosPerfil);
router.put('/:id/permisos',  verifyToken, requirePerfil('Administrador'), ctrl.updatePermisosPerfil);
router.get('/:id/usuarios',  verifyToken, ctrl.getUsuariosByPerfil);
router.put('/modulos/reordenar', verifyToken, requirePerfil('Administrador'), ctrl.reordenarModulos);

module.exports = router;
