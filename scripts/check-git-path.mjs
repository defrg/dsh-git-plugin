/**
 * dsh-git-plugin — git 可执行文件定位自检（不依赖 DSH）。
 *
 *   node scripts/check-git-path.mjs
 *
 * 重点验证「git 目录可配置」这条需求：
 *   1. 显式 gitPath / gitDir 必须被采纳，并如实报告来源；
 *   2. 显式配置指向不存在的路径时**不能静默跳过**——要记进 attempts 一并返回，
 *      否则在别的机器上配错了路径会表现为"莫名其妙用了别的 git"；
 *   3. 什么都不配时按 GIT_PATH → 各平台标准位置 → PATH 的顺序回退；
 *   4. resolveRepo 的三级回退（参数 → 配置 → 进程 cwd）与来源标注。
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_EXE, DEFAULTS, resolveConfig, resolveGitPath, resolveRepo } from '../lib/git.js';

let failed = 0;

function assert(condition, label, detail) {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 造一个假的 Git 安装根目录：<root>/cmd/git.exe（Windows）或 <root>/bin/git（POSIX）。 */
function makeFakeGitRoot(root) {
  const relative = process.platform === 'win32' ? join('cmd', GIT_EXE) : join('bin', GIT_EXE);
  const exe = join(root, relative);
  mkdirSync(join(root, process.platform === 'win32' ? 'cmd' : 'bin'), { recursive: true });
  writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  return { exe, relative };
}

const work = process.env.DSH_GIT_PLUGIN_CHECK_DIR || join(process.env.TEMP || '/tmp', 'dsh-git-plugin-check');
const sandbox = join(work, 'path-probe');
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

console.log('dsh-git-plugin 可执行文件定位自检\n');
console.log(`平台：${process.platform}-${process.arch}`);
console.log(`临时目录：${sandbox}\n`);

// ---------------------------------------------------------------- 1. 显式 gitPath
console.log('[1] 显式 gitPath 优先');
const fakeA = makeFakeGitRoot(join(sandbox, 'rootA'));
const byPath = resolveGitPath({ gitPath: fakeA.exe, gitDir: join(sandbox, 'ignored') });
assert(byPath.path === fakeA.exe, '采纳 gitPath 指定的文件', byPath.path);
assert(byPath.source === '配置项 gitPath', '来源标注为「配置项 gitPath」', byPath.source);
assert(byPath.resolved === true, 'resolved = true');

// ---------------------------------------------------------------- 2. gitDir 拼装
console.log('\n[2] 显式 gitDir 拼出可执行文件');
const fakeB = makeFakeGitRoot(join(sandbox, 'rootB'));
const byDir = resolveGitPath({ gitDir: join(sandbox, 'rootB') });
assert(byDir.path === fakeB.exe, '在 gitDir 下找到可执行文件', byDir.path);
assert(byDir.source.includes('配置项 gitDir'), '来源标注为「配置项 gitDir」', byDir.source);
assert(byDir.source.includes(fakeB.relative), '来源里带上命中的相对路径', byDir.source);

// ---------------------------------------------------------------- 3. 配错了要说清楚
console.log('\n[3] 显式配置指向不存在的路径 —— 必须留痕，不能静默跳过');
const missing = join(sandbox, 'no-such-dir');
const byMissing = resolveGitPath({ gitPath: join(missing, GIT_EXE), gitDir: missing });
assert(byMissing.attempts.length >= 2, '两个失败候选都记进 attempts', `实际 ${byMissing.attempts.length} 条`);
assert(byMissing.attempts.some((a) => a.includes('gitPath')), 'attempts 里说明 gitPath 为何不成立');
assert(byMissing.attempts.some((a) => a.includes('gitDir')), 'attempts 里说明 gitDir 为何不成立');
console.log(`     实际记录：\n${byMissing.attempts.map((a) => `       - ${a}`).join('\n')}`);

// ---------------------------------------------------------------- 4. GIT_PATH 环境变量
console.log('\n[4] GIT_PATH 环境变量');
const fakeC = makeFakeGitRoot(join(sandbox, 'rootC'));
const savedGitPath = process.env.GIT_PATH;
process.env.GIT_PATH = fakeC.exe;
const byEnv = resolveGitPath({});
assert(byEnv.path === fakeC.exe, '采纳 GIT_PATH', byEnv.path);
assert(byEnv.source === 'GIT_PATH 环境变量', '来源标注为环境变量', byEnv.source);
if (savedGitPath === undefined) delete process.env.GIT_PATH;
else process.env.GIT_PATH = savedGitPath;

// ---------------------------------------------------------------- 5. 自动探测
console.log('\n[5] 什么都不配时的自动探测');
delete process.env.GIT_PATH;
const auto = resolveGitPath({});
assert(typeof auto.path === 'string' && auto.path.length > 0, '返回了一个候选路径', auto.path);
assert(typeof auto.source === 'string' && auto.source.length > 0, '返回了来源', auto.source);
console.log(`     结果：${auto.path}\n     来源：${auto.source}`);
if (auto.resolved) {
  assert(existsSync(auto.path), '自动探测到的路径真实存在', auto.path);
} else {
  console.log('     （本机标准位置未找到 git，回退到 PATH —— 在装了 Git 的机器上应为 resolved=true）');
}

// ---------------------------------------------------------------- 6. resolveConfig
console.log('\n[6] resolveConfig 的默认值与归一化');
const cfg = resolveConfig({ protectedBranches: [' main ', '', 'release'] });
assert(cfg.protectedBranches.join(',') === 'main,release', 'protectedBranches 去空白并剔除空项', cfg.protectedBranches.join(','));
assert(cfg.timeoutMs === DEFAULTS.timeoutMs, 'timeoutMs 落到默认值');
assert(cfg.maxTextChars === DEFAULTS.maxTextChars, 'maxTextChars 落到默认值');
assert(cfg.defaultRepo === '', 'defaultRepo 默认留空');
const cfg2 = resolveConfig({ timeoutMs: '45000', maxTextChars: 500 });
assert(cfg2.timeoutMs === 45000, '字符串数字被接受', String(cfg2.timeoutMs));
assert(cfg2.maxTextChars === 500, '数字被接受', String(cfg2.maxTextChars));
assert(resolveConfig({}).protectedBranches.includes('main'), '默认保护 main');

// ---------------------------------------------------------------- 7. resolveRepo
console.log('\n[7] resolveRepo 三级回退与来源标注');
const r1 = resolveRepo(resolveConfig({ defaultRepo: '/from/config' }), '/from/arg');
assert(r1.repo === '/from/arg' && r1.source === '调用参数 repo', '参数优先', `${r1.repo} / ${r1.source}`);
const r2 = resolveRepo(resolveConfig({ defaultRepo: '/from/config' }), undefined);
assert(r2.repo === '/from/config' && r2.source === '配置项 defaultRepo', '其次用配置', `${r2.repo} / ${r2.source}`);
const r3 = resolveRepo(resolveConfig({}), undefined);
assert(r3.source.includes('进程工作目录'), '都没有时用进程 cwd 并标注', r3.source);

// ---------------------------------------------------------------- 清理 & 汇总
rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败 —— git 定位逻辑有问题`);
  process.exit(1);
}
console.log('✓ git 定位逻辑正常：显式配置优先、配错留痕、缺省可跨平台回退');
