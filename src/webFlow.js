import { randomUUID } from 'node:crypto';
import { registerFlow, releaseFlowSession } from './flow.js';

// Adapter: the web channel executes the same business flow as Telegram.
export function createWebFlow(ixc, config) {
  const middleware = [], routes = [];
  const bot = {
    use: fn => middleware.push(fn),
    start: fn => routes.push({ type: 'command', match: 'start', fn }),
    command: (match, fn) => routes.push({ type: 'command', match, fn }),
    action: (match, fn) => routes.push({ type: 'action', match, fn }),
    on: (match, fn) => routes.push({ type: 'on', match, fn }),
  };
  registerFlow(bot, ixc, { ...config, allowedTelegramIds: [] });
  return {
    create: () => ({ id: `web:${randomUUID()}`, messages: [], receipts: new Map(), busy: false, sequence: 0 }),
    dispose: session => releaseFlowSession(session.id),
    async dispatch(session, input) {
      const reply = async (text, options = {}) => {
        session.messages.push({ id: ++session.sequence, text: String(text), keyboard: options.reply_markup || null });
        session.messages = session.messages.slice(-40);
        return { message_id: session.sequence };
      };
      const ctx = { chat: { id: session.id }, from: { id: session.id }, reply,
        replyWithPhoto: async (_photo, options) => reply(options?.caption || ''),
        answerCbQuery: async () => {},
      };
      if (input.callback) ctx.callbackQuery = { data: input.callback };
      else ctx.message = input.location ? { location: input.location } : { text: input.text };
      const command = input.text?.match(/^\/(\w+)$/)?.[1];
      const route = routes.find(r => r.type === 'command' ? r.match === command :
        r.type === 'action' ? input.callback && r.match.test(input.callback) :
          r.match === (input.location ? 'location' : input.text ? 'text' : ''));
      let index = -1;
      const next = async () => { index++; return index < middleware.length ? middleware[index](ctx, next) : route?.fn(ctx); };
      try { await next(); }
      catch { await reply('Nao foi possivel concluir esta etapa. Confira o estado no IXC antes de repetir uma operacao. Use /cancelar para voltar.'); }
    },
  };
}
