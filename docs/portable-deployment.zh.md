# 便携部署（绿色安装包）

`scripts/package-portable.mjs` 面向 Linux **x86_64（glibc）** 构建一个自包含、
可直接复制的 dsh-feishu 部署目录：内置 Node 运行时、DSH CLI + harness 家族、
从 `main` 构建的 dsh-feishu bundle、不含密钥的 profile-home 模板、以及每实例
启动脚本。部署就是把目录拷贝到服务器运行 `bin/start` —— 无需系统 Node、无需
网络、无需 pnpm。

使用场景是**单服务器多实例**：每份拷贝都是独立隔离的 dsh-feishu 实例
（各自的 home、飞书应用、API key、模型），一台服务器可同时服务多个用户而互不
串状态。

## 构建

```sh
pnpm install                      # repo 内执行一次
pnpm run build                    # 产生 lib/（bundle 在下面一并构建）
node scripts/package-portable.mjs
```

脚本会真正执行一次 `npm install @deepseek-ai/dsh@<pin>` 到临时 app 前缀
（即 `INSTALL_ANCHOR`），并补装一个 Feishu profile 所需的全部 `@deepseek-ai/*`
包（`cordis.patch.yml` 引用的 bundle 层 + 插件的 peer 依赖），从而完全离线解析
bundle。接着从当前 checkout 构建 dsh-feishu bundle、内置 Node LTS 运行时、写入
profile-home 模板，产出：

```
_dev/portable/dsh-feishu-portable-linux-x64-v<version>-<sha>/   # 包目录
_dev/portable/dsh-feishu-portable-linux-x64-v<version>-<sha>.tar.gz
```

产物在 git-ignored 的 `_dev/` 下，不提交。前置校验：

- **构建机必须是 Linux x86_64 glibc** —— vendored 的原生预编译（sharp、
  node-pty、rollup、koffi 等）按平台选择。musl/Alpine 不在支持范围（需要
  musl 版 Node）。
- 构建机需出站网络（nodejs.org + npm registry）；**部署后的包**永不联网。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `PORTABLE_NODE_CACHE` | 缓存已下载 Node tarball 的持久目录（默认 `_dev/portable/.cache`） |
| `PORTABLE_NODE_VERSION` | 固定 Node 版本（默认取下列 major 的最新 LTS patch） |
| `PORTABLE_NODE_MAJOR` | 自动挑选的 Node major（默认 `22`） |
| `PORTABLE_NODE_TARBALL` | 预下载 `.tar.xz` 路径（离线构建用） |
| `PORTABLE_DSH_VERSION` | 固定 DSH 版本（默认取仓库 `devDependencies["@deepseek-ai/dsh"]`） |
| `PORTABLE_OUT_DIR` | 输出目录（默认 `_dev/portable`） |
| `PORTABLE_PACKAGE_NAME` | 覆盖包目录名 |

### 目录结构

```
runtime/node/        内置 Node（bin/node + npm-cli）
runtime/app/         DSH CLI 安装锚点：node_modules/@deepseek-ai/{dsh,dsh-base,…}
bundle/dsh-feishu/   从 main 构建的 bundle（lib/、cordis.patch.yml、package.json、+ 其运行时依赖）
home/                不含密钥的 DSH_HOME 模板（profiles/feishu/**）
bin/dsh-feishu       启动器：设 PATH、source instance.env、DSH_HOME、exec dsh
bin/start            bin/dsh-feishu 的便捷封装
bin/setup            一次扫码：创建并配置飞书应用（bundle 的快速配置向导）
bin/init-instance    把本包复制成一个新的隔离实例
instance.env.example 每实例凭据与选项
README-PORTABLE.md   每实例部署说明（随包附送）
portable.json        溯源信息：版本、源码 sha、libc
```

## 首次部署与每实例应用配置

```sh
cp -r dsh-feishu-portable-linux-x64-* yourinstance
cd yourinstance
cp instance.env.example instance.env          # FEISHU_APP_ID/SECRET、DEEPSEEK_API_KEY、…
./bin/setup                                    # 一次扫码：创建并配置飞书应用
./bin/start
```

`bin/setup` 以 `--dsh-home <实例 home> --profile feishu` 运行 bundle 的快速
配置向导，把应用凭据写入实例的 `home/profiles/feishu/cordis.patch.yml`。
用 `--app-id cli_xxx` 重跑可重配置已有应用。

## harness 如何离线解析

boot 先按 `INSTALL_ANCHOR`（vendored 的 dsh 安装）解析 bundle 层，再查 profile
自身的 `node_modules`。profile 的 `dsh.profile.bundles` 列出 `@deepseek-ai/dsh-base`、
dsh-feishu 补丁引用的 bundle 层包、以及 dsh-feishu 自身。harness 家族**只存在
一份**（在锚点里）；profile 层只带 dsh-feishu bundle 与其非 harness 运行时依赖，
harness peer 从锚点 symlink 过来——绝不放第二份（重复会导致模块身份状态错乱，
即 double-install 这一类 bug）。

## 多实例模型

- **一份拷贝 = 一个实例。** 服务 N 个用户就复制 N 份；每份有自己的 `home/`
  （即 DSH_HOME 与 `dataDir`）、自己的 `instance.env`（飞书应用、API key、模型），
  因此不存在跨实例的会话、日志或模型状态。
- 每实例身份绑定**各自的飞书应用**（独立 appId/appSecret/bot/团队）。一个飞书群
  对应一个 agent 会话；若需要隔离，实例不应共享同一个应用。
- 不占用端口（surface 走飞书长连接 WebSocket，而非 HTTP），同机多实例不会冲突。
- `bin/start` 会 source `instance.env`；实例
  `home/profiles/feishu/cordis.patch.yml` 里的键优先生效。

### 在同机服务第二个用户

```sh
cd path/to/firstinstance
./bin/init-instance second          # 在 ./second 生成全新隔离副本
cd second
#  编辑 instance.env，填入第二个用户的 appId/appSecret/api key
./bin/start
```

## 验证

- `bin/start --dump-config` 能拼出 dsh-feishu 行（拼装无需凭据；真正启动需要
  真实 app + API key）。
- 设置凭据后 `bin/start` 输出 `[feishu] bridge ready`。
- 端到端 bot 路径（群内一次真实 turn）需由操作者针对真实飞书应用验证 —— CI
  不驱动真实 bot。

## 说明 / 限制

- 目标为 **glibc x86_64 Linux**；musl/Alpine 需要 musl 版 Node。
- 每个实例需要自己的飞书应用（独立 appId/appSecret/bot/团队）。
- 群必须已固定工作目录（通过 `/repo` 或 `/cd` 选择）；`defaultCwd` 只是回退，
  绝不是隐式选择。
- 包从当前工作树构建；请基于干净的 `main` checkout 构建，使产物与发布一致。
