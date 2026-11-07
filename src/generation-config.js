import { defaultSettings } from './defaults.js';

const FILE_TYPE = 'st-image-hub-generation-config';

// 配置文件只携带生图相关字段，避免导入时改动聊天行为、整理 API 或参考图库。
export const GENERATION_FIELDS = {
  serviceUrl: '服务地址', apiKey: 'API 密钥', headers: '自定义请求头', model: '模型',
  timeoutMs: '超时', normalizeImagePrompt: '压缩提示词', maxImagePromptChars: '提示词长度上限',
  imageSafetyPrefix: '图片安全前缀', imageSize: '图片尺寸', imageN: '图片数量',
  retryMaxAttempts: '最大请求次数', retryDelayMs: '重试间隔', retryStatuses: '重试状态码',
  promptTemplate: '生图模板', responseImageRegex: '图片响应正则', extraBody: '额外请求体',
  referenceEnabled: '启用参考图', referenceRequestMode: '图生图请求格式',
  referenceServiceUrl: '图生图地址', referenceJsonField: '参考图字段名',
  referenceImageDetail: '图片 detail', referenceMaxCharacters: '最多匹配角色数',
  referenceImagesPerCharacter: '每角色参考图数', referenceMaxImageMB: '参考图大小上限',
  referenceMaxDimension: '参考图最长边', referenceCaseSensitive: '角色匹配区分大小写',
  referencePromptTemplate: '图生图模板',
};

const NUMBER_LIMITS = {
  timeoutMs: [1000, Infinity], maxImagePromptChars: [0, Infinity], imageN: [1, Infinity],
  retryMaxAttempts: [1, Infinity], retryDelayMs: [0, Infinity],
  referenceMaxCharacters: [1, 8], referenceImagesPerCharacter: [1, 8],
  referenceMaxImageMB: [1, 32], referenceMaxDimension: [512, 4096],
};
const ENUM_VALUES = {
  referenceRequestMode: ['auto', 'multipart-edit', 'chat-multimodal', 'json-reference'],
  referenceImageDetail: ['auto', 'high', 'low'],
};

export function validateImageHeaders(rows) {
  if (!Array.isArray(rows)) throw new Error('自定义请求头必须是键值行数组');
  const names = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') {
      throw new Error(`请求头第 ${index + 1} 行必须包含字符串 name 和 value`);
    }
    const name = row.name.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error(`请求头第 ${index + 1} 行名称无效`);
    if (names.has(name)) throw new Error(`请求头第 ${index + 1} 行名称重复`);
    names.add(name);
    // 由 Headers 检查浏览器实际接受的值；错误只报告行号，避免泄漏鉴权内容。
    try { new Headers([[name, row.value]]); } catch { throw new Error(`请求头第 ${index + 1} 行值无效`); }
  }
}

export function imageRequestHeaders(settings, mode) {
  validateImageHeaders(settings.headers);
  const headers = new Headers();
  if (mode !== 'multipart-edit') headers.set('Content-Type', 'application/json');
  if (settings.apiKey) headers.set('Authorization', `Bearer ${settings.apiKey}`);
  for (const { name, value } of settings.headers) {
    if (mode === 'multipart-edit' && name.trim().toLowerCase() === 'content-type') {
      throw new Error('multipart 图生图不能自定义 Content-Type，请删除该请求头，由浏览器生成上传 boundary');
    }
    headers.set(name.trim(), value);
  }
  return Object.fromEntries(headers);
}

export function validateGenerationConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config 必须是配置对象');
  if (!Object.keys(config).length) throw new Error('配置文件没有可导入的字段');
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(GENERATION_FIELDS, key)) throw new Error(`不支持的配置字段：${key}`);
    const label = GENERATION_FIELDS[key];
    if (key === 'headers') { validateImageHeaders(value); continue; }
    if (typeof value !== typeof defaultSettings[key]) throw new Error(`${label}的类型无效`);
    if (NUMBER_LIMITS[key]) {
      const [min, max] = NUMBER_LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}超出允许范围`);
    }
    if (ENUM_VALUES[key] && !ENUM_VALUES[key].includes(value)) throw new Error(`${label}选项无效`);
    if (['serviceUrl', 'referenceServiceUrl'].includes(key) && value !== '') {
      let url;
      try { url = new URL(value); } catch { throw new Error(`${label}必须是完整 HTTP(S) 地址`); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}必须使用 HTTP(S)`);
    }
    if (key === 'extraBody' && value.trim()) {
      let body;
      try { body = JSON.parse(value); } catch { throw new Error('额外请求体必须是有效 JSON 对象'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('额外请求体必须是 JSON 对象');
    }
    if (key === 'responseImageRegex' && value.trim()) {
      const slash = value.trim().match(/^\/([\s\S]*)\/([a-z]*)$/i);
      try { new RegExp(slash ? slash[1] : value.trim(), slash ? slash[2] : 'g'); }
      catch { throw new Error('图片响应正则无效'); }
    }
    if (key === 'retryStatuses' && value !== '' && !/^\s*[1-5]\d{2}(\s*,\s*[1-5]\d{2})*\s*$/.test(value)) {
      throw new Error('重试状态码必须是逗号分隔的 HTTP 状态码');
    }
  }
}

export function generationConfigFile(settings, includeSecrets) {
  const config = Object.fromEntries(Object.keys(GENERATION_FIELDS)
    .filter(key => includeSecrets || !['apiKey', 'headers'].includes(key))
    .map(key => [key, structuredClone(settings[key])]));
  validateGenerationConfig(config);
  return { type: FILE_TYPE, version: 1, exportedAt: new Date().toISOString(), config };
}

export function readGenerationConfig(text) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('文件必须是有效 JSON'); }
  if (file?.type !== FILE_TYPE) throw new Error('请选择 Image Hub 生图配置文件');
  if (file.version !== 1) throw new Error(`不支持的配置版本：${file.version}`);
  validateGenerationConfig(file.config);
  return structuredClone(file.config);
}

export function settingsWithGenerationConfig(settings, config) {
  validateGenerationConfig(config);
  const next = { ...settings, ...structuredClone(config) };
  // auto 会随地址切换到 multipart；在应用配置前就阻止无效的上传请求头组合。
  const multipart = next.referenceRequestMode === 'multipart-edit'
    || (next.referenceRequestMode === 'auto'
      && /\/images\/edits(?:\?|$|\/)?/i.test(next.referenceServiceUrl || next.serviceUrl));
  imageRequestHeaders(next, multipart ? 'multipart-edit' : 'text-only');
  return next;
}
