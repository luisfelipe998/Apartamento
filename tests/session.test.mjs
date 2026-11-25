import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptAccess, importPasswordKey, decryptAccessWithKey } from '../public/access-crypto.js';
import { createGiftClient } from '../public/client.js';
import { createSessionStore } from '../public/session-store.js';

const DEVICE = 'a'.repeat(43);
const PASSWORD = 'test-invitation-password';
const CONFIG = { mode: 'github', owner: 'luisfelipe998', repo: 'Apartamento', issueNumber: 1,
  author: 'luisfelipe998', token: 'dummy-token-never-persisted' };

function memoryStorage() {
  const entries = new Map();
  return { entries, getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}
function memorySession() {
  let key = null;
  return {
    peek: () => key,
    async load() { return key && structuredClone(key); },
    async save(value) { key = structuredClone(value); return true; },
    clear() { key = null; return Promise.resolve(); },
  };
}
function fixture(envelope, sessionStore = memorySession()) {
  const storage = memoryStorage();
  const apiRequests = [];
  const state = { envelope };
  const options = { storage, sessionStore, fetchImpl: async (url, request) => {
    if (String(url).startsWith('https://api.github.com/')) {
      apiRequests.push(request);
      return Response.json([]);
    }
    return Response.json(state.envelope);
  } };
  return { state, storage, sessionStore, apiRequests, client: () => createGiftClient(options) };
}

test('a new client restores after reload using only a nonextractable PBKDF2 key', async () => {
  const setup = fixture(await encryptAccess(CONFIG, PASSWORD));
  const first = setup.client();
  assert.equal(await first.restore(DEVICE), null);
  assert.deepEqual(await first.login(PASSWORD, DEVICE), { mode: 'github' });
  const saved = setup.sessionStore.peek();
  assert.equal(saved.type, 'secret');
  assert.equal(saved.algorithm.name, 'PBKDF2');
  assert.equal(saved.extractable, false);
  assert.deepEqual(saved.usages, ['deriveKey']);
  await assert.rejects(crypto.subtle.exportKey('raw', saved));
  assert.equal(JSON.stringify(saved), '{}');
  assert.equal(JSON.stringify([...setup.storage.entries]).includes(PASSWORD), false);
  assert.equal(JSON.stringify([...setup.storage.entries]).includes(CONFIG.token), false);
  const reloaded = setup.client();
  assert.deepEqual(await reloaded.restore(DEVICE), { mode: 'github' });
  assert.equal(reloaded.isLoggedIn(), true);
  assert.deepEqual(Object.keys((await reloaded.getReservations()).reservations), []);
});

test('the saved base key survives new build salts and obtains updated encrypted credentials', async () => {
  const setup = fixture(await encryptAccess(CONFIG, PASSWORD));
  await setup.client().login(PASSWORD, DEVICE);
  const oldSalt = setup.state.envelope.salt;
  setup.state.envelope = await encryptAccess({ ...CONFIG, token: 'rotated-dummy-token' }, PASSWORD);
  assert.notEqual(setup.state.envelope.salt, oldSalt);
  const reloaded = setup.client();
  assert.deepEqual(await reloaded.restore(DEVICE), { mode: 'github' });
  await reloaded.getReservations();
  assert.equal(setup.apiRequests.at(-1).headers.Authorization, 'Bearer rotated-dummy-token');
  assert.deepEqual(await decryptAccessWithKey(setup.state.envelope, setup.sessionStore.peek()), { ...CONFIG, token: 'rotated-dummy-token' });
});

test('a changed invitation password invalidates remembered access and requires a new login', async () => {
  const setup = fixture(await encryptAccess(CONFIG, PASSWORD));
  await setup.client().login(PASSWORD, DEVICE);
  setup.state.envelope = await encryptAccess(CONFIG, 'a-new-invitation-password');
  const reloaded = setup.client();
  assert.equal(await reloaded.restore(DEVICE), null);
  assert.equal(reloaded.isLoggedIn(), false);
  assert.equal(setup.sessionStore.peek(), null);
  await assert.rejects(reloaded.getReservations(), { status: 401 });
  assert.deepEqual(await reloaded.login('a-new-invitation-password', DEVICE), { mode: 'github' });
});

test('logout clears active access immediately and prevents restore in a new client', async () => {
  const setup = fixture(await encryptAccess(CONFIG, PASSWORD));
  const client = setup.client();
  await client.login(PASSWORD, DEVICE);
  const clearing = client.logout();
  assert(clearing instanceof Promise);
  assert.equal(client.isLoggedIn(), false);
  await assert.rejects(client.getReservations(), { status: 401 });
  assert.equal(await setup.client().restore(DEVICE), null);
  await clearing;
  assert.equal(setup.sessionStore.peek(), null);
});

test('logout wins over an in-flight restore and leaves no active session', async () => {
  const sessionStore = memorySession();
  await sessionStore.save(await importPasswordKey(PASSWORD));
  let finishFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const envelope = await encryptAccess(CONFIG, PASSWORD);
  const client = createGiftClient({ sessionStore, fetchImpl: () => {
    fetchStarted();
    return new Promise((resolve) => { finishFetch = () => resolve(Response.json(envelope)); });
  } });
  const restoring = client.restore(DEVICE);
  await started;
  await client.logout();
  finishFetch();
  assert.equal(await restoring, null);
  assert.equal(client.isLoggedIn(), false);
  assert.equal(sessionStore.peek(), null);
});

test('logout wins over a password login whose credential fetch is still pending', async () => {
  const sessionStore = memorySession();
  let finishFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const envelope = await encryptAccess(CONFIG, PASSWORD);
  const client = createGiftClient({ sessionStore, fetchImpl: () => {
    fetchStarted();
    return new Promise((resolve) => { finishFetch = () => resolve(Response.json(envelope)); });
  } });
  const loggingIn = client.login(PASSWORD, DEVICE);
  await started;
  await client.logout();
  finishFetch();
  await assert.rejects(loggingIn, { status: 401 });
  assert.equal(client.isLoggedIn(), false);
  assert.equal(sessionStore.peek(), null);
});

test('unavailable IndexedDB degrades to a working login without remembered access', async () => {
  const storage = memoryStorage();
  const sessionStore = createSessionStore({ indexedDB: undefined, storage, scope: 'test-list' });
  const setup = fixture(await encryptAccess(CONFIG, PASSWORD), sessionStore);
  const client = setup.client();
  assert.deepEqual(await client.login(PASSWORD, DEVICE), { mode: 'github' });
  assert.equal(client.isLoggedIn(), true);
  assert.equal(await setup.client().restore(DEVICE), null);
  await client.logout();
  assert.equal(client.isLoggedIn(), false);
});

test('a synchronous logout marker blocks restore while IndexedDB deletion is still pending', async () => {
  const storage = memoryStorage();
  let finishOpening;
  let opens = 0;
  const indexedDB = { open() {
    opens += 1;
    const request = {};
    finishOpening = () => request.onerror();
    return request;
  } };
  const scope = 'test-delayed-logout';
  const markerKey = 'casa-nova.access-state.v1:' + scope;
  storage.setItem(markerKey, 'active:old-session');
  const first = createSessionStore({ indexedDB, storage, scope });
  const clearing = first.clear();
  assert.match(storage.getItem(markerKey), /^logout:/);
  const reloaded = createSessionStore({ indexedDB, storage, scope });
  assert.equal(await reloaded.load(), null);
  await Promise.resolve();
  assert.equal(opens, 1);
  finishOpening();
  await clearing;
});
