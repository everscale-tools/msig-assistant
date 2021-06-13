const debug = require('debug')('app');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');

const indexRouter = require('./routes/index');

const app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', indexRouter);

module.exports = app;

// ---

const _ = require('lodash');
const TransactionApprover = require('./lib/transaction-approver');
const configs = require('./config');

_.forEach(configs, async (config, index) => {
    try {
        const txApprover = new TransactionApprover(config);

        await txApprover.run()

        debug(`Transaction Approver #${index + 1} successfully started`);
    }
    catch (err) {
        debug(`Transaction Approver #${index + 1} construction failed`);
    }
});
