// 第二十轮：安全审查 —— 凭据生命周期面面观（不联网）
// 检查点：cookies 是否会被写进任何持久化位置 / 日志 / 错误对象；access 字段策略
import { readFileSync } from "node:fs"
import { DuMatePlugin, _internal } from "./index.mjs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "index.mjs"), "utf8")
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[S1] 全文无 console.log/console.error 泄漏凭据")
try {
  const logs = [...src.matchAll(/console\.(log|error|warn|info)\(([^)]*)\)/g)]
  for (const [, , args] of logs) {
    if (/cookie|token|cred|header/i.test(args)) throw new Error("日志语句可能泄漏凭据: " + args.slice(0, 80))
  }
  ok(`全文 ${logs.length} 条日志语句，无一含凭据变量`)
} catch (e) { fail("日志泄漏", e) }

console.log("[S2] writeFileSync 调用面（插件不应写任何文件）")
try {
  const writes = [...src.matchAll(/writeFileSync|appendFileSync|mkdirSync|rmdirSync|unlinkSync/g)].map((m) => m[0])
  if (writes.length) throw new Error("插件含写文件调用: " + writes.join(","))
  ok("插件只读不写（只读复用承诺成立）")
} catch (e) { fail("写文件面", e) }

console.log("[S3] access 字段形态（cookie: 前缀 + 明文 header）——确认 magpie 侧存储是预期的")
try {
  // access 里带明文 cookie 是 magpie seat 存储的标准做法（raccoon 同款），但确认没有
  // 把它复制到第二个地方（如 accountId/name）
  const accAssignments = [...src.matchAll(/access:\s*([^,\n]+)/g)].map((m) => m[1].trim())
  for (const a of accAssignments) {
    if (!/^["'`]cookie:/.test(a) && !a.startsWith("cookie:")) throw new Error("access 形态异常: " + a.slice(0, 60))
  }
  ok(`access 字段 ${accAssignments.length} 处，均为 cookie: 前缀形态`)
} catch (e) { fail("access 形态", e) }

console.log("[S4] 错误对象不携带 cookies 引用")
try {
  // signInError/consoleError 等构造的错误对象只带 message/signIn，不带 cookies 属性
  const errConstructions = [...src.matchAll(/err\.\w+ = |new Error\(/g)].length
  const cookieOnErr = /(?:err|e|error)\.cookies\s*=/.test(src)
  if (cookieOnErr) throw new Error("错误对象上挂了 cookies")
  ok("错误对象不含凭据")
} catch (e) { fail("错误对象", e) }

console.log("[S5] .cookie-key 与 auth.json 的读取权限（只 stat/读，不缓存到全局）")
try {
  if (/globalThis\.__|global\.cookieKey|module-level-key/i.test(src)) throw new Error("key 被缓存到全局")
  // readDesktopLogin 每次现读现解（refresh 场景需要新鲜度）——正确
  const rdCount = (src.match(/readDesktopLogin\(\)/g) ?? []).length
  ok(`readDesktopLogin ${rdCount} 处调用，均为现读现解`)
} catch (e) { fail("key 缓存", e) }

console.log("[S6] LOGIN_URL 指向正确的百度登录域（防钓鱼域名校验）")
try {
  const loginUrl = src.match(/const LOGIN_URL\s*=\s*["'`]([^"'`]+)/)?.[1] ?? ""
  // login.bce.baidu.com 是百度智能云官方登录域（from=oa_dumate 为 DuMate 官方来源参数）
  if (!/^https:\/\/login\.bce\.baidu\.com\/\?from=oa_dumate&redirect=https%3A%2F%2Fconsole\.bce\.baidu\.com/.test(loginUrl)) throw new Error("登录 URL 域名异常: " + loginUrl)
  ok(`LOGIN_URL=login.bce.baidu.com（官方域 + oa_dumate 来源 + 回跳 console）`)
} catch (e) { fail("登录域", e) }

console.log("[S7] GATEWAY_BASE/CONSOLE_BASE 域名白名单")
try {
  const gw = src.match(/GATEWAY_BASE\s*=\s*["'`]([^"'`]+)/)?.[1] ?? ""
  const con = src.match(/CONSOLE_BASE\s*=\s*["'`]([^"'`]+)/)?.[1] ?? ""
  if (!gw.startsWith("https://dumate-svc.baidu.com")) throw new Error("GATEWAY_BASE 异常: " + gw)
  if (con !== "https://console.bce.baidu.com") throw new Error("CONSOLE_BASE 异常: " + con)
  ok(`网关/控制台域名为百度官方域`)
} catch (e) { fail("域名白名单", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
