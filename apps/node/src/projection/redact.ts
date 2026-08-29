/**
 * 脱敏库（03 §9 八条规则；04 §6.4 固定语料为判据）。
 *
 * 纪律：Node 在任何内容离开设备前执行（§9 首句）——projector 产出的每一行
 * owner/project 事件与每一条 live delta 都必须先过本模块。脱敏是「原文不可
 * 逆消失」，不是打码展示：Q7 判据是原文不得出现在 Hub DB、Browser frame、
 * 日志与 evidence 包。
 *
 * 规则落点：
 * 1/2 路径替换（workspace/home）与 4/8 字符串模式在 redactString；
 * 3 键名删除与递归在 redactValue；5（preview 字节上限）在 projector 的
 * preview 构造器（per-item 2048 / 总量 8192）；6/7 是工具级 preview 策略，
 * 同样归 projector——本模块提供它们共用的原语。
 */

/**
 * 脱敏上下文：canonical Workspace 根（调用方已 realpath）、home 目录、Node
 * 状态目录（`--state-dir`，runtime-home/plugin-packs/plugin-store 等 Run 产物的
 * 根）与插件 packs 根（通常 `<stateDir>/plugin-packs`）。
 *
 * workspace/home 是 03 §9 规则 1/2；stateDir/packsRoot 是 P1-17 的扩展替换项——
 * 自定义 `--state-dir` 落在 home 之外时，pack overlay 绝对路径（经 Runtime
 * boot 错误进 runtime.fatal summary）会越过 home 替换项泄漏进团队投影，
 * 红线（绝对路径不进团队投影）要求同一机制兜住。'' = 未配置，跳过该项。
 */
export interface RedactionContext {
  readonly workspaceRoot: string
  readonly homeDir: string
  readonly stateDir: string
  readonly packsRoot: string
}

/** 路径替换项（§9 规则 1/2 + P1-17 扩展）；按前缀长度降序替换。 */
const PATH_MARKERS: ReadonlyArray<readonly [keyof RedactionContext, string]> = [
  ['workspaceRoot', '<workspace>'],
  ['homeDir', '<home>'],
  ['stateDir', '<state-dir>'],
  ['packsRoot', '<packs-root>'],
]

/** §9 规则 3：键名匹配即删除值（值替换为固定标记，保留结构形状）。 */
const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie)/i

/** §9 规则 4：Bearer 值。保留 `Bearer` 字样（认证方案不是秘密），删除值。 */
const BEARER_VALUE = /\b(Bearer)\s+\S+/gi

/** §9 规则 4：私钥块（含正文）与孤立的头/尾行。 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const PRIVATE_KEY_LINE = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g

/** §9 规则 4：npm token 格式（与 scripts/secret-scan.sh 同模式）。 */
const NPM_TOKEN = /npm_[A-Za-z0-9_]{8,}/g

/**
 * §9 规则 4 扩展：env 风格敏感赋值（`DEEPSEEK_API_KEY=sk-…` / `MY_TOKEN: …`）。
 * 键必须全大写蛇形（无 i 标志）——HTTP 头风格（`Authorization: Bearer …`）
 * 由 BEARER_VALUE 处理，避免把「Bearer」字样当值吞掉。
 */
const ENV_SENSITIVE_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)\S+/g

/** §9 规则 8：URL 收缩（query/fragment 删除，path 截断 120 字符）。 */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi

const REDACTED = '<redacted>'
const URL_PATH_MAX = 120

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const path =
      url.pathname.length > URL_PATH_MAX ? url.pathname.slice(0, URL_PATH_MAX) : url.pathname
    // port 已含在 host 里；query（search）与 fragment（hash）不带走。
    return `${url.protocol}//${url.host}${path}`
  } catch {
    // 非法 URL：截断到第一个 ?/# 之前，宁缺毋滥。
    const cut = raw.search(/[?#]/)
    return cut === -1 ? raw : raw.slice(0, cut)
  }
}

/** 字符串级脱敏：§9 规则 1/2/4/8（+ P1-17 stateDir/packsRoot 扩展替换）。 */
export function redactString(input: string, ctx: RedactionContext): string {
  let out = input
  // 路径替换（规则 1/2 + 扩展）：四个前缀任意两者都可能互相嵌套（Workspace 常在
  // home 之下；stateDir 默认也在 home 之下，自定义 --state-dir 可能在之外；
  // packsRoot 在 stateDir 之下）。统一按前缀长度降序替换——先吃掉更长前缀，
  // 短前缀再替换时不会从已替换的标记里咬出错位（<…> 标记不含任何前缀原文）。
  const prefixes = PATH_MARKERS.map(([key, marker]) => [ctx[key], marker] as const)
  for (const [prefix, marker] of prefixes
    .filter(([prefix]) => prefix !== '')
    .sort((a, b) => b[0].length - a[0].length)) {
    out = out.replaceAll(prefix, marker)
  }
  out = out.replace(PRIVATE_KEY_BLOCK, '<redacted-private-key>')
  out = out.replace(PRIVATE_KEY_LINE, '<redacted-private-key>')
  out = out.replace(BEARER_VALUE, `$1 ${REDACTED}`)
  out = out.replace(NPM_TOKEN, REDACTED)
  out = out.replace(ENV_SENSITIVE_ASSIGNMENT, `$1${REDACTED}`)
  out = out.replace(URL_PATTERN, (match) => sanitizeUrl(match))
  return out
}

/**
 * 值级脱敏（§9 规则 3）：递归遍历 JSON 值；对象键名命中敏感模式的值替换为
 * 固定标记；字符串值过 redactString。输出保持 JSON 可序列化。
 */
export function redactValue(input: unknown, ctx: RedactionContext): unknown {
  if (typeof input === 'string') return redactString(input, ctx)
  if (Array.isArray(input)) return input.map((item) => redactValue(item, ctx))
  if (typeof input === 'object' && input !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, ctx)
    }
    return out
  }
  return input
}
