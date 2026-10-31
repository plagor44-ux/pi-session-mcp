import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const { allowedReadRoots, createConfinedReadOnlyTools, confineToolPath, confinedOperations, OUTSIDE_ROOTS_MESSAGE } =
  await import(new URL('../../../dist/confined-tools.js', import.meta.url));

const root = await mkdtemp(join(tmpdir(), 'snapshot-proof-'));
const home = join(root, 'home');
const repo = join(root, 'operator');
const snap = join(root, 'snapshot');
const snapLinks = join(root, 'views', 'snapshot-links');
const snapSub = join(root, 'snapshot-sub');
const env = {
  PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Snapshot Proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid',
  GIT_COMMITTER_NAME: 'Snapshot Proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-31T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-31T12:00:00Z',
};
let failed = false;
function gitResult(...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function git(...args) {
  const result = gitResult(...args);
  if (result.status !== 0) throw new Error('git command failed');
  return result.stdout.trim();
}
function at(dir, ...args) { return git('-C', dir, ...args); }
function hasObject(dir, oid) { return gitResult('-C', dir, 'cat-file', '-e', `${oid}^{commit}`).status === 0; }
function materialize(operatorRepo, snapDir, binding) {
  if (!hasObject(operatorRepo, binding.base) || !hasObject(operatorRepo, binding.head)) return 'snapshot_object_missing';
  at(operatorRepo, 'worktree', 'add', '--detach', snapDir, binding.head);
  return 'ok';
}
function verifySnapshot(dir, binding) {
  if (at(dir, 'rev-parse', 'HEAD') !== binding.head) return { ok: false, code: 'snapshot_head_changed' };
  if (at(dir, 'rev-parse', `${binding.head}^{tree}`) !== binding.tree) return { ok: false, code: 'snapshot_tree_mismatch' };
  // Read-only check: no optional index refresh, and ignored files and index flags count as changes.
  if (at(dir, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching') !== '') return { ok: false, code: 'snapshot_modified' };
  if (at(dir, '--no-optional-locks', 'ls-files', '-v').split('\n').some(line => line !== '' && !line.startsWith('H '))) return { ok: false, code: 'snapshot_modified' };
  if (at(dir, 'ls-tree', '-r', binding.head).split('\n').some(line => line.startsWith('160000 '))) return { ok: false, code: 'snapshot_submodule_present' };
  if (!hasObject(dir, binding.base)) return { ok: false, code: 'snapshot_object_missing' };
  return { ok: true };
}
async function reader(dir) {
  const roots = await allowedReadRoots(dir, []);
  const tool = createConfinedReadOnlyTools(dir, roots).find(item => item.name === 'read');
  assert.ok(tool);
  return { roots, read: async path => {
    const result = await tool.execute('proof', { path }, undefined, undefined, { cwd: dir });
    return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  } };
}
async function rejected(fn) {
  await assert.rejects(fn, error => error.message === OUTSIDE_ROOTS_MESSAGE);
}
async function runCase(name, expected, fn) {
  let observed;
  try { observed = await fn(); } catch { observed = 'error'; }
  const pass = observed === expected;
  failed ||= !pass;
  const line = JSON.stringify({ case: name, expected, observed, pass });
  console.log(line.split(root).join('<tmp>'));
}
let binding, selectedReader, changedCommit, linksBinding;
try {
  await mkdir(home);
  await mkdir(repo);
  await mkdir(join(root, 'views'));
  await runCase('setup', 'ok', async () => {
    at(repo, 'init', '-b', 'main');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src/value.txt'), 'main\n');
    at(repo, 'add', '.'); at(repo, 'commit', '-m', 'main');
    const base = at(repo, 'rev-parse', 'HEAD');
    at(repo, 'checkout', '-b', 'feature');
    await writeFile(join(repo, 'src/value.txt'), 'feature\n');
    await writeFile(join(repo, 'src/added.txt'), 'added\n');
    await writeFile(join(repo, '.gitignore'), '*.log\n');
    at(repo, 'add', '.'); at(repo, 'commit', '-m', 'feature');
    binding = { base, head: at(repo, 'rev-parse', 'HEAD'), tree: at(repo, 'rev-parse', 'HEAD^{tree}') };
    assert.equal(at(repo, 'branch', '--show-current'), 'feature');
    assert.equal(at(repo, 'rev-parse', `${binding.head}^{tree}`), binding.tree);
    return 'ok';
  });
  await runCase('reads-selected-head', 'feature', async () => {
    assert.equal(materialize(repo, snap, binding), 'ok');
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    selectedReader = await reader(snap);
    return (await selectedReader.read('src/value.txt')).trim();
  });
  await runCase('operator-edits-do-not-leak', 'feature', async () => {
    await writeFile(join(repo, 'src/value.txt'), 'changed-after-snapshot\n');
    at(repo, 'add', '.'); at(repo, 'commit', '-m', 'changed-after-snapshot');
    changedCommit = at(repo, 'rev-parse', 'HEAD');
    at(repo, 'checkout', 'main');
    await writeFile(join(repo, 'src/value.txt'), 'uncommitted\n');
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    return (await selectedReader.read('src/value.txt')).trim();
  });
  await runCase('snapshot-edit-detected', 'snapshot_modified', async () => {
    await writeFile(join(snap, 'src/value.txt'), 'edit\n');
    assert.equal(verifySnapshot(snap, binding).code, 'snapshot_modified');
    at(snap, 'checkout', '--', '.');
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    await writeFile(join(snap, 'untracked'), 'edit\n');
    const result = verifySnapshot(snap, binding).code;
    await rm(join(snap, 'untracked'));
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    return result;
  });
  await runCase('ignored-file-detected', 'snapshot_modified', async () => {
    await writeFile(join(snap, 'review.log'), 'not part of head\n');
    // Plain status, as in the first ADR draft, does not see it.
    assert.equal(at(snap, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    const result = verifySnapshot(snap, binding).code;
    await rm(join(snap, 'review.log'));
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    return result;
  });
  await runCase('index-flag-detected', 'snapshot_modified', async () => {
    at(snap, 'update-index', '--skip-worktree', 'src/value.txt');
    await writeFile(join(snap, 'src/value.txt'), 'hidden edit\n');
    assert.equal(at(snap, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'), '');
    const result = verifySnapshot(snap, binding).code;
    at(snap, 'update-index', '--no-skip-worktree', 'src/value.txt');
    at(snap, 'checkout', '--', '.');
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    return result;
  });
  await runCase('verification-does-not-write-git-metadata', 'unchanged;control=rewritten', async () => {
    const indexFile = at(snap, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = await readFile(indexFile);
    const beforeStat = await lstat(indexFile);
    // Touch a tracked file so that a refreshing status would rewrite the index.
    await writeFile(join(snap, 'src/value.txt'), 'feature\n');
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    const afterStat = await lstat(indexFile);
    assert.ok(before.equals(await readFile(indexFile)));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    // Control: an ordinary status in the same situation refreshes (rewrites) the index.
    at(snap, 'status', '--porcelain=v1');
    const control = (await lstat(indexFile)).mtimeMs !== beforeStat.mtimeMs ? 'rewritten' : 'not-rewritten';
    return `unchanged;control=${control}`;
  });
  await runCase('plain-remove-deletes-ignored-work', 'removed', async () => {
    // Why setup must verify (including ignored files) before removing: Git alone does not refuse.
    const probe = join(root, 'probe');
    assert.equal(materialize(repo, probe, binding), 'ok');
    await writeFile(join(probe, 'operator-notes.log'), 'would be lost\n');
    assert.equal(verifySnapshot(probe, binding).code, 'snapshot_modified');
    assert.equal(gitResult('-C', repo, 'worktree', 'remove', probe).status, 0);
    await assert.rejects(() => lstat(probe), { code: 'ENOENT' });
    return 'removed';
  });
  await runCase('head-moved-detected', 'snapshot_head_changed', async () => {
    at(snap, 'checkout', '--detach', binding.base);
    const result = verifySnapshot(snap, binding).code;
    at(snap, 'checkout', '--detach', binding.head);
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    return result;
  });
  await runCase('tree-binding-checked', 'snapshot_tree_mismatch', async () => {
    return verifySnapshot(snap, { ...binding, tree: at(repo, 'rev-parse', `${binding.base}^{tree}`) }).code;
  });
  await runCase('missing-object-fails-before-start', 'snapshot_object_missing', async () => {
    const target = join(root, 'missing');
    const missing = '0'.repeat(40);
    assert.equal(hasObject(repo, missing), false);
    const result = materialize(repo, target, { ...binding, head: missing });
    await assert.rejects(() => lstat(target), { code: 'ENOENT' });
    return result;
  });
  await runCase('symlink-escape-rejected', 'rejected', async () => {
    // Commit via a separate temporary worktree, preserving the operator's dirty main.
    const builder = join(root, 'builder');
    at(repo, 'worktree', 'add', '--detach', builder, binding.head);
    await writeFile(join(root, 'outside.txt'), 'outside\n');
    await symlink(join(root, 'outside.txt'), join(builder, 'escape'));
    await symlink('../../outside.txt', join(builder, 'up'));
    await symlink('src/value.txt', join(builder, 'inside'));
    at(builder, 'add', '.'); at(builder, 'commit', '-m', 'links');
    linksBinding = { ...binding, head: at(builder, 'rev-parse', 'HEAD'), tree: at(builder, 'rev-parse', 'HEAD^{tree}') };
    at(repo, 'worktree', 'remove', builder);
    assert.equal(materialize(repo, snapLinks, linksBinding), 'ok');
    assert.deepEqual(verifySnapshot(snapLinks, linksBinding), { ok: true });
    const r = await reader(snapLinks);
    await rejected(() => r.read('escape')); await rejected(() => r.read('up'));
    assert.equal((await r.read('inside')).trim(), 'feature');
    // Also exercise the exported operations layer independently.
    await rejected(() => confinedOperations(r.roots).read.readFile(join(snapLinks, 'escape')));
    return 'rejected';
  });
  await runCase('git-metadata-outside-roots', 'rejected', async () => {
    const r = await reader(snap);
    assert.equal((await lstat(join(snap, '.git'))).isFile(), true);
    assert.match(await r.read('.git'), /^gitdir: /);
    const common = at(snap, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    await rejected(() => confineToolPath(join(common, 'HEAD'), snap, r.roots));
    await rejected(() => confineToolPath(join(common, 'config'), snap, r.roots));
    return 'rejected';
  });
  await runCase('submodule-detected', 'snapshot_submodule_present', async () => {
    const builder = join(root, 'sub-builder');
    at(repo, 'worktree', 'add', '--detach', builder, binding.head);
    at(builder, 'update-index', '--add', '--cacheinfo', `160000,${binding.base},sub`);
    at(builder, 'commit', '-m', 'gitlink');
    await mkdir(join(builder, 'sub'));
    const subBinding = { ...binding, head: at(builder, 'rev-parse', 'HEAD'), tree: at(builder, 'rev-parse', 'HEAD^{tree}') };
    at(repo, 'worktree', 'remove', builder);
    assert.equal(materialize(repo, snapSub, subBinding), 'ok');
    return verifySnapshot(snapSub, subBinding).code;
  });
  await runCase('cleanup-preserves-operator-work', 'preserved', async () => {
    assert.deepEqual(verifySnapshot(snap, binding), { ok: true });
    at(repo, 'worktree', 'remove', snap);
    await assert.rejects(() => lstat(snap), { code: 'ENOENT' });
    assert.equal(at(repo, 'rev-parse', 'main'), binding.base);
    assert.equal(at(repo, 'rev-parse', 'feature'), changedCommit);
    assert.equal(at(repo, 'rev-parse', `${changedCommit}^`), binding.head);
    assert.equal(at(repo, 'branch', '--show-current'), 'main');
    assert.equal(await readFile(join(repo, 'src/value.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(at(repo, 'status', '--porcelain=v1', '--untracked-files=all'), 'M src/value.txt');
    assert.ok(!at(repo, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${snap}`));
    await writeFile(join(snapLinks, 'src/value.txt'), 'modified\n');
    assert.notEqual(gitResult('-C', repo, 'worktree', 'remove', snapLinks).status, 0);
    assert.equal((await lstat(snapLinks)).isDirectory(), true);
    return 'preserved';
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
