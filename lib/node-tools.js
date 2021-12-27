'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const exec = util.promisify(require('child_process').exec);

const execOpts = {
    timeout: 60000,
    killSignal: 'SIGKILL'
}

function execConsole(config, ...commands) {
    const requirement = [
        _.chain(config).get('client.privateKey').isString().value(),
        _.chain(config).get('server.host').isString().value(),
        _.chain(config).get('server.port').isInteger().value(),
        _.chain(config).get('server.publicKey').isString().value()
    ];

    if (! _.every(requirement)) {
        throw new Error('execConsole: wrong console configuration');
    }

    const configFile = 'console.json';

    if (! fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, JSON.stringify({
            config: {
                client_key: {
                    type_id: 1209251014,
                    pvt_key: config.client.privateKey
                },
                server_address: `${config.server.host}:${config.server.port}`,
                server_key: {
                    type_id: 1209251014,
                    pub_key: config.server.publicKey
                },
                timeouts: null
            }
        }));
    }

    return exec(
        `console -j -C ${configFile} \
            ${[...commands].map(c => `-c '${c}'`).join(' ')}`,
        execOpts);
}

module.exports = {
    execConsole,
}
