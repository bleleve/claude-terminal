/** @jest-environment node */
/**
 * What the renderer may touch on disk.
 *
 * Upstream enforced this in the preload with a denylist; here the preload only
 * proxies, and `rendererSecurity.permitted()` in the main process decides. That
 * is an allowlist, so everything this suite calls "denied" is denied by default
 * rather than by name - which is why the one entry that still has to be named is
 * the interesting case: ~/.claude is granted wholesale for settings, skills and
 * agents, and the credential store sits inside it.
 *
 * The intents pinned here are upstream's; only the enforcement point moved.
 * Trust, symlink escape and microphone scope are covered by
 * tests/utils/rendererSecurity.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let temporary, security;
const home = (...seg) => path.join(temporary, ...seg);

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fsguard-'));
  jest.spyOn(os, 'homedir').mockReturnValue(temporary);
  jest.resetModules();
  security = require('../../src/main/utils/rendererSecurity');
  // The grants live in install(); nothing is permitted before it runs.
  fs.mkdirSync(home('.claude'), { recursive: true });
  fs.mkdirSync(home('.claude-terminal'), { recursive: true });
  fs.writeFileSync(home('.claude', '.credentials.json'), '{}');
  const ipc = new EventEmitter();
  ipc.handle = () => {};
  security.install(ipc);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
});

describe('credential material', () => {
  test.each([
    ['.ssh', 'id_rsa'],
    ['.aws', 'credentials'],
    ['.gnupg', 'secring.gpg'],
  ])('is outside every grant: ~/%s/%s', (dir, file) => {
    expect(security.permitted(home(dir, file))).toBe(false);
    expect(security.permitted(home(dir, file), true)).toBe(false);
  });

  test('the Claude credential store is refused although ~/.claude is granted', () => {
    // The one path that needs naming: a grant covers its parent.
    expect(security.permitted(home('.claude', 'settings.json'), true)).toBe(true);
    expect(security.permitted(home('.claude', '.credentials.json'))).toBe(false);
    expect(security.permitted(home('.claude', '.credentials.json'), true)).toBe(false);
  });
});

describe('login persistence', () => {
  const hooks = process.platform === 'win32'
    ? ['ntuser.dat']
    : ['.bashrc', '.zshrc', '.profile'];

  test.each(hooks)('cannot be written: ~/%s', (file) => {
    expect(security.permitted(home(file), true)).toBe(false);
  });

  test('nor can an autostart directory', () => {
    const autostart = process.platform === 'darwin'
      ? home('Library', 'LaunchAgents', 'evil.plist')
      : home('.config', 'autostart', 'evil.desktop');
    expect(security.permitted(autostart, true)).toBe(false);
  });
});

describe('the prefix check', () => {
  test('does not over-block a sibling whose name merely shares a prefix', () => {
    const project = home('project');
    fs.mkdirSync(project);
    fs.mkdirSync(home('project-notes'));
    security.grant(project);
    expect(security.permitted(path.join(project, 'src', 'index.js'), true)).toBe(true);
    expect(security.permitted(home('project-notes', 'index.js'))).toBe(false);
  });
});

describe('what the renderer legitimately edits', () => {
  test('the app data directory is writable', () => {
    expect(security.permitted(home('.claude-terminal', 'settings.json'), true)).toBe(true);
  });

  test('the Claude CLI config is readable but not writable through this bridge', () => {
    fs.writeFileSync(home('.claude.json'), '{}');
    expect(security.permitted(home('.claude.json'))).toBe(true);
    expect(security.permitted(home('.claude.json'), true)).toBe(false);
  });
});

describe('malformed input', () => {
  test('null bytes are refused', () => {
    expect(security.permitted(home('.claude-terminal', 'a\0b'), true)).toBe(false);
  });

  test('a non-string path is refused', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(security.permitted(value)).toBe(false);
    }
  });

  test('a relative path is refused', () => {
    expect(security.permitted('settings.json')).toBe(false);
  });
});
