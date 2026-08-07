// Desarrollado por "BlacKraken Solutions"
// Correo: nabaol.dev@gmail.com
// Fecha: 2026-08-07
//
// Fondo "prisma" del modal Acerca de — puerto vanilla (sin React) del shader que usa el
// hero de la web (muxlyve-web, src/components/HeroFlowBG.tsx). Mismo shader, mismos
// colores de marca. Se carga con import() dinámico solo cuando se abre el modal (ver
// openAbout() en panel-client.js) — three.js pesa ~360kb minificado, no tiene sentido
// cargarlo en cada arranque del panel por un modal que casi nadie abre.
import * as THREE from '/three.module.min.js';

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
  uniform vec3 colorTwitch;
  uniform vec3 colorKick;
  uniform vec3 colorYoutube;
  uniform vec3 colorTiktok;

  void main() {
    vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);

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
 * @param {{ reducedMotion?: boolean }} [options]
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
  renderer.setClearColor(new THREE.Color(0x0d1117));

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

  const uniforms = {
    resolution: { value: [1, 1] },
    time: { value: 0 },
    xScale: { value: 1.0 },
    yScale: { value: 0.5 },
    distortion: { value: 0.4 },
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

  const resize = () => {
    const { width, height } = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    uniforms.resolution.value = [width * dpr, height * dpr];
    renderer.render(scene, camera);
  };

  const animate = () => {
    uniforms.time.value += 0.006;
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(animate);
  };

  resize();
  if (!reduceMotion) animate();

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
