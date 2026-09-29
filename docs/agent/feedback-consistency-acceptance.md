# 操作反馈一致性（前端交互批次③）验收

- 对应场景/门禁：Q1（unit + web project）
- 对应 Issue：#229
- 上次验证：2026-09-30 · `feat/p1-229-feedback-consistency` · 结果 PASS

## 验的是哪条用户路径

1. 任务房间责任人做「提交验收/完成任务/取消任务」这类不可逆动作时的确认体验；
2. 用户在插件页安装、在交付物区下载后的成败反馈；
3. 键盘用户在两个 composer 发送、在窄屏导航面板里退出的路径。

## 交付内容

| # | 交付 | 落点 |
|---|---|---|
| 1 | **ConfirmDialog**：vendored Modal（headless）封装，替换 TaskHeader 三处 `window.confirm`。焦点管理照 RunConsole 口径：打开聚焦确认钮、卸载还焦触发钮、Tab 循环留在对话框内（fireEvent 直测）、Esc/遮罩=取消、危险行动（取消任务）用 danger 样式、pending 防重复 | `shared/ConfirmDialog.tsx` + `TaskHeader.tsx` |
| 2 | **toast 通道**：模块级 store + body portal；`role=status` + aria-live=polite、4s 自动消退、上限 3 条。接入 ArtifactList 下载失败反馈 | `app/toast.tsx` + `session.tsx`（ToastHost）+ `ArtifactList.tsx` |
| 3 | **Cmd/Ctrl+Enter 发送**：CommentComposer 与 InstructionComposer 的 textarea（`requestSubmit`——与按钮同一条 form 路径）；纯 Enter 仍是换行 | 两 composer 的 onKeyDown |
| 4 | **Esc 关窄屏导航**：details 浮层打开时 Esc 收起并还焦菜单钮 | `session.tsx` |

### 取舍（与 Issue 判据的偏差，如实记录）

- **PluginSettings / PluginPackEditor 的 notice 保留原样**：两者文案含「只对之后新建的
  Revision 生效」「去 Agent 管理新建 Revision（链接）」的教育与行动语义，常驻比 4 秒
  消失更负责任。toast 的定位收敛为「短暂事实」（如下载失败/成功这类可重试动作），
  不吞需要阅读的内容。
- **InstructionComposer 的 outcome 段落保留常驻**：它是执行流状态回看（「我那句话怎么了」），
  与 rejected 的理由展示同源，不是瞬时通知。
- **焦点陷阱判据用 fireEvent.keyDown 而非 userEvent Tab**：userEvent 的 Tab 焦点导航
  在全量运行下时序不稳定（单跑绿、全量挂），而判据要回答的是「循环回到 first」，
  不是浏览器 Tab 导航本身。

### 实现过程中抓住的问题

- 一次 `git checkout` 与 untracked 新文件混在同条命令里整条失败，导致组件半新半旧
  （PluginSettings 引用被摘掉的 ToastHost）→ 用例崩溃为 `setNotice is not defined`
  的 unhandled error，表面上像「alert 不渲染」。教训：revert 与新增文件分开操作。
- Modal 的判别联合（`headless: true` 分支不收 `closeLabel`）由 Q0 typecheck 抓住。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project web apps/web/tests/feedback-consistency.spec.tsx apps/web/tests/comment.spec.tsx apps/web/tests/instruction-composer.spec.tsx
```

## 判定（可证伪断言）

- ConfirmDialog：dialog 带 aria-modal；打开即聚焦、Esc 触发 onCancel、关闭还焦触发钮；
  Tab 在 last→first、Shift+Tab 在 first→last；TaskHeader 行动不再调 `window.confirm`
  （spy 断言零调用），取消不发 POST、确认发 POST。
- toast：pushToast 渲染 role=status、4.1s（fake timers）后消失；第 4 条挤掉第 1 条。
- Cmd+Enter：纯 Enter 后零请求；Meta/Ctrl+Enter 后恰好 1 个 POST 且载荷含换行内容。
- Esc 导航：窄屏（stub matchMedia）details 打开 → Esc → open=false 且焦点回 summary。

## 边界与未覆盖

- ConfirmDialog 的真实浏览器焦点环/遮罩模糊效果未在 e2e 验证（本地 Docker 不可用）。
- toast 的视觉（阴影/堆叠位置）走 token，未挂对比度门新对（白底黑字沿用 ink/surface 已覆盖组合）。
- 多对话框叠加（ConfirmDialog 与 RunConsole 并存）不存在于当前流程，未测。

## 复跑

```bash
pnpm check   # Q0+Q1 全量（1292 用例，含本批 9 条新增）
```
