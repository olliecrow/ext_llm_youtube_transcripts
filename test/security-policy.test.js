const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scripts = path.join(__dirname, '..', 'scripts', 'security');
const textScript = path.join(scripts, 'check-sensitive-text.sh');
const rangeScript = path.join(scripts, 'check-push-range.sh');
const leaksScript = path.join(scripts, 'gitleaks-range.sh');
const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;

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

for (const shape of ['NUL', 'new attribute', 'parent attribute', 'later attribute']) {
  test(`push scan rejects a secret hidden by ${shape}`, () => {
    withTempDir(cwd => {
      git(cwd, ['init', '-q', '-b', 'main']);
      const base = commitFile(cwd, 'clean.txt', 'clean\n', 'base');
      if (shape === 'parent attribute') commitFile(cwd, '.gitattributes', '* -diff\n', 'attributes');
      if (shape === 'new attribute') fs.writeFileSync(path.join(cwd, '.gitattributes'), '* -diff\n');
      fs.writeFileSync(path.join(cwd, 'secret.txt'), `token=${'gh' + 'p_' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5'}\n${shape === 'NUL' ? '\0' : ''}`);
      git(cwd, ['add', '.']);
      git(cwd, ['commit', '-q', '-m', 'sample']);
      if (shape === 'later attribute') commitFile(cwd, '.gitattributes', '* -diff\n', 'attributes');
      const head = git(cwd, ['rev-parse', 'HEAD']);
      const result = run(rangeScript, ['--range', `${base}..${head}`], { cwd });
      assert.equal(result.status, 1, result.stderr);
      if (hasGitleaks) {
        const leaks = run(leaksScript, [`${base}..${head}`], { cwd });
        assert.equal(leaks.status, 1, leaks.stdout + leaks.stderr);
      }
    });
  });
}

test('zero-base pushes do not exclude commits on unrelated remotes', () => {
  withTempDir(cwd => {
    git(cwd, ['init', '-q', '-b', 'main']);
    const base = commitFile(cwd, 'clean.txt', 'clean\n', 'base');
    commitFile(cwd, 'secret.txt', `${unix('alice')}\n`, 'ancestor');
    const head = commitFile(cwd, 'clean.txt', 'still clean\n', 'tip');
    git(cwd, ['update-ref', 'refs/remotes/backup/main', head]);
    git(cwd, ['update-ref', 'refs/remotes/origin/main', base]);
    for (const remote of ['', 'origin']) {
      const result = run(rangeScript, [], { cwd, env: {
        PRE_COMMIT_FROM_REF: '0'.repeat(40), PRE_COMMIT_TO_REF: head,
        PRE_COMMIT_REMOTE_NAME: remote
      } });
      assert.equal(result.status, 1, `remote=${remote}\n${result.stderr}`);
    }
    git(cwd, ['update-ref', 'refs/remotes/origin/main', head]);
    assert.equal(run(rangeScript, [], { cwd, env: {
      PRE_COMMIT_TO_REF: head, PRE_COMMIT_REMOTE_NAME: 'origin'
    } }).status, 0, 'no new commits on the target remote');
  });
});

test('gitleaks wrapper rejects logged errors and silent zero-commit scans', () => {
  withTempDir(cwd => {
    git(cwd, ['init', '-q', '-b', 'main']);
    const base = commitFile(cwd, 'clean.txt', 'clean\n', 'base');
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    for (const log of ['ERR git failed', 'INF 0 commits scanned', 'INF no leaks found']) {
      fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh\necho '${log}'\nexit 0\n`, { mode: 0o755 });
      const result = run(leaksScript, [base], { cwd, env: { PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(result.status, 2, result.stdout + result.stderr);
    }
    assert.equal(run(leaksScript, ['a'.repeat(40)], { cwd }).status, 2);
  });
});

test('gitleaks accepts empty and deletion-only ranges', { skip: !hasGitleaks }, () => {
  withTempDir(cwd => {
    git(cwd, ['init', '-q', '-b', 'main']);
    const base = commitFile(cwd, 'clean.txt', 'clean\n', 'base');
    const head = commitFile(cwd, 'clean.txt', '', 'remove');
    for (const range of [`${base}..${base}`, `${base}..${head}`]) {
      const result = run(leaksScript, [range], { cwd });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  });
});
