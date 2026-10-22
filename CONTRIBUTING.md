# 开发与迁移说明

## 开发环境

- Node.js 24 LTS（项目的 `engines` 约束）
- npm 11（使用提交到仓库的 `package-lock.json`）
- Windows 本机抓取功能还需要 Python 3.11、Git，以及 Microsoft Edge 或 Google Chrome

首次迁移到新电脑时，在项目根目录执行：

```powershell
npm ci
Copy-Item .env.example .env.local
```

只需要使用抖音/哔站同步时，再执行 `scripts/setup-sidecar.ps1` 配置 Cookie 和本机令牌。Cookie、令牌、浏览器 IndexedDB 数据和抓取服务代码都不属于 Git 仓库；浏览器中的数据请先从“管理数据”导出 JSON 备份，再在新电脑中导入。

## 常用命令

```powershell
npm run dev                   # 仅启动 Next.js 开发服务器
npm run start:local           # 启动网站和本机抓取服务
npm run stop:local            # 停止由本项目启动的服务
npm run check:local           # 检查本机服务状态与令牌鉴权
npm run verify                # 类型检查、Lint、单元测试和生产构建
npm run test:e2e              # 主流程浏览器冒烟（需先启动生产构建）
npm run test:e2e:following    # 关注名单提取冒烟（同上）
npm run test:e2e:extension    # 插件外链联动冒烟（需 FOCUS_EXTENSION_PATH）
npm run audit:sidecar         # 检查抓取服务的 Python 依赖与已知漏洞
npm run autostart:install     # 安装 Windows 登录自启动
npm run autostart:remove      # 移除 Windows 登录自启动
```

## 修改约定

1. 不要提交 `.env.local`、`.local/`、`node_modules/`、`.next/`、日志、缓存或 `outputs/`。
2. 不要覆盖原始 Cookie、浏览器数据或本地备份；业务数据通过应用内 JSON 备份迁移。
3. 修改同步或关注名单提取逻辑后至少运行 `npm run verify`，并说明平台接口、Cookie 和本机浏览器的未验证部分；涉及浏览器交互的改动还应运行对应的 `test:e2e*` 冒烟。
4. Pull Request 应说明改动文件、验证命令和已知限制。CI 会在 Node.js 24 上运行 `npm run verify`；浏览器冒烟需要本机 Edge/Chrome，不在 CI 中运行。
5. 声称某个验证已通过前请实际运行；用桩替代平台接口时，要把它与真实凭据下的验证区分开。

## 发布检查

推送前确认：

- `git status --short` 中没有凭据、个人路径或运行产物。
- `npm run verify` 成功。
- 如改动本机抓取服务，同时运行 `npm run audit:sidecar`。
