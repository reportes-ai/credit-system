const router = require('express').Router();
const { getNoticias } = require('../controllers/noticias.controller');

// Público — no requiere token (es info pública)
router.get('/', getNoticias);

module.exports = router;
