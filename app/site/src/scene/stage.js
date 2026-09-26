// One renderer, one scene, one camera for the whole page. Takes the canvas; knows nothing about the page DOM.
//   const stage = await createStage(THREE, canvas, { hdrUrl, mobile });
//   stage.setRig({ tx, ty, tz, dist, el, az, fov, sx, sy });  stage.render();
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export const lerp = (a, b, t) => a + (b - a) * t;
export function lerpRig(a, b, t) {
  const o = {};
  for (const k of Object.keys(a)) o[k] = typeof a[k] === 'number' ? lerp(a[k], b[k] ?? a[k], t) : a[k];
  return o;
}

export async function createStage(THREE, canvas, opts = {}) {
  const mobile = !!opts.mobile;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
  const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  if (opts.hdrUrl) {
    try {
      const hdr = await new HDRLoader().loadAsync(opts.hdrUrl);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose(); pmrem.dispose();
    } catch (e) {
      const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
  }
  scene.environmentIntensity = 0.85;
  scene.environmentRotation.y = 1.9;

  // floor: shadow only (the page is the floor). The shadow fades out radially around uFadeC (world xz) so the
  // edge of the shadow camera's box never shows as a straight cut; default radii are huge (no fade).
  const fade = { uFadeC: { value: new THREE.Vector2(0, 0) }, uFade: { value: new THREE.Vector2(1e5, 2e5) } };
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.14 });
  floorMat.onBeforeCompile = (sh) => {
    sh.uniforms.uFadeC = fade.uFadeC; sh.uniforms.uFade = fade.uFade;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFadeW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFadeW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFadeW;\nuniform vec2 uFadeC;\nuniform vec2 uFade;')
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.a *= 1.0 - smoothstep(uFade.x, uFade.y, distance(vFadeW, uFadeC));\n#include <tonemapping_fragment>');
  };
  floorMat.customProgramCacheKey = () => 'ox81-floor-fade';
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  function floorFade(cx = 0, cz = 0, r0 = 1e5, r1 = 2e5) { fade.uFadeC.value.set(cx, cz); fade.uFade.value.set(r0, r1); }

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-9, 16, -6); key.castShadow = true;
  const sm = mobile ? 1024 : 2048;
  key.shadow.mapSize.set(sm, sm); key.shadow.radius = 6; key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 80 });
  scene.add(key); scene.add(key.target);

  const camera = new THREE.PerspectiveCamera(16.2, 1, 1, 2000);
  let W = 1, H = 1, rig = null;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    if (rig) setRig(rig);
  }
  function setRig(r) {
    rig = r;
    const el = THREE.MathUtils.degToRad(r.el), az = THREE.MathUtils.degToRad(r.az);
    camera.fov = r.fov;
    camera.position.set(r.tx - r.dist * Math.sin(az) * Math.cos(el), r.ty + r.dist * Math.sin(el), r.tz + r.dist * Math.cos(az) * Math.cos(el));
    camera.up.set(0, 1, 0);
    camera.lookAt(r.tx, r.ty, r.tz);
    const cx = r.sx * W, cy = r.sy * H;
    camera.setViewOffset(W, H, -(cx - W / 2), -(cy - H / 2), W, H);
    camera.updateProjectionMatrix();
    // keep the key light's shadow box on the subject
    key.position.set(r.tx - 9, 16, r.tz - 6); key.target.position.set(r.tx, 0, r.tz); key.target.updateMatrixWorld();
  }
  function shadowBox(half) {
    Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
    key.shadow.camera.updateProjectionMatrix();
  }
  function project(v) {
    const p = v.clone().project(camera);
    return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H, p.z];
  }
  function render() { renderer.render(scene, camera); }
  resize();
  return { renderer, scene, camera, key, floor, floorFade, setRig, resize, render, project, shadowBox, get size() { return [W, H]; }, dpr };
}

// Heat light + floor glow under pin 1 (only v1 is hot).
export function createPinHeat(THREE, scene) {
  const light = new THREE.PointLight(0xff4b12, 1.6, 5, 2);
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,75,18,0.9)'); gr.addColorStop(0.35, 'rgba(255,75,18,0.35)'); gr.addColorStop(1, 'rgba(255,75,18,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  glow.rotation.x = -Math.PI / 2;
  scene.add(light); scene.add(glow);
  return { light, glow };
}

// Baked contact shadow under a package body.
export function contactShadow(THREE, S) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.filter = 'blur(18px)'; g.fillStyle = 'rgba(18,19,21,1)'; g.fillRect(44, 44, 168, 168);
  const t = new THREE.CanvasTexture(c);
  const ao = new THREE.Mesh(new THREE.PlaneGeometry(S * 1.5, S * 1.5), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.55, depthWrite: false }));
  ao.rotation.x = -Math.PI / 2; ao.position.y = 0.002; ao.name = 'contact-shadow';
  return ao;
}
