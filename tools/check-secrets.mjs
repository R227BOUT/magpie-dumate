#!/usr/bin/env node
// 发布前脱敏检查：拿本机真实的凭据/身份去比对要提交的文件，
// 而不是靠「我记得删了」或者写死的几个关键词。
//
// 用法：node tools/check-secrets.mjs [--all] [--staged]
//   --staged  只查 git 暂存区（默认）
//   --all     查工作区全部受控文件（git ls-files）
//
// 退出码 1 = 有命中，不许发布。
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join, dirname, relative, extname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

// ── 本机真实凭据/身份，用来比对 ──────────────────────────────────────
// 只读，不打印，不落盘。
//
// 路径不写死：这个仓库是公开的，写死就等于把作者机器的目录结构公布出去。
// 优先用插件自己的探测器（它会按环境变量、常见位置、盘符去找），找不到
// 再退回环境变量和用户目录。
// DuMate 的登录态是加密的（auth.json + .cookie-key），token 不能直接拿来比，
// 所以走插件自己的解密：拿到 accountId、昵称和 cookie 值，这些才是能泄漏的东西。
async function realAuth() {
  try {
    const idx = await import(new URL("../index.mjs", import.meta.url).href)
    const read = idx._internal?.readDesktopLogin
    if (!read) return null
    const d = read()
    if (!d) return null
    const cookies = Array.isArray(d.cookies) ? d.cookies : []
    // 只取够长、能区分人的 cookie 值，短的（如 BAIDUID 之外的小标记）不比对
    const cookieValues = cookies
      .map((c) => String(c?.value || ""))
      .filter((v) => v.length >= 16)
    return {
      token: cookieValues[0] || "",       // 用最长/首个 cookie 当"token"位
      extraSecrets: cookieValues,
      uid: String(d.accountId || ""),
      name: String(d.name || ""),
    }
  } catch {
    return null
  }
}

// ── 结构性模式：不管本机有没有登录，都必须查 ─────────────────────────
const PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "邮箱地址"],
  [/\b[0-9]{3}\*{4}[0-9]{4}\b/g, "掩码手机号"],
  // 任何绝对路径写进源码都值得看一眼：作者机器上的目录不该出现在公开仓库
  [/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"']+/g, "个人目录路径"],
  [/[A-Za-z]:[\\/](?!<)[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]{3,}/g, "绝对路径"],
  [/\/(?:home|Users)\/[a-z0-9_-]+\//gi, "Unix 个人目录"],
  [/\bAg[A-Za-z0-9_-]{20,}\b/g, "疑似妙手 accessToken"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "疑似 JWT"],
  [/\bgh[opusr]_[A-Za-z0-9]{30,}\b/g, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "API key"],
]

// ── 白名单：这些是公开的、必须保留的标识 ─────────────────────────────
const ALLOW = [
  // GitHub noreply 提交邮箱，公开无妨
  "@users.noreply.github.com",
  "R227BOUT@users.noreply.github.com",
  // 文档里的占位
  "you@example.com",
  // 百度登录页自带的跳转参数（index.mjs 的 LOGIN_URL），不是谁的凭据
  "https%3A%2F%2Fconsole.bce.baidu.com%2F",
  "login.bce.baidu.com/?from=oa_dumate",
  // UPLOAD.md 里给读者的路径示例，不是作者机器的真实路径
  "D:\\code\\magpie-plugin-dumate",
  // 测试里故意用的假路径
  "C:/tmp/x.txt",
  "Z:/definitely/not/exist",
]

// 本文件自己枚举候选路径时必然写上这些目录，是扫描器的自指，不是泄漏
const SELF_PATH = join(ROOT, "tools", "check-secrets.mjs")

const TEXT_EXT = new Set([".mjs", ".js", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ""])

function filesToCheck(all) {
  if (all) {
    // 全部受控文件 + 未跟踪但没被 ignore 的新文件。
    // 只用 ls-files 会漏掉「刚创建还没 add」的文件，而新文件恰恰最容易
    // 带着调试用的真实路径或 token 一起提交。
    const run = (args) => {
      try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }) } catch { return "" }
    }
    const tracked = run(["ls-files"]).split("\n")
    const fresh = run(["ls-files", "--others", "--exclude-standard"]).split("\n")
    return [...new Set([...tracked, ...fresh].map((s) => s.trim()).filter(Boolean))]
      .filter((f) => TEXT_EXT.has(extname(f).toLowerCase()))
      .filter((f) => !f.startsWith("node_modules/"))
  }
  let out = ""
  try { out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: ROOT, encoding: "utf8" }) } catch { return [] }
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((f) => TEXT_EXT.has(extname(f).toLowerCase()))
    .filter((f) => !f.startsWith("node_modules/"))
}

function scan(file, text, auth) {
  const hits = []
  const lines = text.split("\n")

  const allowed = (s) => ALLOW.some((a) => s.includes(a))

  // 1) 真实凭据：整串 + 各长度前缀
  if (auth) {
    const needles = []
    if (auth.token) {
      needles.push([auth.token, "完整凭据值"])
      for (const n of [40, 24, 16, 12, 10, 8]) {
        if (auth.token.length >= n) needles.push([auth.token.slice(0, n), `凭据值前 ${n} 位`])
      }
    }
    // 其余 cookie 的整串值（每个都单独比，别只查第一个）
    for (const v of auth.extraSecrets || []) {
      if (v && v !== auth.token) needles.push([v, "cookie 值"])
    }
    if (auth.uid && auth.uid.length >= 5) needles.push([auth.uid, "账号 id"])
    if (auth.name && auth.name.length >= 2) needles.push([auth.name, "账号昵称"])

    for (const [needle, what] of needles) {
      if (!needle || allowed(needle)) continue
      let from = 0
      for (;;) {
        const i = text.indexOf(needle, from)
        if (i < 0) break
        const line = text.slice(0, i).split("\n").length
        hits.push({ file, line, what, sample: `${needle.slice(0, 6)}…(${needle.length} 字)` })
        from = i + 1
        break // 每个 needle 每个文件只报一次
      }
    }
  }

  // 2) 结构性模式
  for (const [re, what] of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const s = m[0]
      if (allowed(s)) continue
      const line = text.slice(0, m.index).split("\n").length
      hits.push({ file, line, what, sample: s.length > 26 ? s.slice(0, 12) + "…" : s })
      if (hits.length > 60) return hits
    }
  }
  return hits
}

// ── 跑 ──────────────────────────────────────────────────────────────
const all = process.argv.includes("--all")
const auth = await realAuth()
const files = filesToCheck(all)

console.log(`脱敏检查 · ${all ? "工作区全部受控文件" : "暂存区"} · ${files.length} 个文件`)
if (auth) {
  console.log(`比对基准：本机登录态（uid 有${auth.uid ? "" : "无"}、昵称有${auth.name ? "" : "无"}、token ${auth.token.length} 字）`)
} else {
  console.log("比对基准：未找到本机登录态，只做结构性模式检查")
}

let total = 0
for (const f of files) {
  const p = join(ROOT, f)
  let text
  try {
    if (!existsSync(p) || statSync(p).size > 4 << 20) continue
    text = readFileSync(p, "utf8")
  } catch { continue }
  // package.json 里内嵌的图标是 base64，不参与扫描（它就是要公开的）
  let scanText = text
  if (f.endsWith("package.json")) {
    scanText = text.replace(/"icon"\s*:\s*"data:image\/[^"]*"/g, '"icon":"<inline-image>"')
  }
  const hits = scan(f, scanText, auth)
  // 扫描器本身在枚举候选路径时会写上那些目录，别报自己
  const selfFile = join(ROOT, f) === SELF_PATH
  for (const h of hits) {
    if (selfFile && h.what === "作者机器专属路径") continue
    console.log(`  ✗ ${h.file}:${h.line}  ${h.what}  ${h.sample}`)
    total++
  }
}

if (total) {
  console.error(`\n发现 ${total} 处疑似泄漏，不要发布。确认是误报的话，加进 ALLOW。`)
  process.exit(1)
}
console.log("\n干净：没有本机凭据、个人路径、邮箱或密钥泄漏。")
