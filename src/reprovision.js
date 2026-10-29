const busy = new Set();
const fields = ['id', 'id_login', 'id_contrato', 'mac', 'id_transmissor', 'id_perfil', 'id_caixa_ftth', 'porta_ftth', 'slotno', 'ponno', 'onu_numero', 'comandos', 'vlan', 'vlan_pppoe'];
const same = (a, b) => a && b && fields.every(k => String(a[k] ?? '') === String(b[k] ?? ''));

export async function reprovisionExisting(ixc, { client, contract, login, fiber, dryRun = false }) {
  const key = String(fiber.id);
  if (busy.has(key)) throw Error('Este equipamento ja esta em processamento. Aguarde.');
  busy.add(key);
  try {
    const [currentContract, currentLogin, current] = await Promise.all([
      ixc.read('cliente_contrato', contract.id), ixc.read('radusuarios', login.id), ixc.read('radpop_radio_cliente_fibra', fiber.id),
    ]);
    if (!same(current, fiber) || String(currentContract?.id_cliente) !== String(client.id) || !['A', 'P'].includes(currentContract?.status) ||
        String(currentLogin?.id_cliente) !== String(client.id) || String(currentLogin?.id_contrato) !== String(contract.id) ||
        String(current?.id_login) !== String(login.id) || String(current?.id_contrato) !== String(contract.id)) {
      throw Error('Cadastro ou vinculo alterado. Reinicie a consulta; nada foi desprovisionado.');
    }
    if (!current.mac || !(Number(current.id_transmissor) > 0) || !(Number(current.id_perfil) > 0)) {
      throw Error('Cadastro de fibra incompleto. Confirme serial, OLT e perfil com o NOC.');
    }
    if (dryRun) return { simulated: true };
    await ixc.ensureOnuAuthorizationApiAvailable();
    const removed = await ixc.actionPost('botao_excluir_dispositivo_22434', { id: key });
    if (removed?.type !== 'success') throw Error('IXC nao confirmou a desprovisao. Acione o NOC antes de repetir.');
    const retained = await ixc.read('radpop_radio_cliente_fibra', key);
    if (!same(retained, current)) throw Error('Cadastro mudou apos desprovisao. Acione o NOC para recuperar o equipamento.');
    const authorized = await ixc.authorizeOnu(key);
    if (authorized?.type !== 'success') throw Error('IXC nao confirmou a regravacao. Acione o NOC para recuperar o equipamento.');
    const confirmed = await ixc.read('radpop_radio_cliente_fibra', key);
    if (!same(confirmed, current)) throw Error('Regravacao enviada, mas cadastro divergiu. Acione o NOC para conferir.');
    return { fiber: confirmed };
  } finally { busy.delete(key); }
}
