import { GENERATION_FIELDS, generationConfigFile, readGenerationConfig } from './generation-config.js';

export function createGenerationConfigControls(panel, { readSettings, applyConfig, download, setStatus }) {
  const doc = panel.ownerDocument;
  const find = selector => panel.querySelector(selector);
  const list = find('#oair_image_headers');
  const preview = find('#oair_config_preview');
  const fileInput = find('#oair_config_file');
  const disposers = [];
  let pendingConfig = null;
  const listen = (element, event, handler) => {
    element.addEventListener(event, handler);
    disposers.push(() => element.removeEventListener(event, handler));
  };
  const reportError = error => setStatus(`生图配置操作失败：${error.message}`, 'error');
  const closePreview = () => {
    pendingConfig = null;
    preview.hidden = true;
    find('#oair_config_summary').textContent = '';
  };

  function addHeader({ name, value }) {
    const row = doc.createElement('div');
    row.className = 'oair-header-row';
    for (const [key, label, placeholder] of [
      ['name', '请求头名称', 'X-API-Key'], ['value', '请求头值', '请求头值'],
    ]) {
      const input = doc.createElement('input');
      input.dataset.headerField = key;
      input.setAttribute('aria-label', label);
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = key === 'name' ? name : value;
      row.appendChild(input);
    }
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'oair-btn danger';
    remove.dataset.removeHeader = '';
    remove.textContent = '删除';
    row.appendChild(remove);
    list.appendChild(row);
  }

  listen(list, 'click', event => {
    const button = event.target.closest('[data-remove-header]');
    if (button) button.closest('.oair-header-row').remove();
  });
  listen(find('#oair_header_add'), 'click', () => {
    addHeader({ name: '', value: '' });
    list.lastElementChild.querySelector('input').focus();
  });
  listen(find('#oair_config_export'), 'click', () => {
    try {
      const file = generationConfigFile(readSettings(), find('#oair_config_secrets').checked);
      download('st-image-hub-generation-config.json', JSON.stringify(file, null, 2));
      setStatus('生图配置已导出', 'ok');
    } catch (error) { reportError(error); }
  });
  listen(find('#oair_config_import'), 'click', () => fileInput.click());
  listen(fileInput, 'change', async () => {
    closePreview();
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.disabled = true;
    try {
      pendingConfig = readGenerationConfig(await file.text());
      const fields = Object.keys(pendingConfig).map(key => GENERATION_FIELDS[key]).join('、');
      const credentialSummary = ['apiKey', 'headers'].map(key => {
        if (!Object.hasOwn(pendingConfig, key)) return `${GENERATION_FIELDS[key]}：保留当前值`;
        const value = pendingConfig[key];
        return `${GENERATION_FIELDS[key]}：${value.length ? '替换' : '清空'}`;
      }).join('；');
      find('#oair_config_summary').textContent = [
        `文件：${file.name}`,
        `将覆盖 ${Object.keys(pendingConfig).length} 个字段：${fields}`,
        Object.hasOwn(pendingConfig, 'serviceUrl') ? `服务地址：${pendingConfig.serviceUrl || '（清空）'}` : '',
        Object.hasOwn(pendingConfig, 'model') ? `模型：${pendingConfig.model || '（清空）'}` : '',
        credentialSummary,
        '文件未包含的字段保留当前值。点击“应用配置”后保存。',
      ].filter(Boolean).join('\n');
      preview.hidden = false;
    } catch (error) { reportError(error); }
    finally { fileInput.value = ''; fileInput.disabled = false; }
  });
  listen(find('#oair_config_apply'), 'click', () => {
    try {
      applyConfig(pendingConfig);
      closePreview();
      setStatus('生图配置已导入并保存', 'ok');
    } catch (error) { reportError(error); }
  });
  listen(find('#oair_config_cancel'), 'click', closePreview);

  return {
    readHeaders() {
      return [...list.querySelectorAll('.oair-header-row')].map(row => ({
        name: row.querySelector('[data-header-field="name"]').value.trim(),
        value: row.querySelector('[data-header-field="value"]').value,
      }));
    },
    writeHeaders(headers) {
      list.replaceChildren();
      headers.forEach(addHeader);
    },
    dispose() { disposers.forEach(dispose => dispose()); pendingConfig = null; },
  };
}
