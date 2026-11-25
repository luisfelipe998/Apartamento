import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { GitHubStore } from '../public/github-store.js';

const ALICE = 'a'.repeat(43);
const BOB = 'b'.repeat(43);
const TOKEN = 'test-only-github-secret';
const TIMESTAMP = '2026-11-25T10:30:00.000Z';
const RESERVATION = 'claim-11111111-1111-1111';

function event(overrides = {}) {
  return { action: 'reserve', itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE, reservationId: RESERVATION, timestamp: TIMESTAMP, ...overrides };
}

function comment(id, data = event(), author = 'luisfelipe998') {
  return { id, user: { login: author }, body: `Readable summary.\n\n<!-- apartamento-gift:v1 ${JSON.stringify(data)} -->` };
}

function mockGitHub(initialComments = []) {
  const comments = structuredClone(initialComments);
  const requests = [];
  let nextId = 1000;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      const created = { id: nextId++, user: { login: 'luisfelipe998' }, body: JSON.parse(options.body).body };
      comments.push(created);
      return Response.json(created, { status: 201 });
    }
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json(comments.slice((page - 1) * 100, page * 100));
  };
  return { comments, requests, fetchImpl, store: new GitHubStore({ token: TOKEN, fetchImpl }) };
}

function expectStatus(status) {
  return (error) => {
    assert.equal(error.status, status);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

test('loads every page and does not confuse unrelated or untrusted comments with reservations', async () => {
  const comments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, user: { login: 'luisfelipe998' }, body: 'An ordinary discussion comment.',
  }));
  comments.push(
    comment(101, event(), 'another-account'),
    comment(102, event({ itemId: 'dish-set' })),
  );
  const { store, requests } = mockGitHub(comments);
  const state = await store.snapshot();
  assert.deepEqual([...state.keys()], ['dish-set']);
  assert.deepEqual(requests.map(({ url }) => new URL(url).searchParams.get('page')), ['1', '2']);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal(requests[0].options.redirect, 'error');
});

test('fetches an empty last page when there are exactly 100 comments', async () => {
  const { store, requests } = mockGitHub(Array.from({ length: 100 }, (_, index) => comment(index + 1)));
  assert.equal((await store.snapshot()).size, 1);
  assert.equal(requests.length, 2);
});

test('replays chronological IDs safely, enforces transitions, and accepts a later reservation after release', async () => {
  const { store } = mockGitHub([
    comment('90071992547409935', event({ giverName: 'Bob', ownerId: BOB })),
    comment('90071992547409933', event({ action: 'release', ownerId: BOB })),
    comment('90071992547409931', event()),
    comment('90071992547409934', event({ action: 'release' })),
    comment('90071992547409932', event({ giverName: 'Bob', ownerId: BOB })),
  ]);
  assert.deepEqual((await store.snapshot()).get('coffee-maker'), { giverName: 'Bob', ownerId: BOB, reservedAt: TIMESTAMP, reservationId: RESERVATION });
});

test('ignores malformed markers, events, unsafe IDs, and invalid authors without failing the list', async () => {
  const malformed = [
    comment(1, { ...event(), action: 'delete' }),
    comment(2, { ...event(), timestamp: 'not-a-date' }),
    comment(3, { ...event(), ownerId: 'short' }),
    comment(4, { ...event(), itemId: '../other' }),
    comment(5, { ...event(), giverName: 'name\nnew line' }),
    comment(6, { ...event(), extra: 'field' }),
    comment(Number.MAX_SAFE_INTEGER + 1),
    { ...comment(7), body: '<!-- apartamento-gift:v1 {broken json} -->' },
    { ...comment(8), body: '<!-- apartamento-gift:v1 [] -->' },
    { ...comment(9), body: `${comment(9).body}\n${comment(10).body}` },
    { ...comment(11), body: 'x'.repeat(16_385) },
    { ...comment(12), user: { login: 42 } },
    comment(13, event({ itemId: 'dish-set' }), 'LUISFELIPE998'),
  ];
  const { store } = mockGitHub(malformed);
  assert.deepEqual([...(await store.snapshot()).keys()], ['dish-set']);
});

test('rereads competing claims from different browsers and only the first claim succeeds', async () => {
  const { fetchImpl, comments } = mockGitHub();
  const aliceStore = new GitHubStore({ token: TOKEN, fetchImpl });
  const bobStore = new GitHubStore({ token: TOKEN, fetchImpl });
  const results = await Promise.allSettled([
    aliceStore.reserve({ itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE }),
    bobStore.reserve({ itemId: 'coffee-maker', giverName: 'Bob', ownerId: BOB }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409);
  assert.equal(comments.length, 2);
  assert.equal((await bobStore.snapshot()).get('coffee-maker').ownerId, ALICE);
  const confirmed = await aliceStore.snapshot();
  assert.equal(confirmed.get('coffee-maker').reservationId, results[0].value.get('coffee-maker').reservationId);
});

test('reserve and release are idempotent and ownership is enforced', async () => {
  const { store, comments } = mockGitHub();
  const reservation = { itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE };
  await store.reserve(reservation);
  await store.reserve(reservation);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^Presente reservado: coffee-maker — Alice\./);
  await assert.rejects(store.release({ itemId: 'coffee-maker', ownerId: BOB }), expectStatus(403));
  assert.equal(comments.length, 1);
  const state = await store.release({ itemId: 'coffee-maker', ownerId: ALICE });
  assert.equal(state.size, 0);
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /^Reserva cancelada: coffee-maker — Alice\./);
  assert.match(comments[1].body, /"action":"release"/);
  await store.release({ itemId: 'coffee-maker', ownerId: ALICE });
  assert.equal(comments.length, 2);
  await store.reserve({ ...reservation, giverName: 'Bob', ownerId: BOB });
  assert.equal((await store.snapshot()).get('coffee-maker').ownerId, BOB);
});

test('uses a fresh snapshot before each write and preserves a reservation added elsewhere', async () => {
  const { store, comments } = mockGitHub();
  await store.snapshot();
  comments.push(comment(10, event({ ownerId: BOB, giverName: 'Bob' })));
  await assert.rejects(store.reserve({ itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE }), expectStatus(409));
  assert.equal(comments.length, 1);
});

test('keeps the JSON marker parseable and display names do not trigger mentions or markup', async () => {
  const { store, comments } = mockGitHub();
  const giverName = '@friend #123 <!-- x --> [name](url) & Alice';
  await store.reserve({ itemId: 'coffee-maker', giverName, ownerId: ALICE });
  assert.equal(comments[0].body.includes('@friend'), false);
  assert.equal(comments[0].body.includes('#123'), false);
  assert.equal(comments[0].body.match(/<!--/g).length, 1);
  assert.equal(comments[0].body.includes(TOKEN), false);
  assert.equal((await store.snapshot()).get('coffee-maker').giverName, giverName);
});

test('rejects invalid mutation input before making a GitHub request', async () => {
  const { store, requests } = mockGitHub();
  const reservation = { itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE };
  for (const invalid of [
    { ...reservation, itemId: '../../bad' },
    { ...reservation, ownerId: 'short' },
    { ...reservation, giverName: '' },
    { ...reservation, giverName: 'x'.repeat(81) },
    { ...reservation, giverName: ' Alice ' },
    { ...reservation, giverName: 'Alice\nBob' },
    { ...reservation, giverName: 'Alice\u2028Bob' },
    { ...reservation, giverName: 'Alice\u2029Bob' },
  ]) {
    await assert.rejects(store.reserve(invalid), expectStatus(400));
  }
  await assert.rejects(store.release({ itemId: 'coffee-maker', ownerId: null }), expectStatus(400));
  assert.equal(requests.length, 0);
});

test('maps upstream failures to safe messages without returning GitHub response bodies or network details', async () => {
  for (const upstreamStatus of [401, 403, 404, 422, 429, 500]) {
    const store = new GitHubStore({ token: TOKEN, fetchImpl: async () => new Response(TOKEN, { status: upstreamStatus }) });
    const status = [401, 403, 404, 429].includes(upstreamStatus) ? 503 : 502;
    await assert.rejects(store.snapshot(), expectStatus(status));
  }
  const offline = new GitHubStore({ token: TOKEN, fetchImpl: async () => { throw new Error(TOKEN); } });
  await assert.rejects(offline.snapshot(), expectStatus(502));
  const invalidJson = new GitHubStore({ token: TOKEN, fetchImpl: async () => new Response(TOKEN) });
  await assert.rejects(invalidJson.snapshot(), expectStatus(502));
  const invalidList = new GitHubStore({ token: TOKEN, fetchImpl: async () => Response.json({ secret: TOKEN }) });
  await assert.rejects(invalidList.snapshot(), expectStatus(502));
});

test('failed GitHub writes do not report success or prevent later operations', async () => {
  const mock = mockGitHub();
  let failOnce = true;
  const store = new GitHubStore({ token: TOKEN, fetchImpl: async (url, options) => {
    if (options.method === 'POST' && failOnce) {
      failOnce = false;
      return new Response(TOKEN, { status: 500 });
    }
    return mock.fetchImpl(url, options);
  } });
  const input = { itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE };
  await assert.rejects(store.reserve(input), expectStatus(502));
  assert.equal(mock.comments.length, 0);
  assert.equal((await store.reserve(input)).size, 1);
});

test('detects an unexpected account on the newly created comment', async () => {
  const store = new GitHubStore({ token: TOKEN, fetchImpl: async (_url, options) => {
    return options.method === 'POST' ? Response.json(comment(1, event(), 'wrong-account'), { status: 201 }) : Response.json([]);
  } });
  await assert.rejects(store.reserve({ itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE }), expectStatus(502));
});

test('a stale release cannot clear a newer claim even when the same guest owns both', async () => {
  const newerId = 'claim-22222222-2222-2222';
  const { store, requests } = mockGitHub([
    comment(1),
    comment(2, event({ action: 'release' })),
    comment(3, event({ reservationId: newerId })),
    comment(4, event({ action: 'release' })),
    comment(5, event({ reservationId: 'claim-33333333-3333-3333', ownerId: BOB })),
    comment(6, event({ action: 'release', reservationId: 'claim-33333333-3333-3333', ownerId: BOB })),
  ]);
  assert.equal((await store.snapshot()).get('coffee-maker').reservationId, newerId);
  await assert.rejects(store.release({ itemId: 'coffee-maker', ownerId: ALICE, reservationId: RESERVATION }), expectStatus(409));
  assert.equal(requests.some(({ options }) => options.method === 'POST'), false);
  await store.release({ itemId: 'coffee-maker', ownerId: ALICE, reservationId: newerId });
  assert.equal((await store.snapshot()).size, 0);
});

test('ignores events without a reservation ID and rejects a malformed expected ID', async () => {
  const oldEvent = event();
  delete oldEvent.reservationId;
  const { store, requests } = mockGitHub([comment(1, oldEvent)]);
  assert.equal((await store.snapshot()).size, 0);
  await assert.rejects(store.release({ itemId: 'coffee-maker', ownerId: ALICE, reservationId: 'bad' }), expectStatus(400));
  assert.equal(requests.length, 1);
});

test('the module executes with browser globals and makes direct GitHub fetch requests', async () => {
  const mock = mockGitHub();
  const source = await readFile(new URL('../public/github-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:node:|\bprocess\.|\bBuffer\b|\brequire\()/);
  const browser = { fetch: mock.fetchImpl, crypto: { randomUUID: () => RESERVATION }, AbortSignal };
  runInNewContext(source.replace('export class GitHubStore', 'globalThis.GitHubStore = class GitHubStore'), browser);
  const store = new browser.GitHubStore({ token: TOKEN });
  const state = await store.reserve({ itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE });
  assert.equal(state.get('coffee-maker').reservationId, RESERVATION);
  assert.equal(mock.requests.length, 3);
  for (const { url, options } of mock.requests) {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.cache, 'no-store');
    assert.equal(Object.hasOwn(options.headers, 'User-Agent'), false);
    assert.deepEqual(Object.keys(options.headers).sort(), options.method === 'POST'
      ? ['Accept', 'Authorization', 'Content-Type', 'X-GitHub-Api-Version']
      : ['Accept', 'Authorization', 'X-GitHub-Api-Version']);
  }
});

test('does not report success when an appended reservation is not visible in the confirmation read', async () => {
  const store = new GitHubStore({ token: TOKEN, fetchImpl: async (_url, options) => {
    if (options.method === 'POST') {
      return Response.json({ id: 1, user: { login: 'luisfelipe998' }, body: JSON.parse(options.body).body }, { status: 201 });
    }
    return Response.json([]);
  } });
  await assert.rejects(store.reserve({ itemId: 'coffee-maker', giverName: 'Alice', ownerId: ALICE }), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /reserva ainda não foi confirmada/);
    return true;
  });
});
