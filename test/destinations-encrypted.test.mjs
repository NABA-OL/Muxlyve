// Desarrollado por BlacKraken Solutions (NABA-OL)
// Con MASTER_KEY definida, la URL debe quedar cifrada (AES-256-GCM) en disco y descifrarse
// de vuelta al cargar. Va en un archivo aparte de destinations.test.mjs porque MASTER_KEY
// se lee una sola vez al importar el módulo — no se puede alternar dentro del mismo proceso.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-enc-'));
process.env.MS_CONFIG_DIR = tmpDir;
process.env.MASTER_KEY = 'clave-de-prueba-no-usar-en-produccion';

const { loadAll, saveAll } = await import('../src/destinations.js');

test('saveAll cifra la URL en disco y loadAll la descifra de vuelta', () => {
  const list = [{ name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2/secret-key', enabled: true }];
  saveAll(list);

  const raw = readFileSync(path.join(tmpDir, 'destinations.json'), 'utf8');
  assert.equal(raw.includes('secret-key'), false, 'la clave no debe quedar en texto plano en disco');
  assert.ok(raw.includes('urlEnc'), 'debe guardar el campo cifrado urlEnc');

  const loaded = loadAll();
  assert.equal(loaded[0].url, 'rtmp://a.rtmp.youtube.com/live2/secret-key');
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
