import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encryptAccess } from '../public/access-crypto.js';

export async function buildAccess(env = process.env, destination = new URL('../public/access.json', import.meta.url)) {
  const token = (env.GITHUB_TOKEN || '').trim();
  const password = env.GIFT_PASSWORD || 'password';
  if (env.REQUIRE_GITHUB_TOKEN === 'true' && !token) {
    throw new Error('Defina o secret GIFT_GITHUB_TOKEN antes de publicar.');
  }
  if (env.REQUIRE_GIFT_PASSWORD === 'true'
    && (!env.GIFT_PASSWORD?.trim() || password.trim().toLowerCase() === 'password')) {
    throw new Error('Defina o secret GIFT_PASSWORD com uma senha diferente de password antes de publicar.');
  }
  const owner = env.GITHUB_OWNER || 'luisfelipe998';
  const repo = env.GITHUB_REPO || 'Apartamento';
  const author = env.GITHUB_AUTHOR || owner;
  const issueNumber = Number(env.GITHUB_ISSUE_NUMBER || '1');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(author)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)
    || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('Confira GITHUB_OWNER, GITHUB_REPO, GITHUB_AUTHOR e GITHUB_ISSUE_NUMBER.');
  }
  const mode = token ? 'github' : 'demo';
  const envelope = await encryptAccess({ mode, token, owner, repo, issueNumber, author }, password);
  await mkdir(new URL('.', destination), { recursive: true });
  await writeFile(destination, JSON.stringify(envelope, null, 2) + '\n');
  return mode;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const mode = await buildAccess();
    console.log(mode === 'github'
      ? 'Site estático pronto em public/. Acesso à issue configurado; token criptografado.'
      : 'Site estático pronto em public/. Modo demonstração: adicione GITHUB_TOKEN ao .env para usar a issue.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
