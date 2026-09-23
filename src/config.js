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

const optional = (name) => process.env[name]?.trim() || '';

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  ixc: {
    baseUrl: required('IXC_BASE_URL').replace(/\/+$/, ''),
    token: required('IXC_TOKEN'),
    selfSigned: parseBoolean(process.env.IXC_SELF_SIGNED, true),
    pendingOltIds: parseAllowedIds(process.env.IXC_PENDING_OLT_IDS),
    os: {
      enabled: parseBoolean(process.env.IXC_OS_ENABLED, true),
      subjectId: optional('IXC_OS_SUBJECT_ID') || '7',
      sectorId: optional('IXC_OS_SECTOR_ID') || '3',
      processId: optional('IXC_OS_PROCESS_ID') || '71',
      taskId: optional('IXC_OS_TASK_ID') || '677',
      responseId: optional('IXC_OS_RESPONSE_ID') || '5',
      diagnosisId: optional('IXC_OS_DIAGNOSIS_ID') || '507',
      technicianId: optional('IXC_OS_TECHNICIAN_ID') || '367',
    },
  },
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedTelegramIds: parseAllowedIds(process.env.ALLOWED_TELEGRAM_IDS),
};
