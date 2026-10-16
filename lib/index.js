/**
 * dsh-git-plugin — Host half.
 *
 * 把 git 的常用操作接成 DSH 工具。设计要点：
 *
 *   - **git 安装位置可配置**：`gitPath`（直接指可执行文件）或 `gitDir`（指安装根目录，
 *     如 `C:\Program Files\Git`）。两者都留空时自动探测，因此同一份代码换机器不用改。
 *     `git_version` 会报告「最终用了哪个路径、来自哪一级、其它候选为什么不成立」。
 *   - **零第三方依赖**，只用 Node 内置能力。
 *   - **不经过 shell**：所有命令走 argv 数组，参数里的引号/分号/`$()` 都不会被解释。
 *   - **绝不阻塞在交互上**：强制 `GIT_TERMINAL_PROMPT=0` 并禁用分页器，
 *     否则需要凭据的 fetch/push 会把 Agent 调用挂到超时。
 */
import Schema from "@deepseek-ai/schemastery";
import { DEFAULTS, gitVersion, isGitRepo, lines, resolveConfig, resolveRepo, runGit } from "./git.js";

export const name = "dsh-git-plugin";

/** tools 注册工具；settings 让 git 目录这类路径能在设置界面里改并写回 profile 覆盖层。 */
export const inject = ["tools", "settings"];

/**
 * 配置 schema。每项都必须 `.volatile()`——按官方 cookbook，只有 volatile 字段才会进入
 * 「设置 → 插件」表单；代价是运行时拿到的是 Volatile 包装，需要 .get() 取值（见 snapshot()）。
 */
export const Config = Schema.object({
  gitDir: Schema.string()
    .description("Git 安装根目录，例如 Windows 的 C:\\Program Files\\Git、macOS 的 /usr/local。留空 = 自动探测。将被拼成 <gitDir>/cmd/git.exe、<gitDir>/bin/git 等候选")
    .default("")
    .volatile(),
  gitPath: Schema.string()
    .description("git 可执行文件的完整路径。填了它优先于 gitDir。留空 = 依次尝试 gitDir → GIT_PATH 环境变量 → 各平台标准安装位置 → PATH")
    .default("")
    .volatile(),
  defaultRepo: Schema.string()
    .description("默认仓库目录。工具调用里没传 repo 时用它；再留空则用 DSH 进程的工作目录。每台机器按自己的仓库布局设置")
    .default("")
    .volatile(),
  timeoutMs: Schema.number()
    .description("单条 git 命令的超时（毫秒）。clone/fetch 这类网络操作可以调大")
    .default(30000)
    .volatile(),
  maxTextChars: Schema.number()
    .description("工具返回文本的截断上限（字符），防止 git log 整段历史灌爆上下文")
    .default(12000)
    .volatile(),
  protectedBranches: Schema.array(Schema.string())
    .description("受保护分支名。git_sync 拒绝对它们做强制推送（即使调用方传了 force: true）")
    .default(["main", "master"])
    .volatile(),
});

/** 只读工具允许并发执行；其余串行，避免 index.lock 争抢与工作区互相打架。 */
const READ_ONLY = new Set(["git_version", "git_status", "git_log", "git_diff", "git_show", "git_blame"]);

/** volatile 字段在运行时是 Volatile 包装（用 .get() 取值）；普通字段直接就是值。 */
function unwrapVolatile(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}

function truncate(text, limit) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符；可用 maxTextChars 调大）` : text;
}

function asText(value, limit) {
  if (typeof value === "string") return truncate(value, limit);
  try {
    return truncate(JSON.stringify(value, null, 2), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

/** 从工具结果里取出文本，供 presentResult 用。 */
function contentText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** repo 参数的统一文案——几乎所有工具都要它。 */
const REPO_PROP = {
  type: "string",
  description: "仓库目录（绝对路径，或相对进程 cwd）。省略则用配置 defaultRepo，再省略用进程 cwd；结果里会回显实际用的目录。",
};

/** 把一次 runGit 的结果翻成结构化失败信息。非零退出码不算异常，交给调用方判断。 */
function failureOf(result) {
  if (result.spawnError) {
    return { code: result.timedOut ? "GIT_TIMEOUT" : "GIT_NOT_FOUND", message: result.spawnError };
  }
  const stderr = result.stderr.trim();
  return { code: "GIT_FAILED", message: stderr || `git 退出码 ${result.code}` };
}

export function apply(ctx, config) {
  const snapshot = () => {
    const raw = config && typeof config === "object" ? config : {};
    const plain = {};
    for (const [key, value] of Object.entries(raw)) plain[key] = unwrapVolatile(value);
    return resolveConfig(plain);
  };

  let cfg = snapshot();
  // 在界面上改配置不会重新 apply 插件，只会发这个事件：重算一次，后续调用就会用上新值
  ctx.on("loader/volatile-update", () => {
    cfg = snapshot();
  });

  const define = (spec) =>
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [
          { type: "text", text: value && typeof value.text === "string" ? value.text : asText(value, cfg.maxTextChars) },
        ],
      },
      isConcurrencySafe: () => READ_ONLY.has(spec.name),
      timeoutMs: spec.timeoutMs ?? 120000,
      presentCall: (args) => ({ card: "terminal", title: spec.title, description: args && args.repo ? String(args.repo) : cfg.defaultRepo || cfg.gitPath }),
      presentResult: (_args, result) => ({ card: "terminal", title: spec.title, output: contentText(result) }),
      async execute(args) {
        const value = await spec.execute(args ?? {});
        return { ...value, text: value.text ?? asText(value, cfg.maxTextChars) };
      },
    });

  // ================================================================ 探活

  define({
    name: "git_version",
    title: "git 探活",
    description:
      "检查 git 是否可用：返回版本号、**最终生效的可执行文件路径与来源**（显式 gitPath / gitDir / GIT_PATH 环境变量 / 自动探测 / PATH 兜底）、" +
      "以及其它候选路径为什么不成立。换机器后路径配得对不对，先调它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const found = await gitVersion(cfg);
      const base = {
        gitPath: cfg.gitPath,
        gitSource: cfg.gitSource,
        gitResolved: cfg.gitResolved,
        attempts: cfg.gitAttempts,
        platform: process.platform,
        arch: process.arch,
        defaultRepo: cfg.defaultRepo || null,
      };
      if (found.spawnError || found.code !== 0) {
        return {
          ...base,
          ok: false,
          code: found.timedOut ? "GIT_TIMEOUT" : "GIT_NOT_FOUND",
          reason: found.spawnError ?? found.stderr.trim(),
          text:
            `找不到可用的 git：${cfg.gitPath}\n` +
            `来源：${cfg.gitSource}\n` +
            (cfg.gitAttempts.length ? `已尝试：\n${cfg.gitAttempts.map((a) => `  - ${a}`).join("\n")}\n` : "") +
            `请在「设置 → 插件 → dsh-git-plugin」里配置 gitDir（如 C:\\Program Files\\Git）或 gitPath。`,
        };
      }
      return {
        ...base,
        ok: true,
        version: found.version,
        text:
          `git 可用：${found.version}\n` +
          `可执行文件：${cfg.gitPath}\n` +
          `来源：${cfg.gitSource}\n` +
          `平台：${process.platform}-${process.arch}\n` +
          `默认仓库：${cfg.defaultRepo || "(未设置，将用进程 cwd)"}` +
          (cfg.gitAttempts.length ? `\n注意，以下候选未采用：\n${cfg.gitAttempts.map((a) => `  - ${a}`).join("\n")}` : ""),
      };
    },
  });

  // ================================================================ status

  define({
    name: "git_status",
    title: "git status",
    description:
      "查看工作区状态：当前分支、领先/落后远端的提交数、已暂存 / 未暂存 / 未跟踪 / 冲突文件清单。" +
      "同时给出原始 porcelain 输出。提交前先调它确认改动范围。",
    parameters: { type: "object", properties: { repo: REPO_PROP }, additionalProperties: false },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const result = await runGit(cfg, ["status", "--porcelain=v1", "--branch"], { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git status 失败（${target.repo}）：${failure.message}` };
      }

      const branch = { name: null, upstream: null, ahead: 0, behind: 0, detached: false };
      const staged = [];
      const unstaged = [];
      const untracked = [];
      const ignored = [];
      const conflicted = [];

      for (const line of lines(result.stdout)) {
        if (line.startsWith("## ")) {
          const info = line.slice(3);
          const tracking = /^(.+?)\.\.\.(\S+)(?:\s+\[(.+)\])?$/.exec(info);
          if (tracking) {
            branch.name = tracking[1];
            branch.upstream = tracking[2];
            const counts = tracking[3] ?? "";
            branch.ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
            branch.behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
          } else if (info.startsWith("HEAD (no branch)")) {
            branch.detached = true;
            branch.name = "HEAD (detached)";
          } else {
            branch.name = info.replace(/^No commits yet on\s+/, "").replace(/^Initial commit on\s+/, "");
            if (info.startsWith("No commits yet")) branch.noCommits = true;
          }
          continue;
        }
        const x = line[0];
        const y = line[1];
        const path = line.slice(3);
        if (x === "?" && y === "?") { untracked.push(path); continue; }
        if (x === "!" && y === "!") { ignored.push(path); continue; }
        if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) { conflicted.push(path); continue; }
        if (x !== " " && x !== "?") staged.push(`${x}  ${path}`);
        if (y !== " " && y !== "?") unstaged.push(`${y}  ${path}`);
      }

      const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicted.length === 0;
      const section = (title, list) => (list.length === 0 ? "" : `\n${title}（${list.length}）：\n${list.map((p) => `  ${p}`).join("\n")}`);

      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        branch,
        clean,
        staged,
        unstaged,
        untracked,
        conflicted,
        ignoredCount: ignored.length,
        porcelain: result.stdout,
        text:
          `仓库：${target.repo}（${target.source}）\n` +
          `分支：${branch.name ?? "(未知)"}` +
          (branch.upstream ? ` → ${branch.upstream}` : "") +
          (branch.ahead || branch.behind ? `（领先 ${branch.ahead}，落后 ${branch.behind}）` : "") +
          (branch.detached ? "（游离 HEAD）" : "") +
          (clean ? "\n工作区干净，无未提交改动" : "") +
          section("已暂存", staged) +
          section("未暂存", unstaged) +
          section("未跟踪", untracked) +
          section("冲突", conflicted) +
          (ignored.length ? `\n（另有 ${ignored.length} 个被忽略的文件，未列出）` : ""),
      };
    },
  });

  // ================================================================ log

  define({
    name: "git_log",
    title: "git log",
    description:
      "查看提交历史。可按条数、文件路径、作者、时间范围、提交区间（如 `v1.0..HEAD`）过滤，也可用 grep 在提交信息里搜。" +
      "默认 20 条，格式为「短哈希 日期 作者 主题」。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        limit: { type: "number", description: "最多返回多少条，默认 20" },
        path: { type: "string", description: "只看影响该路径的提交（相对仓库根）" },
        author: { type: "string", description: "按作者过滤（子串匹配）" },
        since: { type: "string", description: "起始时间，如 `2026-01-01` 或 `2 weeks ago`" },
        until: { type: "string", description: "截止时间" },
        range: { type: "string", description: "提交区间，如 `main..feature` 或 `v1.0..HEAD`" },
        grep: { type: "string", description: "在提交信息里做正则搜索" },
        all: { type: "boolean", description: "查所有分支而不只是当前分支" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20;
      const argv = ["log", `-n`, String(limit), "--date=short", "--pretty=format:%h  %ad  %an  %s"];
      if (args.all === true) argv.push("--all");
      if (args.author) argv.push(`--author=${args.author}`);
      if (args.since) argv.push(`--since=${args.since}`);
      if (args.until) argv.push(`--until=${args.until}`);
      if (args.grep) argv.push(`--grep=${args.grep}`, "-i");
      if (args.range) argv.push(String(args.range));
      if (args.path) argv.push("--", String(args.path));

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git log 失败（${target.repo}）：${failure.message}` };
      }
      const entries = lines(result.stdout);
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        count: entries.length,
        entries,
        text: entries.length === 0
          ? `仓库 ${target.repo}：没有匹配的提交`
          : `仓库：${target.repo}（${target.source}）\n最近 ${entries.length} 条提交：\n${entries.join("\n")}`,
      };
    },
  });

  // ================================================================ diff

  define({
    name: "git_diff",
    title: "git diff",
    description:
      "查看差异。默认看工作区 vs 暂存区；`staged: true` 看暂存区 vs HEAD；给了 `from`/`to` 则看两者之间。" +
      "`stat: true` 只返回改动统计。可用 `path` 限定文件。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        staged: { type: "boolean", description: "看已暂存的改动（等价于 git diff --staged）" },
        from: { type: "string", description: "起始 ref（提交/分支/标签）" },
        to: { type: "string", description: "目标 ref；只给 from 时表示 from 与工作区比" },
        path: { type: "string", description: "限定文件或目录（相对仓库根）" },
        stat: { type: "boolean", description: "只返回 --stat 统计" },
        maxLines: { type: "number", description: "最多返回多少行 diff，默认 400" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const argv = ["diff"];
      if (args.stat === true) argv.push("--stat");
      if (args.from) argv.push(String(args.from));
      if (args.to) argv.push(String(args.to));
      if (args.staged === true && !args.from && !args.to) argv.push("--staged");
      if (args.path) argv.push("--", String(args.path));

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git diff 失败（${target.repo}）：${failure.message}` };
      }
      const all = lines(result.stdout);
      const maxLines = Number.isFinite(Number(args.maxLines)) && Number(args.maxLines) > 0 ? Math.floor(Number(args.maxLines)) : 400;
      const shown = all.slice(0, maxLines);
      const scope = args.from || args.to ? `${args.from ?? "工作区"}..${args.to ?? "工作区"}` : args.staged === true ? "暂存区 vs HEAD" : "工作区 vs 暂存区";
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        scope,
        empty: all.length === 0,
        lineCount: all.length,
        diff: shown.join("\n"),
        text: all.length === 0
          ? `仓库 ${target.repo}：${scope} 没有差异`
          : `仓库：${target.repo}（${target.source}）\n范围：${scope}｜共 ${all.length} 行` +
            (shown.length < all.length ? `（只显示前 ${shown.length} 行，可用 maxLines 调整）` : "") +
            `\n\n${shown.join("\n")}`,
      };
    },
  });

  // ================================================================ show

  define({
    name: "git_show",
    title: "git show",
    description: "查看某个提交（或任意 git 对象）的元信息与补丁内容。可用 `path` 只看该对象涉及某文件的改动。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        ref: { type: "string", description: "提交哈希 / 分支 / 标签，如 HEAD、HEAD~2、v1.0" },
        stat: { type: "boolean", description: "只返回改动统计" },
        path: { type: "string", description: "限定文件（相对仓库根）" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const argv = ["show"];
      if (args.stat === true) argv.push("--stat");
      argv.push(String(args.ref));
      if (args.path) argv.push("--", String(args.path));

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git show 失败（${target.repo}）：${failure.message}` };
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        ref: String(args.ref),
        text: `仓库：${target.repo}（${target.source}）\n对象：${args.ref}\n\n${result.stdout}`,
      };
    },
  });

  // ================================================================ blame

  define({
    name: "git_blame",
    title: "git blame",
    description: "逐行追溯某文件：每行最后一次改动来自哪个提交、谁、什么时候。可用 startLine/endLine 限定行范围。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        path: { type: "string", description: "要追溯的文件（相对仓库根）" },
        startLine: { type: "number", description: "起始行（1-based，含）" },
        endLine: { type: "number", description: "结束行（含）" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const argv = ["blame"];
      if (args.startLine) {
        const start = Math.max(1, Math.floor(Number(args.startLine)));
        const end = args.endLine ? Math.floor(Number(args.endLine)) : start;
        argv.push("-L", `${start},${end}`);
      }
      argv.push("--", String(args.path));

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git blame 失败（${target.repo}）：${failure.message}` };
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        path: String(args.path),
        text: `仓库：${target.repo}（${target.source}）\n文件：${args.path}\n\n${result.stdout}`,
      };
    },
  });

  // ================================================================ branch

  define({
    name: "git_branch",
    title: "git branch",
    description:
      "分支管理。action=list 列出本地（含 all=true 时列出远端）分支并标出当前分支；" +
      "create 新建；switch 切换；delete 删除（未合并分支需 force: true）；rename 重命名。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        action: { type: "string", enum: ["list", "create", "switch", "delete", "rename"], description: "要做的操作" },
        name: { type: "string", description: "分支名（create/switch/delete/rename 必填）" },
        newName: { type: "string", description: "rename 时的新名字" },
        startPoint: { type: "string", description: "create 时的起点（提交/分支），省略为当前 HEAD" },
        all: { type: "boolean", description: "list 时同时列出远端分支" },
        force: { type: "boolean", description: "delete 时删除未合并分支（-D）；switch 时丢弃本地改动（-f）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const action = String(args.action);
      let argv;

      if (action === "list") {
        argv = ["branch", "--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(objectname:short)"];
        if (args.all === true) argv.splice(1, 0, "-a");
      } else if (action === "create") {
        if (!args.name) return { ok: false, code: "BAD_ARGS", text: "create 需要 name" };
        argv = ["branch", String(args.name)];
        if (args.startPoint) argv.push(String(args.startPoint));
      } else if (action === "switch") {
        if (!args.name) return { ok: false, code: "BAD_ARGS", text: "switch 需要 name" };
        argv = ["switch"];
        if (args.force === true) argv.push("--discard-changes");
        argv.push(String(args.name));
      } else if (action === "delete") {
        if (!args.name) return { ok: false, code: "BAD_ARGS", text: "delete 需要 name" };
        argv = ["branch", args.force === true ? "-D" : "-d", String(args.name)];
      } else if (action === "rename") {
        if (!args.name || !args.newName) return { ok: false, code: "BAD_ARGS", text: "rename 需要 name 与 newName" };
        argv = ["branch", "-m", String(args.name), String(args.newName)];
      } else {
        return { ok: false, code: "BAD_ARGS", text: `未知 action：${action}` };
      }

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, action, ...failure, text: `git branch ${action} 失败（${target.repo}）：${failure.message}` };
      }

      if (action !== "list") {
        return {
          ok: true,
          repo: target.repo,
          repoSource: target.source,
          action,
          output: result.stdout.trim(),
          text: `仓库：${target.repo}（${target.source}）\n${result.stdout.trim() || `${action} 完成`}`,
        };
      }

      const branches = [];
      let current = null;
      for (const line of lines(result.stdout)) {
        const [headMark, branchName, upstream, sha] = line.split("|");
        const isCurrent = headMark === "*";
        if (isCurrent) current = branchName;
        branches.push({ name: branchName, current: isCurrent, upstream: upstream || null, sha: sha || null });
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        action: "list",
        current,
        branches,
        text:
          `仓库：${target.repo}（${target.source}）\n当前分支：${current ?? "(游离 HEAD)"}\n` +
          (branches.length === 0 ? "（无分支）" : `共 ${branches.length} 个分支：\n` +
            branches.map((b) => `${b.current ? "*" : " "} ${b.name}${b.upstream ? ` → ${b.upstream}` : ""}${b.sha ? `  ${b.sha}` : ""}`).join("\n")),
      };
    },
  });

  // ================================================================ add

  define({
    name: "git_add",
    title: "git add",
    description: "把改动加入暂存区。不传 paths 时等价于 `git add -A`（暂存全部改动，含删除）。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        paths: { type: "array", items: { type: "string" }, description: "要暂存的路径（相对仓库根）。省略 = 全部改动" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const argv = ["add"];
      if (paths.length === 0) argv.push("-A");
      else argv.push("--", ...paths);

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git add 失败（${target.repo}）：${failure.message}` };
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        staged: paths.length === 0 ? ["(所有改动)"] : paths,
        text: `仓库：${target.repo}（${target.source}）\n已暂存：${paths.length === 0 ? "所有改动" : paths.join("、")}\n${result.stdout.trim()}`.trim(),
      };
    },
  });

  // ================================================================ commit

  define({
    name: "git_commit",
    title: "git commit",
    description:
      "创建提交。需要 message；`all: true` 会先自动暂存已跟踪文件的改动（等价 -a，不影响未跟踪文件）。" +
      "`amend: true` 修补上一次提交（会改写历史，已推送的分支慎用）。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        message: { type: "string", description: "提交信息。多行时第一行作主题" },
        all: { type: "boolean", description: "提交前自动暂存已跟踪文件的改动（git commit -a）" },
        amend: { type: "boolean", description: "修补上一次提交（--amend）" },
        author: { type: "string", description: "覆盖作者，格式 `名字 <邮箱>`" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const argv = ["commit", "-m", String(args.message)];
      if (args.all === true) argv.push("-a");
      if (args.amend === true) argv.push("--amend");
      if (args.author) argv.push(`--author=${args.author}`);

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git commit 失败（${target.repo}）：${failure.message}` };
      }
      const sha = /\[[^\]]*\b([0-9a-f]{7,})\]/.exec(result.stdout)?.[1] ?? null;
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        sha,
        amend: args.amend === true,
        output: result.stdout.trim(),
        text: `仓库：${target.repo}（${target.source}）\n${args.amend === true ? "已修补上一次提交" : "提交成功"}${sha ? `：${sha}` : ""}\n${result.stdout.trim()}`,
      };
    },
  });

  // ================================================================ restore

  define({
    name: "git_restore",
    title: "git restore",
    description:
      "撤销改动。默认把工作区文件恢复到 HEAD；`staged: true` 只把它们移出暂存区（改动保留在工作区）；" +
      "`source` 可指定恢复来源（如某个提交）。**这是会丢改动的高危操作**，路径必须显式给出。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        paths: { type: "array", items: { type: "string" }, description: "要恢复的路径（相对仓库根），必填" },
        staged: { type: "boolean", description: "只取消暂存（--staged），保留工作区改动" },
        source: { type: "string", description: "恢复来源 ref，如 HEAD~1；默认 HEAD" },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
      if (paths.length === 0) return { ok: false, code: "BAD_ARGS", text: "git_restore 必须显式给出 paths" };

      const argv = ["restore"];
      if (args.staged === true) argv.push("--staged");
      if (args.source) argv.push(`--source=${args.source}`);
      argv.push("--", ...paths);

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, ...failure, text: `git restore 失败（${target.repo}）：${failure.message}` };
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        paths,
        staged: args.staged === true,
        source: args.source ?? "HEAD",
        text:
          `仓库：${target.repo}（${target.source}）\n` +
          (args.staged === true
            ? `已取消暂存（工作区改动保留）：${paths.join("、")}`
            : `已把工作区恢复到 ${args.source ?? "HEAD"}：${paths.join("、")}（这些改动已丢失）`),
      };
    },
  });

  // ================================================================ stash

  define({
    name: "git_stash",
    title: "git stash",
    description:
      "贮藏管理。action=list 列出；push 保存当前改动（可带 message，includeUntracked 一并保存未跟踪文件）；" +
      "pop 弹出并删除；apply 应用但保留；drop 丢弃某条；clear 清空全部（高危）。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        action: { type: "string", enum: ["list", "push", "pop", "apply", "drop", "clear"], description: "要做的操作" },
        message: { type: "string", description: "push 时的说明" },
        includeUntracked: { type: "boolean", description: "push 时把未跟踪文件也存进去（-u）" },
        index: { type: "number", description: "第几条（0 起，0 是最近一条）；pop/apply/drop 用，省略为 stash@{0}" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const action = String(args.action);
      const ref = Number.isFinite(Number(args.index)) ? `stash@{${Math.floor(Number(args.index))}}` : "stash@{0}";
      let argv;

      if (action === "list") argv = ["stash", "list", "--date=short", "--pretty=format:%gd  %ad  %s"];
      else if (action === "push") {
        argv = ["stash", "push"];
        if (args.includeUntracked === true) argv.push("-u");
        if (args.message) argv.push("-m", String(args.message));
      } else if (action === "pop") argv = ["stash", "pop", ref];
      else if (action === "apply") argv = ["stash", "apply", ref];
      else if (action === "drop") argv = ["stash", "drop", ref];
      else if (action === "clear") argv = ["stash", "clear"];
      else return { ok: false, code: "BAD_ARGS", text: `未知 action：${action}` };

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, action, ...failure, text: `git stash ${action} 失败（${target.repo}）：${failure.message}` };
      }

      if (action === "list") {
        const entries = lines(result.stdout);
        return {
          ok: true,
          repo: target.repo,
          repoSource: target.source,
          action,
          count: entries.length,
          entries,
          text: entries.length === 0
            ? `仓库 ${target.repo}：没有贮藏`
            : `仓库：${target.repo}（${target.source}）\n共 ${entries.length} 条贮藏：\n${entries.join("\n")}`,
        };
      }
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        action,
        output: (result.stdout + result.stderr).trim(),
        text: `仓库：${target.repo}（${target.source}）\nstash ${action} 完成\n${(result.stdout + result.stderr).trim()}`.trim(),
      };
    },
  });

  // ================================================================ remote

  define({
    name: "git_remote",
    title: "git remote",
    description: "远端管理：list 列出所有远端及 URL；add 新增；remove 删除；set-url 改地址。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        action: { type: "string", enum: ["list", "add", "remove", "set-url"], description: "要做的操作" },
        name: { type: "string", description: "远端名，如 origin（add/remove/set-url 必填）" },
        url: { type: "string", description: "远端地址（add/set-url 必填）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const action = String(args.action);
      let argv;

      if (action === "list") argv = ["remote", "-v"];
      else if (action === "add") {
        if (!args.name || !args.url) return { ok: false, code: "BAD_ARGS", text: "add 需要 name 与 url" };
        argv = ["remote", "add", String(args.name), String(args.url)];
      } else if (action === "remove") {
        if (!args.name) return { ok: false, code: "BAD_ARGS", text: "remove 需要 name" };
        argv = ["remote", "remove", String(args.name)];
      } else if (action === "set-url") {
        if (!args.name || !args.url) return { ok: false, code: "BAD_ARGS", text: "set-url 需要 name 与 url" };
        argv = ["remote", "set-url", String(args.name), String(args.url)];
      } else return { ok: false, code: "BAD_ARGS", text: `未知 action：${action}` };

      const result = await runGit(cfg, argv, { repo: target.abs });
      if (!result.ok) {
        const failure = failureOf(result);
        return { ok: false, repo: target.repo, repoSource: target.source, action, ...failure, text: `git remote ${action} 失败（${target.repo}）：${failure.message}` };
      }

      // remote -v 每行形如：origin  git@github.com:a/b.git (fetch)
      const remotes = {};
      for (const line of lines(result.stdout)) {
        const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
        if (!match) continue;
        remotes[match[1]] ??= { name: match[1], fetch: null, push: null };
        remotes[match[1]][match[3]] = match[2];
      }
      const list = Object.values(remotes);
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        action,
        remotes: list,
        text: action === "list"
          ? `仓库：${target.repo}（${target.source}）\n` +
            (list.length === 0
              ? "没有配置任何远端"
              : `共 ${list.length} 个远端：\n${list.map((r) => `  ${r.name}\n    fetch: ${r.fetch}\n    push : ${r.push}`).join("\n")}`)
          : `仓库：${target.repo}（${target.source}）\n${result.stdout.trim() || `remote ${action} 完成`}`,
      };
    },
  });

  // ================================================================ sync

  define({
    name: "git_sync",
    title: "git 同步",
    description:
      "与远端交互。action=fetch 只拉取不改工作区；pull 拉取并合并；push 推送当前分支。" +
      "强制推送必须显式 force: true，且**受保护分支（配置 protectedBranches，默认 main/master）会直接拒绝**。" +
      "凭据不可用时不会弹交互提示，而是直接失败（强制 GIT_TERMINAL_PROMPT=0）。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        action: { type: "string", enum: ["fetch", "pull", "push"], description: "要做的操作" },
        remote: { type: "string", description: "远端名，默认 origin" },
        branch: { type: "string", description: "分支名；push 省略时推当前分支" },
        force: { type: "boolean", description: "强制推送（--force-with-lease）。对受保护分支无效，会被拒绝" },
        prune: { type: "boolean", description: "fetch/pull 时清理远端已删除的分支（--prune）" },
        tags: { type: "boolean", description: "push 时一并推送标签（--tags）" },
        setUpstream: { type: "boolean", description: "push 时设置上游（-u）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const action = String(args.action);
      const remote = args.remote ? String(args.remote) : "origin";
      if (!["fetch", "pull", "push"].includes(action)) return { ok: false, code: "BAD_ARGS", text: `未知 action：${action}` };

      // 受保护分支拦截：先解析出这次真正会作用到的分支名
      let branch = args.branch ? String(args.branch) : null;
      if (action === "push" && !branch) {
        const head = await runGit(cfg, ["rev-parse", "--abbrev-ref", "HEAD"], { repo: target.abs });
        if (head.ok) branch = head.stdout.trim();
      }
      if (action === "push" && args.force === true && branch && cfg.protectedBranches.includes(branch)) {
        return {
          ok: false,
          code: "PROTECTED_BRANCH",
          repo: target.repo,
          repoSource: target.source,
          branch,
          protectedBranches: cfg.protectedBranches,
          text:
            `已拒绝：${branch} 是受保护分支，不允许强制推送。\n` +
            `受保护列表来自配置 protectedBranches（当前：${cfg.protectedBranches.join("、")}）。\n` +
            `确实需要时，请先在「设置 → 插件 → dsh-git-plugin」里把它从该列表移除。`,
        };
      }

      const argv = [action];
      if (action === "fetch") {
        argv.push(remote);
        if (args.prune === true) argv.push("--prune");
      } else if (action === "pull") {
        argv.push(remote);
        if (branch) argv.push(branch);
        if (args.prune === true) argv.push("--prune");
      } else {
        if (args.setUpstream === true) argv.push("-u");
        argv.push(remote);
        if (branch) argv.push(branch);
        if (args.force === true) argv.push("--force-with-lease");
        if (args.tags === true) argv.push("--tags");
      }

      // 网络操作给更宽的超时
      const result = await runGit(cfg, argv, { repo: target.abs, timeoutMs: Math.max(cfg.timeoutMs, 60000) });
      if (!result.ok) {
        const failure = failureOf(result);
        return {
          ok: false,
          repo: target.repo,
          repoSource: target.source,
          action,
          remote,
          branch,
          ...failure,
          text:
            `git ${action} 失败（${target.repo}）：${failure.message}\n` +
            (failure.code === "GIT_TIMEOUT" ? "网络操作超时；可在设置里调大 timeoutMs。\n" : "") +
            (failure.code === "GIT_NOT_FOUND" ? "找不到 git 可执行文件，先用 git_version 检查。\n" : ""),
        };
      }

      const output = (result.stdout + result.stderr).trim();
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        action,
        remote,
        branch,
        output,
        text: `仓库：${target.repo}（${target.source}）\ngit ${action} ${remote}${branch ? ` ${branch}` : ""} 完成\n${output}`.trim(),
      };
    },
  });

  // ================================================================ run（逃生口）

  define({
    name: "git_run",
    title: "git 命令",
    description:
      "执行任意 git 子命令（逃生口）。args 是**参数数组**，会原样作为 argv 传给 git，不经过 shell，" +
      "因此放心传含空格/引号的路径。用于覆盖上面没封装的操作，例如 init、clone、reset、revert、tag、cherry-pick、" +
      "`push --delete` 等。返回退出码与标准输出/错误；非零退出码不抛异常。",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PROP,
        args: {
          type: "array",
          items: { type: "string" },
          description: "git 参数数组，**不含开头的 git**。例如 [\"log\",\"--oneline\",\"-5\"]、[\"clone\",\"https://…\",\"dest\"]、[\"tag\",\"-l\"]",
        },
        timeoutMs: { type: "number", description: "本次命令的超时（毫秒），省略用配置值" },
      },
      required: ["args"],
      additionalProperties: false,
    },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const argv = Array.isArray(args.args) ? args.args.map(String) : [];
      if (argv.length === 0) return { ok: false, code: "BAD_ARGS", text: "args 不能为空" };

      const result = await runGit(cfg, argv, {
        repo: target.abs,
        timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : undefined,
      });

      if (result.spawnError) {
        return {
          ok: false,
          repo: target.repo,
          repoSource: target.source,
          code: result.timedOut ? "GIT_TIMEOUT" : "GIT_NOT_FOUND",
          reason: result.spawnError,
          text: result.spawnError,
        };
      }

      const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return {
        ok: result.code === 0,
        code: result.code,
        repo: target.repo,
        repoSource: target.source,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        text:
          `仓库：${target.repo}（${target.source}）\n` +
          `命令：${result.command}\n` +
          `退出码：${result.code}\n` +
          (body ? `\n${body}` : "（无输出）"),
      };
    },
  });

  // ================================================================ repo 判定（辅助）

  define({
    name: "git_repo",
    title: "git 仓库判定",
    description:
      "判断某个目录是不是 git 仓库，并返回仓库根、当前分支、是否有未提交改动、以及远端地址。" +
      "不确定「这个目录归哪个仓库管」时先调它；它同时会回显本次生效的仓库解析来源。",
    parameters: { type: "object", properties: { repo: REPO_PROP }, additionalProperties: false },
    async execute(args) {
      const target = resolveRepo(cfg, args.repo);
      const inside = await isGitRepo(cfg, target.abs);
      if (!inside) {
        return {
          ok: false,
          code: "NOT_A_REPO",
          repo: target.repo,
          repoSource: target.source,
          exists: target.exists,
          text:
            `不是 git 仓库：${target.repo}\n` +
            `来源：${target.source}｜目录存在：${target.exists}\n` +
            `要用别的目录，请在调用时传 repo，或在「设置 → 插件 → dsh-git-plugin」里配置 defaultRepo。`,
        };
      }
      const root = await runGit(cfg, ["rev-parse", "--show-toplevel"], { repo: target.abs });
      // 刚 init 还没提交时 HEAD 是"未出生"的，`rev-parse --abbrev-ref HEAD` 会返回字面量 "HEAD"，
      // 只有 `branch --show-current` 给得出真正的分支名；游离 HEAD 时它返回空串。
      const current = await runGit(cfg, ["branch", "--show-current"], { repo: target.abs });
      const detached = await runGit(cfg, ["rev-parse", "--short", "HEAD"], { repo: target.abs });
      const branchName = current.stdout.trim() || (detached.code === 0 ? `(游离 HEAD ${detached.stdout.trim()})` : "(尚无提交)");
      const dirty = await runGit(cfg, ["status", "--porcelain"], { repo: target.abs });
      const remote = await runGit(cfg, ["remote", "get-url", "origin"], { repo: target.abs });
      return {
        ok: true,
        repo: target.repo,
        repoSource: target.source,
        root: root.stdout.trim() || target.abs,
        branch: branchName,
        dirty: dirty.stdout.trim() !== "",
        origin: remote.code === 0 ? remote.stdout.trim() : null,
        text:
          `是 git 仓库\n` +
          `查询目录：${target.repo}（${target.source}）\n` +
          `仓库根：${root.stdout.trim()}\n` +
          `当前分支：${branchName}\n` +
          `未提交改动：${dirty.stdout.trim() !== "" ? "有" : "无"}\n` +
          `origin：${remote.code === 0 ? remote.stdout.trim() : "(未配置)"}`,
      };
    },
  });
}

export { DEFAULTS };
