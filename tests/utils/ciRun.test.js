/**
 * The run the CI pill shows. It used to take any run in progress on the
 * repository, so a pull request from a fork or another contributor's branch
 * took over the pill of a project that had nothing running.
 */

'use strict';

const { relevantRun } = require('../../src/renderer/utils/ciRun');

const run = (id, branch, status, conclusion = null) => ({ id, branch, status, conclusion });

test('a run in progress on another branch is not this project\'s', () => {
  const runs = [run(3, 'fix/usage-after-reset', 'in_progress'), run(2, 'main', 'completed', 'success')];
  expect(relevantRun(runs, 'main')).toMatchObject({ id: 2 });
});

test('on the current branch, a run in progress beats a newer finished one', () => {
  const runs = [run(5, 'feat/x', 'completed', 'failure'), run(4, 'feat/x', 'queued'), run(3, 'feat/x', 'completed', 'success')];
  expect(relevantRun(runs, 'feat/x')).toMatchObject({ id: 4 });
});

test('otherwise the newest run of the branch', () => {
  expect(relevantRun([run(9, 'feat/x', 'completed', 'failure'), run(8, 'feat/x', 'completed', 'success')], 'feat/x')).toMatchObject({ id: 9 });
});

test('no run for the branch, no branch, or no list: nothing to show', () => {
  expect(relevantRun([run(1, 'main', 'in_progress')], 'feat/x')).toBeNull();
  expect(relevantRun([run(1, 'main', 'in_progress')], null)).toBeNull();
  expect(relevantRun(undefined, 'main')).toBeNull();
});

describe('shouldAnnounce', () => {
  const { shouldAnnounce, runKey } = require('../../src/renderer/utils/ciRun');

  test('a green run is shown once, then not again by the next poll', () => {
    const seen = new Set();
    const green = run(2, 'main', 'completed', 'success');
    expect(shouldAnnounce(green, seen)).toBe(true);
    seen.add(runKey(green));
    expect(shouldAnnounce({ ...green }, seen)).toBe(false);
  });

  test('a run in progress, a failure, or a new run is always shown', () => {
    const seen = new Set([runKey(run(2, 'main', 'completed', 'success'))]);
    expect(shouldAnnounce(run(3, 'main', 'in_progress'), seen)).toBe(true);
    expect(shouldAnnounce(run(3, 'main', 'completed', 'failure'), seen)).toBe(true);
    expect(shouldAnnounce(run(4, 'main', 'completed', 'success'), seen)).toBe(true);
    expect(shouldAnnounce(null, seen)).toBe(false);
  });
});
