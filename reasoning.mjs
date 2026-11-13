// Keep magpie's shared reasoning levels while sending DuMate's own switches.
// Contributed by RanceLee (公众号 HelloRanceLee, 2026-11-13).
//
// DuMate only understands "thinking on/off" for deepseek-v41-flash; "low" and
// "high" resolve to the same upstream strength. The four UI levels are kept so
// switching providers does not lose the selection, but this does NOT claim the
// upstream offers four distinct reasoning budgets.
export function normalizeReasoningBody(body) {
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
  else return body
  let request
  try { request = JSON.parse(text) } catch { return body }
  if (request?.model !== "deepseek-v41-flash" || !["none", "low", "high", "max"].includes(request.reasoning_effort)) return body

  const enabled = request.reasoning_effort !== "none"
  if (!enabled) delete request.reasoning_effort
  else if (request.reasoning_effort === "low") request.reasoning_effort = "high"
  // An explicit effort wins over conflicting switches left by an SDK/variant.
  request.thinking = { ...request.thinking, type: enabled ? "enabled" : "disabled" }
  request.enable_thinking = enabled
  return JSON.stringify(request)
}
