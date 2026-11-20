import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const pipeline = source.slice(source.indexOf('function imageMarkdown'), source.indexOf('async function onGenerationAfterCommands'));
const queue = source.slice(source.indexOf('function autoImageSourceIsCurrent'), source.indexOf('function readPanelSettings'));

function fixture() {
  const timers = new Map();
  const requests = [];
  const pending = [];
  const saved = [];
  const writes = [];
  const fallbackCalls = [];
  let nextTimer = 0;
  let chat = [];
  let chatId = 'A';
  const state = {
    settings: { enabled: true, processAssistantMessages: true, appendImageToMessage: true, serviceUrl: 'mock' },
    autoImageQueue: [], activeAutoImage: null, autoImageDrainTimer: null, autoImageEpoch: 0, autoImageSeen: new WeakSet(), currentRun: null,
  };
  const captureSource = messageId => ({ chat: { id: chatId, messageId, message: { ...chat[messageId] } } });
  const context = vm.createContext({
    state, captureSource, performance, generatedGallery: null,
    SillyTavern: { getContext: () => ({ chat }) },
    tavern: {
      getChatMessages: id => chat[id] ? [{ role: chat[id].is_user ? 'user' : chat[id].is_system ? 'system' : 'assistant', message: chat[id].mes }] : [],
      setChatMessages: async ([{ message_id, message }]) => {
        writes.push([chatId, message_id, message]);
        chat[message_id].mes = message;
      },
    },
    sourceIsCurrent: (snapshot, expected) => snapshot.chat.id === chatId
      && snapshot.chat.message.swipe_id === chat[snapshot.chat.messageId]?.swipe_id
      && chat[snapshot.chat.messageId]?.mes === expected,
    resetSteps() {}, setStatus() {}, updateStep() {}, setElapsed() {}, addLog() {},
    clip: text => text,
    setTimeout: callback => (timers.set(++nextTimer, callback), nextTimer),
    clearTimeout: id => timers.delete(id),
    resolveReferenceContext: () => ({ characters: [], images: [] }),
    collectImageUrls: data => [{ url: data.url }],
    saveGeneratedImage: async (url, { source }) => {
      saved.push([url, source.chat.id]);
      return { imagePath: url };
    },
    callImageApi: prompt => {
      requests.push(prompt);
      return new Promise((resolve, reject) => pending.push({
        finish: () => resolve({ data: { url: `/${prompt}.png` }, request: { body: { prompt } } }),
        fail: () => reject(new Error('mock failure')),
      }));
    },
    extractPicPrompts: text => ({
      prompts: text.startsWith('pic:') ? [text.slice(4)] : [],
      cleaned: 'cleaned',
    }),
    generateFallbackPromptFromMessage: async (message, options) => {
      fallbackCalls.push(options.historyEndId);
      return options.canContinue() ? message.message : null;
    },
  });
  vm.runInContext(pipeline + queue, context);
  async function tick() {
    const current = [...timers.values()];
    timers.clear();
    current.forEach(callback => callback());
    await new Promise(resolve => setImmediate(resolve));
  }
  function receive(mes, is_user = false) {
    chat.push({ mes, swipe_id: 0, is_user });
    return context.onMessageReceived(chat.length - 1);
  }
  return {
    state, requests, saved, writes, fallbackCalls, tick, receive, pending, context,
    switchChat(id) {
      chatId = id;
      const old = chat;
      chat = [];
      context.clearAutoImageQueue();
      return old;
    },
    restore(old) { chatId = 'A'; chat = old; context.clearAutoImageQueue(); },
    swipe(index) { chat[index].swipe_id++; },
    replace(index, replacement) { chat[index] = replacement; },
  };
}

test('事件立即返回，生图串行，两个回复的图片各自写回', async () => {
  const f = fixture();
  assert.equal(f.receive('pic:first'), undefined);
  assert.deepEqual(f.requests, []);
  await f.tick();
  assert.equal(f.receive('pic:second'), undefined);
  await f.tick();
  assert.deepEqual(f.requests, ['first']);
  f.pending.shift().finish();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.requests, ['first', 'second']);
  f.pending.shift().finish();
  await f.tick();
  assert.deepEqual(f.writes.map(([, id]) => id), [0, 1]);
});

test('换聊天清空等待任务，切回后已发出的图片仍只存图库', async () => {
  const f = fixture();
  f.receive('pic:running');
  await f.tick();
  f.receive('pic:dropped');
  const original = f.switchChat('B');
  f.restore(original);
  f.pending.shift().finish();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.requests, ['running']);
  assert.deepEqual(f.saved, [['/running.png', 'A']]);
  assert.deepEqual(f.writes, []);
});

test('关闭嵌入或原楼层被替换都只存图库', async () => {
  const f = fixture();
  f.receive('pic:off');
  await f.tick();
  f.state.settings.appendImageToMessage = false;
  f.pending.shift().finish();
  await f.tick();

  f.state.settings.appendImageToMessage = true;
  f.receive('pic:replaced');
  await f.tick();
  f.replace(1, { mes: 'pic:replaced', swipe_id: 0 });
  f.pending.shift().finish();
  await f.tick();

  assert.equal(f.saved.length, 2);
  assert.deepEqual(f.writes, []);
});

test('单个任务失败不堵队列，补救提示词的历史上限为原楼层', async () => {
  const f = fixture();
  f.state.settings.autoFallbackWhenNoPic = true;
  f.receive('pic:failure');
  f.receive('fallback');
  f.receive('pic:later');
  await f.tick();
  f.pending.shift().fail();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.requests, ['failure', 'fallback']);
  assert.deepEqual(f.fallbackCalls, [1]);
});

test('保留手动调用的 Promise 结果，自动队列等待手动任务结束', async () => {
  const f = fixture();
  const manual = f.context.processPromptToImage('phone', { previewOnly: true });
  f.receive('pic:automatic');
  await f.tick();
  assert.deepEqual(f.requests, ['phone']);
  f.pending.shift().finish();
  assert.equal((await manual).records[0].imagePath, '/phone.png');
  await f.tick();
  assert.deepEqual(f.requests, ['phone', 'automatic']);
});

test('两种模式沿用布尔设置，且和自动生图开关互不影响', () => {
  const select = { type: 'select-one', dataset: { oairSetting: 'appendImageToMessage' } };
  const auto = { type: 'checkbox', dataset: { oairSetting: 'processAssistantMessages' } };
  const context = vm.createContext({
    state: {
      settings: { appendImageToMessage: false, processAssistantMessages: true },
      generationConfigControls: { readHeaders: () => [], writeHeaders: () => {} },
    },
    qa: () => [select, auto],
  });
  vm.runInContext(
    source.slice(source.indexOf('function readPanelSettings'), source.indexOf('function getSettingsFromUi'))
    + source.slice(source.indexOf('function writeSettingsToUi'), source.indexOf('function loadSettings')),
    context,
  );
  context.writeSettingsToUi();
  assert.equal(select.value, 'gallery');
  assert.equal(context.readPanelSettings().appendImageToMessage, false);
  assert.equal(context.readPanelSettings().processAssistantMessages, true);
  select.value = 'embed';
  assert.equal(context.readPanelSettings().appendImageToMessage, true);
  assert.equal(context.readPanelSettings().processAssistantMessages, true);
});

for (const delayed of [false, true]) {
  for (const embed of [false, true]) {
    test(`正常/延后和保存模式独立组合 delay=${delayed} embed=${embed}`, async () => {
      const f = fixture();
      Object.assign(f.state.settings, { delayAutoImageOneReply: delayed, appendImageToMessage: embed });
      f.receive('question', true);
      f.receive('pic:first');
      await f.tick();
      assert.equal(f.requests.length, delayed ? 0 : 1);
      f.receive('follow up', true);
      await f.tick();
      assert.equal(f.requests.length, delayed ? 0 : 1);
      if (delayed) { f.receive('pic:second'); await f.tick(); }
      assert.deepEqual(f.requests, ['first']);
      f.pending.shift().finish();
      await f.tick();
      assert.equal(f.saved.length, 1);
      assert.deepEqual(f.writes.map(([, id]) => id), embed ? [1] : []);
      f.context.onMessageReceived(delayed ? 3 : 1);
      f.swipe(delayed ? 3 : 1);
      f.context.onMessageReceived(delayed ? 3 : 1);
      await f.tick();
      assert.deepEqual(f.requests, ['first']);
    });
  }
}

test('延后模式慢请求保持串行，切换对话清队列并禁止切回补贴', async () => {
  const f = fixture();
  f.state.settings.delayAutoImageOneReply = true;
  f.receive('pic:first');
  f.receive('pic:second');
  await f.tick();
  f.receive('pic:third');
  f.context.onMessageReceived(2);
  await f.tick();
  assert.deepEqual(f.requests, ['first']);
  const original = f.switchChat('B');
  f.restore(original);
  f.context.onMessageReceived(2);
  f.pending.shift().finish();
  await f.tick();
  await f.tick();
  assert.deepEqual(f.requests, ['first']);
  assert.deepEqual(f.saved, [['/first.png', 'A']]);
  assert.deepEqual(f.writes, []);
});

test('请求期间 swipe 只保存，重复事件和失败不自动收费重试', async () => {
  const f = fixture();
  f.receive('pic:first');
  f.context.onMessageReceived(0);
  await f.tick();
  f.swipe(0);
  f.context.onMessageReceived(0);
  f.pending.shift().finish();
  await f.tick();
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.writes, []);
  f.receive('pic:failure');
  await f.tick();
  f.pending.shift().fail();
  await f.tick();
  f.context.onMessageReceived(1);
  await f.tick();
  assert.deepEqual(f.requests, ['first', 'failure']);
});

test('延后模式自动总开关关闭时不入队，旧楼层事件不触发', async () => {
  const f = fixture();
  f.state.settings.delayAutoImageOneReply = true;
  f.state.settings.processAssistantMessages = false;
  f.receive('pic:first');
  f.receive('pic:second');
  await f.tick();
  assert.deepEqual(f.requests, []);
  f.state.settings.processAssistantMessages = true;
  f.context.onMessageReceived(0);
  await f.tick();
  assert.deepEqual(f.requests, []);
});
