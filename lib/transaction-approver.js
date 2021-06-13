'use strict';

const _ = require('lodash');
const Async = require('async');
const Queue = require('better-queue');
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

function confirmTransaction(client, transactionId, address, keys) {
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

function initTxConfirmationQueue(client, txsToConfirm, sources, destinations) {
    const txApprovalPredicate = {
        transId: transId => BigInt(transId) > 0n,
        src: src => _.has(sources, src),
        dest: dest => _.includes(destinations, dest)
    }

    return new Queue(({ tx, ...txInfo }, cb) => {
        _.merge(txsToConfirm, { [tx]: txInfo });

        const txToConfirm = txsToConfirm[tx];

        if (!_.conformsTo(txToConfirm, txApprovalPredicate)) {
            return cb();
        }

        debug(`transaction to confirm: ${JSON.stringify(txToConfirm, null, 2)}`);

        const address = txToConfirm.src;
        const custodians = sources[address];

        Async.eachOf(custodians, (keys, index, cb) => {
            const retryOpts = {
                times: 4,
                interval: retryCount => 30000 * Math.pow(2, retryCount - 1) // 30s, 1m, 2m, ...
            }

            Async.retry(retryOpts, cb => {
                confirmTransaction(client, txToConfirm.transId, address, keys)
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
        }, err => {
            if (_.isNil(err)) {
                delete txsToConfirm[tx];
            }

            cb(err);
        });
    });
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
        this.txsToConfirm = {}
        this.txConfirmationQueue = initTxConfirmationQueue(
            this.client,
            this.txsToConfirm,
            config.sources,
            config.destinations
        );
        this.config = config;
    }

    monitorMessages() {
        const params = {
            collection: 'messages',
            filter: {
                dst: { in: _.keys(this.config.sources) },
                msg_type: { eq: 1 },
                OR: {
                    src: { in: _.keys(this.config.sources) },
                    msg_type: { eq: 2 }
                }
            },
            result: 'msg_type body dst_transaction { id } src src_transaction { id }'
        }
        const handler = async doc => {
            let result = _.get(doc, 'result');

            if (!result) return;

            result.body = await decodeMessageBody(this.client, result.body);

            const relevant = _
                .chain(result)
                .get('body.name')
                .eq('submitTransaction')
                .value();

            if (!relevant) return;

            let txPartialInfo;

            switch (_.get(result, 'msg_type')) {
                case 1: {
                    txPartialInfo = {
                        tx: _.get(result, 'dst_transaction.id'),
                        dest: _.get(result, 'body.value.dest'),
                        value: _.get(result, 'body.value.value', 0)
                    }
                } break;
                case 2: {
                    txPartialInfo = {
                        tx: _.get(result, 'src_transaction.id'),
                        transId: _.get(result, 'body.value.transId', 0),
                        src: _.get(result, 'src')
                    }
                } break;
                default: throw new Error('unexpected message type');
            }

            this.txConfirmationQueue.push(txPartialInfo);
        };

        return this.client.net.subscribe_collection(params, handler);
    }

    async run() {
        const inProgress = _.has(this.subscription, 'handle');

        if (inProgress) {
            throw new Error('Messages are already being monitored');
        }

        this.subscription = await this.monitorMessages();
    }
}

module.exports = TransactionApprover;
