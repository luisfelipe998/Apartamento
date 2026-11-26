import { normalizeImages, resolveImageUrl } from './media.js';

const PUBLIC_BASE = 'https://raw.githubusercontent.com/luisfelipe998/Apartamento/main/public/';
const UNAVAILABLE = 'Não conseguimos carregar os presentes. Tente atualizar a lista.';
const INVALID = 'A lista de presentes está indisponível. Confira os dados e tente novamente.';

function catalogBase(pageUrl) {
  const page = new URL(pageUrl);
  if (page.username || page.password || !['http:', 'https:', 'file:'].includes(page.protocol)) throw new Error(INVALID);
  const local = page.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname)
    || page.hostname.endsWith('.localhost');
  return { local, base: local ? new URL('./', page).href : PUBLIC_BASE };
}

/** Read local edits in development and the latest public main catalog in production. */
export async function loadGiftCatalog({
  pageUrl = globalThis.document?.baseURI,
  fetchImpl = globalThis.fetch,
  requestId = globalThis.crypto.randomUUID(),
} = {}) {
  let location;
  try { location = catalogBase(pageUrl); } catch { throw new Error(INVALID); }
  const url = new URL('./data/items.json', location.base);
  url.searchParams.set('v', requestId);
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
  } catch { throw new Error(UNAVAILABLE); }
  if (!response.ok) throw new Error(UNAVAILABLE);
  let data;
  try { data = await response.json(); } catch { throw new Error(INVALID); }
  if (!data || !Array.isArray(data.items)) throw new Error(INVALID);
  const ids = new Set();
  const items = data.items.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id)
      || ids.has(item.id) || typeof item.name !== 'string') throw new Error(INVALID);
    ids.add(item.id);
    const images = normalizeImages(item.images, item.name, location.base).map((image) => {
      if (location.local || !image.src.startsWith(PUBLIC_BASE)) return image;
      const src = new URL(image.src);
      src.searchParams.set('v', requestId);
      return { ...image, src: src.href };
    });
    const links = Array.isArray(item.links) ? item.links.flatMap((link) => {
      const url = resolveImageUrl(link?.url);
      return url ? [{ url, ...(typeof link.label === 'string' ? { label: link.label } : {}) }] : [];
    }) : [];
    return { id: item.id, name: item.name, description: String(item.description || ''),
      category: String(item.category || 'Para a casa'), images, links };
  });
  return { ...data, items };
}
