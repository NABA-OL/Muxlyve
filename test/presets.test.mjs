// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// applyPresetToDestinations() es la parte pura de los perfiles de destinos (ver
// src/presets.js) — recibe destinos + preset, devuelve un array NUEVO, sin tocar disco
// ni relays. savePreset/deletePreset/listPresets sí tocan settings.json, se prueban por
// separado si hace falta (mismo patrón que destinations.test.mjs con MS_CONFIG_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPresetToDestinations, deactivatePresetInDestinations, isPresetActive } from '../src/presets.js';

const destinations = [
  { name: 'Twitch', url: 'rtmp://a', enabled: true },
  { name: 'YouTube', url: 'rtmp://b', enabled: false },
  { name: 'Kick', url: 'rtmp://c', enabled: true },
];

test('destino listado en el preset queda enabled=true', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  const next = applyPresetToDestinations(destinations, preset);
  assert.equal(next.find((d) => d.name === 'Twitch').enabled, true);
});

test('destino fuera del preset queda enabled=false, aunque estuviera prendido antes', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  const next = applyPresetToDestinations(destinations, preset);
  assert.equal(next.find((d) => d.name === 'Kick').enabled, false);
  assert.equal(next.find((d) => d.name === 'YouTube').enabled, false);
});

test('no muta el array ni los objetos originales', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  const original = JSON.parse(JSON.stringify(destinations));
  applyPresetToDestinations(destinations, preset);
  assert.deepEqual(destinations, original);
});

test('nombre del preset que ya no existe en destinations se ignora sin romper', () => {
  const preset = { name: 'Viejo', enabled: ['DestinoQueYaNoExiste'] };
  const next = applyPresetToDestinations(destinations, preset);
  assert.equal(next.every((d) => d.enabled === false), true);
  assert.equal(next.length, destinations.length);
});

test('preset con enabled vacío apaga todo', () => {
  const preset = { name: 'Ninguno', enabled: [] };
  const next = applyPresetToDestinations(destinations, preset);
  assert.equal(next.every((d) => d.enabled === false), true);
});

test('preset nulo/undefined devuelve la lista tal cual', () => {
  assert.deepEqual(applyPresetToDestinations(destinations, null), destinations);
  assert.deepEqual(applyPresetToDestinations(destinations, undefined), destinations);
});

// deactivatePresetInDestinations — para el botón de Stream Deck (docs/STREAMDECK_PLUGIN.md):
// apaga SOLO lo que el perfil prende, no toca el resto (a diferencia de apply, que es
// intercambio total).
test('deactivate apaga solo los destinos del preset, no toca el resto', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  const next = deactivatePresetInDestinations(destinations, preset);
  assert.equal(next.find((d) => d.name === 'Twitch').enabled, false);
  // Kick estaba enabled=true por su cuenta, fuera del preset — no lo toca.
  assert.equal(next.find((d) => d.name === 'Kick').enabled, true);
  assert.equal(next.find((d) => d.name === 'YouTube').enabled, false); // ya estaba false
});

test('deactivate no muta el input', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  const original = JSON.parse(JSON.stringify(destinations));
  deactivatePresetInDestinations(destinations, preset);
  assert.deepEqual(destinations, original);
});

test('deactivate con preset nulo devuelve la lista tal cual', () => {
  assert.deepEqual(deactivatePresetInDestinations(destinations, null), destinations);
});

// isPresetActive — heurística de "¿está prendido ahora?" que expone GET /api/presets
// (campo `active`) para que el plugin pinte el botón sin pedir /api/state aparte.
test('preset activo cuando TODOS sus destinos están enabled=true', () => {
  const preset = { name: 'Twitch+Kick', enabled: ['Twitch', 'Kick'] };
  assert.equal(isPresetActive(destinations, preset), true); // ambos están true arriba
});

test('preset inactivo si falta alguno de sus destinos', () => {
  const preset = { name: 'Todo', enabled: ['Twitch', 'YouTube', 'Kick'] };
  assert.equal(isPresetActive(destinations, preset), false); // YouTube está false
});

test('preset activo aunque haya OTROS destinos prendidos fuera del preset', () => {
  const preset = { name: 'Solo Twitch', enabled: ['Twitch'] };
  assert.equal(isPresetActive(destinations, preset), true); // Kick también está true, no importa
});

test('preset con enabled vacío nunca está activo', () => {
  const preset = { name: 'Ninguno', enabled: [] };
  assert.equal(isPresetActive(destinations, preset), false);
});

test('destino del preset que ya no existe -> inactivo', () => {
  const preset = { name: 'Viejo', enabled: ['NoExiste'] };
  assert.equal(isPresetActive(destinations, preset), false);
});

// Caso real reportado: perfil con Twitch+Kick+YouTube, se borra YouTube desde el panel,
// se aplica el perfil (Twitch y Kick quedan prendidos, YouTube se ignora al ya no
// existir — ver applyPresetToDestinations). Antes del fix, isPresetActive() exigía TODOS
// los nombres del perfil incluido el borrado, así que el perfil quedaba "inactivo" para
// siempre aunque estuviera correctamente aplicado.
test('perfil con un destino borrado sigue detectándose activo si el resto está prendido', () => {
  const preset = { name: 'Todo', enabled: ['Twitch', 'Kick', 'YouTube'] };
  const destinationsSinYoutube = [
    { name: 'Twitch', url: 'rtmp://a', enabled: true },
    { name: 'Kick', url: 'rtmp://c', enabled: true },
    // YouTube ya no está en la lista — se borró.
  ];
  assert.equal(isPresetActive(destinationsSinYoutube, preset), true);
});

test('perfil con un destino borrado sigue detectando inactivo si falta prender algo', () => {
  const preset = { name: 'Todo', enabled: ['Twitch', 'Kick', 'YouTube'] };
  const destinationsSinYoutube = [
    { name: 'Twitch', url: 'rtmp://a', enabled: true },
    { name: 'Kick', url: 'rtmp://c', enabled: false },
  ];
  assert.equal(isPresetActive(destinationsSinYoutube, preset), false);
});
