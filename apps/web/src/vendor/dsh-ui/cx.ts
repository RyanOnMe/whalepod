/**
 * **本仓新增代码，非上游代码**：WhalePod 自有实现，许可为 Apache-2.0（见仓库根 LICENSE），
 * 不在 vendored 副本的许可范围内——Cherry-pick / 同步上游时不要把它当成上游文件；
 * 从上游再取原语时，只替换那几个组件的 `.tsx`/`.module.css` 与 `manifest.json` 对应条目。
 *
 * 它替代的是上游原语里用到的 clsx（上游每个组件都从该包 import clsx）；
 * 本仓不引入这个依赖（vendored 是复制不是依赖，见 vendor/dsh-ui/README.md），用一个
 * 小等价物顶替。入参形态按**本仓已 vendored 组件的实际调用**取子集，不是 clsx 全实现：
 *   - 字符串：直接拼接；
 *   - falsy（false/null/undefined/0/''）：跳过；
 *   - 对象：键名在值为真时拼接（ConnectionIndicator 用了 `{ [css.secondDot]: true }` 这一形态）。
 * clsx 还支持嵌套数组与数字入参，本仓没有调用点，故不实现——若将来取用的上游组件用了，
 * 在这里补而不是在组件里改写调用点。
 */

/** 对象入参：键为类名，值为真时拼接。 */
type CxObject = Readonly<Record<string, boolean | null | undefined>>

/** 拼接类名：跳过 false/null/undefined/空串，其余按顺序以单空格连接。 */
export function cx(...parts: readonly (string | false | null | undefined | CxObject)[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part !== '') out.push(part)
      continue
    }
    if (part === null || part === undefined || part === false) continue
    for (const key of Object.keys(part)) {
      if (part[key] === true && key !== '') out.push(key)
    }
  }
  return out.join(' ')
}
