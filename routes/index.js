import Debug from 'debug';
import express from 'express';
import asyncHandler from 'express-async-handler';

const debug = Debug('api:index');
const router = express.Router();

export default router;

function errorHandler(err, req, res, next) {
    debug('ERROR:', err);

    res.status(err.statusCode || 500).send();
}

router.post('/', asyncHandler(async (req, res) => {
    res.send();
}), errorHandler);

