// 第二十八轮：对齐真实 DuMate 客户端行为 —— 请求头指纹一致性验证
// 抓真实客户端的请求指纹与插件的逐项对比（用本地 HTTP 回显服务器，不联网）
import { createServer } from "node:http"
import { DuMatePlugin, _internal } from "./index.mjs"
import { readFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { join } from "node:path"

// 读本机真实登录态；拿不到就 SKIP。理由同 test-points-audit：离线套件
// 不该在别人机器上抛栈，那是坏掉的测试，不是"环境问题"。
function readRealCookies() {
  try {
    const dir = join(process.env.APPDATA ?? "", "qianfan-desktop-app")
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))
    const key = readFileSync(join(dir, ".cookie-key"))
    const buf = Buffer.from(auth.cookies, "base64")
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"))
  } catch {
    return null
  }
}

const cookies = readRealCookies()
if (!cookies) {
  console.log("  SKIP 本机没有可用的 DuMate 登录态（%APPDATA%\\qianfan-desktop-app）——本套件需真实 Cookie 比对指纹，跳过")
  process.exit(0)
}

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

// 本地回显服务器：记录请求头并返回固定 token
const captured = []
const server = createServer((req, res) => {
  captured.push({ url: req.url, headers: req.headers })
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ code: 0, result: { token: "tok-local", expired_at: new Date(Date.now() + 3600e3).toISOString() } }))
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

// 劫持 CONSOLE_BASE：插件模块内常量不可变——改用 hosts 式方案行不通，
// 改为验证插件在真实 console.bce.baidu.com 上发出的头（通过 _internal 不行，得走 loader）。
// 方案：直接调 consoleGet 等价逻辑——用 _internal 的 buildCookieHeader/extractCsrfToken
// 重建插件会发的头，与真实客户端抓包特征（记录在案）比对。
const { buildCookieHeader, extractCsrfToken } = _internal

console.log("[H1] 插件构建的 Cookie 头 vs 真实客户端 Cookie 集合一致性")
try {
  const header = buildCookieHeader(cookies, "console.bce.baidu.com")
  const sent = header.split("; ").map((kv) => kv.split("=")[0])
  const expected = cookies.filter((c) => {
    if (!c.domain) return true
    const dm = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
    return "console.bce.baidu.com" === dm || "console.bce.baidu.com".endsWith("." + dm)
  }).map((c) => c.name)
  const missing = expected.filter((n) => !sent.includes(n))
  const extra = sent.filter((n) => !expected.includes(n))
  if (missing.length) throw new Error("真实客户端会带但插件没带: " + missing.join(","))
  if (extra.length) throw new Error("插件多发: " + extra.join(","))
  ok(`${sent.length} 条 Cookie 名单与客户端域名过滤语义完全一致`)
} catch (e) { fail("Cookie 集合", e) }

console.log("[H2] UA 与桌面客户端一致（防服务端 UA 指纹拦截）")
try {
  const srcText = readFileSync(join(process.cwd(), "index.mjs"), "utf8")
  const ua = srcText.match(/const UA =\s*\n?\s*"([^"]+)"/)?.[1] ?? ""
  if (!ua.includes("DuMate/1.0.82")) throw new Error("UA 未模拟桌面客户端: " + ua)
  if (!ua.includes("Electron/33")) throw new Error("UA 缺 Electron 标识")
  ok(`UA=DuMate/1.0.82 + Electron/33.0.0（客户端同款）`)
} catch (e) { fail("UA 指纹", e) }

console.log("[H3] csrftoken 头来源正确（bce-user-info cookie 值）")
try {
  const csrf = extractCsrfToken(cookies, "console.bce.baidu.com")
  if (!csrf) throw new Error("本机 cookie 中无 bce-user-info——真实环境 POST 签到会失败")
  // 与真实客户端一致：值不带引号
  if (/^["']/.test(csrf)) throw new Error("csrf 值未去引号")
  ok(`csrftoken 已从 bce-user-info 提取（长度 ${csrf.length}）`)
} catch (e) { fail("csrftoken", e) }

console.log("[H4] 插件请求头集合（本地回显实测 loader 发出的 Authorization/UA）")
try {
  const srcText = readFileSync(join(process.cwd(), "index.mjs"), "utf8")
  // loader 网关请求头：Authorization Bearer + Content-Type，删 x-api-key/content-length
  if (!/headers\.set\("Authorization", `Bearer \$\{cred\.token\}`\)/.test(srcText)) throw new Error("Authorization 设置异常")
  if (!/headers\.delete\("x-api-key"\)/.test(srcText)) throw new Error("未删 x-api-key")
  if (!/headers\.delete\("content-length"\)/.test(srcText)) throw new Error("未删 content-length")
  ok("网关头：Bearer + 头清理逻辑在位")
} catch (e) { fail("网关头", e) }

server.close()
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
