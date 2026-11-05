import { resolveProvisionProfiles } from './provisionProfiles.js';
const busy = new Set();
const fields = ['id', 'id_login', 'id_contrato', 'mac', 'id_transmissor', 'id_perfil', 'id_caixa_ftth', 'porta_ftth', 'slotno', 'ponno', 'onu_numero', 'comandos', 'vlan', 'vlan_pppoe'];
const same = (a, b) => a && b && fields.every(k => String(a[k] ?? '') === String(b[k] ?? ''));

// O IXC retorna HTML de console para as acoes de OLT, nao apenas JSON.
// Um painel verde sem confirmacao de comando nao comprova a operacao.
export const isConfirmedOltAction = response => {
  const raw = typeof response === 'string' ? response : String(response?.message || '');
  const text = raw.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (response?.type === 'error' || /panel-(?:heading-)?(?:danger|warning|error)/i.test(raw) ||
      /\b(error|erro|falha|failed|failure|invalid|timeout|incomplete|unknown command|not found)\b/i.test(text)) return false;
  return response?.type === 'success' ||
    (/panel-(?:heading-)?success/i.test(raw) && /command execute success|executad[oa] com sucesso|successfully/i.test(text));
};

export async function reprovisionExisting(ixc, { client, contract, login, fiber, mode, profile, dryRun = false }) {
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
    const removed = await ixc.actionPost('botao_excluir_dispositivo_22434', { id: key });
    if (!isConfirmedOltAction(removed)) throw Error('IXC nao confirmou a desprovisao. Acione o NOC antes de repetir.');
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
    const authorized = await ixc.authorizeOnu(key);
    if (!isConfirmedOltAction(authorized)) throw Error('IXC nao confirmou a regravacao. Acione o NOC para recuperar o equipamento.');
    phase = 'verify';
    const confirmed = await ixc.read('radpop_radio_cliente_fibra', key);
    if (!same(confirmed, expected)) throw Error('Regravacao enviada, mas cadastro divergiu. Acione o NOC para conferir.');
    return { fiber: confirmed };
  } catch (error) {
    // Nao registrar resposta bruta: o console da OLT pode conter senhas PPPoE.
    console.error(JSON.stringify({ event: 'reprovision_failed', fiberId: key, phase, code: error.code || 'operation_failed' }));
    throw error;
  } finally { busy.delete(key); }
}
