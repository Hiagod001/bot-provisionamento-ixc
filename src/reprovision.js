import { logger } from './logger.js';
import { resolveProvisionProfiles } from './provisionProfiles.js';
import { saveOltResponse } from './oltResponseAudit.js';
const busy = new Set();
export const REPROVISION_SETTLE_MS = 30000;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fields = ['id', 'id_login', 'id_contrato', 'mac', 'id_transmissor', 'id_perfil', 'id_caixa_ftth', 'porta_ftth', 'slotno', 'ponno', 'onu_numero', 'comandos', 'vlan', 'vlan_pppoe'];
const same = (a, b) => a && b && fields.every(k => String(a[k] ?? '') === String(b[k] ?? ''));

// O IXC retorna HTML de console para as acoes de OLT, nao apenas JSON.
// Um painel verde sem confirmacao de comando nao comprova a operacao.
export const classifyOltAction = response => {
  const raw = typeof response === 'string' ? response : String(response?.message || '');
  const text = raw.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (response?.type === 'error' || /panel-(?:heading-)?(?:danger|warning|error)/i.test(raw) ||
      /\b(error|erro|falha|failed|failure|invalid|timeout|incomplete|unknown command|not found)\b/i.test(text)) return 'ixc_rejected';
  if (response?.type === 'success' ||
    (/panel-(?:heading-)?success/i.test(raw) && /command execute success|executad[oa] com sucesso|successfully/i.test(text))) return 'confirmed';
  return response === undefined || response === null || response === '' ? 'empty_response' : 'unrecognized_response';
};
export const isConfirmedOltAction = response => classifyOltAction(response) === 'confirmed';

export async function runReprovisionOltAction(request, { fiberId, phase }, saveResponse = saveOltResponse) {
  let response, transportError;
  try { response = await request(); } catch (error) {
    transportError = error;
    response = error.ixcResponse ?? error.response?.data;
  }
  if (!transportError && isConfirmedOltAction(response)) return response;
  const classification = transportError && (response === undefined || classifyOltAction(response) === 'confirmed')
    ? 'transport_error' : classifyOltAction(response);
  const diagnostic = {
    fiberId, phase, classification, response,
    httpStatus: Number.isInteger(transportError?.response?.status) ? transportError.response.status : undefined,
    errorCode: /^[A-Z_]{1,40}$/.test(transportError?.code || '') ? transportError.code : undefined,
  };
  let reference;
  try { reference = await saveResponse(diagnostic); } catch {
    logger.error(JSON.stringify({ event: 'olt_response_capture_failed', fiberId, phase }));
  }
  logger.error(JSON.stringify({ event: 'olt_action_unconfirmed', fiberId, phase, classification, reference, httpStatus: diagnostic.httpStatus, errorCode: diagnostic.errorCode }));
  const action = phase === 'deauthorize' ? 'desprovisao' : 'regravacao';
  const detail = classification === 'transport_error' ? 'A consulta terminou sem resposta do IXC.'
    : classification === 'ixc_rejected' ? 'O IXC retornou uma indicacao de erro.'
    : 'O retorno recebido nao comprovou a conclusao da operacao.';
  throw Error(`IXC nao confirmou a ${action}. ${detail}${reference ? ` Referencia para o NOC: ${reference}.` : ''} Acione o NOC antes de repetir.`);
}

export async function reprovisionExisting(ixc, { client, contract, login, fiber, mode, profile, dryRun = false, onWaiting = async () => {} }, { wait = delay, saveResponse = saveOltResponse } = {}) {
  const key = String(fiber.id);
  if (busy.has(key)) throw Error('Este equipamento ja esta em processamento. Aguarde.');
  busy.add(key);
  let phase = 'validate';
  try {
    const [currentContract, currentLogin, current] = await Promise.all([
      ixc.read('cliente_contrato', contract.id), ixc.read('radusuarios', login.id), ixc.read('radpop_radio_cliente_fibra', fiber.id),
    ]);
    if (!same(current, fiber) || String(currentContract?.id_cliente) !== String(client.id) || !['A', 'P'].includes(currentContract?.status) ||
        String(currentLogin?.id_cliente) !== String(client.id) || String(currentLogin?.id_contrato) !== String(contract.id) ||
        String(current?.id_login) !== String(login.id) || String(current?.id_contrato) !== String(contract.id)) {
      throw Error('Cadastro ou vinculo alterado. Reinicie a consulta; nada foi desprovisionado.');
    }
    if (!current.mac || !(Number(current.id_transmissor) > 0)) {
      throw Error('Cadastro de fibra incompleto. Confirme serial, OLT e perfil com o NOC.');
    }
    const resolved = await resolveProvisionProfiles(ixc, { oltId: current.id_transmissor, oldFiber: current, mode });
    const selected = resolved.profile;
    if (!selected) throw Error('Escolha Integrada ou Bridge antes de continuar.');
    if (profile && (String(profile.id) !== String(selected.id) ||
        String(profile.comando || profile.comandos) !== String(selected.comando || selected.comandos))) {
      throw Error('Script alterado durante a confirmacao. Reinicie a consulta; nada foi desprovisionado.');
    }
    if (dryRun) return { simulated: true };
    await ixc.ensureOnuAuthorizationApiAvailable();
    phase = 'deauthorize';
    await runReprovisionOltAction(() => ixc.actionPost('botao_excluir_dispositivo_22434', { id: key }), { fiberId: key, phase }, saveResponse);
    phase = 'wait_after_deauthorize';
    // Falha ao avisar o operador nao deve impedir a recuperacao da ONU.
    try { await onWaiting(); } catch {
      logger.warn(JSON.stringify({ event: 'reprovision_wait_notice_failed', fiberId: key }));
    }
    await wait(REPROVISION_SETTLE_MS);
    phase = 'update_profile';
    const retained = await ixc.read('radpop_radio_cliente_fibra', key);
    if (!same(retained, current)) throw Error('Cadastro mudou apos desprovisao. Acione o NOC para recuperar o equipamento.');
    const expected = { ...current, id_perfil: String(selected.id), comandos: selected.comando || selected.comandos };
    if (!same(current, expected)) {
      const updated = await ixc.update('radpop_radio_cliente_fibra', key, { ...retained, id_perfil: expected.id_perfil, comandos: expected.comandos });
      if (updated?.type !== 'success') throw Error('IXC nao confirmou a atualizacao do script. Acione o NOC para recuperar o equipamento.');
      if (!same(await ixc.read('radpop_radio_cliente_fibra', key), expected)) throw Error('Script nao persistiu no cadastro. Acione o NOC para recuperar o equipamento.');
    }
    phase = 'authorize';
    await runReprovisionOltAction(() => ixc.authorizeOnu(key), { fiberId: key, phase }, saveResponse);
    phase = 'verify';
    const confirmed = await ixc.read('radpop_radio_cliente_fibra', key);
    if (!same(confirmed, expected)) throw Error('Regravacao enviada, mas cadastro divergiu. Acione o NOC para conferir.');
    return { fiber: confirmed };
  } catch (error) {
    // Nao registrar resposta bruta: o console da OLT pode conter senhas PPPoE.
    logger.error(JSON.stringify({ event: 'reprovision_failed', fiberId: key, phase, code: error.code || 'operation_failed' }));
    throw error;
  } finally { busy.delete(key); }
}
