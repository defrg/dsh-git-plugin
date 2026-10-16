# dsh-git-plugin

DSH（DeepSeek Harness）插件：把 **git 常用操作**接成工具，让 Agent 直接查状态、看历史、比差异、建分支、提交、贮藏、与远端同步。

## 两个设计目标

**① git 安装位置可配置，换机器不用改代码。**

默认什么都不用配：插件按下面的顺序自己找 git，并把「最终用了哪个、来自哪一级」如实报出来。

```
显式 gitPath  →  显式 gitDir  →  GIT_PATH 环境变量  →  各平台标准安装位置  →  PATH 兜底
```

`gitDir` 给一个「Git 根目录」即可（Windows 的 `C:\Program Files\Git`、macOS 的 `/usr/local`），
插件会自动尝试 `<gitDir>/cmd/git.exe`、`<gitDir>/bin/git`、`<gitDir>/mingw64/bin/git.exe`、`<gitDir>/git.exe`。
**配错了不会静默跳过**——`git_version` 会把每个失败候选和原因一并列出来，省得在一台新机器上
对着「怎么用的是另一个 git」发呆。

**② 零第三方依赖，且不经过 shell。**

只用 Node 内置能力（`node:child_process` 的 `execFile` + argv 数组）。
参数里的空格、引号、分号、`$()` 都不会被解释，中文路径也不会被转义成八进制
（默认带 `-c core.quotepath=false`）。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `git_version` | 探活：git 版本、生效的可执行文件路径与来源、失败候选清单 |
| `git_repo` | 判定某目录是不是仓库，返回仓库根 / 当前分支 / 是否有改动 / origin |
| `git_status` | 分支、领先落后数、已暂存 / 未暂存 / 未跟踪 / 冲突清单 |
| `git_log` | 提交历史，可按条数、路径、作者、时间、区间、提交信息过滤 |
| `git_diff` | 差异：工作区 / 暂存区 / 任意两个 ref 之间，可只出 `--stat` |
| `git_show` | 看某个提交或对象的元信息与补丁 |
| `git_blame` | 逐行追溯，可限定行范围 |
| `git_branch` | list / create / switch / delete / rename |
| `git_add` | 暂存；不传路径等价于 `git add -A` |
| `git_commit` | 提交，支持 `-a` 与 `--amend` |
| `git_restore` | 撤销改动或取消暂存（**必须显式给出路径**） |
| `git_stash` | list / push / pop / apply / drop / clear |
| `git_remote` | list / add / remove / set-url |
| `git_sync` | fetch / pull / push，强制推送需显式 `force: true` |
| `git_run` | 逃生口：执行任意 git 子命令（`init`、`clone`、`reset`、`revert`、`tag`、`cherry-pick`…） |
| `git_config` | 读 / 写本插件配置（`get` / `set`），改动即时生效、无需重启 |

`git_run` 的 `args` 是**参数数组**、不含开头的 `git`：

```jsonc
{ "args": ["log", "--oneline", "-5"] }
{ "args": ["clone", "https://github.com/defrg/dsh-git-plugin.git", "E:/project/x"] }
{ "args": ["reset", "--hard", "HEAD~1"] }
```

## 配置

有**两个入口**，改的是同一份配置（都写进本 profile 覆盖层、volatile 值即时生效、无需重启）：

1. **图形界面**：「设置 → 插件 → dsh-git-plugin」里的配置卡片。插件自带 `lib/client.js`
   注册进 `plugins.bundle.config` 槽位 —— DSH 不会为第三方 bundle 自动生成表单，必须自带这张卡。
2. **工具 / YAML**：让 Agent 调 `git_config`，或直接写在 `cordis.patch.yml`：

```yaml
- id: dsh-git-plugin
  name: 'dsh-git-plugin'
  config:
    gitDir: 'C:\Program Files\Git'   # 或 macOS/Linux 的 /usr/local
    defaultRepo: 'E:/project/my-repo'
    timeoutMs: 30000
    protectedBranches: [main, master]
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `gitDir` | 空（自动探测） | Git 安装根目录 |
| `gitPath` | 空（自动探测） | git 可执行文件完整路径，优先于 `gitDir` |
| `defaultRepo` | 空 | 默认仓库目录；调用没传 `repo` 时用它，再空则用 DSH 进程 cwd |
| `timeoutMs` | 30000 | 单条 git 命令超时（网络操作会至少放宽到 60000） |
| `maxTextChars` | 12000 | 返回文本截断上限 |
| `protectedBranches` | `[main, master]` | 拒绝对这些分支强制推送 |

### 换机器时怎么做

1. 装上 Git（任何标准安装位置都行）；
2. 如果装在非标准位置，在设置里把 `gitDir` 指过去；
3. 调一次 `git_version` 确认「可执行文件」和「来源」符合预期；
4. 需要固定默认仓库就把 `defaultRepo` 设上。

**插件自身的 `cordis.patch.yml` 里刻意不带任何本机路径**，就是为了让同一份 patch 在任何机器上都能直接用。

## 安全边界

- **不经过 shell**：所有命令走 argv 数组，没有拼接、没有命令注入面。
- **绝不阻塞在交互上**：强制 `GIT_TERMINAL_PROMPT=0`，需要凭据的 fetch/push 会直接失败而不是挂住；
  同时禁用分页器（`--no-pager` / `GIT_PAGER=cat`），避免输出被 less 吞掉。
- **受保护分支**：对 `protectedBranches` 里的分支强制推送会被直接拒绝，即使调用方传了 `force: true`；
  且强制推送用 `--force-with-lease` 而非 `--force`，不会覆盖别人已推送的提交。
- **`git_restore` 必须显式给路径**：不给 `paths` 直接报 `BAD_ARGS`，杜绝"手滑清空整个工作区"。
- **只读工具才并发**：`git_version` / `git_status` / `git_log` / `git_diff` / `git_show` / `git_blame`
  声明为可并发，其余串行，避免 `index.lock` 争抢与工作区互相打架。
- **配置路由带鉴权**：`/git-plugin/api/config` 是设置卡片用的读写入口。`webServer` 载体自身
  **不拥有认证与 Origin 策略**，所以这里套了 `ctx.connection.requestRejection(req)` ——
  否则任何能访问该端口的页面都能盲发 POST 改写 `gitDir` / `gitPath`，下一次调用就会用
  攻击者指定的可执行文件去跑"git"。配置写入还被收窄成字段白名单（`gitDir` / `gitPath` /
  `defaultRepo` / `protectedBranches`），`timeoutMs` 之类的字段改不动。

## 自测

```powershell
node scripts/check-git-path.mjs   # 可执行文件定位：19 项断言（含"配错要留痕"）
node scripts/check-tools.mjs      # 真实仓库上跑完整流程 + 配置入口：102 项断言
```

`check-tools.mjs` 会在临时目录里 `git init` 一个真仓库，把 16 个工具实跑一遍
（建仓 → 配置身份 → 改文件 → status → add → commit → log → diff → branch → stash → restore
→ remote → 受保护分支拦截 → 配置读写 → 参数校验），跑完即删。

配置入口那部分用假 ctx 捕获路由，验证三件事：**未鉴权的 GET 拿不到配置、未鉴权的 POST
写不进配置、鉴权通过后只有白名单字段能落盘**。

临时目录默认用系统临时目录，可用 `DSH_GIT_PLUGIN_CHECK_DIR` 改写。

## 已知边界

- 需要 git ≥ 2.23（`git restore` / `git switch` 从这版开始有）。更老的 git 请用 `git_run` 走 `checkout`。
- `git_branch list` 用 `%(HEAD)`/`%(upstream:short)` 格式，需要 git ≥ 2.13。
- 不处理交互式场景：`rebase -i`、`add -p`、合并冲突的编辑器都不会被拉起。
- `git_run` 是逃生口，能力等于直接跑 git——它能做的破坏性操作（`reset --hard`、`clean -fd`、
  `push --delete`）它都能做，用之前想清楚。

## 许可

MIT
