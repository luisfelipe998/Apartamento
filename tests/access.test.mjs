import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { encryptAccess, decryptAccess } from '../public/access-crypto.js';
import { createGiftClient } from '../public/client.js';
import { buildAccess } from '../scripts/build.mjs';
import { createStaticServer } from '../scripts/serve.mjs';

test('the password unlocks AES-GCM credentials; wrong passwords and tampering fail', async () => {
  const payload = { token: 'a-dummy-token-that-must-stay-encrypted', mode: 'github' };
  const envelope = await encryptAccess(payload, 'test-invitation-password');
  assert.ok(!JSON.stringify(envelope).includes(payload.token));
  assert.deepEqual(await decryptAccess(envelope, 'test-invitation-password'), payload);
  await assert.rejects(decryptAccess(envelope, 'wrong'), { status: 401 });
  const damaged = { ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) };
  await assert.rejects(decryptAccess(damaged, 'test-invitation-password'), { status: 401 });
  await assert.rejects(decryptAccess({ ...envelope, iterations: 999999999 }, 'test-invitation-password'));
});

test('build creates an encrypted credential file and refuses a production deploy without a token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apartamento-build-test-'));
  try {
    const destination = pathToFileURL(join(directory, 'access.json'));
    const mode = await buildAccess({ GITHUB_TOKEN: 'test-only-token', GIFT_PASSWORD: 'password' }, destination);
    assert.equal(mode, 'github');
    const text = await readFile(destination, 'utf8');
    assert.ok(!text.includes('test-only-token'));
    assert.equal((await decryptAccess(JSON.parse(text), 'password')).issueNumber, 1);
    await assert.rejects(buildAccess({ REQUIRE_GITHUB_TOKEN: 'true' }, destination));
    await assert.rejects(buildAccess({ GITHUB_ISSUE_NUMBER: '../other' }, destination));
    assert.equal(await buildAccess({}, destination), 'demo');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production builds reject missing or default passwords before writing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apartamento-production-test-'));
  try {
    const destination = pathToFileURL(join(directory, 'access.json'));
    const env = {
      GITHUB_TOKEN: 'test-only-production-token',
      GIFT_PASSWORD: 'test-invitation-password',
      REQUIRE_GITHUB_TOKEN: 'true',
      REQUIRE_GIFT_PASSWORD: 'true',
    };
    assert.equal(await buildAccess(env, destination), 'github');
    const previous = await readFile(destination, 'utf8');
    assert.equal((await decryptAccess(JSON.parse(previous), env.GIFT_PASSWORD)).token, env.GITHUB_TOKEN);
    for (const password of [undefined, '', '   ', 'password', ' Password ']) {
      await assert.rejects(buildAccess({ ...env, GIFT_PASSWORD: password }, destination), /GIFT_PASSWORD/);
      assert.equal(await readFile(destination, 'utf8'), previous);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser clients preserve giver ownership, reject other guests, and keep credentials out of storage', async () => {
  const envelope = await encryptAccess({ mode: 'demo', owner: 'luisfelipe998', repo: 'Apartamento', issueNumber: 1, author: 'luisfelipe998' }, 'password');
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const fetchImpl = async () => Response.json(envelope);
  const alice = createGiftClient({ fetchImpl, storage });
  const bob = createGiftClient({ fetchImpl, storage });
  await assert.rejects(alice.getReservations(), { status: 401 });
  await assert.rejects(alice.login('wrong', 'a'.repeat(43)), { status: 401 });
  assert.equal((await alice.login('password', 'a'.repeat(43))).mode, 'demo');
  await bob.login('password', 'b'.repeat(43));
  const reserved = await alice.reserve('cafeteira');
  assert.equal(reserved.reservations.cafeteira.mine, true);
  assert.equal((await bob.getReservations()).reservations.cafeteira.mine, false);
  await assert.rejects(bob.reserve('cafeteira', 'Bruno'), { status: 409 });
  await assert.rejects(bob.release('cafeteira'), { status: 403 });
  const resumed = createGiftClient({ fetchImpl, storage });
  await resumed.login('password', 'a'.repeat(43));
  assert.equal((await resumed.getReservations()).reservations.cafeteira.mine, true);
  assert.deepEqual(Object.keys((await resumed.release('cafeteira')).reservations), []);
  assert.ok(!JSON.stringify([...memory]).includes('password'));
  alice.logout();
  assert.equal(alice.isLoggedIn(), false);
  await assert.rejects(alice.getReservations(), { status: 401 });
});

test('the local preview serves only public files and never the env file or an API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apartamento-static-test-'));
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<h1>Casa nova</h1>');
  await writeFile(join(directory, '.env'), 'GITHUB_TOKEN=private-test-value');
  const server = createStaticServer(join(directory, 'public'));
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(origin + '/')).status, 200);
    for (const path of ['/.env', '/../.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/scripts/build.mjs', '/api/session']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes('private-test-value'));
    }
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
