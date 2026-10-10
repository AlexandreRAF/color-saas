const serper = require('./browse');
const brave = require('./brave_browse');
const openserp = require('./openserp_browse');

const providers = { brave, serper, openserp };

function searchProvider(value = process.env.SEARCH_PROVIDER || 'serper') {
  const provider = String(value).trim().toLowerCase();
  if (!Object.hasOwn(providers, provider)) throw new Error('SEARCH_PROVIDER must be openserp, brave or serper');
  return provider;
}

function browse(queries, options = {}) {
  return providers[searchProvider(options.provider)].browse(queries, options);
}

module.exports = { browse, searchProvider };
