import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { IxcClient } from './ixcClient.js';
import { registerFlow } from './flow.js';

const bot = new Telegraf(config.telegramBotToken);
const ixc = new IxcClient(config.ixc);

registerFlow(bot, ixc, config);

bot.catch(async (error, ctx) => {
  console.error('Erro no bot:', error);
  const reason = String(error?.message || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 350);
  await ctx.reply(
    reason
      ? `Nao conclui o provisionamento.\n${reason}`
      : 'Nao conclui o provisionamento. Tente novamente ou envie /cancelar.'
  );
});

const launchWithRetry = async () => {
  while (true) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log(`Bot de provisionamento iniciado. DRY_RUN=${config.dryRun ? 'true' : 'false'}`);
      return;
    } catch (error) {
      console.error(`Telegram indisponivel ao iniciar: ${error?.code || error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
};

await launchWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
