// 第十六轮 C：测量离线套件总耗时（用户醒来后 `npm test:quick` 体验）
// 注意：不递归调 run-tests.mjs（它包含本文件会无限递归）——改为直接 spawn 各离线套件计时。
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OFFLINE = ["test-unit", "test-static", "test-config-edge", "test-checkin-branches", "test-desktop-paths", "test-token-lifecycle", "test-delivery-review", "test-edge-cases", "test-bug-regression", "test-determinism"]

const t0 = Date.now()
let fails = 0
for (const s of OFFLINE) {
  const r = spawnSync(process.execPath, [join(here, s + ".mjs")], { encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0 || /FAIL/.test(r.stdout + r.stderr)) fails++
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`[T1] 离线套件体验: ${OFFLINE.length} 套件 ${fails} 失败, ${secs}s`)
if (secs > 15 || fails) { console.error("  离线套件超 15s 或有失败"); process.exitCode = 1 }

// 顺带验证 files 数组声明的 glob 是否会把 test-determinism 带上（npm pack 模拟跳过，仅静态核对）
import { readFileSync } from "node:fs"
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"))
const hasTestGlob = pkg.files.some((f) => f.startsWith("test-"))
console.log(`[T2] package.json files 含 test glob: ${hasTestGlob ? "PASS" : "FAIL"}`)
if (!hasTestGlob) process.exitCode = 1
