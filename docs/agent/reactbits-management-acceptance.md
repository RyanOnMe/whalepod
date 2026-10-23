# 管理页 ReactBits 精修验收（P1-432）

## 路径与设计

成员、插件、Agents 与设备是团队的配置入口。本轮新增 Data Table 5、Integrations 1、Card 2、Monitoring 7 四项已登录网页来源，适配六个展示槽；现有包共二十项来源、二十四个导出。

| Before | After | Why |
| --- | --- | --- |
| 成员姓名、用户名、角色平铺，邀请表单常驻 | 头像/身份/角色目录；页头显式展开邀请，折叠保留角色与生成结果 | 名单优先，邀请按需处理 |
| 插件目录与安装信息堆叠、多层卡框 | 单一集成卡轮廓；身份、安装动作、审核与能力分区 | 重点清楚，安全声明仍可见 |
| Agent 列表缺少选择线索，详情只能点原卡收起 | 图标/说明/选择反馈；详情显式关闭并回焦原卡 | 详情路径清晰，键盘可恢复 |
| 未生成时也显示配对空面板，设备事实缺少层级 | 唯一页头签发入口；设备身份/平台/状态/最后在线分组，指南按需展开 | 先看可用设备，需要时再配对 |

仅展示与控件布局变化。HTTP、权限、邀请有效期/复制、插件审核与 Pack 禁选、Agent 表单、配对过期/错误逻辑均由宿主持有。无虚假成员管理、连接开关、利用率、CPU/内存/磁盘图表或演示计时器。
私有适配及摘录仅保存在忽略的 `artifacts/private-ui/collectui/`；公开为 minify 的 JS/CSS、声明、许可与来源/输入/资产摘要。沿用此前授权，不宣称加密或不可逆；无新运行依赖。

## 驱动与判定

```bash
pnpm build # 新工作区首次建立真实包产物
pnpm check
pnpm exec playwright test --config=playwright.management.config.ts
node --import tsx scripts/verify-management-evidence.mts artifacts/evidence/management-pages/<本轮目录>
pnpm exec playwright test --config=playwright.operations.config.ts --project=p1-141
pnpm exec playwright test --config=playwright.operations.config.ts --project=p1-142
pnpm exec playwright test --config=playwright.operations.config.ts --project=p1-158
```

管理页生产驱动 `management-pages.spec.ts` 走真实 Setup、邀请注册、插件安装与组合、Agent 创建、Node 配对；不插业务表、不造投影。复用已有隔离装配（Web 5313 / Hub 18183），不抢真人预览与其他工作区端口。
`web.management` 记录 1440/390/320 的四页几何、内容溢出、控件及权限事实。只读检查段必须零 POST；邀请与配对复制、Member 禁写、详情关闭回焦、Revision 预填、邀请折叠保留、唯一配对入口和减少动态效果均有断言。

独立判定器 `scripts/lib/management-evidence.ts` 检查十二档布局，缺数据、缺视图、越权、意外写入、横向溢出、内容裁切、错误焦点或动效规则均失败。负控逐项破坏事实验证能红。总入口同时核对二十二张截图；生成的邀请链接不入截图，配对码遮罩。
组件层覆盖邀请/配对失败、复制拒绝、码过期撤下、停用成员、插件审核/能力警示、不可入 Pack 的安装、Agent 请求体与版本；更新存量键盘检查，先按键展开邀请，再验证 Tab/Enter/Space/Esc 路径。

## 证据、归因与复跑

证据为 `artifacts/evidence/management-pages/<本轮目录>/facts.json` 与 `management-*.png`。截图仅视觉复核，判定必须读取事实。日志/证据扫描后保留，不保存 Cookie、口令、邀请 token、原始组件源码或网络 trace。
几何/焦点/折叠问题先看 `web.management`；写入与权限再看 hub.http / hub.domain；设备配对问题对照 node.gateway。来源或资产异常先查 vendor/collectui/manifest.json；授权维护者用现有编译入口重建。

## 本轮结果

红测提交 `c9c00d4`；实测结果、审批及最终 CI 在合入前补齐。浏览器验证范围为 Chrome。
