import _ from 'lodash';
import Debug from 'debug';
import express from 'express';
import http from 'http';
import logger from 'morgan';
import indexRouter from './routes/index.js';
import TransactionApprover from './lib/transaction-approver.js';
import configs from './config.js';

const app = express();
const port = 3000;
const debug = Debug('app');

app.set('port', port);
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/', indexRouter);

const server = http.createServer(app);

server.setTimeout(600000);
server.on('error', (err) => {
    debug(err);

    process.exit(1);
});
server.on('listening', () => {
    const addr = server.address();
    const bind = _.isString(addr)
        ? 'pipe ' + addr
        : 'port ' + addr.port;

    debug('listening on ' + bind);

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
});
server.listen(port);

