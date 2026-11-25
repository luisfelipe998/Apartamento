import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImages, resolveImageUrl } from '../public/media.js';

const page = 'https://luisfelipe998.github.io/Apartamento/';

test('a carousel can mix local files and remote images, including simple URL strings', () => {
  assert.deepEqual(normalizeImages([
    './assets/foto 1.jpg',
    'https://images.example.com/produto.webp?size=800',
    { src: 'assets/detalhe.png', alt: 'Detalhe do presente' },
    { url: 'https://images.example.com/segunda.jpg', alt: 'Outra vista' },
  ], 'Presente', page), [
    { src: page + 'assets/foto%201.jpg', alt: 'Presente' },
    { src: 'https://images.example.com/produto.webp?size=800', alt: 'Presente' },
    { src: page + 'assets/detalhe.png', alt: 'Detalhe do presente' },
    { src: 'https://images.example.com/segunda.jpg', alt: 'Outra vista' },
  ]);
});

test('invalid image entries do not create broken carousel slides or executable URLs', () => {
  assert.deepEqual(normalizeImages([null, {}, 42, '', 'javascript:alert(1)', 'file:///Users/example/photo.jpg',
    { src: 'data:text/html,unsafe' }, 'https://user:secret@images.example.com/photo.jpg'], 'Foto', page), []);
  assert.equal(resolveImageUrl('  https://images.example.com/photo.jpg  ', page), 'https://images.example.com/photo.jpg');
  assert.equal(resolveImageUrl('./assets/local.svg', page), page + 'assets/local.svg');
});
