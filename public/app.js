import { createGiftClient } from './client.js';
import { resolveImageUrl } from './media.js';
import { createStoreLink } from './store-links.js';
import { loadGiftCatalog } from './catalog.js';

(() => {
  'use strict';
  const client = createGiftClient();

  const $ = (selector) => document.querySelector(selector);
  const deviceStorageKey = 'casa-nova.device.v1';
  const state = { session: null, items: [], reservations: {}, status: 'all', category: '', search: '', statusReady: false, loading: false, loadingRevision: null, pending: false, pendingItemId: null, selectedId: null, revision: 0, toastTimer: null };

  function storageRead(kind, key) {
    try { return window[kind].getItem(key); } catch { return null; }
  }
  function storageWrite(kind, key, value) {
    try { window[kind].setItem(key, value); } catch { /* Browsers in private mode may disable persistence. */ }
  }
  function getDeviceKey() {
    const stored = storageRead('localStorage', deviceStorageKey) || storageRead('sessionStorage', deviceStorageKey);
    if (stored && /^[A-Za-z0-9_-]{43}$/.test(stored)) return stored;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = btoa(String.fromCharCode(...bytes)).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
    storageWrite('localStorage', deviceStorageKey, key);
    storageWrite('sessionStorage', deviceStorageKey, key);
    return key;
  }
  const deviceKey = getDeviceKey();
  try { localStorage.removeItem('casa-nova.name.v1'); } catch { /* Remove the obsolete name field when possible. */ }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function normalized(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');
  }
  function setImage(image, src, alt) {
    image.alt = alt || '';
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    image.onerror = () => { image.onerror = null; image.src = new URL('./assets/fallback.svg', document.baseURI).href; };
    image.src = resolveImageUrl(src, document.baseURI) || new URL('./assets/fallback.svg', document.baseURI).href;
  }
  // Cards and the dialog share one controller; dialog reuse never stacks listeners.
  function createImageCarousel({ root, image, previous, next, indicator, thumbnails, images, name }) {
    const slides = images.length ? images : [{ src: './assets/fallback.svg', alt: name }];
    const multiple = slides.length > 1;
    const listeners = new AbortController();
    const { signal } = listeners;
    let index = 0;
    let gesture = null;
    let suppressClickUntil = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', `Imagens de ${name}`);
    root.setAttribute('aria-roledescription', multiple ? 'carrossel' : 'imagem');
    root.tabIndex = multiple ? 0 : -1;
    root.classList.toggle('has-multiple-images', multiple);
    image.draggable = false;
    [previous, next, indicator, thumbnails].filter(Boolean).forEach((control) => control.classList.toggle('hidden', !multiple));
    const thumbnailButtons = [];

    function show(targetIndex) {
      index = ((targetIndex % slides.length) + slides.length) % slides.length;
      setImage(image, slides[index].src, slides[index].alt || name);
      root.dataset.imageIndex = String(index);
      indicator.textContent = `${index + 1} / ${slides.length}`;
      indicator.setAttribute('aria-label', `Imagem ${index + 1} de ${slides.length}`);
      thumbnailButtons.forEach((button, buttonIndex) => button.setAttribute('aria-pressed', String(index === buttonIndex)));
    }

    if (thumbnails) {
      thumbnails.replaceChildren(...slides.map((slide, slideIndex) => {
        const button = element('button', 'thumbnail-button');
        button.type = 'button';
        button.setAttribute('aria-label', `Ver imagem ${slideIndex + 1} de ${name}`);
        const thumbnail = element('img');
        thumbnail.draggable = false;
        setImage(thumbnail, slide.src, '');
        button.append(thumbnail);
        button.addEventListener('click', () => show(slideIndex), { signal });
        thumbnailButtons.push(button);
        return button;
      }));
    }

    previous.addEventListener('click', (event) => { event.stopPropagation(); show(index - 1); }, { signal });
    next.addEventListener('click', (event) => { event.stopPropagation(); show(index + 1); }, { signal });
    root.addEventListener('keydown', (event) => {
      if (!multiple || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') show(0);
      else if (event.key === 'End') show(slides.length - 1);
      else show(index + (event.key === 'ArrowRight' ? 1 : -1));
    }, { signal });

    root.addEventListener('pointerdown', (event) => {
      if (!multiple || event.pointerType !== 'touch' || !event.isPrimary || event.target.closest('.carousel-arrow, .thumbnail-button')) return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { signal, passive: true });
    root.addEventListener('pointerup', (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const deltaX = event.clientX - gesture.x;
      const deltaY = event.clientY - gesture.y;
      gesture = null;
      if (Math.abs(deltaX) < 40 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;
      show(index + (deltaX < 0 ? 1 : -1));
      suppressClickUntil = performance.now() + 450;
    }, { signal, passive: true });
    root.addEventListener('pointercancel', () => { gesture = null; }, { signal, passive: true });
    root.addEventListener('click', (event) => {
      // A swipe over the card image must not also open its details.
      if (event.detail > 0 && performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { signal, capture: true });
    show(0);
    return { destroy() { listeners.abort(); } };
  }
  let dialogCarousel = null;
  function setMessage(message) {
    $('#list-message').textContent = message;
    $('#list-message').classList.toggle('hidden', !message);
  }
  function toast(message) {
    clearTimeout(state.toastTimer);
    $('#toast').textContent = message;
    $('#toast').classList.remove('hidden');
    state.toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 5500);
  }
  function errorMessage(error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'A resposta está demorando um pouco. Tente de novo em instantes.';
    if (error instanceof TypeError) return 'Não conseguimos conectar à lista. Confira sua conexão e tente de novo.';
    return error.message || 'Algo não saiu como esperado. Tente novamente.';
  }

  async function request(operation) {
    try { return await operation(); } catch (error) {
      if (error.status === 401 && state.session) await endSession('Sua sessão terminou. Digite a senha do convite para entrar de novo.');
      throw error;
    }
  }

  async function endSession(message = '') {
    clearTimeout(state.toastTimer);
    $('#toast').classList.add('hidden');
    state.session = null;
    const logout = client.logout();
    state.reservations = {};
    state.statusReady = false;
    state.pending = false;
    state.pendingItemId = null;
    state.loading = false;
    state.loadingRevision = null;
    state.revision += 1;
    state.selectedId = null;
    $('#gift-dialog').close();
    $('#list-view').classList.add('hidden');
    $('#welcome-view').classList.remove('hidden');
    $('#logout-button').classList.add('hidden');
    $('#login-error').textContent = message;
    $('#password').value = '';
    $('#password').focus({ preventScroll: true });
    document.body.style.overflow = '';
    $('#login-button').disabled = true;
    try { await logout; } finally { $('#login-button').disabled = false; }
  }

  function applyCatalog(data) {
    state.items = data.items;
    if (typeof data.title === 'string') document.title = data.title;
    if (typeof data.subtitle === 'string') $('#list-description').textContent = data.subtitle;
    const select = $('#category-filter');
    select.replaceChildren(new Option('Todos os ambientes', ''));
    [...new Set(state.items.map((item) => item.category))].sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach((category) => select.add(new Option(category, category)));
    if (!Array.from(select.options).some((option) => option.value === state.category)) state.category = '';
    select.value = state.category;
    render();
    if ($('#gift-dialog').open) {
      if (state.items.some((item) => item.id === state.selectedId)) openGift(state.selectedId);
      else $('#gift-dialog').close();
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.reservations || typeof snapshot.reservations !== 'object' || Array.isArray(snapshot.reservations)) throw new Error('Não foi possível conferir as reservas. Atualize antes de escolher um presente.');
    const reservations = Object.create(null);
    for (const item of state.items) {
      const reservation = snapshot.reservations[item.id];
      if (reservation && typeof reservation.giver === 'string') reservations[item.id] = { reservedAt: reservation.reservedAt, mine: reservation.mine === true };
    }
    state.reservations = reservations;
    state.statusReady = true;
    setMessage('');
    render();
    if (state.selectedId && $('#gift-dialog').open) updateDialogState();
  }

  async function refreshReservations({ quiet = false, refreshCatalog = false } = {}) {
    if (!state.session || state.pending || state.loading) return;
    state.loading = true;
    const revision = ++state.revision;
    state.loadingRevision = revision;
    const session = state.session;
    let catalogLoaded = !refreshCatalog;
    $('#refresh-button').disabled = true;
    $('#refresh-button').setAttribute('aria-busy', 'true');
    if (refreshCatalog) {
      state.statusReady = false;
      $('#gift-grid').setAttribute('aria-busy', 'true');
      if (state.items.length) render();
      if ($('#gift-dialog').open) updateDialogState();
    }
    try {
      if (refreshCatalog) {
        const catalog = await loadGiftCatalog();
        if (revision !== state.revision || session !== state.session) return;
        applyCatalog(catalog);
        catalogLoaded = true;
      }
      const snapshot = await request(() => client.getReservations());
      if (revision !== state.revision || session !== state.session) return;
      applySnapshot(snapshot);
      if (!quiet) toast('Prontinho! A lista está atualizada.');
    } catch (error) {
      if (error.status === 401 || session !== state.session || revision !== state.revision) return;
      state.statusReady = false;
      setMessage(errorMessage(error) + (catalogLoaded ? ' As reservas precisam ser confirmadas antes de escolher um presente.' : ''));
      render();
      if ($('#gift-dialog').open) updateDialogState();
    } finally {
      if (state.loadingRevision === revision) {
        state.loading = false;
        state.loadingRevision = null;
        $('#refresh-button').disabled = false;
        $('#refresh-button').setAttribute('aria-busy', 'false');
        $('#gift-grid').setAttribute('aria-busy', 'false');
      }
    }
  }

  async function openList() {
    $('#welcome-view').classList.add('hidden');
    $('#list-view').classList.remove('hidden');
    $('#logout-button').classList.remove('hidden');
    $('#refresh-button').disabled = true;
    $('#list-title').focus({ preventScroll: true });
    $('#gift-grid').setAttribute('aria-busy', 'true');
    $('#gift-grid').replaceChildren(...Array.from({ length: 6 }, () => { const skeleton = element('div', 'card-skeleton'); skeleton.setAttribute('aria-hidden', 'true'); return skeleton; }));
    setMessage('');
    await refreshReservations({ quiet: true, refreshCatalog: true });
  }

  function render() {
    const reservedCount = state.items.filter((item) => state.reservations[item.id]).length;
    const mineCount = state.items.filter((item) => state.reservations[item.id]?.mine).length;
    const total = state.items.length;
    const percent = total ? Math.round(reservedCount / total * 100) : 0;
    $('#count-all').textContent = total;
    $('#count-available').textContent = state.statusReady ? total - reservedCount : '—';
    $('#count-mine').textContent = state.statusReady ? mineCount : '—';
    $('#count-reserved').textContent = state.statusReady ? reservedCount : '—';
    $('#progress-description').textContent = state.statusReady ? `${reservedCount} de ${total} presentes já têm um carinho reservado.` : 'Conferindo os presentes e as reservas…';
    $('#progress-number').textContent = state.statusReady ? `${reservedCount} / ${total}` : '—';
    $('#progress-fill').style.width = state.statusReady ? `${percent}%` : '0%';
    $('#gift-progress').setAttribute('aria-valuenow', String(state.statusReady ? percent : 0));
    const search = normalized(state.search);
    const visibleItems = state.items.filter((item) => {
      const reservation = state.reservations[item.id];
      if (state.category && item.category !== state.category) return false;
      if (search && !normalized(`${item.name} ${item.description} ${item.category}`).includes(search)) return false;
      if (state.status === 'available' && state.statusReady && reservation) return false;
      if (state.status === 'mine' && (!state.statusReady || !reservation?.mine)) return false;
      if (state.status === 'reserved' && (!state.statusReady || !reservation)) return false;
      return true;
    });
    $('#gift-grid').replaceChildren(...visibleItems.map(renderCard));
    $('#empty-state').classList.toggle('hidden', visibleItems.length > 0 || !state.statusReady);
    $('#empty-description').textContent = state.status === 'mine' && !mineCount ? 'Quando você reservar um presente, ele vai aparecer aqui. Que bom ter você com a gente!' : 'Experimente outra busca ou escolha um ambiente diferente.';
    document.querySelectorAll('[data-status]').forEach((button) => {
      const active = button.dataset.status === state.status;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderCard(item) {
    const reservation = state.statusReady ? state.reservations[item.id] : null;
    const card = element('article', `gift-card${reservation ? ' is-reserved' : ''}${reservation?.mine ? ' is-mine' : ''}`);
    card.dataset.itemId = item.id;
    card.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.target.closest('button, a, input, select, textarea')) return;
      openGift(item.id);
    });
    const carousel = element('div', 'card-carousel');
    const imageButton = element('button', 'card-image-button');
    imageButton.type = 'button';
    imageButton.setAttribute('aria-label', `Ver detalhes: ${item.name}`);
    imageButton.addEventListener('click', () => openGift(item.id));
    const image = element('img');
    image.loading = 'lazy';
    image.decoding = 'async';
    const badge = element('span', 'card-badge', !state.statusReady ? 'Conferindo…' : reservation?.mine ? 'Meu presente' : reservation ? 'Reservado' : 'Disponível');
    imageButton.append(image, badge);
    const previous = element('button', 'carousel-arrow carousel-previous', '‹');
    previous.type = 'button';
    previous.setAttribute('aria-label', `Imagem anterior de ${item.name}`);
    const next = element('button', 'carousel-arrow carousel-next', '›');
    next.type = 'button';
    next.setAttribute('aria-label', `Próxima imagem de ${item.name}`);
    const indicator = element('span', 'carousel-count');
    indicator.setAttribute('aria-live', 'polite');
    indicator.setAttribute('aria-atomic', 'true');
    carousel.append(imageButton, previous, next, indicator);
    createImageCarousel({ root: carousel, image, previous, next, indicator, images: item.images, name: item.name });
    const content = element('div', 'card-content');
    const category = element('span', 'card-category', item.category);
    const title = element('h3', 'card-title', item.name);
    const description = element('p', 'card-description', item.description);
    const details = element('button', 'card-details-button', 'Ver detalhes');
    details.type = 'button';
    details.setAttribute('aria-label', `Ver detalhes: ${item.name}`);
    details.addEventListener('click', () => openGift(item.id));
    const pending = state.pending && state.pendingItemId === item.id;
    const button = element('button', 'card-button', pending ? 'Salvando reserva…' : !state.statusReady ? 'Conferindo reservas' : reservation?.mine ? 'Meu presente' : reservation ? 'Reservado' : 'Quero presentear');
    button.type = 'button';
    button.disabled = !state.statusReady || (state.pending && !reservation);
    button.setAttribute('aria-busy', String(pending));
    if (!reservation) button.append(element('span', '', '♡'));
    button.addEventListener('click', () => reservation ? openGift(item.id) : changeReservation('reserve', item.id));
    content.append(category, title, description, details);
    content.append(button);
    card.append(carousel, content);
    return card;
  }

  function openGift(itemId) {
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    state.selectedId = item.id;
    $('#dialog-title').textContent = item.name;
    $('#dialog-category').textContent = item.category;
    $('#dialog-description').textContent = item.description;
    $('#dialog-error').textContent = '';
    dialogCarousel?.destroy();
    dialogCarousel = createImageCarousel({
      root: $('#dialog-gallery'), image: $('#dialog-image'), previous: $('#dialog-previous'),
      next: $('#dialog-next'), indicator: $('#dialog-image-count'), thumbnails: $('#dialog-thumbnails'),
      images: item.images, name: item.name,
    });
    $('#purchase-links').replaceChildren(...item.links.map(createStoreLink).filter(Boolean));
    $('.purchase-section').classList.toggle('hidden', !item.links.length);
    updateDialogState();
    if (!$('#gift-dialog').open) {
      $('#gift-dialog').showModal();
      document.body.style.overflow = 'hidden';
    }
  }

  function updateDialogState() {
    const reservation = state.reservations[state.selectedId];
    const available = state.statusReady && !reservation;
    const mine = state.statusReady && reservation?.mine;
    const status = $('#dialog-status');
    status.textContent = !state.statusReady ? 'Precisamos atualizar a lista para confirmar se este presente está disponível.' : mine ? 'Reservado por você. Obrigado!\u00a0♡' : reservation ? 'Este presente já foi reservado.' : 'Disponível para fazer parte do nosso novo lar.';
    status.classList.toggle('reserved', Boolean(reservation) && !mine);
    $('#reservation-form').classList.toggle('hidden', !available);
    $('#release-section').classList.toggle('hidden', !mine);
    $('#reserve-button').disabled = state.pending || !available;
    $('#release-button').disabled = state.pending || !mine;
  }

  async function changeReservation(action, itemId = state.selectedId) {
    if (state.pending || !state.statusReady || !itemId) return;
    state.pending = true;
    state.pendingItemId = itemId;
    state.revision += 1;
    render();
    updateDialogState();
    $('#dialog-error').textContent = '';
    $('#reserve-button').textContent = action === 'reserve' ? 'Reservando com carinho…' : 'Quero presentear ♡';
    $('#release-button').textContent = action === 'release' ? 'Liberando presente…' : 'Liberar este presente';
    const session = state.session;
    try {
      const snapshot = await request(() => action === 'reserve' ? client.reserve(itemId) : client.release(itemId));
      if (session !== state.session) return;
      applySnapshot(snapshot);
      toast(action === 'reserve' ? 'Presente reservado! Obrigado por fazer parte da nossa história. ♡' : 'Presente liberado. Tudo bem mudar de ideia!');
    } catch (error) {
      if (error.status === 401 || session !== state.session) return;
      const message = errorMessage(error);
      // A timeout may occur after GitHub accepted the comment. Always reread before allowing another change.
      state.statusReady = false;
      state.pending = false;
      state.loading = false;
      await refreshReservations({ quiet: true });
      if (state.session && $('#gift-dialog').open) $('#dialog-error').textContent = message;
      else if (state.session) toast(message);
    } finally {
      state.pending = false;
      state.pendingItemId = null;
      $('#reserve-button').textContent = 'Quero presentear ♡';
      $('#release-button').textContent = 'Liberar este presente';
      if (state.session) { render(); updateDialogState(); }
    }
  }

  async function activateSession(session) {
    state.session = crypto.randomUUID();
    $('#demo-label').classList.toggle('hidden', session.mode !== 'demo');
    $('#password').value = '';
    await openList();
  }

  async function restoreSession() {
    const button = $('#login-button');
    button.disabled = true;
    button.textContent = 'Verificando acesso…';
    $('#login-form').setAttribute('aria-busy', 'true');
    try {
      const session = await client.restore(deviceKey);
      if (session) await activateSession(session);
    } catch (error) {
      $('#login-error').textContent = errorMessage(error);
    } finally {
      button.disabled = false;
      button.textContent = 'Entrar na lista';
      $('#login-form').setAttribute('aria-busy', 'false');
    }
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#login-button');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Abrindo a porta…';
    $('#login-error').textContent = '';
    try {
      const session = await client.login($('#password').value, deviceKey);
      await activateSession(session);
    } catch (error) { $('#login-error').textContent = errorMessage(error); } finally {
      button.disabled = false;
      button.textContent = 'Entrar na lista';
    }
  });
  $('#logout-button').addEventListener('click', () => endSession());
  $('#refresh-button').addEventListener('click', async () => {
    if (!state.items.length) await openList();
    else await refreshReservations({ refreshCatalog: true });
  });
  document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => { state.status = button.dataset.status; render(); }));
  $('#search').addEventListener('input', (event) => { state.search = event.target.value; render(); });
  $('#category-filter').addEventListener('change', (event) => { state.category = event.target.value; render(); });
  $('#clear-filters').addEventListener('click', () => { state.search = ''; state.category = ''; state.status = 'all'; $('#search').value = ''; $('#category-filter').value = ''; render(); });
  $('#close-dialog').addEventListener('click', () => $('#gift-dialog').close());
  $('#gift-dialog').addEventListener('close', () => { state.selectedId = null; document.body.style.overflow = ''; });
  $('#gift-dialog').addEventListener('click', (event) => {
    if (event.target !== $('#gift-dialog')) return;
    const box = $('#gift-dialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('#gift-dialog').close();
  });
  $('#reservation-form').addEventListener('submit', (event) => { event.preventDefault(); changeReservation('reserve'); });
  $('#release-button').addEventListener('click', () => changeReservation('release'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReservations({ quiet: true }); });
  setInterval(() => { if (!document.hidden) refreshReservations({ quiet: true }); }, 60000);

  restoreSession();
})();
