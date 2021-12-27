'use strict';

const _ = require('lodash');
const Async = require('async');
const NeDB = require('nedb');
const { TonClient } = require('@tonclient/core');
const { libNode } = require('@tonclient/lib-node');
const { file: tmpFile } = require('tmp-promise');
const { execConsole } = require('./node-tools')
const abiSafeMultisigWallet = require('./SafeMultisigWallet.abi.json');
const debug = require('debug')('lib:tx-approver');
const fs = require('fs').promises;

TonClient.useBinaryLibrary(libNode);

const localClient = new TonClient();

function decodeMessageBody(body) {
    return localClient.abi.decode_message_body({
        abi: {
            type: 'Contract',
            value: abiSafeMultisigWallet
        },
        body,
        is_internal: false
    });
}

async function sendMessage(config, message_encode_params) {
    const { message } = await localClient.abi.encode_message(message_encode_params);
    const { path, cleanup } = await tmpFile({ postfix: 'msg-body.boc' });

    await fs.writeFile(path, message, 'base64');

    const { stdout, stderr } = await execConsole(config, `sendmessage ${path}`);

    cleanup();

    debug(stdout);

    if(/success/.test(stdout)) return;

    debug(stderr);

    throw new Error('sendMessage failed');
}

async function getTimeDiff(config) {
    const { stdout } = await execConsole(config, 'getstats');
    const stats = JSON.parse(stdout);

    return _.isNumber(stats.timediff) ? stats.timediff : Number.POSITIVE_INFINITY;
}

function buildTxConfirmationFn(dryRun, consoleConfig) {
    if (dryRun) {
        return () => Promise.resolve();
    }

    return async (client, transactionId, address, keys) => {
        const message_encode_params = {
            abi: {
                type: 'Contract',
                value: abiSafeMultisigWallet
            },
            address,
            call_set: {
                function_name: 'confirmTransaction',
                input: {
                    transactionId
                },
            },
            is_internal: false,
            signer: {
                type: 'Keys',
                keys
            }
        }

        if (consoleConfig) {
            const timeDiffIsAcceptable = await getTimeDiff(consoleConfig) < 100;

            if (timeDiffIsAcceptable) {
                return sendMessage(consoleConfig, message_encode_params);
            }
        }

        return client.processing.process_message({
            message_encode_params,
            send_events: false
        });
    }
}

function initTxConfirmationQueue(everosConfig, dryRun, consoleCoinfig, sources, destinations) {
    let client = new TonClient(everosConfig);
    const txConfirmationQueue = Async.queue((txToConfirm, cb) => {
        const txApprovalPredicate = {
            transId: transId => BigInt(transId) > 0n,
            src: src => _.has(sources, src),
            dest: dest => _.includes(destinations, dest)
        }

        if (!_.conformsTo(txToConfirm, txApprovalPredicate)) {
            debug(`Transaction doesn't fit approval predicate: ${JSON.stringify(txToConfirm, null ,2)}`);

            return cb();
        }

        debug(`Transaction to confirm: ${JSON.stringify(txToConfirm, null, 2)}`);

        const address = txToConfirm.src;
        const custodians = sources[address];
        const txConfirmationRetryOpts = {
            times: 5,
            interval: retryCount => 10000 * retryCount // 10s, 20s, 30s, ...
        }
        const confirmTransaction = buildTxConfirmationFn(dryRun, consoleCoinfig);

        Async.eachOf(custodians, (keys, index, cb) => {
            Async.retry(txConfirmationRetryOpts, cb => {
                confirmTransaction(client, txToConfirm.transId, address, keys)
                    .then(() => cb())
                    .catch(err => {
                        client.close();
                        client = new TonClient(everosConfig);

                        debug(`EverOS client got re-initilized due to the following error: ${err.message}`);

                        cb(err);
                    });
            }, err => {
                if (_.isNil(err)) {
                    debug(`Transaction ${txToConfirm.transId} confirmed by custodian #${index + 1}`);
                }
                else {
                    debug(`Transaction ${txToConfirm.transId} confirmation failed for custodian #${index + 1}: ${err.message}`);
                }

                cb(err);
            });
        }, cb);
    });

    txConfirmationQueue.error((err, task) => {
        debug(`txConfirmationQueue: task failed: ${JSON.stringify(task, null, 2)},
            ${JSON.stringify(err, null, 2)}`);
    });

    return txConfirmationQueue;
}

function buildTransactionsIterationTask(everosConfig, txIterationStateDb, accountsFilter, txConfirmationQueue) {
    class AlreadyInitializedError extends Error {
        constructor() {
            super('already initialized');
        }
    }

    let client = new TonClient(everosConfig);
    let iterator;

    return cb => {
        Async.waterfall([
            cb => {
                Async.waterfall([
                    cb => {
                        return _.isNil(iterator) ? cb() : cb(new AlreadyInitializedError(), iterator);
                    },
                    cb => {
                        txIterationStateDb.findOne(
                            { key: 'resume-state' },
                            (err, doc) => cb(err, _.get(doc, 'value'))
                        );
                    },
                    (state, cb) => {
                        if (_.isNil(state)) {
                            const params = {
                                start_time: Math.floor(Date.now() / 1000),
                                accounts_filter: accountsFilter,
                                result: 'in_message { body } out_messages { body }',
                                include_transfers: false
                            }

                            debug('Creating transaction iterator...');

                            client.net.create_transaction_iterator(params)
                                .then(_.partial(cb, null))
                                .catch(cb)
                        }
                        else {
                            const params = {
                                resume_state: state,
                                accounts_filter: accountsFilter
                            }

                            debug('Resuming transaction iterator...');

                            client.net.resume_transaction_iterator(params)
                                .then(_.partial(cb, null))
                                .catch(cb)
                        }
                    }
                ], (err, result) => {
                    if (_.isNil(err) || (err instanceof AlreadyInitializedError)) {
                        iterator = result;

                        cb();
                    }
                    else {
                        cb(err);
                    }
                });
            },
            cb => {
                const params = {
                    iterator: iterator.handle,
                    limit: 1,
                    return_resume_state: true
                }

                client.net.iterator_next(params)
                    .then(_.partial(cb, null))
                    .catch(cb);
            },
            ({ resume_state, items }, cb) => {
                txIterationStateDb.update(
                    { key: 'resume-state' },
                    { $set: { value: resume_state } },
                    { upsert: true },
                    err => cb(err, items)
                );
            },
            (items, cb) => {
                const transformer = (acc, item, key, cb) => {
                    Async.parallel([
                        cb => {
                            const path = ['in_message', 'body'];

                            decodeMessageBody(_.get(item, path))
                                .then(body => _.set(item, path, body))
                                .then(() => cb())
                                .catch(cb);
                        },
                        cb => {
                            const path = ['out_messages', 0, 'body'];

                            decodeMessageBody(_.get(item, path))
                                .then(body => _.set(item, path, body))
                                .then(() => cb())
                                .catch(cb);
                        }
                    ], err => {
                        if (_.isNil(err)) {
                            acc.push(item);
                        }

                        cb();
                    });
                }

                Async.transform(items, [], transformer, cb);
            },
            (items, cb) => {
                const txs = _
                    .chain(items)
                    .filter([['in_message', 'body', 'name'], 'submitTransaction'])
                    .map(item => ({
                        transId: item.out_messages[0].body.value.transId,
                        src: item.account_addr,
                        dest: item.in_message.body.value.dest
                    }))
                    .value();

                Async.eachLimit(txs, 1, (tx, cb) => {
                    txConfirmationQueue.push(tx, cb);
                }, cb);
            }
        ], err => {
            if (_.isNil(err) || _.isNil(iterator)) {
                cb(err);
            }
            else {
                debug(`Transactions iteration task failed: ${JSON.stringify(err, null, 2)}`);

                client.net.remove_iterator(iterator)
                    .finally(() => {
                        iterator = null;

                        client.close();
                        client = new TonClient(everosConfig);

                        debug(`EverOS client got re-initilized due to the previous error`);

                        cb(err);
                    });
            }
        });
    }
}

function validateConfig(config) {
    const isAddress = value => /^(-1|0):[0-9a-zA-Z]{64}$/.test(value);
    const configEntryValidator = {
        client: _.partialRight(_.has, 'network.endpoints.0'), // at least one endpoint specified
        sources: _.partialRight(_.every, (value, key) => {
            const isKey = value => /^[0-9a-zA-Z]{64}$/.test(value);
            const keyPairValidator = { public: isKey, secret: isKey }

            return isAddress(key)
                && _.every(value, _.partialRight(_.conformsTo, keyPairValidator)); // [potentially empty] key pair list
        }),
        destinations: _.partialRight(_.every, isAddress)
    }

    return _.conformsTo(config, configEntryValidator);
}

class TransactionApprover {
    constructor(config) {
        if (!validateConfig(config)) {
            throw new Error('config is invalid');
        }

        this.txConfirmationQueue = initTxConfirmationQueue(
            config.client,
            _.get(config, 'dryRun', false),
            config.console,
            config.sources,
            config.destinations
        );
        this.db = {
            txIterationState: new NeDB({
                filename: config.txIterationStateDbPath,
                autoload: true
            })
        }
        this.config = config;
    }

    run() {
        const retryOpts = {
            times: 5,
            interval: retryCount => 10000 * retryCount // 10s, 20s, 30s, ...
        }
        const task = buildTransactionsIterationTask(
            this.config.client,
            this.db.txIterationState,
            [..._.keys(this.config.sources)],
            this.txConfirmationQueue
        );

        debug('Starting endless transactions confirmation loop...');

        return Async.forever(Async.retryable(retryOpts, task));
    }
}

module.exports = TransactionApprover;
