// Propiedad de BlacKraken Solutions
// Desarrollado por NABA-OL
// discordToTelegramMarkdown() traduce el markdown escrito para Discord (**negrita**,
// *itálica*/_itálica_) a MarkdownV2 de Telegram, que usa sintaxis distinta (un solo
// asterisco es negrita, no itálica) y exige escapar ~14 caracteres reservados en el
// texto plano — ver el comentario largo en src/telegram.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordToTelegramMarkdown } from '../src/telegram.js';

test('negrita de Discord (**x**) pasa a negrita de Telegram (*x*)', () => {
  assert.equal(discordToTelegramMarkdown('**hola**'), '*hola*');
});

test('itálica de Discord con un asterisco pasa a itálica de Telegram (_x_)', () => {
  assert.equal(discordToTelegramMarkdown('*hola*'), '_hola_');
});

test('itálica con guion bajo se mantiene igual (mismo símbolo en los dos formatos)', () => {
  assert.equal(discordToTelegramMarkdown('_hola_'), '_hola_');
});

test('negrita e itálica combinadas en el mismo mensaje', () => {
  assert.equal(
    discordToTelegramMarkdown('**negrita** y *itálica* y _también itálica_ juntas'),
    '*negrita* y _itálica_ y _también itálica_ juntas',
  );
});

test('caracteres reservados de MarkdownV2 en texto plano quedan escapados', () => {
  assert.equal(
    discordToTelegramMarkdown('Sin markdown, solo texto (con paréntesis) y puntos.'),
    'Sin markdown, solo texto \\(con paréntesis\\) y puntos\\.',
  );
});

test('signo de exclamación dentro de la negrita también se escapa', () => {
  assert.equal(discordToTelegramMarkdown('**TAMOS EN VIVO!**'), '*TAMOS EN VIVO\\!*');
});

// Caso real que rompía con el primer approach (placeholder de texto en vez de un solo
// paso con regex.exec): un número suelto rodeado de espacios se confundía con el
// marcador temporal y desaparecía del mensaje.
test('un número suelto en el texto no se confunde con nada interno ni desaparece', () => {
  assert.equal(
    discordToTelegramMarkdown('Arrancamos a las 8 en punto, no falten!'),
    'Arrancamos a las 8 en punto, no falten\\!',
  );
});

test('mensaje sin ningún markdown ni caracteres reservados pasa igual', () => {
  assert.equal(discordToTelegramMarkdown('Hola mundo'), 'Hola mundo');
});

test('mensaje vacío no rompe', () => {
  assert.equal(discordToTelegramMarkdown(''), '');
});
