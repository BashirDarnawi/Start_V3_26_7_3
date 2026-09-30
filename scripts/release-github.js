#!/usr/bin/env node
/**
 * Start a production image build on GitHub's Intel (linux/amd64) machines.
 *
 * Why this exists next to `npm run release:image:push`:
 *
 *  - The server needs an Intel image. On an Apple Silicon Mac, Docker has to
 *    translate every build step (5-10 extra minutes per cold build) and then
 *    upload the whole image. GitHub's runners are Intel machines, so they build
 *    natively and push to Docker Hub directly; the laptop only pushes a tag.
 *  - Every push already runs the full CI workflow (all test suites, browser
 *    flows on three device sizes, PostgreSQL money scenarios, dependency
 *    audit, Docker smoke test). The publish workflow
 *    (.github/workflows/publish-image.yml) does not run them again: it waits
 *    for this commit's CI run, refuses unless every server-relevant job is
 *    green, builds and smoke-tests the image in parallel, then pushes. So a
 *    release of an already-tested commit takes a few minutes, and a release
 *    started right after a push takes CI's time plus a few minutes.
 *
 * What this script does:
 *   1. Refuses uncommitted changes (GitHub can only build what is committed).
 *   2. Pushes the current branch, so the built commit exists on GitHub and
 *      CI starts (or has already run) for it.
 *   3. Asks GitHub whether CI already proved this commit
 *      (scripts/ci-status-for-sha.js) and refuses a commit CI rejected.
 *   4. Creates and pushes a tag named release-<12-char sha>-<UTC time>: the
 *      tag push starts the workflow, and the tag name becomes the release
 *      name that https://albayanhub.com/api/health/ready reports.
 *   5. Prints the link to watch the run and the next manual steps.
 *
 * Usage:
 *   npm run release:github
 *   node scripts/release-github.js --dry-run   (prints what would happen)
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stderr || '');
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status})`);
  }
  return result;
}

let branchPushed = false;
function fail(message) {
  const state = branchPushed
    ? 'The branch is on GitHub, but no release tag was pushed and no build was started.'
    : 'Nothing was pushed and no build was started.';
  console.error(`\n${message}\n${state}`);
  process.exit(1);
}

// 1. Only committed source can be built on GitHub.
const status = git(['status', '--porcelain']).stdout.trim();
if (status) {
  fail('Working tree has uncommitted changes. Commit them first (GitHub builds the committed source only):\n' + status);
}

const sha = git(['rev-parse', '--short=12', 'HEAD']).stdout.trim();
if (!/^[a-f0-9]{7,40}$/.test(sha)) fail('Cannot identify the source revision.');

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
if (!branch || branch === 'HEAD') fail('Not on a branch (detached HEAD). Check out the branch you want to release.');

const remote = git(['remote', 'get-url', 'origin']).stdout.trim();
const repoMatch = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
if (!repoMatch) fail(`The origin remote is not a GitHub repository: ${remote}`);
const repo = repoMatch[1];

// The tag carries the release name; the workflow reuses it verbatim, so keep
// the exact shape scripts/publish-image.js used (health page, rollback tags
// and the docs all read the same format).
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const release = `release-${sha}-${stamp}`;

console.log(`\nRelease:  ${release}`);
console.log(`Commit:   ${sha} on branch ${branch}`);
console.log(`Builds on: GitHub (${repo}), Intel linux/amd64 - the Mac does not translate anything.\n`);

if (dryRun) {
  console.log(`--dry-run: would push branch ${branch} and tag ${release} to origin, which starts`);
  console.log('the "Publish verified Docker image" workflow. Nothing was pushed.');
  process.exit(0);
}

// 2. The commit must exist on GitHub before the tag points at it.
console.log(`Pushing branch ${branch} to GitHub...`);
const pushBranch = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: ROOT, stdio: 'inherit', shell: false });
if (pushBranch.status !== 0) fail('Pushing the branch failed. A rejected push means GitHub has commits you do not have, or history was rewritten. Do not force anything; ask for help first.');
branchPushed = true;

// 3. Do not cut a release of a commit CI already rejected; otherwise say how
//    long the release will take. Network trouble here is not fatal: the
//    workflow's gate makes the same check with the same script.
const fullSha = git(['rev-parse', 'HEAD']).stdout.trim();
const ci = spawnSync(process.execPath, [path.join(__dirname, 'ci-status-for-sha.js'), '--repo', repo, '--sha', fullSha], { cwd: ROOT, encoding: 'utf8', shell: false });
const ciLines = (ci.stdout || '').trim().split('\n');
const ciState = (ciLines.find(line => line.startsWith('ci=')) || '').replace(/^ci=/, '');
const ciLink = (ciLines.find(line => line.startsWith('url=')) || '').replace(/^url=/, '');
if (ciState === 'failed') {
  fail(`GitHub's tests are red for this commit${ciLink ? ` (${ciLink})` : ''}. Fix the failing job, or open that run and click "Re-run failed jobs" if it was a one-off, then release again.`);
} else if (ciState === 'cancelled') {
  fail(`GitHub's tests for this commit were cancelled, usually by a newer push to the branch${ciLink ? ` (${ciLink})` : ''}. Release the newest commit instead, or open that run and click "Re-run all jobs", wait for green, then release again.`);
} else if (ciState === 'passed') {
  console.log('GitHub already tested this exact commit: the release only builds, smoke-tests and pushes (a few minutes).');
} else if (ciState === 'running' || ciState === 'missing') {
  console.log('GitHub is testing this commit now (usually 5-10 minutes); the release waits for that, then builds and pushes.');
  console.log(`  Tests: https://github.com/${repo}/actions/workflows/ci.yml`);
} else {
  console.log('Could not read the test status from here; the release workflow checks it on GitHub.');
}

// 4. The tag push starts the workflow.
if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${release}`], { allowFailure: true }).status === 0) {
  fail(`Tag ${release} already exists locally; run the command again to get a fresh timestamp.`);
}
git(['tag', '--annotate', '--message', `Albayan release ${release}`, release, 'HEAD']);
console.log(`Pushing tag ${release}...`);
const pushTag = spawnSync('git', ['push', 'origin', `refs/tags/${release}`], { cwd: ROOT, stdio: 'inherit', shell: false });
if (pushTag.status !== 0) {
  git(['tag', '--delete', release], { allowFailure: true });
  fail('Pushing the release tag failed; the local tag was removed. Nothing was built.');
}

// 5. Everything else happens on GitHub and in Jelastic.
console.log(`\nStarted. Watch the release here:`);
console.log(`  https://github.com/${repo}/actions/workflows/publish-image.yml\n`);
console.log('When the run is green, Docker Hub holds:');
console.log(`  bashird/albayan:latest   and the rollback tag   bashird/albayan:${release}`);
console.log('\nNext, by hand:');
console.log('  1. Libyan Spider: albayan environment -> app container -> Redeploy, tag "latest", keep volumes.');
console.log('  2. Open https://albayanhub.com/api/health/ready and check "release" shows');
console.log(`     ${release}`);
console.log('\nIf the run is red, the live site is unchanged and `latest` did not move (at most the rollback tag exists on Docker Hub).');
console.log('The red step says what to do; usually it is a button called "Re-run failed jobs" on that run.');
console.log('Pushing more commits to this branch while the release waits cancels its tests: release the newest commit then.');
