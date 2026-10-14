# Bilibili CDN Picker

面向 iOS Surge 的 B 站点播 CDN 测速与选择模块。它用当前正在播放的视频或音频资源，对候选 CDN 做分阶段 Range 测速，确认足够快的节点后，只把同一资源后续的媒体请求改写到该节点。

当前版本 **v0.4.0** 增加 Surge 本机网页控制台：[打开 CDN Picker](https://bcp.test/)。先更新并启用模块，再在手机 Safari 打开；可添加到主屏幕。不需要 JSBox、远程后端或开放 Surge 管理端口。

136 项自动化测试覆盖核心逻辑与模拟 Surge 构建产物；网页已完成本地浏览器交互检查。手机反馈确认 v0.3.3 本轮测试无内存告警，但这不等于所有网络条件都不会超限。v0.4.0 的 Safari 本地域名拦截、主屏幕启动和任务生命周期仍需按 [实机清单](docs/runtime-experiments.md) 验收。

## 手机看不到面板或命中记录时

`BiliBili → DIRECT` 表示直连出口，不妨碍本模块改写 CDN 主机。请求已完成且有下载字节时，速率栏的 `0 B/s` 不代表没有传输数据。截图中的 HTTPS Akamai `/upgcxcode/…m4s` 本来就符合匹配范围，不能把它未见备注归因于 HTTP 支持缺失。

v0.3.2 将 `DEBUG` 同时连接到 Surge 原生脚本 `debug` 参数；命中的媒体请求会输出不含签名的 `router_matched` 标记。另补充 HTTP 80 媒体请求和限定主机的 HTTP 引擎声明，HTTPS 请求不会降级为 HTTP。

`Home → Modify → Scripting` 是主配置的编辑入口，不能把它当作合并模块后的运行时脚本清单，也不能因为列表为空就判定模块脚本未加载。模块设置叠加在主配置之上，不通过主配置 UI 编辑，参见 [Surge 模块说明](https://manual.nssurge.com/profile/module.html)。v0.4.0 优先使用 Safari 网页执行快速选择；通过快捷指令选择 `BiliCDN-Diagnostics` 可查看状态。编辑器运行只是已载入正确代码与参数后的备用方式，不要求模块脚本出现在 Modify 列表中。

若模块已启用但找不到脚本和面板，先停用旧版，再安装[无参数诊断模块](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.diagnostic.sgmodule)。该模块固定手动模式、SG 和调试开关，去掉参数替换，并提供无需脚本运行的静态 `BCP v0.4.0 已加载` 标记。不要同时启用普通版和诊断版。静态标记仍不出现时继续核对模块启用状态和面板授权；静态与动态面板卡片出现只证明面板声明生效；v0.4.0 网页显示版本、网络和样本状态才是新的操作验收入口。

## 工作方式

| 脚本 | 类型 | 职责 |
| --- | --- | --- |
| `request-router.js` | http-request（JSC） | 识别媒体请求，按缓存决策改写主机和 Host，节流保存样本；不测速、不等待 |
| `web-control.js` | http-request（WebView） | 在 `bcp.test` 返回网页、同源状态 API、设置及显式测速任务 |
| `control-panel.js` | 面板 / generic（WebView） | 面板只读并提示网页入口；保留快捷指令兼容入口 |
| `discovery-runner.js` | cron（WebView） | 快捷指令入口、自动模式任务及低频后备调度 |
| `response-observer.js` | http-response（JSC） | 只看状态码，记录改写后出现的 403/404/429/5xx，让后续请求退回备选或原生节点 |
| `network-event.js` | network-changed 事件 | 递增网络代次，使进行中的任务放弃跨网络提交 |

快速选择的流程：原生节点预检 → 不超过 20 个候选的 128 KiB 粗筛（iOS 最多 2 并发，动态超时）→ 前 3 名 1 MiB 复筛 → 赢家再做一次 1 MiB 确认，取两次中的较低值。确认成绩达到目标（默认 80 Mbps）即停止；低于目标但可播放时先采用，再在预算内扩展候选。完整探索尝试覆盖全量候选，前 20 名复筛，前 5 名做 4 MiB 确认；在 60 秒内为后两阶段预留时间，未完成全量覆盖时明确标记部分探索。

改写只替换 URL 的主机部分，路径与 query 原样保留；每条资源决策默认 10 分钟有效，且不超过签名的 `deadline`。没有当前资源的确认结果时，请求保持原样。

## 安装

手机直接安装：[远程模块](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.remote.sgmodule) · [一键导入 Surge](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fpanelatta%2Fbilibili-cdn-picker%2Fmain%2Fsurge%2FBilibiliCDNPicker.remote.sgmodule)。在 Surge 的模块管理中选择通过 URL 安装，粘贴远程模块地址并启用即可，无需复制本地 JS 文件。远程版脚本固定到已验证提交 `2810b3c9d0d00924477eea9199d5bad115acb3a7`（v0.3.3）。

若旧链接导入时报 `Malformed argument declaration … PROBE_POLICY:`，重新获取修正后的远程模块；无默认值的声明已改为 `PROBE_POLICY`，参数仍可留空。

第一次使用先完成[手机首轮验证](docs/runtime-experiments.md#手机首轮验证)，再考虑开启自动模式。以下为手工部署方式：

1. 准备脚本。项目已包含构建好的 `surge/` 目录；修改源码后运行 `node tools/build.mjs` 重新生成。
2. 选择一种安装方式：
   - 本地模块：把 `surge/` 中的本地模块及 6 个 JS 文件复制到 Surge 配置目录（通常为 iCloud Drive 的 Surge 文件夹），在 Surge 的模块列表中启用 Bilibili CDN Picker。
   - 远程模块：把 `surge/` 发布到可访问的 HTTPS 地址，运行 `node tools/build.mjs --base-url https://example.com/path/surge/`，然后在 Surge 中安装生成的 `surge/BilibiliCDNPicker.remote.sgmodule` 的 URL。
3. 在 Surge 中生成并信任 MITM 证书，开启 MITM。模块会追加本机控制台域名 `bcp.test` 以及 `upos-*.bilivideo.com`、`cn-*.bilivideo.com`、`ec-*.bilivideo.com`、`upos-*.akamaized.net`。
4. 停用 Biliverse Redirect 等会改写同类媒体 URL 的规则；同一请求只会执行第一个匹配的请求脚本。

## 使用

1. 在 Surge 更新原有模块，确认版本为 v0.4.0，只启用原版或诊断版其中之一。MITM 与脚本功能保持开启。
2. Safari 打开 [https://bcp.test](https://bcp.test/)。此地址由本机模块返回页面；关闭 Surge 或停用模块时不能使用。
3. 在 B 站固定画质播放约 10 秒，再于两分钟内回到网页。选择“视频”，点击“优化当前视频”，保持网页在前台等待结果。音频需要单独选择；网页一次只测所选资源。
4. 查看当前选择、确认速率、停止原因、有效／已测／候选数量与额外流量。原生线路已足够快时保留原生；粗筛快但确认失败不算优化成功。
5. 返回同一视频、保持画质，拖动到未缓冲位置。只有后续新请求会使用选择，已有连接不会强行中断。测速结束后再比较起播、缓冲和拖动恢复时间。
6. 确有需要再点“探索更多节点”：目标预算 100 MiB／所选资源、约 60 秒，结果可能仅覆盖部分候选。可随时“停止测速”，在途请求结束后任务锁才释放。
7. Safari 分享菜单 → 添加到主屏幕；以后从图标打开。它依赖 Surge 运行，不是离线应用。

任务运行时每约 2 秒更新状态，空闲时每约 5 秒更新；隐藏网页后暂停轮询。刷新网页和 Surge 的只读面板都不会启动测速。网页设置保存在本机，优先于模块参数；模块更新不会重置这些设置。诊断日志开关控制脚本自身日志，Surge 请求 Notes 的原生调试仍由模块 `DEBUG` 参数决定。

网页出现连接错误时检查模块是否更新、`bcp.test` 是否在生效 MITM 范围、Surge CA 是否信任，以及是否有更靠前的通配脚本抢先处理请求。不要通过关闭证书验证或开放公网管理端口解决。更详细的判定见 [网页实机验收](docs/runtime-experiments.md#v040-网页实机验收)。

也可以在 iOS 快捷指令中运行 `BiliCDN-Runner` 脚本，并传入参数：

| 参数 | 作用 |
| --- | --- |
| `quick` | 对当前待测资源运行快速选择 |
| `quick-force` | 即使已有有效决策也重新选择 |
| `full` | 完整探索 |
| `stop` | 让进行中的任务停止派发 |
| `pause` / `resume` | 暂停或恢复改写（暂停时也不测速） |
| `clear-network` | 清空当前网络的排行与决策 |
| `clear-all` | 清空除配置外的全部数据 |

## 配置

启用模块时可设置以下参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `ENABLED` | `true` | 总开关；关闭后所有请求原样放行 |
| `MODE` | `manual` | `adaptive` 会在发现新资源时自动触发测速，需先完成生命周期实验 |
| `REGION` | `SG` | 地区推荐表：`SG`、`TW`、`HK`、`JP`、`AU`、`US` 或 `NONE` |
| `TARGET_MBPS` | `80` | 未知码率时的“足够快”目标 |
| `HISTORY_POLICY` | `conservative` | `optimistic` 会把本网络历史最佳节点直接用于尚未测速的资源，失败后退回原生 |
| `CELLULAR_DISCOVERY` | `false` | 允许蜂窝网络下的自动任务和完整探索；手动快速选择始终可用，蜂窝预算 4 MiB |
| `ROUTE_REVISION` | `default` | 更换代理出口后修改，使测速历史按出口隔离 |
| `PROBE_POLICY` | 空 | 测速请求使用的 Surge 策略名；留空则按规则匹配，应与播放实际走的策略一致 |
| `DEBUG` | `false` | 输出脱敏日志，并启用 Surge 请求备注中的原生脚本调试 |

其余参数（并发、预算、超时、TTL、迟滞等）可在 Surge 的脚本持久化数据中写入 `BiliCDNPicker.config`，值为 JSON 对象，例如：

```json
{ "quickTargetMiB": 8, "discoveryConcurrency": 6, "preferredHosts": ["cn-hk-eq-01-14.bilivideo.com"] }
```

远程模块默认脚本基地址由 `tools/remote-module.json` 固定，正常构建会同时生成两个模块；自定义发布可使用 `--base-url` 覆盖，检查时传入相同参数。

完整的键名、默认值和取值范围见 [src/core/config.js](src/core/config.js)。无效值会回落到默认值，并在面板显示警告。

## 限制

- 只处理 HTTP 80／HTTPS 443 默认端口的 `/upgcxcode/…/*.m4s` 点播分段，主机限于 `upos-*`、`cn-*`、`ec-*.bilivideo.com` 和 `upos-*.akamaized.net`。直播、BStar、PCDN/MCDN、DRM 资源一律直通。
- 测速基于完成回调：超时请求的实际流量不可观测，按保守预留计入；服务器忽略 Range 时可能超出预算。预算是目标值，不是硬上限。
- 回退只使用通过确认的备选。响应观察使用请求 ID 关联实际目标及原网络，缺少可靠关联时跳过；失败记录按网络与出口隔离。
- 响应观察只能影响之后的请求，已经失败的请求依赖 App 自身重试。它不能发现没有响应头的超时、播放器停滞或解码问题。
- 有限采样与提前停止不保证找到全局最快节点，面板只报告“本轮已测”的结果。
- 模块不修复解码、渲染或浏览器问题。
- 数据只保存在本机：网络标识以加盐摘要保存，日志不记录签名 URL、Cookie、SSID 或 BSSID，不上传遥测。

## 升级到 v0.4.0

两种远程模块使用同一套修复后的脚本，只有默认参数与诊断显示不同：

- [原版固定更新地址](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.remote.sgmodule)：可配置参数，默认关闭调试。
- [诊断版固定更新地址](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.diagnostic.sgmodule)：无参数替换，默认手动、SG、调试开启，包含静态“已加载”标记。

来源 URL 包含 `/main/` 的模块可以在 Surge 模块管理中更新。之前发出的含 40 位提交 SHA 的 URL 是不可变快照，无法通过修改 main 更新；需将安装来源换成上述固定地址一次，或停用旧条目后重新导入。两版不要同时启用。以后更新同一地址即可取得最新模块，模块内部的 JS 地址会固定到该版提交，避免脚本混版。

本版将交互迁移到网页，面板仅保留只读入口。原定采样大小、Top 20／5、候选扩展、100 MiB 目标预算与 60 秒总时限保持不变；完整探索增加分阶段时间预留。新增网页 API 鉴权、视频／音频隔离、并行查看与停止及超时节点回归测试。

## 从 v0.3.0 升级的缓存处理

更新模块与 `surge/` 中全部脚本。旧版未分网络的失败缓存会自动忽略，旧决策中未标明已确认的备选会被丢弃。五项审查修复与回归范围见[开发文档 §18.4](docs/development-design.md#184-审查修复与升级行为)。

## 开发

需要 Node.js 18 或更高版本，无第三方依赖。

```sh
npm test                  # 单元测试与集成测试
node tools/preview-web.cjs # 本机交互预览，使用模拟网络，访问 127.0.0.1:8787
node tools/build.mjs      # 生成 surge/ 下的脚本与模块
npm run check             # 校验脚本、本地与远程模块格式和构建一致性，并运行测试
```

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 配置、网络画像、候选与短名单、Range 探测、滚动调度、预算、动态淘汰线、选择与冷却、持久化 |
| `src/media/` | URL 字节保持解析、Host 处理、主机校验、`upos-m4s` 资源适配器 |
| `src/app/` | 请求路由、响应观察、测速任务、网页 API、面板、网络事件 |
| `src/web/` | 无外部依赖的控制台页面、样式及浏览器脚本 |
| `src/adapters/surge/` | Surge 全局对象封装 |
| `src/entries/`、`src/module/` | 构建入口与模块模板 |
| `data/` | 候选清单及[来源说明](data/NOTICE.md) |
| `tests/` | 单元测试、模拟 CDN 与 Surge 运行时的集成测试 |
| `tools/` | 构建、候选清单导入、对话存档提取 |

## 文档

- [开发设计文档](docs/development-design.md)：需求、架构、算法、缓存、预算、回退与验收，§18 记录实现状态与设计取舍。
- [M0 实机能力验证清单](docs/runtime-experiments.md)
- [候选清单来源与许可](data/NOTICE.md)：清单派生自 bilibili-cdn-switcher，仅限个人非商业使用。
- [原始对话存档](docs/sources/shared-chat.md) 与 [结构化存档](docs/sources/shared-chat.json)

重新提取对话存档：

```sh
python3 tools/extract_shared_chat.py /path/to/saved-share.html docs/sources
```

提取工具只解析数据，不运行网页中的 JavaScript；页面格式变更时可能需要调整。
