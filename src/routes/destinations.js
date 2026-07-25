// Desarrollado por BlacKraken Solutions (NABA-OL)
// Fase 3 del refactor (docs/PLAN_REFACTOR_PANEL.md) — destinos RTMP y perfiles (presets):
// /api/destinations, /api/retry, /api/presets*. Ver contrato en src/routes/system.js.
import { loadAll, saveAll, isValidUrl } from '../destinations.js';
import { applyChange, stopByName, retry } from '../relays.js';
import { listPresets, savePreset, deletePreset, applyPresetToDestinations, deactivatePresetInDestinations, isPresetActive } from '../presets.js';

const MAX_NAME = 40;
const MAX_URL = 500;

// Valida la entrada del panel en el límite de confianza antes de tocar el archivo o ffmpeg.
function validateDestination(input, t) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const enabled = Boolean(input.enabled);
  if (!name) return { error: t('El nombre es obligatorio.') };
  if (name.length > MAX_NAME) return { error: t('Nombre máximo ') + MAX_NAME + t(' caracteres.') };
  if (url.length > MAX_URL) return { error: t('URL máxima ') + MAX_URL + t(' caracteres.') };
  // Solo exigimos URL válida si se quiere habilitar (TikTok puede quedar deshabilitado con placeholder).
  if (enabled && !isValidUrl(url)) {
    return { error: t('Para activar, la URL debe empezar por rtmp://, rtmps:// o srt:// y no ser un placeholder.') };
  }
  // Bitrate máximo opcional — vacío/0/inválido = sin cap, el destino sigue en -c copy
  // (ver relays.js). No se valida un rango: si el usuario pone algo absurdo, el propio
  // FFmpeg lo va a rechazar o el resultado se va a ver mal, no rompe nada de la app.
  const maxBitrateRaw = Number(input.maxBitrate);
  const maxBitrate = Number.isFinite(maxBitrateRaw) && maxBitrateRaw > 0 ? Math.round(maxBitrateRaw) : null;
  return { dest: { name, url, enabled, maxBitrate } };
}

export async function handle(req, res, url, ctx) {
  const { json, readBody, t, buildState, debugLog } = ctx;

  // GET /api/presets -> perfiles guardados + si cada uno está activo AHORA MISMO (todos
  // sus destinos con enabled=true, ver isPresetActive en presets.js). El campo `active`
  // viaja calculado desde acá para que un consumidor externo (plugin de Stream Deck, ver
  // docs/STREAMDECK_PLUGIN.md) no tenga que pedir /api/state aparte solo para saber en
  // qué estado pintar su botón.
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    const destinations = loadAll();
    const presets = listPresets().map((p) => ({ ...p, active: isPresetActive(destinations, p) }));
    json(res, 200, { presets });
    return true;
  }

  // POST /api/presets  { name } -> guarda el estado enabled ACTUAL de todos los destinos
  // bajo ese nombre. Si el nombre ya existe, lo pisa.
  if (req.method === 'POST' && url.pathname === '/api/presets') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    try {
      json(res, 200, { presets: savePreset(input.name, loadAll()) });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return true;
  }

  // POST /api/presets/apply  { name } -> aplica: cada destino queda enabled según esté o
  // no en el preset. Mismo camino que el toggle por destino (saveAll + applyChange), para
  // no duplicar la lógica de arranque/parada de relays.
  if (req.method === 'POST' && url.pathname === '/api/presets/apply') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const preset = listPresets().find((p) => p.name === input.name);
    if (!preset) { json(res, 404, { error: t('Perfil no encontrado.') }); return true; }
    const next = applyPresetToDestinations(loadAll(), preset);
    saveAll(next);
    next.forEach(applyChange);
    json(res, 200, buildState());
    return true;
  }

  // POST /api/presets/deactivate  { name } -> apaga SOLO los destinos que ese perfil
  // prende, sin tocar el resto (a diferencia de /apply, que es un intercambio total).
  // Pensado para el botón de "Perfil" del plugin de Stream Deck — un botón físico con un
  // solo estado ON/OFF necesita un "apagar esto puntual" que no pise otros destinos que
  // el usuario haya prendido a mano. Ver docs/STREAMDECK_PLUGIN.md.
  if (req.method === 'POST' && url.pathname === '/api/presets/deactivate') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const preset = listPresets().find((p) => p.name === input.name);
    if (!preset) { json(res, 404, { error: t('Perfil no encontrado.') }); return true; }
    const next = deactivatePresetInDestinations(loadAll(), preset);
    saveAll(next);
    next.forEach(applyChange);
    json(res, 200, buildState());
    return true;
  }

  // DELETE /api/presets?name=X -> borra un perfil guardado.
  if (req.method === 'DELETE' && url.pathname === '/api/presets') {
    const name = url.searchParams.get('name');
    if (!name) { json(res, 400, { error: t('Falta el parámetro name.') }); return true; }
    json(res, 200, { presets: deletePreset(name) });
    return true;
  }

  // POST /api/destinations  -> upsert por nombre (crear, editar URL, toggle ON/OFF, clave TikTok)
  if (req.method === 'POST' && url.pathname === '/api/destinations') {
    let input;
    try { input = await readBody(req); }
    catch (err) {
      debugLog('error', `POST /api/destinations -> 400 leyendo el body: ${err.message}`);
      json(res, 400, { error: err.message });
      return true;
    }
    debugLog('log', `POST /api/destinations body recibido: ${JSON.stringify(input)}`);
    const { error, dest } = validateDestination(input, t);
    if (error) {
      debugLog('error', `POST /api/destinations -> 400 validateDestination: ${error}`);
      json(res, 400, { error });
      return true;
    }

    const list = loadAll();
    const idx = list.findIndex((d) => d.name === dest.name);
    const next = idx >= 0
      ? list.map((d, i) => (i === idx ? { ...d, url: dest.url, enabled: dest.enabled, maxBitrate: dest.maxBitrate } : d))
      : [...list, dest];
    saveAll(next);
    applyChange(dest); // arranca/para el relay en caliente si hay emisión
    debugLog('log', `POST /api/destinations -> 200, "${dest.name}" enabled=${dest.enabled}`);
    json(res, 200, buildState());
    return true;
  }

  // POST /api/retry?name=X  -> reintento manual de un destino 'failed'
  if (req.method === 'POST' && url.pathname === '/api/retry') {
    const name = url.searchParams.get('name');
    const dest = loadAll().find((d) => d.name === name);
    if (!dest) { json(res, 404, { error: t('Destino no encontrado.') }); return true; }
    retry(dest);
    json(res, 200, buildState());
    return true;
  }

  // DELETE /api/destinations?name=X
  if (req.method === 'DELETE' && url.pathname === '/api/destinations') {
    const name = url.searchParams.get('name');
    if (!name) { json(res, 400, { error: t('Falta el parámetro name.') }); return true; }
    stopByName(name);
    saveAll(loadAll().filter((d) => d.name !== name));
    json(res, 200, buildState());
    return true;
  }

  return false;
}
