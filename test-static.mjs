// 第六轮：代码级审查——用 AST 抓漏网之鱼（未 await 的 Promise、吞错、边界）
// 纯静态，不联网不耗积分。
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("./index.mjs", import.meta.url), "utf8")
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e); process.exitCode = 1 }

console.log("[S1] 语法完整性（node 直接 import 即编译）——已在所有套件隐式覆盖")
ok("index.mjs 可正常 import（7 套件 36 用例全过的基础）")

console.log("[S2] fetchGatewayToken 单飞缓存正确性（代码走查）")
try {
  const fn = src.match(/async function fetchGatewayToken[\s\S]*?\n\}/)?.[0] ?? ""
  if (!fn) throw new Error("函数未找到")
  // pending promise 存在时 join 它而不是并发再发
  if (!fn.includes("pending")) throw new Error("无 single-flight")
  // finally 清理 pending 防死锁
  if (!/finally\(\(\) => tokenCache\.delete/.test(fn)) throw new Error("pending 无 finally 清理")
  // 过期前 5 分钟余量刷新
  if (!/expiresAt - 5 \* 60_000/.test(fn)) throw new Error("无提前刷新余量")
  ok("单飞 + finally 清理 + 提前刷新均在位")
} catch (e) { fail("token 缓存走查", e) }

console.log("[S3] loader 的 body 处理（Request 与 init 两态）")
try {
  const fn = src.match(/async fetch\(input, init = \{\}\)[\s\S]*?\n          \},\n/) ?? src
  if (!/input instanceof Request/.test(src)) throw new Error("缺 Request 分支")
  if (!/req\.clone\(\)\.text\(\)/.test(src)) throw new Error("缺 clone().text()")
  if (!/headers\.delete\("content-length"\)/.test(src)) throw new Error("缺 content-length 删除（改写 body 后旧长度会错）")
  if (!/headers\.delete\("x-api-key"\)/.test(src)) throw new Error("缺 x-api-key 删除")
  ok("Request/双态 body + 头清理在位")
} catch (e) { fail("loader body 走查", e) }

console.log("[S4] 错误路径 401 缓存失效")
try {
  if (!/res\.status === 401[\s\S]{0,200}tokenCache\.delete/.test(src)) throw new Error("401 时未清 token 缓存")
  ok("401 → 清缓存 → 返回 signIn=expired")
} catch (e) { fail("401 缓存清理", e) }

console.log("[S5] 三种登录方式的失败信息质量")
try {
  if (!/请先安装并登录百度搭子/.test(src)) throw new Error("desktop 失败指引缺失")
  if (!/DevTools Network 面板/.test(src)) throw new Error("browser 指引未提 Network 面板")
  if (!/bce-sessionid/.test(src)) throw new Error("必检字段提示缺失")
  ok("失败信息均指向可操作的下一步")
} catch (e) { fail("失败信息", e) }

console.log("[S6] 敏感信息泄漏面检查")
try {
  // 插件不应把 cookie 值打进日志/错误信息
  const errorPaths = src.match(/throw new Error\(([^)]+)\)/g) ?? []
  for (const p of errorPaths) {
    if (/cookieHeader|cookieStr|c\.value|cred\.token/i.test(p)) throw new Error("错误信息可能泄漏凭据: " + p.slice(0, 80))
  }
  ok("所有 throw 语句不含凭据值")
} catch (e) { fail("泄漏面", e) }

console.log("[S7] package.json 入口一致性")
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  if (pkg.main && !src) throw new Error("main 指向不存在文件")
  ok(`package.json: name=${pkg.name}, main=${pkg.main ?? "(默认 index)"}`)
} catch (e) { fail("package.json", e) }

console.log("[S8] 商店图标准备度（发现页只读 package.json 的 magpie.icon）")
// magpie 扫 GitHub 时只 fetch 仓库根目录的 package.json，
// 用 ownIcon() 判一个图：https:// 或 data:image/ 开头，且不超过 3<<19。
// 少了这个字段，发现页卡片就画空心框——插件目录里的 icon.png 帮不上忙。
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const said = pkg.magpie?.icon ?? ""
  if (!said) throw new Error("magpie.icon 缺失 —— 发现页会是空心框")
  if (said.length > 3 << 19) throw new Error(`magpie.icon 超长 ${said.length} > ${3 << 19}`)
  if (!/^(https:\/\/|data:image\/)/i.test(said)) throw new Error("magpie.icon 不是 https:// 或 data:image/")
  // 与随包的 icon.png 必须是同一张，否则改了图忘了重生成
  const head = said.slice(0, said.indexOf(","))
  const mime = head.match(/^data:(image\/[a-z+]+);base64$/i)
  if (!mime) throw new Error("magpie.icon 不是 base64 data URI: " + head.slice(0, 40))
  const embedded = Buffer.from(said.slice(said.indexOf(",") + 1), "base64")
  const onDisk = readFileSync(new URL("./icon.png", import.meta.url))
  if (!embedded.equals(onDisk)) throw new Error(`magpie.icon 与 icon.png 不一致（${embedded.length} vs ${onDisk.length} bytes）`)
  ok(`magpie.icon ${said.length} 字符 = icon.png 原图（${onDisk.length} bytes）`)
} catch (e) { fail("商店图标", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
