import test from 'node:test';
import assert from 'node:assert/strict';
import { contractAddress, contractButtonLabel } from '../src/format.js';
import { sendContractOptions, askSwapOldFiberRemoval, hasSwapBoxAndPort, buildProvisionPayload } from '../src/flow.js';
import { reprovisionExisting } from '../src/reprovision.js';
import { createWebFlow } from '../src/webFlow.js';
import { validateMoveDestination, buildSerialRequestMessage } from '../src/flow.js';

test('mudanca pergunta sobre ONU e segue para cliente em ambas as escolhas', async () => {
  for (const choice of ['yes', 'no']) {
    const flow = createWebFlow({}, { dryRun: true });
    const session = flow.create();
    try {
      await flow.dispatch(session, { callback: 'service:mudanca' });
      assert.match(session.messages.at(-1).text, /vai mudar tambem o equipamento/);
      assert.equal(session.messages.at(-1).keyboard.inline_keyboard[0].length, 2);
      await flow.dispatch(session, { callback: `moveequipment:${choice}` });
      assert.match(session.messages.at(-1).text, /ID do cliente/);
    } finally { flow.dispose(session); }
  }
  assert.match(buildSerialRequestMessage({ serviceType: 'mudanca', moveSwapOnu: true }), /NOVO EQUIPAMENTO/);
});

test('mudanca bloqueia antes da remocao se vinculo mudou ou tentativa ja removeu ONU', async () => {
  await assert.rejects(validateMoveDestination({ moveOldRemoved: true }, {}, {}), /ja foi removida/);
  const old = { id: '1', id_login: '2', id_contrato: '3', mac: 'OLD' };
  await assert.rejects(validateMoveDestination({ oldFiber: old, login: { id: '2' }, contract: { id: '3' } }, { read: async () => ({ ...old, mac: 'CHANGED' }) }, {}), /Cadastro antigo mudou/);
});

const reproFixture = () => {
  const client = { id: '10' }, contract = { id: '20', id_cliente: '10', status: 'A', endereco: 'Rua Teste', numero: '77' }, login = { id: '30', id_cliente: '10', id_contrato: '20', login: 'teste' };
  const fiber = { id: '40', id_contrato: '20', id_login: '30', mac: 'HWTC1234', id_transmissor: '5', id_perfil: '7', id_caixa_ftth: '123', porta_ftth: '2' };
  const calls = [];
  const ixc = {
    read: async table => ({ cliente_contrato: contract, radusuarios: login, radpop_radio_cliente_fibra: { ...fiber } })[table],
    ensureOnuAuthorizationApiAvailable: async () => {},
    actionPost: async (action, data) => { calls.push([action, data.id]); return { type: 'success' }; },
    authorizeOnu: async id => { calls.push(['authorize', id]); return { type: 'success' }; },
    findClient: async () => client, findContractsByClient: async () => [contract], findPppoeLoginsByContract: async () => [login], findFiberClientsByLogin: async () => [fiber],
  };
  return { client, contract, login, fiber, ixc, calls };
};

test('reprovisiona o mesmo cadastro, preserva caixa e porta e respeita simulacao', async () => {
  const f = reproFixture();
  await reprovisionExisting(f.ixc, { ...f, dryRun: true });
  assert.equal(f.calls.length, 0);
  const result = await reprovisionExisting(f.ixc, f);
  assert.deepEqual(f.calls, [['botao_excluir_dispositivo_22434', '40'], ['authorize', '40']]);
  assert.equal(result.fiber.id_caixa_ftth, '123');
});
test('reprovisionamento bloqueia vinculo alterado e resposta inconclusiva', async () => {
  const f = reproFixture();
  await assert.rejects(reprovisionExisting(f.ixc, { ...f, client: { id: '99' } }), /vinculo alterado/);
  assert.equal(f.calls.length, 0);
  f.ixc.actionPost = async () => ({});
  await assert.rejects(reprovisionExisting(f.ixc, f), /nao confirmou a desprovisao/);
  assert.equal(f.calls.length, 0);
});
test('menu reprovisionar mostra endereco e cliques repetidos nao repetem operacao', async () => {
  const f = reproFixture();
  const flow = createWebFlow(f.ixc, { dryRun: false });
  const session = flow.create();
  try {
    await flow.dispatch(session, { callback: 'repro:start' });
    await flow.dispatch(session, { text: '10' });
    assert.ok(session.messages.some(m => m.text.includes('Rua Teste, 77')));
    const button = () => session.messages.at(-1).keyboard.inline_keyboard[0][0].callback_data;
    await flow.dispatch(session, { callback: button() });
    const confirm = button();
    await flow.dispatch(session, { callback: confirm });
    await flow.dispatch(session, { callback: confirm });
    assert.equal(f.calls.length, 2);
    assert.ok(session.messages.some(m => m.text.includes('IXC confirmou o reprovisionamento')));
  } finally { flow.dispose(session); }
});

test('troca sem caixa ou porta orienta NOC antes de oferecer remocao', async () => {
  for (const fiber of [{}, { id_caixa_ftth: '0', porta_ftth: '1' }, { id_caixa_ftth: '1', porta_ftth: '0' }, { id_caixa_ftth: '', porta_ftth: '' }]) {
    const state = { oldFiber: fiber, onu: { id_olt: '5' } };
    const replies = [];
    await askSwapOldFiberRemoval({ reply: async (...args) => replies.push(args) }, state);
    assert.equal(state.step, 'swap_lookup_blocked');
    assert.match(replies[0][0], /Cliente sem caixa e porta no cadastro\. Confirmar primeiro com o NOC/);
    assert.equal(replies[0].length, 1);
  }
  assert.equal(hasSwapBoxAndPort({ id_caixa_ftth: '12', porta_ftth: '1' }), true);
  assert.throws(() => buildProvisionPayload({ serviceType: 'troca', swapWithoutBox: true }), /Projeto importacao/);
});

test('endereco proprio do contrato nao e substituido pelo endereco do cliente', () => {
  const client = { endereco: 'Rua do cliente', numero: '99' };
  assert.match(contractAddress({ endereco_padrao_cliente: 'N', endereco: 'Rua da instalacao', numero: '12' }, client), /^Rua da instalacao, 12/);
  assert.match(contractAddress({ endereco_padrao_cliente: 'S' }, client), /^Rua do cliente, 99/);
  assert.match(contractAddress({ endereco_padrao_cliente: 'N' }, client), /^Rua nao informada, numero nao informado/);
});

test('botao preserva numero quando a rua precisa ser abreviada', () => {
  const text = contractButtonLabel({ id: '12345', endereco: 'Rua muito longa '.repeat(20), numero: '9876' });
  assert.ok(text.length <= 60);
  assert.ok(text.endsWith(', 9876'));
});

for (const prefix of ['contract', 'maccontract', 'signalcontract']) {
  test(`${prefix}: todas as opcoes mostram rua e numero`, async () => {
    const contracts = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 100), endereco: `Rua ${i}`, numero: String(i + 200) }));
    const replies = [];
    await sendContractOptions({ reply: async (text, extra) => replies.push({ text, extra }) }, contracts, null, prefix, 'token');
    const fullText = replies.map(r => r.text).join('\n');
    const buttons = replies.at(-1).extra.reply_markup.inline_keyboard.flat();
    for (let i = 0; i < contracts.length; i++) {
      assert.ok(fullText.includes(`Rua ${i}, ${i + 200}`));
      assert.ok(buttons[i].text.includes(`Rua ${i}, ${i + 200}`));
      assert.ok(buttons[i].callback_data.startsWith(`${prefix}:`));
    }
  });
}
