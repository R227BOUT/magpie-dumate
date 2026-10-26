// 第三十轮：Windows 特殊场景 —— 路径含中文/空格、AppData 重定向、多用户环境
// 验证 desktopUserDataDir 与 readDesktopLogin 在非标准环境下的行为
import { DuMatePlugin, _internal } from "./index.mjs"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { readDesktopLogin } = _internal
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

// 构造合法 auth 文件（iv+tag+ct 布局）
function makeAuthFiles(dir, opts = {}) {
  mkdirSync(dir, { recursive: true })
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const payload = JSON.stringify(opts.cookies ?? [{ name: "bce-sessionid", value: "v", domain: ".baidu.com" }])
  const c = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(payload, "utf8"), c.final()])
  const enc = Buffer.concat([iv, c.getAuthTag(), ct])
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cookies: enc.toString("base64"), ...(opts.authExtra ?? {}) }))
  writeFileSync(join(dir, ".cookie-key"), key)
}

const origAppData = process.env.APPDATA
// OS-provided temp dir; a hardcoded home path here would leak the author's
// machine layout in a published file and break on any other machine.
const sandbox = join(tmpdir(), "dumate-win-matrix")
rmSync(sandbox, { recursive: true, force: true })

console.log("[W1] APPDATA 含空格的路径")
try {
  const p = join(sandbox, "App Data With Spaces", "qianfan-desktop-app")
  makeAuthFiles(p)
  process.env.APPDATA = join(sandbox, "App Data With Spaces")
  const r = readDesktopLogin()
  if (!r || !r.cookies.length) throw new Error("空格路径读取失败")
  ok(`空格路径 OK（${r.cookies.length} 条 cookie）`)
} catch (e) { fail("空格路径", e) }

console.log("[W2] APPDATA 含中文的路径")
try {
  const p = join(sandbox, "中文目录测试", "qianfan-desktop-app")
  makeAuthFiles(p)
  process.env.APPDATA = join(sandbox, "中文目录测试")
  const r = readDesktopLogin()
  if (!r || !r.cookies.length) throw new Error("中文路径读取失败")
  ok(`中文路径 OK（${r.cookies.length} 条 cookie）`)
} catch (e) { fail("中文路径", e) }

console.log("[W3] APPDATA 未设置（undefined）→ 走空字符串 join 不崩")
try {
  delete process.env.APPDATA
  const r = readDesktopLogin()
  // join("", "qianfan-desktop-app") = 相对路径 → statSync 失败 → null
  if (r !== null) throw new Error("APPDATA 缺失应返回 null")
  ok("APPDATA 缺失 → null 不崩")
} catch (e) { fail("APPDATA 缺失", e) }

console.log("[W4] DUMATE_USER_DATA_DIR 用 Windows 反斜杠路径")
try {
  const p = join(sandbox, "backslash-dir", "qianfan-desktop-app")
  makeAuthFiles(p)
  process.env.DUMATE_USER_DATA_DIR = p.replace(/\//g, "\\")
  const r = readDesktopLogin()
  if (!r) throw new Error("反斜杠路径读取失败")
  ok("反斜杠路径 OK")
} catch (e) { fail("反斜杠路径", e) }

console.log("[W5] 恢复环境变量")
try {
  process.env.APPDATA = origAppData
  delete process.env.DUMATE_USER_DATA_DIR
  const r = readDesktopLogin()
  // 没装 DuMate 的机器上这里读不到——那是环境差异，不是插件 bug，判 SKIP。
  if (!r || !r.cookies.length) {
    console.log("  SKIP 本机无 DuMate 登录态，W5 不适用（环境变量已恢复）")
  } else {
    ok(`真实环境恢复正常（${r.cookies.length} 条）`)
  }
} catch (e) { fail("环境恢复", e) }

rmSync(sandbox, { recursive: true, force: true })
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
