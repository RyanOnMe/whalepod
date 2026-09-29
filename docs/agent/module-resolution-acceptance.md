# vitest 面解析到 src 验收（#35）

- 对应场景/门禁：Q1（`pnpm test:unit`）的模块解析前提；影响所有 vitest project（unit/web/integration/dsh-contract/resilience/security）
- 对应 Issue：#35（P1-35，priority:p0）
- 上次验证：2026-09-29 · `fix/p1-35-vitest-resolve-src` · 结果 PASS

## 验的是哪条用户路径

开发者本地改了某个 workspace 包（如 `@whalepod/domain`）的 `src/`，不先 `tsc -b` 重建 dist，直接跑 `pnpm test:unit`——测试必须打到**刚改的 src**，而不是 exports 默认指向的陈旧 `dist/`。修复前这条路径打旧构建，可能误判通过（PR #34 review 探针实测踩中）。

## 修复机制

各 workspace 包的 `exports` 增加 `development` 条件（protocol 含 `.` 与 `./plugin-pack-digest` 两个入口）：

```json
".": {
  "types": "./dist/index.d.ts",
  "development": "./src/index.ts",
  "default": "./dist/index.js"
}
```

vitest 的 server 解析条件默认含 `development`，于是**所有 vitest project 的包名 import 都选 src**；生产解析、`tsc -b`、tsx 直跑的 scripts 不带该条件、仍走 `default → dist`，行为不变。另把根 `package.json` 的 devDependencies 补齐全部 5 个 workspace 包（原先只有 db/protocol），使 `scripts/tests/` 成为合法 importer。

### 实验排除的替代方案

- 根配置 `resolve.alias` / `test.alias`（根级或 project 级）：vite 端解析可被重写，但**静态 import 链上存在 Node 原生解析环节**，对「importer 未声明依赖」的场景（如 `scripts/` 旧状）alias 够不着的组合已被实验证伪；且条件式是声明式、覆盖 Node/vite 两端，故弃 alias。
- 只加 development 条件而不补根依赖：`scripts/tests/` 下 Node 解析不到未声明包，自证 spec 放不进去。

## 驱动（怎么触发）

```bash
pnpm test:unit   # 或 pnpm check（末端即 test:unit）
```

## 观测与判定

机器判据固化为 `scripts/tests/module-resolution.spec.ts`（unit project 面，Q1 每次必跑）：

1. **路径断言**：对 `packages/` 下每个包（目录动态枚举，新增包自动进判据），`import.meta.resolve('@whalepod/<pkg>')` 必须以 `/packages/<pkg>/src/index.ts` 结尾；protocol 的 `./plugin-pack-digest` 子路径同理。
2. **行为断言**：全部 5 个包 + protocol 子路径在 spec 顶部**静态 import**——静态链正是 #35 踩坑的那条链；解析退回 dist 或加载失败时 suite 直接红。

## 红绿证据（2026-09-29 实测）

| 实验 | 配置 | 结果 |
|---|---|---|
| 基线复现 | 无 development 条件；`packages/protocol/src` 追加仅 src 有的导出 `__SRC_PROBE_35__`，dist 不重建，hub 真实单测断言该导出 | **红**（导出不可见＝打 dist，复现 #35） |
| 修复生效 | 加 development 条件，同上断言 | **绿**（打 src，改动立即可测） |
| 可证伪 | 撤掉 protocol 的 development 条件再跑自证 spec | **红 1 条**（protocol 解析路径断言抓住退回 dist） |
| 恢复 | 恢复条件 | **绿 6/6** |

## 归因（失败先看哪层）

- 自证 spec 的路径断言红 → exports 的 development 条件被删/写错（先查对应包 `package.json`）。
- 静态 import 报 `Cannot find package` → importer 所在 package.json 缺依赖声明（Node 原生解析层；如 `scripts/` 需根 package.json 声明）。
- 打包/生产运行行为异常 → 与本修复无关的可能性大（生产走 `default → dist`），查 dist 是否新鲜（`pnpm typecheck`）。

## 边界与未覆盖

- **tsx 直跑的 scripts（`phase1-drive` 等）不走 vitest，仍解析 dist**——改 src 后跑 scripts 前先 `pnpm typecheck`（`tsc -b` 重建）。这条口头契约保留在 CONTRIBUTING「Before you push」。
- Q2（integration）因本地 Docker 不可用未跑，由 PR 必检项（check + integration）兜底；Q0/Q1 经 `pnpm check` 全绿、Q3 `pnpm test:dsh-contract` 10 文件 35 用例全绿（runtime-dsh 解析面已覆盖）。
- Node 以 `--conditions=development` 运行生产代码也会选 src——仓库内无此运行形态，未做防御。

## 复跑

```bash
# 自证判据（1 秒级）
pnpm vitest run --project unit scripts/tests/module-resolution.spec.ts
# 全量门
pnpm check && pnpm test:dsh-contract
```
