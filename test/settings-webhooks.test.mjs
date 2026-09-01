/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Migración de la versión anterior (un solo discordWebhookUrl/discordMessage) a la
// multi-webhook (discordWebhooks[]/liveMessage) — y el tope de 3 al leer un
// settings.json que alguien pudo haber editado a mano con más. Mismo patrón que
// destinations.test.mjs con MS_CONFIG_DIR temporal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'muxlyve-test-webhooks-'));
process.env.MS_CONFIG_DIR = tmpDir;

const { loadSettings, MAX_DISCORD_WEBHOOKS, MAX_TELEGRAM_BOTS } = await import('../src/settings.js');
const settingsPath = path.join(tmpDir, 'settings.json');

test('discordWebhookUrl viejo (singular) migra a discordWebhooks[]', () => {
  writeFileSync(settingsPath, JSON.stringify({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/a' }));
  const s = loadSettings();
  assert.deepEqual(s.discordWebhooks, [{ url: 'https://discord.com/api/webhooks/1/a', enabled: true }]);
});

test('discordWebhooks viejo (array de strings planos) migra a {url, enabled} con enabled=true', () => {
  writeFileSync(settingsPath, JSON.stringify({ discordWebhooks: ['https://discord.com/api/webhooks/1/a'] }));
  const s = loadSettings();
  assert.deepEqual(s.discordWebhooks, [{ url: 'https://discord.com/api/webhooks/1/a', enabled: true }]);
});

test('discordWebhooks respeta enabled:false ya guardado', () => {
  writeFileSync(settingsPath, JSON.stringify({
    discordWebhooks: [{ url: 'https://discord.com/api/webhooks/1/a', enabled: false }],
  }));
  const s = loadSettings();
  assert.deepEqual(s.discordWebhooks, [{ url: 'https://discord.com/api/webhooks/1/a', enabled: false }]);
});

test('discordMessage viejo migra a liveMessage', () => {
  writeFileSync(settingsPath, JSON.stringify({ discordMessage: 'Hola mundo' }));
  const s = loadSettings();
  assert.equal(s.liveMessage, 'Hola mundo');
});

test('un settings.json con más de 3 webhooks se recorta a 3 al leer', () => {
  writeFileSync(settingsPath, JSON.stringify({
    discordWebhooks: [
      'https://discord.com/api/webhooks/1/a',
      'https://discord.com/api/webhooks/2/b',
      'https://discord.com/api/webhooks/3/c',
      'https://discord.com/api/webhooks/4/d',
    ],
  }));
  const s = loadSettings();
  assert.equal(s.discordWebhooks.length, MAX_DISCORD_WEBHOOKS);
});

test('webhooks inválidos o duplicados se descartan al leer', () => {
  writeFileSync(settingsPath, JSON.stringify({
    discordWebhooks: [
      'https://discord.com/api/webhooks/1/a',
      'https://discord.com/api/webhooks/1/a', // duplicado
      'https://evil.example.com/x', // host inválido
      'no-es-una-url',
    ],
  }));
  const s = loadSettings();
  assert.deepEqual(s.discordWebhooks, [{ url: 'https://discord.com/api/webhooks/1/a', enabled: true }]);
});

test('telegramBots respeta el mismo tope y descarta entradas inválidas', () => {
  const validToken = '123456789:AAHqhK9DsSNGCQnQanCwHzXTVo1TVe0MYCA';
  writeFileSync(settingsPath, JSON.stringify({
    telegramBots: [
      { botToken: validToken, chatId: '1' },
      { botToken: validToken, chatId: '2' },
      { botToken: validToken, chatId: '3' },
      { botToken: validToken, chatId: '4' }, // se pisa por el tope
      { botToken: 'invalido', chatId: '5' }, // formato de token malo
    ],
  }));
  const s = loadSettings();
  assert.equal(s.telegramBots.length, MAX_TELEGRAM_BOTS);
});

test('telegramBots viejo sin campo enabled migra a enabled=true; respeta enabled:false ya guardado', () => {
  const validToken = '123456789:AAHqhK9DsSNGCQnQanCwHzXTVo1TVe0MYCA';
  writeFileSync(settingsPath, JSON.stringify({
    telegramBots: [
      { botToken: validToken, chatId: '1' },
      { botToken: validToken, chatId: '2', enabled: false },
    ],
  }));
  const s = loadSettings();
  assert.equal(s.telegramBots[0].enabled, true);
  assert.equal(s.telegramBots[1].enabled, false);
});

test('sin nada configurado, los arrays arrancan vacíos', () => {
  writeFileSync(settingsPath, JSON.stringify({}));
  const s = loadSettings();
  assert.deepEqual(s.discordWebhooks, []);
  assert.deepEqual(s.telegramBots, []);
  assert.equal(s.liveMessage, null);
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
