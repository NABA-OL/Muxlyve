/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-10-10
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Hallazgos del chequeo de seguridad 2026-10-10: redacción de claves en logs, validación
// del header Host (DNS rebinding) y clave de ingest aleatoria en vez de "mistream".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-security-'));
process.env.MS_CONFIG_DIR = tmpDir;
delete process.env.STREAM_KEY;

const { redactStreamUrls } = await import('../src/redact.js');
const { hostAllowed } = await import('../src/panelAuth.js');
const { loadSettings, ensureStreamKey, isValidStreamKey, WEAK_DEFAULT_STREAM_KEY } = await import('../src/settings.js');
const settingsPath = path.join(tmpDir, 'settings.json');

after(() => rmSync(tmpDir, { recursive: true, force: true }));

test('redactStreamUrls oculta la clave y el query, conserva host:puerto', () => {
  assert.equal(
    redactStreamUrls('rtmp://127.0.0.1:1/live/CLAVE_SECRETA_ABC123: Connection refused'),
    'rtmp://127.0.0.1:1/**** Connection refused',
  );
  assert.equal(
    redactStreamUrls('Error opening output rtmps://a.rtmp.youtube.com/live2/abcd-1234?backup=1: I/O error'),
    'Error opening output rtmps://a.rtmp.youtube.com/**** I/O error',
  );
  assert.equal(redactStreamUrls('srt://h.example:9000?streamid=s3cr3t&passphrase=x'), 'srt://h.example:9000/****');
  assert.equal(redactStreamUrls('sin urls acá https://example.com/a/b'), 'sin urls acá https://example.com/a/b');
});

test('hostAllowed acepta localhost e IPs literales, rechaza dominios (DNS rebinding)', () => {
  const req = (host) => ({ headers: host === undefined ? {} : { host } });
  for (const ok of ['localhost:19080', 'LOCALHOST', '127.0.0.1:19080', '192.168.1.5:19080', '[::1]:19080', undefined]) {
    assert.equal(hostAllowed(req(ok)), true, `debería aceptar ${ok}`);
  }
  for (const bad of ['attacker.example:19080', '127.0.0.1.attacker.example', 'localhost.attacker.example', 'evil.com', '[::1', 'localhost@evil.com']) {
    assert.equal(hostAllowed(req(bad)), false, `debería rechazar ${bad}`);
  }
});

test('sin clave persistida se genera una aleatoria válida, nunca "mistream", y es estable', () => {
  const a = loadSettings().streamKey;
  assert.notEqual(a, WEAK_DEFAULT_STREAM_KEY);
  assert.ok(isValidStreamKey(a));
  assert.equal(loadSettings().streamKey, a);
});

test('ensureStreamKey persiste la generada y avisa que fue generada', () => {
  const { key, generated } = ensureStreamKey();
  assert.equal(generated, true);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf-8')).streamKey, key);
  assert.equal(loadSettings().streamKey, key);
});

test('"mistream" persistida (instalaciones viejas) se reemplaza por una aleatoria', () => {
  writeFileSync(settingsPath, JSON.stringify({ streamKey: 'mistream' }));
  assert.notEqual(loadSettings().streamKey, 'mistream');
});

test('una clave propia del usuario se respeta', () => {
  writeFileSync(settingsPath, JSON.stringify({ streamKey: 'mi_clave_propia_9' }));
  assert.equal(loadSettings().streamKey, 'mi_clave_propia_9');
});

test('STREAM_KEY de env se usa como default salvo que sea "mistream"', () => {
  writeFileSync(settingsPath, '{}');
  process.env.STREAM_KEY = 'desde_env_123';
  assert.equal(loadSettings().streamKey, 'desde_env_123');
  process.env.STREAM_KEY = 'mistream';
  assert.notEqual(loadSettings().streamKey, 'mistream');
  delete process.env.STREAM_KEY;
});

test('ensureStreamKey no pisa un settings.json ilegible', () => {
  writeFileSync(settingsPath, '{ no es json');
  ensureStreamKey();
  assert.equal(readFileSync(settingsPath, 'utf-8'), '{ no es json');
});

// ── Contención de rutas (clips/grabaciones) ──
const { deleteClip, deleteRecording, convertOrphanRecording, resolveClipsDir, resolveRecordingsDir, isManagedFile } = await import('../src/relays.js');
const { existsSync, mkdirSync } = await import('node:fs');
const mediaDir = path.join(tmpDir, 'media');
mkdirSync(mediaDir, { recursive: true });
const writeSettings = (o) => writeFileSync(settingsPath, JSON.stringify(o));

test('outputDir del cliente ya no define la carpeta base', () => {
  writeSettings({ clipsDir: mediaDir, recordingsDir: mediaDir });
  assert.equal(resolveClipsDir('/etc'), mediaDir);
  assert.equal(resolveRecordingsDir('/etc'), mediaDir);
});

test('bypass viejo: {path: X, outputDir: dirname(X)} ya no borra un archivo ajeno', () => {
  writeSettings({ clipsDir: mediaDir, recordingsDir: mediaDir });
  const victim = path.join(tmpDir, 'importante.txt');
  writeFileSync(victim, 'x');
  assert.throws(() => deleteClip(victim, tmpDir), /fuera de la carpeta/);
  assert.throws(() => deleteRecording(victim, tmpDir), /fuera de la carpeta/);
  assert.equal(existsSync(victim), true);
});

test('dentro de la carpeta configurada solo se borran archivos que la app genera', () => {
  writeSettings({ clipsDir: mediaDir, recordingsDir: mediaDir });
  const foreign = path.join(mediaDir, 'notas.docx');
  const clip = path.join(mediaDir, 'clip_2026.mp4');
  const rec = path.join(mediaDir, 'grabacion_2026.ts');
  for (const f of [foreign, clip, rec]) writeFileSync(f, 'x');
  assert.throws(() => deleteClip(foreign), /fuera de la carpeta/);
  assert.throws(() => deleteRecording(foreign), /fuera de la carpeta/);
  assert.throws(() => deleteClip(rec), /fuera de la carpeta/);
  deleteClip(clip);
  deleteRecording(rec);
  assert.equal(existsSync(foreign), true);
  assert.equal(existsSync(clip), false);
  assert.equal(existsSync(rec), false);
});

test('path traversal con .. no escapa de la carpeta', () => {
  writeSettings({ clipsDir: mediaDir });
  const victim = path.join(tmpDir, 'clip_fuera.mp4');
  writeFileSync(victim, 'x');
  assert.throws(() => deleteClip(path.join(mediaDir, '..', 'clip_fuera.mp4')), /fuera de la carpeta/);
  assert.equal(existsSync(victim), true);
});

test('convertOrphanRecording rechaza .ts ajenos o fuera de la carpeta', async () => {
  writeSettings({ recordingsDir: mediaDir });
  await assert.rejects(async () => convertOrphanRecording(path.join(mediaDir, 'otro.ts')), /fuera de la carpeta/);
  await assert.rejects(async () => convertOrphanRecording(path.join(tmpDir, 'grabacion_x.ts')), /fuera de la carpeta/);
});

test('isManagedFile solo acepta los nombres que genera la app', () => {
  assert.equal(isManagedFile('/a/clip_1.mp4', 'clip'), true);
  assert.equal(isManagedFile('/a/clip_1.exe', 'clip'), false);
  assert.equal(isManagedFile('/a/grabacion_1.ts', 'recording'), true);
  assert.equal(isManagedFile('/a/grabacion_1.app', 'recording'), false);
});
