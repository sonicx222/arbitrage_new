// Jest custom reporters are loaded via Node's require(), so we need a JS entrypoint.
// This wrapper registers ts-node to compile the TypeScript reporter on the fly.

require('ts-node/register/transpile-only');

module.exports = require('./slow-test-reporter.ts').default;
