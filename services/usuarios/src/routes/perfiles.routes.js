const router = require('express').Router();
const ctrl = require('../controllers/perfiles.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',    verifyToken, ctrl.getAllPerfiles);
router.post('/',      verifyToken, requireFunc('usuarios_perfiles'), ctrl.createPerfil);
router.put('/masivo', verifyToken, requireFunc('usuarios_perfiles'), ctrl.masivoPermisos);
router.put('/:id',    verifyToken, requireFunc('usuarios_perfiles'), ctrl.updatePerfil);
router.delete('/:id', verifyToken, requireFunc('usuarios_perfiles'), ctrl.deletePerfil);
router.get('/modulos-funcionalidades', verifyToken, ctrl.getModulosConFuncionalidades);
router.get('/:id/permisos',  verifyToken, ctrl.getPermisosPerfil);
router.put('/:id/permisos',  verifyToken, requireFunc('usuarios_perfiles'), ctrl.updatePermisosPerfil);
router.get('/:id/usuarios',  verifyToken, ctrl.getUsuariosByPerfil);
router.put('/modulos/reordenar', verifyToken, requireFunc('usuarios_perfiles'), ctrl.reordenarModulos);

module.exports = router;
