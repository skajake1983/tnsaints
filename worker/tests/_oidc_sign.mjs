// Test-only signer for the mock Google provider in test_portal_google.py.
//
// Python's standard library cannot produce RSA signatures, so the suite calls
// this with the same `jose` library the Worker uses to verify:
//
//   node tests/_oidc_sign.mjs keys                 -> {"public": JWK, "private": JWK}
//   node tests/_oidc_sign.mjs sign <keys.json>     -> reads claims JSON on stdin,
//                                                     prints an RS256 JWT
//
// The keys are generated per run and never leave the test process.
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';
import { readFileSync } from 'node:fs';

const [cmd, keyFile] = process.argv.slice(2);

if (cmd === 'keys') {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  // A fresh key id per run. The Worker caches a provider's key set per
  // isolate; reusing an id would pair a new key with a cached old one.
  const kid = `test-${crypto.randomUUID()}`;
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid, alg: 'RS256' };
  process.stdout.write(JSON.stringify({ public: pub, private: priv }));
} else if (cmd === 'sign') {
  const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
  const claims = JSON.parse(readFileSync(0, 'utf8'));
  const key = await importJWK(keys.private, 'RS256');
  const { exp, iat, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT(rest)
    .setProtectedHeader({ alg: 'RS256', kid: keys.private.kid, typ: 'JWT' })
    .setIssuedAt(iat ?? now)
    .setExpirationTime(exp ?? now + 3600)
    .sign(key);
  process.stdout.write(jwt);
} else {
  process.stderr.write('usage: keys | sign <keys.json>\n');
  process.exit(2);
}
