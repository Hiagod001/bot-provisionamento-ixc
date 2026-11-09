import test from 'node:test';
import assert from 'node:assert/strict';
import { IxcClient, ONU_AUTHORIZATION_TIMEOUT_MS } from '../src/ixcClient.js';
import { reportUncertainProvision } from '../src/flow.js';

test('somente autorizacoes aguardam 180 segundos, sem repetir escrita em timeout', async () => {
  const ixc = new IxcClient({ baseUrl: 'https://example.invalid', token: 'test' });
  const requests = [];
  ixc.http.post = async (url, body, options) => { requests.push({ url, body, options }); return { data: { type: 'success' } }; };
  await ixc.authorizePendingOnu('pending');
  await ixc.authorizeOnu('123');
  await ixc.clearLoginMac('30');
  assert.equal(ONU_AUTHORIZATION_TIMEOUT_MS, 180000);
  assert.equal(requests[0].options.timeout, 180000);
  assert.equal(requests[1].options.timeout, 180000);
  assert.equal(requests[2].options, undefined);
  assert.equal(ixc.http.defaults.timeout, 60000);
  let attempts = 0;
  ixc.http.post = async () => { attempts++; throw Object.assign(Error('timeout'), { code: 'ECONNABORTED' }); };
  await assert.rejects(ixc.authorizeOnu('123'), /timeout/);
  assert.equal(attempts, 1);
});

const fixture = () => {
  const ixc = Object.create(IxcClient.prototype), calls = [];
  const fiber = { id: '123', mac: 'HWTC1234', id_login: '30', id_contrato: '20', id_transmissor: '1' };
  const payload = { pendingOnuId: 'pending', clienteFibra: { ...fiber } };
  ixc.prepareProvisionPayload = async () => payload;
  ixc.ensureOnuAuthorizationApiAvailable = async () => {};
  ixc.findFiberClientsByMac = async () => [];
  ixc.findFiberClientsByLogin = async () => [];
  ixc.create = async () => { calls.push('create'); return { id: '123' }; };
  ixc.findProvisionedOnu = async () => fiber;
  ixc.authorizePendingOnu = async () => { calls.push('pending'); return { type: 'success' }; };
  ixc.authorizeOnu = async () => { calls.push('authorize'); return { type: 'success' }; };
  ixc.read = async (table, id, options) => {
    if (options) assert.deepEqual(options, { timeoutMs: 10000, retryTransient: false, strictResponse: true });
    calls.push('read'); return fiber;
  };
  ixc.getOnuPowerSummary = async () => { throw Error('Nao medir automaticamente'); };
  return { ixc, payload, fiber, calls };
};

for (const [method, phase, expected] of [
  ['authorizePendingOnu', 'authorize_pending', ['create', 'timeout', 'read']],
  ['authorizeOnu', 'authorize_device', ['create', 'pending', 'timeout', 'read']],
]) {
  test(`timeout em ${phase} confere cadastro sem regravar nem declarar sucesso`, async () => {
    const { ixc, payload, calls } = fixture();
    let diagnostic;
    ixc[method] = async () => { calls.push('timeout'); throw Object.assign(Error('timeout'), { code: 'ECONNABORTED' }); };
    await assert.rejects(ixc.provisionOnu(payload, { saveResponse: async data => { diagnostic = data; return 'test-reference'; } }), error => {
      assert.equal(error.code, 'PROVISION_RESULT_UNCERTAIN');
      assert.equal(error.provisionMutationStarted, true);
      assert.equal(error.phase, phase);
      assert.match(error.message, /pode continuar executando/);
      assert.match(error.message, /cadastro de fibra foi localizado/);
      assert.match(error.message, /Nao repita/);
      return true;
    });
    assert.deepEqual(calls, expected);
    assert.equal(diagnostic.phase, phase);
    assert.equal(diagnostic.classification, 'transport_timeout');
  });
}

test('timeout ao criar confere vinculos e nao tenta criar outra vez', async () => {
  const { ixc, payload, calls, fiber } = fixture();
  ixc.create = async () => { calls.push('create'); throw Object.assign(Error('timeout'), { code: 'ECONNABORTED' }); };
  ixc.findFiberClientsByMac = async (mac, options) => options ? [fiber] : [];
  await assert.rejects(ixc.provisionOnu(payload, { saveResponse: async () => 'ref' }), e => e.phase === 'create_fiber' && e.provisionMutationStarted);
  assert.deepEqual(calls, ['create']);
});

test('preflight sem alteracao permite nova tentativa e cadastro final ausente nunca vira sucesso', async () => {
  const first = fixture();
  first.ixc.ensureOnuAuthorizationApiAvailable = async () => { throw Object.assign(Error('timeout'), { code: 'ECONNABORTED' }); };
  await assert.rejects(first.ixc.provisionOnu(first.payload), e => !e.provisionMutationStarted && e.code === 'ECONNABORTED');
  assert.deepEqual(first.calls, []);
  const last = fixture(); last.ixc.read = async () => null;
  await assert.rejects(last.ixc.provisionOnu(last.payload, { saveResponse: async () => 'ref' }), e => e.phase === 'verify' && e.code === 'PROVISION_RESULT_UNCERTAIN');
});

test('notifica cada autorizacao e falha de notificacao nao interrompe equipamento', async () => {
  const { ixc, payload, calls } = fixture(), notices = [];
  const result = await ixc.provisionOnu(payload, { onProgress: async phase => { notices.push(phase); throw Error('Canal indisponivel'); } });
  assert.deepEqual(notices, ['authorize_pending', 'authorize_device']);
  assert.equal(result.authorized, true);
  assert.deepEqual(calls, ['create', 'pending', 'authorize', 'read']);
});

test('resultado incerto bloqueia estado de retry e remove botao de repetir', async () => {
  for (const marker of ['moveRemovalStarted', 'moveOldRemoved', 'provisionApplied']) {
    const state = { step: 'provisioning', [marker]: true }, replies = [];
    assert.equal(await reportUncertainProvision({ reply: async (...args) => replies.push(args) }, state, Error('timeout')), true);
    assert.equal(state.step, 'provision_uncertain');
    assert.match(replies[0][0], /Nao repita/);
    assert.ok(replies[0][1].reply_markup.inline_keyboard.flat().every(button => button.callback_data !== 'confirm:retry'));
  }
  const state = { step: 'provisioning' };
  assert.equal(await reportUncertainProvision({ reply: async () => assert.fail('Nao deveria avisar') }, state, Error('Leitura falhou')), false);
});
