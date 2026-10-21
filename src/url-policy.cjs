'use strict';

/**
 * Accept only credential-free HTTP(S) addresses for browser navigation.
 * The browser deliberately does not accept file:, javascript:, data:, or
 * custom protocols through its address bar or the open-external bridge.
 */
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

module.exports = { safeHttpUrl };
