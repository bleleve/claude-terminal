/**
 * The composer belongs to the conversation. The other tabs of a session
 * (Changes, Git, Tickets, Documents) are for reading: the prompt box and
 * Claude's task bar above it only show on Conversation.
 */

/** api mock: `on*` captures its callback, everything else resolves to a bare success. */
function makeApiMock(listeners) {
  const ns = () => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: () => ns() });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('the composer on a session\'s tabs', () => {
  let listeners, wrapper, view;

  const tab = (name) => wrapper.querySelector(`.chat-tab[data-tab="${name}"]`);
  const composer = () => wrapper.querySelector('.chat-input-area');

  beforeEach(() => {
    jest.resetModules();
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  test('only Conversation shows it', () => {
    expect(composer().hidden).toBe(false);
    for (const name of ['changes', 'git', 'tickets', 'artifacts']) {
      tab(name).click();
      expect(composer().hidden).toBe(true);
    }
    tab('conversation').click();
    expect(composer().hidden).toBe(false);
  });

  test('Claude\'s task bar goes with it, even when it appears on another tab', async () => {
    view.sendMessage('go');
    await new Promise((r) => setTimeout(r, 0));
    const sessionId = view.getSessionId();
    tab('git').click();
    listeners.onMessage({ sessionId, message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'TaskCreate', input: { subject: 'First task' } }] } } });
    listeners.onMessage({ sessionId, message: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Task #1 created successfully: First task' }] } } });
    const bar = wrapper.querySelector('.chat-todo');
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(true);
    tab('conversation').click();
    expect(bar.hidden).toBe(false);
  });

  test('a file added from outside brings the conversation back, its chip in the composer', () => {
    tab('git').click();
    // Text selected in the Git panel: the chip still goes to the composer.
    const panel = wrapper.querySelector('.session-git-panel');
    panel.textContent = 'feat/x';
    const range = document.createRange();
    range.selectNodeContents(panel);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    view.addMentionChip('file', { path: 'src/a.js', fullPath: '/tmp/test/src/a.js' });
    expect(composer().hidden).toBe(false);
    expect(tab('conversation').classList.contains('active')).toBe(true);
    expect(composer().querySelector('.chat-inline-chip')).not.toBeNull();
    expect(panel.querySelector('.chat-inline-chip')).toBeNull();
  });
});
