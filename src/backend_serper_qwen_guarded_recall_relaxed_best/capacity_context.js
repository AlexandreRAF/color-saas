'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

// Propagates a vehicle identity through search, fetching and model helpers
// without coupling every provider function to the AgenticLoop class.
const capacityContext = new AsyncLocalStorage();
module.exports = { capacityContext };
