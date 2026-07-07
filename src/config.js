import 'dotenv/config';

const required = (name) => {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value.trim();
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'sim', 's', 'yes', 'y'].includes(String(value).toLowerCase());
};

const parseAllowedIds = (value) => {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  ixc: {
    baseUrl: required('IXC_BASE_URL').replace(/\/+$/, ''),
    token: required('IXC_TOKEN'),
    selfSigned: parseBoolean(process.env.IXC_SELF_SIGNED, true),
  },
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedTelegramIds: parseAllowedIds(process.env.ALLOWED_TELEGRAM_IDS),
};
