# 设备准备返回任务验收（#338）

## 用户路径与规则

任务准备区的安装/设备链接只携不透明Task身份进入设备页。只有当前登录壳确实访问过该Task时，设备页才呈现“返回任务继续准备”；复制链接、外部地址和别的页面会话不会制造本地草稿上下文。返回固定站内任务路径与task-execution锚点，不接受任意return URL，不放正文/环境/凭据进URL或history state。

返回恢复编辑意图并聚焦实际执行区，但首次重新挂载必读当前任务、授权、来源、Agent/固定Revision，以及责任人本人的Device/Workspace。成功旧缓存先显示确认中，不能靠旧值解锁发送；读取失败不说成无权。权限撤销、归档或离线会保留正文和显式选择并阻塞，不换目标或静默开新执行。授予指令权不让协作者读取责任人的私有现场。

草稿存储不包含Node准备结果或full_access确认。返回不会自动发指令、重新探查Node、填试运行或调用模型；原准备结果立即不再作为当前确认。常规启动仍走既有server preflight，不把手工准备检查升级为新的授权或强制业务阶段。

## 机器判据

execution-composer.spec.tsx用真实Router/会话壳/QueryClient，公开HTTP边界模拟新事实；检查href、真实焦点、原正文/版本/来源与目标、禁用及错误/无权状态、请求数量。先红七条回归后实现。补充未知参数/跨会话不建立上下文、缓存授权延迟确认、网络错误重试、来源归档与任务读取恢复。首次任务/授权/配置/环境确认期间不得发送，后台正常刷新不覆盖用户意图。

## 六原语与复跑

驱动pnpm exec vitest run --project web apps/web/tests/execution-composer.spec.tsx；Q0 pnpm check。生产主链与第五批组合Q5见#339；不直写运行投影，不用截图判断权限或受理。web.route看参数/锚点，web.execution看会话与mode/source/owner，web.query看首次缓存重读，hub命令仍是最终授权与环境守卫。

脱敏证据入artifacts/evidence/operation-flow-batch5/return；出包secret-scan。模型真实网络、额度与真人理解效果仍未测。原#312在途代码不纳入。

## 云端负载下的同帧检查

#341首次云端check暴露既有crossfade.spec的真实时间竞争：内容查询返回后，繁忙调度可能已用尽短退场窗口，断言再看骨架就太迟。测试现在只控制setTimeout/clearTimeout，在数据放行后先断言内容与退场骨架共存，再推进计时断言卸载；不改生产动画时长，不删除判据。项目页同族检查也使用同一策略。原失败和修复后的完整Q0/CI均保留在return证据包。
