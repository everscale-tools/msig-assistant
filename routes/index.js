const debug = require('debug')('api:index');
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');

function errorHandler(err, req, res, next) {
    debug('ERROR:', err);

    res.status(err.statusCode || 500).send();
}

router.post('/', asyncHandler(async (req, res) => {
    res.send();
}), errorHandler);

module.exports = router;
