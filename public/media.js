/** Images may be local paths or public image URLs, as strings or {src, alt}. */
export function resolveImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeImages(images, fallbackAlt = '', baseUrl = globalThis.document?.baseURI) {
  if (!Array.isArray(images)) return [];
  return images.flatMap((entry) => {
    const source = typeof entry === 'string' ? entry : entry?.src ?? entry?.url;
    const src = resolveImageUrl(source, baseUrl);
    if (!src) return [];
    const alt = typeof entry?.alt === 'string' && entry.alt.trim() ? entry.alt : fallbackAlt;
    return [{ src, alt }];
  });
}
