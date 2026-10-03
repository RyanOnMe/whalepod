/**
 * JS 与 CSS 的交界（#273）：退场动画的时长必须**两端一致**。
 *
 * 卸载是 JS 的事（`usePresence` 的计时器），退场是 CSS 的事（`transition` 的时长）。
 * 两边各写一个数字就会出现"动画还没演完就被摘掉"（或反过来：演完了还挂在 DOM 里）——
 * 那正是这一刀要修的毛病，不能自己再造一个。
 *
 * 所以：**CSS 侧只有 `--duration-base` 一处取值**（`styles/tokens.css`），JS 侧只有这里
 * 一处常量，并且有判据钉住两者相等（`apps/web/tests/presence.spec.tsx` 读 `tokens.css`
 * 现场解析，不硬编码 160）。
 */
export const EXIT_PRESENCE_MS = 160
