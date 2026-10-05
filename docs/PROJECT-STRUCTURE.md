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
scripts/                     本机抓取服务安装、启动、停止、检查和安全审计
tests/                       Vitest 单元测试
public/                      静态资源
.github/workflows/           GitHub Actions CI
```

## 可提交文件与本地文件

Git 仓库只保存源码、配置模板、锁文件、测试和说明文档。以下目录是可再生或包含敏感信息的本地目录，已由 `.gitignore` 排除：

- `node_modules/`、`.next/`、`.npm-cache/`：依赖和构建缓存，迁移后运行 `npm ci` 重新生成。
- `.local/`：本机抓取服务、虚拟环境、Cookie、令牌和运行日志，不能上传。
- `.env.local`：本机配置和令牌，迁移后从 `.env.example` 重新创建。
- `logs/`、`outputs/`：本地运行日志和导出结果，按需保留在本机，不作为源码发布。

## 新电脑迁移步骤

1. 克隆 GitHub 仓库并进入项目目录。
2. 安装 Node.js 24 LTS、Git；需要自动同步时另装 Python 3.11 和 Edge/Chrome。
3. 执行 `npm ci`，再执行 `Copy-Item .env.example .env.local`。
4. 仅需要手动使用时运行 `npm run dev`；需要自动同步时运行 `scripts/setup-sidecar.ps1` 和 `npm run start:local`。
5. 在浏览器中打开 `http://127.0.0.1:3000`，导入此前从“管理数据”导出的 JSON 备份。
6. 执行 `npm run verify` 确认迁移后的环境可构建。

## 当前验证基线

- 单元测试：8 个测试文件，42 个测试通过。
- TypeScript：`npm run typecheck` 通过。
- ESLint：`npm run lint` 通过。
- Next.js 生产构建：`npm run build` 通过。
- 自动化同步依赖平台 Cookie、平台公开接口和本机浏览器；这些外部条件不由 CI 模拟。
