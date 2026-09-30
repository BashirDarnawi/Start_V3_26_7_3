#!/usr/bin/env node
/**
 * Did GitHub's automatic CI already prove this exact commit?
 *
 * Every branch push runs the CI workflow (.github/workflows/ci.yml). A release
 * of the same commit does not need to run those tests a second time: this
 * script looks up the CI runs for the commit and reports whether the jobs
 * that matter for the web image all succeeded. The publish workflow's gate
 * uses it (with --require-passed, so its exit code alone decides); the laptop
 * release script uses it to tell the owner what to expect and to refuse a
 * commit CI already rejected.
 *
 * Only branch PUSH runs of this repository count. A pull_request run tests a
 * merge commit (head + base), not the commit itself, so it can neither prove
 * nor block a release. The decision is made per REQUIRED job, not per run:
 * the phone-app builds live in the same workflow but say nothing about the
 * server image, so they are neither waited for nor required.
 *
 * Usage:
 *   node scripts/ci-status-for-sha.js --sha <40-hex> [--repo owner/name]
 *       [--wait <seconds>] [--grace <seconds>] [--interval <seconds>]
 *       [--require-passed]
 *
 * Machine-readable stdout (last lines):
 *   reason=<one line of plain words>
 *   url=<the CI run, when known>
 *   ci=passed     every required job succeeded for this exact commit
 *   ci=failed     a required job failed (fix or re-run it; releases refuse)
 *   ci=running    required jobs still in progress (or --wait timed out)
 *   ci=cancelled  the commit's CI run was cancelled (usually by a newer push)
 *   ci=missing    no CI run for this commit (never pushed to a branch?)
 *   ci=error      GitHub could not be asked (network / API trouble)
 * Exit code: 0 for passed; without --require-passed also 0 for running,
 * cancelled and missing; 1 for failed; 2 for usage/API errors. With
 * --require-passed anything but passed exits 1 (error stays 2).
 *
 * --wait keeps polling while required jobs are running. --grace (default
 * 180 s, only with --wait) also tolerates "no run yet": GitHub creates the
 * run a few seconds after the push, and the gate may look before that.
 */
const { spawnSync } = require('child_process');

// Job names as .github/workflows/ci.yml prints them. `prefix: true` matches a
// matrix job ("FastAPI tests (1 of 3)", "Real browser critical flows (...)"):
// every job whose name starts with the prefix must succeed and at least one
// must exist.
const REQUIRED = [
  { name: 'Frontend tests and generated files' },
  { name: 'FastAPI tests', prefix: true },
  { name: 'Real browser critical flows', prefix: true },
  { name: 'PostgreSQL migration smoke test' },
  { name: 'Docker production smoke test' },
];

// CI jobs that deliberately do not gate a server release. Every job in ci.yml
// must be in REQUIRED or here (scripts/test-build-safety.js enforces it), so
// adding a job forces a decision instead of being silently ignored.
const IGNORED = [
  'Android lint, tests, and release bundle',
  'iOS simulator build',
];

const CI_WORKFLOW_FILE = 'ci.yml';
const COUNTED_EVENTS = new Set(['push']);

function jobsFor(req, jobs) {
  return jobs.filter(job => (req.prefix ? job.name.startsWith(req.name) : job.name === req.name));
}

/** Verdict for one run from its jobs: passed | failed | running | missing. */
function judgeRun(jobs) {
  const missing = [];
  const failed = [];
  let running = false;
  for (const req of REQUIRED) {
    const matches = jobsFor(req, jobs || []);
    if (!matches.length) { missing.push(req.name); continue; }
    for (const job of matches) {
      if (job.status !== 'completed') { running = true; continue; }
      if (job.conclusion !== 'success') failed.push(`${job.name}: ${job.conclusion}`);
    }
  }
  if (failed.length) return { state: 'failed', reason: failed.join('; ') };
  if (running) return { state: 'running', reason: 'required CI jobs are still running' };
  if (missing.length) return { state: 'missing', reason: `required job(s) not in the CI run: ${missing.join(', ')}` };
  return { state: 'passed', reason: 'every required CI job succeeded' };
}

/**
 * Pure decision over the commit's CI runs (already filtered to this repo's
 * branch pushes) and each run's jobs. Exported for the build-safety tests.
 *
 * Newest run first (by last update, so a re-run counts). A red required job
 * in the newest run is final even if an older run was green: the newer run
 * saw newer advisories or flakiness worth a look. An older green run is
 * enough while the newest is still running (a second run of the same commit
 * on another branch must not delay a release).
 */
function evaluate(runs, jobsByRunId, repo) {
  const counted = (runs || []).filter(Boolean).filter(run =>
    COUNTED_EVENTS.has(run.event) && (!repo || !run.head_repository || run.head_repository.full_name === repo));
  if (!counted.length) return { state: 'missing', reason: 'no CI run found for this commit' };
  const ordered = [...counted].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  const verdicts = ordered.map(run => {
    if (run.status === 'completed' && (run.conclusion === 'cancelled' || run.conclusion === 'skipped')) {
      return { state: 'cancelled', reason: `the CI run for this commit was ${run.conclusion}`, runId: run.id, url: run.html_url };
    }
    const verdict = judgeRun(jobsByRunId[run.id] || []);
    return { ...verdict, runId: run.id, url: run.html_url };
  });
  const newest = verdicts[0];
  if (newest.state === 'failed') return newest;
  const green = verdicts.find(v => v.state === 'passed');
  if (green) return green;
  if (newest.state === 'running') return newest;
  const running = verdicts.find(v => v.state === 'running');
  if (running) return running;
  return newest; // cancelled or missing jobs
}

function parseArgs(argv) {
  const out = { wait: 0, grace: 180, interval: 30, requirePassed: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--sha') { out.sha = value; i++; }
    else if (key === '--repo') { out.repo = value; i++; }
    else if (key === '--wait') { out.wait = Number(value); i++; }
    else if (key === '--grace') { out.grace = Number(value); i++; }
    else if (key === '--interval') { out.interval = Number(value); i++; }
    else if (key === '--require-passed') { out.requirePassed = true; }
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!/^[a-f0-9]{40}$/.test(out.sha || '')) throw new Error('--sha must be the full 40-character commit id');
  for (const [name, n, min] of [['--wait', out.wait, 0], ['--grace', out.grace, 0], ['--interval', out.interval, 5]]) {
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
  }
  if (!out.repo) {
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', shell: false });
    const match = (remote.stdout || '').trim().match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
    if (!match) throw new Error('Pass --repo owner/name (the origin remote is not a GitHub repository)');
    out.repo = match[1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new Error(`--repo must look like owner/name, got ${out.repo}`);
  return out;
}

function findToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  // On a laptop, a `gh auth login` session raises the API limit and lets the
  // refuse-red-commit check work behind shared addresses.
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: false });
  return gh.status === 0 ? (gh.stdout || '').trim() : '';
}

const TRANSIENT = new Set([403, 429, 500, 502, 503, 504]);

async function githubJson(url, token, attempts = 3) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'albayan-release', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response.json();
      lastError = new Error(`GitHub API ${response.status} for ${url.replace(/\?.*$/, '')}`);
      if (!TRANSIENT.has(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
  }
  throw lastError;
}

async function fetchState(opts, token) {
  const base = `https://api.github.com/repos/${opts.repo}/actions`;
  const runs = (await githubJson(`${base}/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${opts.sha}&event=push&per_page=20`, token)).workflow_runs || [];
  const jobsByRunId = {};
  for (const run of runs) {
    const page = await githubJson(`${base}/runs/${run.id}/jobs?per_page=100`, token);
    jobsByRunId[run.id] = page.jobs || [];
  }
  return evaluate(runs, jobsByRunId, opts.repo);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = findToken();
  const start = Date.now();
  const deadline = start + opts.wait * 1000;
  const graceDeadline = start + Math.min(opts.wait, opts.grace) * 1000;
  let result;
  let errors = 0;
  for (;;) {
    try {
      result = await fetchState(opts, token);
      errors = 0;
    } catch (error) {
      errors += 1;
      result = { state: 'error', reason: `GitHub could not be asked: ${error.message}` };
      // Inside a wait, a blip is not a verdict: keep polling until the deadline.
      if (errors >= 3 && Date.now() >= deadline) break;
    }
    const noRunYet = result.state === 'missing' && result.reason === 'no CI run found for this commit';
    const keepWaiting = Date.now() < deadline && (
      result.state === 'running' || result.state === 'error' || (noRunYet && Date.now() < graceDeadline));
    if (!keepWaiting) break;
    const left = Math.round((deadline - Date.now()) / 1000);
    console.log(`${result.reason}${result.url ? ` (${result.url})` : ''}; checking again in ${opts.interval}s (${left}s left)`);
    await new Promise(resolve => setTimeout(resolve, opts.interval * 1000));
  }
  console.log(`reason=${result.reason}`);
  if (result.url) console.log(`url=${result.url}`);
  console.log(`ci=${result.state}`);
  if (result.state === 'error') process.exit(2);
  if (result.state === 'failed') process.exit(1);
  process.exit(opts.requirePassed && result.state !== 'passed' ? 1 : 0);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`ci-status: ${error.message}`);
    console.log(`reason=${error.message}`);
    console.log('ci=error');
    process.exit(2);
  });
}

module.exports = { evaluate, judgeRun, REQUIRED, IGNORED };
