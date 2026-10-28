import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import https from 'https';
import path from 'path';
import {pipeline} from 'node:stream/promises';

const dir = path.join(process.cwd(), 'public', 'models');
const modelPath = path.join(dir, 'pose_landmarker_lite.task');
const temporaryPath = `${modelPath}.download-${randomUUID()}`;
const modelURL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

function download(url: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {timeout: 30000}, async (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) {
          reject(new Error('模型下载重定向无效或次数过多。'));
          return;
        }
        try {
          await download(new URL(response.headers.location, url).href, redirects + 1);
          resolve();
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`模型下载失败（HTTP ${response.statusCode ?? '未知'}）。`));
        return;
      }
      try {
        await pipeline(response, createWriteStream(temporaryPath, {flags: 'wx'}));
        if ((await stat(temporaryPath)).size === 0) throw new Error('下载的模型文件为空。');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    request.on('timeout', () => request.destroy(new Error('模型下载超时，请检查网络后重试。')));
    request.on('error', reject);
  });
}

try {
  await mkdir(dir, {recursive: true});
  await download(modelURL);
  await rename(temporaryPath, modelPath);
  process.stdout.write('模型下载完成。\n');
} catch (error) {
  await rm(temporaryPath, {force: true});
  process.stderr.write(`模型下载失败：${error instanceof Error ? error.message : '未知错误'}\n`);
  process.exitCode = 1;
}
