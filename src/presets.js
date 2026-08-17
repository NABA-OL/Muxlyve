/*
 * Propiedad de BlacKraken Solutions
 * Desarrollado por: NABAOL
 * Fecha de creación: 2026-07-01
 * Correo: nabaol.dev@gmail.com
 * Copyright (c) 2026 BlacKraken Solutions. Todos los derechos reservados.
 */
// Perfiles de destinos — combinaciones guardadas de "qué destinos van habilitados" (ej.
// "Solo Twitch", "Todo", "Prueba"), para no tener que prender/apagar destino por destino
// antes de cada stream. Se guardan por NOMBRE de destino, no por índice: los destinos se
// pueden borrar y reordenar, un índice guardado apuntaría a otra cosa después — un nombre
// que ya no existe simplemente se ignora al aplicar, sin código extra.
import { loadSettings, saveSettings } from './settings.js';

// Mismo tope que valida settings.js al leer destinationPresets — acá se expone aparte
// para que savePreset() pueda rechazar con un mensaje claro ANTES de guardar (settings.js
// solo recorta en silencio si algo se coló con más, ej. un archivo editado a mano).
export const MAX_PRESETS = 6;

export function listPresets() {
  return loadSettings().destinationPresets;
}

// Título/categoría opcionales de un perfil: mismo tope de 140 caracteres que exige
// Twitch para el título del stream (no hay un límite propio que respetar acá, es
// puramente defensivo — nunca se validó esto ni siquiera en el flujo normal de
// "Modificar información del stream", ver applyStreamTitle() en panel-client.js).
const MAX_STREAM_INFO_LEN = 140;
function validStreamInfoField(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_STREAM_INFO_LEN) : null;
}

// Guarda el estado ENABLED actual de `destinations` bajo `name`, más opcionalmente el
// título/categoría del stream (streamInfo = { title, category }) — así aplicar el perfil
// no solo prende/apaga destinos, también deja el título y la categoría como estaban al
// guardarlo. Retrocompatible: perfiles guardados antes de esto simplemente no tienen esos
// dos campos (quedan null), y savePreset() sin tercer argumento se comporta igual que
// siempre. Si el nombre ya existía, lo actualiza en el mismo lugar (no lo manda al final
// de la lista). Si es nuevo y ya se llegó al tope, rechaza con un error claro — mejor eso
// que descartar en silencio el perfil más viejo sin que el streamer se entere.
export function savePreset(name, destinations, streamInfo = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('El nombre del perfil es obligatorio.');
  const enabled = destinations.filter((d) => d.enabled).map((d) => d.name);
  const title = validStreamInfoField(streamInfo.title);
  const category = validStreamInfoField(streamInfo.category);
  const existing = loadSettings().destinationPresets;
  const idx = existing.findIndex((p) => p.name === trimmed);
  if (idx < 0 && existing.length >= MAX_PRESETS) {
    throw new Error(`Máximo ${MAX_PRESETS} perfiles — borrá uno para guardar otro.`);
  }
  const entry = { name: trimmed, enabled, title, category };
  const next = idx >= 0
    ? existing.map((p, i) => (i === idx ? entry : p))
    : [...existing, entry];
  saveSettings({ destinationPresets: next });
  return next;
}

export function deletePreset(name) {
  const next = loadSettings().destinationPresets.filter((p) => p.name !== name);
  saveSettings({ destinationPresets: next });
  return next;
}

// Función pura: recibe destinos + preset, devuelve un array NUEVO con el enabled
// correcto — no muta el input. Un destino en preset.enabled queda true, cualquier otro
// (incluido uno que el preset ya no menciona) queda false. Este es el "apply" que ya usa
// el panel (chip -> aplica) — intercambio total, mutuamente excluyente entre perfiles.
export function applyPresetToDestinations(destinations, preset) {
  if (!preset) return destinations;
  const wanted = new Set(preset.enabled);
  return destinations.map((d) => ({ ...d, enabled: wanted.has(d.name) }));
}

// Complemento de applyPresetToDestinations pensado para el botón de Stream Deck (ver
// docs/STREAMDECK_PLUGIN.md, acción "Perfil"): "desactivar" un perfil NO es lo mismo que
// aplicar otro — solo apaga los destinos QUE ESE PERFIL prende, sin tocar el resto. Así
// un botón físico puede alternar "activar/desactivar ESTE perfil" sin pisar destinos que
// el usuario haya prendido a mano por su cuenta.
export function deactivatePresetInDestinations(destinations, preset) {
  if (!preset) return destinations;
  const toDisable = new Set(preset.enabled);
  return destinations.map((d) => (toDisable.has(d.name) ? { ...d, enabled: false } : d));
}

// Heurística de "¿está este perfil activo ahora mismo?" — usada tanto por el panel (si
// hiciera falta) como documentada para el plugin: activo si TODOS los destinos que el
// perfil prende Y QUE TODAVÍA EXISTEN están hoy con enabled=true. No exige que el resto
// esté apagado (un perfil parcialmente solapado con otro igual cuenta como activo) —
// mismo criterio simple que necesita un botón físico con un solo estado ON/OFF.
//
// Ignorar los nombres borrados es a propósito: applyPresetToDestinations() también los
// ignora al aplicar (ver su comentario) — si activo exigiera el destino borrado, un
// perfil con una referencia vieja quedaría "inactivo" PARA SIEMPRE aunque el resto de
// sus destinos estén perfectamente prendidos tal cual el perfil los dejó. Reproducido y
// confirmado con un caso real: perfil Twitch+Kick+YouTube, se borra YouTube, se aplica
// el perfil → Twitch y Kick quedan enabled=true pero antes de este fix isPresetActive()
// igual devolvía false.
export function isPresetActive(destinations, preset) {
  if (!preset || !preset.enabled.length) return false;
  const byName = new Map(destinations.map((d) => [d.name, d]));
  const stillExist = preset.enabled.filter((name) => byName.has(name));
  if (!stillExist.length) return false; // el perfil entero apuntaba a destinos borrados
  return stillExist.every((name) => byName.get(name).enabled === true);
}
