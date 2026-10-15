# 首页个人行动入口验收

- Issue #332；关联#274；P1-07/Q0/Q5。
- 2026-10-15：新页面与事件回归先红后绿，最终结果见artifacts/evidence/operation-flow-batch4/home-entry。

## 用户路径与驱动

首页“需要我处理”读取服务端个人投影；一跳到任务内指派、审批、候选或真人完成区域，键盘焦点落在实际区域。列表读取和导航不接受/批准/发布/完成。异步审批卡到达后再聚焦；必要的details自动展开。未知、非法或错误响应不显示成空态或旧可处理列表。

## 观测与判定

Web真实Router/QueryClient/HTTP边界用例attention-home.spec.tsx：明确pending/error/empty/hasMore、只读、五类动作锚点、异步审批、回到已缓存首页刷新、真事件路由刷新、私有字段严格拒绝、后台更新保留焦点。event-router.spec.ts保留全部键/游标判据，新增个人队列和最近任务接线；流式run.event不触发个人重读。

个人缓存键含userId；每次进入首页重新读，成功mutation失效个人队列与最近任务。Task/Run/Approval/Artifact/Member/Project事件刷新对应读模型；重连沿既有全量失效。候选创建无全员广播，首页可见时15秒轮询与切回窗口补偿。普通后台刷新保留列表/焦点，首次缓存读取先确认，读取错误撤下旧链接并提供重试。

生产浏览器链路在#333的双用户attention验收中补机器事实；P1-19共享装配变动时全量Q5。读取层不授予命令权限，实际动作仍走既有鉴权/确认。环境阻塞不在本投影中，真人可用性仍待试用。

## 复跑、归因与取证

pnpm check；pnpm build；pnpm exec playwright test --config playwright.operations.config.ts --project p1-07。组合生产场景及全量结果见attention-trial-acceptance。

旧项看hub.task响应和web.query失效/重连；定位失败看目标对象/锚点/异步卡事件到达；候选隐私看本人投影，不以截图判定。脱敏日志入artifacts/evidence/operation-flow-batch4/home-entry，出包secret-scan。
