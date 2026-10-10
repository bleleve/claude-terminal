/**
 * Which CI run the pill beside the project tabs shows for a project: the
 * newest run of the branch checked out there, in progress first. A run on any
 * other branch is someone else's work (a pull request from a fork, another
 * contributor's branch) and used to take the pill whenever it was in progress.
 *
 * @param {Array<{ branch: string, status: string }>} runs newest first, as GitHub lists them
 * @param {string|null} branch the project's current branch
 * @returns {object|null}
 */
function relevantRun(runs, branch) {
  if (!branch || !Array.isArray(runs)) return null;
  const own = runs.filter((r) => r && r.branch === branch);
  return own.find((r) => r.status === 'in_progress' || r.status === 'queued') || own[0] || null;
}

/** A run's visible state: the same id, status and conclusion read as "seen". */
function runKey(run) {
  return run ? `${run.id}:${run.status}:${run.conclusion || ''}` : null;
}

/**
 * Whether the pill should show this run now. A finished green run is shown
 * once: the pill hides it after a few seconds, and the 30 s poll used to bring
 * the same old run straight back, so a day-old success kept reappearing. A
 * run in progress or one that failed is always worth showing.
 *
 * @param {object|null} run
 * @param {Set<string>} seen keys of the green runs already shown
 */
function shouldAnnounce(run, seen) {
  if (!run) return false;
  if (run.status !== 'completed' || run.conclusion !== 'success') return true;
  return !seen.has(runKey(run));
}

module.exports = { relevantRun, runKey, shouldAnnounce };
