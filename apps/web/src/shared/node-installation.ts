/** Alpha支持的源码安装，与installation.md及生产Node bin验收一致。 */
export const NODE_CLI_COMMAND = 'node apps/node/dist/cli.js'
export const NODE_BUILD_COMMANDS =
  'git clone https://github.com/RyanOnMe/whalepod.git\ncd whalepod\ngit checkout <与服务器一致的发布版本>\ncorepack enable\npnpm install --frozen-lockfile\npnpm -r --if-present build'
