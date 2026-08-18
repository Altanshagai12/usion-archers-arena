/**
 * three.js renderer, camera and lighting.
 *
 * The camera sits behind and slightly above the local archer, looking
 * down-range at the opponent — the over-the-shoulder view the game is played
 * from. It swings a little with the aim so pulling the bow feels connected to
 * the world rather than to a slider.
 *
 * Two embedded-WebView rules are baked in here, both of which have broken real
 * Usion games before:
 *
 *  1. Never build the renderer while the frame is 0×0 — the host shows a
 *     loading state before revealing the iframe, and a canvas created at that
 *     moment never recovers. `waitForViewport` gates *only* the scene; the
 *     network connect must never wait on it.
 *  2. Drive resizing from a ResizeObserver on the mount element. Embedded
 *     WebViews do not reliably fire window `resize` when the host reveals us.
 */

import * as THREE from 'three';

export interface Viewport {
  width: number;
  height: number;
}

export interface ScenePalette {
  sky: [number, number];
  fog: number;
  sun: number;
  ambient: number;
}

export interface CameraShot {
  /** Feet position of the archer we are standing behind. */
  origin: THREE.Vector3;
  /** +1 shoots toward +z, -1 toward -z. */
  facing: 1 | -1;
  pitch: number;
}

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  sun: THREE.DirectionalLight;
  setPalette(palette: ScenePalette): void;
  placeCamera(shot: CameraShot): void;
  render(): void;
  dispose(): void;
}

/** Resolve once the mount element has a real size. */
export function waitForViewport(mount: HTMLElement): Promise<Viewport> {
  const measure = (): Viewport => ({
    width: mount.clientWidth || window.innerWidth,
    height: mount.clientHeight || window.innerHeight,
  });

  const initial = measure();
  if (initial.width > 0 && initial.height > 0) return Promise.resolve(initial);

  return new Promise((resolve) => {
    const observer = new ResizeObserver(() => {
      const size = measure();
      if (size.width > 0 && size.height > 0) {
        observer.disconnect();
        resolve(size);
      }
    });
    observer.observe(mount);
    // Belt and braces: some WebViews reveal without firing the observer.
    window.setTimeout(() => {
      observer.disconnect();
      resolve(measure());
    }, 4000);
  });
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    return false;
  }
}

function makeSkyTexture(top: number, bottom: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
    gradient.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 2, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

/** Over-the-shoulder offsets, in metres, relative to the archer's feet. */
const EYE_BACK = 4.4;
const EYE_UP = 2.5;
const EYE_SIDE = 0.5;
const LOOK_AHEAD = 18;
const LOOK_UP = 1.3;

export function createScene(mount: HTMLElement, viewport: Viewport): SceneHandles {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  // Low-end phones are the target device; 2 is plenty and 3 melts them.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Long far plane: the ridge line sits ~200 m out behind the target.
  const camera = new THREE.PerspectiveCamera(
    55,
    viewport.width / Math.max(1, viewport.height),
    0.3,
    600,
  );
  camera.position.set(0, 3, -5);
  camera.lookAt(0, 1.5, 10);

  const root = new THREE.Group();
  scene.add(root);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-30, 46, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -20;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xffffff, 0x404040, 1.15);
  scene.add(ambient);

  let skyTexture: THREE.Texture | null = null;

  const setPalette = (palette: ScenePalette): void => {
    skyTexture?.dispose();
    skyTexture = makeSkyTexture(palette.sky[0], palette.sky[1]);
    scene.background = skyTexture;
    // Fog starts past the target so the ridge line hazes out, not the action.
    scene.fog = new THREE.Fog(palette.fog, 90, 380);
    sun.color.setHex(palette.sun);
    ambient.color.setHex(palette.sky[1]);
    ambient.groundColor.setHex(palette.ambient);
  };

  const eye = new THREE.Vector3();
  const focus = new THREE.Vector3();

  const placeCamera = (shot: CameraShot): void => {
    const { origin, facing, pitch } = shot;

    // Sit behind and just off the archer's shoulder. Pitch lifts the look point
    // so a high-angle shot shows more sky; there is no lateral aim to follow.
    eye.set(origin.x + EYE_SIDE * facing, origin.y + EYE_UP, origin.z - EYE_BACK * facing);

    focus.set(
      origin.x,
      origin.y + LOOK_UP + Math.sin(pitch) * 9,
      origin.z + LOOK_AHEAD * facing,
    );

    camera.position.copy(eye);
    camera.lookAt(focus);

    // Keep the shadow frustum over the action rather than the world origin.
    sun.target.position.set(origin.x, 0, origin.z + 20 * facing);
    sun.position.set(origin.x - 30, 46, origin.z + 20 * facing);
    sun.target.updateMatrixWorld();
  };

  const observer = new ResizeObserver(() => {
    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  observer.observe(mount);

  return {
    renderer,
    scene,
    camera,
    root,
    sun,
    setPalette,
    placeCamera,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      observer.disconnect();
      skyTexture?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
