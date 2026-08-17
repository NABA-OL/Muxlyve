/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// isValidDiscordWebhook() es el gate anti-SSRF antes de que src/notify.js llame a
// cualquier URL pegada por el usuario — ver el comentario en src/notify.js.
// isValidTelegramBot() es el equivalente para src/telegram.js — ahí el host es fijo
// (api.telegram.org, no hay SSRF por esa vía), lo que se valida es la FORMA del token y
// que haya chat ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDiscordWebhook, isValidTelegramBot } from '../src/settings.js';

test('webhook real de Discord es válido', () => {
  assert.equal(isValidDiscordWebhook('https://discord.com/api/webhooks/123/abcXYZ'), true);
});

test('dominio legado discordapp.com también es válido', () => {
  assert.equal(isValidDiscordWebhook('https://discordapp.com/api/webhooks/123/abcXYZ'), true);
});

test('http (no https) se rechaza', () => {
  assert.equal(isValidDiscordWebhook('http://discord.com/api/webhooks/123/abcXYZ'), false);
});

test('otro host se rechaza (SSRF)', () => {
  assert.equal(isValidDiscordWebhook('https://evil.example.com/api/webhooks/123/abcXYZ'), false);
});

test('subdominio disfrazado se rechaza', () => {
  assert.equal(isValidDiscordWebhook('https://discord.com.evil.example.com/x'), false);
});

test('esquema javascript: se rechaza', () => {
  assert.equal(isValidDiscordWebhook('javascript:alert(1)'), false);
});

test('vacío o no-string se rechaza', () => {
  assert.equal(isValidDiscordWebhook(''), false);
  assert.equal(isValidDiscordWebhook(null), false);
  assert.equal(isValidDiscordWebhook(undefined), false);
});

test('URL malformada no rompe, se rechaza', () => {
  assert.equal(isValidDiscordWebhook('no-es-una-url'), false);
});

const VALID_TOKEN = '123456789:AAHqhK9DsSNGCQnQanCwHzXTVo1TVe0MYCA'; // forma real, no un token de verdad

test('bot de Telegram con token y chatId válidos pasa', () => {
  assert.equal(isValidTelegramBot({ botToken: VALID_TOKEN, chatId: '-1001234567890' }), true);
});

test('chatId con formato @usuario también es válido', () => {
  assert.equal(isValidTelegramBot({ botToken: VALID_TOKEN, chatId: '@mi_canal' }), true);
});

test('token sin el bot_id numérico antes de los dos puntos se rechaza', () => {
  assert.equal(isValidTelegramBot({ botToken: 'AAHqhK9DsSNGCQnQanCwHzXTVo1TVe0MYCA', chatId: '123' }), false);
});

test('token demasiado corto se rechaza', () => {
  assert.equal(isValidTelegramBot({ botToken: '123456789:corto', chatId: '123' }), false);
});

test('chatId vacío se rechaza aunque el token sea válido', () => {
  assert.equal(isValidTelegramBot({ botToken: VALID_TOKEN, chatId: '' }), false);
});

test('bot nulo/vacío/sin campos se rechaza sin romper', () => {
  assert.equal(isValidTelegramBot(null), false);
  assert.equal(isValidTelegramBot({}), false);
  assert.equal(isValidTelegramBot(undefined), false);
});
