import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  confirmKeyboard,
  locationKeyboard,
  oldFiberKeyboard,
  onuConfirmationKeyboard,
  portsKeyboard,
  provisionKeyboard,
  retryPppoeKeyboard,
  retryProvisionKeyboard,
  rowsKeyboard,
  routerReplacementKeyboard,
  serviceKeyboard,
  signalKeyboard,
  signalResultKeyboard,
  swapEquipmentKeyboard,
  swapOldFiberKeyboard,
  titularityKeyboard,
} from './keyboards.js';
import {
  buildProvisionSuccessMessage,
  buildSummary,
  buildTitularitySuccessMessage,
  contractAddress,
  formatAuthorizedOnu,
  formatContract,
  formatLogin,
  formatOnu,
  formatSignalReportEntry,
  profileMode,
  profileModeLabel,
  serviceLabel,
  short,
} from './format.js';

const sessions = new Map();
const serialGuideImagePath = fileURLToPath(
  new URL('../assets/serial-onu-exemplo.png', import.meta.url)
);

const newSession = () => ({
  step: 'service',
  serviceType: null,
  swapEquipment: null,
  routerMacCleared: false,
  serialSuffix: null,
  matches: [],
  menuToken: null,
  onu: null,
  oldFiber: null,
  swapWithoutOldFiber: false,
  targetFibers: [],
  pendingAfterOldFiberRemoval: [],
  skipLoginAfterContractChoice: false,
  contractActivationWarning: null,
  macCleanupWarning: null,
  olt: null,
  box: null,
  dropPort: null,
  freePorts: [],
  client: null,
  contract: null,
  login: null,
  profile: null,
});

const sessionKey = (ctx) => String(ctx.chat?.id);

const getSession = (ctx) => {
  const key = sessionKey(ctx);
  if (!sessions.has(key)) sessions.set(key, newSession());
  return sessions.get(key);
};

const resetSession = (ctx) => {
  sessions.set(sessionKey(ctx), newSession());
  return sessions.get(sessionKey(ctx));
};

const isExpiredCallbackQueryError = (error) =>
  error?.code === 400 &&
  /query is too old|query id is invalid|response timeout expired/i.test(
    String(error?.description || error?.message || '')
  );

export const answerCallbackQuerySafely = async (answerCbQuery, ...args) => {
  try {
    return await answerCbQuery(...args);
  } catch (error) {
    if (isExpiredCallbackQueryError(error)) {
      console.warn('Callback antigo do Telegram ignorado; o fluxo continuou normalmente.');
      return undefined;
    }
    throw error;
  }
};

const mustChooseMessage = 'Use os botoes da mensagem anterior ou envie /cancelar para recomecar.';

const setMenuChoices = (state, rows, step) => {
  state.matches = rows;
  state.step = step;
  state.menuToken = randomUUID().replaceAll('-', '').slice(0, 12);
  return state.menuToken;
};

const clearMenuChoices = (state) => {
  state.matches = [];
  state.menuToken = null;
};

export const parseMenuCallback = (data, prefix) => {
  const match = String(data || '').match(new RegExp(`^${prefix}:([a-f0-9]{12}):(\\d+)$`, 'i'));
  if (!match) return null;
  return { token: match[1], value: Number.parseInt(match[2], 10) };
};

export const currentMenuCallbackValue = (state, prefix, expectedStep, data) => {
  const callback = parseMenuCallback(data, prefix);
  if (
    state.step !== expectedStep ||
    !callback ||
    callback.token !== state.menuToken
  ) {
    return null;
  }
  return callback.value;
};

const ensureAllowed = (ctx, allowedIds) => {
  if (!allowedIds.length) return true;
  return allowedIds.includes(String(ctx.from?.id));
};

const askProvisionStart = async (ctx) => {
  await ctx.reply(
    'Opa! O que voce precisa fazer?',
    provisionKeyboard()
  );
};

const askSignalChoice = async (ctx) => {
  const state = resetSession(ctx);
  state.step = 'signal_choice';
  await ctx.reply('Como deseja verificar o sinal?', signalKeyboard());
};

const sendSignalReport = async (ctx, title, reports, options = {}) => {
  const entries = reports.map((report) => formatSignalReportEntry(report, options));
  const messages = [];
  let current = title;

  for (const entry of entries) {
    const candidate = `${current}\n\n${entry}`;
    if (candidate.length > 3500 && current !== title) {
      messages.push(current);
      current = entry;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  for (let index = 0; index < messages.length; index += 1) {
    const isLast = index === messages.length - 1;
    await ctx.reply(messages[index], isLast ? signalResultKeyboard() : undefined);
  }
};

const withBoxNames = async (ixc, fibers) =>
  typeof ixc.enrichFiberBoxNames === 'function'
    ? ixc.enrichFiberBoxNames(fibers)
    : fibers;

const showClientContractSignal = async (ctx, state, ixc) => {
  await ctx.reply('Consultando o relatorio de potencia...');
  const fibers = await withBoxNames(
    ixc,
    await ixc.findFiberClientsForContract(state.contract.id)
  );
  if (!fibers.length) {
    resetSession(ctx);
    await ctx.reply(
      `Contrato ${short(state.contract.id)} sem ONU cadastrada.`,
      signalResultKeyboard()
    );
    return;
  }

  const reports = await ixc.getFiberPowerReports(fibers);
  const title = [
    'Sinal do cliente',
    short(state.client?.razao),
    `Cliente: ${short(state.client?.id)} | Contrato: ${short(state.contract?.id)}`,
  ].join('\n');
  resetSession(ctx);
  await sendSignalReport(ctx, title, reports, { showBox: true });
};

const askServiceChoice = async (ctx) => {
  resetSession(ctx);
  await ctx.reply('Escolha o servico:', serviceKeyboard());
};

const isRouterReplacement = (state) =>
  state.serviceType === 'troca' && state.swapEquipment === 'router';

const askRouterReplacementConfirmation = async (ctx, state) => {
  state.step = 'router_replace_confirm';
  await ctx.reply(
    [
      'Confirmar troca do roteador:',
      `Cliente: ${short(state.client?.razao)}`,
      `Contrato: ${short(state.contract?.id)}`,
      `PPPoE: ${short(state.login?.login)}`,
      '',
      'O bot vai limpar somente o MAC do PPPoE e abrir a OS de troca do roteador.',
    ].join('\n'),
    routerReplacementKeyboard()
  );
};

const askSerial = async (ctx, state) => {
  state.step = 'serial';
  const message = [
    serviceLabel(state.serviceType),
    '',
    'Para identificar a ONU, digite no minimo 4 caracteres do campo SN mostrado na foto.',
  ].join('\n');

  try {
    await ctx.replyWithPhoto({ source: serialGuideImagePath }, { caption: message });
  } catch (error) {
    console.error('Nao consegui enviar a imagem de exemplo do serial:', error?.message || error);
    await ctx.reply(message);
  }
};

export const normalizeSerialFragment = (value) => {
  const fragment = String(value || '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(fragment) ? fragment : null;
};

export const formatNearbyBoxLabel = (box) =>
  `${box.distanceMeters}m - ${box.descricao || box.nome || 'Caixa sem descricao'}`;

const documentDigits = (client) => String(client?.cnpj_cpf || '').replace(/\D/g, '');

export const validatePppoeCredentials = (client, login) => {
  const document = documentDigits(client);
  if (![11, 14].includes(document.length)) {
    return { valid: false, reason: 'documento_cliente', document };
  }

  const currentLogin = String(login?.login || '').trim().toUpperCase();
  const escapedDocument = document.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contractVariation = '(?:[A-Z]|\\d{1,2})?';
  const acceptedLogin = new RegExp(
    `^${contractVariation}${escapedDocument}${contractVariation}$`
  );
  if (!acceptedLogin.test(currentLogin)) {
    return { valid: false, reason: 'login', document };
  }

  if (String(login?.senha || '') !== document.slice(0, 6)) {
    return { valid: false, reason: 'senha', document };
  }

  return { valid: true, document };
};

export const selectTechnicianProfiles = (profiles, defaultProfileId = '') => {
  const ordered = [
    ...profiles.filter((profile) => String(profile.id) === String(defaultProfileId)),
    ...profiles.filter((profile) => String(profile.id) !== String(defaultProfileId)),
  ];
  const selected = ['bridge', 'integrada']
    .map((mode) => ordered.find((profile) => profileMode(profile) === mode))
    .filter(Boolean);
  return selected.length ? selected : ordered;
};

const blockInvalidPppoe = async (ctx, state, validation) => {
  state.step = 'pppoe_blocked';
  const detail =
    validation.reason === 'login'
      ? `Login atual: ${short(state.login?.login)}\nPadrao: CPF/CNPJ do cliente.`
      : validation.reason === 'senha'
        ? 'A senha nao corresponde aos 6 primeiros digitos do CPF/CNPJ.'
        : 'O CPF/CNPJ do cliente esta ausente ou invalido no IXC.';

  await ctx.reply(
    `PPPoE fora do padrao.\n${detail}\n\nAcione o NOC para corrigir antes de continuar.`,
    retryPppoeKeyboard()
  );
};

const continueWithPendingOnus = async (ctx, state, ixc, onus) => {
  if (!onus.length) {
    state.step = 'serial';
    await ctx.reply(
      'ONU nao apareceu na fila. Reconecte a ONU, aguarde alguns segundos e envie o serial de novo.'
    );
    return;
  }

  const menuToken = setMenuChoices(state, onus, 'onu_choose');
  await ctx.reply(
    `ONUs encontradas: ${onus.length}\nEscolha pelo serial completo:`,
    rowsKeyboard(
      'onu',
      onus,
      (onu) =>
        `${onu.mac || onu.Chassi || 'sem serial'} - ${onu.olt_nome || onu.id_olt || 'OLT desconhecida'}`,
      menuToken
    )
  );
};

const askOldFiberRemoval = async (ctx, state) => {
  state.step = 'oldfiber_confirm';
  await ctx.reply(
    `${formatAuthorizedOnu(state.oldFiber)}\n\nPara mudar endereco, remova o cadastro antigo primeiro.`,
    oldFiberKeyboard()
  );
};

const askSwapOldFiberRemoval = async (ctx, state) => {
  state.step = 'swap_oldfiber_confirm';
  await ctx.reply(
    `${formatAuthorizedOnu(state.oldFiber)}\n\nVou remover a ONU antiga e usar a mesma caixa/porta.`,
    swapOldFiberKeyboard()
  );
};

const pickSingleOrAsk = async (ctx, state, rows, field, step, prefix, message, labelFn) => {
  if (rows.length === 1) {
    state[field] = rows[0];
    state.step = step;
    await ctx.reply(message(rows[0]));
    return true;
  }

  const menuToken = setMenuChoices(state, rows, `${prefix}_choose`);
  await ctx.reply('Escolha uma opcao:', rowsKeyboard(prefix, rows, labelFn, menuToken));
  return false;
};

const askContractChoice = async (ctx, state, contracts, client) => {
  if (contracts.length === 1) {
    state.contract = contracts[0];
    state.step = 'login_lookup';
    await ctx.reply(
      `Cliente: ${short(client.razao)}\n\n${formatContract(contracts[0], client)}\n\nBuscando PPPoE...`
    );
    return true;
  }

  const menuToken = setMenuChoices(state, contracts, 'contract_choose');

  const list = contracts
    .slice(0, 10)
    .map((contract, index) => `${index + 1}. ${formatContract(contract, client)}`)
    .join('\n\n');

  await ctx.reply(
    `Cliente: ${short(client.razao)}\n\nContratos:\n\n${list}`,
    rowsKeyboard(
      'contract',
      contracts,
      (contract, index) =>
        `${index + 1} - ${contract.id} - ${contract.contrato || contract.status || 'contrato'}`,
      menuToken
    )
  );
  return false;
};

const askLoginForContract = async (ctx, state, ixc) => {
  const logins = await ixc.findPppoeLoginsByContract(state.contract.id);
  if (!logins.length) {
    state.step = 'login_id';
    await ctx.reply('Nao achei PPPoE. Envie o ID do login.');
    return;
  }

  await pickSingleOrAsk(
    ctx,
    state,
    logins,
    'login',
    state.serviceType === 'titularidade' ? 'titularity_lookup' : 'profile_lookup',
    'login',
    (login) =>
      state.serviceType === 'titularidade'
        ? `PPPoE: ${formatLogin(login)}\n\nPreparando transferencia...`
        : isRouterReplacement(state)
          ? `PPPoE: ${formatLogin(login)}\n\nPreparando troca do roteador...`
        : `PPPoE: ${formatLogin(login)}\n\nBuscando scripts...`,
    (login) => `${login.id} - ${login.login}`
  );

  if (state.login) {
    await validateAndContinuePppoe(ctx, state, ixc);
  }
};

export const handleSwapAfterContractChoice = async (ctx, state, ixc) => {
  const oldFibers = await withBoxNames(
    ixc,
    await ixc.findFiberClientsByContract(state.contract.id)
  );
  if (!oldFibers.length) {
    state.oldFiber = null;
    state.swapWithoutOldFiber = true;
    await askBoxLocation(ctx, state);
    return true;
  }

  state.swapWithoutOldFiber = false;
  if (oldFibers.length === 1) {
    state.oldFiber = oldFibers[0];
    await askLoginForContract(ctx, state, ixc);
    return true;
  }

  const menuToken = setMenuChoices(state, oldFibers, 'swap_oldonu_choose');
  await ctx.reply(
    'Escolha a ONU antiga:',
    rowsKeyboard(
      'swapoldonu',
      oldFibers,
      (onu) =>
        `${onu.id} - ${onu.mac || 'sem serial'} - caixa ${onu.caixa_nome || 'sem nome'} porta ${onu.porta_ftth || '-'}`,
      menuToken
    )
  );
  return true;
};

const normalizeContractStatus = (value) =>
  short(value, '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

const isContractActive = (contract) => {
  const status = normalizeContractStatus(contract?.status);
  return status === 'A' || status === 'ATIVO' || status === 'ACTIVE';
};

const isTransientIxcError = (error) =>
  ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);

const refreshSelectedContract = async (state, ixc) => {
  if (!state.contract?.id) return;

  let currentContract;
  try {
    currentContract = await ixc.read('cliente_contrato', state.contract.id);
  } catch (error) {
    if (isTransientIxcError(error) && normalizeContractStatus(state.contract?.status)) {
      console.warn(
        `IXC oscilou ao reler o contrato ${state.contract.id}; usando o status obtido na selecao.`
      );
      return;
    }
    throw error;
  }
  if (currentContract) {
    state.contract = {
      ...state.contract,
      ...currentContract,
      cidade_nome: currentContract.cidade_nome || state.contract.cidade_nome,
    };
  }
};

const activateContractWithWarning = async (ctx, state, ixc) => {
  if (!['instalacao', 'titularidade'].includes(state.serviceType)) return;

  await refreshSelectedContract(state, ixc);

  if (isContractActive(state.contract)) {
    console.log(`Contrato ${short(state.contract?.id)} ja estava ativo.`);
    return;
  }

  const response = await ixc.activateContract(state.contract.id);
  if (response?.type === 'error') {
    state.contractActivationWarning = response.message;
    console.error(`Nao foi possivel ativar o contrato ${state.contract.id}: ${response.message}`);
    return;
  }

  console.log(`Contrato ${state.contract.id} ativado pelo bot.`);
};

const clearLoginMacWithWarning = async (ctx, state, ixc) => {
  if (!['troca', 'mudanca'].includes(state.serviceType) || !state.login?.id) return;

  const response = await ixc.clearLoginMac(state.login.id);
  if (response?.type === 'error') {
    state.macCleanupWarning = response.message;
    console.error(`Nao foi possivel limpar o MAC do login ${state.login.id}: ${response.message}`);
    return;
  }

  console.log(`MAC do login ${state.login.id} limpo pelo bot.`);
};

const clearTitularityLoginMacsWithWarning = async (ctx, state, ixc) => {
  const oldLoginId = state.oldFiber?.id_login;
  const newLoginId = state.login?.id;
  const loginIds = [...new Set([oldLoginId, newLoginId].filter((id) => id && id !== '0').map(String))];

  if (!oldLoginId || oldLoginId === '0') {
    state.macCleanupWarning = 'Cadastro de fibra antigo sem ID de login vinculado.';
    console.error(state.macCleanupWarning);
  }

  for (const loginId of loginIds) {
    const label = String(loginId) === String(oldLoginId) ? 'antigo' : 'novo';
    try {
      const response = await ixc.clearLoginMac(loginId);
      if (response?.type === 'error') throw new Error(response.message);
      console.log(`MAC do login ${label} ${loginId} limpo pelo bot.`);
    } catch (error) {
      const warning = `Login ${loginId}: ${String(error?.message || error)}`;
      state.macCleanupWarning = [state.macCleanupWarning, warning].filter(Boolean).join(' | ');
      console.error(`Nao foi possivel limpar o MAC do login ${label}: ${warning}`);
    }
  }
};

const continueAfterValidatedPppoe = async (ctx, state, ixc) => {
  if (isRouterReplacement(state)) {
    await askRouterReplacementConfirmation(ctx, state);
    return;
  }
  if (state.serviceType === 'titularidade') {
    await prepareTitularityProfile(ctx, state, ixc);
    return;
  }
  if (state.serviceType === 'troca' && state.oldFiber?.id) {
    await askSwapOldFiberRemoval(ctx, state);
    return;
  }
  await clearLoginMacWithWarning(ctx, state, ixc);
  await askProfile(ctx, state, ixc);
};

export const completeRouterReplacement = async (ctx, state, ixc, config) => {
  if (state.step !== 'router_replace_confirm' || !isRouterReplacement(state)) {
    await ctx.reply('Etapa expirada. Envie /provisionar.');
    return false;
  }

  if (config.dryRun) {
    resetSession(ctx);
    await ctx.reply('DRY_RUN ativo: o MAC nao foi limpo e a OS nao foi criada.');
    return true;
  }

  state.step = 'router_replace_processing';
  await ctx.reply('Limpando o MAC do PPPoE e abrindo a OS...');
  try {
    const clearResponse = await ixc.clearLoginMac(state.login.id);
    if (clearResponse?.type === 'error') {
      throw new Error(clearResponse.message || 'O IXC recusou a limpeza do MAC.');
    }
    state.routerMacCleared = true;

    const osResult = await ixc.createAndCloseRouterReplacementOs({
      client: state.client,
      contract: state.contract,
      login: state.login,
      address: contractAddress(state.contract, state.client),
    });
    if (!osResult?.serviceOrder?.id) {
      throw new Error('O IXC nao retornou a ordem de servico da troca do roteador.');
    }

    await ctx.reply(
      `Troca do roteador concluida.\nMAC do PPPoE limpo.\nOS ${osResult.serviceOrder.id} aberta e finalizada.`
    );
    resetSession(ctx);
    return true;
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 350);
    if (state.routerMacCleared) {
      resetSession(ctx);
      await ctx.reply(`MAC do PPPoE foi limpo, mas a OS nao foi concluida.\nMotivo: ${reason}`);
    } else {
      state.step = 'router_replace_confirm';
      await ctx.reply(`Nao consegui limpar o MAC. Nenhuma OS foi aberta.\nMotivo: ${reason}`);
    }
    return false;
  }
};

const validateAndContinuePppoe = async (ctx, state, ixc) => {
  const validation = validatePppoeCredentials(state.client, state.login);
  if (!validation.valid) {
    await blockInvalidPppoe(ctx, state, validation);
    return false;
  }
  await continueAfterValidatedPppoe(ctx, state, ixc);
  return true;
};

const askTitularityTransfer = async (ctx, state, ixc) => {
  const targetFibers = await withBoxNames(
    ixc,
    await ixc.findFiberClientsByLogin(state.login.id)
  );
  state.targetFibers = targetFibers.filter(
    (fiber) => String(fiber.id) !== String(state.oldFiber?.id)
  );
  state.step = 'titularity_confirm';

  const conflictMessage = state.targetFibers.length
    ? [
        '',
        'ATENCAO: o login novo ja possui ONU cadastrada:',
        ...state.targetFibers.map((fiber) => formatAuthorizedOnu(fiber)),
        '',
        'Ao confirmar, essa ONU sera desautorizada e o cadastro sera removido antes da transferencia.',
      ].join('\n')
    : '';

  await ctx.reply(
    `${formatAuthorizedOnu(state.oldFiber)}${conflictMessage}\n\nTransferir para o novo cliente?`,
    titularityKeyboard(state.targetFibers.length > 0)
  );
};

export const findExistingTitularityProfile = async (ixc, oldFiber) => {
  const profileId = String(oldFiber?.id_perfil || '').trim();
  if (!profileId || profileId === '0') return null;
  return ixc.read('radpop_radio_cliente_fibra_perfil', profileId);
};

const prepareTitularityProfile = async (ctx, state, ixc) => {
  await loadOlt(state, ixc);
  const profile = await findExistingTitularityProfile(ixc, state.oldFiber);

  if (profile) {
    state.profile = profile;
    await ctx.reply(`Script mantido: ${short(profile.nome)} (ID ${profile.id})`);
    await askTitularityTransfer(ctx, state, ixc);
    return;
  }

  await ctx.reply('A ONU atual esta sem script valido. Escolha o script para continuar.');
  await askProfile(ctx, state, ixc);
};

const finishTitularityTransfer = async (ctx, state, ixc, config) => {
  for (const targetFiber of state.targetFibers || []) {
    await ixc.removeAuthorizedOnu(targetFiber.id);
    console.log(`ONU conflitante ${targetFiber.id} removida do login novo.`);
  }

  await activateContractWithWarning(ctx, state, ixc);
  await clearTitularityLoginMacsWithWarning(ctx, state, ixc);

  const patch = {
    id_contrato: short(state.contract?.id, ''),
    id_login: short(state.login?.id, ''),
    nome: short(state.client?.razao || state.login?.login || state.oldFiber?.nome, ''),
    endereco_padrao_cliente: 'S',
    id_perfil: short(state.profile?.id, ''),
  };

  const response = await ixc.transferFiberClient(state.oldFiber.id, patch);
  const updatedFiber = (await ixc.read('radpop_radio_cliente_fibra', state.oldFiber.id)) || {
    ...state.oldFiber,
    ...patch,
  };
  updatedFiber.caixa_nome ||= state.oldFiber?.caixa_nome || '';

  await ctx.reply(buildTitularitySuccessMessage(state, updatedFiber));
  const signal = await sendProvisionSignal(ctx, ixc, updatedFiber);
  if (config.ixc.os.enabled) {
    try {
      const osResult = await ixc.createAndCloseProvisioningOs({
        client: state.client,
        contract: state.contract,
        login: state.login,
        fiberId: updatedFiber.id,
        signal,
        box: updatedFiber.caixa_nome || 'Nome nao encontrado',
        port: updatedFiber.porta_ftth,
        serial: updatedFiber.mac,
        address: contractAddress(state.contract, state.client),
      });
      if (osResult) console.log(`OS ${osResult.serviceOrder.id} finalizada para a fibra ${updatedFiber.id}.`);
    } catch (error) {
      state.osWarning = String(error?.message || error);
      console.error('Titularidade concluida, mas a OS falhou:', state.osWarning);
    }
  }
  if (state.contractActivationWarning) {
    await ctx.reply(`Aviso: verifique manualmente a ativacao do contrato. Motivo: ${state.contractActivationWarning}`);
  }
  if (response?.type === 'error') {
    await ctx.reply(`Aviso do IXC: ${response.message}`);
  }
  if (state.macCleanupWarning) {
    await ctx.reply(`Aviso: verifique manualmente a limpeza do MAC do login antigo. Motivo: ${state.macCleanupWarning}`);
  }
  resetSession(ctx);
};

const enrichCityNames = async (ixc, records) => {
  const list = Array.isArray(records) ? records : [records];
  const cityIds = [...new Set(list.map((record) => record?.cidade).filter(Boolean))];
  const names = new Map();

  await Promise.all(
    cityIds.map(async (cityId) => {
      names.set(String(cityId), await ixc.findCityName(cityId));
    })
  );

  for (const record of list) {
    if (record?.cidade) record.cidade_nome = names.get(String(record.cidade)) || '';
  }
};

export const sendProvisionSignal = async (ctx, ixc, fiber) => {
  let signal;
  try {
    if (!fiber?.id) throw new Error('ONU sem ID para consultar sinal');
    signal = await ixc.getOnuPowerSummary(fiber.id);
  } catch (error) {
    console.error('Sinal apos provisionamento indisponivel:', error?.message || error);
  }
  try {
    await ctx.reply(formatSignalReportEntry({
      fiber: { nome: 'Sinal da ONU' },
      signal,
      status: 'Sem leitura no momento. Consulte novamente em Verificar sinal.',
    }));
  } catch (error) {
    console.error('Nao consegui enviar o sinal ao tecnico:', error?.message || error);
  }
  return signal || null;
};

const selectByCallback = async (ctx, prefix, expectedStep, field, nextStep, nextMessage) => {
  const state = getSession(ctx);
  const index = currentMenuCallbackValue(state, prefix, expectedStep, ctx.callbackQuery.data);
  const selected = index === null ? null : state.matches[index];
  if (!selected) {
    await ctx.answerCbQuery('Opcao expirada. Envie /provisionar.');
    return null;
  }

  state[field] = selected;
  clearMenuChoices(state);
  state.step = nextStep;
  await ctx.answerCbQuery('Selecionado');
  await ctx.reply(nextMessage(selected));
  return selected;
};

const buildProvisionPayload = (state) => ({
  pendingOnuId: state.onu?.id,
  cleanupExistingLogin: state.serviceType === 'troca',
  clienteFibra: {
    radpop_estrutura: 'N',
    id_transmissor: short(state.olt?.id || state.onu?.id_olt, ''),
    id_caixa_ftth: short(state.box?.id, ''),
    porta_ftth: short(state.dropPort, ''),
    id_contrato: short(state.contract?.id, ''),
    id_login: short(state.login?.id, ''),
    nome: short(state.client?.razao || state.login?.login || state.onu?.mac, 'ONU provisionada pelo bot'),
    mac: short(state.onu?.mac || state.onu?.Chassi, ''),
    id_perfil: short(state.profile?.id, ''),
    comandos: short(state.profile?.comando || state.profile?.comandos, ''),
    ponid: short(state.onu?.ponid || state.onu?.ponno, ''),
    slotno: short(state.onu?.slotno, ''),
    ponno: short(state.onu?.ponno, ''),
    onu_numero: short(state.onu?.onu_numero, ''),
    onu_tipo: short(state.onu?.modelo, ''),
    service_port: '',
    id_chamado_radpop: '0',
    login_onu_cliente: 'admin',
    senha_onu_cliente: 'admin',
    porta_telnet_onu_cliente: '23',
    porta_web_onu_cliente: '80',
    tipo_autenticacao: 'MAC',
    endereco_padrao_cliente: 'S',
  },
});

const loadOlt = async (state, ixc) => {
  if (state.olt) return;
  const oltId = state.onu?.id_olt || state.oldFiber?.id_transmissor;
  if (!oltId) return;

  try {
    state.olt = await ixc.read('radpop_radio', oltId);
  } catch {
    state.olt = {
      id: oltId,
      descricao: state.onu?.olt_nome || `OLT ${oltId}`,
      olt_nome: state.onu?.olt_nome || `OLT ${oltId}`,
    };
  }

  if (!state.olt) {
    state.olt = {
      id: oltId,
      descricao: state.onu?.olt_nome || `OLT ${oltId}`,
      olt_nome: state.onu?.olt_nome || `OLT ${oltId}`,
    };
  }
};

const askBoxLocation = async (ctx, state) => {
  state.step = 'box_location';
  await ctx.reply(
    'Envie sua localizacao para buscar caixas proximas.',
    locationKeyboard()
  );
};

const askFreePortChoice = async (ctx, state, ixc) => {
  await ctx.reply('Buscando portas livres...');
  const freePorts = await ixc.findFreeBoxPorts(state.box);
  state.freePorts = freePorts;

  if (!freePorts.length) {
    state.step = 'box_location';
    await ctx.reply(
      `Sem porta livre na caixa ${short(state.box?.descricao)}. Envie outra localizacao.`
    );
    return;
  }

  const menuToken = setMenuChoices(state, freePorts, 'port_choose');
  await ctx.reply(
    `Caixa: ${short(state.box.descricao)}\nEscolha uma porta livre:`,
    portsKeyboard(freePorts, menuToken)
  );
};

export const registerFlow = (bot, ixc, config) => {
  bot.use(async (ctx, next) => {
    if (typeof ctx.answerCbQuery === 'function') {
      const originalAnswerCbQuery = ctx.answerCbQuery.bind(ctx);
      ctx.answerCbQuery = (...args) => answerCallbackQuerySafely(originalAnswerCbQuery, ...args);
    }
    return next();
  });

  bot.use(async (ctx, next) => {
    if (!ensureAllowed(ctx, config.allowedTelegramIds)) {
      await ctx.reply('Telegram nao autorizado.');
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    resetSession(ctx);
    await askProvisionStart(ctx);
  });

  bot.command('provisionar', async (ctx) => {
    await askServiceChoice(ctx);
  });

  bot.command('sinal', async (ctx) => {
    await askSignalChoice(ctx);
  });

  bot.command('cancelar', async (ctx) => {
    resetSession(ctx);
    await ctx.reply('Cancelado. Envie /provisionar para iniciar.');
  });

  bot.command('status', async (ctx) => {
    const state = getSession(ctx);
    await ctx.reply(`Etapa atual: ${state.step}`);
  });

  bot.action(/^provision:start$/, async (ctx) => {
    await ctx.answerCbQuery('Vamos la');
    await askServiceChoice(ctx);
  });

  bot.action(/^signal:start$/, async (ctx) => {
    await ctx.answerCbQuery('Verificar sinal');
    await askSignalChoice(ctx);
  });

  bot.action(/^signal:/, async (ctx) => {
    const action = ctx.callbackQuery.data;
    if (action === 'signal:start') return;
    if (action === 'signal:again') {
      await ctx.answerCbQuery('Nova consulta');
      await askSignalChoice(ctx);
      return;
    }
    if (action === 'signal:menu' || action === 'signal:back') {
      await ctx.answerCbQuery('Voltando');
      resetSession(ctx);
      await askProvisionStart(ctx);
      return;
    }

    const state = getSession(ctx);
    if (state.step !== 'signal_choice') {
      await ctx.answerCbQuery('Opcao expirada');
      return;
    }

    if (action === 'signal:client') {
      state.step = 'signal_client_id';
      await ctx.answerCbQuery('Sinal do cliente');
      await ctx.reply('Envie o ID do cliente.');
      return;
    }

    state.step = 'signal_box_location';
    await ctx.answerCbQuery('Clientes de uma caixa');
    await ctx.reply('Envie sua localizacao para escolher a caixa.', locationKeyboard());
  });

  bot.action(/^signalbox:/, async (ctx) => {
    const state = getSession(ctx);
    const box = await selectByCallback(ctx, 'signalbox', 'signal_box_choose', 'box', 'signal_box_loading', (selected) =>
      `Caixa escolhida: ${short(selected.descricao)}`
    );
    if (!box) return;

    await ctx.reply('Consultando o sinal das ONUs da caixa...');
    const fibers = await ixc.findFiberClientsByBox(box.id);
    if (!fibers.length) {
      resetSession(ctx);
      await ctx.reply('Nao ha clientes cadastrados nessa caixa.', signalResultKeyboard());
      return;
    }

    const namedFibers = await ixc.enrichFiberClientNames(fibers);
    const reports = await ixc.getFiberPowerReports(namedFibers);
    resetSession(ctx);
    await sendSignalReport(
      ctx,
      `Sinal dos clientes da caixa\n${short(box.descricao)}\nClientes: ${reports.length}`,
      reports
    );
  });

  bot.action(/^signalcontract:/, async (ctx) => {
    const state = getSession(ctx);
    const contract = await selectByCallback(
      ctx,
      'signalcontract',
      'signal_contract_choose',
      'contract',
      'signal_contract_loading',
      (selected) => formatContract(selected, state.client)
    );
    if (!contract) return;
    await showClientContractSignal(ctx, state, ixc);
  });

  bot.action(/^service:/, async (ctx) => {
    const state = resetSession(ctx);
    state.serviceType = ctx.callbackQuery.data.replace('service:', '');
    await ctx.answerCbQuery('Servico selecionado');
    if (state.serviceType === 'troca') {
      state.step = 'swap_equipment_choice';
      await ctx.reply('Qual equipamento sera trocado?', swapEquipmentKeyboard());
      return;
    }
    await askSerial(ctx, state);
  });

  bot.action(/^swapequipment:/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'swap_equipment_choice' || state.serviceType !== 'troca') {
      await ctx.answerCbQuery('Opcao expirada');
      return;
    }

    state.swapEquipment = ctx.callbackQuery.data.replace('swapequipment:', '');
    if (state.swapEquipment === 'onu') {
      await ctx.answerCbQuery('Trocar ONU');
      await askSerial(ctx, state);
      return;
    }
    if (state.swapEquipment === 'router') {
      state.step = 'client';
      await ctx.answerCbQuery('Trocar roteador');
      await ctx.reply('Envie o ID do cliente.');
      return;
    }
    await ctx.answerCbQuery('Opcao invalida');
  });

  bot.action(/^routerreplace:confirm$/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'router_replace_confirm') {
      await ctx.answerCbQuery('Etapa expirada');
      return;
    }
    await ctx.answerCbQuery('Confirmado');
    await completeRouterReplacement(ctx, state, ixc, config);
  });

  bot.action(/^onu:/, async (ctx) => {
    const state = getSession(ctx);
    const onu = await selectByCallback(ctx, 'onu', 'onu_choose', 'onu', 'box_location', (selected) =>
      `ONU selecionada:\n${formatOnu(selected)}`
    );
    if (onu?.id_olt) await loadOlt(state, ixc);
    if (onu) {
      if (state.serviceType === 'mudanca') {
        state.step = 'address_onu_confirm';
        await ctx.reply('Confirma que esta e a ONU correta?', onuConfirmationKeyboard());
        return;
      }
      if (state.serviceType === 'troca') {
        state.step = 'client';
        await ctx.reply('Envie o ID do cliente.');
      } else {
        await askBoxLocation(ctx, state);
      }
    }
  });

  bot.action(/^oldonu:/, async (ctx) => {
    const state = getSession(ctx);
    const oldFiber = await selectByCallback(ctx, 'oldonu', 'oldonu_choose', 'oldFiber', 'oldfiber_confirm', (selected) =>
      formatAuthorizedOnu(selected)
    );
    if (!oldFiber) return;
    await askOldFiberRemoval(ctx, state);
  });

  bot.action(/^addressonu:/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'address_onu_confirm' || !state.onu) {
      await ctx.answerCbQuery('Etapa expirada');
      return;
    }

    if (ctx.callbackQuery.data === 'addressonu:no') {
      await ctx.answerCbQuery('Vamos buscar novamente');
      state.onu = null;
      state.olt = null;
      await askSerial(ctx, state);
      return;
    }

    await ctx.answerCbQuery('ONU confirmada');
    await askBoxLocation(ctx, state);
  });

  bot.action(/^swapoldonu:/, async (ctx) => {
    const state = getSession(ctx);
    const oldFiber = await selectByCallback(ctx, 'swapoldonu', 'swap_oldonu_choose', 'oldFiber', 'login_lookup', (selected) =>
      `${formatAuthorizedOnu(selected)}\n\nValidando PPPoE...`
    );
    if (!oldFiber) return;
    await askLoginForContract(ctx, state, ixc);
  });

  bot.action(/^titularoldonu:/, async (ctx) => {
    const state = getSession(ctx);
    const oldFiber = await selectByCallback(ctx, 'titularoldonu', 'titularoldonu_choose', 'oldFiber', 'client', (selected) =>
      `${formatAuthorizedOnu(selected)}\n\nEnvie o ID do novo cliente.`
    );
    if (!oldFiber) return;
  });

  bot.action(/^oldfiber:delete$/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'oldfiber_confirm' || !state.oldFiber?.id) {
      await ctx.answerCbQuery('Etapa expirada');
      await ctx.reply('Etapa expirada. Envie /provisionar.');
      return;
    }

    await ctx.answerCbQuery('Removendo cadastro antigo');
    await ixc.removeAuthorizedOnu(state.oldFiber.id);
    console.log(`Cadastro de fibra antigo ${state.oldFiber.id} removido na mudanca de endereco.`);

    const pending = await ixc.findPendingOnusBySerialSuffix(state.serialSuffix);

    state.oldFiber = null;
    state.pendingAfterOldFiberRemoval = [];
    await continueWithPendingOnus(ctx, state, ixc, pending);
  });

  bot.action(/^swapoldfiber:delete$/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'swap_oldfiber_confirm' || !state.oldFiber?.id) {
      await ctx.answerCbQuery('Etapa expirada');
      await ctx.reply('Etapa expirada. Envie /provisionar.');
      return;
    }

    const oldFiber = state.oldFiber;
    if (!oldFiber.id_caixa_ftth || !oldFiber.porta_ftth || oldFiber.porta_ftth === '0') {
      await ctx.answerCbQuery('Dados antigos incompletos');
      await ctx.reply(
        'ONU antiga sem caixa/porta. Corrija no IXC ou envie /cancelar.'
      );
      return;
    }

    await ctx.answerCbQuery('Removendo equipamento antigo');
    await ixc.removeAuthorizedOnu(oldFiber.id);

    const box = oldFiber.id_caixa_ftth ? await ixc.read('rad_caixa_ftth', oldFiber.id_caixa_ftth) : null;
    state.box = box || {
      id: oldFiber.id_caixa_ftth,
      descricao: 'Caixa sem nome',
      capacidade: '',
    };
    state.dropPort = String(oldFiber.porta_ftth || '');
    state.oldFiber = null;

    console.log(`Equipamento antigo ${oldFiber.id} removido na troca de equipamento.`);
    await clearLoginMacWithWarning(ctx, state, ixc);
    await askProfile(ctx, state, ixc);
  });

  bot.action(/^pppoe:retry$/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'pppoe_blocked' || !state.client?.id || !state.login?.id) {
      await ctx.answerCbQuery('Etapa expirada');
      return;
    }

    await ctx.answerCbQuery('Verificando PPPoE');
    const [client, login] = await Promise.all([
      ixc.findClient(state.client.id),
      ixc.read('radusuarios', state.login.id),
    ]);
    if (client) state.client = { ...state.client, ...client };
    if (login) state.login = { ...state.login, ...login };
    await validateAndContinuePppoe(ctx, state, ixc);
  });

  bot.action(/^titularity:transfer$/, async (ctx) => {
    const state = getSession(ctx);
    if (state.step !== 'titularity_confirm' || !state.oldFiber?.id || !state.contract?.id || !state.login?.id) {
      await ctx.answerCbQuery('Etapa expirada');
      await ctx.reply('Etapa expirada. Envie /provisionar.');
      return;
    }

    await ctx.answerCbQuery('Transferindo titularidade');
    await ctx.reply('Transferindo titularidade...');
    await finishTitularityTransfer(ctx, state, ixc, config);
  });

  bot.action(/^box:/, async (ctx) => {
    const state = getSession(ctx);
    const box = await selectByCallback(ctx, 'box', 'box_choose', 'box', 'port_lookup', (selected) =>
      `Caixa escolhida: ${short(selected.descricao)} (${short(selected.distanceMeters)}m)`
    );
    if (!box) return;
    await askFreePortChoice(ctx, state, ixc);
  });

  bot.action(/^port:/, async (ctx) => {
    const state = getSession(ctx);
    const port = currentMenuCallbackValue(
      state,
      'port',
      'port_choose',
      ctx.callbackQuery.data
    );

    if (
      port === null ||
      !state.freePorts.includes(port)
    ) {
      await ctx.answerCbQuery('Porta indisponivel ou etapa expirada');
      await ctx.reply('Porta indisponivel. Envie /provisionar.');
      return;
    }

    state.dropPort = String(port);
    clearMenuChoices(state);
    await ctx.answerCbQuery(`Porta ${port} selecionada`);
    if (
      state.serviceType === 'troca' &&
      state.swapWithoutOldFiber &&
      state.contract?.id
    ) {
      await askLoginForContract(ctx, state, ixc);
      return;
    }
    if (state.serviceType === 'mudanca' && state.login?.id) {
      await askProfile(ctx, state, ixc);
      return;
    }
    state.step = 'client';
    await ctx.reply(`Porta ${port}\n\nEnvie o ID do cliente.`);
  });

  bot.action(/^contract:/, async (ctx) => {
    const state = getSession(ctx);
    const contract = await selectByCallback(ctx, 'contract', 'contract_choose', 'contract', 'login_lookup', (selected) =>
      `${formatContract(selected, state.client)}\n\nBuscando PPPoE...`
    );
    if (!contract) return;

    if (state.serviceType === 'troca' && !isRouterReplacement(state)) {
      await handleSwapAfterContractChoice(ctx, state, ixc);
      return;
    }

    await askLoginForContract(ctx, state, ixc);
  });

  bot.action(/^login:/, async (ctx) => {
    const login = await selectByCallback(ctx, 'login', 'login_choose', 'login', 'profile_lookup', (selected) =>
      getSession(ctx).serviceType === 'titularidade'
        ? `Login escolhido: ${formatLogin(selected)}\n\nVou preparar a transferencia de titularidade...`
        : `Login escolhido: ${formatLogin(selected)}\n\nVou listar os scripts da OLT...`
    );
    if (!login) return;
    const state = getSession(ctx);
    await validateAndContinuePppoe(ctx, state, ixc);
  });

  bot.action(/^profile:/, async (ctx) => {
    const profile = await selectByCallback(ctx, 'profile', 'profile_choose', 'profile', 'confirm', (selected) =>
      `Tipo escolhido: ${profileModeLabel(selected)}`
    );
    if (!profile) return;
    const state = getSession(ctx);
    if (state.serviceType === 'titularidade') {
      await askTitularityTransfer(ctx, state, ixc);
      return;
    }
    await ctx.reply(buildSummary(state), confirmKeyboard());
  });

  bot.action(/^confirm:/, async (ctx) => {
    const state = getSession(ctx);
    const action = ctx.callbackQuery.data;
    const accepted = action === 'confirm:yes' || action === 'confirm:retry';
    const expectedStep = action === 'confirm:retry' ? 'retry' : 'confirm';

    if (accepted && state.step !== expectedStep) {
      await ctx.answerCbQuery('Esta tentativa ja expirou');
      return;
    }

    await ctx.answerCbQuery(
      action === 'confirm:retry' ? 'Tentando novamente' : accepted ? 'Confirmado' : 'Cancelado'
    );

    if (!accepted) {
      resetSession(ctx);
      await ctx.reply('Cancelado. Envie /provisionar para iniciar.');
      return;
    }

    const payload = buildProvisionPayload(state);
    if (config.dryRun) {
      resetSession(ctx);
      await ctx.reply(
        `DRY_RUN ativo: nada foi gravado no IXC.\n\nPayload que seria enviado:\n${JSON.stringify(payload.clienteFibra, null, 2)}`
      );
      return;
    }

    state.step = 'provisioning';
    try {
      await activateContractWithWarning(ctx, state, ixc);
      const result = await ixc.provisionOnu(payload);
      await ctx.reply(buildProvisionSuccessMessage(state, result.provisionedOnu));
      const signal = await sendProvisionSignal(ctx, ixc, result.provisionedOnu);
      if (config.ixc.os.enabled) {
        try {
          const osResult = await ixc.createAndCloseProvisioningOs({
            client: state.client,
            contract: state.contract,
            login: state.login,
            fiberId: result.provisionedOnu?.id,
            signal,
            box: state.box?.descricao || state.box?.id,
            port: state.dropPort,
            serial: result.provisionedOnu?.mac || state.onu?.mac || state.onu?.Chassi,
            address: contractAddress(state.contract, state.client),
          });
          if (osResult) console.log(`OS ${osResult.serviceOrder.id} finalizada para a fibra ${result.provisionedOnu?.id}.`);
        } catch (osError) {
          console.error(
            'ONU provisionada, mas a OS nao foi concluida:',
            osError?.code || '',
            osError?.message || osError
          );
        }
      }
      if (state.contractActivationWarning) {
        await ctx.reply(`Aviso: confira a ativacao. ${state.contractActivationWarning}`);
      }
      if (state.macCleanupWarning) {
        await ctx.reply(`Aviso: confira a limpeza do MAC. ${state.macCleanupWarning}`);
      }
      resetSession(ctx);
    } catch (error) {
      console.error(
        'Provisionamento nao concluido:',
        error?.code || '',
        error?.message || error
      );
      state.step = 'retry';
      const reason = String(error?.message || 'Falha ao consultar o IXC.')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 350);
      await ctx.reply(
        `Nao consegui provisionar.\n${reason}\n\nApos o NOC corrigir, tente novamente.`,
        retryProvisionKeyboard()
      );
    }
  });

  bot.on('location', async (ctx) => {
    const state = getSession(ctx);
    const isSignalLookup = state.step === 'signal_box_location';
    if (state.step !== 'box_location' && !isSignalLookup) {
      await ctx.reply('Nao estou escolhendo caixa agora. Use o menu para comecar.');
      return;
    }

    await ctx.reply('Buscando caixas proximas...', {
      reply_markup: { remove_keyboard: true },
    });

    const boxes = await ixc.findBoxesNearLocation(ctx.message.location, {
      radiusMeters: 300,
      limit: 10,
    });

    if (!boxes.length) {
      await ctx.reply(
        'Nao achei caixa em ate 300m. Envie uma localizacao mais perto da CTO.'
      );
      return;
    }

    const menuToken = setMenuChoices(
      state,
      boxes,
      isSignalLookup ? 'signal_box_choose' : 'box_choose'
    );
    await ctx.reply(
      'Escolha a caixa:',
      rowsKeyboard(
        isSignalLookup ? 'signalbox' : 'box',
        boxes,
        (box) => formatNearbyBoxLabel(box),
        menuToken
      )
    );
  });

  bot.on('text', async (ctx) => {
    const state = getSession(ctx);
    const text = ctx.message.text.trim();

    if (state.step === 'service') {
      await askProvisionStart(ctx);
      return;
    }

    if (state.step === 'signal_client_id') {
      if (!/^\d+$/.test(text)) {
        await ctx.reply('Envie apenas o ID do cliente.');
        return;
      }

      await ctx.reply('Buscando cliente e contratos...');
      const client = await ixc.findClient(text);
      if (!client) {
        await ctx.reply('Cliente nao encontrado.');
        return;
      }

      state.client = client;
      const contracts = await ixc.findContractsByClient(text);
      if (!contracts.length) {
        resetSession(ctx);
        await ctx.reply(
          `${short(client.razao)}\nNao possui contratos cadastrados.`,
          signalResultKeyboard()
        );
        return;
      }

      await enrichCityNames(ixc, [client, ...contracts]);
      if (contracts.length === 1) {
        state.contract = contracts[0];
        await showClientContractSignal(ctx, state, ixc);
        return;
      }

      const menuToken = setMenuChoices(state, contracts, 'signal_contract_choose');
      const contractList = contracts
        .slice(0, 10)
        .map((contract, index) => `${index + 1}. ${formatContract(contract, client)}`)
        .join('\n\n');
      await ctx.reply(
        `Cliente: ${short(client.razao)}\n\nContratos:\n\n${contractList}`,
        rowsKeyboard(
          'signalcontract',
          contracts,
          (_contract, index) => `Contrato ${index + 1}`,
          menuToken
        )
      );
      return;
    }

    if (state.step === 'signal_box_location') {
      await ctx.reply('Use o botao para enviar a localizacao.');
      return;
    }

    if (state.step === 'serial') {
      const serial = normalizeSerialFragment(text);
      if (!serial) {
        await ctx.reply('Digite no minimo 4 caracteres do serial, usando somente letras e numeros.');
        return;
      }

      await ctx.reply(
        state.serviceType === 'titularidade'
          ? 'Buscando ONU cadastrada...'
          : state.serviceType === 'mudanca'
            ? 'Verificando cadastro da ONU...'
          : 'Buscando ONU na fila...'
      );
      state.serialSuffix = serial;

      if (state.serviceType === 'titularidade') {
        const authorizedOnus = await withBoxNames(
          ixc,
          await ixc.findAuthorizedOnusBySerialSuffix(serial)
        );
        if (!authorizedOnus.length) {
          await ctx.reply('Nao achei ONU cadastrada com esse serial.');
          return;
        }

        const menuToken = setMenuChoices(state, authorizedOnus, 'titularoldonu_choose');
        await ctx.reply(
          `ONUs cadastradas encontradas: ${authorizedOnus.length}\nEscolha pelo serial completo:`,
          rowsKeyboard(
            'titularoldonu',
            authorizedOnus,
            (onu) => `${onu.mac || 'sem serial'} - contrato ${onu.id_contrato || '-'} - ID ${onu.id}`,
            menuToken
          )
        );
        return;
      }

      if (state.serviceType === 'mudanca') {
        const authorizedOnus = await withBoxNames(
          ixc,
          await ixc.findAuthorizedOnusBySerialSuffix(serial)
        );
        if (authorizedOnus.length) {
          const menuToken = setMenuChoices(state, authorizedOnus, 'oldonu_choose');
          await ctx.reply(
            `Cadastros antigos encontrados: ${authorizedOnus.length}\nEscolha pelo serial completo:`,
            rowsKeyboard(
              'oldonu',
              authorizedOnus,
              (onu) => `${onu.mac || 'sem serial'} - contrato ${onu.id_contrato || '-'} - ID ${onu.id}`,
              menuToken
            )
          );
          return;
        }
      }

      const onus = await ixc.findPendingOnusBySerialSuffix(serial);

      if (!onus.length) {
        await ctx.reply('Nao achei ONU pendente com esse serial.');
        return;
      }

      await continueWithPendingOnus(ctx, state, ixc, onus);
      return;
    }

    if (state.step === 'box_location') {
      await ctx.reply('Use o botao para enviar a localizacao.');
      return;
    }

    if (state.step === 'box') {
      await ctx.reply('Buscando caixa...');
      const oltId = state.olt?.id || state.onu?.id_olt;
      const boxes = await ixc.findBoxes(text, oltId);
      if (!boxes.length) {
        await ctx.reply('Caixa nao encontrada. Envie o nome.');
        return;
      }

      await pickSingleOrAsk(
        ctx,
        state,
        boxes,
        'box',
        'drop_port',
        'box',
        (box) => `Caixa escolhida: ${short(box.descricao)}\n\nEnvie a porta onde o drop esta ligado.`,
        (box) => box.descricao || box.nome || 'Caixa sem nome'
      );
      return;
    }

    if (state.step === 'port_choose') {
      await ctx.reply('Escolha a porta pelo menu.');
      return;
    }

    if (state.step === 'client') {
      if (!/^\d+$/.test(text)) {
        await ctx.reply('Envie apenas o ID do cliente.');
        return;
      }

      await ctx.reply('Buscando cliente...');
      const client = await ixc.findClient(text);
      if (!client) {
        await ctx.reply('Cliente nao encontrado.');
        return;
      }

      state.client = client;
      const contracts = await ixc.findContractsByClient(text);
      if (!contracts.length) {
        await ctx.reply(`${short(client.razao)}\nSem contratos encontrados.`);
        return;
      }

      await enrichCityNames(ixc, [client, ...contracts]);
      await askContractChoice(ctx, state, contracts, client);

      if (state.contract) {
        if (state.serviceType === 'troca' && !isRouterReplacement(state)) {
          await handleSwapAfterContractChoice(ctx, state, ixc);
          return;
        }
        await askLoginForContract(ctx, state, ixc);
      }
      return;
    }

    if (state.step === 'login_id') {
      if (!/^\d+$/.test(text)) {
        await ctx.reply('Envie apenas o ID do PPPoE.');
        return;
      }
      const login = await ixc.read('radusuarios', text);
      if (!login) {
        await ctx.reply('Login nao encontrado.');
        return;
      }
      state.login = login;
      await ctx.reply(`PPPoE: ${formatLogin(login)}`);
      await validateAndContinuePppoe(ctx, state, ixc);
      return;
    }

    if (state.step === 'profile_choose') {
      const requestedMode = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
      const mode = ['integrada', 'integrado'].includes(requestedMode)
        ? 'integrada'
        : requestedMode === 'bridge'
          ? 'bridge'
          : null;
      const profile = state.matches.find((item) => profileMode(item) === mode);
      if (!profile) {
        await ctx.reply('Escolha Integrada ou Bridge pelos botoes.');
        return;
      }

      state.profile = profile;
      clearMenuChoices(state);
      state.step = 'confirm';
      await ctx.reply(`Tipo escolhido: ${profileModeLabel(profile)}`);
      if (state.serviceType === 'titularidade') {
        await askTitularityTransfer(ctx, state, ixc);
        return;
      }
      await ctx.reply(buildSummary(state), confirmKeyboard());
      return;
    }

    await askProvisionStart(ctx);
  });
};

const askProfile = async (ctx, state, ixc) => {
  await loadOlt(state, ixc);

  const profiles = await ixc.findProfilesByOlt(state.olt, state.onu || state.oldFiber);
  if (!profiles.length) {
    state.step = 'profile_manual';
    await ctx.reply(
      `Nao achei script para esta OLT. Confira os perfis no IXC ou envie /cancelar.`
    );
    return;
  }

  const defaultProfileId = state.olt?.perfil_fibra_padrao;
  const choices = selectTechnicianProfiles(profiles, defaultProfileId);

  const menuToken = setMenuChoices(state, choices, 'profile_choose');
  await ctx.reply(
    'Preciso saber o tipo da ONU:\n\nEla e integrada ou bridge?',
    rowsKeyboard('profile', choices, (profile) => profileModeLabel(profile), menuToken)
  );
};
