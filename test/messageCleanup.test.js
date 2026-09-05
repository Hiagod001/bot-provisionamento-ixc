import test from 'node:test';
import assert from 'node:assert/strict';

import { clearTrackedMessages, MessageHistoryStore } from '../src/messageCleanup.js';

test('historico guarda IDs unicos por conversa', () => {
  const store = new MessageHistoryStore(null);
  store.track('10', 100);
  store.track('10', 101);
  store.track('10', 100);
  store.track('20', 200);

  assert.deepEqual(store.take('10'), [100, 101]);
  assert.deepEqual(store.take('20'), [200]);
});

test('limpeza apaga o fluxo anterior em lote e esvazia o historico', async () => {
  const store = new MessageHistoryStore(null);
  store.track('10', 100);
  store.track('10', 101);
  const calls = [];
  const ctx = {
    chat: { id: 10 },
    telegram: {
      deleteMessages: async (chatId, ids) => calls.push({ chatId, ids }),
      deleteMessage: async () => {
        throw new Error('nao deveria usar contingencia');
      },
    },
  };

  const deleted = await clearTrackedMessages(ctx, store, { includeRecent: false });

  assert.equal(deleted, 2);
  assert.deepEqual(calls, [{ chatId: 10, ids: [101, 100] }]);
  assert.deepEqual(store.take('10'), []);
});

test('primeira limpeza inclui as mensagens recentes ainda nao rastreadas', async () => {
  const store = new MessageHistoryStore(null);
  const batches = [];
  const ctx = {
    chat: { id: 10 },
    message: { message_id: 150 },
    telegram: {
      deleteMessages: async (_chatId, ids) => batches.push(ids),
      deleteMessage: async () => true,
    },
  };

  const deleted = await clearTrackedMessages(ctx, store);

  assert.equal(deleted, 100);
  assert.equal(batches[0][0], 150);
  assert.equal(batches[0].at(-1), 51);
});
