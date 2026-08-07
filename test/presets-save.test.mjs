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

// Fase 3 del lote 2 (docs/PLAN_FEATURES_LOTE2.md) — perfiles con título + categoría.
// Los tests de arriba ya llenaron el tope de 6 perfiles (Perfil 0..5) — estos reusan esos
// mismos nombres (sobreescribir, no crear) para no chocar con el límite.
test('savePreset sin streamInfo deja title/category en null (retrocompatible)', () => {
  savePreset('Perfil 1', dest);
  const p = listPresets().find((x) => x.name === 'Perfil 1');
  assert.equal(p.title, null);
  assert.equal(p.category, null);
});

test('savePreset con streamInfo guarda título y categoría', () => {
  savePreset('Perfil 2', dest, { title: 'Charlando un rato', category: 'Just Chatting' });
  const p = listPresets().find((x) => x.name === 'Perfil 2');
  assert.equal(p.title, 'Charlando un rato');
  assert.equal(p.category, 'Just Chatting');
});

test('savePreset con streamInfo vacío/en blanco lo deja en null, no en string vacío', () => {
  savePreset('Perfil 3', dest, { title: '   ', category: '' });
  const p = listPresets().find((x) => x.name === 'Perfil 3');
  assert.equal(p.title, null);
  assert.equal(p.category, null);
});

test('savePreset recorta título/categoría a 140 caracteres', () => {
  const largo = 'x'.repeat(200);
  savePreset('Perfil 4', dest, { title: largo, category: largo });
  const p = listPresets().find((x) => x.name === 'Perfil 4');
  assert.equal(p.title.length, 140);
  assert.equal(p.category.length, 140);
});

test('sobreescribir un perfil existente actualiza también título/categoría, no solo destinos', () => {
  savePreset('Perfil 1', dest, { title: 'Ahora sí tiene', category: 'Minecraft' });
  const p = listPresets().find((x) => x.name === 'Perfil 1');
  assert.equal(p.title, 'Ahora sí tiene');
  assert.equal(p.category, 'Minecraft');
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
