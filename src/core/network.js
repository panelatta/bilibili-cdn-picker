'use strict';

const { digest } = require('./hash');

// Builds a local network fingerprint (design §8.2). SSID/carrier are only fed
// into a salted digest; they are never stored or logged in clear text.
// Without a usable identity the profile is scoped to the current network
// generation, so unknown networks never share one long-lived winner.
function networkContext(network, options) {
  const opts = options || {};
  const net = network && typeof network === 'object' ? network : {};
  const wifi = net.wifi || {};
  const v4 = net.v4 || {};
  const v6 = net.v6 || {};
  const cell = net['cellular-data'] || {};
  const iface = String(v4.primaryInterface || v6.primaryInterface || '');

  let type = 'unknown';
  if (wifi.ssid || /^en\d/.test(iface)) type = 'wifi';
  else if (/^pdp_ip/.test(iface) || (!iface && cell.radio)) type = 'cellular';

  let identity = null;
  if (type === 'wifi' && wifi.ssid) identity = 'ssid:' + wifi.ssid;
  else if (type === 'cellular' && cell.carrier) identity = 'carrier:' + cell.carrier;

  const known = identity !== null;
  const scope = known ? identity : 'unknown@' + (opts.generation || 0);
  const key = digest([opts.salt || '', type, scope, opts.routeRevision || '', opts.probePolicy || ''].join('\n'));
  const typeLabel = type === 'wifi' ? 'Wi-Fi' : type === 'cellular' ? '蜂窝' : '未知网络';
  return {
    type,
    known,
    key,
    label: typeLabel + ' #' + key.slice(0, 4),
    cellular: type === 'cellular',
  };
}

module.exports = { networkContext };
