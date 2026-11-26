import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGiftCatalog } from '../public/catalog.js';

const production = 'https://luisfelipe998.github.io/Apartamento/';
const raw = 'https://raw.githubusercontent.com/luisfelipe998/Apartamento/main/public/';
const gift = (id = 'presente-novo') => ({ id, name: 'Presente novo', images: ['./assets/gifts/novo.jpg'] });
const ok = (data) => ({ ok: true, json: async () => data });

test('production reads new gifts and their photos from main without requiring a Pages copy or credentials', async () => {
  let request;
  const catalog = await loadGiftCatalog({ pageUrl: production, requestId: 'first', fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return ok({ title: 'Nossa casa', subtitle: 'Presentes', items: [gift()] });
  } });
  assert.equal(request.url, raw + 'data/items.json?v=first');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers, undefined);
  assert(request.options.signal instanceof AbortSignal);
  assert.equal(catalog.title, 'Nossa casa');
  assert.equal(catalog.subtitle, 'Presentes');
  assert.equal(catalog.items[0].category, 'Para a casa');
  assert.equal(catalog.items[0].images[0].src, raw + 'assets/gifts/novo.jpg?v=first');
});

test('another refresh fetches the updated catalog and changes the version of repository photos', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return ok({ items: requests.length === 1 ? [gift('antigo')] : [gift('novo'), gift('adicionado')] });
  };
  const first = await loadGiftCatalog({ pageUrl: production, fetchImpl, requestId: 'one' });
  const second = await loadGiftCatalog({ pageUrl: production, fetchImpl, requestId: 'two' });
  assert.deepEqual(first.items.map(({ id }) => id), ['antigo']);
  assert.deepEqual(second.items.map(({ id }) => id), ['novo', 'adicionado']);
  assert.notEqual(requests[0], requests[1]);
  assert.equal(second.items[0].images[0].src, raw + 'assets/gifts/novo.jpg?v=two');
});

test('local previews preserve their subpath and use local uncommitted photos', async () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://preview.localhost:3000']) {
    let requested;
    const result = await loadGiftCatalog({ pageUrl: origin + '/Apartamento/index.html', requestId: 'local',
      fetchImpl: async (url) => { requested = String(url); return ok({ items: [gift()] }); } });
    assert.equal(requested, origin + '/Apartamento/data/items.json?v=local');
    assert.equal(result.items[0].images[0].src, origin + '/Apartamento/assets/gifts/novo.jpg');
  }
  let fileRequest;
  await loadGiftCatalog({ pageUrl: 'file:///tmp/preview/index.html', requestId: 'file',
    fetchImpl: async (url) => { fileRequest = String(url); return ok({ items: [] }); } });
  assert.equal(fileRequest, 'file:///tmp/preview/data/items.json?v=file');
});

test('external photos retain their queries and safe purchase links retain their labels', async () => {
  const external = 'https://images.example.com/photo.jpg?width=800&v=original#photo';
  const item = { ...gift(), images: [external, { url: './assets/detail.jpg?size=small', alt: 'Detalhe' },
    'javascript:alert(1)', 'https://user:secret@images.example.com/private.jpg'],
  links: [{ url: 'https://www.amazon.com.br/s?k=presente', label: 'Buscar na Amazon' },
    { url: '/relative', label: 'Inválido' }, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com/' }] };
  const result = await loadGiftCatalog({ pageUrl: 'https://presentes.example.org/', requestId: 'current',
    fetchImpl: async () => ok({ items: [item] }) });
  assert.deepEqual(result.items[0].images, [{ src: external, alt: 'Presente novo' },
    { src: raw + 'assets/detail.jpg?size=small&v=current', alt: 'Detalhe' }]);
  assert.deepEqual(result.items[0].links, [{ url: 'https://www.amazon.com.br/s?k=presente', label: 'Buscar na Amazon' }]);
});

test('invalid IDs, duplicate IDs and malformed catalog entries fail before reaching the UI', async () => {
  for (const data of [null, {}, { items: {} }, { items: [null] }, { items: [gift('../unsafe')] },
    { items: [gift('a'.repeat(81))] }, { items: [gift(), gift()] }, { items: [{ ...gift(), name: null }] }]) {
    await assert.rejects(loadGiftCatalog({ pageUrl: production, fetchImpl: async () => ok(data) }), /Confira os dados/);
  }
});

test('HTTP, network and malformed JSON failures give a Portuguese error without falling back to a stale copy', async () => {
  for (const response of [async () => ({ ok: false }), async () => { throw new Error('Network unavailable'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } })]) {
    const requests = [];
    await assert.rejects(loadGiftCatalog({ pageUrl: production, fetchImpl: async (url) => {
      requests.push(String(url));
      return response();
    } }), /presentes/);
    assert.equal(requests.length, 1);
    assert(requests[0].startsWith(raw));
  }
});
