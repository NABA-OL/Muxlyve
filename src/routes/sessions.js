// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-07-30
// Fase 6 del lote 2 (docs/PLAN_FEATURES_LOTE2.md) — historial de sesiones de transmisión.
// Ver contrato en src/routes/system.js.
import { listSessions } from '../sessions.js';

export async function handle(req, res, url, ctx) {
  const { json } = ctx;

  // GET /api/sessions -> últimas sesiones grabadas (más reciente primero, ver
  // src/sessions.js recordSession). Se guarda un registro por sesión desde
  // src/relays.js onUnpublish() — solo si de verdad se avisó "estoy en vivo".
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    json(res, 200, { sessions: listSessions() });
    return true;
  }

  return false;
}
