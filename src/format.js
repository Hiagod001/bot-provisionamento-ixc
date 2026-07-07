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
    'ONU encontrada aguardando autorizacao:',
    `Serial/MAC: ${short(onu.mac || onu.Chassi)}`,
    `Modelo: ${short(onu.modelo || onu.onu_tipo)}`,
    `OLT: ${short(onu.olt_nome || onu.descricao || onu.id_olt)}`,
    `Slot/PON: ${short(onu.slotno)}/${short(onu.ponno)}`,
  ].join('\n');

export const formatContract = (contract, client = null) =>
  [
    `Contrato ${short(contract.id)} - ${short(contract.contrato)}`,
    `Status: ${short(contract.status)} / Internet: ${short(contract.status_internet)}`,
    contractAddress(contract, client),
  ].join('\n');

export const formatLogin = (login) =>
  `Login ${short(login.id)} - ${short(login.login)} (${short(login.autenticacao)})`;

export const formatAuthorizedOnu = (onu) =>
  [
    'Cadastro antigo encontrado para esta ONU:',
    `ID cadastro fibra: ${short(onu.id)}`,
    `Serial/MAC: ${short(onu.mac)}`,
    `OLT antiga: ${short(onu.id_transmissor)}`,
    `Caixa antiga: ${short(onu.id_caixa_ftth)}`,
    `Porta antiga: ${short(onu.porta_ftth)}`,
    `Contrato antigo: ${short(onu.id_contrato)}`,
    `Login antigo: ${short(onu.id_login)}`,
    `VLAN antiga: ${short(onu.vlan || onu.vlan_pppoe)}`,
  ].join('\n');

export const buildSummary = (state) =>
  [
    'Resumo do provisionamento:',
    `Servico: ${serviceLabel(state.serviceType)}`,
    `ONU: ${short(state.onu?.mac || state.onu?.Chassi)} | OLT ${short(state.olt?.descricao || state.olt?.olt_nome || state.onu?.olt_nome || state.onu?.id_olt)}`,
    `Caixa: ${short(state.box?.descricao)} (ID ${short(state.box?.id)})`,
    `Porta drop: ${short(state.dropPort)}`,
    `Cliente: ${short(state.client?.razao)} (ID ${short(state.client?.id)})`,
    `Contrato: ${short(state.contract?.id)} - ${short(state.contract?.contrato)}`,
    `PPPoE: ${short(state.login?.login)} (ID ${short(state.login?.id)})`,
    `Script/perfil: ${short(state.profile?.nome)} (ID ${short(state.profile?.id)})`,
  ].join('\n');

export const buildProvisionSuccessMessage = (state, provisionedOnu) =>
  [
    'ONU provisionada no IXC com sucesso.',
    '',
    'Dados para configurar a ONT:',
    `VLAN: ${short(provisionedOnu?.vlan || provisionedOnu?.vlan_pppoe || state.login?.vlan)}`,
    `PPPoE: ${short(state.login?.login)}`,
    `Senha PPPoE: ${short(state.login?.senha)}`,
    '',
    `OLT: ${short(state.olt?.descricao || state.olt?.olt_nome || state.onu?.olt_nome || state.onu?.id_olt)}`,
    `Caixa: ${short(state.box?.descricao)} (ID ${short(state.box?.id)})`,
    `Porta: ${short(state.dropPort)}`,
    `ONU/MAC: ${short(provisionedOnu?.mac || state.onu?.mac || state.onu?.Chassi)}`,
  ].join('\n');

export const buildTitularitySuccessMessage = (state, fiber) =>
  [
    'Troca de titularidade concluida no IXC.',
    '',
    'Dados atuais do acesso:',
    `VLAN: ${short(fiber?.vlan || fiber?.vlan_pppoe || state.login?.vlan)}`,
    `PPPoE: ${short(state.login?.login)}`,
    `Senha PPPoE: ${short(state.login?.senha)}`,
    '',
    `Novo cliente: ${short(state.client?.razao)} (ID ${short(state.client?.id)})`,
    `Contrato: ${short(state.contract?.id)} - ${short(state.contract?.contrato)}`,
    `Caixa: ${short(fiber?.id_caixa_ftth || state.oldFiber?.id_caixa_ftth)}`,
    `Porta: ${short(fiber?.porta_ftth || state.oldFiber?.porta_ftth)}`,
    `ONU/MAC: ${short(fiber?.mac || state.oldFiber?.mac)}`,
  ].join('\n');
