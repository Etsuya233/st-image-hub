import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
// 运行实际布局及事件绑定代码，隔离 ST 的聊天、存储和图片请求依赖。
const layout = source.slice(source.indexOf('const PANEL_MIN_WIDTH'), source.indexOf('function readStoredPanelPosition'));
const binding = source.slice(source.indexOf('function bindPanelLayout()'), source.indexOf('function bindDom('));

function createLayout() {
  const win = new EventTarget();
  Object.assign(win, { innerWidth: 390, innerHeight: 844, requestAnimationFrame: callback => callback() });
  win.visualViewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
  const classes = new Set();
  const panel = {
    style: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
  };
  // 模拟键盘关闭后 ST 输入栏尚未恢复位置，插件应独立恢复可视高度。
  const bars = { top: 40, bottom: 780 };
  const doc = { getElementById: id => ({ getBoundingClientRect: () => id === 'top-bar'
    ? { bottom: bars.top, height: 40 }
    : { top: bars.bottom, height: 64 } }) };
  const context = vm.createContext({
    state: { panel, uiWindow: win, panelSize: null, panelPosition: null, disposers: [] },
    W: win,
    uiDoc: () => doc,
    SillyTavern: { getContext: () => ({ isMobile: () => false }) },
    TAVERN_BOTTOM_BAR_IDS: ['send-form', 'send_form', 'form_sheld'],
  });
  vm.runInContext(layout + binding + '\nbindPanelLayout();', context);
  return { win, panel, bars, context, classes };
}

function assertViewport({ panel, win }) {
  assert.equal(panel.style.top, `${win.visualViewport.offsetTop}px`, '面板上边界应跟随可视视口');
  assert.equal(panel.style.left, `${win.visualViewport.offsetLeft}px`);
  assert.equal(panel.style.height, `${win.visualViewport.height}px`, '面板应覆盖完整可视高度');
  assert.equal(panel.style.width, `${win.visualViewport.width}px`);
  assert.equal(panel.style.bottom, '');
}

test('移动端覆盖顶部工具栏和底部输入框', () => {
  assertViewport(createLayout());
});

test('iPhone 键盘开合后恢复高度，不受 ST 输入栏的滞后位置影响', () => {
  const fixture = createLayout();
  for (let i = 0; i < 3; i++) {
    Object.assign(fixture.win.visualViewport, { height: 360, offsetTop: 120 });
    fixture.bars.bottom = 416;
    fixture.win.visualViewport.dispatchEvent(new Event('resize'));
    assertViewport(fixture);
    fixture.win.visualViewport.offsetTop = 160;
    fixture.win.visualViewport.dispatchEvent(new Event('scroll'));
    assertViewport(fixture);
    Object.assign(fixture.win.visualViewport, { height: 844, offsetTop: 0 });
    fixture.win.visualViewport.dispatchEvent(new Event('resize'));
    assertViewport(fixture);
  }
});

test('键盘关闭时即使底栏仍在键盘上沿，面板也恢复完整高度', () => {
  const fixture = createLayout();
  fixture.win.visualViewport.height = 480;
  fixture.bars.bottom = 416;
  fixture.win.visualViewport.dispatchEvent(new Event('resize'));
  fixture.win.visualViewport.height = 844;
  fixture.win.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(fixture.panel.style.height, '844px');
});

test('横屏和返回桌面布局时清除移动端尺寸，解绑后停止更新', () => {
  const fixture = createLayout();
  Object.assign(fixture.win, { innerWidth: 844, innerHeight: 390 });
  Object.assign(fixture.win.visualViewport, { width: 844, height: 390 });
  fixture.win.dispatchEvent(new Event('orientationchange'));
  assertViewport(fixture);
  Object.assign(fixture.win, { innerWidth: 1440, innerHeight: 900 });
  fixture.win.dispatchEvent(new Event('resize'));
  assert.equal(fixture.classes.has('oair-panel-fullscreen'), false);
  for (const property of ['top', 'left', 'bottom', 'width', 'height']) assert.equal(fixture.panel.style[property], '');
  vm.runInContext('state.disposers.forEach(dispose => dispose())', fixture.context);
  fixture.win.innerWidth = 390;
  fixture.win.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(fixture.classes.has('oair-panel-fullscreen'), false);
});
