import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IxcClient,
  isImportProjectBox,
  buildProvisionOsMessage,
  buildRouterReplacementOsMessage,
  deriveProvisionNetworkFields,
  parseOnuPowerSummary,
  selectProfilesForOlt,
} from '../src/ixcClient.js';
import {
  answerCallbackQuerySafely,
  buildSerialRequestMessage,
  buildProvisionPayload,
  claimProcessingStep,
  clearLoginMacWithWarning,
  findExistingTitularityProfile,
  filterContractsForService,
  formatNearbyBoxLabel,
  handleSwapAfterContractChoice,
  POST_PROVISION_SIGNAL_DELAY_MS,
  completeRouterReplacement,
  currentMenuCallbackValue,
  normalizeSerialFragment,
  parseMenuCallback,
  registerFlow,
  sendProvisionSignal,
  sendDelayedProvisionSignal,
  selectTechnicianProfiles,
  selectContractByNumber,
  validatePppoeCredentials,
} from '../src/flow.js';
import {
  buildProvisionSuccessMessage,
  buildTitularitySuccessMessage,
  formatAuthorizedOnu,
  formatSignalReportEntry,
} from '../src/format.js';
import {
  portsKeyboard,
  credentialsCopyKeyboard,
  routerReplacementKeyboard,
  rowsKeyboard,
  signalResultKeyboard,
  provisionedSignalKeyboard,
  swapEquipmentKeyboard,
} from '../src/keyboards.js';

const huaweiReport = `Potencia de ONU
Sinal Rx: -21.48
Temperatura: 48
Voltagem: 3.260
Sinal Tx: -26.58
Status potencia: Regular
INFORMACOES ADICIONAIS:
Tx olt: 2.29
Rx olt: -26.58`;

test('etapa critica pode ser assumida somente uma vez', () => {
  const state = { step: 'titularity_confirm' };

  assert.equal(
    claimProcessingStep(state, 'titularity_confirm', 'titularity_processing'),
    true
  );
  assert.equal(state.step, 'titularity_processing');
  assert.equal(
    claimProcessingStep(state, 'titularity_confirm', 'titularity_processing'),
    false
  );
});

test('troca de ONU pede explicitamente o serial do novo equipamento', () => {
  const message = buildSerialRequestMessage({
    serviceType: 'troca',
    swapEquipment: 'onu',
  });

  assert.match(message, /SN do NOVO EQUIPAMENTO/);
});

test('instalacao mostra somente contratos em pre-ativacao', () => {
  const contracts = [
    { id: '1', status: 'P' },
    { id: '2', status: 'A' },
    { id: '3', status: 'D' },
    { id: '4', status: 'I' },
    { id: '5', status: 'C' },
  ];

  assert.deepEqual(
    filterContractsForService(contracts, 'instalacao').map((contract) => contract.id),
    ['1']
  );
});

test('contratos cancelados e inativos nao aparecem em outros fluxos', () => {
  const contracts = [
    { id: '1', status: 'P' },
    { id: '2', status: 'A' },
    { id: '3', status: 'D' },
    { id: '4', status: 'I' },
    { id: '5', status: 'C' },
  ];

  assert.deepEqual(
    filterContractsForService(contracts, 'troca').map((contract) => contract.id),
    ['1', '2']
  );
  assert.deepEqual(
    filterContractsForService(contracts, 'signal').map((contract) => contract.id),
    ['2']
  );
});

test('Huawei interpreta os tres sinais sem inverter TX da ONU e RX da OLT', () => {
  const signal = parseOnuPowerSummary(huaweiReport);
  assert.deepEqual(signal, { onuTxDbm: '2.29', onuRxDbm: '-21.48', oltRxDbm: '-26.58', status: 'Regular' });
  assert.equal(parseOnuPowerSummary(huaweiReport.replace('Rx olt: -26.58', '')).oltRxDbm, '-26.58');
  assert.equal(parseOnuPowerSummary(huaweiReport.replace('Rx olt: -26.58', 'Rx olt: -25.00')).oltRxDbm, '-25.00');
  const html = huaweiReport.replaceAll('\n', '<br />').replaceAll('.', ',');
  assert.deepEqual(parseOnuPowerSummary(html), signal);
  const partial = parseOnuPowerSummary('Sinal Rx: -21.48\nSinal Tx: -26.58');
  assert.equal(partial.onuTxDbm, '');
  assert.equal(partial.oltRxDbm, '-26.58');
});

test('Huawei usa a mesma leitura no relatorio de clientes e no final do provisionamento', async () => {
  const client = Object.create(IxcClient.prototype);
  client.actionPost = async () => huaweiReport;
  const reports = await client.getFiberPowerReports([{ id: '1', nome: 'Cliente teste' }]);
  assert.match(formatSignalReportEntry(reports[0]), /RX na OLT: -26.58 dBm/);
  const messages = [];
  const signal = await sendProvisionSignal({ reply: async (message) => messages.push(message) }, client, { id: '1' });
  assert.match(messages[0], /TX da ONU: 2.29 dBm/);
  assert.match(messages[0], /RX na ONU: -21.48 dBm/);
  assert.match(messages[0], /RX na OLT: -26.58 dBm/);
  assert.match(buildProvisionOsMessage({ signal }), /recebido na OLT \(RX\): -26.58 dBm/);
});

test('botao pos-provisionamento aguarda cinco segundos antes de consultar a ONU', async () => {
  const events = [];
  const ctx = { reply: async () => events.push('reply') };
  const ixc = {
    getOnuPowerSummary: async (id) => {
      events.push(`signal:${id}`);
      return { onuRxDbm: '-20.00' };
    },
  };

  await sendDelayedProvisionSignal(ctx, ixc, { id: '50760' }, async (milliseconds) => {
    events.push(`wait:${milliseconds}`);
  });

  assert.equal(POST_PROVISION_SIGNAL_DELAY_MS, 5000);
  assert.deepEqual(events, ['wait:5000', 'signal:50760', 'reply']);
  const button = provisionedSignalKeyboard().reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, 'Conferir sinal');
  assert.equal(button.callback_data, 'provisioned:signal');
});

test('botoes azuis copiam PPPoE e senha sem digitacao manual', () => {
  const keyboard = credentialsCopyKeyboard('06759385624', '123456');
  const [loginButton, passwordButton] = keyboard.reply_markup.inline_keyboard.flat();

  assert.deepEqual(loginButton, {
    text: 'Copiar PPPoE',
    style: 'primary',
    copy_text: { text: '06759385624' },
  });
  assert.deepEqual(passwordButton, {
    text: 'Copiar senha',
    style: 'primary',
    copy_text: { text: '123456' },
  });
});

test('iniciar e navegar pelos menus preserva o historico de mensagens', async () => {
  const commands = new Map();
  const actions = [];
  let start;
  const bot = {
    use() {},
    start(handler) { start = handler; },
    command(name, handler) { commands.set(name, handler); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on() {},
  };
  registerFlow(bot, {}, { allowedTelegramIds: [] });
  let deletions = 0;
  const ctx = {
    chat: { id: 'history-regression' },
    message: { message_id: 100 },
    reply: async () => {},
    answerCbQuery: async () => {},
    telegram: {
      deleteMessages: async () => { deletions += 1; },
      deleteMessage: async () => { deletions += 1; },
    },
  };
  await start(ctx);
  await commands.get('provisionar')(ctx);
  await commands.get('sinal')(ctx);
  for (const data of ['provision:start', 'signal:start', 'signal:again', 'signal:menu', 'signal:back']) {
    ctx.callbackQuery = { data, message: { message_id: 100 } };
    await actions.find(({ pattern }) => pattern.test(data)).handler(ctx);
  }
  assert.equal(deletions, 0);
});

test('callback antigo do Telegram nao interrompe o fluxo', async () => {
  const expiredError = Object.assign(new Error('400: Bad Request: query is too old and response timeout expired'), {
    code: 400,
    description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
  });
  const result = await answerCallbackQuerySafely(async () => { throw expiredError; }, 'Confirmado');
  assert.equal(result, undefined);

  await assert.rejects(
    answerCallbackQuerySafely(async () => { throw Object.assign(new Error('Forbidden'), { code: 403 }); }),
    /Forbidden/
  );
});

test('numero digitado escolhe o contrato sem voltar ao inicio', () => {
  const contracts = [{ id: '53848' }, { id: '40599' }, { id: '31955' }];
  const state = { step: 'contract_choose', matches: contracts, menuToken: 'abc123' };
  assert.equal(selectContractByNumber(state, '1'), contracts[0]);
  assert.equal(state.contract.id, '53848');
  assert.equal(state.step, 'login_lookup');
  assert.deepEqual(state.matches, []);
  assert.equal(state.menuToken, null);
});

test('numero de contrato invalido mantem o menu atual', () => {
  const contracts = [{ id: '53848' }, { id: '40599' }];
  for (const input of ['0', '3', '53848', 'abc']) {
    const state = { step: 'contract_choose', matches: contracts, menuToken: 'abc123' };
    assert.equal(selectContractByNumber(state, input), null);
    assert.equal(state.step, 'contract_choose');
    assert.deepEqual(state.matches, contracts);
  }
});

const profiles = [
  { id: '87', nome: '(TESTE) ONU-BRIDGE-OLT01.PMS', fabricante_modelo: '' },
  { id: '86', nome: '(TESTE) ONU-INTEGRADA-OLT01.PMS', fabricante_modelo: '' },
  { id: '90', nome: '(TESTE) ONU-BRIDGE-OLT02.PMS', fabricante_modelo: '' },
  { id: '84', nome: '(TESTE) ONU-INTEGRADA-OLT02.PMS', fabricante_modelo: '' },
  { id: '20', nome: '(TESTE) ONU-BRIDGE-OLT HUAWEI', fabricante_modelo: '' },
  { id: '94', nome: '(TESTE) ONU-INTEGRADA-OLT HUAWEI', fabricante_modelo: '' },
  { id: '88', nome: '(TESTE) ONU-INTEGRADA-PTC', fabricante_modelo: '' },
  { id: '89', nome: '(TESTE) ONU-BRIDGE-PTC', fabricante_modelo: '' },
  { id: '91', nome: '(TESTE) ONU-INTEGRADA-CRZ', fabricante_modelo: '' },
  { id: '92', nome: '(TESTE) ONU-BRIDGE-BRJ', fabricante_modelo: '' },
  { id: '93', nome: '(TESTE) ONU-INTEGRADA-BRJ', fabricante_modelo: '' },
  { id: '96', nome: '(TESTE) ONU-INTEGRADA-SGA', fabricante_modelo: '' },
  { id: '97', nome: '(TESTE) ONU-BRIDGE-SGA', fabricante_modelo: '' },
  { id: '78', nome: 'H. INTEGRADA C/ VOIP --> APENAS OLT HUAWEI', fabricante_modelo: 'HW' },
  { id: '80', nome: 'INTEGRADA -> 04.pms OLT HUAWEI', fabricante_modelo: 'HW' },
  { id: '62', nome: 'FIBERHOME BRIDGE (inet)', fabricante_modelo: 'FBT' },
];

test('OLT 01 PMS mostra somente bridge e integrada da OLT 01', () => {
  const selected = selectProfilesForOlt(profiles, { descricao: 'OLT 01.pms' });
  assert.deepEqual(selected.map((profile) => profile.id), ['87', '86']);
});

test('OLT 02 PMS mostra somente bridge e integrada da OLT 02', () => {
  const selected = selectProfilesForOlt(profiles, { descricao: 'OLT - PMS - 02' });
  assert.deepEqual(selected.map((profile) => profile.id), ['90', '84']);
});

test('OLT Huawei mostra somente bridge e integrada exclusivos', () => {
  const selected = selectProfilesForOlt(profiles, { descricao: 'LT01 Lagoa Formosa (Huawei)' });
  assert.deepEqual(selected.map((profile) => profile.id), ['20', '94']);
});

test('modelo Huawei da ONU nao transforma uma OLT FiberHome em Huawei', () => {
  const selected = selectProfilesForOlt(
    profiles,
    { descricao: 'OLT FiberHome', fabricante_modelo: 'FBT' },
    { modelo: 'HWTC-EG8145V5' }
  );
  assert.deepEqual(selected.map((profile) => profile.id), ['62']);
});

test('fabricante Huawei por extenso tambem restringe o menu', () => {
  const selected = selectProfilesForOlt(profiles, { fabricante_modelo: 'HUAWEI' });
  assert.deepEqual(selected.map((profile) => profile.id), ['20', '94']);
});

test('OLTs com perfil de localidade usam somente os scripts TESTE correspondentes', () => {
  assert.deepEqual(
    selectProfilesForOlt(profiles, { descricao: 'LT01 Paracatu (Huawei)' }).map((profile) => profile.id),
    ['88', '89']
  );
  assert.deepEqual(
    selectProfilesForOlt(profiles, { descricao: 'OLT BRJ' }).map((profile) => profile.id),
    ['92', '93']
  );
  assert.deepEqual(
    selectProfilesForOlt(profiles, { descricao: 'Sao Goncalo do Abaete' }).map((profile) => profile.id),
    ['96', '97']
  );
  assert.deepEqual(
    selectProfilesForOlt(profiles, { descricao: 'OLT CRZ' }).map((profile) => profile.id),
    ['91']
  );
});

test('calcula VLAN e proximo numero livre usando a mesma OLT, slot e PON', () => {
  const rows = [
    { id_transmissor: '7', slotno: '17', ponno: '10', onu_numero: '3', vlan: '3017' },
    { id_transmissor: '7', slotno: '17', ponno: '10', onu_numero: '2', vlan: '3017' },
    { id_transmissor: '7', slotno: '17', ponno: '10', onu_numero: '1', vlan: '3017' },
    { id_transmissor: '1', slotno: '17', ponno: '10', onu_numero: '4', vlan: '1017' },
  ];
  const result = deriveProvisionNetworkFields(rows, {
    id_transmissor: '7',
    slotno: '17',
    ponno: '10',
  });
  assert.equal(result.vlan, '3017');
  assert.equal(result.onu_numero, '4');
});

test('nao aceita provisionamento sem uma VLAN conhecida para a interface', () => {
  assert.throws(
    () =>
      deriveProvisionNetworkFields([], {
        id_transmissor: '7',
        slotno: '17',
        ponno: '10',
      }),
    /Nao encontrei uma VLAN comprovada/
  );
});

test('Patrocinio usa VLAN comprovada em outras PONs do mesmo slot quando a PON esta vazia', () => {
  const rows = [
    { id_transmissor: '1', slotno: '15', ponno: '1', onu_numero: '1', vlan: '1015' },
    { id_transmissor: '1', slotno: '15', ponno: '3', onu_numero: '2', vlan: '1015' },
    { id_transmissor: '1', slotno: '15', ponno: '6', onu_numero: '3', vlan: '1020' },
  ];
  const result = deriveProvisionNetworkFields(rows, {
    id_transmissor: '1', slotno: '15', ponno: '4',
  });
  assert.equal(result.vlan, '1015');
  assert.equal(result.onu_numero, '1');
  assert.equal(result.vlan_pppoe, '');
});

test('nao infere VLAN sem confirmacao em PONs diferentes do slot', () => {
  const rows = [
    { id_transmissor: '1', slotno: '15', ponno: '1', vlan: '1015' },
    { id_transmissor: '1', slotno: '15', ponno: '2', vlan: '1020' },
  ];
  assert.throws(
    () => deriveProvisionNetworkFields(rows, { id_transmissor: '1', slotno: '15', ponno: '4' }),
    /Nao encontrei uma VLAN comprovada/
  );
});

test('mensagem da OS leva caixa, porta e serial escolhidos no bot', () => {
  const message = buildProvisionOsMessage({
    box: 'PMS-01',
    port: '8',
    serial: 'ABC1234',
    signal: { onuRxDbm: '-17.72', onuTxDbm: '1.89', oltRxDbm: '-19.91', status: 'Regular' },
  });
  assert.match(message, /Caixa: PMS-01/);
  assert.match(message, /Porta: 8/);
  assert.match(message, /ONU: ABC1234/);
  assert.match(message, /Sinal da ONU recebido na OLT \(RX\): -19.91 dBm/);
  assert.match(message, /ONU RX -17.72 dBm \| ONU TX 1.89 dBm \| Status Regular/);
});

test('menu de troca separa ONU de roteador e exige confirmacao do roteador', () => {
  const equipmentLabels = swapEquipmentKeyboard().reply_markup.inline_keyboard
    .flat()
    .map((button) => [button.text, button.callback_data]);
  const confirmationLabels = routerReplacementKeyboard().reply_markup.inline_keyboard
    .flat()
    .map((button) => [button.text, button.callback_data]);

  assert.deepEqual(equipmentLabels, [
    ['Trocar ONU', 'swapequipment:onu'],
    ['Trocar roteador', 'swapequipment:router'],
    ['Cancelar', 'confirm:no'],
  ]);
  assert.deepEqual(confirmationLabels, [
    ['Confirmar troca do roteador', 'routerreplace:confirm'],
    ['Cancelar', 'confirm:no'],
  ]);
});

test('mensagem da OS de roteador informa troca e limpeza do MAC', () => {
  const message = buildRouterReplacementOsMessage();
  assert.match(message, /Troca de roteador realizada/);
  assert.match(message, /MAC do login PPPoE limpo no IXC/);
  assert.doesNotMatch(message, /ONU|Caixa|Porta/);
});

test('menus dinamicos incluem token e permitem identificar callbacks antigos', () => {
  const token = 'abcdef123456';
  const rows = rowsKeyboard('contract', [{ id: '10' }], (row) => row.id, token);
  const ports = portsKeyboard([1, 2], token);

  assert.equal(rows.reply_markup.inline_keyboard[0][0].callback_data, `contract:${token}:0`);
  assert.equal(ports.reply_markup.inline_keyboard[0][1].callback_data, `port:${token}:2`);
  assert.deepEqual(parseMenuCallback(`contract:${token}:0`, 'contract'), { token, value: 0 });
  assert.equal(parseMenuCallback('contract:0', 'contract'), null);
  assert.equal(
    currentMenuCallbackValue(
      { step: 'contract_choose', menuToken: '999999999999' },
      'contract',
      'contract_choose',
      `contract:${token}:0`
    ),
    null
  );
  assert.equal(
    currentMenuCallbackValue(
      { step: 'contract_choose', menuToken: token },
      'contract',
      'contract_choose',
      `contract:${token}:0`
    ),
    0
  );
});

test('extrai RX e TX do HTML retornado por Potencia Resumo ONU', () => {
  const result = parseOnuPowerSummary(
    '<div>SEND POWER : 1.89 (Dbm)</div><div>RECV POWER : -17.72 (Dbm)</div>' +
      '<div>OLT RECV POWER : -19.91 (Dbm)</div><div>Status pot&#xEA;ncia: Regular</div>'
  );

  assert.deepEqual(result, {
    onuTxDbm: '1.89',
    onuRxDbm: '-17.72',
    oltRxDbm: '-19.91',
    status: 'Regular',
  });
});

test('fechamento da OS marca finalizar atendimento no payload nativo', async () => {
  const client = Object.create(IxcClient.prototype);
  client.os = {
    enabled: true,
    subjectId: '7',
    sectorId: '3',
    processId: '71',
    taskId: '677',
    responseId: '5',
    diagnosisId: '507',
    technicianId: '367',
  };

  let closeCall;
  client.create = async (resource, payload) => {
    if (resource === 'su_ticket') return { id: '100' };
    closeCall = { resource, payload };
    return { type: 'success' };
  };
  client.read = async () => ({
    id: '100',
    id_wfl_processo: '71',
    id_responsavel_tecnico: '367',
  });
  client.waitForTicketOs = async () => ({ id: '200', id_wfl_tarefa: '677', id_tecnico: '367' });
  client.getOnuPowerSummary = async () => ({
    onuTxDbm: '1.50',
    onuRxDbm: '-18.00',
    oltRxDbm: '-20.00',
    status: 'Regular',
  });

  const result = await client.createAndCloseProvisioningOs({
    client: { id: '10', id_filial: '1' },
    contract: { id: '20', id_filial: '1' },
    login: { id: '30' },
    fiberId: '40',
    box: 'CX-01',
    port: '4',
    serial: 'SERIAL1',
    address: 'Rua Teste, 1',
  });

  assert.equal(result.ticket.id, '100');
  assert.equal(result.serviceOrder.id, '200');
  assert.equal(closeCall.resource, 'su_oss_chamado_fechar');
  assert.equal(closeCall.payload.id_chamado, '200');
  assert.equal(closeCall.payload.id_resposta, '5');
  assert.equal(closeCall.payload.id_su_diagnostico, '507');
  assert.equal(closeCall.payload.finaliza_processo, 'S');
  assert.equal(closeCall.payload.status, 'F');
  assert.match(closeCall.payload.mensagem, /ONU RX -18.00 dBm/);
});

test('OS e aberta mesmo quando a leitura de potencia fica indisponivel', async () => {
  const client = Object.create(IxcClient.prototype);
  client.os = {
    enabled: true,
    subjectId: '7',
    sectorId: '3',
    processId: '71',
    taskId: '677',
    responseId: '5',
    diagnosisId: '507',
    technicianId: '367',
  };

  let signalReads = 0;
  let createdMessage = '';
  client.getOnuPowerSummary = async () => { signalReads += 1; };
  client.createAndCloseServiceOs = async ({ message }) => {
    createdMessage = message;
    return { ticket: { id: '100' }, serviceOrder: { id: '200' } };
  };

  const result = await client.createAndCloseProvisioningOs({
    client: { id: '10' },
    contract: { id: '20' },
    login: { id: '30' },
    fiberId: '40',
    box: 'CX-01',
    port: '4',
    serial: 'SERIAL1',
    signal: null,
  });

  assert.equal(result.serviceOrder.id, '200');
  assert.equal(signalReads, 0);
  assert.match(createdMessage, /Sinal da ONU recebido na OLT \(RX\): Nao informado/);
  assert.match(createdMessage, /Sinal Optico no Cliente: Nao informado/);
});

test('consulta de leitura do IXC repete uma vez em erro transitorio', async () => {
  const client = Object.create(IxcClient.prototype);
  let attempts = 0;
  client.http = {
    get: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return { data: { registros: [{ id: '10' }] } };
    },
  };

  const rows = await client.list('cliente');
  assert.deepEqual(rows, [{ id: '10' }]);
  assert.equal(attempts, 2);
});

test('troca de roteador abre e finaliza OS especifica sem consultar ONU', async () => {
  const client = Object.create(IxcClient.prototype);
  client.os = {
    enabled: true,
    subjectId: '7',
    sectorId: '3',
    processId: '71',
    taskId: '677',
    responseId: '5',
    diagnosisId: '507',
    technicianId: '367',
  };
  const calls = [];
  client.create = async (resource, payload) => {
    calls.push({ resource, payload });
    return resource === 'su_ticket' ? { id: '100' } : { type: 'success' };
  };
  client.read = async () => ({
    id: '100',
    id_wfl_processo: '71',
    id_responsavel_tecnico: '367',
  });
  client.waitForTicketOs = async () => ({ id: '201', id_wfl_tarefa: '677', id_tecnico: '367' });
  client.getOnuPowerSummary = async () => {
    throw new Error('Nao deveria consultar ONU');
  };

  const result = await client.createAndCloseRouterReplacementOs({
    client: { id: '10', id_filial: '1' },
    contract: { id: '20', id_filial: '1' },
    login: { id: '30' },
    address: 'Rua Teste, 1',
  });

  assert.equal(result.serviceOrder.id, '201');
  assert.equal(calls[0].resource, 'su_ticket');
  assert.equal(calls[0].payload.titulo, 'Troca de roteador');
  assert.match(calls[0].payload.menssagem, /Troca de roteador realizada/);
  assert.equal(calls[1].resource, 'su_oss_chamado_fechar');
  assert.match(calls[1].payload.mensagem, /MAC do login PPPoE limpo/);
});

test('troca de roteador limpa somente o MAC e abre a OS apos confirmacao', async () => {
  const calls = [];
  const replies = [];
  const ctx = {
    chat: { id: 'router-test' },
    reply: async (message) => replies.push(message),
  };
  const state = {
    step: 'router_replace_confirm',
    serviceType: 'troca',
    swapEquipment: 'router',
    routerMacCleared: false,
    client: { id: '10', razao: 'CLIENTE TESTE', id_filial: '1' },
    contract: { id: '20', id_filial: '1', endereco: 'Rua Teste', numero: '1' },
    login: { id: '30', login: '12345678901' },
  };
  const ixc = {
    clearLoginMac: async (id) => {
      calls.push(['clearLoginMac', id]);
      return { type: 'success' };
    },
    createAndCloseRouterReplacementOs: async (payload) => {
      calls.push(['createOs', payload.login.id]);
      return { serviceOrder: { id: '201' } };
    },
  };

  const completed = await completeRouterReplacement(ctx, state, ixc, { dryRun: false });

  assert.equal(completed, true);
  assert.deepEqual(calls, [
    ['clearLoginMac', '30'],
    ['createOs', '30'],
  ]);
  assert.match(replies.at(-1), /OS 201 aberta e finalizada/);
});

test('mudanca de endereco limpa o MAC do login uma unica vez', async () => {
  const calls = [];
  const state = {
    serviceType: 'mudanca',
    login: { id: '71825' },
    loginMacCleared: false,
    macCleanupWarning: null,
  };
  const ixc = {
    clearLoginMac: async (id) => {
      calls.push(id);
      return { type: 'success' };
    },
  };

  await clearLoginMacWithWarning({}, state, ixc);
  await clearLoginMacWithWarning({}, state, ixc);

  assert.deepEqual(calls, ['71825']);
  assert.equal(state.loginMacCleared, true);
  assert.equal(state.macCleanupWarning, null);
});

test('consulta Potencia Resumo ONU pelo endpoint oficial e ID da fibra', async () => {
  const client = Object.create(IxcClient.prototype);
  let request;
  client.actionPost = async (resource, payload) => {
    request = { resource, payload };
    return '<div>SEND POWER : 2.00 (Dbm)</div><div>RECV POWER : -16.50 (Dbm)</div>';
  };

  const signal = await client.getOnuPowerSummary('50726', { attempts: 1 });

  assert.deepEqual(request, { resource: 'botao_rel_22991', payload: { id: '50726' } });
  assert.equal(signal.onuRxDbm, '-16.50');
  assert.equal(signal.onuTxDbm, '2.00');
});

test('consulta de sinal do cliente encontra fibras por login e contrato sem duplicar', async () => {
  const client = Object.create(IxcClient.prototype);
  client.findPppoeLoginsByClient = async () => [{ id: '10' }, { id: '11' }];
  client.findContractsByClient = async () => [{ id: '20' }];
  client.findFiberClientsByLogin = async (id) =>
    id === '10' ? [{ id: '100' }] : [{ id: '101' }];
  client.findFiberClientsByContract = async () => [{ id: '100' }, { id: '102' }];

  const fibers = await client.findFiberClientsByClient('1');

  assert.deepEqual(fibers.map((fiber) => fiber.id), ['100', '101', '102']);
});

test('consulta de sinal do contrato encontra ONU pelo contrato ou login', async () => {
  const client = Object.create(IxcClient.prototype);
  client.findFiberClientsByContract = async () => [{ id: '100' }];
  client.findPppoeLoginsByContract = async () => [{ id: '10' }];
  client.findFiberClientsByLogin = async () => [{ id: '100' }, { id: '101' }];

  const fibers = await client.findFiberClientsForContract('20');

  assert.deepEqual(fibers.map((fiber) => fiber.id), ['100', '101']);
});

test('relatorio da caixa prioriza nome do cliente e usa login como contingencia', async () => {
  const client = Object.create(IxcClient.prototype);
  client.read = async (resource, id) => {
    if (resource !== 'radusuarios') return null;
    if (id === '10') return { id: '10', id_cliente: '20', login: 'login-cliente' };
    return { id: '11', id_cliente: '21', login: 'login-sem-nome' };
  };
  client.findClient = async (id) =>
    id === '20' ? { id: '20', razao: 'CLIENTE COM NOME' } : { id: '21', razao: '' };

  const fibers = await client.enrichFiberClientNames([
    { id: '1', id_login: '10', nome: 'nome antigo' },
    { id: '2', id_login: '11', nome: 'outro nome antigo' },
  ]);

  assert.equal(fibers[0].nome, 'CLIENTE COM NOME');
  assert.equal(fibers[1].nome, 'login-sem-nome');
});

test('cadastros de fibra recebem o nome da caixa sem expor o ID na formatacao', async () => {
  const client = Object.create(IxcClient.prototype);
  client.read = async (resource, id) => {
    assert.equal(resource, 'rad_caixa_ftth');
    return id === '50' ? { id: '50', descricao: 'PMS - CAIXA CENTRAL' } : null;
  };

  const [fiber] = await client.enrichFiberBoxNames([
    { id: '1', id_caixa_ftth: '50', porta_ftth: '3' },
  ]);

  assert.equal(fiber.caixa_nome, 'PMS - CAIXA CENTRAL');
});

test('mensagens de ONU cadastrada e titularidade mostram nome da caixa, nunca o ID', () => {
  const fiber = {
    id: '1',
    mac: 'ONU123',
    id_caixa_ftth: '50',
    caixa_nome: 'PMS - CAIXA CENTRAL',
    porta_ftth: '3',
  };
  const authorized = formatAuthorizedOnu(fiber);
  const titularity = buildTitularitySuccessMessage(
    { oldFiber: fiber, client: {}, contract: {}, login: {}, profile: {} },
    fiber
  );

  assert.match(authorized, /Caixa\/porta: PMS - CAIXA CENTRAL\/3/);
  assert.match(titularity, /Caixa\/porta: PMS - CAIXA CENTRAL\/3/);
  assert.doesNotMatch(authorized, /Caixa\/porta: 50/);
  assert.doesNotMatch(titularity, /Caixa\/porta: 50/);
});

test('menu de caixas mostra distancia e descricao sem expor ID', () => {
  const label = formatNearbyBoxLabel({
    id: '51507',
    distanceMeters: 42,
    descricao: 'PMS - ESTOQUE - CAIXA UAI',
  });

  assert.equal(label, '42m - PMS - ESTOQUE - CAIXA UAI');
  assert.doesNotMatch(label, /51507/);
});

test('busca por localizacao mostra somente caixas VRJ do projeto Importacao', async () => {
  const client = Object.create(IxcClient.prototype);
  client.listAllBoxes = async () => [
    {
      id: '1',
      descricao: 'VRJ - 01-068',
      id_transmissor: '1056',
      id_projeto: '1',
      status: 'A',
      latitude: '-18.3775247',
      longitude: '-46.0320954',
    },
    {
      id: '2',
      descricao: 'VRJ - 01 - 068 - PL 01 - PON 00',
      id_projeto: '35',
      status: 'A',
      latitude: '-18.3775247',
      longitude: '-46.0320954',
    },
    {
      id: '3',
      descricao: 'OUTRA - CAIXA INATIVA',
      status: 'I',
      latitude: '-18.3775247',
      longitude: '-46.0320954',
    },
  ];

  const boxes = await client.findBoxesNearLocation(
    { latitude: -18.3775, longitude: -46.0321 },
    { radiusMeters: 300, limit: 10 }
  );

  assert.deepEqual(boxes.map((box) => box.id), ['1']);
});

test('qualquer caixa de provisionamento deve pertencer ao Projeto importacao', async () => {
  const client = Object.create(IxcClient.prototype);
  client.listAllBoxes = async () => [
    { id: '1', descricao: 'PMS - IMPORTACAO', id_projeto: '1', status: 'A', latitude: '-18.58', longitude: '-46.51' },
    { id: '2', descricao: 'PMS - OUTRO PROJETO', id_projeto: '22', status: 'A', latitude: '-18.58', longitude: '-46.51' },
    { id: '3', descricao: 'PMS - IMPORTACAO INATIVA', id_projeto: '1', status: 'I', latitude: '-18.58', longitude: '-46.51' },
  ];

  const boxes = await client.findBoxesNearLocation(
    { latitude: -18.58, longitude: -46.51 },
    { radiusMeters: 300, limit: 10 }
  );

  assert.deepEqual(boxes.map((box) => box.id), ['1']);
  assert.equal(isImportProjectBox(boxes[0]), true);
});

test('busca digitada tambem exclui caixas de outros projetos', async () => {
  const client = Object.create(IxcClient.prototype);
  client.list = async () => [
    { id: '1', descricao: 'PMS - IMPORTACAO', id_projeto: '1', id_transmissor: '2', status: 'A' },
    { id: '2', descricao: 'PMS - OUTRO PROJETO', id_projeto: '22', id_transmissor: '2', status: 'A' },
  ];

  const boxes = await client.findBoxes('PMS', '2');
  assert.deepEqual(boxes.map((box) => box.id), ['1']);
});

test('VRJ digitada encontra caixa sem GPS na OLT correta e filtra projeto antes da paginacao', async () => {
  const client = Object.create(IxcClient.prototype);
  let params;
  client.list = async (_table, input) => {
    params = input;
    return [
      { id: '1', descricao: 'VRJ - 01-01', id_projeto: '1', id_transmissor: '1056', status: 'A', latitude: '', longitude: '' },
      { id: '2', descricao: 'VRJ - 01-01', id_projeto: '35', id_transmissor: '1056', status: 'A' },
      { id: '3', descricao: 'VRJ - 01-01', id_projeto: '1', id_transmissor: '6', status: 'A' },
    ];
  };
  const rows = await client.findBoxes('VRJ - 01-01', '1056');
  assert.deepEqual(rows.map(row => row.id), ['1']);
  assert.equal(params.oper, 'L');
  assert.ok(JSON.parse(params.grid_param).some(filter => filter.TB === 'rad_caixa_ftth.id_projeto' && filter.P === '1'));
  client.listAllBoxes = async () => rows;
  assert.deepEqual(await client.findBoxesNearLocation({ latitude: 0, longitude: 0 }), []);
});

test('busca por localizacao de Paracatu mostra somente caixas PTU da OLT e projeto Importacao', async () => {
  const client = Object.create(IxcClient.prototype);
  client.listAllBoxes = async () => [
    {
      id: '10',
      descricao: 'PTU - 03-001',
      id_projeto: '1',
      id_transmissor: '5',
      status: 'A',
      latitude: '-17.2220',
      longitude: '-46.8740',
    },
    {
      id: '11',
      descricao: 'PTU - 03 - 001 - PL 01 - PON 00',
      id_projeto: '38',
      id_transmissor: '5',
      status: 'A',
      latitude: '-17.2220',
      longitude: '-46.8740',
    },
    {
      id: '12',
      descricao: 'PTC - 04-001',
      id_projeto: '1',
      id_transmissor: '5',
      status: 'A',
      latitude: '-17.2220',
      longitude: '-46.8740',
    },
    {
      id: '13',
      descricao: 'PTU - OUTRA OLT',
      id_projeto: '1',
      id_transmissor: '1',
      status: 'A',
      latitude: '-17.2220',
      longitude: '-46.8740',
    },
  ];

  const boxes = await client.findBoxesNearLocation(
    { latitude: -17.2220, longitude: -46.8740 },
    { radiusMeters: 300, limit: 10 }
  );

  assert.deepEqual(boxes.map((box) => box.id), ['10']);
});

test('Patrocinio mostra somente caixas PTC do projeto Importacao e OLT 1', async () => {
  const client = Object.create(IxcClient.prototype);
  client.listAllBoxes = async () => [
    { id: '1', descricao: 'PTC - 03-23 - PL 06 - PON 16', id_projeto: '1', id_transmissor: '1', status: 'A', latitude: '-18.94', longitude: '-46.99' },
    { id: '2', descricao: 'PTC - 03 - 023 - PL 06 - PON 16', id_projeto: '31', id_transmissor: '1', status: 'A', latitude: '-18.94', longitude: '-46.99' },
    { id: '3', descricao: 'PTC - OUTRA OLT', id_projeto: '1', id_transmissor: '5', status: 'A', latitude: '-18.94', longitude: '-46.99' },
    { id: '4', descricao: 'PTU - PARACATU', id_projeto: '1', id_transmissor: '5', status: 'A', latitude: '-17.22', longitude: '-46.87' },
  ];
  const boxes = await client.findBoxesNearLocation(
    { latitude: -18.94, longitude: -46.99 },
    { radiusMeters: 300, limit: 10 }
  );
  assert.deepEqual(boxes.map((box) => box.id), ['1']);
});

test('provisionamento grava explicitamente o projeto da caixa escolhida', () => {
  const payload = buildProvisionPayload({
    serviceType: 'instalacao',
    onu: { id: '1', mac: 'ABC123' },
    olt: { id: '2' },
    box: { id: '10', id_projeto: '1' },
    dropPort: '4',
    contract: { id: '20' },
    login: { id: '30' },
    client: { razao: 'Cliente teste' },
    profile: { id: '40' },
  });

  assert.equal(payload.clienteFibra.id_caixa_ftth, '10');
  assert.equal(payload.clienteFibra.id_projeto, '1');
});

test('provisionamento bloqueia caixa de outro projeto mesmo se chegar ao payload', () => {
  assert.throws(
    () => buildProvisionPayload({ box: { id: '10', id_projeto: '38' } }),
    /Projeto importacao/
  );
});

test('relatorio de sinal mantem ONU offline sem interromper as outras consultas', async () => {
  const client = Object.create(IxcClient.prototype);
  client.getOnuPowerSummary = async (id) => {
    if (id === '2') throw new Error('ONU Offline: onu is in unactive');
    return { onuRxDbm: '-18.20', onuTxDbm: '1.80', status: 'Regular' };
  };

  const reports = await client.getFiberPowerReports([
    { id: '1', nome: 'Cliente online' },
    { id: '2', nome: 'Cliente offline' },
  ]);

  assert.equal(reports[0].signal.onuRxDbm, '-18.20');
  assert.equal(reports[1].signal, null);
  assert.equal(reports[1].status, 'Offline');
});

test('mensagem de sinal mostra RX TX e estado offline de forma curta', () => {
  const online = formatSignalReportEntry({
    fiber: {
      id: '1',
      nome: 'Cliente A',
      id_caixa_ftth: '50',
      caixa_nome: 'PMS - CAIXA CENTRAL',
      porta_ftth: '3',
    },
    signal: {
      onuRxDbm: '-17.50',
      onuTxDbm: '2.10',
      oltRxDbm: '-19.40',
      status: 'Regular',
    },
  }, { showBox: true });
  const offline = formatSignalReportEntry({
    fiber: { id: '2', nome: 'Cliente B', porta_ftth: '4' },
    signal: null,
    status: 'Offline',
  });

  assert.match(online, /Caixa: PMS - CAIXA CENTRAL \| Porta 3/);
  assert.doesNotMatch(online, /Caixa:? 50/);
  assert.match(online, /RX na ONU: -17.50 dBm/);
  assert.match(online, /TX da ONU: 2.10 dBm/);
  assert.match(online, /RX na OLT: -19.40 dBm/);
  assert.doesNotMatch(online, /fibra 1/i);
  assert.match(offline, /Cliente B/);
  assert.match(offline, /Offline/);
});

test('resultado de sinal mostra somente nova consulta e menu', () => {
  const labels = signalResultKeyboard().reply_markup.inline_keyboard
    .flat()
    .map((button) => button.text);

  assert.deepEqual(labels, ['Verificar outro sinal', 'Menu']);
  assert.equal(labels.includes('Provisionar'), false);
});

test('provisionamento autoriza a ONU sem consultar o sinal automaticamente', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  client.prepareProvisionPayload = async () => ({
    pendingOnuId: '1056',
    clienteFibra: { mac: 'ABC123', id_login: '30', id_contrato: '20' },
  });
  client.ensureOnuAuthorizationApiAvailable = async () => calls.push(['preflight']);
  client.findFiberClientsByMac = async () => [];
  client.findFiberClientsByLogin = async () => [];
  client.create = async () => ({ id: '50760' });
  client.findProvisionedOnu = async () => ({ id: '50760', mac: 'ABC123' });
  client.authorizePendingOnu = async (id) => calls.push(['pending', id]);
  client.authorizeOnu = async (id) => calls.push(['olt', id]);
  client.getOnuPowerSummary = async () => calls.push(['unexpected-power-query']);
  client.read = async () => ({ id: '50760', mac: 'ABC123' });

  const result = await client.provisionOnu({});

  assert.deepEqual(calls, [
    ['preflight'],
    ['pending', '1056'],
    ['olt', '50760'],
  ]);
  assert.equal(result.authorized, true);
});

test('provisionamento remove cadastro de fibra duplicado silenciosamente e continua', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  let duplicateLookup = 0;
  client.prepareProvisionPayload = async () => ({
    pendingOnuId: '1056',
    clienteFibra: { mac: 'ABC123', id_login: '30', id_contrato: '20' },
  });
  client.ensureOnuAuthorizationApiAvailable = async () => {};
  client.findFiberClientsByMac = async () =>
    duplicateLookup++ === 0 ? [{ id: '45225', id_contrato: '46159' }] : [];
  client.findFiberClientsByLogin = async () => [];
  client.removeDuplicateFiberClient = async (id) => calls.push(['remove-old', id]);
  client.create = async () => {
    calls.push(['create-new']);
    return { id: '50760' };
  };
  client.findProvisionedOnu = async () => ({ id: '50760', mac: 'ABC123' });
  client.authorizePendingOnu = async () => {};
  client.authorizeOnu = async () => {};
  client.getOnuPowerSummary = async () => ({ onuRxDbm: '-20.00' });
  client.read = async () => ({ id: '50760', mac: 'ABC123' });

  const result = await client.provisionOnu({});

  assert.deepEqual(calls, [['remove-old', '45225'], ['create-new']]);
  assert.equal(result.authorized, true);
});

test('qualquer provisionamento remove cliente fibra antigo vinculado ao login', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  let loginLookup = 0;
  client.prepareProvisionPayload = async () => ({
    pendingOnuId: '1056',
    clienteFibra: { mac: 'NOVO123', id_login: '39661', id_contrato: '41830' },
  });
  client.ensureOnuAuthorizationApiAvailable = async () => {};
  client.findFiberClientsByMac = async () => [];
  client.findFiberClientsByLogin = async () =>
    loginLookup++ === 0
      ? [{ id: '21758', id_contrato: '0', id_login: '39661', mac: 'ANTIGO123' }]
      : [];
  client.removeDuplicateFiberClient = async (id) => calls.push(['remove-old-login', id]);
  client.create = async () => {
    calls.push(['create-new']);
    return { id: '50760' };
  };
  client.findProvisionedOnu = async () => ({ id: '50760', mac: 'NOVO123' });
  client.authorizePendingOnu = async () => {};
  client.authorizeOnu = async () => {};
  client.getOnuPowerSummary = async () => ({ onuRxDbm: '-20.00' });
  client.read = async () => ({ id: '50760', mac: 'NOVO123' });

  const result = await client.provisionOnu({});

  assert.deepEqual(calls, [['remove-old-login', '21758'], ['create-new']]);
  assert.equal(result.authorized, true);
});

test('preflight bloqueia cadastro parcial quando API de Autorizar ONU nao esta liberada', async () => {
  const client = Object.create(IxcClient.prototype);
  client.actionPost = async () => ({
    type: 'error',
    message: 'Recurso botao_gravar_dispositivo_22408 não está disponível!',
  });

  await assert.rejects(
    () => client.ensureOnuAuthorizationApiAvailable(),
    /botao_gravar_dispositivo_22408/
  );
});

test('Gravar dispositivo usa o endpoint 22408 e o ID do cliente fibra', async () => {
  const client = Object.create(IxcClient.prototype);
  let request;
  client.actionPost = async (resource, payload) => {
    request = { resource, payload };
    return 'Dispositivo gravado com sucesso.';
  };

  await client.authorizeOnu('50760');

  assert.deepEqual(request, {
    resource: 'botao_gravar_dispositivo_22408',
    payload: { id: '50760' },
  });
});

test('remocao desautoriza a ONU no dispositivo antes de excluir o cadastro de fibra', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  client.actionPost = async (resource, payload) => {
    calls.push(['post', resource, payload]);
    return 'Dispositivo excluido com sucesso.';
  };
  client.delete = async (resource, id) => {
    calls.push(['delete', resource, id]);
    return { type: 'success' };
  };

  await client.removeAuthorizedOnu('50749');

  assert.deepEqual(calls, [
    ['post', 'botao_excluir_dispositivo_22434', { id: '50749' }],
    ['delete', 'radpop_radio_cliente_fibra', '50749'],
  ]);
});

test('falha ao desautorizar preserva o cadastro de fibra antigo', async () => {
  const client = Object.create(IxcClient.prototype);
  let deleted = false;
  client.actionPost = async () =>
    '<div class="panel panel-danger">Desautorizacao de ONU: Registro nao encontrado!</div>';
  client.delete = async () => {
    deleted = true;
  };

  await assert.rejects(
    () => client.removeAuthorizedOnu('50749'),
    /desautorizar ONU no dispositivo/
  );
  assert.equal(deleted, false);
});

test('limpeza de duplicidade exclui cadastro orfao quando ONU ja nao existe na OLT', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  client.actionPost = async () =>
    '<div class="panel panel-danger">Desautorizacao de ONU: Registro nao encontrado!</div>';
  client.delete = async (resource, id) => {
    calls.push([resource, id]);
    return { type: 'success' };
  };

  await client.removeDuplicateFiberClient('45225');

  assert.deepEqual(calls, [['radpop_radio_cliente_fibra', '45225']]);
});

test('troca de titularidade preserva os campos existentes no PUT', async () => {
  const client = Object.create(IxcClient.prototype);
  let updateCall;
  client.read = async () => ({
    id: '50749',
    mac: '485754432D0E86B2',
    id_transmissor: '1056',
    id_caixa_ftth: '41255',
    porta_ftth: '6',
    vlan: '1001',
    id_contrato: '75637',
    id_login: '71726',
    nome: 'Cliente antigo',
  });
  client.update = async (resource, id, payload) => {
    updateCall = { resource, id, payload };
    return { type: 'success' };
  };

  await client.transferFiberClient('50749', {
    id_contrato: '80000',
    id_login: '90000',
    nome: 'Cliente novo',
    endereco_padrao_cliente: 'S',
    id_perfil: '30',
  });

  assert.equal(updateCall.resource, 'radpop_radio_cliente_fibra');
  assert.equal(updateCall.id, '50749');
  assert.equal(updateCall.payload.mac, '485754432D0E86B2');
  assert.equal(updateCall.payload.id_transmissor, '1056');
  assert.equal(updateCall.payload.id_caixa_ftth, '41255');
  assert.equal(updateCall.payload.porta_ftth, '6');
  assert.equal(updateCall.payload.vlan, '1001');
  assert.equal(updateCall.payload.id_contrato, '80000');
  assert.equal(updateCall.payload.id_login, '90000');
  assert.equal(updateCall.payload.id_perfil, '30');
});

test('consulta ONU existente pelo login novo antes da troca de titularidade', async () => {
  const client = Object.create(IxcClient.prototype);
  let request;
  client.list = async (resource, params) => {
    request = { resource, params };
    return [{ id: '60000', id_login: '90000' }];
  };

  const rows = await client.findFiberClientsByLogin('90000');

  assert.equal(rows[0].id, '60000');
  assert.equal(request.resource, 'radpop_radio_cliente_fibra');
  assert.equal(request.params.qtype, 'radpop_radio_cliente_fibra.id_login');
  assert.equal(request.params.query, '90000');
  assert.equal(request.params.oper, '=');
});

test('troca de titularidade reutiliza o perfil da ONU antiga', async () => {
  let readCall;
  const ixc = {
    read: async (resource, id) => {
      readCall = { resource, id };
      return { id: '30', nome: 'ONU integrada' };
    },
  };

  const profile = await findExistingTitularityProfile(ixc, { id_perfil: '30' });

  assert.deepEqual(readCall, {
    resource: 'radpop_radio_cliente_fibra_perfil',
    id: '30',
  });
  assert.equal(profile.id, '30');
});

test('troca de titularidade pede script quando a ONU antiga nao possui perfil', async () => {
  let queried = false;
  const ixc = {
    read: async () => {
      queried = true;
    },
  };

  const profile = await findExistingTitularityProfile(ixc, { id_perfil: '0' });

  assert.equal(profile, null);
  assert.equal(queried, false);
});

test('busca de ONU aceita fragmento de serial com no minimo quatro caracteres', () => {
  assert.equal(normalizeSerialFragment(' ea74 '), 'EA74');
  assert.equal(normalizeSerialFragment('a5b2'), 'A5B2');
  assert.equal(normalizeSerialFragment('abc'), null);
  assert.equal(normalizeSerialFragment('ab-12'), null);
});

test('PPPoE aceita CPF puro, letra ou numeros extras para contratos adicionais', () => {
  const client = { cnpj_cpf: '123.456.789-01' };
  for (const login of [
    '12345678901',
    'A12345678901',
    '12345678901F',
    '123456789011',
    '12' + '12345678901',
    'B1234567890102',
  ]) {
    assert.equal(
      validatePppoeCredentials(client, { login, senha: '123456' }).valid,
      true,
      login
    );
  }
});

test('PPPoE bloqueia nome no login e senha fora dos seis primeiros digitos', () => {
  const client = { cnpj_cpf: '123.456.789-01' };
  assert.equal(
    validatePppoeCredentials(client, { login: 'Edna123', senha: '123456' }).reason,
    'login'
  );
  assert.equal(
    validatePppoeCredentials(client, { login: '12345678901', senha: '654321' }).reason,
    'senha'
  );
});

test('mensagem final de ONU integrada orienta configurar VLAN e PPPoE na ONU', () => {
  const message = buildProvisionSuccessMessage(
    {
      profile: { nome: 'ONU-INTEGRADA-OLT02.PMS' },
      login: { login: '12345678901', senha: '123456' },
      box: { descricao: 'CX-01' },
      dropPort: '3',
      onu: { mac: 'ONU123' },
    },
    { mac: 'ONU123', vlan: '3017' }
  );

  assert.match(message, /Configure a ONU/);
  assert.match(message, /VLAN: 3017/);
  assert.match(message, /PPPoE: 12345678901/);
});

test('mensagem final de bridge orienta configurar somente PPPoE no roteador', () => {
  const message = buildProvisionSuccessMessage(
    {
      profile: { nome: 'ONU-BRIDGE-OLT02.PMS' },
      login: { login: '12345678901', senha: '123456' },
      box: { descricao: 'CX-01' },
      dropPort: '3',
      onu: { mac: 'ONU123' },
    },
    { mac: 'ONU123', vlan: '3017' }
  );

  assert.match(message, /Configure o roteador/);
  assert.match(message, /PPPoE: 12345678901/);
  assert.doesNotMatch(message, /VLAN:/);
});

test('menu do tecnico reduz scripts para bridge e integrada sem expor IDs', () => {
  const choices = selectTechnicianProfiles(
    [
      { id: '20', nome: 'ONU BRIDGE OLT 02' },
      { id: '26', nome: 'ONU INTEGRADA OLT 02' },
      { id: '78', nome: 'ONU INTEGRADA COM VOIP OLT 02' },
    ],
    '26'
  );

  assert.deepEqual(choices.map((profile) => profile.id), ['20', '26']);
});

test('troca sem ONU antiga continua pedindo localizacao para provisionar normalmente', async () => {
  const replies = [];
  const ctx = {
    reply: async (message, keyboard) => replies.push({ message, keyboard }),
  };
  const state = {
    serviceType: 'troca',
    contract: { id: '60744' },
    oldFiber: null,
  };
  const ixc = {
    findFiberClientsByContract: async () => [],
  };

  await handleSwapAfterContractChoice(ctx, state, ixc);

  assert.equal(state.swapWithoutOldFiber, true);
  assert.equal(state.step, 'box_location');
  assert.match(replies[0].message, /Envie sua localizacao/);
});

test('filtro de ONU pendente compara somente o serial', () => {
  const client = Object.create(IxcClient.prototype);
  const rows = [
    { mac: 'HWTCea74a5b2', modelo: 'HG260' },
    { mac: 'HWTC00000000', modelo: 'EA74' },
  ];

  const matches = client.filterPendingOnusBySerialSuffix(rows, 'ea74');

  assert.deepEqual(matches.map((onu) => onu.mac), ['HWTCea74a5b2']);
});

test('ONU autorizada usa consulta parcial pelo MAC', async () => {
  const client = Object.create(IxcClient.prototype);
  let request;
  client.list = async (resource, params) => {
    request = { resource, params };
    return [
      { id: '1', mac: 'HWTCea74a5b2' },
      { id: '2', mac: 'HWTCea74feb2' },
    ];
  };

  const rows = await client.findAuthorizedOnusBySerialSuffix('ea74');

  assert.deepEqual(rows.map((onu) => onu.mac), ['HWTCea74a5b2', 'HWTCea74feb2']);
  assert.equal(request.resource, 'radpop_radio_cliente_fibra');
  assert.equal(request.params.qtype, 'radpop_radio_cliente_fibra.mac');
  assert.equal(request.params.oper, 'L');
});

test('Consultar todas atualiza apenas OLTs ativas homologadas, nunca radios ou fila global antiga', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  client.list = async (resource, params = {}, options = {}) => {
    calls.push({ resource, params, options });
    if (resource === 'radpop_radio') return [
      { id: '7', ativo: 'S', fabricante_modelo: 'FH' },
      { id: '1056', ativo: 'S', fabricante_modelo: 'HW' },
      { id: '9', ativo: 'N', fabricante_modelo: 'HW' },
      { id: '10', ativo: 'S', fabricante_modelo: 'MIKROTIK' },
    ];
    const id = JSON.parse(params.grid_param)[0].P;
    return [{ id: `onu-${id}`, mac: `SERIAL-${id}` }];
  };

  const rows = await client.listPendingOnus({ refresh: true });

  assert.deepEqual(rows.map((row) => row.id), ['onu-7', 'onu-1056']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].resource, 'radpop_radio');
  assert.ok(calls.slice(1).every((call) => call.params.grid_param && call.options.strictResponse));
});

test('consulta critica de OLT respeita timeout curto sem repetir automaticamente', async () => {
  const client = Object.create(IxcClient.prototype);
  let calls = 0;
  client.http = {
    get: async (_path, options) => {
      calls += 1;
      assert.equal(options.timeout, 10000);
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    },
  };

  await assert.rejects(
    () => client.list('fh_onu_nao_autorizadas', {}, { timeoutMs: 10000, retryTransient: false }),
    /timeout/
  );
  assert.equal(calls, 1);
});

test('falha em todas as OLTs nao resulta em serial inexistente', async () => {
  const client = Object.create(IxcClient.prototype);
  client.pendingOltIds = ['6'];
  client.list = async () => {
    throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  };

  await assert.rejects(
    () => client.findPendingOnusBySerialSuffix('F438'),
    /Nao foi possivel confirmar esse serial/
  );
});

test('consulta usa lista configurada quando API nega descoberta e encontra F438 em resposta fresca', async () => {
  const client = Object.create(IxcClient.prototype);
  client.pendingOltIds = ['6', '7'];
  client.list = async (table, params) => {
    if (table === 'radpop_radio') throw new Error('Sem permissao');
    if (JSON.parse(params.grid_param)[0].P === '7') throw new Error('timeout');
    return [{ id: 'fresh', mac: 'HWTCeb1bf438', id_olt: '6' }];
  };
  assert.equal((await client.findPendingOnusBySerialSuffix('f438'))[0].id, 'fresh');
  await assert.rejects(() => client.findPendingOnusBySerialSuffix('FFFF'), /Nao foi possivel confirmar/);
});

test('consulta concorrente compartilha atualizacao mas consulta seguinte atualiza novamente', async () => {
  const client = Object.create(IxcClient.prototype);
  let releases;
  let count = 0;
  client.refreshPendingOnus = async () => { count++; return new Promise(resolve => { releases = resolve; }); };
  const first = client.listPendingOnus();
  const second = client.listPendingOnus();
  releases([]);
  await Promise.all([first, second]);
  assert.equal(count, 1);
  const third = client.listPendingOnus();
  releases([]);
  await third;
  assert.equal(count, 2);
});

test('atualizacao limita a tres consultas simultaneas e cobre todas as OLTs', async () => {
  const client = Object.create(IxcClient.prototype);
  client.pendingOltIds = ['1','2','3','4','5','6','7'];
  let active = 0, peak = 0, count = 0;
  client.list = async (table) => {
    if (table === 'radpop_radio') throw new Error('Sem permissao');
    active++; peak = Math.max(peak, active); count++;
    await new Promise(resolve => setImmediate(resolve));
    active--; return [];
  };
  const rows = await client.listPendingOnus();
  assert.equal(count, 7);
  assert.equal(peak, 3);
  assert.deepEqual(rows.failedOlts, []);
});

test('consulta estrita distingue erro HTTP 200 de fila vazia valida', async () => {
  const client = Object.create(IxcClient.prototype);
  client.http = { get: async () => ({ data: { type: 'error', message: 'Sem permissao' } }) };
  await assert.rejects(() => client.list('fh_onu_nao_autorizadas', {}, { strictResponse: true }), /Sem permissao/);
  client.http.get = async () => ({ data: '<html>login</html>' });
  await assert.rejects(() => client.list('fh_onu_nao_autorizadas', {}, { strictResponse: true }), /Resposta invalida/);
  client.http.get = async () => ({ data: { rows: [], total: 0 } });
  assert.deepEqual(await client.list('fh_onu_nao_autorizadas', {}, { strictResponse: true }), []);
  client.http.get = async () => ({ data: { page: 1, total: 0, type: 'error', message: 'Nenhuma onu disponivel' } });
  assert.deepEqual(await client.list('fh_onu_nao_autorizadas', {}, { strictResponse: true }), []);
  client.http.get = async () => ({ data: { total: 0, type: 'error', message: 'Sem permissao' } });
  await assert.rejects(() => client.list('fh_onu_nao_autorizadas', {}, { strictResponse: true }), /Sem permissao/);
});
