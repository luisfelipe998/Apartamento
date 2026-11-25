(() => {
  'use strict';
  const input = document.getElementById('password');
  const button = document.getElementById('password-toggle');
  const form = document.getElementById('login-form');
  if (!input || !button || !form) return;

  function setVisible(visible) {
    input.type = visible ? 'text' : 'password';
    const label = visible ? 'Ocultar senha' : 'Mostrar senha';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(visible));
    button.title = label;
    button.querySelector('[data-password-slash]')?.classList.toggle('hidden', !visible);
  }
  button.addEventListener('click', () => setVisible(input.type === 'password'));
  document.getElementById('logout-button')?.addEventListener('click', () => setVisible(false));
  form.addEventListener('submit', (event) => {
    setVisible(false);
    if (location.protocol === 'file:') event.preventDefault();
  });
  setVisible(false);

  if (location.protocol === 'file:') {
    document.getElementById('login-error').textContent = 'Para abrir a lista, use o link do site ou acesse http://localhost:3000 com a prévia iniciada.';
    document.getElementById('login-button').disabled = true;
  }
})();
