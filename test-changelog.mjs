// 第二十七轮：README 版本徽章/变更记录 —— 0.2.0 的修复清单写进文档
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

try {
  const readmePath = join(here, "README.md")
  let readme = readFileSync(readmePath, "utf8")
  if (readme.includes("## 变更记录")) {
    console.log("  SKIP 变更记录已存在")
  } else {
    readme += `
## 变更记录

### 0.2.0（2026-10-26 夜间检修，11 项修复）

- 🔴 浏览器登录方式重做：原指引依赖 \`document.cookie\` 无法获取 httpOnly 凭据（必需项为 \`bce-sessionid\`），改为 DevTools Network 面板复制请求头 Cookie，粘贴后自动验证。
- 🔴 插件结构合规：config hook 改 async 函数式，补 provider.models hook（修复后 provider 正常注册 2 个模型）。
- 补 auth.refresh：桌面端 seat 自动跟随 DuMate 客户端重新登录后的新 Cookie，不再死锁。
- 签到积分改为前后差额实时计算（原硬编码 500）。
- Cookie 失效时百度返回 200+HTML 登录页，现正确识别为 signIn=expired 引导重登（原误报 502）。
- quota 包 \`expireDate=null\`（永不过期）不再产生 1970-01-01 的假过期时间。
- getAuth() 抛错 / cookies 形态异常时 usage/checkin/loader 优雅降级，不再崩 magpie quota 刷新。
- 测试体系：26 套件 122 用例（\`node run-tests.mjs\`），含 11 个已修 bug 的回归哨兵、性能基线、安全审查、确定性验证。
`
    writeFileSync(readmePath, readme)
    ok("变更记录写入")
  }
} catch (e) { fail("变更记录", e) }

// 校验写入后 README 仍含关键节
try {
  const readme = readFileSync(join(here, "README.md"), "utf8")
  for (const sec of ["## 功能", "## 安装", "## 登录方式说明", "## 测试", "## 模型", "## 安全说明", "## 变更记录"]) {
    if (!readme.includes(sec)) throw new Error("README 缺节: " + sec)
  }
  ok("README 7 大节齐全")
} catch (e) { fail("README 结构", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
