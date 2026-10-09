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

module.exports = { relevantRun };
