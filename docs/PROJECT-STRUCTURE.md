# 项目结构与迁移清单

## 目录职责

```text
app/                         Next.js App Router 页面、布局和 API Route Handler
  api/bilibili/session       哔站 Cookie 登录态检查（同步前预检）
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
  bilibili-browser.ts        用本机浏览器读取哔站关注名单并检查登录态
  following-list.ts          名单格式校验、TXT / JSON 导入导出
  server/                    仅服务端使用的同步与关注名单模块
    bilibili-sync.ts         哔站投稿同步（分页间隔 1.2 秒）
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
5. 更新 Cookie（Edge/Chrome 127+ 的 App-Bound 加密使自动化脚本无法复用浏览器登录态）：按 README“获取 Cookie”从开发者工具复制，或只保存 `SESSDATA`、`bili_jct`、`DedeUserID` 三行到 `.local/cookie-input.txt` 后运行 `node scripts/set-bilibili-cookie.mjs`；再执行 `npm run stop:local`、`npm run start:local` 让 sidecar 重新读取。
6. Windows 上运行 `npm run autostart:install`，让网站在当前用户登录后自动启动；移除启动项运行 `npm run autostart:remove`。
7. 在浏览器中打开 `http://127.0.0.1:3000`。实时数据保存在该浏览器配置的 IndexedDB；迁移时从 `.local/personal-data/backups/` 选择 JSON 备份并通过“管理数据”导入。
8. 执行 `npm run verify` 确认迁移后的环境可构建。

## 当前验证基线（2026-10-23）

- 单元 / 集成测试：23 个测试文件，214 个测试通过（`npm test`）。
- TypeScript：`npm run typecheck` 通过。
- ESLint：`npm run lint` 通过。
- Next.js 生产构建：`npm run build` 通过（13 条路由）。
- 浏览器冒烟：`npm run test:e2e` 95 项、`npm run test:e2e:following` 9 项通过（需先启动生产构建、并存在 Edge 或 Chrome；见下）。
- 插件联动冒烟：`npm run test:e2e:extension` 9 项通过（需 `FOCUS_EXTENSION_PATH` 指向本机 FocusExtension 目录；默认路径为 `D:\浏览器插件\FocusExtension`）。
- CI 在 Node.js 24 上运行 `npm run typecheck && npm run lint && npm test && npm run build`；浏览器冒烟不在 CI 中运行。
- 自动化同步与关注名单提取依赖平台 Cookie、平台公开接口和本机浏览器；这些外部条件不由 CI 模拟，需在本机用真实凭据另行验证。

### 同步节奏与错误恢复

- 哔站：每次请求 1 位博主，博主之间 3–5 秒随机间隔，同一博主翻页间隔 1.2 秒；单轮最多 50 位，超出部分顺延到下一轮（优先失败、未同步、最久未同步的博主）。
- 顺延不等于需要反复手动操作：一轮完成且本轮无失败、无空结果、无限流时会等待 15 秒自动继续下一轮（最多 10 轮），期间显示“第 N 轮完成，自动继续剩余 X 位”；任一轮出现失败、限流、空结果、登录失效或用户取消即停止，剩余博主保留到下次。进度条按累计处理数增长，最终消息显示“分 N 轮完成”。
- 同步开始前通过 `/api/bilibili/session` 用保存的 Cookie 直接请求哔站登录接口（普通 HTTP，不再启动无头浏览器）；只有明确的“未登录/已过期”才跳过哔站博主，风控或异常响应按“检查不可用”放行。结果按 Cookie 文件指纹缓存，文件更新后自动重新检查；失效提示会要求更新 Cookie 并重启网站（抓取服务只在启动时读取一次 Cookie）。
- 防卡死：每个同步请求 8 分钟硬上限（超时返回 504 并释放同步锁）；Playwright 浏览器关闭最多等待 5 秒（`closeWithTimeout`），避免卡住的 Edge 进程让请求永久挂起；客户端登录检查 45 秒超时。同步开始/结束与失败原因写入 `.local/runtime/app.log`（`[sync]` 前缀）。
- 平台返回限流时等待 20 秒重试一次；重试会保留同批已成功博主的首次结果。仍受限则停止该平台本轮后续请求，并把这些博主标记为“本轮未请求”（不保留历史错误、不计为失败）。只有网络中断、超时和服务端 5xx 才计入“同步服务连续失败”的熔断；本地配置错误或 4xx 不触发熔断。
- 同步期间暂停、取消关注、删除只会让被修改的博主本轮跳过（按 ID/平台对账批次），其余批次继续完成；只有导入或清空替换全部数据时才中止本轮。中止时已成功的运行显示“部分完成”，不会全部标成失败。
- 平台返回“完整但 0 条投稿”时不再计为失败：首次保留旧缓存并记为本轮跳过（`emptySnapshotCount` 随数据持久化），单条空结果的第二次确认才清空缓存；同一批多个博主都返回 0 条时按平台限流处理，停止该平台本轮后续请求并保留全部缓存。
- 同步接口同一时间只处理一个任务：短暂重叠（超时重试、另一标签页）会等待最多 15 秒再执行，确实被占用时以“另一个同步任务正在进行”停止本轮而不是把整批标为失败。
- 平台/状态标签的计数按“其余筛选条件”计算，并随搜索实时更新；撤销提示最多排队 3 条，删除视频与取消关注的撤销按身份恢复，不因无关编辑而失效。
- 关注名单连接令牌 30 分钟内有效；单次回调载荷上限 24 MB，名单文件读取上限 32 MB，覆盖 1 万条长头像 URL 的极端情况。
- 启动器在启动网站前检查端口；端口被其他进程占用时直接报错，不会留下无限重启的监督器。监督器对“启动后立即退出”的连续失败最多重试 5 次（测试可用 `APP_SUPERVISOR_MAX_RAPID_FAILURES` 覆盖），超限后停止自动重启并输出单一可处理错误。

### 端到端冒烟

`scripts/e2e-smoke.mjs` 覆盖首次使用、批量导入、自动同步、筛选搜索、手动保存、关注列表操作与撤销、同步失败重试、备份导出/清空/导入、个人页、主题、移动端布局、多标签页同步，以及残留旧版缓存、分享短链接和空态同步按钮等边界；“同步失败与重试”一段会模拟平台限流，验证退避重试成功、持久限流下的失败与跳过区分、跳过博主不保留历史错误、Cookie 失效时的明确提示，以及“重试有错误的博主”批量恢复；另校验标签计数随搜索/状态筛选更新、连续删除与取消关注的撤销提示排队、以及同步期间编辑不会中止本轮。平台接口（`/api/feed/sync`、`/api/metadata`、`/api/bilibili/session`）在浏览器网络层被替换为确定性桩，因此它验证的是本站行为，不是平台可用性。

`scripts/following-e2e-smoke.mjs` 覆盖关注名单提取的流式预览、完整/未完整结果的选中规则、中断后的部分结果确认、追加去重、名单 JSON 导入、单平台部分名单重新提取、全站备份替换，以及从哔站 www / api / **space** 页面通过一次性连接回传名单（space 即关注列表所在的真实页面）。平台的关注接口与页面同样由桩替代。

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
