# React Bits Micro：WhalePod 应用内源码适配

仅选取 CallChip、StatusMark、ThoughtLine、RubberSegment、WarmTooltip、BellToggle 和 SwipeToast 的 TypeScript/CSS 版本，固定版本与逐文件原始 SHA-256 见 [manifest.json](./manifest.json)。来源为 [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits)，版权属于 David Haz。

## 许可与使用范围

[LICENSE.md](./LICENSE.md) 完整保留上游 **MIT + Commons Clause License Condition v1.0**，这些第三方文件及其改编继续受该许可约束，不改标为 WhalePod 的 Apache-2.0。根 NOTICE 登记此例外。

上游文本允许作为应用、网站或产品的一部分使用、修改与分发，同时限制组件本身的售卖、再许可和再分发（含单独发布、打包和移植版）。此处使用范围是 WhalePod 应用内部呈现，不导出 npm 包或另一套组件库。公开 WhalePod 源码时保留本目录、版权和许可通知；不能仅复制该目录作为独立组件产品。此范围说明记录项目的集成方式，不代表额外获得了维护者授权。

## 本地适配

- StatusMark 保留圆环、虚线、勾与叉的几何和状态结构。Motion 控制改成事实驱动的 CSS；只对在线 running Run 绘制不定进度活动，不接收百分比。新增暂停图形；标签取 WhalePod 完整九态中文表，删除英文重复朗读和完成划线。
- CallChip 保留芯片、底色、图标槽、名称和结果的结构。图标由宿主现有 DSH 图标提供；仅呈现匹配的真实结束事件，不展示工具参数。删去 expectedMs 填充、本地计时器、shake、重试按钮和本地状态回调。
- ThoughtLine 保留标题、点状 glyph 与标签结构，改为受控公开阶段摘要。移除思维 trace、计时器、自动 settle、shimmer、blur 和外部依赖；当前面板已有状态环，因此标签不再添加另一处循环动效。
- RubberSegment 保留轨道、等宽按钮与指示面结构。仅用于 Console 筛选，改为原生 group + aria-pressed，保留全部按钮的 Tab 顺序；取消拖拽、惯性、弹性、拉伸与 radio 键位。鼠标指示面 transform 160ms 可打断，键盘与减少动态即时切换。
- 指令按钮反馈使用 WhalePod 自有实现，保留原 InstructionComposer 的权限、目标和提交路径，没有复制 PromptBar 或扩展不存在的功能。
- WarmTooltip 保留「首个等待、窗口内相邻即时」的 warm 语义与单例提示层，改由应用壳挂一个 `HintGroup`（`shared/micro/Hint.tsx`）。删除倾斜、行程弹簧、模糊层、长按与武装进度条，以及 Motion 依赖。触发元素必须是真实 DOM 元素（`aria-describedby` 要挂在会渲染它的节点上）；已聚焦元素上的提示不等待，鼠标按下后不再补弹。只有「可见文案够不着真目标」的可聚焦控件才用它（复制按钮、运行列表项），不给纯展示元素加 tab 停靠点。
- BellToggle 改成**完全受控**：`pressed` 由调用方按真实权限结果给，组件只在真的从关变开（或已开时真实未读增加）时响一次铃，计数写在 `data-ring` 上、由 CSS keyframe 播放。删除声呐波纹、铃舌、弹簧展开、未读晃动、尺寸与配色参数，以及 Motion/Hugeicons 依赖（铃铛图形用上游同文件里的内联路径）。徽标只渲染传入的真实未读数，为 0 不渲染空徽标。
- SwipeToast 保留下滑关闭、fuse 与可暂停语义，改成承载 store 里的一条 toast：**计时器由卡片持有**，因此悬停、聚焦、页面隐藏、拖拽中都能暂停并按剩余时间继续；关闭路径是滑动、Escape、关闭按钮与真实到期四条。删除动作按钮槽、inline 模式、弹簧回落与 Motion/Hugeicons 依赖；位移走 CSS 变量而不是 Motion 值。卡片本体样式与 `.leaving` 退场仍在 `styles/global.css`（#273 契约）。
- 所有颜色、圆角、字体、过渡均消费现有语义 token。在线状态环周期沿用上游 1100ms，集中登记为活动 token。减少动态模式彻底停用旋转、弹入与 fuse 动画（消退行为不依赖动画）；无需新增 Motion/Hugeicons 依赖。
- 组件仅负责呈现，状态/事件配对在应用层；不变更 Run、审批或 Task 的业务语义。提示层只显示调用方传入的静态标签，不读取 Run/事件/投影数据；铃铛不改变通知投递逻辑本身；toast 的关闭不推进任何系统状态。

## 同步纪律

只比较 manifest 里的固定路径。更新先核对新版本许可，再比较原始哈希与上游差异；保留上述本地适配与验收判据。不整库同步，不覆盖另一个 vendor/dsh-ui 目录。不静默引入 Motion/图标包：新增依赖单独走仓库依赖流程。
