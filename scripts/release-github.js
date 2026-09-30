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
 *  - The GitHub workflow (.github/workflows/publish-image.yml) runs the SAME
 *    gates as the laptop publisher: every test suite, the browser flows, the
 *    PostgreSQL money scenarios, and a smoke test of the exact image. Nothing
 *    is pushed to Docker Hub when any of them fails.
 *
 * What this script does:
 *   1. Refuses uncommitted changes (GitHub can only build what is committed).
 *   2. Pushes the current branch, so the built commit exists on GitHub.
 *   3. Creates and pushes a tag named release-<12-char sha>-<UTC time>: the
 *      tag push starts the workflow, and the tag name becomes the release
 *      name that https://albayanhub.com/api/health/ready reports.
 *   4. Prints the link to watch the run and the next manual steps.
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

function fail(message) {
  console.error(`\n${message}\nNothing was pushed and no build was started.`);
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
if (pushBranch.status !== 0) fail('Pushing the branch failed. Fix that first (a rejected push usually means GitHub has commits you do not have: run git pull).');

// 3. The tag push starts the workflow.
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

// 4. Everything else happens on GitHub and in Jelastic.
console.log(`\nStarted. Watch the build here (about 15-25 minutes):`);
console.log(`  https://github.com/${repo}/actions/workflows/publish-image.yml\n`);
console.log('When the run is green, Docker Hub holds:');
console.log(`  bashird/albayan:latest   and the rollback tag   bashird/albayan:${release}`);
console.log('\nNext, by hand:');
console.log('  1. Libyan Spider: albayan environment -> app container -> Redeploy, tag "latest", keep volumes.');
console.log('  2. Open https://albayanhub.com/api/health/ready and check "release" shows');
console.log(`     ${release}`);
console.log('\nIf the run is red, nothing was pushed to Docker Hub and the live site is unchanged.');
