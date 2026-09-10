/**
 * **本仓新增代码，非上游代码**：WhalePod 自有实现，许可为 Apache-2.0（见仓库根 LICENSE），
 * 不在 vendored 副本的许可范围内——Cherry-pick / 同步上游时不要把它当成上游文件；
 * 从上游再取原语时，只替换那几个组件的 `.tsx`/`.module.css` 与 `manifest.json` 对应条目。
 *
 * 它替代的是上游 6 个原语里用到的 clsx（上游每个组件都从该包 import clsx）；
 * 本仓不引入这个依赖（vendored 是复制不是依赖，见 vendor/dsh-ui/README.md），用一个
 * 10 行的等价物顶替。上游调用点只用到「字符串 + falsy 跳过」这一档子集（没有对象/数组
 * 入参），所以这里不实现 clsx 的完整入参形态。
 */

/** 拼接类名：跳过 false/null/undefined/空串，其余按顺序以单空格连接。 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}
