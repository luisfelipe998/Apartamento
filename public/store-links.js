const STORES = [
  { name: 'Amazon', icon: 'amazon.svg', domains: ['amazon.com.br', 'amazon.com'], shortHosts: ['amzn.to'] },
  { name: 'Mercado Livre', icon: 'mercado-livre.svg', domains: ['mercadolivre.com.br', 'mercadolivre.com', 'mercadolibre.com'], shortHosts: [] },
  { name: 'Shopee', icon: 'shopee.svg', domains: ['shopee.com.br', 'shopee.com'], shortHosts: ['shope.ee'] },
];

/** Build a shopping link from a validated destination; labels never identify a store. */
export function createStoreLink(link) {
  if (!link || typeof link.url !== 'string' || !link.url.trim()) return null;
  let url;
  try { url = new URL(link.url); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/[.]$/, '');
  const store = STORES.find((candidate) =>
    candidate.domains.some((domain) => host === domain || host.endsWith('.' + domain)) ||
    candidate.shortHosts.includes(host));
  const label = typeof link.label === 'string' && link.label.trim() ? link.label : (store?.name || 'Visitar loja');

  const anchor = document.createElement('a');
  anchor.className = 'store-link';
  anchor.href = url.href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.dataset.store = store?.name || 'Outra loja';
  anchor.setAttribute('aria-label', label + ' (abre em outra aba)');

  const icon = document.createElement('img');
  icon.className = 'store-link-icon';
  icon.src = new URL('./assets/stores/' + (store?.icon || 'shop.svg'), import.meta.url).href;
  icon.alt = '';
  icon.width = 24;
  icon.height = 24;
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'store-link-label';
  text.textContent = label;
  const external = document.createElement('span');
  external.className = 'store-link-external';
  external.textContent = '↗';
  external.setAttribute('aria-hidden', 'true');
  anchor.append(icon, text, external);
  return anchor;
}
