import test from 'node:test';
import assert from 'node:assert/strict';
import { isConfirmedOltAction, reprovisionExisting } from '../src/reprovision.js';
import { resolveProvisionProfiles } from '../src/provisionProfiles.js';
import { askProfile } from '../src/flow.js';
import { createWebFlow } from '../src/webFlow.js';

const successHtml = '<div class="panel panel-success"><div>Command execute success. &#13;</div></div>';
const fixture = () => {
  const client = { id: '10' }, contract = { id: '20', id_cliente: '10', status: 'A', endereco: 'Rua A', numero: '1' }, login = { id: '30', id_cliente: '10', id_contrato: '20', login: 'test' };
  const fiber = { id: '40', id_login: '30', id_contrato: '20', mac: 'HWTC1234', id_transmissor: '6', id_perfil: '30', comandos: 'old commands', slotno: '8', ponno: '1', onu_numero: '1', id_caixa_ftth: '123', porta_ftth: '2', vlan: '1008' };
  const profiles = Object.fromEntries([
    ['30', 'F. INTEGRADA antiga'], ['86', 'INTEGRADA-OLT01.PMS'], ['87', 'BRIDGE-OLT01.PMS'],
    ['88', 'INTEGRADA-PTC'], ['89', 'BRIDGE-PTC'], ['84', 'INTEGRADA-OLT02.PMS'], ['90', 'BRIDGE-OLT02.PMS'],
    ['93', 'INTEGRADA-BRJ'], ['92', 'BRIDGE-BRJ'], ['91', 'INTEGRADA-CRZ'], ['32', 'BRIDGE-CRZ-PTC-PMS01'],
    ['96', 'INTEGRADA-SGA'], ['97', 'BRIDGE-SGA'], ['94', 'INTEGRADA-HUAWEI'], ['95', 'BRIDGE-HUAWEI'],
  ].map(([id, nome]) => [id, { id, nome, comando: `commands-${id}` }]));
  const calls = [];
  const ixc = {
    read: async (table, id) => table === 'radpop_radio_cliente_fibra_perfil' ? profiles[id] : ({ cliente_contrato: contract, radusuarios: login, radpop_radio_cliente_fibra: { ...fiber } })[table],
    ensureOnuAuthorizationApiAvailable: async () => {},
    actionPost: async () => { calls.push('remove'); return successHtml; },
    update: async (table, id, body) => { calls.push('update'); Object.assign(fiber, body); return { type: 'success' }; },
    authorizeOnu: async () => { calls.push('authorize'); return successHtml; },
    findClient: async () => client, findContractsByClient: async () => [contract], findPppoeLoginsByContract: async () => [login], findFiberClientsByLogin: async () => [{ ...fiber }],
  };
  return { ixc, client, contract, login, fiber, profiles, calls };
};

test('aceita confirmacao HTML real e JSON; rejeita retorno vazio, erro ou parcial', () => {
  assert.equal(isConfirmedOltAction(successHtml), true);
  assert.equal(isConfirmedOltAction('<div class="panel-primary"><div class="panel-heading-success">Autorizar ONU</div><span class="field-value">Command execute success. &#13;</span></div>'), true);
  assert.equal(isConfirmedOltAction({ type: 'success' }), true);
  for (const response of [{}, '', '<html>Login</html>', '<div class="panel-success">aguarde</div>',
    successHtml + '<div>Error: command failed</div>', successHtml + '<div class="panel-danger">falha</div>', successHtml + '<div class="panel-heading-danger">Resultado parcial</div>',
    { type: 'error', message: successHtml }, { type: 'success', message: 'Invalid command' }]) {
    assert.equal(isConfirmedOltAction(response), false);
  }
});

test('reprovisiona apos HTML, atualiza script e preserva cadastro e localizacao', async () => {
  const f = fixture(), original = { ...f.fiber };
  const result = await reprovisionExisting(f.ixc, f, { wait: async () => {} });
  assert.deepEqual(f.calls, ['remove', 'update', 'authorize']);
  assert.deepEqual(result.fiber, { ...original, id_perfil: '86', comandos: 'commands-86' });
});

test('revalida perfil antes da desprovisao e bloqueia OLT ou perfil desconhecido', async () => {
  const f = fixture();
  await assert.rejects(reprovisionExisting(f.ixc, { ...f, profile: { id: '86', comando: 'outdated' } }), /Script alterado/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(resolveProvisionProfiles(f.ixc, { oltId: '1104', oldFiber: f.fiber }), /mapeamento/);
  await assert.rejects(resolveProvisionProfiles(f.ixc, { oltId: '6', oldFiber: { id_perfil: '999' } }), /script antigo/);
  f.profiles['30'].nome = 'Sem tipo';
  await assert.rejects(reprovisionExisting(f.ixc, f), /inequivoco/);
  assert.deepEqual(f.calls, []);
});

test('script antigo fornece o tipo, OLT de destino determina o perfil aprovado', async () => {
  const f = fixture();
  for (const [oltId, ids] of Object.entries({ '1': ['88','89'], '6': ['86','87'], '7': ['84','90'], '8': ['93','92'], '9': ['91','32'], '1105': ['96','97'], '2': ['94','95'], '3': ['94','95'], '4': ['94','95'], '5': ['94','95'], '1056': ['94','95'] })) {
    for (const [index, type] of ['INTEGRADA', 'BRIDGE'].entries()) {
      f.profiles['30'].nome = type;
      const result = await resolveProvisionProfiles(f.ixc, { oltId, oldFiber: f.fiber });
      assert.equal(result.profile.id, ids[index]);
    }
  }
});

test('pergunta tipo somente sem perfil antigo, antes de desprovisionar', async () => {
  const f = fixture(); f.fiber.id_perfil = '0';
  const flow = createWebFlow(f.ixc, { dryRun: false }), session = flow.create();
  try {
    await flow.dispatch(session, { callback: 'repro:start' });
    await flow.dispatch(session, { text: '10' });
    const button = () => session.messages.at(-1).keyboard.inline_keyboard[0][0].callback_data;
    await flow.dispatch(session, { callback: button() });
    assert.match(session.messages.at(-1).text, /sem script/);
    assert.deepEqual(f.calls, []);
    await flow.dispatch(session, { callback: button() });
    assert.match(session.messages.at(-1).text, /Confirma desprovisionar/);
    await flow.dispatch(session, { callback: button() });
    assert.deepEqual(f.calls, ['remove', 'update', 'authorize']);
  } finally { flow.dispose(session); }
});

test('mudanca sem troca aproveita tipo antigo sem perguntar novamente', async () => {
  for (const serviceType of ['mudanca']) {
    const f = fixture(), messages = [];
    const state = { serviceType, oldFiber: f.fiber, login: f.login, contract: f.contract, client: f.client, onu: { id_olt: '8', mac: 'NEW' }, olt: { id: '8' }, matches: [], profileBeforeSwap: serviceType === 'troca' };
    await askProfile({ reply: async text => messages.push(text) }, state, f.ixc);
    assert.equal(state.profile.id, '93');
    assert.equal(state.step, serviceType === 'troca' ? 'swap_oldfiber_confirm' : 'confirm');
    assert.equal(messages.some(t => t.includes('A ONU e integrada ou bridge?')), false);
    assert.deepEqual(f.calls, []);
  }
});

test('troca de ONU oferece ambos os tipos e preserva escolha diferente do equipamento antigo', async () => {
  for (const serviceType of ['troca', 'mudanca']) {
    for (const [oldMode, newProfile] of [['BRIDGE', '94'], ['INTEGRADA', '95']]) {
      const f = fixture(), messages = [];
      f.profiles['30'].nome = oldMode;
      const state = { serviceType, moveSwapOnu: serviceType === 'mudanca', swapEquipment: 'onu',
        oldFiber: f.fiber, login: f.login, contract: f.contract, client: f.client,
        onu: { id_olt: '5', mac: 'NEW' }, olt: { id: '5' }, matches: [],
        profileBeforeSwap: serviceType === 'troca' };
      const ctx = { reply: async (text, options) => messages.push({ text, options }) };
      await askProfile(ctx, state, f.ixc);
      assert.equal(state.step, 'profile_choose');
      assert.equal(state.profile, undefined);
      assert.deepEqual(state.matches.map(p => p.id), ['94', '95']);
      assert.match(messages.at(-1).text, /NOVA ONU/);
      assert.deepEqual(f.calls, []);
      // Ao retornar da remocao, manter o tipo escolhido para a ONU nova.
      state.profile = f.profiles[newProfile];
      state.previousFiber = state.oldFiber;
      state.oldFiber = null;
      state.profileBeforeSwap = false;
      await askProfile(ctx, state, f.ixc);
      assert.equal(state.profile.id, newProfile);
      assert.equal(state.step, 'confirm');
      assert.equal(messages.some(m => m.text.includes('Tipo identificado pelo script anterior')), false);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('nao regrava apos alteracao concorrente nem repete escrita inconclusiva', async () => {
  const f = fixture();
  f.ixc.actionPost = async () => { f.fiber.porta_ftth = '3'; return successHtml; };
  await assert.rejects(reprovisionExisting(f.ixc, { ...f, fiber: { ...f.fiber } }, { wait: async () => {} }), /Cadastro mudou/);
  assert.deepEqual(f.calls, []);
  const g = fixture();
  g.ixc.authorizeOnu = async () => { g.calls.push('authorize'); return successHtml + '<div>Command failed</div>'; };
  await assert.rejects(reprovisionExisting(g.ixc, g, { wait: async () => {} }), /nao confirmou a regravacao/);
  assert.deepEqual(g.calls, ['remove', 'update', 'authorize']);
});

test('espera 30 segundos apos remover, avisa e bloqueia repeticao durante a espera', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = reprovisionExisting(f.ixc, { ...f, onWaiting: async () => { f.calls.push('notice'); } });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['remove', 'notice']);
  await assert.rejects(reprovisionExisting(f.ixc, f), /em processamento/);
  t.mock.timers.tick(29999);
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['remove', 'notice']);
  t.mock.timers.tick(1);
  await pending;
  assert.deepEqual(f.calls, ['remove', 'notice', 'update', 'authorize']);
});

test('sem confirmacao ou em simulacao nao espera nem regrava', async () => {
  const f = fixture();
  const options = { wait: async () => { throw Error('Nao deveria esperar'); } };
  await reprovisionExisting(f.ixc, { ...f, dryRun: true }, options);
  assert.deepEqual(f.calls, []);
  f.ixc.actionPost = async () => ({});
  await assert.rejects(reprovisionExisting(f.ixc, f, options), /nao confirmou a desprovisao/);
  assert.deepEqual(f.calls, []);
});

test('falha na mensagem nao impede espera e recuperacao; cadastro alterado durante espera bloqueia gravacao', async () => {
  const f = fixture();
  await reprovisionExisting(f.ixc, { ...f, onWaiting: async () => { throw Error('Canal indisponivel'); } }, {
    wait: async ms => { assert.equal(ms, 30000); f.calls.push('wait'); },
  });
  assert.deepEqual(f.calls, ['remove', 'wait', 'update', 'authorize']);
  const g = fixture();
  await assert.rejects(reprovisionExisting(g.ixc, g, {
    wait: async () => { g.fiber.id_login = '999'; },
  }), /Cadastro mudou/);
  assert.deepEqual(g.calls, ['remove']);
});
