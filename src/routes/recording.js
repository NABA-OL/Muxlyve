// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-07-25
// Fase 3 del refactor (docs/PLAN_REFACTOR_PANEL.md) — buffer rodante, grabación completa,
// clips y grabaciones guardadas: /api/record/*, /api/fullrecord/*, /api/clips*,
// /api/recordings*. Ver contrato en src/routes/system.js.
import path from 'node:path';
import {
  isLive, recorderInfo, startRecording, stopRecording, saveClip, listRecentClips, deleteClip,
  fullRecordingInfo, startFullRecording, stopFullRecording, listRecentRecordings, deleteRecording,
  armRecording, armFullRecording, setRecDuration, setClipsDir, setRecordingsDir,
  listOrphanRecordings, convertOrphanRecording, resolveClipsDir, resolveRecordingsDir,
} from '../relays.js';

// Duraciones del buffer rodante: 1/5/10/15 min. Ver src/relays.js — la nota sobre
// tmpdir()/tmpfs en Linux (RAM en vez de disco) aplica sobre todo al tope de 15 min.
const REC_DURATIONS = [60, 300, 600, 900];

export async function handle(req, res, url, ctx) {
  const { json, readBody, t, buildState } = ctx;

  // POST /api/record/start  { duration?: 60|300|600|900 } — sin duration, usa la última
  // configurada (recorderInfo().duration): así un cliente que no conoce la preferencia
  // del usuario (ej. el plugin de Stream Deck) prende el buffer con la misma duración
  // que ya está seleccionada en Preferencias, sin tener que replicar ese ajuste aparte.
  // Sin señal todavía: no rechaza con 409 — "arma" el buffer (queda guardado, server-side,
  // no en el cliente) para que arranque solo apenas OBS conecte (ver onPublish en
  // relays.js). Mismo comportamiento sea el panel o el plugin de Stream Deck quien llame.
  if (req.method === 'POST' && url.pathname === '/api/record/start') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const dur = REC_DURATIONS.includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
    armRecording(true, dur);
    if (isLive()) startRecording(dur);
    json(res, 200, buildState());
    return true;
  }

  // POST /api/record/stop — siempre desarma también (si no, la próxima vez que llegue
  // señal volvería a arrancar solo, aunque el usuario lo haya apagado a propósito).
  if (req.method === 'POST' && url.pathname === '/api/record/stop') {
    stopRecording();
    armRecording(false);
    json(res, 200, buildState());
    return true;
  }

  // POST /api/record/duration  { duration } — persiste SOLO la duración elegida (sin
  // armar ni reiniciar un buffer activo). Se llama apenas cambia la selección en
  // Preferencias, para que quede lista para el próximo arranque automático sin depender
  // de un des/re-armado manual — ver setRecDuration() en relays.js.
  if (req.method === 'POST' && url.pathname === '/api/record/duration') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!REC_DURATIONS.includes(Number(input.duration))) { json(res, 400, { error: 'Duración inválida.' }); return true; }
    setRecDuration(Number(input.duration));
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/record/save  { duration?: 60|300|600|900, outputDir?: string } — sin duration,
  // usa la del buffer activo (recorderInfo().duration), mismo criterio que /api/record/start.
  if (req.method === 'POST' && url.pathname === '/api/record/save') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    const dur = REC_DURATIONS.includes(Number(input.duration)) ? Number(input.duration) : recorderInfo().duration;
    const outputDir = typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : null;
    // Log SIEMPRE (no gateado por ALLOW_LAN_PANEL como debugLog): a diferencia de
    // /api/state (poll cada 2s), esto solo dispara con un click explícito de "guardar
    // clip" — sirve para diagnosticar desde la consola si la request del Stream Deck
    // realmente llega, con qué body, y qué resultado da, sin depender de tener LAN
    // habilitada ni de que la ruta esté en DEBUG_LOG_ROUTES.
    console.log(`[record/save] request desde ${req.socket.remoteAddress} — duration=${input.duration ?? '(no enviado, usa ' + dur + ')'} outputDir=${outputDir ?? '(default)'}`);
    try {
      const filePath = await saveClip(dur, outputDir);
      console.log(`[record/save] OK — ${filePath}`);
      json(res, 200, { ok: true, path: filePath });
    } catch (err) {
      console.error(`[record/save] FALLÓ — ${err.message}`);
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/fullrecord/start  { outputDir? } — grabación completa (archivo único con
  // toda la transmisión), independiente del buffer rodante de arriba. Ver relays.js.
  // Mismo criterio que /api/record/start: sin señal, queda "armada" en vez de rechazar.
  if (req.method === 'POST' && url.pathname === '/api/fullrecord/start') {
    let input;
    try { input = await readBody(req); } catch { input = {}; }
    const outputDir = typeof input.outputDir === 'string' && input.outputDir.trim() ? input.outputDir.trim() : null;
    armFullRecording(true);
    if (isLive()) startFullRecording(outputDir);
    json(res, 200, buildState());
    return true;
  }

  // POST /api/fullrecord/stop
  if (req.method === 'POST' && url.pathname === '/api/fullrecord/stop') {
    stopFullRecording();
    armFullRecording(false);
    json(res, 200, buildState());
    return true;
  }

  // GET /api/clips?dir=  → últimos clips guardados en el folder configurado (o el
  // default si no hay uno elegido) — mismo folder que usa /api/record/save.
  if (req.method === 'GET' && url.pathname === '/api/clips') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files, total } = listRecentClips(outputDir);
      json(res, 200, { dir, files, total });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // DELETE /api/clips  { path, outputDir? } — borra un clip guardado. deleteClip()
  // valida que el path esté DENTRO de la carpeta de clips antes de borrar.
  if (req.method === 'DELETE' && url.pathname === '/api/clips') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!input.path) { json(res, 400, { error: t('Falta el parámetro path.') }); return true; }
    try {
      deleteClip(input.path, input.outputDir || null);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/clips/set-dir  { dir } — persiste la carpeta de destino de clips
  // (settings.json, ver setClipsDir en relays.js). Antes esto solo vivía en localStorage
  // del panel — el plugin de Stream Deck no tiene acceso a eso, así que sus saves
  // siempre caían en la carpeta default aunque el usuario hubiera elegido otra acá.
  if (req.method === 'POST' && url.pathname === '/api/clips/set-dir') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    setClipsDir(typeof input.dir === 'string' ? input.dir : null);
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/recordings?dir=  → últimas grabaciones completas (.mp4 ya remuxeadas),
  // mismo criterio que /api/clips pero apuntando a resolveRecordingsDir().
  if (req.method === 'GET' && url.pathname === '/api/recordings') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files, total } = listRecentRecordings(outputDir);
      json(res, 200, { dir, files, total });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // DELETE /api/recordings  { path, outputDir? } — borra una grabación completa. Mismo
  // guard de seguridad que DELETE /api/clips (path debe estar dentro del folder).
  if (req.method === 'DELETE' && url.pathname === '/api/recordings') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!input.path) { json(res, 400, { error: t('Falta el parámetro path.') }); return true; }
    try {
      deleteRecording(input.path, input.outputDir || null);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/recordings/set-dir  { dir } — mismo criterio que /api/clips/set-dir.
  if (req.method === 'POST' && url.pathname === '/api/recordings/set-dir') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    setRecordingsDir(typeof input.dir === 'string' ? input.dir : null);
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/recordings/orphans?dir=  → .ts que quedaron sin remuxear a .mp4 (crash,
  // cierre forzado de la app, o falla del remux automático). Ver listOrphanRecordings().
  if (req.method === 'GET' && url.pathname === '/api/recordings/orphans') {
    const outputDir = url.searchParams.get('dir') || null;
    try {
      const { dir, files } = listOrphanRecordings(outputDir);
      json(res, 200, { dir, files });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/recordings/convert  { path, outputDir? } — remuxea un .ts huérfano a .mp4
  // a pedido del usuario. Mismo guard de seguridad que DELETE /api/recordings.
  if (req.method === 'POST' && url.pathname === '/api/recordings/convert') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!input.path) { json(res, 400, { error: t('Falta el parámetro path.') }); return true; }
    try {
      const mp4Path = await convertOrphanRecording(input.path, input.outputDir || null);
      json(res, 200, { ok: true, path: mp4Path });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/clips/open  { path, reveal? }  → abre una carpeta, o revela un archivo
  // puntual en el explorador nativo (solo Electron).
  // CN-003: a diferencia de deleteClip/deleteRecording/convertOrphanRecording, este era
  // el único endpoint de archivos sin containment check — shell.openPath() en un path
  // arbitrario ABRE (y para un ejecutable, corre) lo que sea. Acepta: la carpeta de clips
  // o grabaciones exacta (para "abrir carpeta"), o un archivo DENTRO de alguna de las dos
  // (para "revelar clip puntual") — nada fuera de esas dos carpetas.
  if (req.method === 'POST' && url.pathname === '/api/clips/open') {
    let input;
    try { input = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return true; }
    if (!input.path) { json(res, 400, { error: 'Falta path.' }); return true; }
    const resolved = path.resolve(input.path);
    const clipsDir = path.resolve(resolveClipsDir(input.outputDir));
    const recordingsDir = path.resolve(resolveRecordingsDir(input.outputDir));
    const isAllowedDir = resolved === clipsDir || resolved === recordingsDir;
    const isAllowedFile = path.dirname(resolved) === clipsDir || path.dirname(resolved) === recordingsDir;
    if (!isAllowedDir && !isAllowedFile) {
      json(res, 400, { error: t('Ruta fuera de la carpeta de clips.') });
      return true;
    }
    try {
      const { shell } = await import('electron');
      if (input.reveal) {
        shell.showItemInFolder(resolved);
      } else {
        const err = await shell.openPath(resolved);
        if (err) { json(res, 500, { error: err }); return true; }
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 501, { error: t('Selector solo disponible en la app de escritorio.') });
    }
    return true;
  }

  return false;
}
