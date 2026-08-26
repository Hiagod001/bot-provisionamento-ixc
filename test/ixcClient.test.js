import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IxcClient,
  buildProvisionOsMessage,
  deriveProvisionNetworkFields,
  selectProfilesForOlt,
} from '../src/ixcClient.js';

const profiles = [
  { id: '87', nome: '(TESTE) ONU-BRIDGE-OLT01.PMS', fabricante_modelo: '' },
  { id: '86', nome: '(TESTE) ONU-INTEGRADA-OLT01.PMS', fabricante_modelo: '' },
  { id: '85', nome: '(TESTE) ONU-BRIDGE-OLT02.PMS', fabricante_modelo: '' },
  { id: '84', nome: '(TESTE) ONU-INTEGRADA-OLT02.PMS', fabricante_modelo: '' },
  { id: '20', nome: 'H. BRIDGE -> APENAS OLT HUAWEI', fabricante_modelo: '' },
  { id: '26', nome: 'H. INTEGRADA -> APENAS OLT HUAWEI', fabricante_modelo: '' },
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
  assert.deepEqual(selected.map((profile) => profile.id), ['85', '84']);
});

test('OLT Huawei mostra somente bridge e integrada exclusivos', () => {
  const selected = selectProfilesForOlt(profiles, { descricao: 'LT01 Paracatu (Huawei)' });
  assert.deepEqual(selected.map((profile) => profile.id), ['20', '26']);
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
  assert.deepEqual(selected.map((profile) => profile.id), ['20', '26']);
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
    /Nao encontrei uma VLAN valida/
  );
});

test('mensagem da OS leva caixa, porta e serial escolhidos no bot', () => {
  const message = buildProvisionOsMessage({ box: 'PMS-01', port: '8', serial: 'ABC1234' });
  assert.match(message, /Caixa: PMS-01/);
  assert.match(message, /Porta: 8/);
  assert.match(message, /ONU: ABC1234/);
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

  const result = await client.createAndCloseProvisioningOs({
    client: { id: '10', id_filial: '1' },
    contract: { id: '20', id_filial: '1' },
    login: { id: '30' },
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
});

test('provisionamento executa o botao Autorizar ONU usando o ID do cliente fibra', async () => {
  const client = Object.create(IxcClient.prototype);
  const calls = [];
  client.prepareProvisionPayload = async () => ({
    pendingOnuId: '1056',
    clienteFibra: { mac: 'ABC123', id_login: '30', id_contrato: '20' },
  });
  client.ensureOnuAuthorizationApiAvailable = async () => calls.push(['preflight']);
  client.findFiberClientsByMac = async () => [];
  client.create = async () => ({ id: '50760' });
  client.findProvisionedOnu = async () => ({ id: '50760', mac: 'ABC123' });
  client.authorizePendingOnu = async (id) => calls.push(['pending', id]);
  client.authorizeOnu = async (id) => calls.push(['olt', id]);
  client.read = async () => ({ id: '50760', mac: 'ABC123' });

  const result = await client.provisionOnu({});

  assert.deepEqual(calls, [
    ['preflight'],
    ['pending', '1056'],
    ['olt', '50760'],
  ]);
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
