import test from 'node:test';
import assert from 'node:assert/strict';
import { contractAddress, contractButtonLabel } from '../src/format.js';
import { sendContractOptions, buildProvisionPayload } from '../src/flow.js';

test('troca sem caixa antiga permite zeros sem liberar instalacao ou caixa de outro projeto', () => {
  const state = { serviceType: 'troca', swapWithoutBox: true, box: null, olt: { id: '5' }, profile: { id: '1' } };
  const payload = buildProvisionPayload(state);
  assert.equal(payload.clienteFibra.id_caixa_ftth, '0');
  assert.equal(payload.clienteFibra.porta_ftth, '0');
  assert.throws(() => buildProvisionPayload({ ...state, serviceType: 'instalacao' }), /Projeto importacao/);
  assert.throws(() => buildProvisionPayload({ ...state, swapWithoutBox: false }), /Projeto importacao/);
  assert.throws(() => buildProvisionPayload({ ...state, box: { id: '10', id_projeto: '38' } }), /Projeto importacao/);
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
