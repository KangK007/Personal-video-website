# 项目结构与迁移清单

## 目录职责

```text
app/                         Next.js App Router 页面、布局和 API Route Handler
  api/health                 网站与本机抓取服务健康检查
  api/feed/sync              同步代理和响应归一化
  api/following              平台关注名单提取（NDJSON 流）与浏览器连接回传
  api/metadata               公开页面元数据读取
  creator/[id]               博主个人页
  following                  关注列表页
  following/bridge           一次性浏览器连接的结果接收页
components/                  页面交互组件
  VideoHub.tsx               主界面、表单、筛选、备份等交互
  FollowingCollector.tsx     关注名单提取、预览、导入导出与浏览器连接
lib/                         客户端状态、数据模型、存储、同步和平台适配器
  bilibili-browser.ts        用本机浏览器读取哔站关注名单
  following-list.ts          名单格式校验、TXT / JSON 导入导出
  server/                    仅服务端使用的同步与关注名单模块
    bilibili-sync.ts         哔站投稿同步
    feed-sync-shared.ts      同步响应归一化公共函数
    following.ts             抖音 / 哔站关注名单采集器
    following-bridge.ts      一次性连接令牌与结果回传
scripts/                     本机服务与登录启动项安装、启动、停止和检查
  app-supervisor.mjs         网站进程崩溃后自动重启
  e2e-smoke.mjs              主流程浏览器冒烟
  following-e2e-smoke.mjs    关注名单提取浏览器冒烟
  extension-link-smoke.mjs   与 FocusExtension 的外链联动冒烟（需插件目录）
tests/                       Vitest 单元与集成测试
public/                      静态资源
.github/workflows/           GitHub Actions CI
```

## 可提交文件与本地文件

Git 仓库只保存源码、配置模板、锁文件、测试和说明文档。以下目录是可再生或包含敏感信息的本地目录，已由 `.gitignore` 排除：

- `node_modules/`、`.next/`、`.npm-cache/`：依赖和构建缓存，迁移后运行 `npm ci` 重新生成。
- `.local/`：本机抓取服务、虚拟环境、Cookie、令牌、运行日志，以及个人 JSON 备份，不能上传。
- `.local/personal-data/backups/`：网站“管理数据”导出的 JSON v2 文件；启动器会自动创建该目录。
- `.env.local`：本机配置和令牌，迁移后从 `.env.example` 重新创建。
- `logs/`、`outputs/`：本地运行日志和导出结果，按需保留在本机，不作为源码发布。

## 新电脑迁移步骤

1. 克隆 GitHub 仓库并进入项目目录。
2. 安装 Node.js 24 LTS、Git；需要自动同步时另装 Python 3.11 和 Edge/Chrome。
3. 执行 `npm ci`，再执行 `Copy-Item .env.example .env.local`。
4. 需要自动同步时运行 `scripts/setup-sidecar.ps1`；然后运行 `npm run start:local` 启动网站。
5. Windows 上运行 `npm run autostart:install`，让网站在当前用户登录后自动启动；移除启动项运行 `npm run autostart:remove`。
6. 在浏览器中打开 `http://127.0.0.1:3000`。实时数据保存在该浏览器配置的 IndexedDB；迁移时从 `.local/personal-data/backups/` 选择 JSON 备份并通过“管理数据”导入。
7. 执行 `npm run verify` 确认迁移后的环境可构建。

## 当前验证基线（2026-10-22）

- 单元 / 集成测试：19 个测试文件，161 个测试通过（`npm test`）。
- TypeScript：`npm run typecheck` 通过。
- ESLint：`npm run lint` 通过。
- Next.js 生产构建：`npm run build` 通过（12 条路由）。
- 浏览器冒烟：`npm run test:e2e` 80 项、`npm run test:e2e:following` 7 项通过（需先启动生产构建、并存在 Edge 或 Chrome；见下）。
- 插件联动冒烟：`npm run test:e2e:extension` 9 项通过（需 `FOCUS_EXTENSION_PATH` 指向本机 FocusExtension 目录；默认路径为 `D:\浏览器插件\FocusExtension`）。
- CI 在 Node.js 24 上运行 `npm run typecheck && npm run lint && npm test && npm run build`；浏览器冒烟不在 CI 中运行。
- 自动化同步与关注名单提取依赖平台 Cookie、平台公开接口和本机浏览器；这些外部条件不由 CI 模拟，需在本机用真实凭据另行验证。

### 端到端冒烟

`scripts/e2e-smoke.mjs` 覆盖首次使用、批量导入、自动同步、筛选搜索、手动保存、关注列表操作与撤销、同步失败重试、备份导出/清空/导入、个人页、主题、移动端布局、多标签页同步，以及残留旧版缓存、分享短链接和空态同步按钮等边界；其中“同步失败与重试”一段会模拟平台限流，验证本轮失败与跳过的区分、跳过博主不保留历史错误，以及“重试有错误的博主”批量恢复。平台接口（`/api/feed/sync`、`/api/metadata`）在浏览器网络层被替换为确定性桩，因此它验证的是本站行为，不是平台可用性。

`scripts/following-e2e-smoke.mjs` 覆盖关注名单提取的流式预览、完整/未完整结果的选中规则、中断后的部分结果确认、追加去重、名单 JSON 导入、全站备份替换，以及从哔站 www / api 页面通过一次性连接回传名单。平台的关注接口与页面同样由桩替代。

`scripts/extension-link-smoke.mjs` 加载真实 Chromium 插件，验证本站外链不会被插件误拦截。

```powershell
npm run build
npx next start --hostname 127.0.0.1 --port 3100
npm run test:e2e -- http://127.0.0.1:3100
npm run test:e2e:following -- http://127.0.0.1:3100
$env:FOCUS_EXTENSION_PATH = 'D:\浏览器插件\FocusExtension'
npm run test:e2e:extension -- http://127.0.0.1:3100
```

主流程脚本使用 `.local/e2e/` 保存独立的浏览器配置和截图；关注名单脚本使用临时浏览器环境；插件脚本使用 `.local/e2e/focus-extension-profile/`。三者都不会读写正常使用的浏览器数据。真实同步仍需用本机 Cookie 验证。
