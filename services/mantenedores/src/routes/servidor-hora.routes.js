const router = require('express').Router();
const ctrl   = require('../controllers/servidor-hora.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/', verifyToken, ctrl.getInfo);

module.exports = router;
