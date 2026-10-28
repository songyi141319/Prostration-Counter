import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const script = fileURLToPath(new URL('../../download.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function runDownload(scenario: string, existing = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'counter-download-'));
  directories.push(directory);
  const models = path.join(directory, 'public', 'models');
  mkdirSync(models, {recursive: true});
  const model = path.join(models, 'pose_landmarker_lite.task');
  if (existing) writeFileSync(model, 'previous working model');
  const preload = path.join(directory, 'https-fixture.cjs');
  writeFileSync(preload, `
    const https = require('node:https');
    const {EventEmitter} = require('node:events');
    const {PassThrough} = require('node:stream');
    let requests = 0;
    https.get = (_url, options, callback) => {
      const respond = typeof options === 'function' ? options : callback;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => { if (error) request.emit('error', error); };
      process.nextTick(() => {
        requests += 1;
        const scenario = process.env.DOWNLOAD_SCENARIO;
        if (scenario === 'network-error') { request.emit('error', new Error('connection failed')); return; }
        if (scenario === 'timeout') { request.emit('timeout'); return; }
        const response = new PassThrough();
        response.statusCode = scenario === 'http-error' ? 503 : scenario === 'redirect-error' && requests === 1 ? 302 : scenario === 'redirect-error' ? 404 : 200;
        response.headers = response.statusCode === 302 ? {location: 'https://example.invalid/model'} : {};
        respond(response);
        if (scenario === 'interrupted') {
          response.write('partial');
          process.nextTick(() => response.destroy(new Error('connection interrupted')));
        } else {
          response.end(scenario === 'empty' ? '' : response.statusCode === 200 ? 'downloaded model' : 'service unavailable');
        }
      });
      return request;
    };
  `);
  const result = spawnSync(process.execPath, ['--require', preload, '--import', loader, script], {
    cwd: directory,
    env: {...process.env, DOWNLOAD_SCENARIO: scenario},
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  return {result, model, models};
}

describe('模型下载的真实命令入口', () => {
  it('成功后才用完整下载替换模型', () => {
    const {result, model, models} = runDownload('success');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(model, 'utf8')).toBe('downloaded model');
    expect(readdirSync(models)).toEqual(['pose_landmarker_lite.task']);
  });

  it.each(['http-error', 'redirect-error', 'network-error', 'interrupted', 'empty', 'timeout'])(
    '%s 时返回失败并保留已有可用模型', (scenario) => {
      const {result, model, models} = runDownload(scenario);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).not.toBe(0);
      expect(readFileSync(model, 'utf8')).toBe('previous working model');
      expect(readdirSync(models)).toEqual(['pose_landmarker_lite.task']);
    },
  );

  it('首次下载失败时不留下假模型', () => {
    const {result, models} = runDownload('http-error', false);
    expect(result.status, result.stderr).not.toBe(0);
    expect(readdirSync(models)).toEqual([]);
  });
});
