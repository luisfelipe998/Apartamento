const DATABASE_NAME = 'casa-nova.access.v1';
const OBJECT_STORE = 'keys';

function defaultDatabase() {
  try { return globalThis.indexedDB; } catch { return undefined; }
}
function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}
function validKey(key) {
  return key?.type === 'secret' && key.extractable === false
    && key.algorithm?.name === 'PBKDF2' && key.usages?.includes('deriveKey');
}

/** Only a nonextractable derivation key enters IndexedDB. The synchronous marker
 * blocks a reload from restoring an old key while logout deletion is pending. */
export function createSessionStore({ indexedDB = defaultDatabase(), storage = defaultStorage(),
  scope = new URL('./access.json', import.meta.url).href } = {}) {
  const markerKey = 'casa-nova.access-state.v1:' + scope;
  let database;
  let queued = Promise.resolve();
  let loadedMarker = null;
  function marker() {
    try { return storage?.getItem(markerKey) ?? null; } catch { return null; }
  }
  function mark(value) {
    try {
      if (!storage?.setItem) return false;
      storage.setItem(markerKey, value);
      return marker() === value;
    } catch { return false; }
  }
  function open() {
    if (!indexedDB?.open) return Promise.resolve(null);
    if (database) return database;
    database = new Promise((resolve) => {
      let request;
      try { request = indexedDB.open(DATABASE_NAME, 1); } catch { resolve(null); return; }
      let settled = false;
      const finish = (connection) => {
        if (settled) { connection?.close(); return; }
        settled = true;
        clearTimeout(timer);
        if (!connection) database = undefined;
        resolve(connection);
      };
      const timer = setTimeout(() => finish(null), 2500);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) request.result.createObjectStore(OBJECT_STORE);
      };
      request.onsuccess = () => {
        const connection = request.result;
        connection.onversionchange = () => { connection.close(); database = undefined; };
        finish(connection);
      };
      request.onerror = request.onblocked = () => finish(null);
    });
    return database;
  }
  async function transaction(mode, operation) {
    const connection = await open();
    if (!connection) return null;
    return new Promise((resolve) => {
      let tx;
      let request;
      try {
        tx = connection.transaction(OBJECT_STORE, mode);
        request = operation(tx.objectStore(OBJECT_STORE));
      } catch { resolve(null); return; }
      let value = null;
      request.onsuccess = () => { value = request.result ?? true; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => resolve(null);
    });
  }
  function enqueue(operation) {
    const pending = queued.then(operation).catch(() => null);
    queued = pending;
    return pending;
  }
  return {
    async load() {
      const expected = marker();
      if (!expected?.startsWith('active:')) return null;
      const record = await enqueue(() => transaction('readonly', (store) => store.get(scope)));
      if (marker() !== expected || record?.generation !== expected.slice(7) || !validKey(record.key)) return null;
      loadedMarker = expected;
      return record.key;
    },
    save(key) {
      if (!validKey(key)) return Promise.resolve(false);
      const generation = crypto.randomUUID();
      const pendingMarker = 'pending:' + generation;
      loadedMarker = null;
      if (!mark(pendingMarker)) return Promise.resolve(false);
      return enqueue(async () => {
        if (marker() !== pendingMarker) return false;
        const written = await transaction('readwrite', (store) => store.put({ key, generation }, scope));
        if (!written || marker() !== pendingMarker) return false;
        const activeMarker = 'active:' + generation;
        if (!mark(activeMarker)) return false;
        loadedMarker = activeMarker;
        return true;
      });
    },
    clear() {
      // This runs before any await, including when the caller immediately reloads.
      loadedMarker = null;
      mark('logout:' + crypto.randomUUID());
      return enqueue(() => transaction('readwrite', (store) => store.delete(scope))).then(() => undefined);
    },
    isCurrent() { return loadedMarker !== null && marker() === loadedMarker; },
  };
}
