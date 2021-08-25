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
const ps = [];

_.forEach(configs, (config, index) => {
    try {
        const txApprover = new TransactionApprover(config);

        ps.push(txApprover.run());

        debug(`Transaction Approver #${index + 1} successfully started` + (config.dryRun ? ' (dryRun)' : ''));
    }
    catch (err) {
        debug(`Transaction Approver #${index + 1} construction failed`);
    }
});

Promise.all(ps)
    .then(() => debug(`no Transaction Approvers configured [ps.length = ${ps.length}] - exiting...`))
    .catch(err => debug(`some Transaction Approver got interrupted - exiting... ${JSON.stringify(err, null, 2)}`))
    .finally(() => process.exit(1));

