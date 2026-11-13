import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLog } from '../src/logger.js';
const options = { now: new Date('2026-11-13T15:00:00Z'), source: 'WEB' };

test('log mostra Brasilia, canal, etapa, duracao e identificadores pesquisaveis', () => {
  const line = formatLog('INFO', [JSON.stringify({ event: 'provision_stage', phase: 'authorize_device', olt: '5', fiberId: '42', durationMs: 52535 })], options);
  assert.match(line, /13\/11\/2026.*12:00:00 BRT \| WEB \| INFO/);
  assert.match(line, /etapa=aplicar script na OLT/);
  assert.match(line, /duracao=52.53s/);
  assert.match(line, /evento=provision_stage/);
  assert.match(line, /fibra=42/);
});
test('erro no fluxo ganha destaque e logs ficam em uma linha sem ANSI', () => {
  const line = formatLog('INFO', [{ event: 'flow_transition', errorCode: 'timeout', from: 'serial', to: 'onu_choose' }], options);
  assert.match(line, /\| ERRO \|/);
  assert.match(line, /erro=timeout/);
  assert.doesNotMatch(formatLog('INFO', ['abc\n\r\t\u001b[31mdef'], options), /[\n\r\t\u001b]/);
});
test('campos secretos e objetos brutos nao sao despejados nos logs', () => {
  const line = formatLog('ERRO', [{ event: 'unknown_event', senha: 'very-secret', token: 'private-token', comandos: 'pppoe secret', nested: { senha: 'secret' } }], options);
  assert.doesNotMatch(line, /very-secret|private-token|pppoe secret/);
  assert.match(line, /senha=\[OCULTO\]/);
  assert.match(line, /nested=\[objeto omitido\]/);
  assert.doesNotMatch(formatLog('ERRO', ['password=abc Bearer xyz https://api.telegram.org/bot123:abc/getMe'], options), /abc|xyz/);
  assert.match(formatLog('INFO', [{ senha: 'never-print' }], options), /objeto omitido/);
});
test('preserva evento desconhecido e texto de erro util', () => {
  assert.match(formatLog('AVISO', [{ event: 'new_event', attempt: 2 }], options), /evento=new_event.*tentativa=2/);
  assert.match(formatLog('ERRO', [new Error('timeout of 60000ms exceeded')], options), /timeout of 60000ms exceeded/);
});
