# docs/agent — Harness 文档索引

给在这个仓库里干活的人和 AI：验证怎么拆、证据去哪找、验过的步骤放哪。

| 文档 | 内容 |
|---|---|
| [ai-harness-principles.md](./ai-harness-principles.md) | 六原语：驱动、观测、判定、归因、取证、发现 |
| [issue-workflow.md](./issue-workflow.md) | 问题从发现到合入的完整走法 |
| [evidence-map.md](./evidence-map.md) | 出问题时去哪一层找哪份证据 |
| [acceptance-template.md](./acceptance-template.md) | 验收文档模板；新验收一律按它写 |

规矩只有一条：**验过就要留下**。验收步骤、探针跑法、上次结果、坑在哪，写进这里的 acceptance 文档；能直接复跑的脚本放 `scripts/`。只留在 `/tmp` 或对话里的验证，等于没验。

验收文档命名：`<链路或场景>-acceptance.md`，放在本目录，并在上表补一行索引。
