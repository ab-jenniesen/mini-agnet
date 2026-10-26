import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TuiAltScreen,
  CURSOR_MARKER,
  visibleWidth,
  stripTerminalSequences,
} from '@earendil-works/pi-tui';
import { TerminalView } from '../src/ui/terminal/view.js';
import { SecretInput } from '../src/ui/terminal/dialogs.js';
import { reducePresentation, initialPresentationState } from '../src/ui/view-model.js';
import { helpText } from '../src/ui/command-router.js';
import { autocomplete } from '../src/ui/terminal/autocomplete.js';
import { TerminalController } from '../src/ui/terminal/controller.js';
import { runtimeFixture, echoModel } from './helpers/runtime.js';
import { FakeTerminal } from './helpers/terminal.js';

test('Pi editor inserts in the middle and deletes graphemes in both directions', () => {
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  try {
    const editor = view.editor;
    editor.setText('你👨‍👩‍👧‍👦好');
    editor.handleInput('\x1b[D');
    editor.handleInput('中');
    assert.equal(editor.getText(), '你👨‍👩‍👧‍👦中好');
    editor.handleInput('\x7f');
    assert.equal(editor.getText(), '你👨‍👩‍👧‍👦好');
    editor.handleInput('\x7f');
    assert.equal(editor.getText(), '你好');
    editor.handleInput('\x1b[3~');
    assert.equal(editor.getText(), '你');
    editor.handleInput('\n');
    editor.handleInput('第二行');
    assert.equal(editor.getText(), '你\n第二行');
    editor.addToHistory('/stats');
    editor.setText('');
    editor.handleInput('\x1b[A');
    assert.equal(editor.getText(), '/stats');
    editor.handleInput('\x1b[B');
    assert.equal(editor.getText(), '');
  } finally {
    view.stop();
    terminal.dispose();
  }
});

test('slash and argument completions use the shared command definitions', async () => {
  const f = await runtimeFixture(echoModel);
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  try {
    const state = await f.runtime.initialize();
    const provider = autocomplete(
      f.runtime,
      await f.runtime.dispatch({ type: 'models.providers' }),
      state.workspaceRoot,
    );
    const opts = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions(['/sess'], 0, 5, opts);
    assert.ok(suggestions?.items.some((item) => item.value.includes('session')));
    const modes = await provider.getSuggestions(['/permission a'], 0, 13, opts);
    assert.ok(modes?.items.some((item) => item.value === 'ask'));
    const sessions = await provider.getSuggestions(['/session d'], 0, 10, opts);
    assert.ok(sessions?.items.some((item) => item.value === 'default'));
  } finally {
    view.stop();
    terminal.dispose();
    await f.close();
  }
});

test('fullscreen scrolling never changes prompt history; resize keeps all rendered lines within width', async () => {
  const f = await runtimeFixture(echoModel);
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  try {
    const snapshot = await f.runtime.initialize();
    snapshot.history = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `历史消息 ${i}\n正文 ${i}`,
    }));
    view.update(reducePresentation(initialPresentationState(), { type: 'state', state: snapshot }));
    view.editor.addToHistory('/stats');
    view.editor.setText('草稿');
    view.start();
    view.tui.renderNow();
    await terminal.flush();
    assert.ok(terminal.output.includes('\x1b[?1049h'));
    const tui = view.tui as TuiAltScreen;
    assert.ok(tui.viewportTop > 0);
    terminal.input('\x1b[<64;10;5M');
    assert.equal(view.editor.getText(), '草稿');
    view.tui.renderNow();
    assert.equal(tui.isFollowingOutput, false);
    terminal.resize(32, 16);
    view.tui.renderNow();
    await terminal.flush();
    for (const line of tui.getScreenLines()) assert.ok(visibleWidth(line) <= 32);
    assert.match(terminal.screen(), /草稿/);
    view.stop();
    await terminal.flush();
    assert.ok(terminal.output.includes('\x1b[?1049l'));
    assert.equal(terminal.stopped, true);
  } finally {
    view.stop();
    terminal.dispose();
    await f.close();
  }
});

test('help is paged above the editor and notices replace each other', async () => {
  const f = await runtimeFixture(echoModel);
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  try {
    view.update(
      reducePresentation(initialPresentationState(), {
        type: 'state',
        state: await f.runtime.initialize(),
      }),
    );
    view.start();
    view.status('info', '提示一');
    view.tui.renderNow();
    view.status('info', '提示二');
    view.tui.renderNow();
    await terminal.flush();
    assert.doesNotMatch(terminal.screen(), /提示一/);
    assert.match(terminal.screen(), /提示二/);
    view.panel('命令帮助', helpText());
    view.tui.renderNow();
    await terminal.flush();
    assert.match(terminal.screen(), /类型：任务/);
    assert.match(terminal.screen(), /命令：/);
    const first = terminal.screen();
    terminal.input('\x1b[6~');
    view.tui.renderNow();
    await terminal.flush();
    assert.notEqual(terminal.screen(), first);
    terminal.input('\x1b');
    view.tui.renderNow();
    assert.equal(view.tui.hasOverlay(), false);
    terminal.resize(20, 10);
    view.tui.renderNow();
    await terminal.flush();
    const editorLines = view.editor.render(20);
    assert.ok(editorLines.some((line) => line.includes(CURSOR_MARKER)));
  } finally {
    view.stop();
    terminal.dispose();
    await f.close();
  }
});

test('secret input masks characters while retaining the IME cursor marker', () => {
  const input = new SecretInput();
  input.focused = true;
  input.handleInput('sk-private-value');
  const rendered = input.render(40).join('\n');
  assert.doesNotMatch(rendered, /private|sk-/);
  assert.match(stripTerminalSequences(rendered), /•/);
  assert.ok(rendered.includes(CURSOR_MARKER));
  assert.equal(input.getValue(), 'sk-private-value');
});

test('terminal controller renders one final reply, usage, command panels and responsive model choices', async () => {
  const f = await runtimeFixture(echoModel);
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  const controller = new TerminalController(f.runtime, view);
  try {
    await controller.start();
    await controller.submit('你好');
    view.tui.renderNow();
    await terminal.flush();
    assert.match(terminal.screen(), /答复：你好/);
    assert.equal((terminal.screen().match(/答复：你好/g) ?? []).length, 1);
    assert.match(terminal.screen(), /合计 12/);
    await controller.submit('/help');
    view.tui.renderNow();
    terminal.input('/');
    view.tui.renderNow();
    assert.equal(view.tui.hasOverlay(), false);
    assert.equal(view.editor.getText(), '/');
    view.editor.setText('');
    const choice = view.select(
      '选择模型供应商',
      Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: `供应商 ${i}` })),
    );
    terminal.resize(20, 10);
    view.tui.renderNow();
    await terminal.flush();
    terminal.input('\x1b[B');
    terminal.input('\r');
    assert.equal(await choice, '1');
  } finally {
    await controller.close();
    terminal.dispose();
    await f.close();
  }
});

test('Ctrl+C cancels the task while its approval dialog has focus', { timeout: 5000 }, async () => {
  const f = await runtimeFixture({
    async complete() {
      return {
        content: null,
        toolCalls: [
          {
            id: 'pending',
            name: 'write_file',
            arguments: '{"path":"never.txt","content":"never"}',
          },
        ],
      };
    },
  });
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  const controller = new TerminalController(f.runtime, view);
  try {
    await controller.start();
    let ready!: () => void;
    const approval = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested') ready();
    });
    const pending = controller.submit('write');
    await approval;
    view.tui.renderNow();
    assert.equal(view.tui.hasOverlay(), true);
    terminal.input('\x03');
    await pending;
    assert.equal(f.runtime.snapshot().running, false);
    assert.equal(f.runtime.snapshot().pendingApprovals.length, 0);
    assert.equal(view.tui.hasOverlay(), false);
  } finally {
    await controller.close();
    terminal.dispose();
    await f.close();
  }
});

test('Ctrl+I reveals completed thinking and Ctrl+O cycles all three tool display modes', async () => {
  const f = await runtimeFixture({
    async complete(_messages, _tools, options) {
      options?.onEvent?.({ type: 'thinking', text: '保留的思考内容', source: 'summary' });
      options?.onEvent?.({ type: 'text', text: 'answer' });
      return { content: 'answer', toolCalls: [], finishReason: 'stop' };
    },
  });
  const terminal = new FakeTerminal();
  const view = new TerminalView(terminal);
  const controller = new TerminalController(f.runtime, view);
  try {
    await controller.start();
    await controller.submit('hello');
    view.tui.renderNow();
    await terminal.flush();
    assert.doesNotMatch(terminal.screen(), /保留的思考内容/);
    terminal.input('\t');
    view.tui.renderNow();
    await terminal.flush();
    assert.equal(view.thinkingMode, 'expanded');
    assert.match(terminal.screen(), /保留的思考内容/);
    terminal.input('\t');
    view.tui.renderNow();
    await terminal.flush();
    assert.doesNotMatch(terminal.screen(), /保留的思考内容/);
    for (const mode of ['all', 'collapsed', 'recent']) {
      terminal.input('\x0f');
      assert.equal(view.toolDisplayMode, mode);
    }
    await controller.submit('/task');
    view.tui.renderNow();
    await terminal.flush();
    assert.match(terminal.screen(), /已完成/);
    assert.match(terminal.screen(), /纯回复，无文件验收/);
  } finally {
    await controller.close();
    terminal.dispose();
    await f.close();
  }
});
