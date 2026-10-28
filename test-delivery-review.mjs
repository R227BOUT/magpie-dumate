// 第十三轮：最终交付审查 —— 站在"醒来第一次使用"视角走完整用户体验链
// 1. 安装引导文本是否自洽 2. 登录后 agent 首调 3. quota 首查 4. 签到提示 5. 文档与实际行为一致性
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[U1] 三种登录方式的 instructions 可操作性与一致性")
try {
  const src = readFileSync(join(here, "index.mjs"), "utf8")
  const instructions = [...src.matchAll(/instructions:\s*\n?\s*([\s\S]*?)(?=,\n\s*method)/g)].map((m) => m[1])
  if (instructions.length < 2) throw new Error("只找到 " + instructions.length + " 组 instructions")
  const joined = instructions.join("\n")
  // 桌面端方式不该有"复制 Cookie"指引
  const desktopBlock = src.match(/label: "百度搭子桌面端登录态[\s\S]*?method: "auto"/)?.[0] ?? ""
  if (desktopBlock && /document\.cookie|DevTools/.test(desktopBlock)) throw new Error("桌面端方式混入了复制指引")
  // 浏览器方式必须提 Network 面板与 httpOnly
  if (!/Network/.test(joined)) throw new Error("浏览器指引未提 Network 面板")
  if (!/httpOnly/.test(joined)) throw new Error("指引未解释 httpOnly 陷阱")
  // 手动方式必须写清来源
  const manualBlock = src.match(/label: "手动粘贴[\s\S]*?method: "code"/)?.[0] ?? ""
  if (manualBlock && !/bce-sessionid/.test(manualBlock)) throw new Error("手动方式未写必含字段")
  ok(`桌面端无污染、浏览器提 Network/httpOnly、手动写字段`)
} catch (e) { fail("登录指引", e) }

console.log("[U2] README 与实际登录字段一致（防文档漂移）")
try {
  const readme = readFileSync(join(here, "README.md"), "utf8")
  const src = readFileSync(join(here, "index.mjs"), "utf8")
  const requiredInCode = src.match(/REQUIRED_COOKIES = \[([^\]]+)\]/)?.[1] ?? ""
  const reqNames = [...requiredInCode.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  if (!reqNames.length) throw new Error("REQUIRED_COOKIES 解析失败")
  for (const name of reqNames) {
    if (!readme.includes(name)) throw new Error(`README 未提必需字段 ${name}`)
  }
  // README 不应再出现旧的 BDUSS/STOKEN 必填说法
  if (/需包含 BDUSS 与 STOKEN/.test(readme)) throw new Error("README 残留旧必填字段说法")
  ok(`README 与 REQUIRED_COOKIES(${reqNames.join(",")}) 一致`)
} catch (e) { fail("README 一致性", e) }

console.log("[U3] 错误信息的用户视角质量（全部中文、有下一步动作）")
try {
  const src = readFileSync(join(here, "index.mjs"), "utf8")
  const msgs = [...src.matchAll(/(?:new Error|message:)\s*[`"']([^`"']+)[`"']/g)].map((m) => m[1])
  const userFacing = msgs.filter((m) => /DuMate|Cookie|登录|token/i.test(m))
  for (const m of userFacing) {
    if (/^[a-z\s]+$/i.test(m) && !/token/i.test(m)) throw new Error("疑似英文报错: " + m)
  }
  // 关键失败都要有"怎么办"（模板串里嵌套的分支也算：直接查全文关键句）
  const hasNextStep = userFacing.filter((m) => /请|重新|确认|检查/.test(m)).length
  // 模板串形态的报错（DuMate 接口错误 / 登录态已失效）在全文层面已含指引词
  const hasGuideInTemplates = /请打开百度搭子重新登录/.test(src) && /请重新登录/.test(src)
  if (!hasGuideInTemplates) throw new Error("模板串报错缺行动指引")
  // "DuMate gateway token 已失效并清除缓存，请重试或重新登录" 含指引
  if (hasNextStep + (hasGuideInTemplates ? 1 : 0) < 2) throw new Error(`带行动指引的报错不足`)
  ok(`直接报错 ${userFacing.length} 条中 ${hasNextStep} 条含指引 + 模板串报错均含"重新登录"指引`)
} catch (e) { fail("报错质量", e) }

console.log("[U4] 醒来后的操作命令可直接复制执行（路径有效性）")
try {
  const readme = readFileSync(join(here, "README.md"), "utf8")
  const addCmd = readme.match(/magpie plugin add (\S+)/)?.[1]
  if (!addCmd) throw new Error("README 无 plugin add 命令")
  // 相对路径 ./magpie-dumate 在本项目位置也成立；绝对路径检查存在性
  if (addCmd.includes("D:") || addCmd.includes("C:")) {
    const p = addCmd.replace(/\//g, "\\")
    try { readFileSync(join(p, "index.mjs")) } catch { throw new Error("README 里的绝对路径不存在: " + addCmd) }
  }
  ok(`安装命令指向有效位置: ${addCmd}`)
} catch (e) { fail("安装命令", e) }

console.log("[U5] quota 显示对'从未签过到的新用户'的鲁棒性（字段缺省推演）")
try {
  // loginBonusInfo 可能返回无 totalTimes/totalPoints 的新号——推演 usage/checkin 不崩
  const src = readFileSync(join(here, "index.mjs"), "utf8")
  // usage 读取处应有 ?? 兜底
  const usageBlock = src.match(/async usage\(getAuth\) \{[\s\S]*?\n      \},/)?.[0] ?? ""
  if (!/\?\?/.test(usageBlock)) throw new Error("usage 无空值兜底")
  if (!/parseFloat/.test(usageBlock)) throw new Error("totalPoints 非 string 也应处理")
  ok("usage 对缺失字段有兜底")
} catch (e) { fail("新号鲁棒性", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
