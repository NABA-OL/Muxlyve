// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// savePreset() sí toca settings.json (a diferencia de las funciones puras probadas en
// presets.test.mjs) — mismo patrón que destinations.test.mjs con MS_CONFIG_DIR temporal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-presets-'));
process.env.MS_CONFIG_DIR = tmpDir;

const { savePreset, listPresets, MAX_PRESETS } = await import('../src/presets.js');

const dest = [{ name: 'Twitch', url: 'rtmp://a', enabled: true }];

test('el tope de perfiles es 6', () => {
  assert.equal(MAX_PRESETS, 6);
});

test('guarda hasta el tope sin rechazar', () => {
  for (let i = 0; i < MAX_PRESETS; i++) savePreset('Perfil ' + i, dest);
  assert.equal(listPresets().length, MAX_PRESETS);
});

test('el perfil número 7 se rechaza con error claro, no descarta el más viejo en silencio', () => {
  assert.throws(() => savePreset('Perfil de más', dest), /Máximo 6 perfiles/);
  assert.equal(listPresets().length, MAX_PRESETS);
  assert.equal(listPresets()[0].name, 'Perfil 0'); // el primero sigue ahí, no lo pisó
});

test('sobreescribir un perfil EXISTENTE en el tope sí funciona (no es un perfil nuevo)', () => {
  savePreset('Perfil 0', [{ name: 'Twitch', url: 'rtmp://a', enabled: false }]);
  assert.equal(listPresets().length, MAX_PRESETS);
  assert.deepEqual(listPresets()[0].enabled, []);
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
