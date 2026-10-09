'use strict';

const dns = require('node:dns');
const net = require('node:net');

const { Agent, fetch } = require('undici');
const ipaddr = require('ipaddr.js');

const { cancelBody } = require('./page_response');

const blocked = () => Object.assign(new Error('Source pages must use public HTTP(S) destinations'),
  { code: 'PAGE_DESTINATION_BLOCKED' });

function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

function publicPageUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || !hostname.includes('.') && !net.isIP(hostname)
    || net.isIP(hostname) && !publicAddress(hostname)) throw blocked();
  return url;
}

// Validate the addresses actually given to the socket, not a separate DNS
// preflight that could be invalidated by rebinding before connection.
function publicLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    const settings = typeof options === 'number' ? { family: options } : options || {};
    lookup(hostname, { ...settings, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length || addresses.some(row => !publicAddress(row.address))) return callback(blocked());
      if (settings.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const dispatcher = new Agent({ connect: { lookup: publicLookup() } });

async function publicPageRequest(value, options = {}, request = fetch) {
  let url = publicPageUrl(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    options.signal?.throwIfAborted();
    const response = await request(url, { ...options, dispatcher, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    cancelBody(response.body);
    if (!location || redirects === 5) throw Object.assign(new Error('Source redirect limit reached or location missing'),
      { code: 'PAGE_REDIRECT_LIMIT' });
    url = publicPageUrl(new URL(location, url));
  }
}

module.exports = { publicPageRequest, publicPageUrl, publicAddress, publicLookup };
