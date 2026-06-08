const router = require('express').Router();
const ctrl = require('../controllers/usuarios.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/', verifyToken, ctrl.getAllUsuarios);
router.get('/:id', verifyToken, ctrl.getUsuarioById);
router.post('/', verifyToken, soloAdmin, ctrl.createUsuario);
router.put('/:id', verifyToken, soloAdmin, ctrl.updateUsuario);
router.delete('/:id', verifyToken, soloAdmin, ctrl.deleteUsuario);
router.post('/:id/reset-clave', verifyToken, soloAdmin, ctrl.resetClave);
router.get('/:id/permisos',    verifyToken, ctrl.getPermisosUsuario);
router.put('/:id/permisos',    verifyToken, soloAdmin, ctrl.updatePermisosUsuario);
router.get('/me/ejecutivos',   verifyToken, ctrl.misEjecutivos);
router.get('/:id/ejecutivos',  verifyToken, ctrl.getEjecutivosUsuario);
router.put('/:id/ejecutivos',  verifyToken, soloAdmin, ctrl.updateEjecutivosUsuario);

module.exports = router;
