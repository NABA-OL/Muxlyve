// Puerta de licencia — PREPARADA PERO DESACTIVADA (Fase A).
//
// En Fase A la app no exige licencia: checkLicense() siempre devuelve unlocked.
// El "modo dueño" ya está cableado para cuando se active la validación real (Fase B):
//   - Build de desarrollo (no empaquetado) -> desbloqueado.
//   - MS_DEV_UNLOCK=1 -> desbloqueado aunque sea build de producción.
// La validación online contra el backend (Freemius/Vercel) se añadirá en Fase B
// en la rama marcada con TODO; hasta entonces NO se bloquea a nadie.

// reason: 'dev' | 'env' | 'fase-A' — de dónde viene el desbloqueo (para logs/UI).
export function checkLicense({ isPackaged } = {}) {
  if (!isPackaged) return { unlocked: true, reason: 'dev' };
  if (process.env.MS_DEV_UNLOCK === '1') return { unlocked: true, reason: 'env' };

  // TODO (Fase B): validar la license key contra el backend y guardar token firmado.
  //   const token = await validateOnline(key, machineId());
  //   return { unlocked: token.valid, reason: 'license' };
  // Por ahora la puerta está DESACTIVADA: Fase A se distribuye sin licencia.
  return { unlocked: true, reason: 'fase-A' };
}
