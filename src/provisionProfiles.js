import { profileMode } from './format.js';

// Perfis existentes aprovados por OLT. Nao usar o perfil mais recente nem o
// fabricante da ONU para inferir o fabricante/versao da OLT.
const approved = {
  '1': { integrada: '88', bridge: '89' },
  '6': { integrada: '86', bridge: '87' },
  '7': { integrada: '84', bridge: '90' },
  '8': { integrada: '93', bridge: '92' },
  '9': { integrada: '91', bridge: '32' },
  '1105': { integrada: '96', bridge: '97' },
  ...Object.fromEntries(['2', '3', '4', '5', '1056'].map(id => [id, { integrada: '94', bridge: '95' }])),
};

export async function resolveProvisionProfiles(ixc, { oltId, oldFiber, mode }) {
  const mapping = approved[String(oltId)];
  if (!mapping) throw Error('OLT sem mapeamento de scripts aprovado. Confirme com o NOC antes de continuar.');
  const oldId = Number(oldFiber?.id_perfil) > 0 ? String(oldFiber.id_perfil) : null;
  if (oldId) {
    const old = await ixc.read('radpop_radio_cliente_fibra_perfil', oldId);
    if (!old || String(old.id) !== oldId) throw Error('Nao consegui conferir o script antigo. Confirme com o NOC antes de continuar.');
    const name = String(old.nome || '').toUpperCase();
    const inferred = profileMode(old);
    if (!inferred || (name.includes('BRIDGE') && name.includes('INTEGRAD'))) {
      throw Error('Script antigo sem tipo bridge/integrada inequivoco. Confirme com o NOC antes de continuar.');
    }
    if (mode && mode !== inferred) throw Error('Tipo escolhido diverge do script antigo. Reinicie a consulta.');
    mode = inferred;
  }
  if (mode && !mapping[mode]) throw Error('Tipo de equipamento invalido.');
  const modes = mode ? [mode] : ['integrada', 'bridge'];
  const choices = await Promise.all(modes.map(async type => {
    const profile = await ixc.read('radpop_radio_cliente_fibra_perfil', mapping[type]);
    const manufacturer = String(profile?.fabricante_modelo || '').toUpperCase();
    const huawei = ['2', '3', '4', '5', '1056'].includes(String(oltId));
    const compatible = huawei ? ['HW', 'HUAWEI'] : ['FH', 'FBT', 'FB6001', 'FIBERHOME'];
    if (!profile || String(profile.id) !== mapping[type] || profileMode(profile) !== type ||
        (manufacturer && !compatible.includes(manufacturer)) || !String(profile.comando || profile.comandos || '').trim()) {
      throw Error('Script aprovado indisponivel ou incompativel com a OLT. Confirme com o NOC.');
    }
    return profile;
  }));
  return { profile: mode ? choices[0] : null, choices, mode };
}
