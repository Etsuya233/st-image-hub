import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultSettings } from '../src/defaults.js';
import {
  GENERATION_FIELDS, generationConfigFile, readGenerationConfig,
  settingsWithGenerationConfig, imageRequestHeaders,
} from '../src/generation-config.js';

const settings = () => ({ ...structuredClone(defaultSettings),
  apiKey: 'test-secret', headers: [{ name: 'X-Project', value: 'project-secret' }],
});

test('配置文件完整往返，范围不包含整理 API、预设、图库和聊天行为', () => {
  const current = settings();
  current.extraBody = '{"quality":"high"}';
  const file = generationConfigFile(current, true);
  const config = readGenerationConfig(JSON.stringify(file));
  for (const key of Object.keys(GENERATION_FIELDS)) assert.deepEqual(config[key], current[key]);
  for (const key of ['summaryApiKey', 'summaryProfiles', 'referenceCharacters', 'mainPrompt', 'entryPoint', 'enabled', 'extractionRegex']) {
    assert.equal(Object.hasOwn(config, key), false);
  }
  const target = { ...settings(), summaryApiKey: 'keep', enabled: false };
  const merged = settingsWithGenerationConfig(target, config);
  assert.equal(merged.summaryApiKey, 'keep');
  assert.equal(merged.enabled, false);
  config.headers[0].value = 'changed';
  assert.equal(merged.headers[0].value, 'project-secret');
});

test('不含密钥的导出省略整个凭据字段，导入保留本机凭据；空值可清空', () => {
  const file = generationConfigFile(settings(), false);
  assert.equal(Object.hasOwn(file.config, 'apiKey'), false);
  assert.equal(Object.hasOwn(file.config, 'headers'), false);
  assert.equal(JSON.stringify(file).includes('test-secret'), false);
  assert.equal(JSON.stringify(file).includes('project-secret'), false);
  const current = settings();
  const merged = settingsWithGenerationConfig(current, readGenerationConfig(JSON.stringify(file)));
  assert.equal(merged.apiKey, current.apiKey);
  assert.deepEqual(merged.headers, current.headers);
  const cleared = settingsWithGenerationConfig(current, { apiKey: '', headers: [], referenceServiceUrl: '' });
  assert.equal(cleared.apiKey, '');
  assert.deepEqual(cleared.headers, []);
});

test('文件类型、版本和所有字段完整校验，失败不修改当前配置', () => {
  const current = settings();
  const before = structuredClone(current);
  assert.throws(() => readGenerationConfig('{'), /JSON/);
  assert.throws(() => readGenerationConfig('{"type":"other"}'), /配置文件/);
  const file = generationConfigFile(current, true);
  assert.throws(() => readGenerationConfig(JSON.stringify({ ...file, version: 2 })), /版本/);
  for (const config of [null, [], {}, { model: 2 }, { serviceUrl: 'file:///tmp/a' },
    { imageN: 0 }, { timeoutMs: 500 }, { referenceMaxCharacters: 9 }, { imageN: 1.5 },
    { referenceImageDetail: 'invalid' }, { extraBody: '[]' }, { extraBody: '{' },
    { responseImageRegex: '/[/' }, { retryStatuses: '429,no' }, { summaryApiKey: 'unexpected' },
    { headers: [{ name: 'Authorization', value: 'one' }, { name: 'authorization', value: 'two' }] },
    { headers: [{ name: 'bad name', value: 'x' }] }, { headers: [{ name: 'X-Key', value: 'secret\r\nvalue' }] },
  ]) {
    assert.throws(() => settingsWithGenerationConfig(current, config));
    assert.throws(() => readGenerationConfig(JSON.stringify({ ...file, config })));
    assert.deepEqual(current, before);
  }
});

test('请求头忽略大小写覆盖自动鉴权，JSON 自动设置 Content-Type', () => {
  const current = settings();
  current.headers.push({ name: 'aUtHoRiZaTiOn', value: 'Custom abc' });
  const headers = imageRequestHeaders(current, 'text-only');
  assert.equal(headers.authorization, 'Custom abc');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-project'], 'project-secret');
  assert.equal(Object.keys(headers).filter(key => /authorization/i.test(key)).length, 1);
  current.headers.push({ name: 'content-TYPE', value: 'application/custom+json' });
  assert.equal(imageRequestHeaders(current, 'chat-multimodal')['content-type'], 'application/custom+json');
});

test('multipart 由浏览器生成 Content-Type，显式和自动图生图模式均拒绝手写该头', () => {
  const current = settings();
  assert.equal(Object.hasOwn(imageRequestHeaders(current, 'multipart-edit'), 'content-type'), false);
  current.headers.push({ name: 'CONTENT-TYPE', value: 'multipart/form-data' });
  assert.throws(() => imageRequestHeaders(current, 'multipart-edit'), /Content-Type/);
  assert.throws(() => settingsWithGenerationConfig(current, { referenceRequestMode: 'multipart-edit' }), /Content-Type/);
  assert.throws(() => settingsWithGenerationConfig(current, { referenceServiceUrl: 'https://example.com/v1/images/edits' }), /Content-Type/);
});

// 在实际请求组装入口验证配置确实进入 JSON / multipart 请求，避免只测试独立辅助函数。
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const requestCode = source.slice(source.indexOf('function fillPromptTemplate('), source.indexOf('async function fetchWithTimeout('));
test('设置与请求日志隐藏全部自定义头，任意名称的凭据均不会写入日志', () => {
  const logging = source.slice(source.indexOf('function maskSecret('), source.indexOf('function safeStringify('));
  const context = vm.createContext({ clip: value => value });
  vm.runInContext(logging, context);
  const logged = vm.runInContext('sanitize({ settings: { headers: [{ name: "X-Project", value: "private-value" }] }, headers: { "X-Project": "private-value" } })', context);
  assert.equal(JSON.stringify(logged).includes('private-value'), false);
  assert.equal(logged.headers, '[请求头内容已隐藏]');
});
test('实际请求组装使用自定义鉴权和参考图，multipart 正文保留文件', async () => {
  const current = settings();
  current.headers = [{ name: 'authorization', value: 'Custom live-test' }];
  const context = vm.createContext({
    state: { settings: current }, imageRequestHeaders, FormData,
    normalizeImagePromptForBackend: prompt => ({ backendPrompt: prompt }),
    parseJsonLoose: text => text ? JSON.parse(text) : {},
    dataUrlToBlob: () => new Blob(['test-image'], { type: 'image/png' }),
    referenceFileName: filename => filename,
  });
  vm.runInContext(requestCode, context);
  const json = vm.runInContext('buildImageRequest("draw")', context);
  assert.equal(json.headers.authorization, 'Custom live-test');
  assert.equal(json.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(json.fetchBody).model, current.model);
  current.referenceRequestMode = 'multipart-edit';
  const request = vm.runInContext('buildImageRequest("draw", { characters: [{ id: "a", name: "秋元悦也" }], images: [{ characterId: "a", characterName: "秋元悦也", dataUrl: "test", fileName: "ref.png" }] })', context);
  assert.equal(request.headers.authorization, 'Custom live-test');
  assert.equal(Object.hasOwn(request.headers, 'content-type'), false);
  assert.equal(await request.fetchBody.get('image').text(), 'test-image');
  assert.match(request.fetchBody.get('prompt'), /图1：秋元悦也/);
  assert.doesNotMatch(JSON.parse(json.fetchBody).prompt, /参考图按上传顺序编号/);
  const encoded = new Request('https://example.com', { method: 'POST', headers: request.headers, body: request.fetchBody });
  assert.match(encoded.headers.get('content-type'), /^multipart\/form-data; boundary=/);
});

test('按实际附件顺序标注角色，多张参考图使用 multipart 数组字段上传', async () => {
  const current = settings();
  current.referenceRequestMode = 'auto';
  current.referenceServiceUrl = 'https://api.openai.com/v1/images/edits';
  current.referencePromptTemplate = '参考角色：{{characters}}，共 {{reference_count}} 张。\n{{prompt}}';
  const context = vm.createContext({
    state: { settings: current }, imageRequestHeaders, FormData,
    normalizeImagePromptForBackend: prompt => ({ backendPrompt: prompt }),
    parseJsonLoose: text => text ? JSON.parse(text) : {},
    dataUrlToBlob: dataUrl => new Blob([dataUrl], { type: 'image/png' }),
    referenceFileName: filename => filename,
  });
  vm.runInContext(requestCode, context);
  const request = vm.runInContext(`buildImageRequest("draw", {
    characters: [{ id: "a", name: "秋元悦也" }, { id: "b", name: "方亦楷" }],
    images: [
      { characterId: "a", characterName: "秋元悦也", dataUrl: "first-image", fileName: "first.png" },
      { characterId: "a", characterName: "秋元悦也", dataUrl: "second-image", fileName: "second.png" },
      { characterId: "b", characterName: "方亦楷", dataUrl: "third-image", fileName: "third.png" },
    ],
  })`, context);
  assert.equal(request.url, current.referenceServiceUrl);
  const encoded = new Request(request.url, { method: 'POST', headers: request.headers, body: request.fetchBody });
  const form = await encoded.formData();
  assert.equal(form.getAll('image').length, 0, '多图不能重复提交单值 image 参数');
  const images = form.getAll('image[]');
  assert.deepEqual(images.map(image => image.name), ['first.png', 'second.png', 'third.png']);
  assert.deepEqual(await Promise.all(images.map(image => image.text())), ['first-image', 'second-image', 'third-image']);
  const prompt = form.get('prompt').replaceAll('\r\n', '\n');
  assert.match(prompt, /图1：秋元悦也\n图2：秋元悦也\n图3：方亦楷/);
  assert.match(prompt, /参考角色：秋元悦也、方亦楷，共 3 张。\ndraw$/);
});

test('多模态和 JSON 参考图编号一致，JSON 单值字段只标注实际发送的图', () => {
  const current = settings();
  const context = vm.createContext({
    state: { settings: current }, imageRequestHeaders,
    normalizeImagePromptForBackend: prompt => ({ backendPrompt: prompt }),
    parseJsonLoose: () => ({}),
  });
  vm.runInContext(requestCode, context);
  const build = () => vm.runInContext(`buildImageRequest("draw", {
    characters: [
      { id: "a", name: "秋元悦也", notes: "短袖" },
      { id: "b", name: "方亦楷", notes: "长袖" },
    ],
    images: [
      { characterId: "a", characterName: "秋元悦也", dataUrl: "first-image" },
      { characterId: "b", characterName: "方亦楷", dataUrl: "second-image" },
    ],
  })`, context);

  current.referenceRequestMode = 'chat-multimodal';
  const content = JSON.parse(build().fetchBody).messages[0].content;
  assert.match(content[0].text, /图1：秋元悦也\n图2：方亦楷/);
  assert.deepEqual(content.slice(1).map(part => part.image_url.url), ['first-image', 'second-image']);

  current.referenceRequestMode = 'json-reference';
  current.referencePromptTemplate = '{{characters}}｜{{reference_count}}｜{{reference_notes}}\n{{prompt}}';
  const array = JSON.parse(build().fetchBody);
  assert.deepEqual(array.images, ['first-image', 'second-image']);
  assert.match(array.prompt, /图1：秋元悦也\n图2：方亦楷/);

  current.referenceJsonField = 'reference_image';
  const single = build();
  const body = JSON.parse(single.fetchBody);
  assert.equal(body.reference_image, 'first-image');
  assert.deepEqual(body.reference_characters, ['秋元悦也']);
  assert.match(body.prompt, /图1：秋元悦也/);
  assert.match(body.prompt, /秋元悦也｜1｜秋元悦也：短袖\ndraw$/);
  assert.doesNotMatch(body.prompt, /图2|方亦楷|长袖/);
  assert.equal(single.referenceContext.images.length, 1);
});
