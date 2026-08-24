import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProvisionNetworkFields, selectProfilesForOlt } from '../src/ixcClient.js';

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
