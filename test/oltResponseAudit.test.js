import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveOltResponse } from '../src/oltResponseAudit.js';
import { runReprovisionOltAction } from '../src/reprovision.js';
import { IxcClient } from '../src/ixcClient.js';

test('preserva resposta literal em arquivo restrito', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ixc-response-test-'));
  const response = '<div>Resposta desconhecida\r\nset secret EXAMPLE_SECRET</div>';
  const reference = await saveOltResponse({ fiberId: '123', phase: 'deauthorize', classification: 'unrecognized_response', response }, directory);
  const path = join(directory, `${reference}.json`);
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.response, response);
    assert.equal(stored.phase, 'deauthorize');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await unlink(path); await rmdir(directory); }
});

test('resposta desconhecida tem referencia, sem corpo no chat ou log e sem repeticao', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const response = '<div>EXAMPLE_SECRET</div>';
  let requests = 0, captured;
  await assert.rejects(runReprovisionOltAction(async () => { requests++; return response; }, { fiberId: '123', phase: 'deauthorize' }, async data => { captured = data; return 'reference-test'; }), error => {
    assert.match(error.message, /Referencia para o NOC: reference-test/);
    assert.ok(!error.message.includes('EXAMPLE_SECRET'));
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(captured.response, response);
  assert.equal(captured.classification, 'unrecognized_response');
  assert.ok(!logs.join('').includes('EXAMPLE_SECRET'));
});

test('captura rejeicao do IXC mesmo quando authorizeOnu lanca erro', async () => {
  const ixc = new IxcClient({ baseUrl: 'https://example.invalid', token: 'test' });
  const response = { type: 'error', message: 'EXAMPLE_SECRET' };
  ixc.actionPost = async () => response;
  let captured;
  await assert.rejects(runReprovisionOltAction(() => ixc.authorizeOnu('123'), { fiberId: '123', phase: 'authorize' }, async data => { captured = data; return 'ref'; }), error => {
    assert.match(error.message, /indicacao de erro/);
    assert.ok(!error.message.includes('EXAMPLE_SECRET'));
    return true;
  });
  assert.deepEqual(captured.response, response);
  assert.equal(captured.classification, 'ixc_rejected');
});

test('timeout registra ausencia de resposta; HTTP com corpo preserva somente o corpo', async () => {
  for (const body of [undefined, '<html>Gateway error</html>']) {
    let captured;
    await assert.rejects(runReprovisionOltAction(async () => {
      throw Object.assign(Error('URL_WITH_SECRET'), { code: 'ECONNABORTED', config: { token: 'EXAMPLE_SECRET' }, response: body ? { status: 502, data: body } : undefined });
    }, { fiberId: '123', phase: 'authorize' }, async data => { captured = data; return 'ref'; }), /IXC nao confirmou/);
    assert.equal(captured.response, body);
    assert.equal(captured.classification, body ? 'ixc_rejected' : 'transport_error');
    assert.ok(!JSON.stringify(captured).includes('EXAMPLE_SECRET'));
    assert.ok(!JSON.stringify(captured).includes('URL_WITH_SECRET'));
  }
});

test('falha ao salvar evidencia nao repete acao nem mascara resposta inconclusiva', async () => {
  await assert.rejects(runReprovisionOltAction(async () => ({}), { fiberId: '123', phase: 'deauthorize' }, async () => { throw Error('Disk error'); }), /IXC nao confirmou a desprovisao/);
  const response = { type: 'success' };
  assert.equal(await runReprovisionOltAction(async () => response, { fiberId: '123', phase: 'authorize' }, async () => { throw Error('Should not save success'); }), response);
});
