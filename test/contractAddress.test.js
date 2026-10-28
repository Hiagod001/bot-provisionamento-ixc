import test from 'node:test';
import assert from 'node:assert/strict';
import { contractAddress, contractButtonLabel } from '../src/format.js';
import { sendContractOptions, askSwapOldFiberRemoval, hasSwapBoxAndPort, buildProvisionPayload } from '../src/flow.js';

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
