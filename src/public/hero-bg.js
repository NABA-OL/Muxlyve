// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-08-07
//
// Fondo "prisma" — puerto vanilla (sin React) del shader que usa el hero de la web
// (muxlyve-web, src/components/HeroFlowBG.tsx). Mismo shader, mismos colores de marca.
// Lo usan dos vistas con dos formas de cargar MUY distintas: el modal Acerca de
// (panel-client.js) lo pide con import() dinámico servido por HTTP (/hero-bg.js), y el
// splash (electron/splash.html) lo carga directo por file:// — una ruta absoluta tipo
// "/three.module.min.js" resolvería a la RAÍZ DEL DISCO en ese segundo caso, mal. Por
// eso la ruta de acá abajo se resuelve relativa a este propio archivo (import.meta.url,
// funciona igual en los dos contextos) en vez de hardcodear "/three.module.min.js".
const THREE = await import(new URL('./three.module.min.js', import.meta.url).href);

const VERTEX = `
  attribute vec3 position;
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAGMENT = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;
  uniform float xScale;
  uniform float yScale;
  uniform float distortion;
  uniform float yOffset;
  uniform float fadeStart;
  uniform float fadeEnd;
  uniform vec3 colorTwitch;
  uniform vec3 colorKick;
  uniform vec3 colorYoutube;
  uniform vec3 colorTiktok;

  void main() {
    vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);
    // El centro de la onda es donde p.y (vertical, 0 = medio del canvas) se acerca a
    // 0 — por eso el brillo siempre queda a media altura sin importar qué tan alto sea
    // el canvas. yOffset corre ese centro hacia abajo (positivo) o arriba (negativo) DEL
    // MISMO cálculo — nada de recortar ni enmascarar el canvas por fuera, es continuo de
    // punta a punta, no puede quedar una línea de corte porque no hay corte.
    p.y -= yOffset;

    float d = length(p) * distortion;

    float x1 = p.x * (1.0 + d * 2.4);
    float x2 = p.x * (1.0 + d * 0.8);
    float x3 = p.x * (1.0 - d * 0.8);
    float x4 = p.x * (1.0 - d * 2.4);

    float i1 = 0.045 / abs(p.y + sin((x1 + time) * xScale) * yScale);
    float i2 = 0.045 / abs(p.y + sin((x2 + time) * xScale) * yScale);
    float i3 = 0.045 / abs(p.y + sin((x3 + time) * xScale) * yScale);
    float i4 = 0.045 / abs(p.y + sin((x4 + time) * xScale) * yScale);

    vec3 col = colorTwitch * i1 + colorKick * i2 + colorYoutube * i3 + colorTiktok * i4;

    // yOffset mueve DÓNDE está el centro de la onda, pero 1/abs(x) cae muy rápido apenas
    // te alejás de ese centro — en una ventana angosta y alta como el splash, la mayor
    // parte del canvas queda tan lejos del centro que la intensidad es prácticamente 0,
    // y esa zona "apagada" se ve como un borde definido aunque matemáticamente sea
    // continuo (cae rápido, no que se corte). Esto es aparte: un fundido explícito y
    // MUCHO más gradual, controlado a mano — no depende de la forma de la curva de la
    // onda. fadeStart/fadeEnd en fracción de pantalla (0 abajo, 1 arriba, mismo sistema
    // que gl_FragCoord). Default (ambos > 1) = sin fundido, para no tocar el modal
    // Acerca de que no lo necesita.
    float screenY = gl_FragCoord.y / resolution.y;
    float fade = 1.0 - smoothstep(fadeStart, fadeEnd, screenY);
    col *= fade;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Colores de marca en 0-1 (mismos que --twitch/--kick/--youtube/--tiktok del sitio web)
const COLOR_TWITCH = new THREE.Vector3(0.569, 0.275, 1.0); // #9146ff
const COLOR_KICK = new THREE.Vector3(0.325, 0.988, 0.094); // #53fc18
const COLOR_YOUTUBE = new THREE.Vector3(1.0, 0.0, 0.0); // #ff0000
const COLOR_TIKTOK = new THREE.Vector3(0.145, 0.957, 0.933); // #25f4ee

/**
 * Monta el shader del prisma sobre un <canvas>.
 * @param {HTMLCanvasElement} canvas
 * @param {{ reducedMotion?: boolean, yOffset?: number, fadeStart?: number, fadeEnd?: number }} [options]
 *   yOffset corre el centro de la onda hacia abajo (positivo) en unidades normalizadas
 *   (0 = medio del canvas). fadeStart/fadeEnd: fundido vertical EXPLÍCITO, en fracción
 *   de pantalla (0 = abajo del todo, 1 = arriba del todo) — completamente visible por
 *   debajo de fadeStart, completamente invisible por encima de fadeEnd, transición suave
 *   entre los dos. Sin esto (default) no hay fundido — el modal Acerca de no lo necesita,
 *   el splash sí (ver electron/splash.html) para que la parte de arriba del canvas se
 *   apague del todo sin que la caída natural de la onda se sienta como un borde.
 * @returns {() => void} función de limpieza — llamarla al cerrar el modal para liberar
 *   el contexto WebGL (evita fugas si el modal se abre/cierra varias veces).
 */
export function initHeroBG(canvas, options = {}) {
  const parent = canvas.parentElement;
  if (!parent) return () => {};

  const reduceMotion =
    options.reducedMotion ??
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  } catch {
    return () => {};
  }
  // Sin esto, three.js interpreta y transforma los hex por su propia gestión de color
  // (sRGB) — 0x0d1117 acá termina como un píxel LIGERAMENTE distinto del mismo hex
  // puesto plano en CSS (que no pasa por ninguna transformación). La diferencia es sutil
  // pero justo ahí es donde se veía la línea residual entre el canvas y el fondo de la
  // ventana. Apagar ColorManagement global (no solo en el renderer) hace que el
  // Color(0x0d1117) de acá abajo y el "background:#0d1117" del CSS sean el mismo píxel
  // exacto, sin transformar ninguno de los dos.
  THREE.ColorManagement.enabled = false;
  renderer.setClearColor(new THREE.Color(0x0d1117));

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

  const uniforms = {
    resolution: { value: [1, 1] },
    time: { value: 0 },
    xScale: { value: 1.0 },
    yScale: { value: 0.5 },
    distortion: { value: 0.4 },
    yOffset: { value: options.yOffset ?? 0 },
    fadeStart: { value: options.fadeStart ?? 1.1 },
    fadeEnd: { value: options.fadeEnd ?? 1.2 },
    colorTwitch: { value: COLOR_TWITCH },
    colorKick: { value: COLOR_KICK },
    colorYoutube: { value: COLOR_YOUTUBE },
    colorTiktok: { value: COLOR_TIKTOK },
  };

  const position = new Float32Array([
    -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));

  const material = new THREE.RawShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  let frameId = 0;
  let lastTimestamp = null;
  // 0.006/frame a 60fps ≈ 0.36 unidades por segundo real — mismo ritmo en
  // cualquier pantalla, en vez de depender de cuántas veces dispare
  // requestAnimationFrame (120Hz+ corre el shader al doble de velocidad)
  const TIME_UNITS_PER_SECOND = 0.36;

  const resize = () => {
    const { width, height } = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    uniforms.resolution.value = [width * dpr, height * dpr];
    renderer.render(scene, camera);
  };

  const animate = (timestamp) => {
    const deltaSeconds = lastTimestamp === null ? 0 : (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;
    uniforms.time.value += deltaSeconds * TIME_UNITS_PER_SECOND;
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(animate);
  };

  resize();
  if (!reduceMotion) frameId = requestAnimationFrame(animate);

  const observer = new ResizeObserver(resize);
  observer.observe(parent);

  return function cleanup() {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  };
}