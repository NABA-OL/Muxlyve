# Muxlyve — Fase B: licencia con Freemius

Activación y validación de licencia en la app de escritorio usando **Freemius** como pasarela (pago único, licencia flexible 1–2 equipos). Requiere que ya esté hecha la Fase A (app Electron empaquetada).

## Qué pone Freemius y qué ponemos nosotros

| Lo pone Freemius | Lo ponemos nosotros (en la app) |
|---|---|
| Checkout, cobro, impuestos (MoR) | Pantalla de activación (pegar la key) |
| Generación de la license key | Llamar a su API para activar/validar |
| Activaciones por equipo (límite flexible) | Guardar el estado de licencia local (cifrado) |
| Envío de la key por correo | Modo dueño (desbloqueo sin key) |
| Desactivar/transferir equipo | Botón "desactivar este equipo" |

> Con Freemius **no necesitas montar el backend de licencias** (ni el Vercel+Mongo es obligatorio). La app habla directo con la API REST de Freemius.

## Datos que necesitas de tu cuenta Freemius

Antes de implementar, saca del panel de Freemius:
- `product_id` (ID del producto/plugin/app)
- `public_key` (clave pública del SDK)
- `secret_key` (⚠ solo para uso en servidor/build, nunca embebida en cliente público sin cuidado)
- El esquema de licencias configurado (pago único, nº de activaciones permitidas = 1 o 2).

## Flujo de activación en la app

```
1. App abre → ¿hay licencia válida guardada localmente?
      sí → desbloqueada.
      no → muestra pantalla "Activar licencia".
2. Usuario pega la key recibida por correo.
3. App llama a Freemius: activar licencia para este equipo
      (envía key + un "install"/machine id).
4. Freemius responde:
      OK   → guarda token/licencia local (cifrado) → desbloquea.
      límite de equipos alcanzado → mensaje claro + opción de
            liberar otro equipo desde la web/cuenta.
      inválida/expirada → mensaje de error.
5. Revalidación periódica suave al abrir (con amplio margen offline).
```

## Puerta de licencia (con modo dueño)

La función central que decide si la app está desbloqueada:

```js
// electron/license.js  (pseudocódigo)
export async function isUnlocked() {
  // 1) Modo dueño: desarrollo o variable de entorno
  if (!app.isPackaged) return true;             // build de desarrollo
  if (process.env.MS_DEV_UNLOCK === '1') return true;

  // 2) Licencia local válida ya guardada
  const local = readLocalLicense();             // cifrada en disco
  if (local && isStillValid(local)) return true;

  // 3) Sin licencia → bloqueado (muestra pantalla de activación)
  return false;
}

export async function activate(key) {
  const machineId = getMachineId();             // huella estable del equipo
  const res = await freemiusActivate({ key, machineId }); // API REST Freemius
  if (res.ok) { saveLocalLicense(res.license); return { ok: true }; }
  return { ok: false, reason: res.reason };     // 'device_limit' | 'invalid' | ...
}
```

Notas:
- `getMachineId`: usar algo estable (p. ej. paquete `node-machine-id`) — no la MAC pura.
- `saveLocalLicense`: cifrar con la misma idea que las credenciales de stream (AES-256-GCM).
- La "llave de dueño" se logra creando en Freemius una licencia tuya marcada con activaciones altas/ilimitadas; se activa como cualquier cliente pero nunca se agota.

## Integración con el motor existente

- La puerta NO debe impedir que el motor arranque para nada interno; debe bloquear la **funcionalidad de reenvío** (que `onPublish` no inicie relays si `!isUnlocked()`), y la ventana muestra la pantalla de activación.
- En modo dueño / con licencia, todo funciona igual que hoy.

## UI mínima de licencia

- Pantalla de activación: campo para la key, botón "Activar", mensajes de error claros.
- En ajustes: estado de la licencia, equipo actual, botón "Desactivar este equipo" (libera el cupo vía Freemius), enlace a "gestionar mi licencia".
- Mensaje especial para `device_limit`: "Esta licencia ya está activa en el máximo de equipos. Libera uno desde tu cuenta para usarla aquí."

## Variables nuevas (.env / build)

```env
FREEMIUS_PRODUCT_ID=
FREEMIUS_PUBLIC_KEY=
# La secret key NO se embebe en el cliente público; úsala solo si haces
# validación server-side (opcional, vía tu Vercel).
MS_DEV_UNLOCK=     # 1 para desbloquear en tus pruebas
```

## Seguridad realista

- Ofuscar/minificar el bundle del cliente (sube el costo de crackear).
- No confiar solo en una validación local booleana fácilmente parcheable: combinar verificación con Freemius + token firmado guardado.
- Aceptar que ningún DRM local es perfecto: objetivo = "más fácil pagar que crackear".

---

## Prompt para Code (Fase B)

> Lee `docs/FASE_B_LICENCIA.md` y `docs/DESKTOP_APP.md`. Implementa la **Fase B**: integración de licencia con Freemius en la app Electron.
>
> 1. Crea `electron/license.js` con `isUnlocked()`, `activate(key)` y `deactivate()` usando la **API REST de Freemius** (product id y public key vendrán de variables de entorno: `FREEMIUS_PRODUCT_ID`, `FREEMIUS_PUBLIC_KEY`). Usa `node-machine-id` para el machine id.
> 2. Implementa el **modo dueño**: `isUnlocked()` devuelve true si `!app.isPackaged` o si `process.env.MS_DEV_UNLOCK === '1'`, antes de consultar nada.
> 3. Guarda la licencia localmente **cifrada** (reusa el enfoque AES-256-GCM ya usado para las credenciales de stream).
> 4. En el arranque (`electron/main.js`): si no está desbloqueada, muestra una **pantalla de activación** (pegar key → activar → desbloquear). Si está desbloqueada, carga el panel normal.
> 5. Conecta la puerta al motor: que `onPublish` no inicie relays si `!isUnlocked()`.
> 6. Añade en ajustes el estado de licencia y un botón "Desactivar este equipo".
> 7. Maneja el error `device_limit` con un mensaje claro.
>
> No toques la lógica de reenvío ni reconexión. Mantén el estilo ESM actual.

> ⚠ Antes de correr esto necesito tener en `.env`: `FREEMIUS_PRODUCT_ID` y `FREEMIUS_PUBLIC_KEY` (de mi cuenta Freemius), y haber creado el producto con licencia de pago único y 1–2 activaciones por equipo.
