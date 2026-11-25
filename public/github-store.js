const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{32,128}$/;
const RESERVATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MARKER = /^<!-- apartamento-gift:v1 (.+) -->$/gm;
const MAX_BODY_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 12_000;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function validName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80
    && value === value.trim() && !CONTROL_CHARACTERS.test(value);
}

function validOwnerId(value) {
  return typeof value === 'string' && OWNER_ID.test(value);
}

function validateInput({ itemId, ownerId, giverName }, needsName = false) {
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) {
    throw failure(400, 'O identificador deste presente é inválido.');
  }
  if (!validOwnerId(ownerId)) throw failure(400, 'Não foi possível identificar quem fez a reserva.');
  if (needsName && !validName(giverName)) throw failure(400, 'Informe um nome de 1 a 80 caracteres.');
}

function commentId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value)) return BigInt(value);
  return null;
}

function parseEvent(body) {
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) return null;
  const markers = [...body.matchAll(MARKER)];
  if (markers.length !== 1) return null;
  let event;
  try { event = JSON.parse(markers[0][1]); } catch { return null; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).sort().join(',') !== 'action,giverName,itemId,ownerId,reservationId,timestamp') return null;
  if (event.action !== 'reserve' && event.action !== 'release') return null;
  if (typeof event.itemId !== 'string' || !ITEM_ID.test(event.itemId)) return null;
  if (!validOwnerId(event.ownerId) || !validName(event.giverName)) return null;
  if (typeof event.reservationId !== 'string' || !RESERVATION_ID.test(event.reservationId)) return null;
  if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) return null;
  if (new Date(event.timestamp).toISOString() !== event.timestamp) return null;
  return event;
}

function replay(comments, author) {
  const ordered = new Map();
  for (const comment of comments) {
    if (typeof comment?.user?.login !== 'string' || comment.user.login.toLowerCase() !== author.toLowerCase()) continue;
    const id = commentId(comment.id);
    const event = parseEvent(comment.body);
    if (id !== null && event) ordered.set(id, event);
  }
  const state = new Map();
  for (const [, event] of [...ordered.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const current = state.get(event.itemId);
    if (event.action === 'reserve' && !current) {
      state.set(event.itemId, {
        giverName: event.giverName, ownerId: event.ownerId, reservedAt: event.timestamp, reservationId: event.reservationId,
      });
    } else if (event.action === 'release' && current?.ownerId === event.ownerId
      && current.reservationId === event.reservationId) {
      state.delete(event.itemId);
    }
  }
  return state;
}

function commentBody(event) {
  // Escaping angle brackets keeps user text from creating another HTML marker.
  const json = JSON.stringify(event).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026').replaceAll('@', '\\u0040').replaceAll('#', '\\u0023');
  // Public comments must not turn a guest's display name into a GitHub mention.
  const name = event.giverName.replaceAll('@', '＠').replaceAll('#', '＃').replace(/[\\`*_{}\[\]()<>!|~]/g, '');
  const summary = event.action === 'reserve'
    ? `Presente reservado: ${event.itemId} — ${name}.`
    : `Reserva cancelada: ${event.itemId} — ${name}.`;
  return `${summary}\n\n<!-- apartamento-gift:v1 ${json} -->`;
}

/**
 * An append-only event log stored in GitHub issue comments, accessed directly
 * from the browser. The first valid claim in GitHub comment-ID order wins.
 * Every mutation rereads the log because browsers cannot lock one another.
 */
export class GitHubStore {
  #token;
  #baseUrl;
  #author;
  #fetch;

  constructor({ token, owner = 'luisfelipe998', repo = 'Apartamento', issueNumber = 1, author = owner, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || token.trim().length === 0) throw failure(503, 'As credenciais da lista ainda não foram configuradas.');
    if (typeof owner !== 'string' || !OWNER.test(owner) || typeof repo !== 'string' || !REPOSITORY.test(repo)) {
      throw failure(500, 'O repositório da lista está configurado incorretamente.');
    }
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw failure(500, 'O registro de reservas está configurado incorretamente.');
    if (typeof author !== 'string' || !OWNER.test(author)) throw failure(500, 'A conta responsável pela lista está configurada incorretamente.');
    if (typeof fetchImpl !== 'function') throw failure(500, 'Este navegador não conseguiu acessar as reservas.');
    this.#token = token.trim();
    this.#baseUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
    this.#author = author;
    // Calling native window.fetch as this.#fetch(...) would bind its receiver
    // to GitHubStore and Chrome rejects it with "Illegal invocation".
    this.#fetch = (url, options) => fetchImpl(url, options);
  }

  async #request(url, options = {}) {
    let response;
    try {
      response = await this.#fetch(url, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw failure(502, 'Não foi possível conectar à lista de reservas. Tente novamente em instantes.');
    }
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) {
        throw failure(503, 'O acesso às reservas está indisponível. Avise quem compartilhou a lista.');
      }
      if (response.status === 429) throw failure(503, 'A lista recebeu muitas solicitações. Aguarde um pouco e tente novamente.');
      throw failure(502, 'Não foi possível concluir a solicitação. Tente novamente em instantes.');
    }
    try { return await response.json(); } catch {
      throw failure(502, 'Não foi possível ler a resposta da lista. Tente novamente em instantes.');
    }
  }

  async snapshot() {
    const comments = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request(`${this.#baseUrl}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw failure(502, 'Não foi possível carregar o registro de reservas.');
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return replay(comments, this.#author);
  }

  async #append(event) {
    const comment = await this.#request(this.#baseUrl, {
      method: 'POST', body: JSON.stringify({ body: commentBody(event) }),
    });
    if (!comment || commentId(comment.id) === null || typeof comment?.user?.login !== 'string'
      || comment.user.login.toLowerCase() !== this.#author.toLowerCase()) {
      throw failure(502, 'Não foi possível confirmar o registro da reserva. Avise quem compartilhou a lista.');
    }
  }

  async reserve({ itemId, giverName, ownerId } = {}) {
    validateInput({ itemId, giverName, ownerId }, true);
    const state = await this.snapshot();
    const current = state.get(itemId);
    if (current && current.ownerId !== ownerId) throw failure(409, 'Outra pessoa já reservou este presente.');
    if (current) return state;
    const event = { action: 'reserve', itemId, giverName, ownerId, reservationId: crypto.randomUUID(), timestamp: new Date().toISOString() };
    await this.#append(event);
    const confirmed = await this.snapshot();
    if (!confirmed.has(itemId)) {
      throw failure(502, 'A reserva ainda não foi confirmada. Atualize a lista antes de tentar novamente.');
    }
    if (confirmed.get(itemId).reservationId !== event.reservationId) {
      throw failure(409, 'Este presente recebeu outra reserva antes da sua. Atualize a lista.');
    }
    return confirmed;
  }

  async release({ itemId, ownerId, reservationId } = {}) {
    validateInput({ itemId, ownerId });
    if (reservationId !== undefined && (typeof reservationId !== 'string' || !RESERVATION_ID.test(reservationId))) {
      throw failure(400, 'O identificador desta reserva é inválido.');
    }
    const state = await this.snapshot();
    const current = state.get(itemId);
    if (!current) return state;
    if (current.ownerId !== ownerId) throw failure(403, 'Somente quem reservou este presente pode cancelar a reserva.');
    if (reservationId !== undefined && current.reservationId !== reservationId) {
      throw failure(409, 'Esta reserva mudou. Atualize a lista antes de cancelar.');
    }
    await this.#append({ action: 'release', itemId, giverName: current.giverName, ownerId, reservationId: current.reservationId, timestamp: new Date().toISOString() });
    const confirmed = await this.snapshot();
    if (confirmed.get(itemId)?.reservationId === current.reservationId) {
      throw failure(502, 'O cancelamento ainda não foi confirmado. Atualize a lista antes de tentar novamente.');
    }
    return confirmed;
  }
}
