// Run with Node's test runner. Reuse an installed Playwright via COUNTER_PLAYWRIGHT_MODULE.
// Camera and pose input are simulated; the real React UI and counting engines run locally.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';
import {createServer} from 'vite';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.COUNTER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
let server;
let browser;
let baseURL;
const probe = randomUUID();

before(async () => {
  server = await createServer({
    root, logLevel: 'error',
    server: {host: '127.0.0.1', port: 0, hmr: false, watch: null},
    optimizeDeps: {exclude: ['@mediapipe/tasks-vision']},
    plugins: [{
      name: 'counter-local-test-input', enforce: 'pre',
      resolveId(id) { if (id === '@mediapipe/tasks-vision') return '\0counter-test-vision'; },
      load(id) {
        if (id !== '\0counter-test-vision') return;
        return `
          export class FilesetResolver { static async forVisionTasks() { return {}; } }
          export class PoseLandmarker {
            static POSE_CONNECTIONS = [];
            static async createFromOptions() { return new PoseLandmarker(); }
            detectForVideo() {
              if (window.__counterQA.inferenceFailure) throw new Error('simulated inference failure');
              return {landmarks: window.__counterQA.landmarks ? [window.__counterQA.landmarks] : []};
            }
            close() {}
          }
          export class DrawingUtils { drawLandmarks() {} drawConnectors() {} }
        `;
      },
      configureServer(local) {
        local.middlewares.use('/__counter_local_probe', (_request, response) => response.end(probe));
      },
    }],
  });
  await server.listen();
  baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--no-proxy-server', '--mute-audio']});
});
after(async () => { await browser?.close(); await server?.close(); });

function scenario(name, body) {
  test(name, async () => {
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === baseURL || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
      const h = window.__counterQA = {now: 0, landmarks: null, requests: [], deferCamera: false};
      const frames = new Map();
      let frameId = 0;
      window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
      window.cancelAnimationFrame = (id) => frames.delete(id);
      performance.now = () => h.now;
      h.step = async (spec, count) => {
        h.landmarks = spec ? Array.from({length: 33}, () => ({x: 0, y: 0, visibility: 0})) : null;
        if (spec) {
          if (spec.head !== undefined) for (const i of [0, 2, 5, 7, 8]) h.landmarks[i] = {x: 0.5, y: spec.head, visibility: 0.9};
          if (spec.shoulder !== undefined) {
            h.landmarks[11] = {x: 0.4, y: spec.shoulder, visibility: 0.9};
            h.landmarks[12] = {x: 0.6, y: spec.shoulder, visibility: 0.9};
          }
        }
        for (let i = 0; i < count; i += 1) {
          h.now += 33;
          const callbacks = [...frames.values()];
          frames.clear();
          for (const callback of callbacks) callback(h.now);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      const sources = new WeakMap();
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 10000 && h.deferMetadata) h.expireMetadata = () => callback(...args);
        return nativeSetTimeout(callback, delay, ...args);
      };
      Object.defineProperties(HTMLMediaElement.prototype, {
        srcObject: {configurable: true, get() { return sources.get(this) ?? null; }, set(stream) {
          sources.set(this, stream);
          if (stream && !h.deferMetadata) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
        }},
        readyState: {configurable: true, get() { return 4; }},
        currentTime: {configurable: true, get() { return h.now / 1000; }},
      });
      Object.defineProperties(HTMLVideoElement.prototype, {
        videoWidth: {configurable: true, get() { return h.landscape ? 960 : 640; }},
        videoHeight: {configurable: true, get() { return h.landscape ? 640 : 960; }},
      });
      HTMLMediaElement.prototype.play = async () => {
        if (h.playFailure) throw new Error('simulated video failure');
        if (h.deferPlay) await new Promise((resolve) => {h.finishPlay = resolve;});
      };
      const draw = () => {if (h.drawingFailure) throw new Error('simulated drawing failure');};
      CanvasRenderingContext2D.prototype.drawImage = draw;
      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') OffscreenCanvasRenderingContext2D.prototype.drawImage = draw;
      Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
        async enumerateDevices() {
          if (h.enumerationFailure) throw new Error('simulated device-list failure');
          return ['front', 'back'].map((id) => ({kind: 'videoinput', deviceId: id, label: id, groupId: '', toJSON() {return this;}}));
        },
        getUserMedia(constraints) {
          return new Promise((resolve, reject) => {
            const request = {id: h.requests.length, constraints, stopped: false};
            request.stream = {id: String(request.id), getTracks: () => [{stop() {request.stopped = true;}}]};
            request.resolve = () => resolve(request.stream);
            request.reject = () => reject(new Error('simulated camera failure'));
            h.requests.push(request);
            if (!h.deferCamera) request.resolve();
          });
        },
      }});
    });
    try {
      const response = await context.request.get(`${baseURL}/__counter_local_probe`);
      assert.equal(await response.text(), probe, 'probe must arrive at this local server');
      await page.goto(baseURL);
      await page.getByRole('button', {name: '开启摄像头', exact: true}).waitFor();
      await body(page);
      assert.deepEqual(errors, [], 'there must be no uncaught UI error');
      if (process.env.COUNTER_QA_OUTPUT) {
        await mkdir(process.env.COUNTER_QA_OUTPUT, {recursive: true});
        await page.screenshot({path: path.join(process.env.COUNTER_QA_OUTPUT, name.replace(/[^a-z0-9-]/g, '_') + '.png'), fullPage: true});
      }
    } finally { await context.close(); }
  });
}

const STAND = {head: 0.2, shoulder: 0.35};
const BOW = {head: 0.52, shoulder: 0.5};
const KNEEL = {head: 0.45, shoulder: 0.6};
const BOTTOM = {head: 0.78, shoulder: 0.72};
const step = (page, spec, frames) => page.evaluate(([pose, count]) => window.__counterQA.step(pose, count), [spec, frames]);
const count = async (page) => Number(await page.locator('.tabular-nums').first().textContent());
async function start(page) {
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.getByRole('button', {name: '开始计数', exact: true}).click();
  await step(page, STAND, 75);
}
async function ramp(page, from, to, frames) {
  for (let i = 1; i <= frames; i += 1) await step(page, {head: from.head + (to.head - from.head) * i / frames, shoulder: from.shoulder + (to.shoulder - from.shoulder) * i / frames}, 1);
}
async function toBottom(page) {
  await ramp(page, STAND, BOW, 12); await step(page, BOW, 12);
  await ramp(page, BOW, KNEEL, 10); await step(page, KNEEL, 12);
  await ramp(page, KNEEL, BOTTOM, 10); await step(page, BOTTOM, 35);
}

scenario('normal-cycle-and-pause', async (page) => {
  await start(page); await toBottom(page);
  await ramp(page, BOTTOM, STAND, 15); await step(page, STAND, 25);
  assert.equal(await count(page), 1);
  await page.getByRole('button', {name: '暂停计数', exact: true}).click();
  await toBottom(page); await step(page, STAND, 40);
  assert.equal(await count(page), 1);
  await page.getByRole('button', {name: '开始计数', exact: true}).click();
  await step(page, STAND, 75); await toBottom(page);
  await ramp(page, BOTTOM, STAND, 15); await step(page, STAND, 25);
  assert.equal(await count(page), 2);
});

scenario('reset-discards-unfinished-cycle', async (page) => {
  await start(page); await toBottom(page);
  await page.getByRole('button', {name: '计数清零', exact: true}).click();
  await step(page, STAND, 45);
  assert.equal(await count(page), 0, 'a cycle started before reset must never be counted afterward');
});

scenario('mode-switch-requires-new-setup', async (page) => {
  await start(page); await toBottom(page);
  await page.getByRole('button', {name: /^磕头数/}).click();
  await page.getByText('请在画面中保持跪坐', {exact: true}).waitFor();
  await step(page, STAND, 45);
  assert.equal(await count(page), 0);
});

scenario('smart-calibration-resets-smart-engine', async (page) => {
  await start(page); await toBottom(page);
  await page.getByRole('button', {name: /参数设置|设置参数/}).click();
  await page.getByRole('button', {name: /校准站立基线|重新准备姿态/}).click();
  await step(page, STAND, 45);
  assert.equal(await count(page), 0);
  assert.equal(await page.getByText('校准中，请站好不动…', {exact: true}).count(), 0);
});

scenario('classic-calibration-without-pose-finishes', async (page) => {
  await page.getByRole('button', {name: /^经典引擎/}).click();
  await start(page);
  await page.getByRole('button', {name: '手动校准', exact: true}).click();
  await step(page, null, 140);
  assert.equal(await page.getByText('校准中，请站好不动…', {exact: true}).count(), 0);
  await page.getByText('未检测到清晰姿态，请站好后重新校准。', {exact: true}).waitFor();
  assert.equal(await count(page), 0);
});

scenario('cancel-pending-camera-request', async (page) => {
  await page.evaluate(() => {window.__counterQA.deferCamera = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.getByRole('button', {name: '取消开启', exact: true}).click();
  await page.evaluate(() => window.__counterQA.requests[0].resolve());
  await page.getByRole('button', {name: '开启摄像头', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '开始计数', exact: true}).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
});

scenario('video-play-failure-releases-stream', async (page) => {
  await page.evaluate(() => {window.__counterQA.playFailure = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.getByText(/无法访问摄像头/).waitFor();
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
});

scenario('new-camera-survives-old-request-return', async (page) => {
  await page.evaluate(() => {window.__counterQA.deferCamera = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.waitForFunction(() => window.__counterQA.requests.length === 1);
  await page.getByRole('button', {name: '取消开启', exact: true}).click();
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.waitForFunction(() => window.__counterQA.requests.length === 2);
  await page.evaluate(() => window.__counterQA.requests[1].resolve());
  await page.getByRole('button', {name: '关闭摄像头', exact: true}).waitFor();
  await page.evaluate(() => window.__counterQA.requests[0].resolve());
  const state = await page.evaluate(() => ({oldStopped: window.__counterQA.requests[0].stopped, newStopped: window.__counterQA.requests[1].stopped, source: document.querySelector('video').srcObject.id}));
  assert.deepEqual(state, {oldStopped: true, newStopped: false, source: '1'});
});

scenario('metadata-timeout-releases-camera', async (page) => {
  await page.evaluate(() => {window.__counterQA.deferMetadata = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.waitForFunction(() => !!window.__counterQA.expireMetadata);
  await page.evaluate(() => window.__counterQA.expireMetadata());
  await page.getByText(/无法访问摄像头/).waitFor();
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
});

scenario('cancel-while-video-play-is-pending', async (page) => {
  await page.evaluate(() => {window.__counterQA.deferPlay = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.waitForFunction(() => !!window.__counterQA.finishPlay);
  await page.getByRole('button', {name: '取消开启', exact: true}).click();
  await page.evaluate(() => window.__counterQA.finishPlay());
  await page.getByRole('button', {name: '开启摄像头', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
  assert.equal(await page.getByRole('button', {name: '开始计数', exact: true}).isDisabled(), true);
});

scenario('device-list-failure-keeps-camera-running', async (page) => {
  await page.evaluate(() => {window.__counterQA.enumerationFailure = true;});
  await page.getByRole('button', {name: '开启摄像头', exact: true}).click();
  await page.getByRole('button', {name: '关闭摄像头', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '开始计数', exact: true}).isEnabled(), true);
});

scenario('inference-failure-stops-with-message', async (page) => {
  await start(page);
  await page.evaluate(() => {window.__counterQA.inferenceFailure = true;});
  await step(page, STAND, 1);
  await page.getByText(/姿态识别中断/).waitFor();
  assert.equal(await page.getByRole('button', {name: '开始计数', exact: true}).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
});

scenario('landscape-without-offscreen-canvas', async (page) => {
  await page.evaluate(() => {window.__counterQA.landscape = true; window.OffscreenCanvas = undefined;});
  await start(page);
  await toBottom(page); await ramp(page, BOTTOM, STAND, 15); await step(page, STAND, 25);
  assert.equal(await count(page), 1);
});

scenario('drawing-failure-stops-with-message', async (page) => {
  await start(page);
  await page.evaluate(() => {window.__counterQA.drawingFailure = true;});
  await step(page, STAND, 1);
  await page.getByText(/画面处理异常/).waitFor();
  assert.equal(await page.getByRole('button', {name: '开始计数', exact: true}).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__counterQA.requests[0].stopped), true);
});

scenario('fractional-target-rejected-and-mobile-layout', async (page) => {
  await page.locator('input[type="number"]').first().fill('1.5');
  await page.getByRole('button', {name: '设为自定义提醒', exact: true}).click();
  await page.getByText('自定义提醒次数请输入大于 0 的整数。', {exact: true}).waitFor();
  const layout = await page.evaluate(() => ({width: innerWidth, content: document.documentElement.scrollWidth}));
  assert.ok(layout.content <= layout.width, 'mobile page must not overflow sideways');
});
