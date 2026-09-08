/**
 * Account switch after a usage limit — what the restart carries.
 *
 * A limit refused before the SDK's init message leaves no session file behind,
 * so the opening turn exists nowhere but the bubble on screen: the restart has
 * to send it again or the prompt dies with the account that refused it. Once a
 * real session id exists the opposite holds — the turn is already on disk, and
 * re-sending it would post the same message twice.
 */

jest.mock('../../src/renderer/ui/components/AccountSwitchModal', () => ({
  showAccountSwitchModal: jest.fn(async () => 'acc-team'),
}));

/**
 * api mock: `on*` captures its callback, everything else records the call and
 * answers from `responses` (keyed `namespace.method`) or with a bare success.
 */
function makeApiMock(listeners, calls, responses = {}) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      return Promise.resolve(responses[`${namespace}.${method}`] || { success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

// jsdom ships no crypto.randomUUID; the send path tags each user message with one.
let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('chat account switch', () => {
  let listeners, calls, wrapper, view, sessionId, responses;

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

  /** The options of the last chat.start — the restart the switch fired. */
  const lastStart = () => [...calls].reverse().find(c => c.namespace === 'chat' && c.method === 'start')?.args[0];

  const hitLimit = async () => {
    listeners.onAccountLimit({
      sessionId, error: 'Usage limit reached', activeAccountId: 'acc-max', projectId: null,
    });
    await flush();
  };

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    responses = {};
    window.electron_api = makeApiMock(listeners, calls, responses);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    view.sendMessage('contexte Salim');
    await flush();
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
    expect(lastStart().prompt).toBe('contexte Salim');
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('resends the opening turn when no session was ever written', async () => {
    await hitLimit();

    const restart = lastStart();
    expect(restart.accountId).toBe('acc-team');
    expect(restart.resumeSessionId).toBeNull();
    // Without this the prompt is lost: nothing on disk to resume, nothing sent.
    expect(restart.prompt).toBe('contexte Salim');
  });

  it('resumes without resending once the SDK has given a session id', async () => {
    listeners.onMessage({
      sessionId,
      message: {
        type: 'assistant', session_id: 'real-uuid-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    });

    await hitLimit();

    const restart = lastStart();
    expect(restart.accountId).toBe('acc-team');
    expect(restart.resumeSessionId).toBe('real-uuid-1');
    // The resumed transcript already holds it; sending it again would double it.
    expect(restart.prompt).toBe('');
  });

  // A cap reported in-band leaves the session running, so the composer stays
  // usable while the offer is up. What gets typed there never reaches the CLI,
  // so the resume comes back without it — the restart has to carry it.
  it('resends a message that never got its turn, alongside the resume', async () => {
    listeners.onMessage({
      sessionId,
      message: {
        type: 'assistant', session_id: 'real-uuid-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    });
    responses['chat.prepareSwitchAccount'] = {
      success: true,
      context: {
        cwd: '/tmp/test', projectId: 'p1', accountId: 'acc-max',
        pendingUserMessage: {
          text: 'et maintenant les tests', images: [], mentions: [], userMessageUuid: 'uuid-9',
        },
      },
    };

    await hitLimit();

    const restart = lastStart();
    expect(restart.resumeSessionId).toBe('real-uuid-1');
    expect(restart.prompt).toBe('et maintenant les tests');
    // Same uuid so the bubble already on screen is the one that gets recorded.
    expect(restart.userMessageUuid).toBe('uuid-9');
  });
});
