# React Bits Micro：WhalePod 应用内源码适配

仅选取 CallChip 和 StatusMark 的 TypeScript/CSS 版本，固定版本与逐文件原始 SHA-256 见 [manifest.json](./manifest.json)。来源为 [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits)，版权属于 David Haz。

## 许可与使用范围

[LICENSE.md](./LICENSE.md) 完整保留上游 **MIT + Commons Clause License Condition v1.0**，这些第三方文件及其改编继续受该许可约束，不改标为 WhalePod 的 Apache-2.0。根 NOTICE 登记此例外。

上游文本允许作为应用、网站或产品的一部分使用、修改与分发，同时限制组件本身的售卖、再许可和再分发（含单独发布、打包和移植版）。此处使用范围是 WhalePod 应用内部呈现，不导出 npm 包或另一套组件库。公开 WhalePod 源码时保留本目录、版权和许可通知；不能仅复制该目录作为独立组件产品。此范围说明记录项目的集成方式，不代表额外获得了维护者授权。

## 本地适配

- StatusMark 保留圆环、虚线、勾与叉的几何和状态结构。Motion 控制改成事实驱动的 CSS；只对在线 running Run 绘制不定进度活动，不接收百分比。新增暂停图形；标签取 WhalePod 完整九态中文表，删除英文重复朗读和完成划线。
- CallChip 保留芯片、底色、图标槽、名称和结果的结构。图标由宿主现有 DSH 图标提供；仅呈现匹配的真实结束事件，不展示工具参数。删去 expectedMs 填充、本地计时器、shake、重试按钮和本地状态回调。
- 所有颜色、圆角、字体、过渡均消费现有语义 token。在线状态环周期沿用上游 1100ms，集中登记为活动 token。减少动态模式彻底停用旋转；无需新增 Motion/Hugeicons 依赖。
- 组件仅负责呈现，状态/事件配对在应用层；不变更 Run、审批或 Task 的业务语义。

## 同步纪律

只比较 manifest 里的固定路径。更新先核对新版本许可，再比较原始哈希与上游差异；保留上述本地适配与验收判据。不整库同步，不覆盖另一个 vendor/dsh-ui 目录。不静默引入 Motion/图标包：新增依赖单独走仓库依赖流程。
