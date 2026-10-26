// 第十六轮 B2：跨套件污染审计——顺序跑全部离线套件两次，验证结果确定性
// （若有套件泄漏全局状态，第二次跑会出现不同结果）
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const node = process.execPath
const OFFLINE = ["test-unit", "test-static", "test-config-edge", "test-checkin-branches", "test-desktop-paths", "test-token-lifecycle", "test-delivery-review", "test-edge-cases", "test-bug-regression"]

const signature = () => {
  const sig = {}
  for (const s of OFFLINE) {
    const r = spawnSync(node, [join(here, s + ".mjs")], { encoding: "utf8", timeout: 120_000 })
    sig[s] = (r.stdout.match(/^  PASS/gm) ?? []).length + "/" + ((r.stdout + r.stderr).match(/FAIL/g) ?? []).length
  }
  return sig
}

console.log("[I1] 第一轮")
const run1 = signature()
console.log("  ", JSON.stringify(run1))
console.log("[I2] 第二轮（同进程树独立 spawn，验证确定性）")
const run2 = signature()
const identical = JSON.stringify(run1) === JSON.stringify(run2)
if (!identical) {
  console.error("  FAIL 两轮结果不同:", JSON.stringify(run2))
  process.exitCode = 1
} else {
  console.log("  PASS 两轮完全一致（无跨套件污染，结果确定）")
}
