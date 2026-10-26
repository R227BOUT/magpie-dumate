// 第二十三轮：文档终审 —— README 全文逐节核对与代码行为一致性（离线静态）
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(join(here, "README.md"), "utf8")
const src = readFileSync(join(here, "index.mjs"), "utf8")
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"))
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[D1] README 提到的所有测试套件都真实存在")
try {
  // README 有两处提及形态：正文里的 test-xxx.mjs、表格里的裸套件名 test-xxx
  const withExt = [...readme.matchAll(/test-[\w-]+\.mjs/g)].map((m) => m[0])
  const bare = [...readme.matchAll(/^\| (test-[\w-]+) \|/gm)].map((m) => m[1] + ".mjs")
  const mentioned = [...new Set([...withExt, ...bare])]
  if (!mentioned.length) throw new Error("README 未提及任何测试套件（断言失效保护）")
  const missing = mentioned.filter((f) => { try { readFileSync(join(here, f)); return false } catch { return true } })
  if (missing.length) throw new Error("README 提到但不存在的测试: " + missing.join(","))
  ok(`${mentioned.length} 个测试套件全部存在（正文 ${withExt.length} + 表格 ${bare.length}）`)
} catch (e) { fail("测试文件存在性", e) }

console.log("[D2] README 测试表与 run-tests.mjs 名单一致")
try {
  const runnerSrc = readFileSync(join(here, "run-tests.mjs"), "utf8")
  const offline = runnerSrc.match(/const OFFLINE = \[([^\]]+)\]/)?.[1] ?? ""
  const online = runnerSrc.match(/const ONLINE = \[([^\]]+)\]/)?.[1] ?? ""
  const inRunner = [...(offline + online).matchAll(/"([\w-]+)"/g)].map((m) => m[1])
  const inReadme = [...readme.matchAll(/^\| (test-[\w-]+) \|/gm)].map((m) => m[1])
  const runnerOnly = inRunner.filter((s) => !inReadme.includes(s))
  const readmeOnly = inReadme.filter((s) => !inRunner.includes(s))
  if (runnerOnly.length) throw new Error("runner 有但 README 无: " + runnerOnly.join(","))
  if (readmeOnly.length) throw new Error("README 有但 runner 无: " + readmeOnly.join(","))
  ok(`${inRunner.length} 套件双向一致`)
} catch (e) { fail("README-runner 一致性", e) }

console.log("[D3] README 提到的模型 id 与 FALLBACK_MODELS 一致")
try {
  const fallbackIds = [...src.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1])
  for (const id of fallbackIds) {
    if (!readme.includes(id)) throw new Error(`README 未提模型 ${id}`)
  }
  ok(`fallback 模型 ${fallbackIds.join(",")} 均在文档中`)
} catch (e) { fail("模型文档", e) }

console.log("[D4] package.json 字段完整（name/version/description/main/exports/license）")
try {
  for (const f of ["name", "version", "description", "main", "exports", "license"]) {
    if (!pkg[f]) throw new Error("缺 " + f)
  }
  if (pkg.main !== "./index.mjs") throw new Error("main 异常: " + pkg.main)
  ok(`v${pkg.version}, main 正确`)
} catch (e) { fail("package.json", e) }

console.log("[D5] 变更记录完整（每项修复必须在 README 里留下痕迹）")
try {
  // 原先读的是 夜间工作报告.md（夜间检修的过程产物，已归档，不再随插件走）。
  // 要求没有降低：修了什么必须写在 README 里，否则插件被带走后没人知道改动来历。
  const changelog = readme.split("## 变更记录")[1] ?? ""
  if (!changelog) throw new Error("README 缺变更记录章节")
  // 硬门槛：条目数足够（版本标题以 "### " 开头，不计数）。少于 8 条说明被删减了。
  const bullets = [...changelog.matchAll(/^- /gm)].length
  if (bullets < 8) throw new Error(`变更记录条目过少（${bullets} 条），可能被删减或格式被改`)
  // 版本号必须出现在变更记录里，防止版本与记录脱节
  if (!changelog.includes(pkg.version)) throw new Error(`变更记录未提及当前版本 ${pkg.version}`)
  // 最新版本必须在最前：否则"当前版本"读到的其实是旧记录
  const versions = [...changelog.matchAll(/^### (\d+\.\d+\.\d+)/gm)].map((m) => m[1])
  if (!versions.length) throw new Error("变更记录里没有版本标题")
  if (versions[0] !== pkg.version) throw new Error(`最新变更记录是 ${versions[0]}，不是当前版本 ${pkg.version}`)
  ok(`变更记录 ${bullets} 条，最新版本 ${versions[0]}`)
} catch (e) { fail("变更记录完整性", e) }

console.log("[D6] README 里的套件数量与 runner 名单一致")
try {
  const runnerSrc = readFileSync(join(here, "run-tests.mjs"), "utf8")
  const offline = [...(runnerSrc.match(/const OFFLINE = \[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1])
  const online = [...(runnerSrc.match(/const ONLINE = \[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1])
  const readmeOffline = readme.match(/--quick\s+#\s*(\d+)\s*个离线套件/)?.[1]
  const readmeTotal = readme.match(/node run-tests\.mjs\s+#\s*全部\s*(\d+)\s*套件/)?.[1]
  if (!readmeOffline) throw new Error("README 未写离线套件数量（形如 `# N 个离线套件`）")
  if (!readmeTotal) throw new Error("README 未写总套件数量（形如 `# 全部 N 套件`）")
  if (Number(readmeOffline) !== offline.length) throw new Error(`离线数量不符：README ${readmeOffline} vs runner ${offline.length}`)
  if (Number(readmeTotal) !== offline.length + online.length) throw new Error(`总数量不符：README ${readmeTotal} vs runner ${offline.length + online.length}`)
  ok(`离线 ${offline.length} / 总计 ${offline.length + online.length}，与 README 一致`)
} catch (e) { fail("套件数量一致性", e) }

console.log("[D7] README 不写死汇总型用例数（「N 用例」只在描述单个套件时允许）")
try {
  // 汇总型 = 两位数以上且后面紧跟「用例」，如「91 用例」「122 个用例」——必然随迭代过期
  const hits = [...readme.matchAll(/(\d+)\s*个?用例/g)]
    .map((m) => ({ text: m[0], n: Number(m[1]) }))
    .filter((h) => h.n >= 20)
  if (hits.length) throw new Error("README 出现汇总用例数: " + hits.map((h) => h.text).join(","))
  const single = [...readme.matchAll(/(\d+)\s*个专杀用例/g)].map((m) => m[0])
  ok(`无汇总用例数硬编码（允许的单套件表述：${single.join(",") || "无"}）`)
} catch (e) { fail("用例数硬编码", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
