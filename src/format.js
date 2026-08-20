export const short = (value, fallback = '-') => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
};

export const serviceLabel = (value) =>
  ({
    instalacao: 'Instalacao',
    mudanca: 'Mudanca de endereco',
    troca: 'Troca de equipamento',
    titularidade: 'Troca de titularidade',
  })[value] ?? value;

export const contractAddress = (contract, client = null) => {
  const source =
    client && (!contract.endereco || contract.endereco_padrao_cliente === 'S')
      ? client
      : contract;

  const parts = [
    source.endereco,
    source.numero,
    source.bairro,
    source.cidade_nome || (source.cidade ? `cidade ${source.cidade}` : ''),
    source.cep ? `CEP ${source.cep}` : '',
    source.complemento,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Endereco nao informado no retorno';
};

export const formatOnu = (onu) =>
  [
    'ONU encontrada:',
    `Serial: ${short(onu.mac || onu.Chassi)}`,
    `OLT: ${short(onu.olt_nome || onu.descricao || onu.id_olt)}`,
    `PON: ${short(onu.slotno)}/${short(onu.ponno)}`,
    `Modelo: ${short(onu.modelo || onu.onu_tipo)}`,
  ].join('\n');

export const formatContract = (contract, client = null) =>
  [
    `Contrato ${short(contract.id)} | ${short(contract.status)}`,
    `Plano: ${short(contract.contrato)}`,
    `Endereco: ${contractAddress(contract, client)}`,
  ].join('\n');

export const formatLogin = (login) =>
  `${short(login.login)} (ID ${short(login.id)})`;

export const formatAuthorizedOnu = (onu) =>
  [
    'ONU ja cadastrada:',
    `Cadastro: ${short(onu.id)} | Serial: ${short(onu.mac)}`,
    `Caixa/porta: ${short(onu.id_caixa_ftth)}/${short(onu.porta_ftth)}`,
    `Contrato/login: ${short(onu.id_contrato)}/${short(onu.id_login)}`,
    `VLAN: ${short(onu.vlan || onu.vlan_pppoe)}`,
  ].join('\n');

export const buildSummary = (state) =>
  [
    'Confirmar dados:',
    `Servico: ${serviceLabel(state.serviceType)}`,
    `ONU: ${short(state.onu?.mac || state.onu?.Chassi)}`,
    `OLT: ${short(state.olt?.descricao || state.olt?.olt_nome || state.onu?.olt_nome || state.onu?.id_olt)}`,
    `Caixa/porta: ${short(state.box?.descricao)} / ${short(state.dropPort)}`,
    `Cliente: ${short(state.client?.razao)} | Contrato ${short(state.contract?.id)}`,
    `PPPoE: ${short(state.login?.login)}`,
    `Script: ${short(state.profile?.nome)}`,
  ].join('\n');

export const buildProvisionSuccessMessage = (state, provisionedOnu) =>
  [
    'Provisionado com sucesso.',
    '',
    `VLAN: ${short(provisionedOnu?.vlan || provisionedOnu?.vlan_pppoe || state.login?.vlan)}`,
    `PPPoE: ${short(state.login?.login)}`,
    `Senha: ${short(state.login?.senha)}`,
    '',
    `Caixa/porta: ${short(state.box?.descricao)} / ${short(state.dropPort)}`,
    `ONU: ${short(provisionedOnu?.mac || state.onu?.mac || state.onu?.Chassi)}`,
  ].join('\n');

export const buildTitularitySuccessMessage = (state, fiber) =>
  [
    'Titularidade transferida.',
    '',
    `VLAN: ${short(fiber?.vlan || fiber?.vlan_pppoe || state.login?.vlan)}`,
    `PPPoE: ${short(state.login?.login)}`,
    `Senha: ${short(state.login?.senha)}`,
    '',
    `Cliente: ${short(state.client?.razao)} | Contrato ${short(state.contract?.id)}`,
    `Caixa/porta: ${short(fiber?.id_caixa_ftth || state.oldFiber?.id_caixa_ftth)}/${short(fiber?.porta_ftth || state.oldFiber?.porta_ftth)}`,
    `ONU: ${short(fiber?.mac || state.oldFiber?.mac)}`,
  ].join('\n');
