#!/usr/bin/env node
// 统一测试 runner：node run-tests.mjs [suite ...]
// 无参数 = 全部；传名字 = 只跑指定套件。--quick 跳过联网套件。
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const node = process.execPath
const args = process.argv.slice(2)
const quick = args.includes("--quick")
const only = args.filter((a) => !a.startsWith("--"))

const OFFLINE = ["test-unit", "test-static", "test-config-edge", "test-checkin-branches", "test-desktop-paths", "test-token-lifecycle", "test-delivery-review", "test-edge-cases", "test-bug-regression", "test-determinism", "test-upgrade-compat", "test-security", "test-sse-robustness", "test-docs-audit", "test-points-audit", "test-client-fingerprint", "test-release-ready", "test-windows-paths", "test-privacy"]
const ONLINE = ["test-smoke", "test-stream-tools", "test-concurrency", "test-browser-login", "test-loader-real", "test-multi-turn", "test-checkin-real-fields", "test-agent-session", "test-stress", "test-model-routing", "test-perf-baseline", "test-llm-edge"]
const suites = (quick ? OFFLINE : [...OFFLINE, ...ONLINE]).filter((s) => !only.length || only.includes(s))

let totalPass = 0, totalFail = 0, failedSuites = []
for (const suite of suites) {
  const file = join(here, suite + ".mjs")
  const t0 = Date.now()
  const r = spawnSync(node, [file], { encoding: "utf8", timeout: 300_000 })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  const pass = (out.match(/^  PASS/gm) ?? []).length
  const fail = (out.match(/FAIL/g) ?? []).length
  totalPass += pass
  totalFail += fail
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const status = fail === 0 && r.status === 0 ? "✓" : "✗"
  console.log(`${status} ${suite.padEnd(28)} ${String(pass).padStart(2)} pass ${fail} fail ${secs}s`)
  if (status === "✗") {
    failedSuites.push(suite)
    console.log(out.split("\n").filter((l) => /FAIL|Error/i.test(l)).slice(0, 5).map((l) => "    " + l.trim()).join("\n"))
  }
}
console.log("─".repeat(52))
console.log(`合计: ${totalPass} pass, ${totalFail} fail, ${suites.length} 套件${failedSuites.length ? " · 失败: " + failedSuites.join(", ") : ""}`)
process.exitCode = totalFail ? 1 : 0
