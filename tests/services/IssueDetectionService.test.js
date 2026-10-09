/**
 * Automatic ticket detection, against the real link store, tracker service and
 * Linear adapter over the fixture. It must suggest, never link; suggest only
 * tickets that exist; never come back on a dismissal; and pair a tool call
 * with its result, since a creation's key is only in the result.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIssueDetectionService } = require('../../src/main/services/IssueDetectionService');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');

let dir;
let trackers;
let links;
let detection;
let conn;
const registry = { get: (id) => (id === 'linear' ? linear : null), describe: () => describeTrackers([linear]) };

beforeEach(async () => {
  fixture.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-detect-'));
  const secrets = new Map();
  trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry,
    fetch: fixture.fetch,
  });
  links = createIssueLinkService({ storePath: path.join(dir, 'issue-links.json') });
  detection = createIssueDetectionService({ trackers, links, registry });
  conn = await trackers.connect('linear', fixture.secret);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const statuses = async (key) => Object.fromEntries((await links.get(key)).map((l) => [l.ref, l.status]));

/** Detection runs off the event, through the disk: wait for the links rather than for a guessed delay. */
async function waitForLinks(key, count) {
  const end = Date.now() + 3000;
  while (Date.now() < end && (await links.get(key)).length < count) await new Promise((r) => setTimeout(r, 20));
}

describe('tool calls', () => {
  test('a Linear tool that targets a ticket suggests it, with the tool as evidence', async () => {
    const refs = await detection.observeToolCall('s1', { name: 'mcp__claude_ai_Linear__save_comment', input: { issueId: 'ENG-142', body: 'x' }, result: 'ok' });
    expect(refs).toEqual(['linear:ENG-142']);
    const [link] = await links.get('s1');
    expect(link).toMatchObject({ ref: 'linear:ENG-142', status: 'suggested', source: 'tool', evidence: 'save_comment (write)', title: 'Session tickets tab', connectionId: conn.id });
  });

  test('a creation is keyed from the result', async () => {
    await detection.observeToolCall('s1', { name: 'mcp__linear__save_issue', input: { team: 'ENG', title: 'New' }, result: [{ type: 'text', text: '{"identifier":"ENG-155"}' }] });
    expect(await statuses('s1')).toEqual({ 'linear:ENG-155': 'suggested' });
  });

  test('a key the tracker does not know is not suggested', async () => {
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__get_issue', input: { id: 'ENG-99999' } })).toEqual([]);
    expect(await links.get('s1')).toEqual([]);
  });

  test('other tools, lists and errors are ignored', async () => {
    expect(await detection.observeToolCall('s1', { name: 'Bash', input: { command: 'echo ENG-142' } })).toEqual([]);
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__list_issues', input: {}, result: '{"identifier":"ENG-142"}' })).toEqual([]);
  });

  test('a ticket already linked, or dismissed, is never suggested again', async () => {
    await links.link('s1', { ref: 'linear:ENG-142', connectionId: conn.id });
    await links.suggest('s1', { ref: 'linear:ENG-139', connectionId: conn.id });
    await links.dismiss('s1', ['linear:ENG-139']);
    const fetchSpy = jest.spyOn(trackers, 'getIssue');
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__get_issue', input: { id: 'ENG-142' } })).toEqual([]);
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__get_issue', input: { id: 'ENG-139' } })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled(); // known tickets cost no request
    expect(await statuses('s1')).toEqual({ 'linear:ENG-142': 'linked', 'linear:ENG-139': 'dismissed' });
  });
});

describe('text', () => {
  test('a branch name names its ticket', async () => {
    expect(await detection.observeText('s1', 'ada/eng-142-session-tickets-tab', 'branch', 'ada/eng-142-session-tickets-tab')).toEqual(['linear:ENG-142']);
    expect((await links.get('s1'))[0]).toMatchObject({ source: 'branch', evidence: 'ada/eng-142-session-tickets-tab' });
  });

  test('a PR title and a prompt, only for prefixes the workspace has', async () => {
    expect(await detection.observeText('s1', 'ENG-142: session tab (see UTF-8 notes and OPS-12)', 'pr', '#57')).toEqual(['linear:ENG-142', 'linear:OPS-12']);
    expect(await detection.observeText('s1', 'fix SHA-256 handling', 'prompt')).toEqual([]);
  });

  test('an unknown source is refused', async () => {
    expect(await detection.observeText('s1', 'ENG-142', 'assistant')).toEqual([]);
  });
});

describe('chat sessions', () => {
  function fakeChat() {
    let listener;
    return {
      addEventListener: (fn) => { listener = fn; return () => { listener = null; }; },
      emit: (message) => listener('chat-message', { sessionId: 'chat-1', message }),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 200));

  test('a tracker tool call is paired with its result and keyed by the SDK session', async () => {
    const chat = fakeChat();
    detection.attachChat(chat);
    chat.emit({ type: 'assistant', session_id: 'sdk-1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__linear__save_issue', input: { team: 'ENG', title: 'x' } }] } });
    expect(await links.get('sdk-1')).toEqual([]); // nothing until the result
    chat.emit({ type: 'user', session_id: 'sdk-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{"identifier":"ENG-155"}' }] } });
    await waitForLinks('sdk-1', 1);
    expect(await statuses('sdk-1')).toEqual({ 'linear:ENG-155': 'suggested' });
  });

  test('a failed tool call suggests nothing', async () => {
    const chat = fakeChat();
    detection.attachChat(chat);
    chat.emit({ type: 'assistant', session_id: 'sdk-1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__linear__get_issue', input: { id: 'ENG-142' } }] } });
    chat.emit({ type: 'user', session_id: 'sdk-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] } });
    await settle();
    expect(await links.get('sdk-1')).toEqual([]);
  });
});

describe('terminal sessions (hooks)', () => {
  test('PostToolUse and UserPromptSubmit are both read', async () => {
    detection.onHookEvent({ hook: 'PostToolUse', stdin: { session_id: 'term-1', tool_name: 'mcp__linear__get_issue', tool_input: { id: 'OPS-12' }, tool_response: {} } });
    detection.onHookEvent({ hook: 'UserPromptSubmit', stdin: { session_id: 'term-1', prompt: 'continue on ENG-139 please' } });
    await waitForLinks('term-1', 2);
    expect(await statuses('term-1')).toEqual({ 'linear:OPS-12': 'suggested', 'linear:ENG-139': 'suggested' });
  });

  test('an event without a session is ignored', () => {
    expect(() => detection.onHookEvent({ hook: 'PostToolUse', stdin: { tool_name: 'mcp__linear__get_issue' } })).not.toThrow();
    expect(() => detection.onHookEvent(null)).not.toThrow();
  });
});
