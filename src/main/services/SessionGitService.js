'use strict';
/**
 * Where a session's branch stands: everything behind the chat's Git tab, in
 * one call so the renderer does not chain a dozen IPC requests per refresh.
 *
 * Read-only. Branch, upstream and drift, the base the branch is measured
 * against, uncommitted files, the branch's own commits, and its pull request
 * with checks and reviews.
 *
 * Every git call here is one that fails as ordinary control flow (no
 * upstream, no origin/HEAD, not a repo), which `execGit` answers with null and
 * does not log. A tab polled every 30 s must not fill the error log.
 */

const path = require('path');
const { execGit, parseGitStatus } = require('../utils/git');
const github = require('./GitHubAuthService');

const COMMIT_LIMIT = 30;
const RECENT_ON_BASE = 10;
const SEP = '\x1f';
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** `git log` lines as commits. */
function parseLog(output) {
  if (!output) return [];
  return output.split('\n').filter(Boolean).map((line) => {
    const [sha, short, subject, author, date] = line.split(SEP);
    return { sha, short, subject, author, date };
  });
}

/** name → fetch URL, from `git remote -v`. */
function parseRemotes(output) {
  const remotes = {};
  for (const line of (output || '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes[m[1]] = m[2];
  }
  return remotes;
}

/** The web host of a remote URL, for the "create a pull request" link. */
function remoteHost(url) {
  if (typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
  const ssh = /^[^@]+@([^:]+):/.exec(url);
  return ssh ? ssh[1] : null;
}

/**
 * The branch the session's branch is measured against. The remote the branch
 * tracks comes first: a branch pushed to a fork is based on the fork's main,
 * and measuring it against origin/main (the upstream) would list every commit
 * the fork has that upstream does not.
 */
async function findBase(cwd, remote) {
  const remotes = [...new Set([remote, 'origin'].filter(Boolean))];
  for (const r of remotes) {
    const head = await execGit(cwd, ['for-each-ref', '--format=%(symref:short)', `refs/remotes/${r}/HEAD`]);
    if (head) return head;
  }
  const candidates = [
    ...remotes.flatMap((r) => [`refs/remotes/${r}/main`, `refs/remotes/${r}/master`]),
    'refs/heads/main',
    'refs/heads/master',
  ];
  const existing = new Set(((await execGit(cwd, ['for-each-ref', '--format=%(refname)', ...candidates])) || '').split('\n').filter(Boolean));
  const found = candidates.find((ref) => existing.has(ref));
  return found ? found.replace(/^refs\/(remotes|heads)\//, '') : null;
}

function summarizeChecks(checkRuns) {
  const checks = { total: 0, success: 0, failure: 0, pending: 0, skipped: 0, failing: [] };
  for (const run of checkRuns || []) {
    checks.total++;
    if (run.status !== 'completed') checks.pending++;
    else if (['success', 'neutral'].includes(run.conclusion)) checks.success++;
    else if (['skipped', 'cancelled', 'stale'].includes(run.conclusion)) checks.skipped++;
    else {
      checks.failure++;
      checks.failing.push({ name: run.name, url: run.url || null });
    }
  }
  return checks;
}

/** Each reviewer's latest decision; plain comments do not override a decision. */
function summarizeReviews(reviews) {
  const latest = new Map();
  for (const review of reviews || []) {
    if (!review.user) continue;
    if (review.state === 'COMMENTED' && latest.has(review.user)) continue;
    latest.set(review.user, review.state);
  }
  const decisions = [...latest.entries()].map(([user, state]) => ({ user, state }));
  return {
    approved: decisions.filter((d) => d.state === 'APPROVED').length,
    changesRequested: decisions.filter((d) => d.state === 'CHANGES_REQUESTED').length,
    decisions,
  };
}

/**
 * The branch's pull request, looked for on the repository the branch is
 * pushed to, then on origin. An open one wins over a closed or merged one.
 */
async function findPullRequest(cwd, branch, remote, base) {
  const remotes = parseRemotes(await execGit(cwd, ['remote', '-v']));
  const pushRemote = remote && remotes[remote] ? remote : remotes.origin ? 'origin' : null;
  if (!pushRemote) return null;
  const pushRepo = github.parseGitHubRemote(remotes[pushRemote]);
  if (!pushRepo) return null;

  const repos = [];
  for (const name of [pushRemote, 'origin']) {
    const parsed = remotes[name] && github.parseGitHubRemote(remotes[name]);
    if (parsed && !repos.some((r) => r.owner === parsed.owner && r.repo === parsed.repo)) repos.push(parsed);
  }

  const baseBranch = base ? base.replace(/^[^/]+\//, '') : 'main';
  const host = remoteHost(remotes[pushRemote]) || 'github.com';
  const createUrl = `https://${host}/${pushRepo.owner}/${pushRepo.repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`;

  let found = null;
  for (const repo of repos) {
    const res = await github.getPullRequestsForBranch(repo.owner, repo.repo, pushRepo.owner, branch);
    if (!res.authenticated) return { authenticated: false, createUrl };
    const best = res.pullRequests.find((pr) => pr.state === 'open') || res.pullRequests[0];
    if (best && (!found || (found.pr.state !== 'open' && best.state === 'open'))) found = { repo, pr: best };
    if (found?.pr.state === 'open') break;
  }
  if (!found) return { authenticated: true, createUrl, pullRequest: null };

  const { repo, pr } = found;
  const [checks, reviews] = await Promise.all([
    pr.headSha ? github.getCheckRuns(repo.owner, repo.repo, pr.headSha) : { checkRuns: [] },
    github.getPullRequestReviews(repo.owner, repo.repo, pr.number),
  ]);
  return {
    authenticated: true,
    createUrl,
    pullRequest: {
      ...pr,
      repo: `${repo.owner}/${repo.repo}`,
      checks: summarizeChecks(checks.checkRuns),
      reviews: summarizeReviews(reviews.reviews),
    },
  };
}

/**
 * @param {string} cwd the session's working directory
 * @param {{ withPullRequest?: boolean }} [opts]
 */
async function summary(cwd, { withPullRequest = true } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { isRepo: false };
  const root = await execGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return { isRepo: false };

  const [branchRaw, head, statusOut, gitDir, commonDir] = await Promise.all([
    execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    execGit(cwd, ['rev-parse', '--short', 'HEAD']),
    execGit(cwd, ['status', '--porcelain']),
    execGit(cwd, ['rev-parse', '--git-dir']),
    execGit(cwd, ['rev-parse', '--git-common-dir']),
  ]);
  const detached = branchRaw === 'HEAD';
  const branch = detached ? null : branchRaw;

  const files = parseGitStatus(statusOut || '');
  const conflicts = (statusOut || '').split('\n').filter((l) => CONFLICT_CODES.has(l.slice(0, 2))).length;
  const worktree = !!(gitDir && commonDir && path.resolve(cwd, gitDir) !== path.resolve(cwd, commonDir));

  let upstream = null;
  let remote = null;
  let ahead = 0;
  let behind = 0;
  if (branch) {
    const ref = await execGit(cwd, ['for-each-ref', '--format=%(upstream:short)%00%(upstream:remotename)', `refs/heads/${branch}`]);
    if (ref) {
      const [u, r] = ref.split('\0');
      upstream = u || null;
      remote = r || null;
    }
    if (upstream) {
      const counts = await execGit(cwd, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`]);
      if (counts) [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    }
  }

  const base = await findBase(cwd, remote);
  const onBase = !branch || !base || base === branch || base.endsWith(`/${branch}`);
  const format = `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`;
  const commits = parseLog(onBase
    ? await execGit(cwd, ['log', format, '-n', String(RECENT_ON_BASE)])
    : await execGit(cwd, ['log', format, '-n', String(COMMIT_LIMIT), `${base}..HEAD`]));

  const pr = withPullRequest && branch && !onBase ? await findPullRequest(cwd, branch, remote, base) : null;

  return {
    isRepo: true,
    root,
    branch,
    detached,
    head,
    worktree,
    upstream,
    remote,
    ahead,
    behind,
    base,
    onBase,
    dirty: {
      staged: files.staged.length,
      unstaged: files.unstaged.length,
      untracked: files.untracked.length,
      conflicts,
    },
    commits,
    pr,
  };
}

module.exports = { summary, _internals: { parseLog, parseRemotes, remoteHost, summarizeChecks, summarizeReviews } };
