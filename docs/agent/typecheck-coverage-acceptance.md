# tests/ 的 typecheck 覆盖验收（#178）

- 对应门禁：Q0 静态门（`pnpm check`）——本片改的是**门本身**，故单独立档
- 对应 Issue：#178（门禁缺口）；未覆盖部分另见 #183
- 上次验证：2026-09-11 · `fix/p1-178-runtime-dsh-test-typecheck` · 结果 PASS（Q0 绿 / 1134 用例）

## 门改了什么

`pnpm check` → `typecheck` → `tsc -p tsconfig.json --noEmit && pnpm -r --if-present typecheck`。
改动前各包 tsconfig 只 `include: ["src/**/*.ts"]`，于是 **9 个有 `tests/` 的包里只有 `apps/web`
把测试目录纳入类型检查**——测试代码里的类型错误（漏 import、拼错类型名、签名漂移）逃得过 Q0，
只在运行时偶发暴露（#177 那处 `TS2304` 就是这么溜过去的）。

现在：给包加 `tsconfig.test.json`（`extends` 自身 tsconfig + `rootDir: "."` + include `src` 与
`tests`，`noEmit`、`composite: false`），包内 `typecheck` 改为
`tsc -b && tsc -p tsconfig.test.json`。

| 包 | 状态 |
|---|---|
| `apps/web` | 早已覆盖（先例 `tsconfig.test.json`） |
| `packages/runtime-dsh` | **本片接线**（并修掉随之暴露的 3 处存量错误） |
| `packages/domain` / `packages/testkit` / `apps/runtime` | **本片接线**（实测零存量错误，纯护栏） |
| `apps/hub` / `apps/node` / `packages/db` / `packages/protocol` | **未覆盖**，#183 分批收口 |

## 驱动（怎么触发）

```bash
pnpm check                      # Q0：含每包 typecheck（现覆盖 5 个包的 tests）
npx tsc -p packages/runtime-dsh/tsconfig.test.json   # 单包复跑
npx tsx scripts/check-boundaries.ts                  # 接线护栏（O2）
```

## 判定

| 判据 | 证据 | 结果 |
|---|---|---|
| 新门**真的在跑编译器** | 在 `src/runtime-spec.ts` 注入类型错误 → 红（exit 1），还原 → 绿 | PASS |
| tests 目录里的错误会被抓住 | 四个新接线的包各在 `tests/` 注入 `const __p: NoSuchTypeName = …` → 全部 exit 2 并报 TS2304；还原后逐字节一致 | PASS |
| 被测文件真的进了 program | `tsc -p … --listFilesOnly`：runtime-dsh 13/13、domain 8/8、testkit 2/2、runtime 1/1 | PASS |
| 没有把错误藏起来 | 3 处存量修复都是真修（import 改向到类型定义所在文件；readonly → 显式副本；`waitForFrame` 的收窄改为在谓词守卫内完成、**去掉唯一的 `as`**） | PASS |
| 新增开销可接受 | 3 个新项目分别 ~0.4–0.7s；对 21s 的 `pnpm check` 约 +2.4s（~12%） | PASS |
| 接线不会被静默跳过 | 新增 `checkTypecheckWiring`（`scripts/check-boundaries.ts`）+ 4 条单测：有 `tests/` 却缺 `typecheck` 脚本、脚本没跑 `tsconfig.test.json`、脚本引用了不存在的配置、以及正确接线与无 tests 包不受约束 | PASS |

> 为什么要那条接线护栏（评审 O2）：根 `tsc -b` 只构建根项目（`--dry` 证实：根配置无 `references`），
> 包 `src/` 与 `tests/` 能否进 Q0 **完全依赖各包自己那条脚本**；而 `pnpm -r --if-present typecheck`
> 在**缺脚本时静默 exit 0**（实测）。没有护栏时，「新包漏配」= 该包整体静默脱离类型门。
> 护栏带一张**只允许缩小**的豁免表（当前 4 项，每项标注 #183 与实测错误数）。

## 未覆盖与已知项

1. **4 个包仍未接线**（#183，实测存量错误）：`apps/node` **29**、`apps/hub` **30**、
   `packages/protocol` **1**、`packages/db` **1**，合计 **61**。
   口径提醒：早先记的「node 91」是**假象**——`apps/node/tests/*` 里两处
   `import ... from '../../../hub/tests/helpers.js'` 把 59 个 `apps/hub/src/*` 文件拖进 node 的
   program，抬 `rootDir` 后多出的 62 个 `TS6059` 并不是 node 自己的错误。**node 接线前需先拆这处
   跨包测试 import**，否则一接就是一片红。
2. **`packages/db` 的 tests 面可能冒出 `src` 级错误**：本片期间并发分支正在改 `db/schema`，
   曾观察到 1 个落在 `src/repositories/task.ts` 的错误随分支状态出现/消失。接线时以稳定分支为基准。
3. **本地 `pnpm check` 有偶发抖动**：负载高时 `apps/web/tests/{project-task-list,select-menu}.spec.tsx`
   偶发失败，单跑全绿；与本片无关（本片不动 web），但「Q0 绿」在本地不是每次都可复现。
4. **超时口径未调**：Q2/Q6 的用例仍是 5s 默认超时，机器饱和时既有用例会按超时失败（见
   `task-message-entity-acceptance.md` 的登记）。这是另一个问题，不在本片。
