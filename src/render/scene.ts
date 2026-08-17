/**
 * three.js renderer, camera and lighting.
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

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  setPalette(palette: ScenePalette): void;
  frameArena(left: number, right: number, top: number): void;
  render(): void;
  dispose(): void;
}

export interface ScenePalette {
  sky: [number, number];
  fog: number;
  sun: number;
  ambient: number;
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
  const camera = new THREE.PerspectiveCamera(
    38,
    viewport.width / Math.max(1, viewport.height),
    0.5,
    400,
  );
  camera.position.set(0, 6, 34);
  camera.lookAt(0, 3, 0);

  const root = new THREE.Group();
  scene.add(root);

  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-14, 26, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -10;
  sun.shadow.bias = -0.0012;
  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xffffff, 0x404040, 1.1);
  scene.add(ambient);

  let skyTexture: THREE.Texture | null = null;

  const setPalette = (palette: ScenePalette): void => {
    skyTexture?.dispose();
    skyTexture = makeSkyTexture(palette.sky[0], palette.sky[1]);
    scene.background = skyTexture;
    scene.fog = new THREE.Fog(palette.fog, 55, 190);
    sun.color.setHex(palette.sun);
    ambient.color.setHex(palette.sky[1]);
    ambient.groundColor.setHex(palette.ambient);
  };

  /**
   * Fit both archers on screen. Portrait phones are much narrower than the
   * arena is wide, so the distance is solved from the horizontal FOV too and
   * the wider of the two constraints wins.
   */
  const frameArena = (left: number, right: number, top: number): void => {
    const centreX = (left + right) / 2;
    const span = Math.max(6, right - left) * 1.18;
    const height = Math.max(6, top + 4);

    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);

    const distanceForWidth = span / 2 / Math.tan(hFov / 2);
    const distanceForHeight = height / 2 / Math.tan(vFov / 2);
    const distance = Math.max(distanceForWidth, distanceForHeight) + 6;

    camera.position.set(centreX, Math.max(4.5, height * 0.52), distance);
    camera.lookAt(centreX, Math.max(2.2, height * 0.34), 0);

    sun.target.position.set(centreX, 0, 0);
    sun.position.set(centreX - 16, 28, 20);
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
    ambient,
    setPalette,
    frameArena,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      observer.disconnect();
      skyTexture?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
