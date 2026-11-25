import { decryptAccessWithKey, importPasswordKey } from './access-crypto.js';
import { GitHubStore } from './github-store.js';
import { createSessionStore } from './session-store.js';

const DEMO_KEY = 'casa-nova.demo-comments.v1';
function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function createDemoTransport(storage, author) {
  let memory = [];
  function read() {
    try {
      const stored = JSON.parse(storage?.getItem(DEMO_KEY) || 'null');
      if (Array.isArray(stored)) memory = stored;
    } catch { /* A demo still works without browser storage. */ }
    return memory;
  }
  return async (address, options = {}) => {
    const url = new URL(address);
    const comments = read();
    if (options.method === 'POST') {
      const { body } = JSON.parse(options.body);
      const id = comments.reduce((largest, comment) => Math.max(largest, comment.id), 0) + 1;
      const comment = { id, body, user: { login: author }, created_at: new Date().toISOString() };
      memory = [...comments, comment];
      try { storage?.setItem(DEMO_KEY, JSON.stringify(memory)); } catch { /* Memory fallback. */ }
      return Response.json(comment, { status: 201 });
    }
    const page = Number(url.searchParams.get('page') || '1');
    return Response.json(comments.slice((page - 1) * 100, page * 100));
  };
}

export function createGiftClient({ fetchImpl = globalThis.fetch, storage = defaultStorage(),
  accessUrl = new URL('./access.json', import.meta.url),
  sessionStore = createSessionStore({ storage, scope: String(accessUrl) }) } = {}) {
  let store = null;
  let ownerId = '';
  let lastSnapshot = new Map();
  let revision = 0;
  function clearMemory() { store = null; ownerId = ''; lastSnapshot = new Map(); }
  function validateDevice(deviceKey) {
    if (typeof deviceKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(deviceKey)) {
      throw new Error('Não conseguimos identificar este navegador. Atualize a página.');
    }
  }
  async function prepare(material, deviceKey) {
    validateDevice(deviceKey);
    const response = await fetchImpl(accessUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('A lista ainda não está disponível. Tente novamente mais tarde.');
    const config = await decryptAccessWithKey(await response.json(), material);
    if (!config || !['demo', 'github'].includes(config.mode)) throw new Error('A configuração da lista está indisponível.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceKey));
    const nextOwnerId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const transport = config.mode === 'demo' ? createDemoTransport(storage, config.author) : fetchImpl;
    const nextStore = new GitHubStore({ ...config, token: config.mode === 'demo' ? 'local-demo' : config.token, fetchImpl: transport });
    return { store: nextStore, ownerId: nextOwnerId, mode: config.mode };
  }
  function activate(prepared) {
    store = prepared.store;
    ownerId = prepared.ownerId;
    lastSnapshot = new Map();
    return { mode: prepared.mode };
  }
  function requireLogin() {
    if (!store) throw Object.assign(new Error('Digite a senha do convite para abrir a lista.'), { status: 401 });
  }
  function present(snapshot) {
    lastSnapshot = snapshot;
    const reservations = Object.create(null);
    for (const [itemId, value] of snapshot) {
      reservations[itemId] = { giver: value.giverName, reservedAt: value.reservedAt,
        mine: value.ownerId === ownerId, reservationId: value.reservationId };
    }
    return { reservations, updatedAt: new Date().toISOString() };
  }
  async function snapshotOperation(operation) {
    requireLogin();
    const activeStore = store;
    const activeRevision = revision;
    const snapshot = await operation(activeStore);
    if (activeRevision !== revision || activeStore !== store) {
      throw Object.assign(new Error('Sua sessão terminou. Abra a lista novamente para continuar.'), { status: 401 });
    }
    return present(snapshot);
  }
  return {
    async login(password, deviceKey) {
      const operation = ++revision;
      clearMemory();
      validateDevice(deviceKey);
      const material = await importPasswordKey(password);
      const prepared = await prepare(material, deviceKey);
      if (operation !== revision) throw Object.assign(new Error('A entrada foi cancelada. Digite a senha novamente.'), { status: 401 });
      try { await sessionStore.save(material); } catch { /* Login still works when storage is unavailable. */ }
      if (operation !== revision) throw Object.assign(new Error('A entrada foi cancelada. Digite a senha novamente.'), { status: 401 });
      return activate(prepared);
    },
    async restore(deviceKey) {
      const operation = ++revision;
      clearMemory();
      try {
        validateDevice(deviceKey);
        const material = await sessionStore.load();
        if (!material || operation !== revision) return null;
        const prepared = await prepare(material, deviceKey);
        if (operation !== revision || (sessionStore.isCurrent && !sessionStore.isCurrent())) return null;
        return activate(prepared);
      } catch (error) {
        if (error.status === 401 && operation === revision) {
          try { await sessionStore.clear(); } catch { /* A failed key is never activated. */ }
        }
        return null;
      }
    },
    async getReservations() {
      return snapshotOperation((activeStore) => activeStore.snapshot());
    },
    async reserve(itemId, giverName = 'Convidado') {
      return snapshotOperation((activeStore) => activeStore.reserve({ itemId, giverName: giverName.trim(), ownerId }));
    },
    async release(itemId) {
      requireLogin();
      const reservationId = lastSnapshot.get(itemId)?.reservationId;
      if (!reservationId) throw Object.assign(new Error('Atualize a lista antes de liberar este presente.'), { status: 409 });
      return snapshotOperation((activeStore) => activeStore.release({ itemId, ownerId, reservationId }));
    },
    logout() {
      revision += 1;
      clearMemory();
      // clear() writes the logout marker synchronously before deleting IndexedDB.
      try { return Promise.resolve(sessionStore.clear()).catch(() => {}); } catch { return Promise.resolve(); }
    },
    isLoggedIn() { return store !== null; },
  };
}
