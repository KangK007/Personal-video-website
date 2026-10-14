# 项目结构与迁移清单

## 目录职责

```text
app/                         Next.js App Router 页面、布局和 API Route Handler
  api/health                 网站与本机抓取服务健康检查
  api/feed/sync              同步代理和响应归一化
  api/metadata               公开页面元数据读取
  creator/[id]               博主个人页
  following                  关注列表页
components/                  页面交互组件
lib/                         客户端状态、数据模型、存储、同步和平台适配器
  server/                    仅服务端使用的哔站同步模块
scripts/                     本机服务与登录启动项安装、启动、停止和检查
tests/                       Vitest 单元测试
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

## 当前验证基线

- 单元测试：14 个测试文件，117 个测试通过（`npm test`）。
- 端到端冒烟：`npm run test:e2e`（需要先启动生产构建、并存在 Edge 或 Chrome；见下）。
- TypeScript：`npm run typecheck` 通过。
- ESLint：`npm run lint` 通过。
- Next.js 生产构建：`npm run build` 通过。
- 自动化同步依赖平台 Cookie、平台公开接口和本机浏览器；这些外部条件不由 CI 模拟。

### 端到端冒烟

`scripts/e2e-smoke.mjs` 用 Playwright 驱动本机 Edge/Chrome，覆盖首次使用、批量导入、自动同步、筛选搜索、手动保存、关注列表操作与撤销、同步失败重试、备份导出/清空/导入、个人页、主题、移动端布局，以及残留旧版缓存、分享短链接和空态同步按钮等边界。平台接口（`/api/feed/sync`、`/api/metadata`）在浏览器网络层被替换为确定性桩，因此它验证的是本站行为，不是平台可用性。外部服务必须另行用真实 Cookie 和平台接口验证。

```powershell
npm run build
npx next start --hostname 127.0.0.1 --port 3100
npm run test:e2e
```

脚本使用 `.local/e2e/` 保存独立的浏览器配置和截图，不会读写正常使用的浏览器数据。
