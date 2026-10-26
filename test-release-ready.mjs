// 第二十五轮：插件 version bump + 发布就绪检查（版本号应反映 11 个 bug 修复）
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[R1] 版本号可解析且与 README 变更记录首条一致")
try {
  const pkgPath = join(here, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  // 不把版本号写死在这里：那会让每次发版都要改测试，且改测试的动机是"让它变绿"，
  // 正是断言最不该有的性质。改为校验格式 + 与 README 变更记录的最新条目一致。
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) throw new Error("版本格式异常: " + pkg.version)
  const readme = readFileSync(join(here, "README.md"), "utf8")
  const headings = [...readme.matchAll(/^### (\d+\.\d+\.\d+)（/gm)].map((m) => m[1])
  if (!headings.length) throw new Error("README 变更记录里找不到版本标题")
  if (headings[0] !== pkg.version) throw new Error(`版本不一致：package.json ${pkg.version} vs README 最新 ${headings[0]}`)
  ok(`v${pkg.version}，与 README 最新变更记录一致`)
} catch (e) { fail("版本检查", e) }

console.log("[R2] 项目文件清单完整性（无孤儿/无缺失）")
try {
  const files = readdirSync(here)
  const testFiles = files.filter((f) => /^test-[\w-]+\.mjs$/.test(f))
  const runnerSrc = readFileSync(join(here, "run-tests.mjs"), "utf8")
  const offline = runnerSrc.match(/const OFFLINE = \[([^\]]+)\]/)?.[1] ?? ""
  const online = runnerSrc.match(/const ONLINE = \[([^\]]+)\]/)?.[1] ?? ""
  const inRunner = [...(offline + online).matchAll(/"([\w-]+)"/g)].map((m) => m[1] + ".mjs")
  // runner 名单指向的文件必须都真实存在（防名单写错/文件改名）
  const missingFiles = inRunner.filter((f) => !testFiles.includes(f))
  if (missingFiles.length) throw new Error("runner 名单指向不存在的文件: " + missingFiles.join(","))
  // 未被 runner 收录的测试文件必须全部在「有意排除」清单里
  const knownExcluded = [
    "test-quick-ux.mjs",      // meta：spawn runner 会递归
    "test-long-session.mjs",  // 3 分钟长循环
    "test-heartbeat.mjs",     // 20 分钟心跳
    "test-changelog.mjs",     // 一次性迁移（写 README 变更记录）
    "test-magpie-upgrade.mjs", // 需沙箱 magpie，非标准环境
    "test-ai-sdk-e2e.mjs",    // 需 workspace 装的 AI SDK（ESM 绝对路径 import）
  ]
  const notInRunner = testFiles.filter((f) => !inRunner.includes(f))
  const unexpected = notInRunner.filter((f) => !knownExcluded.includes(f))
  if (unexpected.length) throw new Error("存在未纳入 runner 的测试: " + unexpected.join(","))
  const staleExcluded = knownExcluded.filter((f) => !notInRunner.includes(f))
  if (staleExcluded.length) throw new Error("排除清单已过期（这些其实在 runner 里或文件不存在）: " + staleExcluded.join(","))
  // 集合不变量：总数 = runner 覆盖 + 排除数
  if (testFiles.length !== inRunner.length + notInRunner.length) throw new Error("清单数量不自洽")
  ok(`${testFiles.length} 个测试文件 = runner 覆盖 ${inRunner.length} + 有意排除 ${notInRunner.length}`)
} catch (e) { fail("文件清单", e) }

console.log("[R3] 所有 .mjs 语法有效（只做语法检查，不执行模块）")
try {
  // 原来用 import() 逐个"加载"文件：那不是在查语法，是真的把每个套件跑一遍
  // （每个都会读凭据、打网关、耗积分），耗时百秒级。
  // 改用 node --check：只解析语法，不执行顶层代码。秒级完成，也不产生副作用。
  const files = readdirSync(here).filter((f) => f.endsWith(".mjs"))
  const { spawnSync } = await import("node:child_process")
  const bad = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", join(here, f)], { encoding: "utf8", timeout: 30_000 })
    if (r.status !== 0) {
      const why = (r.stderr ?? "").split("\n").find((l) => /SyntaxError|Error/.test(l)) ?? "exit " + r.status
      bad.push(f + ": " + why.trim())
    }
  }
  if (bad.length) throw new Error(bad.join("; "))
  ok(`${files.length} 个 .mjs 语法有效（node --check，未执行）`)
} catch (e) { fail("语法检查", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
