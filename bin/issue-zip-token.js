#!/usr/bin/env node
// Mints (and prints) a fresh download URL for an already-built user package,
// using the exact same secret/serial store as the bridge's HTTP API.
//
// Used by fix-certs.sh --reissue-all: after it rebuilds a user's package with
// bin/generate-user-zip.sh (following a Root CA rotation), it calls this
// inside the telemetry-bridge container — the only place config/zip-token-secret
// is mounted — to hand back a working link without going through a browser.
//
// Usage: node bin/issue-zip-token.js <username>
const path = require('path');
const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
  console.error('Usage: issue-zip-token.js <username>');
  process.exit(1);
}

const createZipTokenStore = require(path.join(__dirname, '..', 'lib', 'zip-tokens.js'));
const { issueZipToken, revokeZipTokens } = createZipTokenStore(path.join(__dirname, '..', 'config'));

// This follows a fresh cert rebuild, so any link issued against the old
// package is already dead — revoke first to keep the serial consistent.
revokeZipTokens(username);
const token = issueZipToken(username);
const publicHost = process.env.PUBLIC_HOST || 'ares-werx.com';
console.log(`https://${publicHost}/user-zips/${username}.zip?t=${token}`);
