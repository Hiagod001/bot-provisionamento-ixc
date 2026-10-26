const $ = id => document.getElementById(id);
let sequence = 0, busy = false, timer, sending = false;
let pending = JSON.parse(sessionStorage.getItem('pendingAction') || 'null');
const status = text => { $('status').textContent = text; };
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (response.status === 401) {
    const hadSession = sequence > 0 || !!pending;
    $('login').hidden = false; $('workspace').hidden = true;
    $('composer').before($('choices')); $('choices').replaceChildren(); $('messages').replaceChildren(); sequence = 0;
    clearTimeout(timer);
    if (path.startsWith('/api/state') && !hadSession) data.error = 'Entre com a senha de acesso.';
  }
  if (!response.ok) throw Error(data.error || 'Falha na comunicação');
  return data;
}
function controls() {
  for (const element of document.querySelectorAll('#choices button,#entry button,#text,#location,#menu,#logout')) element.disabled = busy || sending || !!pending;
}
function render(message) {
  const card = document.createElement('div'); card.className = `message ${message.role === 'user' ? 'user-message' : 'bot-message'}`;
  const author = document.createElement('span'); author.className = 'message-author'; author.textContent = message.role === 'user' ? 'Você' : 'Uai • Assistente';
  const content = document.createElement('div'); content.textContent = message.text;
  card.append(author, content);
  if (message.role === 'user') $('choices').replaceChildren();
  $('messages').append(card);
  const keyboard = message.keyboard;
  if (keyboard?.inline_keyboard) {
    $('choices').replaceChildren();
    card.append($('choices'));
    for (const row of keyboard.inline_keyboard) for (const choice of row) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = choice.text;
      if (choice.copy_text) {
        button.className = 'copy'; button.onclick = async () => { try { await navigator.clipboard.writeText(choice.copy_text.text); status('Copiado.'); } catch { status('Não foi possível copiar automaticamente. Selecione o texto.'); } }; card.append(button);
      } else if (choice.callback_data) { button.onclick = () => act({ callback: choice.callback_data }); $('choices').append(button); }
    }
  } else if (keyboard?.remove_keyboard) $('choices').replaceChildren();
  while ($('messages').children.length > 40) {
    if ($('messages').firstChild.contains($('choices'))) $('composer').before($('choices'));
    $('messages').firstChild.remove();
  }
}
async function refresh() {
  clearTimeout(timer);
  try {
    const data = await api(`/api/state?after=${sequence}`);
    $('login').hidden = true; $('workspace').hidden = false;
    if (sequence <= data.resetAfter && data.resetAfter > 0) {
      $('composer').before($('choices')); $('choices').replaceChildren(); $('messages').replaceChildren();
    }
    for (const message of data.messages) render(message);
    sequence = data.sequence; busy = data.busy;
    if (!pending) $('retry').hidden = true;
    status(busy ? 'Processando no servidor. Aguarde…' : 'Pronto.');
    controls();
    if (data.messages.length) $('messages').scrollTop = $('messages').scrollHeight;
    if (busy) timer = setTimeout(refresh, 3000);
  } catch (error) { status(error.message + ($('login').hidden ? ' Use Atualizar para reconectar.' : '')); $('retry').hidden = !$('login').hidden; }
}
async function sendPending() {
  if (!pending || sending) return;
  sending = true; controls();
  try {
    await api('/api/action', pending);
    pending = null; sessionStorage.removeItem('pendingAction'); $('retry').hidden = true;
    await refresh();
  } catch (error) { status(error.message + ' Não envie novamente; use Reconectar.'); $('retry').hidden = false; }
  finally { sending = false; controls(); }
}
async function act(input) {
  if (busy || sending || pending) return;
  pending = { requestId: crypto.randomUUID(), input }; sessionStorage.setItem('pendingAction', JSON.stringify(pending));
  await sendPending();
}
$('login').onsubmit = async event => {
  event.preventDefault(); const button = $('login').querySelector('button'); button.disabled = true;
  try {
    await api('/api/login', { password: $('password').value }); $('password').value = '';
    // A new session cannot replay an operation from an expired session.
    const hadPending = !!pending; pending = null; sessionStorage.removeItem('pendingAction'); sequence = 0; busy = false;
    await refresh(); if (hadPending) status('Sessão nova: confira no IXC a solicitação anterior antes de repetir.');
  } catch (error) { status(error.message); } finally { button.disabled = false; }
};
$('entry').onsubmit = event => { event.preventDefault(); const text = $('text').value.trim(); if (text) { $('text').value = ''; act({ text }); } };
$('menu').onclick = () => act({ text: '/start' });
$('refresh').onclick = () => pending ? sendPending() : refresh();
$('retry').onclick = () => pending ? sendPending() : refresh();
$('logout').onclick = async () => { try { await api('/api/logout', {}); location.reload(); } catch (e) { status(e.message); } };
$('location').onclick = () => {
  if (!navigator.geolocation) { status('Este navegador não oferece localização.'); return; }
  status('Obtendo localização pelo GPS…');
  navigator.geolocation.getCurrentPosition(position => act({ location: { latitude: position.coords.latitude, longitude: position.coords.longitude } }), () => status('Não consegui obter o GPS. Permita o acesso à localização e tente novamente.'), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
};
if (pending) sendPending(); else refresh();
