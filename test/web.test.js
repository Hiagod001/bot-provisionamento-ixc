import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWebServer, hashWebPassword, verifyWebPassword } from '../src/webServer.js';
import { createWebFlow } from '../src/webFlow.js';

const passwordHash = hashWebPassword('test-only-password');
test('senha usa hash com salt e rejeita senha incorreta', () => {
  assert.equal(verifyWebPassword('test-only-password', passwordHash), true);
  assert.equal(verifyWebPassword('incorrect', passwordHash), false);
  assert.notEqual(hashWebPassword('test-only-password'), passwordHash);
});

async function setup(t, flow) {
  const origin = 'http://127.0.0.1';
  const server = createWebServer({ flow, passwordHash, origin, secure: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, cookie = '', requestOrigin = origin) => fetch(base + path, { method: 'POST', headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const login = async () => { const r = await post('/api/login', { password: 'test-only-password' }); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); return r.headers.get('set-cookie').split(';')[0]; };
  return { base, post, login };
}
const fakeFlow = () => ({ create: () => ({ messages: [], receipts: new Map(), busy: false, sequence: 0 }), dispose() {}, async dispatch() {} });

test('Menu repetido nao duplica saudacao; retorno inicia conversa limpa com sequencia monotona', async () => {
  const flow = createWebFlow({}, { dryRun: true, allowedTelegramIds: [] });
  const s = flow.create();
  await flow.dispatch(s, { text: '/start' });
  for (let i = 0; i < 20; i++) await flow.dispatch(s, { text: '/start' });
  assert.equal(s.messages.length, 1);
  await flow.dispatch(s, { callback: 'clearmac:start' });
  assert.equal(s.messages[1].role, 'user');
  assert.equal(s.messages[1].text, 'Limpar MAC');
  const previous = s.sequence;
  await flow.dispatch(s, { text: '/start' });
  assert.equal(s.messages.length, 1);
  assert.equal(s.resetAfter, previous);
  assert.ok(s.sequence > previous);
  await flow.dispatch(s, { text: '/start' });
  assert.equal(s.messages.length, 1);
  flow.dispose(s);
});

test('web exige login, bloqueia CSRF e limita tentativas', async t => {
  const { base, post } = await setup(t, fakeFlow());
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const logo = await fetch(base + '/uai-logo.png');
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('cache-control'), /max-age=86400/);
  assert.match(logo.headers.get('content-security-policy'), /img-src 'self'/);
  assert.equal((await fetch(base + '/brand.css')).status, 200);
  assert.equal((await post('/api/login', { password: 'test-only-password' }, '', 'https://evil.invalid')).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await post('/api/login', { password: 'test-only-password' })).status, 429);
});

test('web nao repete acao apos perda de resposta e impede concorrencia', async t => {
  let release, calls = 0;
  const flow = fakeFlow();
  flow.dispatch = async (_s, input) => { if (input.text === '/start') return; calls++; await new Promise(resolve => { release = resolve; }); };
  const { base, post, login } = await setup(t, flow);
  const cookie = await login();
  const request = { requestId: randomUUID(), input: { text: '123' } };
  assert.equal((await post('/api/action', request, cookie)).status, 202);
  assert.equal((await post('/api/action', request, cookie)).status, 202);
  assert.equal((await post('/api/action', { ...request, requestId: randomUUID() }, cookie)).status, 409);
  assert.equal(calls, 1);
  assert.equal((await post('/api/logout', {}, cookie)).status, 409);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post('/api/action', request, cookie)).status, 202);
  assert.equal(calls, 1);
  assert.equal((await post('/api/logout', {}, cookie)).status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 401);
});

test('adaptador reutiliza fluxo Limpar MAC sem alterar IXC em simulacao', async () => {
  let mutations = 0;
  const client = { id: '10', razao: 'Teste' }, contract = { id: '20', id_cliente: '10', status: 'A' }, login = { id: '30', id_cliente: '10', id_contrato: '20', login: 'teste' };
  const ixc = { findClient: async () => client, findContractsByClient: async () => [contract], findPppoeLoginsByContract: async () => [login], read: async table => table === 'cliente_contrato' ? contract : login, clearLoginMac: async () => { mutations++; } };
  const flow = createWebFlow(ixc, { dryRun: true, allowedTelegramIds: ['not-web'] });
  const session = flow.create();
  const clickLast = () => ({ callback: session.messages.at(-1).keyboard.inline_keyboard[0][0].callback_data });
  await flow.dispatch(session, { text: '/start' });
  assert.match(session.messages[0].text, /Opa/);
  await flow.dispatch(session, { callback: 'clearmac:start' });
  await flow.dispatch(session, { text: '10' });
  await flow.dispatch(session, clickLast());
  await flow.dispatch(session, clickLast());
  assert.match(session.messages.at(-1).text, /Simulacao/);
  assert.equal(mutations, 0);
  const other = flow.create(); await flow.dispatch(other, { text: '/start' });
  assert.equal(other.messages.length, 1);
  flow.dispose(session); flow.dispose(other);
});
