// 第二十六轮：真实 magpie 端 plugin update 路径 —— 0.1.0 seat 升级到 0.2.0 的兼容
// 用沙箱 magpie 重装（update）插件并验证旧 plugin-auth.json 的 seat 依然可用
//
// 沙箱（bin/magpie.exe 与隔离 HOME）在临时目录，属一次性产物，项目搬家后可能不存在。
// 该套件本就登记在 release-ready 的「有意排除」清单里，因此沙箱缺失时跳过而非报红。
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
// 沙箱位置不写死用户名：可用 MAGPIE_SANDBOX 覆盖，否则从用户目录推导。
const SANDBOX = process.env.MAGPIE_SANDBOX
  ?? join(homedir(), ".workbuddy", "tmp-dumate-extract", "magpie-sandbox")

if (!existsSync(join(SANDBOX, "bin", "magpie.exe"))) {
  console.log(`  SKIP 沙箱 magpie 不存在（${SANDBOX}）——本套件需沙箱环境，已登记为有意排除`)
  process.exit(0)
}

const env = {
  ...process.env,
  USERPROFILE: join(SANDBOX, "home"),
  LOCALAPPDATA: join(SANDBOX, "home", "AppData", "Local"),
}

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const { spawnSync } = await import("node:child_process")
const run = (args, timeout = 90_000) =>
  spawnSync(join(SANDBOX, "bin", "magpie.exe"), args, { encoding: "utf8", timeout, env })

console.log("[UP1] 沙箱内 plugin 状态（旧 0.1.0 seat 仍在）")
try {
  // signed-in 状态在 plugin 列表的下一行（缩进行），需跨行联合匹配
  const r = run(["plugin"])
  const lines = (r.stdout ?? "").split("\n")
  const idx = lines.findIndex((l) => l.includes("dumate") && l.includes("on"))
  const signedLine = lines.slice(idx, idx + 2).join("\n")
  if (!/signed in as/.test(signedLine)) throw new Error("旧 seat 丢失，输出:\n" + lines.slice(0, 4).join("\n"))
  ok("旧登录态保留")
} catch (e) { fail("旧 seat", e) }

console.log("[UP2] 重新 add（覆盖为 0.2.0 代码）后旧 seat 仍可调用")
try {
  // plugin add 同路径 = 更新代码；plugin-auth.json 不动。
  // 路径取自本文件所在目录，避免插件项目搬家后硬编码失效。
  const add = run(["plugin", "add", here])
  if (!/dumate/.test(add.stdout ?? "")) throw new Error("add 输出异常: " + (add.stdout ?? "").slice(0, 100))
  const who = run(["plugin"])
  const lines = (who.stdout ?? "").split("\n")
  const idx = lines.findIndex((l) => l.includes("dumate") && l.includes("on"))
  const signedLine = lines.slice(idx, idx + 2).join("\n")
  if (!/signed in as/.test(signedLine)) throw new Error("add 后 seat 丢失")
  ok("升级后旧 seat 兼容（plugin-auth 不因代码更新失效）")
} catch (e) { fail("升级兼容", e) }

console.log("[UP3] 升级后端到端 provider test")
try {
  const r = run(["provider", "test", "dumate"], 120_000)
  const good = (r.stdout ?? "").includes("✓")
  if (!good) throw new Error("provider test 失败: " + (r.stdout ?? "").slice(0, 150))
  const ms = (r.stdout.match(/(\d+)\s*ms/) ?? [])[1]
  ok(`chat 通过（${ms}ms）`)
} catch (e) { fail("端到端", e) }

console.log("[UP4] 升级后 quota refresh")
try {
  const r = run(["quota", "refresh", "dumate", "--json"], 60_000)
  const j = JSON.parse(r.stdout ?? "[]")
  const dum = Array.isArray(j) ? j.find((x) => x.provider === "dumate") : null
  if (!dum) throw new Error("quota 无 dumate: " + (r.stdout ?? "").slice(0, 100))
  ok(`quota 正常（${dum.balance}）`)
} catch (e) { fail("quota", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
