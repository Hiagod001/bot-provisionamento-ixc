import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultStorePath = fileURLToPath(
  new URL('../data/message-history.json', import.meta.url)
);

export class MessageHistoryStore {
  constructor(filePath = defaultStorePath) {
    this.filePath = filePath;
    this.messages = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.filePath, 'utf8'));
      for (const [chatId, ids] of Object.entries(saved)) {
        this.messages.set(String(chatId), new Set(ids.filter(Number.isInteger)));
      }
    } catch (error) {
      console.error('Nao consegui ler o historico de mensagens:', error?.message || error);
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = Object.fromEntries(
      [...this.messages.entries()].map(([chatId, ids]) => [chatId, [...ids].slice(-500)])
    );
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }

  track(chatId, messageId) {
    if (chatId === undefined || chatId === null || !Number.isInteger(messageId)) return;
    const key = String(chatId);
    const ids = this.messages.get(key) || new Set();
    ids.add(messageId);
    this.messages.set(key, new Set([...ids].slice(-500)));
    this.persist();
  }

  take(chatId) {
    const key = String(chatId);
    const ids = [...(this.messages.get(key) || [])];
    this.messages.delete(key);
    this.persist();
    return ids;
  }
}

export const messageHistory = new MessageHistoryStore();

export const trackConversationMessages = async (ctx, next) => {
  const chatId = ctx.chat?.id;
  const incomingMessageId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id;
  messageHistory.track(chatId, incomingMessageId);

  for (const methodName of ['reply', 'replyWithPhoto']) {
    const original = ctx[methodName]?.bind(ctx);
    if (!original) continue;
    ctx[methodName] = async (...args) => {
      const sent = await original(...args);
      messageHistory.track(chatId, sent?.message_id);
      return sent;
    };
  }

  return next();
};

export const clearTrackedMessages = async (
  ctx,
  store = messageHistory,
  { includeRecent = true } = {}
) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId === null) return 0;
  const ids = new Set(store.take(chatId));
  const referenceMessageId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id;
  if (includeRecent && Number.isInteger(referenceMessageId)) {
    const firstMessageId = Math.max(1, referenceMessageId - 99);
    for (let messageId = firstMessageId; messageId <= referenceMessageId; messageId += 1) {
      ids.add(messageId);
    }
  }
  const orderedIds = [...ids].sort((a, b) => b - a);
  let deleted = 0;

  for (let index = 0; index < orderedIds.length; index += 100) {
    const batch = orderedIds.slice(index, index + 100);
    try {
      await ctx.telegram.deleteMessages(chatId, batch);
      deleted += batch.length;
    } catch {
      for (const messageId of batch) {
        try {
          await ctx.telegram.deleteMessage(chatId, messageId);
          deleted += 1;
        } catch {
          // Telegram nao apaga mensagens antigas, inexistentes ou sem permissao.
        }
      }
    }
  }

  return deleted;
};
