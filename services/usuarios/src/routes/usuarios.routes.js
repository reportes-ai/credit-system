const router = require('express').Router();
const ctrl = require('../controllers/usuarios.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Autorización paramétrica: la matriz de Perfiles y Permisos manda
// (Administrador pasa siempre por bypass del middleware)

router.get('/', verifyToken, ctrl.getAllUsuarios);
router.get('/:id', verifyToken, ctrl.getUsuarioById);
router.post('/', verifyToken, requireFunc('usuarios.crear', 'usuarios_gestionar'), ctrl.createUsuario);
router.put('/:id', verifyToken, requireFunc('usuarios.editar', 'usuarios_gestionar'), ctrl.updateUsuario);
router.delete('/:id', verifyToken, requireFunc('usuarios.eliminar', 'usuarios_gestionar'), ctrl.deleteUsuario);
router.post('/:id/reactivar', verifyToken, requireFunc('usuarios.editar', 'usuarios_gestionar'), ctrl.reactivarUsuario);
router.post('/:id/reset-clave', verifyToken, requireFunc('usuarios.reset_clave', 'usuarios_gestionar'), ctrl.resetClave);
router.get('/:id/permisos',    verifyToken, ctrl.getPermisosUsuario);
router.put('/:id/permisos',    verifyToken, requireFunc('usuarios.permisos', 'usuarios_perfiles'), ctrl.updatePermisosUsuario);
router.get('/me/ejecutivos',   verifyToken, ctrl.misEjecutivos);
router.get('/:id/ejecutivos',  verifyToken, ctrl.getEjecutivosUsuario);
router.put('/:id/ejecutivos',  verifyToken, requireFunc('usuarios_gestionar'), ctrl.updateEjecutivosUsuario);

module.exports = router;
