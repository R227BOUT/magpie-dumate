# 上传与发布指南

两条路可以走，**建议先走 A**。两者不冲突，稳定后可以再补 B。

---

## A. GitHub 仓库 + `magpie-plugin` topic（推荐先做）

官方文档：给仓库打上 `magpie-plugin` topic，就会出现在 **插件 → 发现 → 非官方插件 · GitHub**，
**无需 PR、无需审核**，magpie 最多每 10 分钟轮询一次 GitHub，几分钟内就会出现。
Star 多的排在前面，并明确标注「没有人审阅过」。

### 硬性条件（不满足就不会显示）

| 条件 | 说明 |
|---|---|
| `package.json` 在**仓库根目录** | 不能在子目录里 |
| 被加载的文件必须**已提交** | 不能是构建产物；`dist` 只在发布时才构建的仓库不会显示 |
| 不是 fork、不是已归档、不是 magpie-community 官方仓库 | — |

### 零基础操作步骤（照着做，每步都有验证点）

> 全部命令都在 **PowerShell** 里执行。不要用 CMD。

#### 第 0 步：确认 git 可用

```powershell
git --version
git config --global user.name
git config --global user.email
```

- 第一条报「无法将 git 项识别为 cmdlet」= 没装。去 <https://git-scm.com/download/win> 下载安装，
  一路默认下一步即可；装完**关掉 PowerShell 重新开**再试。
- 后两条输出为空 = 还没设身份，随便填，只要两条一致（邮箱不必是 GitHub 注册邮箱）：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

#### 第 1 步：在 GitHub 上建一个**空**仓库

1. 登录 <https://github.com>
2. 右上角 `+` → **New repository**
3. Repository name 填 `magpie-plugin-dumate`
4. 选 **Public**（必须公开，magpie 要能读到）
5. 🔴 **下面三个勾选框全部不要勾**（Add a README / Add .gitignore / Choose a license）——
   这些文件本地已经有了，勾了会在推送时冲突
6. 点 **Create repository**

建好后页面会显示一堆「…or push an existing repository」命令，**不要照抄它的**，用第 2 步的。

#### 第 2 步：提交并推送

```powershell
cd <本插件目录>

git init
git add -A
git status --short
```

> `<本插件目录>` 换成你实际放插件的目录，例如 `cd D:\code\magpie-plugin-dumate`。
> 在资源管理器里打开该文件夹、地址栏输入 `powershell` 回车，也能直接开在当前目录。

🔴 **在这里停下，先看 `git status --short` 的输出。** 正常应该是 45 行左右，每行以 `A  ` 开头。
必须满足下面四条，任何一条不满足就先别继续：

| 检查 | 期望 |
|---|---|
| 出现 `perf-baseline.json` | ❌ 不该出现 |
| 出现 `stability-logs/` | ❌ 不该出现 |
| 出现 `plugin-auth.json` / `auth.json` / `.cookie-key` | ❌ 不该出现 |
| 出现任何 `.jsonl` / `.log` | ❌ 不该出现 |

这些文件**根本不会出现在列表里**，才说明 `.gitignore` 生效了。确认干净后继续：

```powershell
git commit -m "Initial commit: magpie plugin for Baidu DuMate"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/magpie-plugin-dumate.git
git push -u origin main
```

`git push` 时会发生什么：

- **正常情况**：弹出一个浏览器窗口让你登录 GitHub 并授权（这是 Git 自带的凭据管理器），
  点 **Authorize / 授权** 就完事，回到 PowerShell 会看到推送进度。
- **如果弹出的是命令行要你输用户名密码**：GitHub 从 2021 年起不接受账号密码了，必须用
  Personal Access Token（在 GitHub → Settings → Developer settings → Personal access tokens 里生成）。
  遇到这个不用硬啃，直接改用 **GitHub Desktop**（<https://desktop.github.com/>）：
  Add local repository 选这个插件目录 → Publish repository → 取消勾选 "Keep this code private"，两步就完了。

#### 第 3 步：打 topic（这一步决定 magpie 能不能发现你）

1. 浏览器打开 `https://github.com/你的用户名/magpie-plugin-dumate`
2. 页面右侧 **About** 区域，点旁边的**齿轮图标 ⚙**
3. **Topics** 输入框里输入 `magpie-plugin`，按回车
4. 点 **Save changes**

#### 第 4 步：验证

三个办法，任选：

- 打开 <https://github.com/topics/magpie-plugin>，看列表里有没有你的仓库
- magpie 里：插件 → 发现 → 非官方插件 · GitHub（最多等 10 分钟）
- 命令行装一次验证（用一个临时目录试，别动现在装好的那份）：

```powershell
magpie plugin add github:你的用户名/magpie-plugin-dumate
```

#### 出问题怎么反馈

把**命令原文 + 完整报错**贴出来，不要自己猜着改。git 的报错基本都能定位到具体哪一步。

---

### 命令速查（已熟悉流程时用）

```bash
cd <本插件目录>

git init
git add -A
git status          # ← 关键：确认没有 stability-logs / perf-baseline.json / 凭据文件
git commit -m "Initial commit: magpie plugin for Baidu DuMate"

# 在 GitHub 建好空仓库后
git remote add origin https://github.com/<你的账号>/magpie-plugin-dumate.git
git branch -M main
git push -u origin main
```

然后在 GitHub 仓库页面：**Settings → 右侧 Topics** → 添加 `magpie-plugin` → Save。

几分钟后 magpie 里应该能看到。也可以直接在终端验证装得上：

```bash
magpie plugin add github:<你的账号>/magpie-plugin-dumate
```

### 更新机制

git 仓库没有版本号可比。magpie 判断「有更新」的方式是：**默认分支指向的提交**和 Bun 当前装的
那个不一样时提示，最多每 10 分钟问一次。所以只要 `git push` 就会推送更新，不用改版本号。

⚠️ 若把 spec 固定到某个 commit（`#<sha>`），就不会再有更新提示。

---

## B. 进社区 `registry.json`（先看清它到底是什么）

⚠️ **先纠正一个常见误解**：`registry.json` **不是"第三方插件外链目录"**。
对着真文件核对过（2026-10-26，共 41 条）：**41 条全部是 `@magpie-community/*`**，
没有一条指向外部仓库。它是社区 monorepo 自己那批包的目录。

所以想出现在 `registry.json` 里，**唯一的路是把代码捐进 monorepo**——
不是加一行链接，是让插件变成他们的一个包。

### 要满足什么

| 要求 | 具体 |
|---|---|
| 位置 | `packages/<name>/`（例如 `packages/dumate/`） |
| 包名 | 强制模板 `@magpie-community/opencode-<name>-auth`（我们是 `@magpie-community/opencode-dumate-auth`） |
| 结构 | `package.json`（`type: module`、`main: ./index.mjs`、`license: MIT`）+ `index.mjs` + `README.md` |
| 依赖 | 原则上**不要运行时依赖**（`fetch`/`crypto`/`fs` 够用） |
| 自检 | `bun scripts/check.mjs dumate` 加载插件并校验 hook |
| 沙箱试跑 | `MAGPIE=/path/to/magpie scripts/try.sh dumate`（独立 HOME，不动你自己的 magpie） |
| 评审 | 合并前有人 review（README 原文："a new plugin is merged as soon as its review is done"） |

### 代价（这是关键，不是小事）

- **代码从此住在别人仓库**。你不再能单独 `git push` 发布；改动要走 PR。
- **版本号一 bump 就自动发布**：`main` 上改版本 → CI 打进 `dist` 分支 + 发 npm，
  **所有装了它的 magpie 会自动更新**。一次手滑就是全量用户。
- 包名、目录名、provider 命名都受模板约束，不能沿用现在的 `magpie-plugin-dumate`。
- `icon` 在 registry 里可以是短名（如 `"kimi"`），不一定是 URL——具体看评审意见。

### 两条路怎么选

| | GitHub topic（已做） | 社区 monorepo |
|---|---|---|
| 被发现 | ✅ 插件 → 发现 → 非官方插件 · GitHub | ✅ 插件页推荐位 |
| 代价 | 无，仓库你自己管 | 代码捐出 + 长期维护 + 全量自动发布 |
| 适合 | 想自己掌控、随时改 | 想长期做、愿意接社区流程 |

**建议**：先跑一段时间 topic 路线，收反馈、稳定接口，再决定要不要捐。
真要捐，把 `index.mjs` 去掉本仓库特有的测试脚手架、按模板建 `packages/dumate/`，
跑通 `scripts/check.mjs` 再提 PR。

---

## 上传前必查清单

```bash
# 1. 确认测试产物未被跟踪（含真实积分流水，绝不能外传）
git status --short
git ls-files | grep -E "stability-logs|perf-baseline|\.jsonl$"

# 2. 确认没有凭据
git ls-files | grep -E "auth\.json|\.cookie-key|plugin-auth"

# 3. 确认没有本机路径（无输出 = 干净）
git grep -nE "[A-Za-z]:[\\\\/]{1,2}(Users|ProgramData|Documents)" -- .
```

第 3 条若命中，把路径换成 `homedir()` 推导或环境变量——本仓库已按此清理过。

⚠️ **这条检查必须真的跑一遍再推**。本仓库第一版就是"清单写好了但没执行"：
`test-desktop-paths.mjs` / `test-windows-paths.mjs` 里各留了一处写死的用户目录绝对路径，
`test-edge-cases.mjs` 的 mock 里还留着真实积分池数字，全都进了第一次提交，事后只能 amend + force push 补救。

### 两条容易漏的

1. **测试 mock 不要用真实数字**。余额/积分/额度的 mock 一律用整数（`5000` 而不是账号里那个真实数字）——
   mock 值本身不会「因为是假的」就安全，它照样暴露你的账户规模。
2. **临时目录一律 `join(tmpdir(), "...")`**，不要写死某个盘某个用户目录。写死了换台机器测试还会红。

### 绝不能提交的东西

| 项 | 原因 |
|---|---|
| `stability-logs/` | 心跳日志里有**真实积分余额流水** |
| `perf-baseline.json` | 性能基线含本机实测数据 |
| `plugin-auth.json` / `auth.json` / `.cookie-key` | 等同意志级凭据，泄露等于交出账号 |
| 任何 `.jsonl` / `*.log` | 运行产物，可能含请求内容 |

这些已在 `.gitignore` 里排除。**但 `.gitignore` 只对未跟踪文件生效**——一旦误提交过一次，
即使后来删除，它仍留在 git 历史里。这种情况必须重写历史（`git filter-repo`）或删库重建。

> 补救办法（仅当仓库是刚建、只有 1 个提交、没别人 clone 过时可用）：
> 改好文件 → `git add -A` → `git commit --amend` → `git push --force-with-lease`。
> 旧提交会从分支上消失。GitHub 在垃圾回收前仍可能通过旧 SHA 直接访问到它，
> 所以彻底的做法是删库重建；只有 1 个提交、0 star 的新库，amend 已经够用。

---

## 当前状态

- 版本 `0.2.1`，19 个离线套件 / 31 个套件（`node run-tests.mjs --quick` = 98 pass / 0 fail）
- 已按官方插件规范对齐（详见 README 变更记录 0.2.1）
- 已发布：<https://github.com/R227BOUT/magpie-plugin-dumate>，`magpie-plugin` topic 已生效
- 已脱敏：无硬编码本机路径、无真实余额数字、`.gitignore` 就位

## 脱敏与登录是两件不相干的事（常见误解）

**插件目录里从来不存你的登录凭据。** 凭据只在这两个地方，都不在插件目录：

| 位置 | 谁管 | 插件的关系 |
|---|---|---|
| `%APPDATA%\qianfan-desktop-app\auth.json` + `.cookie-key` | DuMate 客户端 | 只读复用，绝不写入 |
| `~/.config/magpie/plugin-auth.json` | magpie 自己 | 插件拿不到也写不了 |

所以：

- **重新登录不会往插件目录写任何东西**——magpie 把凭据写进它自己的 `plugin-auth.json`。
- **改代码、再推 GitHub，都不需要重新脱敏**。脱敏删的是「本机路径 / 真实余额 / 测试产物」，
  和凭据完全无关。
- 只要不新写「把真实数据落盘」的测试，泄漏就不会再产生。推之前跑一次上面的三条检查即可。
