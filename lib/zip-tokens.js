// Shared HMAC download-token logic for per-user TAK data packages.
// Used by telemetry_bridge.js (issue on generation, verify on download) and by
// bin/issue-zip-token.js (a CLI so fix-certs.sh --reissue-all can mint links for
// packages it rebuilds outside the bridge's HTTP API). Both must sign against the
// exact same secret and serial store, so this logic lives in one place rather
// than being duplicated between the server and the CLI.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createZipTokenStore(configDir) {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  const secretFile = path.join(configDir, 'zip-token-secret');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const secret = Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'hex');

  const serialsFile = path.join(configDir, 'zip_tokens.json');
  if (!fs.existsSync(serialsFile)) fs.writeFileSync(serialsFile, JSON.stringify({}, null, 2));
  let serials = JSON.parse(fs.readFileSync(serialsFile));
  function saveSerials() { fs.writeFileSync(serialsFile, JSON.stringify(serials, null, 2)); }

  const TTL_SECONDS = parseInt(process.env.ZIP_TOKEN_TTL_SECONDS, 10) || 1800;

  function signature(username, exp, serial) {
    return crypto.createHmac('sha256', secret)
      .update(`${username}|${exp}|${serial}`)
      .digest('base64url');
  }

  function issueZipToken(username) {
    const serial = serials[username] || 0;
    const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    return `${exp}.${serial}.${signature(username, exp, serial)}`;
  }

  function revokeZipTokens(username) {
    serials[username] = (serials[username] || 0) + 1;
    saveSerials();
  }

  function verifyZipToken(username, token) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const exp = parseInt(parts[0], 10);
    const serial = parseInt(parts[1], 10);
    if (!Number.isFinite(exp) || !Number.isFinite(serial)) return false;
    if (exp < Math.floor(Date.now() / 1000)) return false;
    if (serial !== (serials[username] || 0)) return false;
    const expected = Buffer.from(signature(username, exp, serial));
    const given = Buffer.from(parts[2]);
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
  }

  return { issueZipToken, revokeZipTokens, verifyZipToken };
};
