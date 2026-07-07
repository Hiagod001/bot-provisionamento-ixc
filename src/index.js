import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { IxcClient } from './ixcClient.js';
import { registerFlow } from './flow.js';

const bot = new Telegraf(config.telegramBotToken);
const ixc = new IxcClient(config.ixc);

registerFlow(bot, ixc, config);

bot.catch(async (error, ctx) => {
  console.error('Erro no bot:', error);
  await ctx.reply('Ocorreu um erro ao consultar o IXC. Tente novamente ou envie /cancelar.');
});

bot.launch({ dropPendingUpdates: true });

console.log(`Bot de provisionamento iniciado. DRY_RUN=${config.dryRun ? 'true' : 'false'}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
