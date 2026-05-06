import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
gsap.registerPlugin(ScrollTrigger);

// === Wait briefly for Google Fonts before creating canvas textures.
// Tight cap so the scene appears fast even on cold caches; system fallback is acceptable. ===
if (document.fonts) {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('700 32px "Playfair Display"'),
        document.fonts.load('400 32px "Playfair Display"'),
        document.fonts.load('700 16px "Manrope"'),
      ]),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
  } catch (_) { /* fall back to system serifs */ }
}

// === UNT brand palette ===
const COLORS = {
  greenDeepest: 0x00190a,
  greenDeep: 0x003a1a,
  greenDark: 0x005c2c,
  green: 0x00853e,
  greenBright: 0x00b85b,
  greenGlow: 0x4ee090,
  greenMist: 0xc8e8d4,
  white: 0xffffff,
  offWhite: 0xf4f8f5,
  paper: 0xfaf7ec,
  charcoal: 0x0a0a0a,
  goldAccent: 0xd4af37,
};

const isMobile = window.matchMedia('(max-width: 767px)').matches;
const isDesktopFrame = !isMobile;

const canvas = document.getElementById('bg-canvas');
const scrollContainer = isDesktopFrame ? document.querySelector('.phone-screen') : window;

// Always start at the top — don't let the browser restore mid-transition scroll positions.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const resetScrollToTop = () => {
  if (isDesktopFrame && scrollContainer) scrollContainer.scrollTop = 0;
  window.scrollTo(0, 0);
};
resetScrollToTop();
window.addEventListener('load', resetScrollToTop);
// Handle bfcache restores (Safari "Back" button after Open in Maps, etc.)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resetScrollToTop();
});

// === Scene + camera ===
const scene = new THREE.Scene();

function getRenderSize() {
  if (isDesktopFrame) {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width || 374, height: rect.height || 846 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

let { width: W, height: H } = getRenderSize();

const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 200);
camera.position.set(0, 1.5, 11);

// === Renderer ===
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// === Post-processing: cinematic bloom ===
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0.35, 0.5, 0.7);
bloomPass.threshold = 0.7;
bloomPass.strength = 0.35;
bloomPass.radius = 0.5;
composer.addPass(bloomPass);

composer.addPass(new OutputPass());

// === Environment map (PBR reflections) ===
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

function createEnvironment() {
  const envScene = new THREE.Scene();
  const skyGeo = new THREE.SphereGeometry(50, 32, 32);
  const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x1a3a2a });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));
  const lightSpot = (color, position, intensity = 1) => {
    const geo = new THREE.SphereGeometry(2, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...position);
    mesh.scale.setScalar(intensity);
    envScene.add(mesh);
  };
  lightSpot(0xaaffcc, [10, 10, 5], 1.5);
  lightSpot(0xffffff, [-8, 8, 3], 1.4);
  lightSpot(0x44aa66, [3, -6, -8], 1);
  lightSpot(0x88ddaa, [-3, 12, -5], 1.2);
  return pmremGenerator.fromScene(envScene, 0, 0.1, 50).texture;
}
scene.environment = createEnvironment();

// === Cinematic gradient sky (real depth — not flat) ===
scene.fog = new THREE.FogExp2(0x004a22, 0.018);
const skyGeo = new THREE.SphereGeometry(80, 64, 64);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: {
    topColor: { value: new THREE.Color(0x004a22) },
    horizonColor: { value: new THREE.Color(0x00a04a) },
    bottomColor: { value: new THREE.Color(0x001a0a) },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPosition.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 bottomColor;
    varying vec3 vWorldPos;
    void main() {
      vec3 dir = normalize(vWorldPos);
      float h = dir.y;
      vec3 col = mix(bottomColor, horizonColor, smoothstep(-0.5, 0.05, h));
      col = mix(col, topColor, smoothstep(0.05, 0.75, h));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// === Lighting (balanced — neutral white key with green accents) ===
const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xfffbf0, 1.7);
keyLight.position.set(4, 8, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -8;
keyLight.shadow.camera.right = 8;
keyLight.shadow.camera.top = 8;
keyLight.shadow.camera.bottom = -8;
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 30;
keyLight.shadow.bias = -0.0005;
keyLight.shadow.radius = 4;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
fillLight.position.set(-5, 4, 3);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0x4ee090, 0.55);
rimLight.position.set(-2, 4, -6);
scene.add(rimLight);

const heroLight = new THREE.PointLight(0xffffff, 1.0, 18);
heroLight.position.set(0, 3, 5);
scene.add(heroLight);

// (Reflective floor removed — was rendering as black against the solid green bg)

// === STARS ===
function createStars(count) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = 30 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    sizes[i] = Math.random() * 1.8 + 0.5;
    phases[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      pixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute float size;
      attribute float phase;
      uniform float time;
      uniform float pixelRatio;
      varying float vTwinkle;
      void main() {
        vTwinkle = 0.45 + 0.55 * sin(time * 2.0 + phase);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = size * pixelRatio * (50.0 / -mvPosition.z);
      }
    `,
    fragmentShader: `
      varying float vTwinkle;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float alpha = (1.0 - d * 2.0) * vTwinkle;
        gl_FragColor = vec4(1.0, 1.0, 0.95, alpha);
      }
    `,
  });
  return new THREE.Points(geo, mat);
}
const stars = createStars(500);
scene.add(stars);

// === EMBERS ===
function createEmbers(count) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);
  const greenCol = new THREE.Color(COLORS.greenGlow);
  const whiteCol = new THREE.Color(COLORS.white);
  const brightCol = new THREE.Color(COLORS.greenBright);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 22;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 22 + 2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 8 - 2;
    const r = Math.random();
    const c = r < 0.4 ? greenCol : (r < 0.7 ? brightCol : whiteCol);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    speeds[i] = 0.18 + Math.random() * 0.45;
    phases[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('speed', new THREE.BufferAttribute(speeds, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      pixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute vec3 color;
      attribute float speed;
      attribute float phase;
      uniform float time;
      uniform float pixelRatio;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vec3 p = position;
        float life = mod(time * speed + phase, 10.0);
        p.y += life - 5.0;
        p.x += sin(time * 0.5 + phase) * 0.4;
        vAlpha = 1.0 - abs(life - 5.0) / 5.0;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = (4.5 + 2.5 * sin(time + phase)) * pixelRatio * (50.0 / -mvPosition.z);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float a = pow(1.0 - d * 2.0, 1.5) * vAlpha;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  return new THREE.Points(geo, mat);
}
const embers = createEmbers(120);
scene.add(embers);

// (Volumetric god ray removed — was making everything look like a green pipe)

// =============================================================
// UTILITY: 2D canvas → THREE texture
// =============================================================
function makeTextTexture(text, w = 512, h = 256, bg = '#ffffff', fg = '#00853e') {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, w - 12, h - 12);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.floor(h * 0.55)}px "Playfair Display", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// =============================================================
// SCENE 1: GRADUATION CAP (with stand reflection on floor)
// =============================================================
function createCap() {
  const group = new THREE.Group();

  // === Procedural cloth/fabric texture for realism (woven look) ===
  const clothCanvas = document.createElement('canvas');
  clothCanvas.width = 512;
  clothCanvas.height = 512;
  const clothCtx = clothCanvas.getContext('2d');
  // Base black
  clothCtx.fillStyle = '#1a1a1a';
  clothCtx.fillRect(0, 0, 512, 512);
  // Woven texture: thin diagonal lines + noise
  for (let y = 0; y < 512; y += 2) {
    for (let x = 0; x < 512; x += 2) {
      const v = 30 + Math.random() * 40;
      clothCtx.fillStyle = `rgb(${v},${v},${v})`;
      clothCtx.fillRect(x, y, 1, 1);
    }
  }
  // Diagonal weave lines
  clothCtx.globalAlpha = 0.18;
  clothCtx.strokeStyle = '#000';
  clothCtx.lineWidth = 1;
  for (let i = -512; i < 512; i += 4) {
    clothCtx.beginPath();
    clothCtx.moveTo(i, 0);
    clothCtx.lineTo(i + 512, 512);
    clothCtx.stroke();
  }
  clothCtx.globalAlpha = 1;
  const clothTex = new THREE.CanvasTexture(clothCanvas);
  clothTex.wrapS = clothTex.wrapT = THREE.RepeatWrapping;
  clothTex.repeat.set(4, 4);
  clothTex.colorSpace = THREE.NoColorSpace;

  // === Procedural normal map for woven fabric bumps ===
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = 256;
  normalCanvas.height = 256;
  const nctx = normalCanvas.getContext('2d');
  const nimg = nctx.createImageData(256, 256);
  for (let i = 0; i < nimg.data.length; i += 4) {
    const px = (i / 4) % 256;
    const py = Math.floor((i / 4) / 256);
    const wx = Math.sin(px * 0.7) * 28 + Math.sin(py * 1.3) * 6;
    const wy = Math.sin(py * 0.7) * 28 + Math.sin(px * 1.3) * 6;
    nimg.data[i]     = 128 + wx;
    nimg.data[i + 1] = 128 + wy;
    nimg.data[i + 2] = 255;
    nimg.data[i + 3] = 255;
  }
  nctx.putImageData(nimg, 0, 0);
  const normalTex = new THREE.CanvasTexture(normalCanvas);
  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.repeat.set(8, 8);

  // === Premium fabric material — satin weave with fine bump ===
  const fabricMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0d,
    roughness: 0.78,
    roughnessMap: clothTex,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(0.35, 0.35),
    metalness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.55,
    sheen: 1.0,
    sheenColor: new THREE.Color(0x4a4a58),
    sheenRoughness: 0.55,
  });

  // === Mortarboard (top square) — bigger, properly beveled ===
  const boardShape = new THREE.Shape();
  const s = 1.5;
  const cornerR = 0.05; // soft rounded corners (more realistic)
  boardShape.moveTo(-s + cornerR, -s);
  boardShape.lineTo(s - cornerR, -s);
  boardShape.quadraticCurveTo(s, -s, s, -s + cornerR);
  boardShape.lineTo(s, s - cornerR);
  boardShape.quadraticCurveTo(s, s, s - cornerR, s);
  boardShape.lineTo(-s + cornerR, s);
  boardShape.quadraticCurveTo(-s, s, -s, s - cornerR);
  boardShape.lineTo(-s, -s + cornerR);
  boardShape.quadraticCurveTo(-s, -s, -s + cornerR, -s);

  const boardGeo = new THREE.ExtrudeGeometry(boardShape, {
    depth: 0.08, bevelEnabled: true, bevelSegments: 8,
    bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 16,
  });
  boardGeo.translate(0, 0, -0.04);
  const board = new THREE.Mesh(boardGeo, fabricMat);
  board.rotation.x = -Math.PI / 2;
  board.position.y = 0.6;
  board.castShadow = true;
  board.receiveShadow = true;
  group.add(board);

  // === Pillow under the board (visible from below — adds depth) ===
  const pillowShape = new THREE.Shape();
  const ps = s * 0.94;
  const pr = 0.08;
  pillowShape.moveTo(-ps + pr, -ps);
  pillowShape.lineTo(ps - pr, -ps);
  pillowShape.quadraticCurveTo(ps, -ps, ps, -ps + pr);
  pillowShape.lineTo(ps, ps - pr);
  pillowShape.quadraticCurveTo(ps, ps, ps - pr, ps);
  pillowShape.lineTo(-ps + pr, ps);
  pillowShape.quadraticCurveTo(-ps, ps, -ps, ps - pr);
  pillowShape.lineTo(-ps, -ps + pr);
  pillowShape.quadraticCurveTo(-ps, -ps, -ps + pr, -ps);
  const pillowGeo = new THREE.ExtrudeGeometry(pillowShape, {
    depth: 0.05, bevelEnabled: true, bevelSegments: 4,
    bevelSize: 0.025, bevelThickness: 0.025, curveSegments: 12,
  });
  pillowGeo.translate(0, 0, -0.025);
  const pillow = new THREE.Mesh(pillowGeo, fabricMat);
  pillow.rotation.x = -Math.PI / 2;
  pillow.position.y = 0.54;
  pillow.castShadow = true;
  pillow.receiveShadow = true;
  group.add(pillow);

  // === Cap body — proper skull-cap taper (wider at base, narrower at top) ===
  const bodyGeo = new THREE.CylinderGeometry(0.92, 1.08, 0.82, 64, 8, true);
  const body = new THREE.Mesh(bodyGeo, fabricMat);
  body.position.y = 0.18;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // === Top sealing disc (slightly raised) ===
  const topDiscGeo = new THREE.CircleGeometry(0.92, 48);
  const topDisc = new THREE.Mesh(topDiscGeo, fabricMat);
  topDisc.rotation.x = -Math.PI / 2;
  topDisc.position.y = 0.585;
  group.add(topDisc);

  // === Stitch ring detail at board/body junction ===
  const stitchRingGeo = new THREE.TorusGeometry(0.93, 0.006, 8, 96);
  const stitchMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a32,
    roughness: 0.7,
    metalness: 0.1,
  });
  const stitchRing = new THREE.Mesh(stitchRingGeo, stitchMat);
  stitchRing.position.y = 0.585;
  stitchRing.rotation.x = Math.PI / 2;
  group.add(stitchRing);

  // === UNT green silk inner lining (visible from below) ===
  const liningGeo = new THREE.CylinderGeometry(0.9, 1.06, 0.78, 48, 1, true);
  const liningMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.greenDark,
    roughness: 0.4,
    metalness: 0.2,
    side: THREE.BackSide,
    sheen: 0.6,
    sheenColor: new THREE.Color(COLORS.greenGlow),
  });
  const lining = new THREE.Mesh(liningGeo, liningMat);
  lining.position.y = 0.18;
  group.add(lining);

  // === Reinforcing band around base of cap (real graduation caps have this) ===
  const bandGeo = new THREE.TorusGeometry(1.06, 0.025, 12, 48);
  const bandMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a1a1f,
    roughness: 0.6,
    metalness: 0.2,
  });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = -0.22;
  band.rotation.x = Math.PI / 2;
  group.add(band);

  // === Tassel button (white fabric-covered center on UNT cap) ===
  const buttonGeo = new THREE.SphereGeometry(0.11, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const buttonMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.white,
    roughness: 0.32,
    metalness: 0.1,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    sheen: 0.7,
    sheenColor: new THREE.Color(0xffffff),
    sheenRoughness: 0.3,
  });
  const button = new THREE.Mesh(buttonGeo, buttonMat);
  button.position.y = 0.71;
  button.castShadow = true;
  group.add(button);

  // Button base disc (closes the half-sphere underside cleanly)
  const buttonBase = new THREE.Mesh(new THREE.CircleGeometry(0.11, 32), buttonMat);
  buttonBase.rotation.x = -Math.PI / 2;
  buttonBase.position.y = 0.71;
  group.add(buttonBase);

  // === Tassel cord — anchored at button, swings via cordRoot animation ===
  const cordRoot = new THREE.Group();
  cordRoot.position.set(0, 0.71, 0);
  group.add(cordRoot);
  group.userData.cordRoot = cordRoot;

  const cordCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.5, -0.05, 0.45),
    new THREE.Vector3(1.05, -0.2, 0.82),
    new THREE.Vector3(1.32, -0.55, 1.05),
  ]);
  const cordGeo = new THREE.TubeGeometry(cordCurve, 96, 0.038, 16, false);
  const cordMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.greenBright,
    roughness: 0.4,
    metalness: 0.2,
    sheen: 0.85,
    sheenColor: new THREE.Color(COLORS.greenGlow),
    sheenRoughness: 0.4,
    clearcoat: 0.3,
    clearcoatRoughness: 0.3,
  });
  const cord = new THREE.Mesh(cordGeo, cordMat);
  cord.castShadow = true;
  cordRoot.add(cord);

  // Thin braided highlight thread along the cord
  const cordHighlightMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.greenGlow,
    roughness: 0.32,
    metalness: 0.25,
    sheen: 1.0,
    sheenColor: new THREE.Color(0xffffff),
    sheenRoughness: 0.3,
  });
  const cord2Curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0,    0.006, 0.006),
    new THREE.Vector3(0.5,  -0.04, 0.455),
    new THREE.Vector3(1.05, -0.19, 0.825),
    new THREE.Vector3(1.32, -0.545, 1.055),
  ]);
  const cord2Geo = new THREE.TubeGeometry(cord2Curve, 96, 0.018, 12, false);
  const cord2 = new THREE.Mesh(cord2Geo, cordHighlightMat);
  cord2.castShadow = true;
  cordRoot.add(cord2);

  // === Tassel head (collar + fringe), positioned at end of cord, swings ===
  const tasselHead = new THREE.Group();
  tasselHead.position.set(1.32, -0.55, 1.05);
  cordRoot.add(tasselHead);
  group.userData.tasselHead = tasselHead;

  // Collar (where the strands gather at the top)
  const collarMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.green,
    roughness: 0.4,
    metalness: 0.22,
    sheen: 0.85,
    sheenColor: new THREE.Color(COLORS.greenGlow),
    sheenRoughness: 0.4,
    clearcoat: 0.25,
  });
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.088, 0.13, 32),
    collarMat
  );
  collar.position.y = 0.05;
  collar.castShadow = true;
  tasselHead.add(collar);

  // Top dome of the collar (rounded gather where strands meet the cord)
  const collarTopGeo = new THREE.SphereGeometry(0.12, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const collarTop = new THREE.Mesh(collarTopGeo, collarMat);
  collarTop.position.y = 0.115;
  collarTop.castShadow = true;
  tasselHead.add(collarTop);

  // Binding wrap ring near the bottom of the collar
  const wrapMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.greenDark,
    roughness: 0.5,
    metalness: 0.2,
    sheen: 0.8,
    sheenColor: new THREE.Color(COLORS.greenGlow),
  });
  const wrapRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.092, 0.014, 12, 32),
    wrapMat
  );
  wrapRing.rotation.x = Math.PI / 2;
  wrapRing.position.y = -0.005;
  tasselHead.add(wrapRing);

  // Fringe — denser strands in two concentric rings with slight randomness
  const totalStrands = 64;
  for (let i = 0; i < totalStrands; i++) {
    const angle = (i / totalStrands) * Math.PI * 2 + (Math.random() - 0.5) * 0.04;
    const ringIdx = i % 2;
    const r = 0.07 + ringIdx * 0.018 + (Math.random() - 0.5) * 0.006;
    const length = 0.56 + Math.random() * 0.14;
    const strandGeo = new THREE.CylinderGeometry(0.0095, 0.004, length, 5);
    const strand = new THREE.Mesh(strandGeo, cordMat);
    strand.position.x = Math.cos(angle) * r;
    strand.position.z = Math.sin(angle) * r;
    strand.position.y = -length / 2 - 0.02;
    strand.rotation.z = Math.cos(angle) * 0.05 + (Math.random() - 0.5) * 0.025;
    strand.rotation.x = Math.sin(angle) * 0.05 + (Math.random() - 0.5) * 0.025;
    strand.castShadow = true;
    tasselHead.add(strand);
  }

  // === Big readable "Class of 2026" plaque on the cap board (top face) ===
  const plaqueTex = makeCapPlaqueTexture();
  const plaqueGeo = new THREE.PlaneGeometry(1.7, 0.6);
  const plaqueMat = new THREE.MeshPhysicalMaterial({
    map: plaqueTex,
    roughness: 0.4,
    metalness: 0.3,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const plaque = new THREE.Mesh(plaqueGeo, plaqueMat);
  plaque.position.set(0, 0.685, 0);
  plaque.rotation.x = -Math.PI / 2;
  group.add(plaque);

  return group;
}

function makeCapPlaqueTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 360;
  const ctx = c.getContext('2d');
  // Transparent background — only the badge is visible
  ctx.clearRect(0, 0, c.width, c.height);

  // Rounded rectangle background
  const rx = 50, ry = 30, rr = 60;
  const rw = c.width - 100, rh = c.height - 60;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.lineTo(rx + rw - rr, ry);
  ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rr);
  ctx.lineTo(rx + rw, ry + rh - rr);
  ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
  ctx.lineTo(rx + rr, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rr);
  ctx.lineTo(rx, ry + rr);
  ctx.quadraticCurveTo(rx, ry, rx + rr, ry);
  ctx.closePath();
  ctx.fill();

  // Border
  ctx.strokeStyle = '#00853e';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Inside text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#003a1a';
  ctx.font = 'bold 70px "Playfair Display", Georgia, serif';
  ctx.fillText('CLASS OF', c.width / 2, 130);

  ctx.fillStyle = '#00853e';
  ctx.font = 'bold 130px "Playfair Display", Georgia, serif';
  ctx.fillText('2026', c.width / 2, 260);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}

const cap = createCap();
cap.position.set(0, 1.6, 0);
cap.scale.setScalar(1.2);
scene.add(cap);

// === Eagle ===
function createEagle() {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(-0.3, 0.12, -0.85, 0.45, -1.5, 0.22);
  shape.bezierCurveTo(-1.0, 0.05, -0.6, 0.0, -0.3, -0.05);
  shape.lineTo(0, -0.12);
  shape.lineTo(0.3, -0.05);
  shape.bezierCurveTo(0.6, 0.0, 1.0, 0.05, 1.5, 0.22);
  shape.bezierCurveTo(0.85, 0.45, 0.3, 0.12, 0, 0);
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x88e0aa,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
  });
  const eagle = new THREE.Mesh(geo, mat);
  eagle.scale.setScalar(0.9);
  group.add(eagle);
  return group;
}
const eagle = createEagle();
eagle.position.set(-15, 5, -8);
scene.add(eagle);

// =============================================================
// SCENE 2: PHOTO FRAME
// =============================================================
function loadPhotoTexture() {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      './public/sriya.jpeg',
      (tex) => { tex.colorSpace = THREE.SRGBColorSpace; resolve(tex); },
      undefined,
      () => resolve(null)
    );
  });
}

function createPhotoFrame(photoTexture) {
  const group = new THREE.Group();

  // === Thinner, weighty medallion body (won't hide photo) ===
  const medallionShape = new THREE.Shape();
  medallionShape.absarc(0, 0, 1.55, 0, Math.PI * 2);
  const medallionGeo = new THREE.ExtrudeGeometry(medallionShape, {
    depth: 0.14,
    bevelEnabled: true,
    bevelSegments: 12,
    bevelSize: 0.06,
    bevelThickness: 0.04,
    curveSegments: 80,
  });
  medallionGeo.translate(0, 0, -0.07);

  const medallionMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.white,
    roughness: 0.18,
    metalness: 0.55,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const medallion = new THREE.Mesh(medallionGeo, medallionMat);
  medallion.castShadow = true;
  medallion.receiveShadow = true;
  group.add(medallion);

  // === The PHOTO — clearly in front, big and prominent ===
  if (photoTexture) {
    const photoGeo = new THREE.CircleGeometry(1.32, 96);
    const photoMat = new THREE.MeshPhysicalMaterial({
      map: photoTexture,
      roughness: 0.5,
      metalness: 0.0,
    });
    const photo = new THREE.Mesh(photoGeo, photoMat);
    photo.position.z = 0.18;
    group.add(photo);
  }

  // === Inner thin white ring framing the photo ===
  const innerRingGeo = new THREE.TorusGeometry(1.34, 0.035, 16, 96);
  const innerRingMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.white,
    roughness: 0.2,
    metalness: 0.7,
    clearcoat: 1,
  });
  const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
  innerRing.position.z = 0.19;
  group.add(innerRing);

  // === UNT green outer accent ring (premium border) ===
  const outerRingGeo = new THREE.TorusGeometry(1.46, 0.05, 24, 96);
  const outerRingMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.green,
    roughness: 0.3,
    metalness: 0.5,
    clearcoat: 0.8,
  });
  const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
  outerRing.position.z = 0.19;
  outerRing.castShadow = true;
  group.add(outerRing);

  // === Decorative star markers around the medallion ===
  const starMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.green,
    roughness: 0.3,
    metalness: 0.5,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 16), starMat);
    s.position.set(Math.cos(a) * 1.46, Math.sin(a) * 1.46, 0.2);
    group.add(s);
  }

  // === Soft atmospheric glow behind the medallion ===
  const glowGeo = new THREE.CircleGeometry(2.5, 32);
  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: { color: { value: new THREE.Color(COLORS.greenBright) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float alpha = pow(1.0 - d * 2.0, 2.5) * 0.28;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.z = -0.5;
  group.add(glow);

  // Tilt the medallion slightly forward — 3D realistic angle (gravity feel)
  group.rotation.x = -0.12;

  // For animation
  group.userData.medallion = medallion;

  return group;
}

function makeMedallionBandTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  // White band fill
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  // Engraved-look text in UNT green
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00853e';
  ctx.font = 'bold 130px "Manrope", sans-serif';
  ctx.fillText('★  UNIVERSITY OF NORTH TEXAS  ★', c.width / 2, 170);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}

let photoFrame;
loadPhotoTexture().then((tex) => {
  photoFrame = createPhotoFrame(tex);
  photoFrame.position.set(0, -20, 0);
  photoFrame.visible = false;
  scene.add(photoFrame);
});

// =============================================================
// SCENE 3: DIPLOMA SCROLL
// =============================================================
function makeDiplomaTexture() {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 800;
  const ctx = c.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#fefaee');
  grad.addColorStop(0.5, '#f7eecf');
  grad.addColorStop(1, '#ede0ac');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 800; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? '#000' : '#8b6914';
    ctx.fillRect(Math.random() * c.width, Math.random() * c.height, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  // UNT-style outer border (thick green)
  ctx.strokeStyle = '#00853e';
  ctx.lineWidth = 10;
  ctx.strokeRect(140, 50, c.width - 280, c.height - 100);
  ctx.lineWidth = 2;
  ctx.strokeRect(170, 80, c.width - 340, c.height - 160);

  ctx.textAlign = 'center';
  const cx = c.width / 2;

  // University name — bold uppercase (UNT brand style)
  ctx.fillStyle = '#003a1a';
  ctx.font = 'bold 38px "Manrope", Helvetica, Arial, sans-serif';
  ctx.fillText('UNIVERSITY OF NORTH TEXAS', cx, 155);

  // Decorative dot
  ctx.fillStyle = '#00853e';
  ctx.beginPath();
  ctx.arc(cx, 195, 5, 0, Math.PI * 2);
  ctx.fill();

  // Degree — big bold serif (UNT formal style)
  ctx.font = 'bold 78px "Playfair Display", Georgia, serif';
  ctx.fillStyle = '#00853e';
  ctx.fillText('Master of Science', cx, 290);

  // "in"
  ctx.fillStyle = '#003a1a';
  ctx.font = 'italic 34px "Playfair Display", Georgia, serif';
  ctx.fillText('in', cx, 340);

  // Field — bold serif
  ctx.font = 'bold 52px "Playfair Display", Georgia, serif';
  ctx.fillStyle = '#005c2c';
  ctx.fillText('Computer & Information Sciences', cx, 410);

  // Awarded to (small caps style)
  ctx.font = 'bold 22px "Manrope", sans-serif';
  ctx.fillStyle = '#003a1a';
  ctx.fillText('A W A R D E D    T O', cx, 480);

  // Name — biggest, most prominent
  ctx.font = 'bold 64px "Playfair Display", Georgia, serif';
  ctx.fillStyle = '#00190a';
  ctx.fillText('Sriya Jaladi', cx, 565);

  // Divider
  ctx.strokeStyle = '#00853e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 240, 615);
  ctx.lineTo(cx + 240, 615);
  ctx.stroke();

  // Period — bold sans-serif
  ctx.font = 'bold 28px "Manrope", sans-serif';
  ctx.fillStyle = '#003a1a';
  ctx.fillText('AUGUST 2024 — DECEMBER 2026', cx, 660);

  // Class of badge
  ctx.font = 'bold 24px "Manrope", sans-serif';
  ctx.fillStyle = '#00853e';
  ctx.fillText('★  CLASS OF 2026  ★', cx, 715);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}

function createDiploma() {
  const group = new THREE.Group();

  const parchTexture = makeDiplomaTexture();
  const paperGeo = new THREE.PlaneGeometry(3.6, 2.2, 32, 16);
  const paperMat = new THREE.MeshPhysicalMaterial({
    map: parchTexture,
    color: COLORS.paper,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  const paper = new THREE.Mesh(paperGeo, paperMat);
  paper.castShadow = true;
  paper.receiveShadow = true;
  // Subtle curl
  const positions = paperGeo.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    positions.setZ(i, Math.sin(x * 0.5) * 0.04);
  }
  positions.needsUpdate = true;
  paperGeo.computeVertexNormals();
  group.add(paper);

  const rodMat = new THREE.MeshPhysicalMaterial({
    color: 0x3a2014,
    roughness: 0.55,
    metalness: 0.3,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
  });

  // Vertical rods on left/right edges
  const rodGeo = new THREE.CylinderGeometry(0.14, 0.14, 2.5, 24);
  for (const x of [-1.85, 1.85]) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(x, 0, -0.05);
    rod.castShadow = true;
    group.add(rod);
  }

  const capMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.goldAccent,
    roughness: 0.2,
    metalness: 0.9,
    clearcoat: 0.5,
    clearcoatRoughness: 0.1,
  });
  const capGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.13, 24);
  for (const x of [-1.85, 1.85]) {
    for (const y of [-1.25, 1.25]) {
      const c = new THREE.Mesh(capGeo, capMat);
      c.position.set(x, y, -0.05);
      c.castShadow = true;
      group.add(c);
    }
  }

  // Decorative ball ornaments at rod tips
  const domeGeo = new THREE.SphereGeometry(0.19, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  for (const x of [-1.85, 1.85]) {
    for (const y of [-1.355, 1.355]) {
      const d = new THREE.Mesh(domeGeo, capMat);
      d.position.set(x, y, -0.05);
      if (y < 0) d.rotation.x = Math.PI;
      d.castShadow = true;
      group.add(d);
    }
  }

  // (Wax seal & star removed — they were covering the name)

  // Ribbon ties wrapped around rods
  const ribbonMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.green,
    roughness: 0.55,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  for (const x of [-1.85, 1.85]) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.05, 12, 32), ribbonMat);
    wrap.position.set(x, 0.3, -0.05);
    wrap.rotation.x = Math.PI / 2;
    group.add(wrap);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.55), ribbonMat);
    strip.position.set(x + (x < 0 ? -0.1 : 0.1), -0.05, 0.05);
    strip.rotation.z = x < 0 ? 0.18 : -0.18;
    group.add(strip);
  }

  return group;
}
const diploma = createDiploma();
diploma.position.set(0, -20, 0);
diploma.visible = false;
scene.add(diploma);

// =============================================================
// SCENE 4: 3D DATE BLOCK (replacing flat invitation card)
// === A floating "MAY 8" 3D number sculpture ===
// =============================================================
function createDateBlock() {
  const group = new THREE.Group();

  // (Halo ring removed — clean look without circle around the 8)

  // === "MAY" text plane ABOVE the 8 (top of stack) ===
  const mayTex = makeSimpleTextTexture('MAY', 800, 200, 'bold 130px "Playfair Display", Georgia, serif');
  const mayPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 0.6),
    new THREE.MeshBasicMaterial({ map: mayTex, transparent: true })
  );
  mayPlane.position.set(0, 2.4, 0);
  group.add(mayPlane);

  // === Gravity ground glow circle (under the 8 — subtle floor halo) ===
  const groundGlow = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 64),
    new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: { color: { value: new THREE.Color(0xffffff) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 color;
        varying vec2 vUv;
        void main() {
          float d = distance(vUv, vec2(0.5));
          float a = pow(1.0 - d * 2.0, 3.0) * 0.55;
          gl_FragColor = vec4(color, a);
        }
      `,
    })
  );
  groundGlow.rotation.x = -Math.PI / 2.2;
  groundGlow.position.set(0, -1.05, 0);
  group.add(groundGlow);

  // === Info text plane BELOW the 8 (FRIDAY · 4:00 PM · UNT COLISEUM · 2026) ===
  const infoTex = makeInfoBlockTexture();
  const info = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.0),
    new THREE.MeshBasicMaterial({ map: infoTex, transparent: true })
  );
  info.position.set(0, -2.2, 0);
  group.add(info);

  // === Premium 3D "8" (serif gold, the only 8) ===
  const fontLoader = new FontLoader();
  fontLoader.load(
    'https://unpkg.com/three@0.160.0/examples/fonts/optimer_bold.typeface.json',
    (font) => {
      const textGeo = new TextGeometry('8', {
        font,
        size: 2.4,
        height: 0.4,
        curveSegments: 36,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.035,
        bevelSegments: 12,
      });
      textGeo.computeBoundingBox();
      const cx = (textGeo.boundingBox.max.x + textGeo.boundingBox.min.x) / 2;
      const cy = (textGeo.boundingBox.max.y + textGeo.boundingBox.min.y) / 2;
      textGeo.translate(-cx, -cy, 0);

      const textMat = new THREE.MeshPhysicalMaterial({
        color: COLORS.white,
        roughness: 0.2,
        metalness: 0.55,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
      });
      const eight = new THREE.Mesh(textGeo, textMat);
      eight.position.set(0, 0.4, 0);
      eight.castShadow = true;
      eight.receiveShadow = true;
      group.add(eight);
      group.userData.eight = eight;
    }
  );

  return group;
}

function makeSimpleTextTexture(text, w, h, font) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}

function makeInfoBlockTexture() {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 720;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';
  const cx = c.width / 2;

  // FRIDAY (bigger)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 88px "Manrope", sans-serif';
  ctx.fillText('F R I D A Y', cx, 130);

  // Divider
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 280, 185);
  ctx.lineTo(cx + 280, 185);
  ctx.stroke();

  // 4:00 PM (bigger)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 120px "Playfair Display", Georgia, serif';
  ctx.fillText('4:00 PM', cx, 320);

  // Divider
  ctx.beginPath();
  ctx.moveTo(cx - 280, 380);
  ctx.lineTo(cx + 280, 380);
  ctx.stroke();

  // Venue (bigger)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 60px "Manrope", sans-serif';
  ctx.fillText('UNT COLISEUM · DENTON, TX', cx, 480);

  // Year (bigger)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 46px "Manrope", sans-serif';
  ctx.fillText('2026', cx, 580);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}


function makeDateTexture() {
  const c = document.createElement('canvas');
  c.width = 1440;
  c.height = 880;
  const ctx = c.getContext('2d');

  ctx.clearRect(0, 0, c.width, c.height);

  ctx.textAlign = 'center';
  const cx = c.width / 2;

  // FRIDAY — bigger
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 60px sans-serif';
  ctx.fillText('F R I D A Y', cx, 110);

  // Top divider
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 220, 145);
  ctx.lineTo(cx + 220, 145);
  ctx.stroke();

  // Massive "8"
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 460px "Playfair Display", Georgia, serif';
  ctx.fillText('8', cx, 540);

  // MAY · 2026 — bigger
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 78px "Playfair Display", Georgia, serif';
  ctx.fillText('MAY  ·  2026', cx, 670);

  // Bottom divider
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 220, 715);
  ctx.lineTo(cx + 220, 715);
  ctx.stroke();

  // Time — bigger
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText('4:00 PM', cx, 800);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 16;
  return tex;
}

const dateBlock = createDateBlock();
dateBlock.position.set(0, -20, 0);
dateBlock.visible = false;
scene.add(dateBlock);

// =============================================================
// SCENE 5: MAP PIN (with bigger map and floating)
// =============================================================
function createMapPin() {
  const group = new THREE.Group();

  const pinMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.greenBright,
    roughness: 0.25,
    metalness: 0.5,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
  });

  const headGeo = new THREE.SphereGeometry(0.55, 64, 64);
  const head = new THREE.Mesh(headGeo, pinMat);
  head.position.y = 0.7;
  head.scale.set(1, 1.05, 1);
  head.castShadow = true;
  group.add(head);

  const tipGeo = new THREE.ConeGeometry(0.5, 1.1, 48);
  const tip = new THREE.Mesh(tipGeo, pinMat);
  tip.position.y = -0.05;
  tip.rotation.x = Math.PI;
  tip.castShadow = true;
  group.add(tip);

  // (White center disc + ring removed — the "moon" overlay was confusing)

  // Map plane (concentric rings - far below for floor effect)
  const mapGeo = new THREE.CircleGeometry(3.5, 64);
  const mapMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      green: { value: new THREE.Color(COLORS.green) },
      white: { value: new THREE.Color(COLORS.white) },
      glow: { value: new THREE.Color(COLORS.greenGlow) },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 green;
      uniform vec3 white;
      uniform vec3 glow;
      uniform float time;
      varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float rings = sin((d - time * 0.08) * 65.0) * 0.5 + 0.5;
        rings *= smoothstep(0.5, 0.0, d);
        vec3 col = mix(green * 0.2, glow, rings * 0.55);
        col = mix(col, white, rings * 0.18);
        float alpha = smoothstep(0.5, 0.0, d) * 0.85;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    side: THREE.DoubleSide,
  });
  const map = new THREE.Mesh(mapGeo, mapMat);
  map.rotation.x = -Math.PI / 2.3;
  map.position.y = -1.5;
  group.add(map);
  group.userData.map = map;

  return group;
}
const mapPin = createMapPin();
mapPin.position.set(0, -20, 0);
mapPin.visible = false;
scene.add(mapPin);

// === Confetti ===
function createConfetti(count) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);
  const palette = [
    new THREE.Color(COLORS.greenBright),
    new THREE.Color(COLORS.greenGlow),
    new THREE.Color(COLORS.white),
    new THREE.Color(COLORS.green),
    new THREE.Color(COLORS.greenMist),
  ];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 14;
    positions[i * 3 + 1] = Math.random() * 12 + 6;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 4;
    const c = palette[Math.floor(Math.random() * palette.length)];
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    speeds[i] = 0.5 + Math.random() * 1.0;
    phases[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('speed', new THREE.BufferAttribute(speeds, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      pixelRatio: { value: renderer.getPixelRatio() },
      progress: { value: 0 },
    },
    vertexShader: `
      attribute vec3 color;
      attribute float speed;
      attribute float phase;
      uniform float time;
      uniform float pixelRatio;
      uniform float progress;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vec3 p = position;
        float t = progress * 9.0;
        p.y -= t * speed;
        p.x += sin(time * 2.0 + phase) * 0.6;
        p.z += cos(time * 1.5 + phase) * 0.4;
        vAlpha = (1.0 - progress) * progress * 4.0;
        vAlpha = clamp(vAlpha, 0.0, 1.0);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = 9.5 * pixelRatio * (50.0 / -mvPosition.z);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = max(abs(c.x), abs(c.y));
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.userData.mat = mat;
  return points;
}
const confetti = createConfetti(260);
confetti.visible = false;
scene.add(confetti);

// =============================================================
// SCROLL TIMELINE
// =============================================================
function buildTimeline() {
  const sceneEls = document.querySelectorAll('.scene');
  sceneEls.forEach((el) => {
    ScrollTrigger.create({
      trigger: el,
      scroller: isDesktopFrame ? scrollContainer : window,
      start: 'top 85%',
      end: 'bottom 15%',
      onEnter: () => el.classList.add('in-view'),
      onEnterBack: () => el.classList.add('in-view'),
    });
  });

  ScrollTrigger.create({
    trigger: '.overlay',
    scroller: isDesktopFrame ? scrollContainer : window,
    start: 'top top',
    end: 'bottom bottom',
    scrub: 1,
    onUpdate: (self) => driveTimeline(self.progress),
  });

  ScrollTrigger.create({
    trigger: '.scene-1',
    scroller: isDesktopFrame ? scrollContainer : window,
    start: 'top top',
    once: true,
    onEnter: () => {
      gsap.fromTo(eagle.position, { x: -15, y: 5 }, { x: 15, y: 4, duration: 9, ease: 'power1.inOut' });
    },
  });

  ScrollTrigger.create({
    trigger: '.scene-5',
    scroller: isDesktopFrame ? scrollContainer : window,
    start: 'top 60%',
    onEnter: () => {
      confetti.visible = true;
      gsap.fromTo(confetti.userData.mat.uniforms.progress, { value: 0 }, { value: 1, duration: 3.5, ease: 'power2.out' });
    },
  });
}

// All 3D objects positioned in upper half (y around 1.5-2)
// Text in HTML overlay sits in middle/lower half and is fully readable
// Smoothstep easing helper
const smooth = (t) => t * t * (3 - 2 * t);

function driveTimeline(p) {
  const sceneIndex = p * 5;
  const tNow = performance.now();

  // Each scene gets a long stable period and a tight 0.1 transition.
  // Stable zones (text fully readable, 3D centered):
  //   Scene 1: 0.00 → 0.90    Scene 2: 1.05 → 1.90    Scene 3: 2.05 → 2.90
  //   Scene 4: 3.05 → 3.90    Scene 5: 4.05 → 5.00
  // Transition zones (0.10 wide): 0.90→1.05, 1.90→2.05, 2.90→3.05, 3.90→4.05

  // === Cap (S1, exits 0.90 → 1.05) ===
  if (sceneIndex < 1.05) {
    cap.visible = true;
    if (sceneIndex < 0.9) {
      cap.position.set(0, 1.6 + Math.sin(tNow * 0.0009) * 0.08, 0);
      cap.rotation.set(0.2 + Math.sin(tNow * 0.0006) * 0.03, Math.sin(tNow * 0.0007) * 0.18, 0);
      cap.scale.setScalar(1.2);
    } else {
      const k = smooth((sceneIndex - 0.9) / 0.15);
      cap.position.set(0, 1.6 + k * 9, 0);
      cap.rotation.set(0.2 + k * Math.PI * 2, k * Math.PI * 4, 0);
      cap.scale.setScalar(1.2 * (1 - k * 0.7));
    }
  } else {
    cap.visible = false;
  }

  // === Photo frame (S2, enters 0.95, stable 1.05 → 1.90, exits 1.90 → 2.05) ===
  if (photoFrame && sceneIndex >= 0.95 && sceneIndex < 2.05) {
    photoFrame.visible = true;
    if (sceneIndex < 1.05) {
      const k = smooth((sceneIndex - 0.95) / 0.10);
      photoFrame.position.y = -8 + k * 9.6;
      photoFrame.scale.setScalar(0.5 + k * 0.5);
      photoFrame.rotation.y = (1 - k) * Math.PI * 0.3;
    } else if (sceneIndex < 1.9) {
      photoFrame.position.y = 1.6;
      photoFrame.scale.setScalar(1);
      photoFrame.rotation.y = (sceneIndex - 1.05) * 0.35;
    } else {
      const k = smooth((sceneIndex - 1.9) / 0.15);
      photoFrame.position.y = 1.6 - k * 9;
      photoFrame.scale.setScalar(1 - k * 0.5);
    }
  } else if (photoFrame) {
    photoFrame.visible = false;
  }

  // === Diploma (S3, enters 1.95, stable 2.05 → 2.90, exits 2.90 → 3.05) ===
  if (sceneIndex >= 1.95 && sceneIndex < 3.05) {
    diploma.visible = true;
    if (sceneIndex < 2.05) {
      const k = smooth((sceneIndex - 1.95) / 0.10);
      diploma.position.y = -8 + k * 9.6;
      diploma.scale.setScalar(k);
      diploma.rotation.z = (1 - k) * 0.25;
    } else if (sceneIndex < 2.9) {
      diploma.position.y = 1.6;
      diploma.scale.setScalar(1);
      diploma.rotation.z = 0;
      diploma.rotation.y = Math.sin((sceneIndex - 2.05) * 2) * 0.12;
    } else {
      const k = smooth((sceneIndex - 2.9) / 0.15);
      diploma.position.y = 1.6 - k * 9;
      diploma.scale.setScalar(1 - k * 0.5);
    }
  } else {
    diploma.visible = false;
  }

  // === Date block (S4, enters 2.95, stable 3.05 → 3.90, exits 3.90 → 4.05) ===
  if (sceneIndex >= 2.95 && sceneIndex < 4.05) {
    dateBlock.visible = true;
    if (sceneIndex < 3.05) {
      const k = smooth((sceneIndex - 2.95) / 0.10);
      dateBlock.position.y = -8 + k * 9.6;
      dateBlock.rotation.y = (1 - k) * Math.PI * 0.5;
      dateBlock.scale.setScalar(k);
    } else if (sceneIndex < 3.9) {
      dateBlock.position.y = 1.6;
      dateBlock.scale.setScalar(1);
      dateBlock.rotation.y = 0;
      // Cinematic slow rotation of the 3D "8"
      if (dateBlock.userData.eight) {
        dateBlock.userData.eight.rotation.y = Math.sin(tNow * 0.0008) * 0.3;
      }
    } else {
      const k = smooth((sceneIndex - 3.9) / 0.15);
      dateBlock.position.y = 1.6 - k * 9;
      dateBlock.scale.setScalar(1 - k * 0.5);
    }
  } else {
    dateBlock.visible = false;
  }

  // === Map pin (S5, enters 3.95, stable 4.05 → 5.0) ===
  if (sceneIndex >= 3.95) {
    mapPin.visible = true;
    if (sceneIndex < 4.05) {
      const k = smooth((sceneIndex - 3.95) / 0.10);
      mapPin.position.y = 6 - k * 4.4;
      mapPin.scale.setScalar(k);
    } else {
      mapPin.position.y = 1.6 + Math.sin(tNow * 0.0015) * 0.12;
      mapPin.scale.setScalar(1);
      mapPin.rotation.y = (sceneIndex - 4.05) * 0.35;
    }
  } else {
    mapPin.visible = false;
  }

  // Subtle camera dolly
  camera.position.y = 1.5 - p * 0.3;
  camera.position.z = 11 + Math.sin(p * Math.PI) * 0.5;
  camera.lookAt(0, 1.4, 0);
}

// === Resize ===
function handleResize() {
  const sz = getRenderSize();
  W = sz.width;
  H = sz.height;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  renderer.setSize(W, H, false);
  composer.setSize(W, H);
  bloomPass.setSize(W, H);
}

window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);

// === Animation loop ===
const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();

  stars.material.uniforms.time.value = t;
  embers.material.uniforms.time.value = t;
  if (confetti.userData.mat) confetti.userData.mat.uniforms.time.value = t;

  if (photoFrame && photoFrame.visible && photoFrame.userData.outerRing) {
    photoFrame.userData.outerRing.material.uniforms.time.value = t;
  }
  if (mapPin.visible && mapPin.userData.map) {
    mapPin.userData.map.material.uniforms.time.value = t;
  }

  // Cap tassel sway (gentle pendulum motion)
  if (cap.visible && cap.userData.cordRoot) {
    cap.userData.cordRoot.rotation.z = Math.sin(t * 1.6) * 0.08;
    cap.userData.cordRoot.rotation.x = Math.cos(t * 1.2) * 0.04;
  }
  // Tassel head extra dangle (responds slightly delayed)
  if (cap.visible && cap.userData.tasselHead) {
    cap.userData.tasselHead.rotation.z = Math.sin(t * 1.6 - 0.3) * 0.12;
  }

  // Animate orbiting orbs in date block
  if (dateBlock.visible) {
    dateBlock.children.forEach((child) => {
      if (child.userData.basePos !== undefined && child.userData.phase !== undefined) {
        const base = child.userData.basePos;
        child.position.y = base.y + Math.sin(t * 1.2 + child.userData.phase) * 0.08;
      }
    });
  }

  composer.render();
  requestAnimationFrame(animate);
}

// === Init ===
function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.classList.add('hidden');
    setTimeout(() => loading.remove(), 700);
  }
}

function init() {
  buildTimeline();
  handleResize();
  document.querySelector('.scene-1')?.classList.add('in-view');
  animate();
  hideLoading();
}

async function bootstrap() {
  // Tight font cap — system fallback is acceptable; speed trumps perfect first paint.
  if (document.fonts && document.fonts.ready) {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    } catch (_) { /* ignore */ }
  }
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// === Share ===
const shareBtn = document.getElementById('share-btn');
if (shareBtn) {
  shareBtn.addEventListener('click', async () => {
    const shareData = {
      title: "You're Invited — Sriya's Graduation",
      text: "Join me as I graduate from the University of North Texas — May 8, 2026!",
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
        showToast('Link copied to clipboard ✨');
      } else {
        showToast(window.location.href);
      }
    } catch (err) { /* cancelled */ }
  });
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}
