# TabTin 安装（v0.1.0-alpha.2）

适用对象：**没有开发背景的试用团队**。全程约 30 分钟。产品命题与边界见
[README](../README.md)；这里只有"装到哪一步、看到什么算对"。

拓扑一句话：一台 Linux 机器跑 **Hub**（团队服务器，Docker 装）；每位成员的
macOS/Linux 电脑跑一个 **Node**（自己电脑上执行 Agent 的常驻程序）；浏览器用
Hub 的网页。3–10 人团队 = 一台 Hub + 每人一个 Node。

> **先选网络形态（决定后面一切）**
> - 团队只有你一个人试用：Hub 装本机，浏览器用 `http://localhost:8080` ——最省事。
> - 多人试用：Hub 必须有一个 **https 域名**（自己买域名 + Caddy/nginx 反代皆可）。
> - ⚠ **局域网 `http://192.168.x.x` 形态不可用**：会话 Cookie 在非 localhost 下强制
>   `Secure`（这是安全默认，不是 bug），http 页面会把 Cookie 全丢——表现为
>   "登录成功但立刻又变未登录"。多人又想零公网，请每人开 SSH 隧道：
>   `ssh -L 8080:127.0.0.1:8080 <hub主机>`，浏览器仍访问 `http://localhost:8080`。
>   （产品级 LAN 方案在议：Issue #105。）

---

## A. Hub 主机（Linux，装过 Docker 的任意机器）

前置：Docker（含 compose 插件）、git。检查：`docker compose version` 有输出即对。

```bash
git clone https://github.com/RyanOnMe/project311.git
cd project311
git checkout v0.1.0-alpha.2        # 锁版本；main 是开发分支，试用勿用

# 1) 生成两个只此一份的机密，写进 .env（权限 0600）
umask 077
cat > .env <<ENV
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
# 单源 = 浏览器地址栏那个 origin，逐字符一致（含协议与端口）：
PROJECT311_PUBLIC_ORIGIN="http://localhost:8080"
P311_WEB_PORT=8080
ENV
# 多人 https 形态改这两行：
#   PROJECT311_PUBLIC_ORIGIN="https://hub.你的域名"
#   P311_WEB_PORT=8080    # 仍绑本机，TLS 交给反代（见 C）

# 2) 起服务（首次构建镜像约 3-5 分钟；--env-file 显式指定——compose 的
#    默认 env 解析目录跨版本行为不一，显式化钉死，一审 B7）
docker compose --env-file .env -f deploy/compose.yml up -d --build

# 3) 看到 "healthy" 才算起来（约 30-60 秒）
docker compose --env-file .env -f deploy/compose.yml ps        # 三个服务都 healthy

# 4) 拿一次性 Setup Token（团队创建用，只显示一次）
docker compose --env-file .env -f deploy/compose.yml exec hub node dist/cli.js setup-token
```

**验证点**：浏览器打开 `PROJECT311_PUBLIC_ORIGIN`（如 `http://localhost:8080`）→
看到"创建团队"页 → 粘贴第 4 步的 Token + 团队名 + 你的用户名/密码 → 进入产品。
> **口令强度已强制**（#106/#108 已落地）：少于 12 个字符建队/受邀会被 400 拒绝——
> 用密码管理器生成，别试短密码。**Token 用过即废**；找不到就重启 hub 容器
重新执行第 4 步（已建队的实例不会再给 Token）。

## B. 每位成员的电脑（macOS / Linux）

前置：git、Node.js 24（装 [nvm](https://github.com/nvm-sh/nvm) 后 `nvm install 24`
最省事）、corepack（随 Node 附带）。

```bash
git clone https://github.com/RyanOnMe/project311.git
cd project311 && git checkout v0.1.0-alpha.2
corepack enable
pnpm install --frozen-lockfile
pnpm -r --if-present build                    # 约 1-2 分钟

# 1) 网页右上角「设备」页 →「生成配对码」（10 分钟有效），然后：
node apps/node/dist/cli.js pair --hub http://localhost:8080 --code <配对码>
#    https 形态把 --hub 换成你的 origin（如 https://hub.你的域名），其余不变
#    （成功输出 "device token (shown once)"，抄进密码管理器，只此一次）

# 2) 登记你要让 Agent 干活的项目目录（可以有多个）：
node apps/node/dist/cli.js workspace add ~/code/我的项目 --name 我的项目

# 3) 配置模型凭证（每个要用模型的成员机都要做一次；密钥只落本机
#    0600 文件，永不上 Hub——Hub 只看得到 slot 名）：
node apps/node/dist/cli.js secret set deepseek-official default
#    按提示粘贴 DeepSeek API Key（platform.deepseek.com 申请，sk-...）

# 4) 常驻运行（先开着窗口跑；稳定后见 D 做成服务）：
node apps/node/dist/cli.js start
```

**建 Agent 时三个字段照这个填**（网页「Agents」→ 新建）：
Provider `deepseek-official`、Model `deepseek-chat`、Credential Slot `default`
——provider 是 DSH 运行时的真实路由名，填别的（比如 `deepseek`）会在
Run 发起时报 `NO_ADAPTER`（#117 实录）。

**验证点**：回到网页 → 发起一个 Run，运行器里能选到"我的项目"；Run 跑起来
后每次工具调用都会请你审批（一次性批准，这是设计）。

> ⚠ **已知限制（#94）**：`start` 运行**期间**再 `workspace add` 的新目录，网页
> 要等 Node 重启（Ctrl+C 再 `start`）后才能看到。正常顺序是"先 add 后 start"。

## C. 多人 https 的一层薄反代（能少则少）

compose 的 web 只绑 `127.0.0.1`（改 `P311_WEB_PORT` 那行旁边加 `127.0.0.1:` 前缀），
TLS 交给 Caddy 一行配置：

```
hub.你的域名 {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 自动签发/续期 Let's Encrypt；`PROJECT311_PUBLIC_ORIGIN` 填 `https://hub.你的域名`
后重启 compose（`docker compose ... up -d` 即可，env 变了会自动重建）。

## D. 开机自启（试用第二周再做这个也不迟）

- Linux（Node 机器与 Hub 主机同法）：`systemd` unit 跑
  `node .../cli.js start`，Hub 主机则直接 `docker compose ... up -d` 加
  `restart: unless-stopped`（compose 文件里给 web/hub/db 三个服务都加上）。
- macOS：`launchd` 的 `KeepAlive` 项（Alpha 期手写一份，仓库暂无示例——别去找，真没有）。

## E. 升级与回滚

```bash
# 升级：切 tag → 重建 → 启动（数据自动向前迁移，见下）
git fetch --tags && git checkout v0.1.0-alpha.2
docker compose --env-file .env -f deploy/compose.yml up -d --build   # Hub 侧
pnpm install --frozen-lockfile && pnpm -r --if-present build   # 每台 Node 机器
node apps/node/dist/cli.js start                          # 重启各 Node

# 回滚：checkout 旧 tag 重复上法。注意：
# 迁移是**只向前**的——回滚 = 停在旧版 hub + 数据不动（旧版代码不认识新 schema
# 列时可能报错，属预期；需要真回退数据找维护者，Alpha 期人工）。版本守卫是
# 已知缺口（旧版不会主动拒绝新 schema，别把它当保护机制）。
```

## F. 出问题了看哪里

| 症状 | 第一手证据 | 说明 |
|---|---|---|
| 网页打不开 | `docker compose ... ps`；`curl <origin>/healthz` | healthz 连不上=Hub 没起；返回 ok 而页面白=找反代/浏览器 |
| 登录成功又掉出 | 你用的 origin 是不是非 localhost 的 http | 见开头红字警告（#105） |
| 运行器选不到项目 | Node 窗口里 `start` 是否活着；`pair` 是否成功 | 新 add 的项目 → 重启 Node（#94） |
| Run 一直排队 | Node 机器与 Hub 的网络是否通（同 origin） | Agent 执行发生在**你的**电脑上 |
| 都要 | `docker compose ... logs --tail 50 hub web` | 日志已脱敏，可直接贴给维护者 |

数据全在 `pgdata`/`hubdata` 两个卷里；卸载 = `docker compose ... down -v`
（**会删库**，先确认真的要清）。
