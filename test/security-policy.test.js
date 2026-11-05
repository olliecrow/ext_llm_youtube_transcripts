const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scripts = path.join(__dirname, '..', 'scripts', 'security');
const textScript = path.join(scripts, 'check-sensitive-text.sh');
const rangeScript = path.join(scripts, 'check-push-range.sh');

// Sensitive samples are built at run time so this file passes its own scan.
const unix = name => ['', 'home', name].join('/');
const mac = name => ['', 'Users', name].join('/');
const win = (name, sep) => ['C:', 'Users', name].join(sep);

function env(extra = {}) {
  return {
    PATH: process.env.PATH || '',
    GIT_AUTHOR_NAME: 'Policy Test',
    GIT_AUTHOR_EMAIL: '123456+policy-test@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Policy Test',
    GIT_COMMITTER_EMAIL: '123456+policy-test@users.noreply.github.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-policy-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(script, args, options = {}) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: env(options.env), cwd: options.cwd });
}

function scanText(dir, text, extraEnv) {
  const file = path.join(dir, 'sample.txt');
  fs.writeFileSync(file, `${text}\n`);
  return run(textScript, [file], { env: extraEnv });
}

// A PATH entry whose tool always fails like a real I/O or usage error.
function failingTool(dir, name) {
  const bin = path.join(dir, `fail-${name}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH || ''}` };
}

test('sensitive-text policy allows only exact placeholder paths', () => {
  const cases = [
    ['Unix home path', `see ${unix('alice')}/project`, 1],
    ['placeholder and real path on one line', `see ${mac('YOU')} and ${mac('alice')}`, 1],
    ['Unix placeholder prefix', `see ${unix('userbob')}`, 1],
    ['macOS placeholder prefix', `see ${mac('YOUNG')}`, 1],
    ['Windows single backslash', `see ${win('alice', '\\')}`, 1],
    ['Windows double backslash', `see ${win('alice', '\\\\')}`, 1],
    ['exact placeholders', `see ${mac('YOU')}, ${unix('user')}/x and ${win('USERNAME', '\\')}`, 0],
    ['credential assignment', `fix: ${'tok'}${'en'}=abc123456789XYZ`, 1],
    ['personal email', `mail ${['person', 'example.com'].join('@')}`, 1],
    ['GitHub noreply email', `mail ${['123+someone', 'users.noreply.github.com'].join('@')}`, 0],
    ['plain text', 'nothing to see', 0]
  ];
  withTempDir(dir => {
    for (const [label, text, expected] of cases) {
      const result = scanText(dir, text);
      assert.equal(result.status, expected, `${label}\n${result.stderr}`);
      assert.ok(!result.stderr.includes('alice'), `${label} must not print the value`);
    }
  });
});

test('sensitive-text policy fails closed when it cannot scan', () => {
  withTempDir(dir => {
    const missing = run(textScript, [path.join(dir, 'missing.txt')]);
    assert.equal(missing.status, 2, missing.stderr);
    for (const tool of ['grep', 'awk']) {
      const result = scanText(dir, `see ${unix('alice')}`, failingTool(dir, tool));
      assert.equal(result.status, 2, `${tool}\n${result.stderr}`);
    }
  });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(cwd, file, text, message) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('push-range check scans added lines and messages, including merges', () => {
  withTempDir(cwd => {
    git(cwd, ['init', '-q', '-b', 'main']);
    const base = commitFile(cwd, 'a.txt', 'clean\n', 'base');
    const check = (range, extraEnv) => run(rangeScript, ['--range', range], { cwd, env: extraEnv });

    assert.equal(check(base).status, 0);

    const leakedLine = commitFile(cwd, 'a.txt', `clean\n++${unix('alice')}\n`, 'add line');
    assert.equal(check(`${base}..${leakedLine}`).status, 1, 'an added line that starts with ++');
    const removal = commitFile(cwd, 'a.txt', 'clean\n', 'remove line');
    assert.equal(check(`${leakedLine}..${removal}`).status, 0, 'a removed line is not new text');

    const message = commitFile(cwd, 'b.txt', 'ok\n', `note ${mac('alice')}`);
    assert.equal(check(`${removal}..${message}`).status, 1, 'a commit message');

    // A path that only the merge commit adds.
    git(cwd, ['checkout', '-q', '-b', 'side', removal]);
    commitFile(cwd, 'side.txt', 'side\n', 'side');
    git(cwd, ['checkout', '-q', 'main']);
    git(cwd, ['merge', '-q', '--no-ff', '--no-commit', 'side']);
    fs.writeFileSync(path.join(cwd, 'merge.txt'), `${unix('alice')}\n`);
    git(cwd, ['add', 'merge.txt']);
    git(cwd, ['commit', '-q', '-m', 'merge side']);
    const merge = git(cwd, ['rev-parse', 'HEAD']);
    assert.equal(check(`${message}..${merge}`).status, 1, 'a merge commit');

    const missing = 'a'.repeat(40);
    assert.notEqual(check(`${missing}..${merge}`).status, 0, 'an unknown base');
    assert.notEqual(check('HEAD').status, 0, 'a non-SHA range');
    assert.notEqual(check(`${base}..${removal}`, failingTool(cwd, 'grep')).status, 0, 'a failing scanner');
  });
});

test('push-range check reads pre-commit refs and fails closed', () => {
  withTempDir(cwd => {
    git(cwd, ['init', '-q', '-b', 'main']);
    const root = commitFile(cwd, 'a.txt', `${unix('alice')}\n`, 'root');
    const hook = extra => run(rangeScript, [], { cwd, env: extra });

    assert.equal(hook({ PRE_COMMIT_FROM_REF: '', PRE_COMMIT_TO_REF: root }).status, 1, 'a new branch');
    assert.equal(hook({ PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/main' }).status, 1, 'a root push without refs');
    assert.equal(hook({ PRE_COMMIT_TO_REF: '0'.repeat(40) }).status, 0, 'a ref deletion');
    assert.notEqual(hook({}).status, 0, 'no range');
    assert.notEqual(hook({ PRE_COMMIT_FROM_REF: 'b'.repeat(40), PRE_COMMIT_TO_REF: root }).status, 0, 'an unknown base');
    assert.notEqual(hook({ PRE_COMMIT_LOCAL_BRANCH: '--all' }).status, 0, 'an option as a ref');
  });
});
