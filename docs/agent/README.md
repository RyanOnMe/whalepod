# docs/agent — Harness 文档索引

给在这个仓库里干活的人和 AI：验证怎么拆、证据去哪找、验过的步骤放哪。

| 文档 | 内容 |
|---|---|
| [ai-harness-principles.md](./ai-harness-principles.md) | 六原语：驱动、观测、判定、归因、取证、发现 |
| [issue-workflow.md](./issue-workflow.md) | 问题从发现到合入的完整走法 |
| [evidence-map.md](./evidence-map.md) | 出问题时去哪一层找哪份证据 |
| [acceptance-template.md](./acceptance-template.md) | 验收文档模板；新验收一律按它写 |
| [setup-auth-invite-acceptance.md](./setup-auth-invite-acceptance.md) | G1-01..06：Setup/登录/邀请/角色/Origin gate 验收（P1-05） |
| [project-task-agent-acceptance.md](./project-task-agent-acceptance.md) | G2-01..06：Project/Task/Comment/Assignment + Task Room 聚合 + Agent Revision 验收（P1-06） |
| [run-orchestrator-acceptance.md](./run-orchestrator-acceptance.md) | G4-01..03、R7/R8：Run Orchestrator 与事务 Outbox 派发（P1-10） |
| [browser-realtime-acceptance.md](./browser-realtime-acceptance.md) | G2-06、R2/R3、§6.2：Browser Team Event 实时链路与断线补洞（P1-08） |
| [web-shell-acceptance.md](./web-shell-acceptance.md) | Issue #11 验收：Web 壳与 Task Room 双上下文主链 e2e（Q5 种子，P1-07） |
| [workspace-runtime-acceptance.md](./workspace-runtime-acceptance.md) | G3-04..06：Workspace Registry、Runtime 进程隔离与无孤儿恢复（P1-12） |

规矩只有一条：**验过就要留下**。验收步骤、探针跑法、上次结果、坑在哪，写进这里的 acceptance 文档；能直接复跑的脚本放 `scripts/`。只留在 `/tmp` 或对话里的验证，等于没验。

验收文档命名：`<链路或场景>-acceptance.md`，放在本目录，并在上表补一行索引。
