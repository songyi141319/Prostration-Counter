import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe.skipIf(process.platform !== 'win32')('Android 构建的失败中止', () => {
  function build(failure: string) {
    const root = mkdtempSync(path.join(tmpdir(), 'counter-build-'));
    directories.push(root);
    for (const sub of ['scripts', 'android', 'bin', 'java', 'sdk']) mkdirSync(path.join(root, sub));
    const script = path.join(root, 'scripts', 'build-android.ps1');
    copyFileSync(fileURLToPath(new URL('../build-android.ps1', import.meta.url)), script);
    const trace = path.join(root, 'trace.txt');
    for (const [command, phase] of [['npm', 'web'], ['npx', 'sync']]) {
      writeFileSync(path.join(root, 'bin', command + '.cmd'), `@echo off\r\necho ${phase}>>"%BUILD_TRACE%"\r\nexit /b ${failure === phase ? 7 : 0}\r\n`);
    }
    writeFileSync(path.join(root, 'android', 'gradlew.bat'), `@echo off\r\necho apk>>"%BUILD_TRACE%"\r\nexit /b ${failure === 'apk' ? 7 : 0}\r\n`);
    const environment = {...process.env};
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
    const originalPath = pathKey ? environment[pathKey] : '';
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
    environment.Path = path.join(root, 'bin') + path.delimiter + originalPath;
    environment.BUILD_TRACE = trace;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-JavaHome', path.join(root, 'java'), '-AndroidSdkRoot', path.join(root, 'sdk')], {
      env: environment,
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    return {result, phases: readFileSync(trace, 'utf8').trim().split(/\r?\n/)};
  }

  it.each([
    ['web', ['web']],
    ['sync', ['web', 'sync']],
    ['apk', ['web', 'sync', 'apk']],
  ])('%s 失败时不再继续并返回失败', (failure, phases) => {
    const {result, phases: actual} = build(failure as string);
    expect(result.status, result.stderr).not.toBe(0);
    expect(actual).toEqual(phases);
  });

  it('只有全部步骤成功才成功退出', () => {
    const {result, phases} = build('none');
    expect(result.status, result.stderr).toBe(0);
    expect(phases).toEqual(['web', 'sync', 'apk']);
  });
});
