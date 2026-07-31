// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// recordSession()/listSessions() tocan sessions.json — mismo patrón que
// presets-save.test.mjs con MS_CONFIG_DIR temporal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-sessions-'));
process.env.MS_CONFIG_DIR = tmpDir;

const { listSessions, recordSession, MAX_SESSIONS } = await import('../src/sessions.js');

test('sin sessions.json todavía, listSessions() devuelve vacío', () => {
  assert.deepEqual(listSessions(), []);
});

test('recordSession guarda y listSessions lo devuelve', () => {
  recordSession({ startedAt: 1000, endedAt: 2000, durationSeconds: 1, destinations: ['Twitch'], peakViewers: { twitch: 5 } });
  const sessions = listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].destinations[0], 'Twitch');
  assert.equal(sessions[0].peakViewers.twitch, 5);
});

test('el más reciente queda primero (unshift, no push)', () => {
  recordSession({ startedAt: 3000, endedAt: 4000, durationSeconds: 1, destinations: ['Kick'], peakViewers: {} });
  const sessions = listSessions();
  assert.equal(sessions[0].destinations[0], 'Kick');
  assert.equal(sessions[1].destinations[0], 'Twitch');
});

test(`se poda al tope de ${MAX_SESSIONS} sesiones`, () => {
  for (let i = 0; i < MAX_SESSIONS + 10; i++) {
    recordSession({ startedAt: i, endedAt: i + 1, durationSeconds: 1, destinations: ['X' + i], peakViewers: {} });
  }
  const sessions = listSessions();
  assert.equal(sessions.length, MAX_SESSIONS);
  // El más nuevo de la tanda final queda primero — confirma que podó las viejas, no las nuevas.
  assert.equal(sessions[0].destinations[0], 'X' + (MAX_SESSIONS + 9));
});

test('entradas mal formadas en el archivo se descartan sin romper, no rechazan las válidas', () => {
  writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify([
    { startedAt: 1, endedAt: 2, durationSeconds: 1, destinations: ['Bien'] }, // válida
    { startedAt: 1, endedAt: 2 }, // sin destinations -> inválida
    'no es un objeto', // inválida
    null, // inválida
  ]));
  const sessions = listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].destinations[0], 'Bien');
});

test('sessions.json que no es un array devuelve vacío, no truena', () => {
  writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({ no: 'es un array' }));
  assert.deepEqual(listSessions(), []);
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
