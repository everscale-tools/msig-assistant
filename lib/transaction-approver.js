'use strict';

const _ = require('lodash');
const Async = require('async');
const NeDB = require('nedb');
const { TonClient } = require('@tonclient/core');
const { libNode } = require('@tonclient/lib-node');
const abiSafeMultisigWallet = require('./SafeMultisigWallet.abi.json');
const debug = require('debug')('lib:tx-approver');

TonClient.useBinaryLibrary(libNode);

function decodeMessageBody(client, body) {
    return client.abi.decode_message_body({
        abi: {
            type: 'Contract',
            value: abiSafeMultisigWallet
        },
        body,
        is_internal: false
    });
}

function buildTxConfirmationFn(client, dryRun) {
    if (dryRun) {
        return () => Promise.resolve();
    }

    return (transactionId, address, keys) => {
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

        return client.processing.process_message({
            message_encode_params,
            send_events: false
        });
    }
}

function initTxConfirmationQueue(client, dryRun, sources, destinations) {
    const txApprovalPredicate = {
        transId: transId => BigInt(transId) > 0n,
        src: src => _.has(sources, src),
        dest: dest => _.includes(destinations, dest)
    }
    const txConfirmationRetryOpts = {
        times: 4,
        interval: retryCount => 30000 * Math.pow(2, retryCount - 1) // 30s, 1m, 2m, ...
    }
    const confirmTransaction = buildTxConfirmationFn(client, dryRun);
    const txConfirmationQueue = Async.queue((txToConfirm, cb) => {
        if (!_.conformsTo(txToConfirm, txApprovalPredicate)) {
            debug(`tx doesn't fit approval predicate: ${JSON.stringify(txToConfirm, null ,2)}`);

            return cb();
        }

        debug(`transaction to confirm: ${JSON.stringify(txToConfirm, null, 2)}`);

        const address = txToConfirm.src;
        const custodians = sources[address];

        Async.eachOf(custodians, (keys, index, cb) => {
            Async.retry(txConfirmationRetryOpts, cb => {
                confirmTransaction(txToConfirm.transId, address, keys)
                    .then(() => cb())
                    .catch(cb);
            }, err => {
                if (_.isNil(err)) {
                    debug(`transaction ${txToConfirm.transId} confirmed by custodian #${index + 1}`);
                }
                else {
                    debug(`transaction ${txToConfirm.transId} confirmation failed for custodian #${index + 1}: ${err.message}`);
                }

                cb(err);
            });
        }, cb);
    });

    txConfirmationQueue.error((err, task) => {
        debug(`txConfirmationQueue: task failed: ${JSON.stringify(task, null, 2)}, ${err}`);
    });

    return txConfirmationQueue;
}

function buildTransactionsIterationTask(client, iterator, txConfirmationQueue, txIterationStateDb) {
    const params = {
        iterator,
        limit: 1,
        return_resume_state: true
    }

    return cb => {
        Async.waterfall([
            cb => {
                client.net.iterator_next(params)
                    .then(result => cb(null, result.resume_state, result.items))
                    .catch(cb);
            },
            (state, items, cb) => {
                txIterationStateDb.update(
                    { key: 'resume-state' },
                    { $set: { value: state } },
                    { upsert: true },
                    err => _.isNil(err) ? cb(null, items) : cb(err)
                );
            },
            (items, cb) => {
                cb(null, _.filter(items, {
                    in_message: { msg_type: 1 },
                    out_messages: [{ msg_type: 2 }]
                }));
            },
            (items, cb) => {
                Async.each(items, (item, cb) => {
                    Async.parallel([
                        cb => {
                            const path = ['in_message', 'body'];

                            decodeMessageBody(client, _.get(item, path))
                                .then(body => _.set(item, path, body))
                                .then(() => cb())
                                .catch(cb);
                        },
                        cb => {
                            const path = ['out_messages', 0, 'body'];

                            decodeMessageBody(client, _.get(item, path))
                                .then(body => _.set(item, path, body))
                                .then(() => cb())
                                .catch(cb);
                        }
                    ], cb);
                }, err => _.isNil(err) ? cb(null, items) : cb(err));
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

                if (_.isEmpty(txs)) return cb();

                return txConfirmationQueue.push(txs, cb);
            }
        ], cb);
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

        this.client = new TonClient(config.client);
        this.txConfirmationQueue = initTxConfirmationQueue(
            this.client,
            _.get(config, 'dryRun', false),
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
        Async.waterfall([
            cb => {
                const inProgress = _.has(this.txIterator, 'handle');

                if (inProgress) {
                    cb(new Error('transactions are already being iterated'));
                }
                else {
                    cb();
                }
            },
            cb => {
                this.db.txIterationState.findOne(
                    { key: 'resume-state' },
                    (err, doc) => _.isNil(err) ? cb(null, _.get(doc, 'value')) : cb(err)
                );
            },
            (state, cb) => {
                const accounts_filter = [..._.keys(this.config.sources)];

                if (_.isNil(state)) {
                    const params = {
                        start_time: Math.floor(Date.now() / 1000),
                        accounts_filter,
                        result: 'in_message { body } out_messages { body }',
                        include_transfers: false
                    }

                    this.client.net.create_transaction_iterator(params)
                        .then(txIterator => {
                            this.txIterator = txIterator;

                            cb(null, this.txIterator.handle);
                        })
                        .catch(cb)
                }
                else {
                    const params = {
                        resume_state: state,
                        accounts_filter
                    }

                    this.client.net.resume_transaction_iterator(params)
                        .then(txIterator => {
                            this.txIterator = txIterator;

                            cb(null, this.txIterator.handle);
                        })
                        .catch(cb)
                }
            },
            (iterator, cb) => {
                const task = buildTransactionsIterationTask(
                    this.client,
                    iterator,
                    this.txConfirmationQueue,
                    this.db.txIterationState
                );

                Async.forever(task, cb);
            }
        ], err => {
            debug(`transactions iteration failed with error: ${err.message}`);
        });
    }
}

module.exports = TransactionApprover;
