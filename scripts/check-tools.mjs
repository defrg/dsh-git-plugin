/**
 * dsh-git-plugin — 工具功能自检（不依赖 DSH）。
 *
 *   node scripts/check-tools.mjs
 *
 * 它在一个临时目录里**建一个真仓库**，然后把插件注册的工具当成真实调用走一遍：
 * 探活 → 建仓 → 配置身份 → 改文件 → status → add → commit → log → diff → branch
 * → stash → restore → remote → 受保护分支拦截 → 逃生口 git_run。
 *
 * 临时目录：`DSH_GIT_PLUGIN_CHECK_DIR` 环境变量，未设置则用系统临时目录。
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

let failed = 0;
let passed = 0;

function assert(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- 假 ctx：捕获工具注册

const registered = new Map();

const ctx = {
  on() {
    return () => {};
  },
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => {};
    },
  },
  settings: {
    async update() {
      return {};
    },
  },
};

const work = process.env.DSH_GIT_PLUGIN_CHECK_DIR || join(process.env.TEMP || '/tmp', 'dsh-git-plugin-check');
const sandbox = join(work, 'tools-probe');
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
const repo = join(sandbox, 'repo');
mkdirSync(repo, { recursive: true });

// 用配置 defaultRepo 指到临时仓库，顺便验证「默认仓库可配置」这条路径
apply(ctx, { defaultRepo: repo });

/** 调一个已注册的工具。 */
async function tool(name, args = {}) {
  const definition = registered.get(name);
  if (!definition) throw new Error(`工具未注册：${name}`);
  return await definition.execute(args);
}

console.log('dsh-git-plugin 工具功能自检\n');
console.log(`临时仓库：${repo}\n`);

// ---------------------------------------------------------------- 1. 注册面

console.log('[1] 工具注册面');
const expected = [
  'git_version', 'git_status', 'git_log', 'git_diff', 'git_show', 'git_blame',
  'git_branch', 'git_add', 'git_commit', 'git_restore', 'git_stash',
  'git_remote', 'git_sync', 'git_run', 'git_repo',
];
for (const toolName of expected) {
  const definition = registered.get(toolName);
  assert(
    Boolean(definition) && typeof definition.execute === 'function' && typeof definition.description === 'string' && definition.description.length > 10,
    `${toolName} 已注册且带说明`,
  );
}
assert(registered.size === expected.length, `注册数量正好 ${expected.length} 个`, `实际 ${registered.size}`);

const roTools = ['git_version', 'git_status', 'git_log', 'git_diff', 'git_show', 'git_blame'];
assert(roTools.every((t) => registered.get(t).isConcurrencySafe() === true), '只读工具声明为可并发');
assert(registered.get('git_commit').isConcurrencySafe() === false, '写操作声明为串行');

// ---------------------------------------------------------------- 2. 探活

console.log('\n[2] 探活');
const version = await tool('git_version');
assert(version.ok === true, 'git 可用', version.reason);
assert(typeof version.version === 'string' && /^\d+\./.test(version.version), `解析出版本号：${version.version}`, version.version);
assert(typeof version.gitSource === 'string' && version.gitSource.length > 0, `报告了来源：${version.gitSource}`);

// ---------------------------------------------------------------- 3. 非仓库目录

console.log('\n[3] 非仓库目录的判定');
const notRepo = await tool('git_repo', { repo: sandbox });
assert(notRepo.ok === false && notRepo.code === 'NOT_A_REPO', '未建仓前报 NOT_A_REPO');
assert(notRepo.text.includes('defaultRepo') || notRepo.text.includes('repo'), '提示里给出了如何换目录');

// ---------------------------------------------------------------- 4. 建仓与身份（走 git_run）

console.log('\n[4] git_run 逃生口：建仓与配置身份');
const init = await tool('git_run', { args: ['init', '-b', 'main'] });
assert(init.code === 0, 'git init -b main 成功', init.text);
const setName = await tool('git_run', { args: ['config', 'user.name', 'dsh-git-plugin check'] });
const setMail = await tool('git_run', { args: ['config', 'user.email', 'check@example.invalid'] });
assert(setName.code === 0 && setMail.code === 0, '写入提交身份（本机全局未配 user.name/email）');

const asRepo = await tool('git_repo');
assert(asRepo.ok === true, '建仓后判定为 git 仓库');
assert(asRepo.branch === 'main', `当前分支 main`, asRepo.branch);
assert(asRepo.root.replace(/\\/g, '/').endsWith('tools-probe/repo'), '返回仓库根', asRepo.root);

// ---------------------------------------------------------------- 5. status / add / commit

console.log('\n[5] 工作区状态与提交');
writeFileSync(join(repo, 'a.txt'), 'hello\n');
let status = await tool('git_status');
assert(status.ok === true, 'git_status 成功');
assert(status.clean === false, '有未提交改动');
assert(status.untracked.some((p) => p.includes('a.txt')), 'a.txt 出现在未跟踪列表', JSON.stringify(status.untracked));

const added = await tool('git_add', { paths: ['a.txt'] });
assert(added.ok === true, 'git_add 成功');
status = await tool('git_status');
assert(status.staged.some((p) => p.includes('a.txt')), 'a.txt 进入已暂存', JSON.stringify(status.staged));

const commit = await tool('git_commit', { message: 'feat: 首个提交' });
assert(commit.ok === true, 'git_commit 成功', commit.text);
assert(typeof commit.sha === 'string' && commit.sha.length >= 7, `解析出提交短哈希：${commit.sha}`, commit.sha);

status = await tool('git_status');
assert(status.clean === true, '提交后工作区干净');

// ---------------------------------------------------------------- 6. log / diff / show

console.log('\n[6] 历史与差异');
const log = await tool('git_log', { limit: 5 });
assert(log.ok === true && log.count === 1, 'git_log 返回 1 条', `count=${log.count}`);
assert(log.entries[0].includes('首个提交'), '提交信息出现在 log 里', log.entries[0]);

let diff = await tool('git_diff');
assert(diff.ok === true && diff.empty === true, '未改动时 diff 为空');

writeFileSync(join(repo, 'a.txt'), 'hello\nworld\n');
diff = await tool('git_diff');
assert(diff.ok === true && diff.empty === false, '改动后 diff 非空');
assert(diff.diff.includes('+world'), 'diff 里含新增行', diff.diff.split('\n').slice(0, 8).join(' / '));

const shown = await tool('git_show', { ref: 'HEAD', stat: true });
assert(shown.ok === true && shown.text.includes('a.txt'), 'git_show --stat 含文件名');

// ---------------------------------------------------------------- 7. restore

console.log('\n[7] restore');
await tool('git_add', { paths: ['a.txt'] });
let staged = await tool('git_status');
assert(staged.staged.length === 1, '改动已暂存');
const restored = await tool('git_restore', { paths: ['a.txt'], staged: true });
assert(restored.ok === true, 'git_restore --staged 成功');
staged = await tool('git_status');
assert(staged.staged.length === 0, '暂存区已清空');
assert(staged.unstaged.some((p) => p.includes('a.txt')), '工作区改动仍保留');

const hardRestore = await tool('git_restore', { paths: ['a.txt'] });
assert(hardRestore.ok === true, 'git_restore 恢复到 HEAD 成功');
const afterRestore = await tool('git_diff');
assert(afterRestore.empty === true, '恢复后 diff 为空');

// restore 必须要求显式路径
const badRestore = await tool('git_restore', { paths: [] });
assert(badRestore.ok === false && badRestore.code === 'BAD_ARGS', '不带 paths 时拒绝执行');

// ---------------------------------------------------------------- 8. branch

console.log('\n[8] 分支');
let branches = await tool('git_branch', { action: 'list' });
assert(branches.ok === true && branches.current === 'main', 'list 标出当前分支 main', branches.current);
assert(branches.branches.length === 1, '此时只有 1 个分支');

const created = await tool('git_branch', { action: 'create', name: 'feature/x' });
assert(created.ok === true, 'git_branch create 成功', created.text);

const switched = await tool('git_branch', { action: 'switch', name: 'feature/x' });
assert(switched.ok === true, 'git_branch switch 成功');

branches = await tool('git_branch', { action: 'list' });
assert(branches.current === 'feature/x', '当前分支已切到 feature/x', branches.current);
assert(branches.branches.length === 2, '现在有 2 个分支');

// ---------------------------------------------------------------- 9. stash

console.log('\n[9] 贮藏');
writeFileSync(join(repo, 'b.txt'), 'stashed content\n');
const pushed = await tool('git_stash', { action: 'push', message: 'wip-b', includeUntracked: true });
assert(pushed.ok === true, 'git_stash push 成功', pushed.text);

let stashList = await tool('git_stash', { action: 'list' });
assert(stashList.count === 1, '贮藏列表有 1 条', `count=${stashList.count}`);
assert(stashList.entries[0].includes('wip-b'), '贮藏信息里含说明', stashList.entries[0]);

const cleanAfterStash = await tool('git_status');
assert(cleanAfterStash.clean === true, '贮藏后工作区干净');

const popped = await tool('git_stash', { action: 'pop' });
assert(popped.ok === true, 'git_stash pop 成功');
stashList = await tool('git_stash', { action: 'list' });
assert(stashList.count === 0, '弹出后贮藏列表为空');

// ---------------------------------------------------------------- 10. remote

console.log('\n[10] 远端');
const addedRemote = await tool('git_remote', { action: 'add', name: 'origin', url: 'https://example.invalid/repo.git' });
assert(addedRemote.ok === true, 'git_remote add 成功');

const remotes = await tool('git_remote', { action: 'list' });
assert(remotes.ok === true && remotes.remotes.length === 1, '列出 1 个远端');
assert(remotes.remotes[0].name === 'origin', '远端名为 origin');
assert(remotes.remotes[0].fetch === 'https://example.invalid/repo.git', 'URL 解析正确', remotes.remotes[0].fetch);

// ---------------------------------------------------------------- 11. 受保护分支拦截（不触网）

console.log('\n[11] 受保护分支的强制推送拦截');
// 先把 HEAD 切回 main —— 这样才是在验证「不传 branch 时按 HEAD 判断目标分支」那条路径
await tool('git_branch', { action: 'switch', name: 'main' });
const guarded = await tool('git_sync', { action: 'push', force: true });
assert(guarded.ok === false && guarded.code === 'PROTECTED_BRANCH', '对 main 强制推送被拒绝', guarded.code);
assert(guarded.branch === 'main', '识别出目标是 main', guarded.branch);
assert(guarded.text.includes('protectedBranches'), '提示里说明是哪项配置在拦');
assert(guarded.text.includes('设置'), '提示里告诉用户去哪里改');

// main 之外的分支不拦（这里只验证保护名单判定，不真的推）
const notProtected = await tool('git_sync', { action: 'push', branch: 'feature/x', force: true, remote: 'nonexistent-remote' });
assert(notProtected.code !== 'PROTECTED_BRANCH', '非保护分支不会被 PROTECTED_BRANCH 拦下', notProtected.code);

// ---------------------------------------------------------------- 12. 参数校验

console.log('\n[12] 参数校验与错误路径');
const badBranch = await tool('git_branch', { action: 'create' });
assert(badBranch.ok === false && badBranch.code === 'BAD_ARGS', 'create 缺 name 时报 BAD_ARGS');
const badAction = await tool('git_stash', { action: 'nonsense' });
assert(badAction.ok === false && badAction.code === 'BAD_ARGS', '未知 action 报 BAD_ARGS');
const badRun = await tool('git_run', { args: [] });
assert(badRun.ok === false && badRun.code === 'BAD_ARGS', 'git_run 空参数被拒');
const failedRun = await tool('git_run', { args: ['rev-parse', '--verify', 'no-such-ref'] });
assert(failedRun.ok === false && failedRun.code !== 0, 'git_run 对非零退出码如实返回（不抛异常）', `code=${failedRun.code}`);
assert(typeof failedRun.text === 'string' && failedRun.text.includes('退出码'), '输出里带退出码');

// ---------------------------------------------------------------- 清理 & 汇总

rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败（通过 ${passed} 项）`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过 —— 工具在真实仓库上工作正常`);
