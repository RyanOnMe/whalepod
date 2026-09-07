/**
 * 口令强度政策（#106）。政策本体是纯函数、放域层（判定 SSoT）；
 * HTTP 归因（400 + VALIDATION_FAILED）由 hub 路由层负责——domain 不知道传输。
 *
 * 界值 12 码点：对齐密码管理器的现实下限（02 Task 5 未定数，#106 定案后写回
 * 03 §4 校验表）。计数单位是 **Unicode 码点**（Array.from），UTF-16 代理对
 * 不被劈半计数——emoji 口令的 11 字符 ≠ 22 code unit 的假通过。
 *
 * 只管**建账路径**（setup），登录不查（历史弱口令不被政策锁死门外；Alpha
 * 无存量，规则立在零）。协议层 PasswordSchema=min(1) 保持：它描述传输形状，
 * 政策在域层判，两层各管各的。
 */
export const PASSWORD_MIN_CODEPOINTS = 12

export function isPasswordAcceptable(password: string): boolean {
  return [...password].length >= PASSWORD_MIN_CODEPOINTS
}
