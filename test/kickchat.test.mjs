/*
 * Propiedad de BlacKraken Solutions <blackraken.com>
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-10-13
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Parseo del chat de Kick tras su migración de Pusher a Centrifugo (2026-10). Los sobres de
// ejemplo tienen la forma real capturada de un canal en vivo (usuarios y textos ficticios).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKickFrames, kickEnvelopeToMessage } from '../src/chat.js';

const chatEvent = (over = {}) => ({
  event: 'App\\Events\\ChatMessageEvent',
  data: JSON.stringify({
    id: 'd0664e98-9d58-4e10-b219-ca08cd1eface',
    chatroom_id: 1202499,
    content: 'hola [emote:37225:KEKLEO] mundo',
    type: 'message',
    sender: { id: 1, username: 'UsuarioPrueba', slug: 'usuarioprueba', identity: { color: '#E9113C', badges: [{ type: 'moderator', text: 'Moderator' }] } },
    ...over,
  }),
});

test('parseKickFrames separa varios comandos en un solo mensaje y descarta basura', () => {
  const frames = parseKickFrames('{"id":1,"connect":{"ping":25}}\n{}\nno es json\n{"push":{"channel":"x"}}\n');
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[1], {}); // el ping del servidor (hay que responderlo con {})
  assert.equal(frames[0].connect.ping, 25);
});

test('un mensaje de chat se convierte al formato unificado (emotes, color, mod)', () => {
  const msg = kickEnvelopeToMessage(chatEvent(), 'otro');
  assert.equal(msg.platform, 'kick');
  assert.equal(msg.username, 'UsuarioPrueba');
  assert.equal(msg.color, '#E9113C');
  assert.equal(msg.isMod, true);
  assert.equal(msg.isBroadcaster, false);
  assert.equal(msg.emotes.length, 1);
  assert.equal(msg.emotes[0].url, 'https://files.kick.com/emotes/37225/fullsize');
  assert.equal(msg.message.slice(msg.emotes[0].start, msg.emotes[0].end), '[emote:37225:KEKLEO]');
});

test('isBroadcaster compara sin distinguir mayúsculas', () => {
  assert.equal(kickEnvelopeToMessage(chatEvent(), 'usuarioPRUEBA').isBroadcaster, true);
});

test('eventos que no son mensajes de chat, o sin texto/usuario, se ignoran', () => {
  assert.equal(kickEnvelopeToMessage({ event: 'App\\Events\\MessageDeletedEvent', data: '{}' }), null);
  assert.equal(kickEnvelopeToMessage(chatEvent({ content: '' })), null);
  assert.equal(kickEnvelopeToMessage(chatEvent({ sender: {} })), null);
  assert.equal(kickEnvelopeToMessage({ event: 'App\\Events\\ChatMessageEvent', data: 'no es json' }), null);
  assert.equal(kickEnvelopeToMessage(undefined), null);
});

test('acepta data ya parseado (objeto) además de string JSON', () => {
  const env = chatEvent();
  assert.equal(kickEnvelopeToMessage({ event: env.event, data: JSON.parse(env.data) }).username, 'UsuarioPrueba');
});
