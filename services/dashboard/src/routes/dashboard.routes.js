const router = require('express').Router();
const ctrl   = require('../controllers/dashboard.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/datos', verifyToken, ctrl.getDatos);

module.exports = router;
