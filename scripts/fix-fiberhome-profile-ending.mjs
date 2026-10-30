import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { IxcClient } from '../src/ixcClient.js';

// Only city-specific integrated profiles with the equivalent old WAN ending.
// Preserve the existing 2010 and 2014 dialects; never replace a full script.
const targets = new Map([
  ['30', '2014'], ['60', '2014'], ['67', '2014'], ['86', '2014'],
  ['88', '2014'], ['91', '2014'], ['96', '2014'],
  ['33', '2010'], ['84', '2010'], ['93', '2010'],
]);
const ixc = new IxcClient(config.ixc);
const table = 'radpop_radio_cliente_fibra_perfil';
const apply = process.argv.includes('--apply');
const plan = [];
for (const [id, version] of targets) {
  const row = await ixc.read(table, id);
  if (!row?.comando || !/INTEGRADA/i.test(row.nome)) throw Error(`Unexpected profile ${id}`);
  const context = version === '2010' ? /cd epononu;\s*cd qinq;/ : /cd onu;\s*cd lan;/;
  if (!context.test(row.comando)) throw Error(`Unexpected ${version} command context: ${id}`);
  const ending = /apply wancfg slot #slot# #pon# #onu_numero#;\s*apply wanbind slot #slot# #pon# #onu_numero#;\s*(?:save;\s*)?$/;
  const fixed = /apply wancfg slot #slot# #pon# #onu_numero#;\s*cd \.\.;\s*cd \.\.;\s*$/;
  if (fixed.test(row.comando)) { console.log(JSON.stringify({ id, name: row.nome, status: 'already_fixed' })); continue; }
  if (!ending.test(row.comando)) throw Error(`Unexpected ending: ${id}; manual review required`);
  const comando = row.comando.replace(ending, 'apply wancfg slot #slot# #pon# #onu_numero#;\r\ncd ..;\r\ncd ..;\r\n');
  plan.push({ row, comando, version });
}
for (const id of ['97', '92', '90', '89', '87', '82', '65', '62', '59', '32']) {
  const row = await ixc.read(table, id);
  if (!/BRIDGE/i.test(row?.nome || '') || !/set (?:white|service_ba)/i.test(row?.comando || '')) throw Error(`Unexpected bridge profile ${id}`);
  const comando = row.comando.replace(/^save;[ \t]*(?:\r?\n|$)/gm, '');
  if (comando === row.comando) { console.log(JSON.stringify({ id, name: row.nome, status: 'already_fixed' })); continue; }
  plan.push({ row, comando, version: 'bridge: remove save only' });
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', profiles: plan.map(p => ({ id: p.row.id, name: p.row.nome, version: p.version })) }));
if (apply && plan.length) {
  const dir = `backups/fiberhome-ending-${Date.now()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/before.json`, JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(`Backup: ${dir}/before.json`);
  for (const { row, comando } of plan) {
    const current = await ixc.read(table, row.id);
    if (JSON.stringify(current) !== JSON.stringify(row)) throw Error(`Concurrent change: ${row.id}`);
    const { id, ...body } = row;
    const response = await ixc.update(table, id, { ...body, comando });
    const verified = await ixc.read(table, id);
    if (response?.type !== 'success' || verified?.comando !== comando || verified?.nome !== row.nome || verified?.fabricante_modelo !== row.fabricante_modelo) {
      throw Error(`Update not verified for ${id}; stop and inspect backup`);
    }
    console.log(JSON.stringify({ id, name: row.nome, status: 'verified' }));
  }
}
