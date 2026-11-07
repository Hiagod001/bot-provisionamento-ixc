import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// O corpo pode conter comandos e credenciais. Nunca enviar ao chat nem ao log.
export async function saveOltResponse({ fiberId, phase, classification, response, httpStatus, errorCode }, directory = resolve('data/olt-responses')) {
  const reference = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, `${reference}.json`), JSON.stringify({
    reference, at: new Date().toISOString(), fiberId, phase, classification,
    httpStatus, errorCode, response: response ?? null,
  }), { flag: 'wx', mode: 0o600 });
  return reference;
}
