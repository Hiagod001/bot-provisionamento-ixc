// Uma linha por evento: legivel no Dokploy e sem sequencias de cor ANSI.
const timeFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium',
});
let channel = 'APP';
export const setLogChannel = value => { channel = value; };

const events = {
  flow_transition: 'Fluxo do atendimento', flow_operation_error: 'Falha no atendimento',
  web_flow_error: 'Falha no atendimento web',
  provision_stage: 'Provisionamento em andamento', provision_unconfirmed: 'Provisionamento NAO confirmado',
  provision_notice_failed: 'Falha ao avisar o tecnico', provision_capture_failed: 'Falha ao salvar diagnostico',
  onu_search: 'Busca de ONU concluida', onu_refresh: 'Consulta das OLTs concluida',
  onu_target_refresh: 'Consulta da OLT concluida', onu_target_failed: 'Falha ao consultar OLT',
  onu_olt_failed: 'OLT nao respondeu', onu_discovery_fallback: 'Usando lista alternativa de OLTs',
  swap_preserve_box: 'Troca de ONU: mantendo caixa e porta', standalone_mac_clear: 'MAC do login limpo',
  olt_action_unconfirmed: 'Operacao na OLT NAO confirmada', olt_response_capture_failed: 'Falha ao salvar resposta da OLT',
  reprovision_failed: 'Falha no reprovisionamento', reprovision_wait_notice_failed: 'Falha ao avisar espera da ONU',
};
const fields = {
  session: 'sessao', service: 'servico', input: 'entrada', from: 'de', to: 'para',
  phase: 'etapa', step: 'etapa', olt: 'OLT', olts: 'OLTs', configuredOlts: 'OLTs configuradas',
  failedOlts: 'OLTs com falha', suffix: 'final serial', matches: 'encontradas', rows: 'registros',
  attempt: 'tentativa', durationMs: 'duracao', fiberId: 'fibra', contractId: 'contrato',
  clientId: 'cliente', loginId: 'login ID', boxId: 'caixa ID', port: 'porta',
  errorCode: 'erro', code: 'codigo', reference: 'referencia', classification: 'resultado', httpStatus: 'HTTP',
};
const values = {
  prepare: 'preparar dados', preflight: 'validar antes de gravar', create_fiber: 'criar cadastro de fibra',
  find_created_fiber: 'conferir cadastro criado', authorize_pending: 'autorizar ONU pendente',
  authorize_device: 'aplicar script na OLT', verify: 'verificar resultado', remove_duplicate: 'remover cadastro antigo',
  deauthorize: 'desprovisionar', authorize: 'provisionar', update_profile: 'atualizar perfil',
  service: 'menu inicial', serial: 'serial da ONU', client: 'cliente', onu_choose: 'escolher ONU',
  profile_choose: 'escolher Integrada/Bridge', swap_oldfiber_confirm: 'confirmar remocao antiga',
  swap_oldfiber_removing: 'remover ONU antiga', confirm: 'confirmar provisionamento',
  provisioning: 'provisionando', provisioned_signal_ready: 'concluido; sinal sob consulta',
  troca: 'troca de equipamento', mudanca: 'mudanca de endereco', button: 'botao', message: 'mensagem',
};

const secretKey = /password|senha|token|authorization|cookie|secret|comandos?|pppoe/i;
const clean = value => String(value)
  .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[OCULTO]')
  .replace(/(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [OCULTO]')
  .replace(/((?:password|senha|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[OCULTO]')
  .slice(0, 1500);

export function formatLog(level, args, { now = new Date(), source = channel } = {}) {
  let event = args[0];
  if (typeof event === 'string' && event.trim().startsWith('{')) {
    try { event = JSON.parse(event); } catch { /* Texto comum, nao JSON. */ }
  }
  if (event?.errorCode || event?.event === 'flow_operation_error') level = 'ERRO';
  const prefix = `${timeFormat.format(now)} BRT | ${source} | ${level}`;
  if (event && typeof event === 'object' && typeof event.event === 'string') {
    const details = Object.entries(event).filter(([key, value]) =>
      !['event', 'at'].includes(key) && value !== undefined && value !== null
    ).map(([key, value]) => {
      const label = fields[key] || key;
      if (secretKey.test(key)) return `${label}=[OCULTO]`;
      if (key === 'durationMs' && Number.isFinite(value)) return `${label}=${(value / 1000).toFixed(2)}s`;
      const display = Array.isArray(value) ? (value.length ? value.join(', ') : 'nenhuma')
        : typeof value === 'object' ? '[objeto omitido]' : values[value] || value;
      return `${clean(label)}=${clean(display)}`;
    });
    return `${prefix} | ${events[event.event] || clean(event.event)} | evento=${clean(event.event)}${details.length ? ' | ' + details.join(' | ') : ''}`;
  }
  return `${prefix} | ${args.map(arg => arg instanceof Error ? `${arg.name}: ${clean(arg.message)}`
    : typeof arg === 'object' && arg !== null ? '[objeto omitido]' : clean(arg)).join(' ')}`;
}

const write = (method, level, args) => {
  try { console[method](formatLog(level, args)); }
  catch { /* Uma falha no log nunca deve interromper uma operacao no IXC. */ }
};
export const logger = {
  log: (...args) => write('log', 'INFO', args),
  info: (...args) => write('info', 'INFO', args),
  warn: (...args) => write('warn', 'AVISO', args),
  error: (...args) => write('error', 'ERRO', args),
};
