/**
 * dsh-git-plugin — git 传输层（零第三方依赖，只用 Node 内置能力）。
 *
 * 两个职责：
 *   1. **定位 git 可执行文件**：不写死任何本机路径，显式配置 → 环境变量 → 各平台标准安装位置逐级回退，
 *      并把「最终用的是哪个路径、来自哪一级」一并返回，便于在别的机器上确认配置是否生效。
 *   2. **执行 git 命令**：一律走 execFile + argv 数组，**不经过 shell**，因此参数里的引号、分号、
 *      `$(...)` 都不会被解释；同时强制关掉分页器与交互式凭据提示，避免 Agent 调用卡死。
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** 该平台上 git 可执行文件的名字。 */
export const GIT_EXE = IS_WINDOWS ? "git.exe" : "git";

/**
 * 一个「Git 根目录」下可执行文件可能所在的相对路径，按优先级排列。
 *
 * Windows 上 Git for Windows 会把 git.exe 放三个地方，官方建议脚本里用 `cmd\git.exe`
 * （它是为命令行设计的包装，`bin\git.exe` 是 MSYS 版，`mingw64\bin\` 是内部实现）。
 * POSIX 上就是 `bin/git`，另外兼容直接指向 bin 目录本身的情况。
 */
function gitRelatives(exe) {
  return [join("cmd", exe), join("bin", exe), join("mingw64", "bin", exe), exe];
}

/** 各平台 git 的常见安装根目录——全部由环境变量拼出，跨机器有效。 */
function standardRoots() {
  if (IS_WINDOWS) {
    return [
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Git"),
      process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git"),
      process.env.USERPROFILE && join(process.env.USERPROFILE, "scoop", "apps", "git", "current"),
    ].filter(Boolean);
  }
  return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/local/git/bin"];
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const trimmed = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");

/**
 * 解析 git 可执行文件。
 *
 * 优先级：显式 `gitPath` → `gitDir` 拼出 → `GIT_PATH` 环境变量 → 各平台标准安装位置 → PATH 兜底。
 * 显式配置若指向不存在的文件**不会静默跳过**，而是记进 `attempts` 一并返回——
 * 在别的机器上配错了路径时，`git_version` 会直接告诉你「你配的 xxx 不存在」。
 *
 * @returns {{ path: string, source: string, resolved: boolean, attempts: string[] }}
 */
export function resolveGitPath(input = {}) {
  const attempts = [];

  const explicitPath = trimmed(input.gitPath);
  if (explicitPath) {
    if (isFile(explicitPath)) return { path: explicitPath, source: "配置项 gitPath", resolved: true, attempts };
    attempts.push(`配置项 gitPath = ${explicitPath}（文件不存在）`);
  }

  const explicitDir = trimmed(input.gitDir);
  if (explicitDir) {
    for (const relative of gitRelatives(GIT_EXE)) {
      const candidate = join(explicitDir, relative);
      if (isFile(candidate)) {
        return { path: candidate, source: `配置项 gitDir → ${relative}`, resolved: true, attempts };
      }
    }
    attempts.push(`配置项 gitDir = ${explicitDir}（下面这些位置都没有 git：${gitRelatives(GIT_EXE).join("、")}）`);
  }

  const fromEnv = trimmed(process.env.GIT_PATH);
  if (fromEnv) {
    if (isFile(fromEnv)) return { path: fromEnv, source: "GIT_PATH 环境变量", resolved: true, attempts };
    attempts.push(`GIT_PATH = ${fromEnv}（文件不存在）`);
  }

  for (const root of standardRoots()) {
    for (const relative of gitRelatives(GIT_EXE)) {
      const candidate = join(root, relative);
      if (isFile(candidate)) {
        return { path: candidate, source: `自动探测（${root}）`, resolved: true, attempts };
      }
    }
  }

  // 兜底：交给 PATH 解析。resolved=false 表示我们没能在本地找到，但 PATH 里可能仍有。
  return { path: GIT_EXE, source: "PATH 兜底（未在标准位置找到）", resolved: false, attempts };
}

/** 配置默认值。所有路径类字段留空 = 自动解析，因此换机器不需要改代码。 */
export const DEFAULTS = {
  gitPath: "",
  gitDir: "",
  defaultRepo: "",
  timeoutMs: 30000,
  maxTextChars: 12000,
  protectedBranches: ["main", "master"],
};

export function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const located = resolveGitPath(cfg);
  return {
    gitPath: located.path,
    gitSource: located.source,
    gitResolved: located.resolved,
    gitAttempts: located.attempts,
    defaultRepo: trimmed(cfg.defaultRepo),
    timeoutMs: num(cfg.timeoutMs, DEFAULTS.timeoutMs),
    maxTextChars: num(cfg.maxTextChars, DEFAULTS.maxTextChars),
    protectedBranches: Array.isArray(cfg.protectedBranches)
      ? cfg.protectedBranches.map((b) => String(b).trim()).filter(Boolean)
      : DEFAULTS.protectedBranches.slice(),
  };
}

/**
 * 解析本次调用要操作的仓库目录。
 * 顺序：调用参数 repo → 配置 defaultRepo → 进程 cwd。
 * 无论走哪一级，结果里都会带上 `repo` 与 `repoSource`，避免"到底在哪个仓库上跑的"这种歧义。
 */
export function resolveRepo(cfg, requested) {
  const explicit = trimmed(requested);
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : join(process.cwd(), explicit);
    return { repo: explicit, abs: path, source: "调用参数 repo", exists: isDirectory(explicit) };
  }
  if (cfg.defaultRepo) {
    return { repo: cfg.defaultRepo, abs: cfg.defaultRepo, source: "配置项 defaultRepo", exists: isDirectory(cfg.defaultRepo) };
  }
  return { repo: process.cwd(), abs: process.cwd(), source: "进程工作目录（未指定 repo）", exists: isDirectory(process.cwd()) };
}

/** 子进程最大输出（git log 之类的输出可能很大）。 */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 执行一条 git 命令。
 *
 * **不会因 git 返回非零退出码而抛错** —— 很多正常情形就是非零（例如 `git diff --exit-code`
 * 有差异时返回 1），由调用方按 `code` 自行判断。只有「进程根本起不来」和「超时」才标成硬错误。
 *
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ok:boolean,
 *                    command:string, repo:string|null, timedOut:boolean, spawnError:string|null}>}
 */
export function runGit(cfg, args, options = {}) {
  const argv = [
    // 不转义非 ASCII 路径：否则中文文件名会输出成 \344\270\255 这种八进制
    "-c", "core.quotepath=false",
    // 全局禁用分页器，避免输出被 less 吞掉
    "--no-pager",
    ...args.map(String),
  ];

  const repo = options.repo && isDirectory(options.repo) ? options.repo : undefined;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : cfg.timeoutMs;

  const env = {
    ...process.env,
    // 绝不弹交互式凭据提示：Agent 调用里那会直接卡死到超时
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // 固定英文输出，便于稳定解析
    LC_ALL: "C",
    LANG: "C",
    // 只读命令不要因为拿不到 index.lock 而失败
    GIT_OPTIONAL_LOCKS: "0",
  };

  const command = `git ${argv.join(" ")}`;

  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ command, repo: repo ?? null, timedOut: false, spawnError: null, ...payload });
    };

    let child;
    try {
      child = execFile(
        cfg.gitPath,
        argv,
        { cwd: repo, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) {
            done({ code: 0, ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          // 超时：execFile 会杀掉进程并给出 killed/signal
          if (error.killed || error.signal) {
            done({
              code: null,
              ok: false,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              timedOut: true,
              spawnError: `命令在 ${timeoutMs}ms 内没有结束，已终止`,
            });
            return;
          }
          // 进程根本没起来（路径不对、没有执行权限）
          if (typeof error.code === "string" && !/^\d+$/.test(error.code)) {
            done({
              code: null,
              ok: false,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              spawnError:
                error.code === "ENOENT"
                  ? `找不到 git 可执行文件：${cfg.gitPath}（当前来源：${cfg.gitSource}）。用 git_version 查看探测过程，或配置 gitDir / gitPath。`
                  : `启动 git 失败：${error.code} ${error.message}`,
            });
            return;
          }
          // 正常的非零退出码
          done({ code: Number(error.code), ok: false, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    } catch (error) {
      done({ code: null, ok: false, stdout: "", stderr: "", spawnError: `启动 git 失败：${error?.message ?? String(error)}` });
      return;
    }

    child.on("error", (error) => {
      done({ code: null, ok: false, stdout: "", stderr: "", spawnError: `启动 git 失败：${error?.message ?? String(error)}` });
    });
  });
}

/** 取 git 版本号（同时用于探活）。 */
export async function gitVersion(cfg) {
  const result = await runGit(cfg, ["--version"], { timeoutMs: 8000 });
  if (result.spawnError || result.code !== 0) return { ...result, version: null };
  const match = /git version (\S+)/.exec(result.stdout);
  return { ...result, version: match ? match[1] : result.stdout.trim() || null };
}

/** 判断某个目录是不是 git 仓库（找 .git，同时兼容 worktree/submodule 的 .git 文件形态）。 */
export async function isGitRepo(cfg, dir) {
  if (!isDirectory(dir)) return false;
  const result = await runGit(cfg, ["rev-parse", "--is-inside-work-tree"], { repo: dir, timeoutMs: 8000 });
  return result.code === 0 && result.stdout.trim() === "true";
}

/** 拆分输出行为数组（去掉结尾空行）。 */
export const lines = (text) => String(text ?? "").split(/\r?\n/).filter((line) => line !== "");
