# magpie-plugin-dumate

OpenCode & Magpie provider plugin for **Baidu DuMate（百度搭子，qianfan 桌面版）** personal points.

把 DuMate 账号的个人模型积分额度接入 Magpie：登录后即可在任意 agent 里使用
`dumate/model-text`（智能路由）等模型，调用消耗 DuMate 积分。

## 功能

- **模型调用**：`https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions`（OpenAI 兼容），
  凭据链路 = Cookie → `/api/dumate/app/token/get` 换 gateway token → `Authorization: Bearer`。
  token 自动缓存与续期（服务端有效期约 14 小时，插件每小时主动刷新）。
- **每日签到**：magpie `checkin` hook，自动领取每日登录积分（数额以接口差额实时计算，Settings → Usage → Plugins 开关）。
- **余额展示**：magpie `usage` hook，在 Usage 页显示剩余/总积分、最近到期积分包。
- **三种登录方式**：
  1. 桌面端登录态复用（读取本机 `qianfan-desktop-app/auth.json` + `.cookie-key`，**只读**）
  2. 浏览器登录（无需安装 DuMate：打开 login.bce.baidu.com 登录后，从 DevTools → Network
     复制请求头的 `Cookie` 整行——关键 Cookie 是 httpOnly，`document.cookie` 拿不到）
  3. 手动粘贴 Cookie 字符串
- **图标**：`auth.icon` 提供 `data:image` URI，按此顺序取第一个可用的：
  1. 插件目录内自带的 `icon.png`（**推荐**，插件自包含，换机器也能用）
  2. 本机已安装 DuMate 的官方图标（256 → 128 → 512，只读借用，不复制）
  3. 插件目录内自带的 `icon.svg`（矢量兜底）
  4. 空串 → magpie 默认方块

  任何一级读取失败都只会降级，不会影响 provider 加载。

  **当前实际使用**：`icon.png` 取自客户端 `icons/256x256.png`（31.8KB），已随插件自带。
  **选哪一张**：用 `256x256.png`，不要 `512x512.png`（101.5KB）或 `1024x1024.png`（244.6KB）——
  magpie 只在插件卡片和 Installed 行渲染，实际尺寸 20–40px，256 与 512 缩到这个尺寸无可辨差异，
  但 base64 编码后体积只有三分之一（插件加载时每次都要编码）。
  不要把 `trayTemplate.png` 拿来用，那是 macOS 菜单栏的纯黑剪影，深色主题下会整个消失。

## 安装

前提：`magpie` 命令能被解析到。Magpie 是绿色单文件版，**默认不会进 PATH**，
所以先确认一次：

```powershell
magpie --version
```

报「无法将 magpie 项识别为 cmdlet」就说明它在 PATH 外。用完整路径调用，
或把所在目录加进用户 PATH（只对之后新开的终端生效）：

```powershell
# 方式 A：完整路径调用（把 <magpie 目录> 换成实际位置）
<magpie 目录>\magpie-windows-amd64.exe plugin add <本插件目录>
<magpie 目录>\magpie-windows-amd64.exe plugin login dumate

# 方式 B：把 magpie 所在目录加进用户 PATH
$d = "<magpie 目录>"
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$d", "User")
```

PATH 配好后就可以简写：

```bash
magpie plugin add ./magpie-plugin-dumate
magpie plugin login dumate
```

> Windows 上可以在 PATH 里的某个目录（例如 `%APPDATA%\npm`）放一个 `magpie.cmd` 转发到 exe，
> 之后 `magpie` 就能直接用。注意**不要把 exe 本身改名**：Magpie 的 WebView2 用户数据目录
> 是按 exe 文件名生成的，改名会让 `%APPDATA%\<原名>` 被弃用，登录态和缓存看起来就"消失"了。

### 不想用命令行？直接改配置登记（等价于 `plugin add`）

`plugin add <本地目录>` 做的事其实就一件：往 `~/.config/magpie/plugins.json` 的 `plugins` 数组里
加一条 `spec`。所以手工加一条完全等价，**不需要把插件文件复制到 `.config/magpie` 里**：

```json
{
  "plugins": [
    { "spec": "<本插件目录的绝对路径>" }
  ]
}
```

改完重启 Magpie 即可。本地目录是**原地加载**（官方原文 "a folder is loaded where it is;
nothing is installed"），所以以后改 `index.mjs` 只要重载就生效，不用重新 `add`。

### 🔴 一个插件 = 一条 spec，没有"写个 magpie 就都连上"

这是最容易误解的地方。`plugins.json` 的结构是 `{"plugins": [{"spec", "off"?, "options"?}]}`，
**每条 spec 只指向一个插件模块入口**，Magpie **不会扫描父目录去发现子插件**。
即使所有插件都放在 `magpie/` 下，`plugin add ./magpie` 也只会尝试加载 `magpie/` 自身的入口文件，
不会把 `magpie/magpie-plugin-dumate`、`magpie/magpie-plugin-xxx` 自动注册进来。

所以：

- **每加一个新插件 = 新增一条 spec**，逐条加，没有捷径。
- `magpie/` 只是**你放源码的目录**，不是 Magpie 的插件注册单位。
- 一个 spec 内部可以导出多个 provider/hook（那是同一个包的事），但那不减少 spec 条数。

运行时可以把 `plugin-providers.json` 当作验证依据：它是 magpie 生成的缓存，
每个条目形如 `{"id":"dumate","spec":"D:\\...\\magpie-plugin-dumate"}` —— **id 与 spec 一一对应**。

> ⚠️ 不要手工把插件文件夹塞进 `.config/magpie/plugins/node_modules/`。那个目录由 Magpie 用
> `bun install` 按 `plugins/package.json` 的依赖清单维护（npm / git 装的包才落地在这里），
> 手工放进去的包在下次安装依赖时会被清掉。本地插件就走 `spec` 绝对路径，不需要复制。
>
> 手工改 `plugins.json` 前先备份。建议先退出 Magpie 再改：GUI 运行时会持有插件列表状态，
> 在这个状态下改文件有被回写覆盖的风险（这一点属预防性建议，未做专项验证）。
>
> 改完不生效时：终端里每条 `magpie` 命令都会新起一个 host，所以总能读到最新目录内容；
> GUI 则需要**关掉再打开该插件**（Plugins › Installed 里的开关），让它重新加载。

## 登录方式说明

1. **桌面端登录态复用**（推荐）：读取本机 `qianfan-desktop-app/auth.json` + `.cookie-key` 解密复用，只读不写。
2. **浏览器登录**（免装 DuMate）：打开登录链接 → 登录跳转到 console.bce.baidu.com 后，F12 → Network 面板 → 任一请求的 Request Headers 里复制 **Cookie 整行值** 粘贴。
   注意：关键登录 Cookie（BDUSS/STOKEN/bce-sessionid）是 httpOnly，`document.cookie` 拿不到，必须用 Network 面板的请求头。
3. **手动粘贴 Cookie 串**：同上来源，需包含 `bce-sessionid`。

登录后 Cookie 过期时（约几周）：方式 1 重新执行 `magpie plugin login dumate` 即可（若 DuMate 客户端重新登录过，插件 refresh 会自动跟随新 Cookie）；方式 2/3 需重新复制粘贴。

## 测试

```bash
node run-tests.mjs --quick   # 19 个离线套件，不联网不耗积分（约 2 分钟）
node run-tests.mjs           # 全部 31 套件（真实调用网关，消耗少量积分）
node run-tests.mjs test-smoke test-stress   # 只跑指定套件
node run-tests.mjs --quick test-unit test-static   # 只跑指定离线套件（秒级）
```

> 只改文档/单模块时用最后一行挑套件跑，能秒级得到反馈。
> 套件数量以 `run-tests.mjs` 的 `OFFLINE`/`ONLINE` 名单为准，本节数字由 `test-docs-audit` 断言把守；
> 用例数随迭代变化，不写进文档，以 runner 合计行为准。

**换台机器能跑吗？** 离线套件在**任何机器**上都能跑：其中三个（`test-points-audit`、
`test-client-fingerprint`、`test-windows-paths`）需要本机 DuMate 登录态做真实数据比对，
拿不到时会打印 `SKIP` 并以 0 退出，不算失败。联网套件则**必须**有可用登录态，否则会报错。

<details><summary>各套件明细</summary>

| 套件 | 覆盖 |
|---|---|
| test-unit | 纯函数：Cookie 解析/域过滤/引号/csrf/容错 |
| test-static | 代码走查：缓存/头清理/泄漏面/失败信息 |
| test-config-edge | config/models hook 契约与幂等 |
| test-checkin-branches | checkin 五分支（fetch mock） |
| test-desktop-paths | 桌面登录路径矩阵 + auth.json 容错 |
| test-token-lifecycle | token 单飞 / 刷新边界 / 异常形态 |
| test-delivery-review | 交付链审查（指引/文档/报错/路径） |
| test-edge-cases | 401 自愈 / windows 计算 / null 字段 |
| test-bug-regression | 已修 bug 的回归哨兵（6 个专杀用例） |
| test-determinism | 跨套件确定性（两轮签名比对） |
| test-upgrade-compat | 旧 seat / 脏 cookie / getAuth 抛错防御 |
| test-security | 凭据生命周期 / 域名白名单 / 泄漏面 |
| test-sse-robustness | SSE 变体：CRLF / 大 chunk / 截断 / 错误体 |
| test-docs-audit | README 与 runner/模型/bug 记录的一致性自检 |
| test-smoke | 全链路冒烟 |
| test-stream-tools | SSE / tool_calls / 大 payload / 错误格式 |
| test-concurrency | 并发 / 坏凭据 401 / 缓存复用 |
| test-browser-login | 浏览器登录方式端到端模拟 |
| test-loader-real | Request 对象 / 流式工具 / refresh 三态 |
| test-multi-turn | 多轮上下文 / system / 参数透传 / 压力 |
| test-checkin-real-fields | 签到真实响应字段核对 |
| test-agent-session | agent 综合演练（多轮+并发工具+流式） |
| test-stress | 30 并发混合 / 断流 / 恢复 |
| test-model-routing | 智能路由观测 / 响应字段完整性 |
| test-perf-baseline | 性能基线：token 链路 / TTFB / 分位数 |
| test-points-audit | 积分守恒对账（本机凭据，仅本地可跑） |
| test-client-fingerprint | 请求指纹与真实客户端一致性（UA/Cookie/csrf） |
| test-release-ready | 发布就绪：版本/文件清单/语法（非 runner 套件见排除清单） |
| test-windows-paths | Windows 路径矩阵：空格/中文/缺失 APPDATA/反斜杠 |
| test-privacy | 隐私最小化：外发域名白名单/请求头清单/无机器信息 |
| test-llm-edge | LLM 边界：特殊字符/长输入/角色序列/参数边界 |

</details>

注意：`model-text` 是推理路由，`max_tokens` 给太小（≤64）时推理思考会吃光配额导致 content 为空、finish_reason=length——这是上游特性，不是插件问题。

## 模型

| ID | 说明 |
|---|---|
| `model-text` | 智能路由（桌面端同款默认，网关自动选择上游） |
| `dm-auto-model/text.L0` | Auto L0 路由 |

网关未提供 /models 端点，清单为固定回退表。上游真实模型由网关侧决定，
API 层不暴露（响应始终回显 `model-text`，id 前缀 `gd-`）；桌面端抓包曾观察到
deepseek-v4-flash-low-latency / qwen35-35b-a3b，但那不是接口契约，不要依赖它。

## 安全说明

- Cookie 明文包含 BDUSS/STOKEN 等百度账号凭据，等同意志级凭据：插件只在内存中使用，
  持久化由 magpie `plugin-auth.json` 统一管理（与所有官方插件一致）。
- 桌面端登录态为只读复用，绝不写 DuMate 数据目录任何文件。
- 自定义 DuMate 数据目录：设置环境变量 `DUMATE_USER_DATA_DIR`。

## 已验证接口（2026-10 实测）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/dumate/app/token/get` | GET | Cookie → gateway token（约 14h 有效） |
| `/api/dumate/points/quota_overview` | GET | 积分总览 |
| `/api/dumate/points/loginBonusInfo` | GET | 签到状态 |
| `/api/dumate/points/loginBonus` | POST | 领签到积分（需域名过滤 Cookie + csrftoken 头） |
| `/api/dumate/user/info` | GET | 账号信息（登录验证） |
| `dumate-svc.baidu.com/gateway/apis/v1/chat/completions` | POST | 模型调用（消耗积分） |

## 变更记录

### 0.2.1（2026-10-26 对照官方插件规范整改 + 准备公开）

按 magpie 官方插件文档与社区插件（`magpie-plugin-msmoli`、`opencode-zcode-auth`）的实际写法对齐：

- `auth.checkin` 返回值语义修正：`POST` 成功但积分未到账时，原来返回 `claimed`（等于宣称一件
  无法证明的事），现改为 `inactive`；登录失效时补 `signIn: "expired"`，magpie 才会标记账号并
  提示重新登录，而不是反复重试同一个死会话。
- `usage` 失败时保留 `signIn: "expired"`：原实现把额度查询的错误一律 `.catch(() => null)` 吞掉，
  登录失效于是被降级成"额度接口不可用"，magpie 会继续重试一个永远不会成功的会话。
- 对外消息统一过 `cardText()` 消毒：清掉控制字符与 bidi 覆盖符。远程返回的错误文本会进账号卡片、
  magpie 日志和终端，一行伪造的换行就能造出假日志。
- `checkin` 加 25 秒预算：magpie 把所有 provider 的签到放在同一个 2 分钟上下文里逐个账号问，
  单个账号不能吃掉别人的份额。
- `package.json` 补 `magpie.maxConcurrency: 4`（官方建议字段，1–1000）。
- 未登录提示从英文 `not signed in` 改为中文可操作提示。
- 脱敏：移除源码里硬编码的本机路径（改为 `homedir()` 推导 + 环境变量覆盖）、
  去掉积分审计里的真实余额锚点、新增 `.gitignore` 排除测试产物（含真实积分流水）与凭据文件。

### 0.2.0（2026-10-26 夜间检修，11 项修复）

- 🔴 浏览器登录方式重做：原指引依赖 `document.cookie` 无法获取 httpOnly 凭据（必需项为 `bce-sessionid`），改为 DevTools Network 面板复制请求头 Cookie，粘贴后自动验证。
- 🔴 插件结构合规：config hook 改 async 函数式，补 provider.models hook（修复后 provider 正常注册 2 个模型）。
- 补 auth.refresh：桌面端 seat 自动跟随 DuMate 客户端重新登录后的新 Cookie，不再死锁。
- 签到积分改为前后差额实时计算（原硬编码 500）。
- Cookie 失效时百度返回 200+HTML 登录页，现正确识别为 signIn=expired 引导重登（原误报 502）。
- quota 包 `expireDate=null`（永不过期）不再产生 1970-01-01 的假过期时间。
- getAuth() 抛错 / cookies 形态异常时 usage/checkin/loader 优雅降级，不再崩 magpie quota 刷新。
- 安装说明补齐「`magpie` 不在 PATH」这一最常见失败：绿色版默认不进 PATH，给出完整路径调用与写 PATH 两种做法。
  （不要为了省事把 exe 改名成 `magpie.exe`：GUI 的 WebView2 用户数据目录按 exe 文件名生成，
  改名会让 `%APPDATA%\magpie-windows-amd64.exe` 被弃用，登录态与缓存看起来"消失"。）
- 测试体系：31 个套件（19 个离线套件、不联网零积分；另 12 个联网套件真实调用网关），
  含 11 个已修 bug 的回归哨兵、性能基线、安全审查、隐私审计、确定性验证、文档一致性守门。
  套件数量由 `test-docs-audit` 断言把守；用例数随迭代变化，以 runner 输出为准。
