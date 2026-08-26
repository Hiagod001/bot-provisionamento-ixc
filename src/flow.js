import {
  confirmKeyboard,
  locationKeyboard,
  oldFiberKeyboard,
  portsKeyboard,
  provisionKeyboard,
  retryProvisionKeyboard,
  rowsKeyboard,
  serviceKeyboard,
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
  serviceLabel,
  short,
} from './format.js';

const sessions = new Map();

const newSession = () => ({
  step: 'service',
  serviceType: null,
  serialSuffix: null,
  matches: [],
  onu: null,
  oldFiber: null,
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

const mustChooseMessage = 'Use os botoes da mensagem anterior ou envie /cancelar para recomecar.';

const ensureAllowed = (ctx, allowedIds) => {
  if (!allowedIds.length) return true;
  return allowedIds.includes(String(ctx.from?.id));
};

const askProvisionStart = async (ctx) => {
  await ctx.reply(
    'Opa! Eu sou o bot de provisionamento.\n\nToque em Provisionar para comecar.',
    provisionKeyboard()
  );
};

const askServiceChoice = async (ctx) => {
  resetSession(ctx);
  await ctx.reply('Escolha o servico:', serviceKeyboard());
};

const askSerial = async (ctx, state) => {
  state.step = 'serial';
  await ctx.reply(`${serviceLabel(state.serviceType)}\n\nEnvie os 7 ultimos caracteres do serial.`);
};

const continueWithPendingOnus = async (ctx, state, ixc, onus) => {
  if (!onus.length) {
    state.step = 'serial';
    await ctx.reply(
      'ONU nao apareceu na fila. Reconecte a ONU, aguarde alguns segundos e envie o serial de novo.'
    );
    return;
  }

  if (onus.length === 1) {
    state.onu = onus[0];
    await ctx.reply(formatOnu(state.onu));
    if (state.onu?.id_olt) await loadOlt(state, ixc);
    if (state.serviceType === 'troca') {
      state.step = 'client';
      await ctx.reply('Envie o ID do cliente.');
      return;
    }
    await askBoxLocation(ctx, state);
    return;
  }

  state.matches = onus;
  state.step = 'onu_choose';
  await ctx.reply(
    'Escolha a ONU:',
    rowsKeyboard('onu', onus, (onu) =>
      `${onu.olt_nome || onu.id_olt || '-'} - ${onu.mac || onu.Chassi || 'sem serial'}`
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

  state.matches = rows;
  state.step = `${prefix}_choose`;
  await ctx.reply('Escolha uma opcao:', rowsKeyboard(prefix, rows, labelFn));
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

  state.matches = contracts;
  state.step = 'contract_choose';

  const list = contracts
    .slice(0, 10)
    .map((contract, index) => `${index + 1}. ${formatContract(contract, client)}`)
    .join('\n\n');

  await ctx.reply(
    `Cliente: ${short(client.razao)}\n\nContratos:\n\n${list}`,
    rowsKeyboard('contract', contracts, (contract, index) =>
      `${index + 1} - ${contract.id} - ${contract.contrato || contract.status || 'contrato'}`
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
        : `PPPoE: ${formatLogin(login)}\n\nBuscando scripts...`,
    (login) => `${login.id} - ${login.login}`
  );

  if (state.login) {
    if (state.serviceType === 'titularidade') {
      await askTitularityTransfer(ctx, state);
      return;
    }
    await clearLoginMacWithWarning(ctx, state, ixc);
    await askProfile(ctx, state, ixc);
  }
};

const handleSwapAfterContractChoice = async (ctx, state, ixc) => {
  const oldFibers = await ixc.findFiberClientsByContract(state.contract.id);
  if (!oldFibers.length) {
    state.step = 'swap_oldfiber_missing';
    await ctx.reply(
      'Nao achei ONU antiga nesse contrato. Confira o contrato ou envie /cancelar.'
    );
    return true;
  }

  if (oldFibers.length === 1) {
    state.oldFiber = oldFibers[0];
    await askSwapOldFiberRemoval(ctx, state);
    return true;
  }

  state.matches = oldFibers;
  state.step = 'swap_oldonu_choose';
  await ctx.reply(
    'Escolha a ONU antiga:',
    rowsKeyboard('swapoldonu', oldFibers, (onu) =>
      `${onu.id} - ${onu.mac || 'sem serial'} - caixa ${onu.id_caixa_ftth || '-'} porta ${onu.porta_ftth || '-'}`
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

const refreshSelectedContract = async (state, ixc) => {
  if (!state.contract?.id) return;

  const currentContract = await ixc.read('cliente_contrato', state.contract.id);
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
    await ctx.reply(`Contrato ${short(state.contract?.id)} ja esta ativo.`);
    return;
  }

  const response = await ixc.activateContract(state.contract.id);
  if (response?.type === 'error') {
    state.contractActivationWarning = response.message;
    await ctx.reply(`Aviso: nao ativei o contrato. ${response.message}`);
    return;
  }

  await ctx.reply('Contrato ativado.');
};

const clearLoginMacWithWarning = async (ctx, state, ixc) => {
  if (state.serviceType !== 'troca' || !state.login?.id) return;

  const response = await ixc.clearLoginMac(state.login.id);
  if (response?.type === 'error') {
    state.macCleanupWarning = response.message;
    await ctx.reply(`Aviso: nao limpei o MAC. ${response.message}`);
    return;
  }

  await ctx.reply('MAC limpo.');
};

const clearOldTitularityLoginMacWithWarning = async (ctx, state, ixc) => {
  const oldLoginId = state.oldFiber?.id_login;
  if (!oldLoginId || oldLoginId === '0') {
    state.macCleanupWarning = 'Cadastro de fibra antigo sem ID de login vinculado.';
    await ctx.reply('Aviso: login antigo sem ID para limpar MAC.');
    return;
  }

  if (String(oldLoginId) === String(state.login?.id)) return;

  const response = await ixc.clearLoginMac(oldLoginId);
  if (response?.type === 'error') {
    state.macCleanupWarning = response.message;
    await ctx.reply(`Aviso: nao limpei o MAC antigo. ${response.message}`);
    return;
  }

  await ctx.reply(`MAC antigo limpo. Login ${oldLoginId}`);
};

const askTitularityTransfer = async (ctx, state) => {
  state.step = 'titularity_confirm';
  await ctx.reply(
    `${formatAuthorizedOnu(state.oldFiber)}\n\nTransferir para o novo cliente?`,
    titularityKeyboard()
  );
};

const finishTitularityTransfer = async (ctx, state, ixc) => {
  await activateContractWithWarning(ctx, state, ixc);
  await clearOldTitularityLoginMacWithWarning(ctx, state, ixc);

  const patch = {
    id_contrato: short(state.contract?.id, ''),
    id_login: short(state.login?.id, ''),
    nome: short(state.client?.razao || state.login?.login || state.oldFiber?.nome, ''),
    endereco_padrao_cliente: 'S',
  };

  const response = await ixc.transferFiberClient(state.oldFiber.id, patch);
  const updatedFiber = (await ixc.read('radpop_radio_cliente_fibra', state.oldFiber.id)) || {
    ...state.oldFiber,
    ...patch,
  };

  await ctx.reply(buildTitularitySuccessMessage(state, updatedFiber));
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

const selectByCallback = async (ctx, prefix, field, nextStep, nextMessage) => {
  const state = getSession(ctx);
  const index = Number(ctx.callbackQuery.data.replace(`${prefix}:`, ''));
  const selected = state.matches[index];
  if (!selected) {
    await ctx.answerCbQuery('Opcao expirada. Envie /provisionar.');
    return null;
  }

  state[field] = selected;
  state.matches = [];
  state.step = nextStep;
  await ctx.answerCbQuery('Selecionado');
  await ctx.reply(nextMessage(selected));
  return selected;
};

const buildProvisionPayload = (state) => ({
  pendingOnuId: state.onu?.id,
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
  if (!state.onu?.id_olt) return;

  try {
    state.olt = await ixc.read('radpop_radio', state.onu.id_olt);
  } catch {
    state.olt = {
      id: state.onu.id_olt,
      descricao: state.onu.olt_nome,
      olt_nome: state.onu.olt_nome,
    };
  }

  if (!state.olt) {
    state.olt = {
      id: state.onu.id_olt,
      descricao: state.onu.olt_nome,
      olt_nome: state.onu.olt_nome,
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

  state.step = 'port_choose';
  await ctx.reply(
    `Caixa: ${short(state.box.descricao)}\nEscolha uma porta livre:`,
    portsKeyboard(freePorts)
  );
};

export const registerFlow = (bot, ixc, config) => {
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

  bot.action(/^service:/, async (ctx) => {
    const state = resetSession(ctx);
    state.serviceType = ctx.callbackQuery.data.replace('service:', '');
    await ctx.answerCbQuery('Servico selecionado');
    await askSerial(ctx, state);
  });

  bot.action(/^onu:/, async (ctx) => {
    const state = getSession(ctx);
    const onu = await selectByCallback(ctx, 'onu', 'onu', 'box_location', (selected) =>
      `ONU selecionada:\n${formatOnu(selected)}`
    );
    if (onu?.id_olt) await loadOlt(state, ixc);
    if (onu) {
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
    const oldFiber = await selectByCallback(ctx, 'oldonu', 'oldFiber', 'oldfiber_confirm', (selected) =>
      formatAuthorizedOnu(selected)
    );
    if (!oldFiber) return;
    await askOldFiberRemoval(ctx, state);
  });

  bot.action(/^swapoldonu:/, async (ctx) => {
    const state = getSession(ctx);
    const oldFiber = await selectByCallback(ctx, 'swapoldonu', 'oldFiber', 'swap_oldfiber_confirm', (selected) =>
      formatAuthorizedOnu(selected)
    );
    if (!oldFiber) return;
    await askSwapOldFiberRemoval(ctx, state);
  });

  bot.action(/^titularoldonu:/, async (ctx) => {
    const state = getSession(ctx);
    const oldFiber = await selectByCallback(ctx, 'titularoldonu', 'oldFiber', 'client', (selected) =>
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
    await ctx.reply('Removendo cadastro antigo...');
    await ixc.removeAuthorizedOnu(state.oldFiber.id);
    await ctx.reply('Removido. Buscando a ONU na fila...');

    const pending =
      state.pendingAfterOldFiberRemoval.length > 0
        ? state.pendingAfterOldFiberRemoval
        : await ixc.findPendingOnusBySerialSuffix(state.serialSuffix);

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
    await ctx.reply('Removendo ONU antiga...');
    await ixc.removeAuthorizedOnu(oldFiber.id);

    const box = oldFiber.id_caixa_ftth ? await ixc.read('rad_caixa_ftth', oldFiber.id_caixa_ftth) : null;
    state.box = box || {
      id: oldFiber.id_caixa_ftth,
      descricao: `Caixa ${oldFiber.id_caixa_ftth}`,
      capacidade: '',
    };
    state.dropPort = String(oldFiber.porta_ftth || '');
    state.oldFiber = null;

    await ctx.reply(
      `ONU antiga removida.\nCaixa/porta: ${short(state.box?.descricao)} / ${short(state.dropPort)}`
    );

    await askLoginForContract(ctx, state, ixc);
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
    await finishTitularityTransfer(ctx, state, ixc);
  });

  bot.action(/^box:/, async (ctx) => {
    const state = getSession(ctx);
    const box = await selectByCallback(ctx, 'box', 'box', 'port_lookup', (selected) =>
      `Caixa escolhida: ${short(selected.descricao)} (${short(selected.distanceMeters)}m)`
    );
    if (!box) return;
    await askFreePortChoice(ctx, state, ixc);
  });

  bot.action(/^port:/, async (ctx) => {
    const state = getSession(ctx);
    const port = Number.parseInt(ctx.callbackQuery.data.replace('port:', ''), 10);

    if (state.step !== 'port_choose' || !state.freePorts.includes(port)) {
      await ctx.answerCbQuery('Porta indisponivel ou etapa expirada');
      await ctx.reply('Porta indisponivel. Envie /provisionar.');
      return;
    }

    state.dropPort = String(port);
    state.step = 'client';
    await ctx.answerCbQuery(`Porta ${port} selecionada`);
    await ctx.reply(`Porta ${port}\n\nEnvie o ID do cliente.`);
  });

  bot.action(/^contract:/, async (ctx) => {
    const state = getSession(ctx);
    const contract = await selectByCallback(ctx, 'contract', 'contract', 'login_lookup', (selected) =>
      `${formatContract(selected, state.client)}\n\nBuscando PPPoE...`
    );
    if (!contract) return;

    if (state.serviceType === 'troca') {
      await handleSwapAfterContractChoice(ctx, state, ixc);
      return;
    }

    await askLoginForContract(ctx, state, ixc);
  });

  bot.action(/^login:/, async (ctx) => {
    const login = await selectByCallback(ctx, 'login', 'login', 'profile_lookup', (selected) =>
      getSession(ctx).serviceType === 'titularidade'
        ? `Login escolhido: ${formatLogin(selected)}\n\nVou preparar a transferencia de titularidade...`
        : `Login escolhido: ${formatLogin(selected)}\n\nVou listar os scripts da OLT...`
    );
    if (!login) return;
    const state = getSession(ctx);
    if (state.serviceType === 'titularidade') {
      await askTitularityTransfer(ctx, state);
      return;
    }
    await clearLoginMacWithWarning(ctx, state, ixc);
    await askProfile(ctx, state, ixc);
  });

  bot.action(/^profile:/, async (ctx) => {
    const profile = await selectByCallback(ctx, 'profile', 'profile', 'confirm', (selected) =>
      `Script escolhido: ${short(selected.nome)}`
    );
    if (!profile) return;
    const state = getSession(ctx);
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
      if (config.ixc.os.enabled) {
        try {
          const osResult = await ixc.createAndCloseProvisioningOs({
            client: state.client,
            contract: state.contract,
            login: state.login,
            box: state.box?.descricao || state.box?.id,
            port: state.dropPort,
            serial: result.provisionedOnu?.mac || state.onu?.mac || state.onu?.Chassi,
            address: contractAddress(state.contract, state.client),
          });
          if (osResult) {
            await ctx.reply(
              `Atendimento ${osResult.ticket.id} e OS ${osResult.serviceOrder.id} finalizados.`
            );
          }
        } catch (osError) {
          console.error('ONU provisionada, mas a OS nao foi concluida:', osError);
          await ctx.reply(
            `ONU provisionada, mas confira a OS no IXC: ${String(osError?.message || osError)}`
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
      console.error('Provisionamento nao concluido:', error);
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
    if (state.step !== 'box_location') {
      await ctx.reply('Nao estou escolhendo caixa agora. Envie /provisionar.');
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

    state.matches = boxes;
    state.step = 'box_choose';
    await ctx.reply(
      'Escolha a caixa:',
      rowsKeyboard('box', boxes, (box) =>
        `${box.distanceMeters}m - ${box.id} - ${box.descricao}`
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

    if (state.step === 'serial') {
      const serial = text.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z0-9]{7}$/.test(serial)) {
        await ctx.reply('Envie somente os 7 ultimos caracteres do serial.');
        return;
      }

      await ctx.reply(
        state.serviceType === 'titularidade'
          ? 'Buscando ONU cadastrada...'
          : 'Buscando ONU na fila...'
      );
      state.serialSuffix = serial;

      if (state.serviceType === 'titularidade') {
        const authorizedOnus = await ixc.findAuthorizedOnusBySerialSuffix(serial);
        if (!authorizedOnus.length) {
          await ctx.reply('Nao achei ONU cadastrada com esse serial.');
          return;
        }

        if (authorizedOnus.length === 1) {
          state.oldFiber = authorizedOnus[0];
          state.step = 'client';
          await ctx.reply(`${formatAuthorizedOnu(state.oldFiber)}\n\nEnvie o ID do novo cliente.`);
          return;
        }

        state.matches = authorizedOnus;
        state.step = 'titularoldonu_choose';
        await ctx.reply(
          'Escolha o cadastro:',
          rowsKeyboard('titularoldonu', authorizedOnus, (onu) =>
            `${onu.id} - ${onu.mac || 'sem serial'} - contrato ${onu.id_contrato || '-'}`
          )
        );
        return;
      }

      const onus = await ixc.findPendingOnusBySerialSuffix(serial);

      if (state.serviceType === 'mudanca') {
        const authorizedOnus = await ixc.findAuthorizedOnusBySerialSuffix(serial);
        if (authorizedOnus.length) {
          state.pendingAfterOldFiberRemoval = onus;

          if (authorizedOnus.length === 1) {
            state.oldFiber = authorizedOnus[0];
            await askOldFiberRemoval(ctx, state);
            return;
          }

          state.matches = authorizedOnus;
          state.step = 'oldonu_choose';
          await ctx.reply(
            'Escolha o cadastro antigo:',
            rowsKeyboard('oldonu', authorizedOnus, (onu) =>
              `${onu.id} - ${onu.mac || 'sem serial'} - contrato ${onu.id_contrato || '-'}`
            )
          );
          return;
        }
      }

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
        await ctx.reply('Caixa nao encontrada. Envie ID ou nome.');
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
        (box) => `${box.id} - ${box.descricao}`
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
        if (state.serviceType === 'troca') {
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
      if (state.serviceType === 'titularidade') {
        await ctx.reply(`PPPoE: ${formatLogin(login)}\n\nPreparando transferencia...`);
        await askTitularityTransfer(ctx, state);
        return;
      }
      await ctx.reply(`PPPoE: ${formatLogin(login)}\n\nBuscando scripts...`);
      await clearLoginMacWithWarning(ctx, state, ixc);
      await askProfile(ctx, state, ixc);
      return;
    }

    await askProvisionStart(ctx);
  });
};

const askProfile = async (ctx, state, ixc) => {
  await loadOlt(state, ixc);

  const profiles = await ixc.findProfilesByOlt(state.olt, state.onu);
  if (!profiles.length) {
    state.step = 'profile_manual';
    await ctx.reply(
      `Nao achei script para esta OLT. Confira os perfis no IXC ou envie /cancelar.`
    );
    return;
  }

  const defaultProfileId = state.olt?.perfil_fibra_padrao;
  const ordered = [
    ...profiles.filter((profile) => String(profile.id) === String(defaultProfileId)),
    ...profiles.filter((profile) => String(profile.id) !== String(defaultProfileId)),
  ];

  state.matches = ordered;
  state.step = 'profile_choose';
  const oltName = state.olt?.descricao || state.olt?.olt_nome || state.onu?.olt_nome;
  await ctx.reply(
    `OLT: ${short(oltName)}\nScripts: ${ordered.length}\n\nEscolha o script:`,
    rowsKeyboard('profile', ordered, (profile) =>
      `${profile.id} - ${profile.nome}${String(profile.id) === String(defaultProfileId) ? ' (padrao)' : ''}`
    )
  );
};
