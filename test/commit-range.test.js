const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '..', 'scripts', 'security', 'resolve-commit-range.sh');
const zero = '0000000000000000000000000000000000000000';

function gitEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '',
    GIT_AUTHOR_NAME: 'Range Test',
    GIT_AUTHOR_EMAIL: '123456+range-test@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Range Test',
    GIT_COMMITTER_EMAIL: '123456+range-test@users.noreply.github.com',
    ...extra
  };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function resolveRange(cwd, env) {
  return spawnSync('bash', [script], { cwd, env: gitEnv(env), encoding: 'utf8' });
}

test('resolves push, pull request, and missing before SHAs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-range-'));
  try {
    runGit(cwd, ['init', '-b', 'main']);
    runGit(cwd, ['commit', '--allow-empty', '-m', 'first']);
    const root = runGit(cwd, ['rev-parse', 'HEAD']);
    runGit(cwd, ['commit', '--allow-empty', '-m', 'second']);
    const child = runGit(cwd, ['rev-parse', 'HEAD']);

    const ranged = resolveRange(cwd, {
      GITHUB_EVENT_NAME: 'push',
      PUSH_BEFORE_SHA: root,
      GITHUB_SHA: child
    });
    assert.equal(ranged.status, 0, ranged.stderr);
    assert.equal(ranged.stdout, `${root}..${child}\n`);
    assert.equal(runGit(cwd, ['log', '--format=%H', `${root}..${child}`]), child);

    for (const [label, before] of [['missing', ''], ['zero', zero], ['unavailable', 'a'.repeat(40)]]) {
      const fallback = resolveRange(cwd, {
        GITHUB_EVENT_NAME: 'push',
        PUSH_BEFORE_SHA: before,
        GITHUB_SHA: root
      });
      assert.equal(fallback.status, 0, `${label}\n${fallback.stderr}`);
      assert.equal(fallback.stdout, `${root}\n`, label);
      assert.equal(runGit(cwd, ['log', '--format=%H', root]), root);
    }

    const unavailable = resolveRange(cwd, {
      GITHUB_EVENT_NAME: 'push',
      PUSH_BEFORE_SHA: 'a'.repeat(40),
      GITHUB_SHA: child
    });
    assert.match(unavailable.stderr, /not in this clone/);

    const scheduled = resolveRange(cwd, {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_SHA: child
    });
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.equal(scheduled.stdout, `${child}\n`);

    const pull = resolveRange(cwd, {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_BASE_SHA: root,
      PR_HEAD_SHA: child,
      GITHUB_SHA: child
    });
    assert.equal(pull.status, 0, pull.stderr);
    assert.equal(pull.stdout, `${root}..${child}\n`);

    const missingBase = resolveRange(cwd, {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_HEAD_SHA: child
    });
    assert.equal(missingBase.status, 1);
    assert.match(missingBase.stderr, /missing/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
