# dsh-feishu 开发指南
[English](development.md) | 中文

dsh-feishu 的安装、构建、测试与本地验证工作流。

## 前置要求

- Node.js >= 22.13（ESM，NodeNext）
- pnpm（dsh profile 工具会转发给 pnpm）
- 一个 dsh 安装：`npm install -g @deepseek-ai/dsh`（`@deepseek-ai/dsh` 的 npx 缓存也可用于本地验证）

## 安装依赖

```sh
pnpm install
```

> 本地环境说明：pnpm 10+ 从 `pnpm-workspace.yaml` 和用户配置目录读取设置；默认的 store 位置在某些主机上可能不可写（例如只读的 home 挂载）。这种情况下，通过重定向 HOME，一次性把 store 指向一个可写路径：
>
> ```sh
> mkdir -p _dev/home && export HOME="$(pwd)/_dev/home"
> pnpm config set store-dir "$(pwd)/_dev/pnpm-store"
> pnpm config set cache-dir "$(pwd)/_dev/pnpm-cache"
> # keep HOME exported for every pnpm invocation in this shell
> ```

### 本地工具链

如果 `pnpm` 不在 `PATH` 中，请使用本地安装，并把每次 pnpm 调用——包括 profile 派生出的 `pnpm`（因为 `dsh plugin` 会转发给它）——都指向仓库 `_dev/` 下可写的 store/cache 路径：

```sh
export PATH="$(pwd)/_dev/pnpm/node_modules/.bin:$PATH"
export npm_config_store_dir="$(pwd)/_dev/pnpm-store"
export npm_config_cache_dir="$(pwd)/_dev/pnpm-cache"
export XDG_CACHE_HOME="$(pwd)/_dev/xdg-cache"  # node-gyp builds
```

`npm_config_*` 环境变量会覆盖项目配置，因此 `dsh plugin` 内部的 `pnpm add` 会使用同一个 store，而无需编辑 profile。`XDG_CACHE_HOME` 重定向 node-gyp 的头文件缓存（默认的 `~/.cache/node-gyp` 可能位于只读挂载上）——没有它，node-pty 等原生模块将无法构建。

## 质量门槛

```sh
pnpm run lint        # Biome: lint + format check on src/ and tests/
pnpm run typecheck   # tsc --noEmit over src/ and tests/
pnpm run test        # Vitest unit + integration tests
pnpm run build       # tsc emit to lib/ (declaration + source maps)
```

提交前这四项必须全部通过；CI 运行同样的四项。

## 目录结构

```
src/                  # plugin source; one module per concern, each with tests
tests/                # vitest suites (never under src/)
docs/                 # English documentation
examples/             # runnable examples (profiles, configs)
scripts/              # repo tooling
```

测试采用 "fake context"（假上下文）模式做插件级覆盖：手工构造模块所接触的 cordis 服务的 stub（见 `tests/index.spec.ts`），再加上针对模块逻辑的纯函数测试。

### 集成测试

`tests/integration/real-composition.spec.ts` 从真实 profile 启动一个**真实的 dsh 进程**并运行一次真实的 agent turn，只 mock 两个外部服务：

- **Feishu** —— `FEISHU_TRANSPORT=memory` 把传输层换成基于文件通道的内存传输（`src/memory-transport.ts`）：测试把一条消息放入 `inbox/`，surface 处理它，每一次 send/update 都会落入 `outbox/`。
- **LLM API** —— `DEEPSEEK_BASE_URL` 把真实的 DeepSeek adapter 指向本地 mock 服务器（`tests/integration/mock-llm-server.ts`）。

该套件断言完整的 surface：消息 → session → agent turn → 卡片发布并被 patch → **由卡片承载的最终答案**（它就地以绿色收尾），此外还有卡片操作、session 生命周期、web 命令包装器，以及工作目录 gate。脚本化的 mock LLM（`setScripts`、`holdNextResponse`，以及一个应答 HTTP 500 的 `error` 块）驱动工具调用、推理、错误 turn 和重试。除非满足前置条件，否则套件会自行跳过：

- dsh CLI 可解析（`$DSH_BIN`，或 `PATH` 上的 `dsh`）。
- 在 `$FEISHU_INT_DSH_HOME/profiles/feishu-dev` 存在一个准备好的 profile（默认 `_dev/dsh-home/profiles/feishu-dev`——用 `dsh plugin --profile feishu-dev add link:<checkout>` 创建，见上文"在真实 dsh profile 中验证 bundle"一节）。刻意与环境的 `DSH_HOME` 相互独立，这样测试永远不会碰到另一个 dsh home。
- checkout 已构建（`pnpm run build`）。

CI 在每次 push 时都运行该套件（两个 node 版本分支都跑）：workflow 构建 checkout、准备 profile，并以 `FEISHU_INT_REQUIRED=1` 运行测试——这样缺少前置条件会响亮地让任务失败，而不是静默跳过。dsh CLI 是 devDependency（`@deepseek-ai/dsh`），原生构建脚本（node-pty 及其同类）在 `pnpm-workspace.yaml` 中获准——不涉及任何凭据；正是上面这些 Feishu 和 LLM mock 让套件在无需密钥的情况下也能运行。

```sh
pnpm run build        # ensure lib/ is current (the profile links the checkout)
pnpm run test         # unit + integration (integration self-skips as needed)
DSH_BIN=/path/to/dsh pnpm run test -- tests/integration/real-composition.spec.ts
FEISHU_INT_REQUIRED=1 pnpm run test   # fail (not skip) when a prerequisite is missing
```

运行 turn 的测试会先固定一个工作目录（`/cd`，工作目录 gate 所要求）；分组测试通过 `FEISHU_MOCK_BOT_OPEN_ID` 注入机器人的 open id。新 session 会额外触发一次标题生成的 LLM completion——请断言卡片内容，绝不要断言精确的 completion 次数。

`FEISHU_TRANSPORT=memory` 这个 seam 对手工调试也很方便：在 surface 运行期间，向 `$FEISHU_MEMORY_DIR/inbox/` 写入一个 JSON 文件即可注入一条假消息。

#### 场景套件（两套真实进程套件、两个 dsh home）

`tests/integration/scenarios.spec.ts` 是第二个真实进程套件，覆盖边缘场景：守护进程重启后的持久性、群组提及模式与允许列表（通过 `FEISHU_*` 环境变量 seam）、`/group` + `/repo`、每一种问题卡片变体、主动提及、去重、passthrough，以及停止 turn 时的表情切换。（Session 回放只有一个 surface——`/export`；`/history` 因冗余且难看，经决策被移除。）由于 vitest 并行运行测试**文件**，两套件不得共享同一个 dsh home（两者都会持久化 session map 与日志）：场景套件默认使用 `_dev/dsh-home-scenarios`（可用 `FEISHU_INT_SCENARIOS_DSH_HOME` 覆盖），用相同的 `dsh plugin --profile feishu-dev add link:<checkout>` 配方准备。CI 会准备两个 profile。

##### 场景覆盖矩阵

| 场景 | 测试 |
|---|---|
| 守护进程重启后恢复同一 session；重启后 `/export` 导出的 transcript 横跨两端 | `restart resumes the same session` |
| turn 运行期间 `/status` 只读 | `/status is read-only` |
| 裸 `/repo` 发布选择器卡片 | `bare /repo posts the project picker card` |
| `/group` 创建群组；@-turn 在其中可用 | `/group creates a group chat` |
| 提及模式 `never` / `ambient` / `topic` | 三个 `groupMentionMode=` 测试 |
| `allowedChats`（环境变量）对整个聊天设门禁 | `allowedChats env` |
| 单人群组放宽（`1u,1b`）接受不带 @ 的消息 | `solo-group relaxation` |
| 多选切换 + Submit（重定向的卡片） | `multi-select question` |
| 由聊天消息回答的自由文本问题 | `free-text question` |
| 问题 Cancel 时以空答案收场 | `question Cancel` |
| 群组审批/问题卡片 @ 请求者；p2p 卡片不 @ | 两个 mention 测试 |
| 重投递的消息 id 被去重 | `message dedup` |
| `unknownCommand=passthrough` 把未知斜杠命令路由给模型 | `unknownCommand=passthrough` |
| 中途停止 turn 会把表情切换为停止表情 | `stop mid-turn swaps the received reaction` |
| `/export` transcript 包含工具行 | `/export after a tool-calling turn` |

## 在真实 dsh profile 中验证 bundle

bundle 必须挂载进一个真实的 dsh profile。请使用隔离的 `DSH_HOME`，这样验证永远不会碰到生产 profile：

> 关于 Feishu 应用本身的创建/配置——一次扫码、无需 web 控制台操作——见 `docs/feishu-setup.md` → "Quick setup"（`pnpm run setup:feishu`）。

```sh
# From the checkout root:
export DSH_HOME="$(pwd)/_dev/dsh-home"   # git-ignored
dsh plugin --profile feishu-dev add "link:$(pwd)"
dsh --profile feishu-dev --dump-config   # confirm the feishu row is composed
timeout 30 dsh --profile feishu-dev       # boot; expect the "[feishu]" log lines
```

- 第一次 `dsh plugin` 调用会初始化 profile（bundles = `['@deepseek-ai/dsh-base']`），在其内部运行 `pnpm add link:<checkout>`，并把 `@dsh-feishu/dsh-feishu` 追加到 `dsh.profile.bundles`，因为 manifest 声明了 `dsh.bundle.patch`。如果 profile 的 pnpm store 不可写，请把 `storeDir` / `cacheDir` 加到 profile 的 `pnpm-workspace.yaml`（该文件是 pnpm 10+ 设置的大本营）。
- 无凭据启动会记录"未配置"通知并注册 `feishu-status`；凭据来自 `appId`/`appSecret` 配置键或 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量。
- 清理：`rm -rf _dev/dsh-home`（或删除 `feishu-dev` profile）。

## 添加功能模块

1. 创建 `src/<module>.ts`，在模块及其导出的函数上写 JSDoc。
2. 创建 `tests/<module>.spec.ts` 覆盖其行为（若它注册进某个 registry，还要覆盖 disposal）。
3. 通过 `src/index.ts` 接入（用 `ctx.get` 对可选服务做 feature-detect）。
4. 更新相关的 `docs/` 页面和 `CHANGELOG.md`。
5. 运行全部质量门槛；用 Conventional Commit 消息提交。

## Pull requests 与 CI

只能通过 CI 全绿的 PR 合并——绝不直接 push 到 main。GitHub API 访问使用位于 `_dev/gh-token` 的 repo 级 fine-grained PAT（chmod 600，由开发者持有，绝不提交）。每次调用时把它读入变量，绝不回显：

```sh
TOKEN=$(cat _dev/gh-token)
```

打开 PR（head = 你 push 的分支，base = `main`）：

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls \
  --data '{"title":"...","head":"<branch>","base":"main","body":"..."}'
```

等待 CI 得出结论——workflow 会运行完整的门槛矩阵，包括 real-composition 集成套件：

```sh
SHA=$(git rev-parse HEAD)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/PGZXB/dsh-feishu/actions/runs?head_sha=$SHA"
```

一旦 PR 的 `mergeable_state` 变为 `clean`（checks 全绿）即可合并。使用 `merge_method: "rebase"` 以保持 `main` 线性——"merge" 即使在可以 fast-forward 时也总是会新增一个 merge commit，导致每个 PR 留下两个 commit：

```sh
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
  https://api.github.com/repos/PGZXB/dsh-feishu/pulls/<number>/merge \
  --data '{"commit_title":"...","merge_method":"rebase"}'
```

打开 PR 之前，先 rebase 到最新的 `origin/main` 并重新运行质量门槛：main 树在并发工作下会移动，在 PR 存在之前解决冲突成本最低。如果 CI 变红，在 worktree 中修复并重新 push——GitHub 会在新的 head 上重新运行 checks。端到端实践见 AGENTS.md → "Worktree + PR workflow"。

## 发布

发布由 tag 驱动：`node scripts/release.mjs <major|minor|patch>` 更新
`package.json`、运行 CI 门禁、提交并打 `v*` tag；随后
[Release workflow](../.github/workflows/release.yml) 发布到 npm
（`NODE_AUTH_TOKEN`，沿用 DeepSeek Harness 发布 workflow 的 registry-token
认证）并创建 GitHub Release。首次公开发布前，轮换飞书 app secret（见
`SECURITY.md`）。
