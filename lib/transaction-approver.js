import * as fs from 'fs/promises';
import crypto from 'crypto';
import _ from 'lodash';
import Async from 'async';
import { Low, JSONFile } from 'lowdb';
import Debug from 'debug';
import { TonClient } from '@tonclient/core';
import { libNode } from '@tonclient/lib-node';
import { file as tmpFile } from 'tmp-promise';
import { execConsole } from './node-tools.js';

TonClient.useBinaryLibrary(libNode);

const abiSafeMultisigWallet = JSON.parse(await fs.readFile('lib/SafeMultisigWallet.abi.json'));
const debug = Debug('lib:tx-approver');
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

function initTxConfirmationQueue(everosConfig, txIterationStateDb, consoleCoinfig, sources, destinations, dryRun) {
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

        debug(`Transaction to confirm: ${JSON.stringify(_.pick(txToConfirm, ['transId', 'src', 'dest']), null, 2)}`);

        const address = txToConfirm.src;
        const custodians = sources[address];
        const txConfirmationRetryOpts = {
            times: 5,
            interval: retryCount => 10000 * retryCount // 10s, 20s, 30s, ...
        }
        const confirmTransaction = buildTxConfirmationFn(dryRun, consoleCoinfig);

        return Async.eachOf(custodians, (keys, index, cb) => {
            Async.retry(txConfirmationRetryOpts, cb => {
                confirmTransaction(client, txToConfirm.transId, address, keys)
                    .then(() => cb())
                    .catch(err => {
                        client.close();
                        client = new TonClient(everosConfig);

                        debug(`EverOS client got re-initilized due to the following error: ${_.toString(err)}`);

                        cb(err);
                    });
            }, err => {
                if (_.isNil(err)) {
                    debug(`Transaction ${txToConfirm.transId} confirmed by custodian #${index + 1}`);
                }
                else {
                    debug(`Transaction ${txToConfirm.transId} confirmation failed for custodian #${index + 1}: ${_.toString(err)}`);
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

function initCursor(client, txIterationStateDb, aa) {
    return cb => {
        const cursor = _.get(txIterationStateDb, ['data', 'cursors', aa, 'startCursor']);

        if (/^[a-f0-9]+$/.test(cursor)) {
            return cb(null, cursor);
        }

        const query = `
            query ($aa: String!) {
                blockchain
                {
                    account_transactions(
                        account_address: $aa
                        last: 1
                    )
                    {
                        pageInfo { endCursor }
                    }
                }
            }
        `;
        const params = {
            query,
            variables: {
                aa
            }
        }

        return client.net.query(params)
            .then(result => {
                const cursor = _.get(result, 'result.data.blockchain.account_transactions.pageInfo.endCursor');

                cb(null, cursor);
            })
            .catch(cb);
    }
}

class NoDataError extends Error {
    constructor() {
        super('no data');
    }
}

function getEdges(client, txIterationStateDb, aa) {
    return (cursor, cb) => {
        const query = `
            query ($aa: String!, $cursor: String!, $limit: Int!) {
                blockchain
                {
                    account_transactions(
                        account_address: $aa
                        after: $cursor
                        first: $limit
                    )
                    {
                        edges { node { account_addr in_msg out_msgs } }
                        pageInfo { startCursor endCursor }
                    }
                }
            }
        `;
        const params = {
            query,
            variables: {
                aa,
                cursor,
                limit: 10
            }
        }

        client.net.query(params)
            .then(result => {
                const edges = _.get(result, 'result.data.blockchain.account_transactions.edges');

                if (_.isEmpty(edges)) {
                    return setTimeout(cb, crypto.randomInt(30000, 300000), new NoDataError());
                }

                _.set(txIterationStateDb, ['data', 'cursors', aa],
                    _.get(result, 'result.data.blockchain.account_transactions.pageInfo'));

                return cb(null, edges);
            })
            .catch(cb);
    }
}

function enrichEdgesWithMessageInfo(client) {
    return (edges, cb) => {
        const query = `
            query ($ids: [String]!) {
                messages(
                    filter: { id: { in: $ids } }
                )
                { id created_at msg_type body }
            }
        `;
        const params = {
            query,
            variables: {
                ids: _.flatMap(edges, ({ node: { in_msg, out_msgs } }) => [in_msg, ...out_msgs])
            }
        }

        client.net.query(params)
            .then(result => {
                const messages = _
                    .chain(result)
                    .get('result.data.messages')
                    .map(x => [x.id, x])
                    .fromPairs()
                    .value();

                _.forEach(edges, edge => {
                    _.update(edge, 'node.in_msg', _.partial(_.get, messages));
                    _.update(edge, 'node.out_msgs', _.partialRight(_.map, _.partial(_.get, messages)));
                });

                cb(null, edges);
            })
            .catch(cb);
    }
}

function decodeMessageBodies() {
    return (edges, cb) => {
        const transformer = (acc, item, key, cb) => {
            Async.parallel([
                cb => {
                    const path = ['node', 'in_msg', 'body'];

                    decodeMessageBody(_.get(item, path))
                        .then(body => (_.set(item, path, body), cb()))
                        .catch(cb);
                },
                cb => {
                    const path = ['node', 'out_msgs', 0, 'body'];

                    decodeMessageBody(_.get(item, path))
                        .then(body => (_.set(item, path, body), cb()))
                        .catch(cb);
                }
            ], err => {
                if (_.isNil(err)) {
                    acc.push(item);
                }

                cb();
            });
        }

        Async.transform(edges, [], transformer, cb);
    }
}

function filterAndConfirmTxs(txIterationStateDb, txConfirmationQueue) {
    return (edges, cb) => {
        const txs = _
            .chain(edges)
            .filter([['node', 'in_msg', 'body', 'name'], 'submitTransaction'])
            .map(edge => ({
                transId: _.get(edge, 'node.out_msgs[0].body.value.transId'),
                src: _.get(edge, 'node.account_addr'),
                dest: _.get(edge, 'node.in_msg.body.value.dest'),
                cursor: edge.cursor
            }))
            .filter(tx => _.chain(txIterationStateDb).get(['data', 'txs', tx.transId]).isNil().value())
            .value();

        Async.eachSeries(txs, (tx, cb) => {
            txConfirmationQueue.push(tx, err => {
                let txInfo = {
                    ok: _.isNil(err),
                    t: Math.floor(Date.now() / 1000)
                }

                if (err) {
                    debug(`WARN: failed to confirmm tx ${JSON.stringify(tx, null, 2)} with error: ${_.toString(err)}`);

                    txInfo.err = err.message;
                }

                _.set(txIterationStateDb, ['data', 'txs', tx.transId], txInfo);

                cb();
            });
        }, cb);
    }
}

function updateCursor(txIterationStateDb, aa) {
    return cb => {
        _.set(txIterationStateDb, ['data', 'cursors', aa], {
            startCursor: _.get(txIterationStateDb, ['data', 'cursors', aa, 'endCursor'])
        });

        cb();
    }
}

function buildTransactionsIterationTask(everosConfig, txIterationStateDb, accountsFilter, txConfirmationQueue) {
    let client = new TonClient(everosConfig);

    try {
    return cb => {
        Async.waterfall([
            cb => {
                txIterationStateDb.read()
                    .then(() => cb())
                    .catch(cb);
            },
            cb => {
                Async.each(accountsFilter, (aa, cb) => {
                    Async.waterfall([
                        initCursor(client, txIterationStateDb, aa),
                        getEdges(client, txIterationStateDb, aa),
                        enrichEdgesWithMessageInfo(client),
                        decodeMessageBodies(),
                        filterAndConfirmTxs(txIterationStateDb, txConfirmationQueue),
                        updateCursor(txIterationStateDb, aa)
                    ], err => {
                        if (err instanceof NoDataError) {
                            return cb();
                        }

                        return cb(err);
                    });
                }, cb);
            }
        ], err => {
            if (_.isNil(err)) {
                // TODO: clean up old txs

                return txIterationStateDb.write()
                    .then(() => cb())
                    .catch(cb);
            }

            debug(`Transactions iteration task failed: ${_.toString(err)}`);

            client.close();
            client = new TonClient(everosConfig);

            debug('EverOS client got re-initilized due to the previous error');

            return cb(err);
        });
    }
    }
    catch (err) {
        debug(err);
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

export default class TransactionApprover {
    constructor(config) {
        if (!validateConfig(config)) {
            throw new Error('config is invalid');
        }

        this.db = {
            txIterationState: new Low(
                new JSONFile(config.txIterationStateDbPath)
            )
        }
        this.txConfirmationQueue = initTxConfirmationQueue(
            config.client,
            this.db.txIterationState,
            config.console,
            config.sources,
            config.destinations,
            _.get(config, 'dryRun', false),
        );
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

