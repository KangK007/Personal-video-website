# 只看关注

一个本地优先的抖音 / 哔哩哔哩关注视频聚合站。主页只展示你自己添加的博主和视频，不需要登录本站，也没有推荐流、评论区或广告模块。

[GitHub 仓库](https://github.com/KangK007/Personal-video-website)

## 已实现功能

- “最近更新”主页只显示已启用博主最近滚动 7×24 小时内发布的视频，并支持按平台筛选和搜索；平台/状态标签的计数会随其余筛选条件更新。
- 独立“关注列表”页面支持搜索、按平台筛选、暂停、恢复、单博主重试和取消关注后 10 秒撤销；连续的删除/取消关注/导入/清空操作不会清除仍在有效期内的撤销提示，撤销操作依次排队。
- 独立博主个人页展示全部本地视频，按发布时间排序并每次加载 48 条。
- 单个添加或按行批量导入博主；同步时尽力补充平台昵称和头像。
- “关注列表”页可从抖音 / 哔站提取自己的平台关注名单：预览、去重、选择后追加，支持导入导出名单文件，以及从已登录的哔站页面回传名单（不读取 Cookie）。
- 分页读取关注博主的全部公开投稿，并按时间合并去重。
- 同步错误可恢复：平台限流时本轮只标记实际失败的博主，被跳过的博主不再长期显示为错误；关注列表提供“重试有错误的博主”，同步服务连续失败时会自动停止本轮而不是把剩余博主全部标成失败。同步期间暂停/取消关注/删除只会让被修改的博主本轮跳过，其余批次继续完成；只有导入或清空替换全部数据时才会中止本轮。平台返回“完整但 0 条投稿”不再算失败：首次保留旧缓存并记为本轮跳过，同一批多个博主都返回 0 条时按平台限流处理并停止该平台本轮后续请求；连续两次单独的空结果才清空该博主缓存。同一时间只处理一个同步任务，短暂重叠会等待而不是把整批标成失败。哔站单轮最多 50 位，一轮无失败完成后会间隔 15 秒自动继续下一批（最多 10 轮），遇到失败、限流、空结果或取消即停止；205 位博主也能一次点击分 4 轮自动完成。
- 手动保存视频链接（抖音 / 哔站分享短链接会在保存时先自动解析为详情页）；公开元数据读取失败时仍可手动填写标题。
- IndexedDB v2 本地保存、v1 数据迁移以及 JSON v1/v2 备份导入和 v2 导出。
- 桌面端和移动端响应式界面，支持键盘操作和深色模式。

## 工作方式

网站由两部分组成：

| 部分 | 作用 | 是否接触 Cookie |
| --- | --- | --- |
| Next.js 网站 | 展示关注流、保存名单、调用同步接口；按需启动本机 Edge 读取抖音主页和平台关注名单 | 是，从 `.local/douyin-cookie.txt` 和 `.local/bilibili-cookie.txt` 读取对应平台 Cookie |
| 本机抓取服务 | 通过第三方 API 服务读取哔站投稿 | 是，启动时从 `.local/bilibili-cookie.txt` 加载到内存；不写入第三方仓库配置 |

不配置抓取服务时，网站仍可完整使用关注名单、平台切换、手动保存和备份功能；“同步关注流”会明确提示尚未配置。

## 快速开始

需要 Node.js 24 LTS。首次安装依赖建议使用锁文件进行可复现安装：

```powershell
npm ci
npm run start:local
```

`start:local` 会检查并启动本机抓取服务，在构建缺失或早于源码时重新构建，然后以生产模式启动 Next.js。网站和哔站 sidecar 都由轻量监督进程管理，意外退出后会自动重启；主动运行 `stop:local` 时会一并停止监督器和工作进程。并发执行多个启动命令时，后启动的命令会等待前一个完成，避免重复构建和覆盖进程记录。启动器只管理自己记录在 `.local/runtime/` 中的进程，不会结束同端口上的未知进程。默认访问地址为 `http://127.0.0.1:3000`；设置有效的 `APP_PORT` 时使用对应端口。运行日志也位于该目录。停止由此脚本启动的服务可运行 `npm run stop:local`。如果只想调试前端，可使用 `npm run dev`；普通 `dev` 和 `start` 命令默认也只监听回环地址。

### 登录后自动启动与个人数据

Windows 上可安装当前用户的登录启动项：

```powershell
npm run autostart:install
```

也可以直接运行 PowerShell 脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

安装脚本会在当前用户的 Windows Startup 文件夹创建快捷方式，并立即启动或复用网站。`APP_PORT` 必须是 1-65535 范围内的十进制整数；安装时按当前进程、用户级、计算机级环境变量的顺序读取，未设置时使用 `scripts/local-settings.json` 中的 `appPort`。通过 `APP_PORT` 设置的端口会固定用于本次启动和后续登录；更改端口后重新运行安装命令。默认地址是 `http://127.0.0.1:3000`。启动项不会自动打开浏览器窗口，也不会把服务暴露到局域网。移除自动启动设置运行 `npm run autostart:remove`，或直接运行 `powershell -ExecutionPolicy Bypass -File .\scripts\remove-autostart.ps1`；移除启动项不会删除数据或停止当前服务，停止服务仍运行 `npm run stop:local`。

项目专用个人数据目录为：

```text
<项目根目录>\.local\personal-data\
  backups\    # 从网站导出的 JSON v2 备份
```

运行 `start:local` 时会自动创建该目录。整个 `.local/` 已被 Git 忽略，因此备份不会被提交到仓库。网站的实时数据仍自动保存在当前浏览器配置中的 IndexedDB；电脑重启后，使用同一个浏览器配置并访问同一 origin（协议、主机和端口），例如 `http://127.0.0.1:3000`，数据会继续显示。不同端口、不同主机名、无痕窗口或不同浏览器配置各自拥有独立数据。添加、编辑或同步后，请等待页眉的“保存中”状态消失再关闭或刷新；写入未完成时浏览器会提示确认离开。

要保留可移动的文件备份，可在 Edge/Chrome 的下载设置中把下载位置设为上述 `backups` 目录，再在网站“管理数据”中选择“导出备份”。导出的 `just-follow-feed-YYYY-MM-DD.json` 包含关注名单和视频元数据。更换浏览器配置、清理浏览器数据或迁移电脑后，先打开同一网址，再从“管理数据”选择“导入备份”并确认；导入会替换当前网站数据。备份目录不会被网站自动导入，建议定期导出并另行复制到安全位置。

启动器发现当前 Node.js 不是 24 时会给出警告但继续运行，避免直接中断本机使用。项目仍只在 Node.js 24 LTS 下完成验证；若出现构建或运行异常，请先切换到 Node.js 24。

可以随时检查两个服务。检查命令还会通过本机令牌验证侧车鉴权是否生效，输出只包含状态码，不会显示令牌：

```powershell
npm run check:local
```

网站的 `/api/health` 只报告本机服务状态，不会返回 Cookie 内容。

## 配置自动同步

本项目使用系统中已有的 Microsoft Edge 或 Google Chrome 读取抖音主页，并使用 [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) 读取哔站投稿。配置脚本固定使用已验证的 v4 提交 `42784ffc83a72a516bfe952153ad7e2a3998d16c`；不会把现有侧车仓库重置或切换到其他提交。需要 Git、Python 3.11、Edge 或 Chrome，以及可访问 GitHub 的网络。

### 1. 准备抓取服务

在项目目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-sidecar.ps1
```

如果 Cookie 已保存在本机文本文件中，可以避免在控制台粘贴：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-sidecar.ps1 -DouyinCookieFile "抖音 Cookie 文件路径" -BilibiliCookieFile "哔站 Cookie 文件路径" -NonInteractive
```

每个文件都必须只包含对应平台的单行 Cookie。脚本会把凭据分别保存到被忽略的 `.local/douyin-cookie.txt` 和 `.local/bilibili-cookie.txt`，并在 Windows 上移除继承权限，只允许当前用户和 `SYSTEM` 访问。凭据不会复制到项目源码或第三方仓库的 YAML。

如果本机侧车令牌可能泄露，可在停止网站后原地轮换，不需要重新输入 Cookie：

```powershell
npm run stop:local
powershell -ExecutionPolicy Bypass -File .\scripts\setup-sidecar.ps1 -SkipInstall -NonInteractive -RotateToken
npm run start:local
```

脚本会完成以下操作：

- 下载第三方项目的固定 v4 提交到被 Git 忽略的 `.local/` 目录；已有仓库版本不符时会停止并提示人工检查，不会自动重置。
- 创建独立 Python 虚拟环境并安装依赖。
- 应用并校验 `scripts/sidecar-security-requirements.txt` 中已做兼容性冒烟测试的安全更新；其中保留上游仍依赖的 `httpx 0.27` 接口。
- 仅绑定 `127.0.0.1:8001`，关闭第三方网页界面和下载接口。
- 安全地提示输入抖音、哔站 Cookie；两个凭据都只保存在 `.local/` 的独立文件中。
- 旧安装若曾把哔站 Cookie 写入第三方 YAML，会先验证外部文件可被启动入口加载，再清空 YAML 中的旧字段。
- 生成独立随机令牌并保护其文件权限；除健康探测外，本机抓取接口均要求本站携带 Bearer 令牌。
- 创建 `.env.local`，让本站连接本机抓取服务。

Cookie 失效后可以重新运行配置，跳过重复安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-sidecar.ps1 -SkipInstall
```

`-SkipInstall` 会跳过完整的上游依赖安装，但仍会检查并应用本项目已验证的安全覆盖版本。更新 Cookie 后必须重启网站（`npm run stop:local` 再 `npm run start:local`）：本机抓取服务只在启动时读取一次 Cookie，站点重启后新的 Cookie 才会生效。

如果 Python 更新或卸载后出现 `No Python at ...`，请先安装 Python 3.11；本机可运行 `winget install --id Python.Python.3.11 --exact --source winget`。随后不带 `-SkipInstall` 重新运行 `setup-sidecar.ps1 -NonInteractive`。脚本会验证虚拟环境能否运行，并重建失效的 `.venv`；`.local/` 中的 Cookie、令牌和个人数据不会随之删除。

### 2. 获取 Cookie

分别在浏览器登录 `douyin.com` 和 `bilibili.com`，按 `F12` 打开开发者工具：

1. 打开“网络（Network）”面板并刷新页面。
2. 选择任意发往当前网站的请求。
3. 在“请求标头（Request Headers）”中找到 `Cookie`。
4. 只复制 `Cookie:` 后面的完整值，粘贴到配置脚本的隐藏输入框。

Cookie 等同于登录凭据。不要发给他人，不要写进源码、截图或聊天记录。本项目的 `.gitignore` 已排除 `.env.local` 和 `.local/`。

Edge / Chrome 127 起用 App-Bound 加密保护 Cookie，自动化脚本无法复用浏览器里的登录态（复制配置或自动化登录窗口通常也会触发风控）。只想更新哔站 Cookie 时，可以只复制 `SESSDATA`、`bili_jct`、`DedeUserID` 三个值，各占一行保存为 `.local/cookie-input.txt`，然后运行：

```powershell
node scripts/set-bilibili-cookie.mjs
npm run stop:local
npm run start:local
```

脚本会校验这三个必需字段、自动补充匿名 `buvid3`/`buvid4`/`b_nut` 并备份旧 Cookie；重启后可用网站同步或 `curl` 请求 `/api/bilibili/session` 验证登录态。

### 3. 启动服务

推荐使用统一启动脚本（网站和 sidecar 会在后台运行，重复执行会复用健康的服务）：

```powershell
npm run start:local
```

源码调试时，也可以分别运行 `.\scripts\start-sidecar.ps1` 和 `npm run dev`。开发模式不负责后台守护，关闭终端后需要重新启动。

打开网站，添加博主主页链接。完成本地数据读取后，只要存在已启用的关注博主，添加成功后和每次新打开、刷新时都会自动同步一次；也可以随时点击“同步关注流”或在失败的博主上重试。程序会顺序翻页，直到平台明确返回没有下一页。完整同步成功后会替换该博主旧的自动同步快照，手动保存的视频继续保留；分页失败或响应不完整时保留旧缓存。没有关注博主或全部暂停时会跳过自动同步，网络或平台失败时保留原有缓存并显示可重试状态。首次同步投稿很多的账号可能需要几分钟，请保持页面开启。

“添加博主”弹窗可以切换到“批量导入”。每行粘贴一个主页链接即可，也支持在链接前写博主名称，例如：

```text
https://www.douyin.com/user/...
摄影博主 https://space.bilibili.com/123456
```

在“关注列表”点击“从平台提取”可以自动读取抖音和哔站的已关注博主。工具分别从 `.local/douyin-cookie.txt` 与 `.local/bilibili-cookie.txt` 读取 Cookie，在临时 Edge/Chrome 会话中打开对应平台页面，再逐页读取关注接口；不复用同步投稿的 Python 抓取服务。界面显示登录账号、进度、重复项和异常；提取结果会先预览，确认后追加到本站，不会替换已有视频或暂停状态。每条名单记录包含 `platform`、`platformUserId`、`name`、`profileUrl` 和可选的 `avatarUrl`，主页链接统一为抖音 `https://www.douyin.com/user/{sec_uid}` 或哔站 `https://space.bilibili.com/{uid}`。若临时浏览器中哔站仍显示“登录”，说明保存的哔站 Cookie 已失效，需要更新 Cookie 后重试。

如果当前 Edge 已经登录哔站，但保存的 Cookie 过期，可以在提取窗口点击“连接当前哔站页面”。本站会生成一次性连接脚本并尝试复制到剪贴板；切到已登录的哔站页面（`www.bilibili.com`、`space.bilibili.com` 等任意哔站页面均可，也可以是 `https://api.bilibili.com/x/web-interface/nav`），在开发者工具 Console 粘贴并回车。脚本只在当前哔站页面内调用关注接口，再打开一个本站本机接收标签页，通过浏览器消息传递名单；接收页以同源请求把结果送回提取窗口。脚本不读取、不显示、不保存 Cookie。脚本完成后切回本站，结果会自动出现；连接令牌 30 分钟内有效且只能读取一次，过期或网站重启后会提示重新连接。

工具支持导出名单专用 JSON（`kind: "following-list"`、`version: 1`、`exportedAt`、`creators`、`platformResults`）和 UTF-8 TXT。TXT 每行是 `主页链接<TAB>博主名称`，可直接粘贴到批量导入框。名单 JSON 可在提取窗口中重新导入并追加；它与“管理数据”中的全站备份格式不同，不能用于替换全站数据。部分分页结果会标记为未完整，导出或追加前需要明确勾选“包含未完整结果”。

抖音同步时会在后台短暂启动无界面的 Edge 或 Chrome，取得主页数据后立即关闭。哔站同步由端口 `8001` 的本机服务处理；开始前会用保存的 Cookie 直接请求哔站登录接口检查登录状态（不再启动无头浏览器），失效时直接提示更新 Cookie（更新后需重启网站）并跳过哔站博主，不再逐条触发平台风控。哔站每次请求 1 位博主、博主之间间隔 3–5 秒、同一博主翻页间隔 1.2 秒，单轮最多同步 50 位，剩余留到下次；命中平台限流时会等待 20 秒重试一次，仍受限则停止该平台本轮后续请求，被跳过的博主不计为失败。一次全量同步会逐批处理；单批或单个博主失败时会保留已有缓存并继续后续批次，可在“关注列表”逐个重试或点“重试有错误的博主”。只有网络中断、超时和服务端 5xx 才计入“同步服务连续失败”的熔断；本地配置错误或 4xx 只标记当批失败，不会提前结束整轮。每个同步请求有 8 分钟硬上限，浏览器关闭操作最多等待 5 秒，因此即使某个页面卡住也不会让整轮同步永久停在“同步中”；进度与失败原因会写入 `.local/runtime/app.log`。

## 项目结构

```text
app/
  api/health/route.ts       # 本机网站与抓取服务健康检查
  api/feed/sync/route.ts   # 只读同步代理与响应归一化
  api/following/collect    # 抖音 / 哔站关注名单 NDJSON 提取接口
  api/metadata/route.ts    # 公开页面元数据读取
  creator/[id]/page.tsx    # 博主个人页路由
  following/page.tsx       # 关注列表路由
  globals.css              # 页面样式和响应式布局
components/VideoHub.tsx    # 三个页面、表单、筛选、备份等交互
components/FollowingCollector.tsx # 关注名单提取、预览、导入导出
lib/douyin-browser.ts      # 使用本机浏览器读取抖音主页投稿
lib/server/following.ts    # 两个平台的关注名单采集器
lib/following-list.ts      # 名单格式、校验、TXT 与 NDJSON 工具
lib/feed-context.tsx       # 跨路由共享的客户端数据状态
lib/feed-logic.ts          # 最近更新过滤和视频排序逻辑
lib/feed-storage.ts        # 使用 IndexedDB 保存大批量关注与视频数据
lib/feed-types.ts          # 关注与视频数据结构
scripts/                   # 本机抓取服务准备、凭据迁移、启动、停止与检查脚本
  app-supervisor.mjs       # 网站进程崩溃后自动重启
```

## 验证

```powershell
npm run typecheck
npm run lint
npm run build
npm audit
npm audit --omit=dev
npm run audit:sidecar
```

也可以使用统一验证命令：

```powershell
npm run verify
```

界面级冒烟测试使用 Playwright 驱动本机 Edge/Chrome，覆盖首次使用、批量导入、同步、筛选、手动保存、撤销、备份导入导出和移动端布局等主要流程；平台接口在浏览器网络层被替换为确定性桩：

```powershell
npm run build
npx next start --hostname 127.0.0.1 --port 3100
npm run test:e2e
npm run test:e2e:following -- http://127.0.0.1:3100
```

主流程冒烟的浏览器配置和截图保存在 `.local/e2e/`；关注名单冒烟使用独立临时浏览器环境，覆盖流式预览、断线后的部分结果确认、追加去重和哔站浏览器连接。两者都不会读写正常使用的数据，平台接口由测试桩替代；真实同步仍需用本机 Cookie 验证。

与本机 FocusExtension 的外链联动可单独用真实 Edge/Chrome 测试。先启动本站，再指定插件目录运行；脚本使用 `.local/e2e/focus-extension-profile/` 中的独立浏览器配置：

```powershell
$env:FOCUS_EXTENSION_PATH = 'D:\浏览器插件\FocusExtension'
npm run test:e2e:extension -- http://127.0.0.1:3100
```

迁移到其他电脑、目录职责和 GitHub CI 说明见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`docs/PROJECT-STRUCTURE.md`](docs/PROJECT-STRUCTURE.md)。

## 限制与安全说明

- 抖音和哔站都可能调整风控或网页接口；Cookie 也会过期。抖音同步依赖本机 Edge 或 Chrome，同步失败时可继续手动保存视频。
- 视频仍在原平台播放，本项目不下载、不转码，也不绕过平台权限。
- 第三方抓取服务只监听回环地址，并由随机 Bearer 令牌保护；仍不要把端口 `8001` 或本站同步接口暴露到局域网或公网。
- `npm run audit:sidecar` 会先执行 `pip check`，再使用可用的 `pip-audit` 检查实际虚拟环境。不要绕过安全覆盖文件单独升级 FastAPI、Starlette 或 `httpx`。
- 当前数据保存在浏览器 IndexedDB；旧版 `localStorage` 数据会在首次打开时自动迁移。清理浏览器数据、切换浏览器配置或更换站点地址前，请先导出备份。
- 使用时应遵守平台条款、著作权规则和当地法律，仅处理有权访问的公开内容。

## 第三方许可

本站代码与第三方抓取服务相互独立。第三方项目采用 Apache-2.0 许可证；自动配置脚本只下载并调用它，没有复制其签名算法源码。抖音浏览器适配器使用 Apache-2.0 许可的 `playwright-core` 驱动本机浏览器。
