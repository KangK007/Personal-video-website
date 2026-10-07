# 只看关注

一个本地优先的抖音 / 哔哩哔哩关注视频聚合站。主页只展示你自己添加的博主和视频，不需要登录本站，也没有推荐流、评论区或广告模块。

[GitHub 仓库](https://github.com/KangK007/Personal-video-website)

## 已实现功能

- “最近更新”主页只显示已启用博主最近滚动 7×24 小时内发布的视频，并支持按平台筛选和搜索。
- 独立“关注列表”页面支持搜索、按平台筛选、暂停、恢复、单博主重试和取消关注后 10 秒撤销。
- 独立博主个人页展示全部本地视频，按发布时间排序并每次加载 48 条。
- 单个添加或按行批量导入博主；同步时尽力补充平台昵称和头像。
- 分页读取关注博主的全部公开投稿，并按时间合并去重。
- 手动保存视频链接；公开元数据读取失败时仍可手动填写。
- IndexedDB v2 本地保存、v1 数据迁移以及 JSON v1/v2 备份导入和 v2 导出。
- 桌面端和移动端响应式界面，支持键盘操作和深色模式。

## 工作方式

网站由两部分组成：

| 部分 | 作用 | 是否接触 Cookie |
| --- | --- | --- |
| Next.js 网站 | 展示关注流、保存名单、调用同步接口；按需启动本机 Edge 读取抖音主页 | 是，仅从 `.local/douyin-cookie.txt` 读取抖音 Cookie |
| 本机抓取服务 | 通过第三方 API 服务读取哔站投稿 | 是，启动时从 `.local/bilibili-cookie.txt` 加载到内存；不写入第三方仓库配置 |

不配置抓取服务时，网站仍可完整使用关注名单、平台切换、手动保存和备份功能；“同步关注流”会明确提示尚未配置。

## 快速开始

需要 Node.js 24 LTS。首次安装依赖建议使用锁文件进行可复现安装：

```powershell
npm ci
npm run start:local
```

`start:local` 会检查并启动本机抓取服务，在构建缺失或早于源码时重新构建，然后以生产模式启动 Next.js。哔站 sidecar 由轻量监督进程管理，意外退出后会自动重启；主动运行 `stop:local` 时会一并停止监督器和工作进程。并发执行多个启动命令时，后启动的命令会等待前一个完成，避免重复构建和覆盖进程记录。启动器只管理自己记录在 `.local/runtime/` 中的进程，不会结束同端口上的未知进程。默认访问地址为 `http://127.0.0.1:3000`；设置有效的 `APP_PORT` 时使用对应端口。运行日志也位于该目录。停止由此脚本启动的服务可运行 `npm run stop:local`。如果只想调试前端，可使用 `npm run dev`；普通 `dev` 和 `start` 命令默认也只监听回环地址。

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

运行 `start:local` 时会自动创建该目录。整个 `.local/` 已被 Git 忽略，因此备份不会被提交到仓库。网站的实时数据仍自动保存在当前浏览器配置中的 IndexedDB；电脑重启后，使用同一个浏览器配置并访问同一 origin（协议、主机和端口），例如 `http://127.0.0.1:3000`，数据会继续显示。不同端口、不同主机名、无痕窗口或不同浏览器配置各自拥有独立数据。

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

`-SkipInstall` 会跳过完整的上游依赖安装，但仍会检查并应用本项目已验证的安全覆盖版本。

### 2. 获取 Cookie

分别在浏览器登录 `douyin.com` 和 `bilibili.com`，按 `F12` 打开开发者工具：

1. 打开“网络（Network）”面板并刷新页面。
2. 选择任意发往当前网站的请求。
3. 在“请求标头（Request Headers）”中找到 `Cookie`。
4. 只复制 `Cookie:` 后面的完整值，粘贴到配置脚本的隐藏输入框。

Cookie 等同于登录凭据。不要发给他人，不要写进源码、截图或聊天记录。本项目的 `.gitignore` 已排除 `.env.local` 和 `.local/`。

### 3. 启动服务

推荐使用统一启动脚本（网站和 sidecar 会在后台运行，重复执行会复用健康的服务）：

```powershell
npm run start:local
```

源码调试时，也可以分别运行 `.\scripts\start-sidecar.ps1` 和 `npm run dev`。开发模式不负责后台守护，关闭终端后需要重新启动。

打开网站，添加博主主页链接，然后点击“同步关注流”。程序会顺序翻页，直到平台明确返回没有下一页。完整同步成功后会替换该博主旧的自动同步快照，手动保存的视频继续保留；分页失败或响应不完整时保留旧缓存。首次同步投稿很多的账号可能需要几分钟，请保持页面开启。

“添加博主”弹窗可以切换到“批量导入”。每行粘贴一个主页链接即可，也支持在链接前写博主名称，例如：

```text
https://www.douyin.com/user/...
摄影博主 https://space.bilibili.com/123456
```

抖音同步时会在后台短暂启动无界面的 Edge 或 Chrome，取得主页数据后立即关闭。哔站同步由端口 `8001` 的本机服务处理。一次全量同步会逐批处理；单批或单个博主失败时会保留已有缓存并继续后续批次，可在“关注列表”逐个重试。

## 项目结构

```text
app/
  api/health/route.ts       # 本机网站与抓取服务健康检查
  api/feed/sync/route.ts   # 只读同步代理与响应归一化
  api/metadata/route.ts    # 公开页面元数据读取
  creator/[id]/page.tsx    # 博主个人页路由
  following/page.tsx       # 关注列表路由
  globals.css              # 页面样式和响应式布局
components/VideoHub.tsx    # 三个页面、表单、筛选、备份等交互
lib/douyin-browser.ts      # 使用本机浏览器读取抖音主页投稿
lib/feed-context.tsx       # 跨路由共享的客户端数据状态
lib/feed-logic.ts          # 最近更新过滤和视频排序逻辑
lib/feed-storage.ts        # 使用 IndexedDB 保存大批量关注与视频数据
lib/feed-types.ts          # 关注与视频数据结构
scripts/                   # 本机抓取服务准备、凭据迁移、启动、停止与检查脚本
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
