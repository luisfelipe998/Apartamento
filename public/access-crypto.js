const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const KEY_ITERATIONS = 310000;

export function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function importPasswordKey(password) {
  if (typeof password !== 'string' || !password) throw new Error('Informe a senha do convite.');
  return crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
}
async function passwordKey(material, salt, iterations, usage) {
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}
export async function encryptAccess(payload, password) {
  if (!password) throw new Error('Defina GIFT_PASSWORD no arquivo .env.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(await importPasswordKey(password), salt, KEY_ITERATIONS, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)),
  );
  return { version: 1, algorithm: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: KEY_ITERATIONS,
    salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}
export async function decryptAccess(envelope, password) {
  return decryptAccessWithKey(envelope, await importPasswordKey(password));
}
export async function decryptAccessWithKey(envelope, material) {
  if (envelope?.version !== 1 || envelope.algorithm !== 'AES-GCM' || envelope.kdf !== 'PBKDF2-SHA256'
    || !Number.isInteger(envelope.iterations) || envelope.iterations < 100000 || envelope.iterations > 1000000
    || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 20000) {
    throw new Error('A configuração da lista está indisponível. Tente novamente mais tarde.');
  }
  try {
    const salt = fromBase64(envelope.salt);
    const iv = fromBase64(envelope.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid encryption parameters');
    const key = await passwordKey(material, salt, envelope.iterations, 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, fromBase64(envelope.ciphertext),
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw Object.assign(new Error('Essa senha não abriu a porta. Confira a senha do convite e tente de novo.'), { status: 401 });
  }
}
