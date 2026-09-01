/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// shouldTriggerClip() es la decisión de autorización de !clip, sin FFmpeg de por medio
// (ver src/chatcommands.js) — el cooldown y el estado de señal viven aparte en
// initChatCommands(), no acá.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTriggerClip } from '../src/chatcommands.js';

const NOW = 1_000_000;

test('mod escribiendo !clip dispara', () => {
  const msg = { message: '!clip', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, 0), true);
});

test('broadcaster escribiendo !clip dispara', () => {
  const msg = { message: '!clip', isMod: false, isBroadcaster: true };
  assert.equal(shouldTriggerClip(msg, NOW, 0), true);
});

test('viewer normal no dispara', () => {
  const msg = { message: '!clip', isMod: false, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, 0), false);
});

test('dentro del cooldown no dispara', () => {
  const msg = { message: '!clip', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, NOW - 5000), false); // cooldown es 15s
});

test('fuera del cooldown sí dispara', () => {
  const msg = { message: '!clip', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, NOW - 20000), true);
});

test('texto que no es !clip no dispara', () => {
  const msg = { message: 'hola !clip', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, 0), false);
});

test('!clipboard no matchea por substring', () => {
  const msg = { message: '!clipboard', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, 0), false);
});

test('!clip con texto extra después sí dispara (solo mira la primera palabra)', () => {
  const msg = { message: '!clip por favor', isMod: true, isBroadcaster: false };
  assert.equal(shouldTriggerClip(msg, NOW, 0), true);
});

test('mensaje sin isMod/isBroadcaster (undefined) no dispara', () => {
  const msg = { message: '!clip' };
  assert.equal(shouldTriggerClip(msg, NOW, 0), false);
});

test('mensaje nulo o sin texto no rompe', () => {
  assert.equal(shouldTriggerClip(null, NOW, 0), false);
  assert.equal(shouldTriggerClip({}, NOW, 0), false);
});
