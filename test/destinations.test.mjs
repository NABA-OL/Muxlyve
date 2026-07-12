// Desarrollado por BlacKraken Solutions (NABA-OL)
// Round-trip en texto plano (sin MASTER_KEY) + validación de URLs. MS_CONFIG_DIR/MASTER_KEY
// se leen en destinations.js al importar el módulo, por eso van antes del import dinámico.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-'));
process.env.MS_CONFIG_DIR = tmpDir;
delete process.env.MASTER_KEY;

const { loadAll, saveAll, isValidUrl, isPlayable } = await import('../src/destinations.js');

test('isValidUrl acepta rtmp/rtmps/srt y rechaza placeholders de la plantilla', () => {
  assert.equal(isValidUrl('rtmp://live.twitch.tv/app/abc123'), true);
  assert.equal(isValidUrl('rtmps://a.rtmp.youtube.com/live2/xyz'), true);
  assert.equal(isValidUrl('srt://servidor:9999?streamid=abc'), true);
  assert.equal(isValidUrl('http://no-es-rtmp.com'), false);
  assert.equal(isValidUrl('rtmp://servidor/app/TU_CLAVE'), false);
  assert.equal(isValidUrl(null), false);
});

test('isPlayable exige enabled=true y una URL válida', () => {
  assert.equal(isPlayable({ enabled: true, url: 'rtmp://x/y/z' }), true);
  assert.equal(isPlayable({ enabled: false, url: 'rtmp://x/y/z' }), false);
  assert.equal(isPlayable({ enabled: true, url: 'TU_CLAVE' }), false);
  assert.equal(isPlayable(null), false);
});

test('saveAll + loadAll hacen round-trip en texto plano sin MASTER_KEY', () => {
  const list = [{ name: 'Twitch', url: 'rtmp://live.twitch.tv/app/testkey', enabled: true }];
  saveAll(list);
  const loaded = loadAll();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Twitch');
  assert.equal(loaded[0].url, 'rtmp://live.twitch.tv/app/testkey');
  assert.equal(loaded[0].urlEnc, undefined);
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
