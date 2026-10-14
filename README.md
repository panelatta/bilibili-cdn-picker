# Bilibili CDN Picker

面向 iOS Surge 的 B 站点播 CDN 测速与选择模块。它用当前正在播放的视频或音频资源，对候选 CDN 做分阶段 Range 测速，确认足够快的节点后，只把同一资源后续的媒体请求改写到该节点。

当前版本 v0.3.2 是首版实现（手动探索版），通过 120 个自动化测试，包括在模拟 Surge 运行时中执行构建产物的集成测试。iOS、Surge 与 Bilibili App 实机上的运行时能力尚未验证；正式使用前请按 [M0 实机能力验证清单](docs/runtime-experiments.md) 逐项确认。

## 手机看不到面板或命中记录时

`BiliBili → DIRECT` 表示直连出口，不妨碍本模块改写 CDN 主机。请求已完成且有下载字节时，速率栏的 `0 B/s` 不代表没有传输数据。截图中的 HTTPS Akamai `/upgcxcode/…m4s` 本来就符合匹配范围，不能把它未见备注归因于 HTTP 支持缺失。

v0.3.2 将 `DEBUG` 同时连接到 Surge 原生脚本 `debug` 参数；命中的媒体请求会输出不含签名的 `router_matched` 标记。另补充 HTTP 80 媒体请求和限定主机的 HTTP 引擎声明，HTTPS 请求不会降级为 HTTP。

面板依赖 Surge 的显示位置、功能授权和生效配置，不作为唯一入口。可以从脚本编辑器手动运行 `BiliCDN-Diagnostics` 查看版本、网络和样本；运行 `BiliCDN-Panel` 做快速选择，`BiliCDN-Explore` 做完整探索。手动运行结果会写入日志并发送本机通知；自动刷新不测速、不通知。

若模块已启用但找不到脚本和面板，先停用旧版，再安装[无参数诊断模块](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.diagnostic.sgmodule)。该模块固定手动模式、SG 和调试开关，去掉参数替换，并提供无需脚本运行的静态 `BCP v0.3.2 已加载` 标记。不要同时启用普通版和诊断版。静态标记仍不出现时继续核对当前配置、模块加载及面板授权，不能仅凭界面列表为空确定根因。

## 工作方式

| 脚本 | 类型 | 职责 |
| --- | --- | --- |
| `request-router.js` | http-request（JSC） | 识别媒体请求，按缓存决策改写主机和 Host，节流保存样本；不测速、不等待 |
| `control-panel.js` | 面板（WebView） | 展示状态；点按刷新按钮时运行快速选择或完整探索 |
| `discovery-runner.js` | cron（WebView） | 快捷指令入口、自动模式任务及低频后备调度 |
| `response-observer.js` | http-response（JSC） | 只看状态码，记录改写后出现的 403/404/429/5xx，让后续请求退回备选或原生节点 |
| `network-event.js` | network-changed 事件 | 递增网络代次，使进行中的任务放弃跨网络提交 |

快速选择的流程：原生节点预检 → 不超过 20 个候选的 128 KiB 粗筛（滚动并发 4，动态超时）→ 前 3 名 1 MiB 复筛 → 赢家再做一次 1 MiB 确认，取两次中的较低值。确认成绩达到目标（默认 80 Mbps）即停止；低于目标但可播放时先采用，再在预算内扩展候选。完整探索覆盖全部 299 个候选，前 20 名复筛，前 5 名做 4 MiB 确认。

改写只替换 URL 的主机部分，路径与 query 原样保留；每条资源决策默认 10 分钟有效，且不超过签名的 `deadline`。没有当前资源的确认结果时，请求保持原样。

## 安装

手机直接安装：[远程模块](https://raw.githubusercontent.com/panelatta/bilibili-cdn-picker/main/surge/BilibiliCDNPicker.remote.sgmodule) · [一键导入 Surge](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fpanelatta%2Fbilibili-cdn-picker%2Fmain%2Fsurge%2FBilibiliCDNPicker.remote.sgmodule)。在 Surge 的模块管理中选择通过 URL 安装，粘贴远程模块地址并启用即可，无需复制本地 JS 文件。远程版脚本固定到已验证提交 `a425c80fe70f216d05a7fefea3123824217e47af`（v0.3.1）。

若旧链接导入时报 `Malformed argument declaration … PROBE_POLICY:`，重新获取修正后的远程模块；无默认值的声明已改为 `PROBE_POLICY`，参数仍可留空。

第一次使用先完成[手机首轮验证](docs/runtime-experiments.md#手机首轮验证)，再考虑开启自动模式。以下为手工部署方式：

1. 准备脚本。项目已包含构建好的 `surge/` 目录；修改源码后运行 `node tools/build.mjs` 重新生成。
2. 选择一种安装方式：
   - 本地模块：把 `surge/` 中的 6 个文件复制到 Surge 配置目录（通常为 iCloud Drive 的 Surge 文件夹），在 Surge 的模块列表中启用 Bilibili CDN Picker。
   - 远程模块：把 `surge/` 发布到可访问的 HTTPS 地址，运行 `node tools/build.mjs --base-url https://example.com/path/surge/`，然后在 Surge 中安装生成的 `surge/BilibiliCDNPicker.remote.sgmodule` 的 URL。
3. 在 Surge 中生成并信任 MITM 证书，开启 MITM。模块会追加 `upos-*.bilivideo.com`、`cn-*.bilivideo.com`、`ec-*.bilivideo.com`、`upos-*.akamaized.net`。
4. 停用 Biliverse Redirect 等会改写同类媒体 URL 的规则；同一请求只会执行第一个匹配的请求脚本。

## 使用

1. 在 B 站 App 播放视频约 10 秒，让模块采集到新鲜样本（最长 2 分钟有效）。
2. 在 Surge 策略页的“B站 CDN”面板点按刷新按钮，运行快速选择。通常数秒内完成；面板显示所选节点、确认速度、覆盖率和测速流量。
3. 继续播放即可，后续分段请求会走所选节点。新视频、换画质、决策过期或整条回退链失效后需要重新选择（自动模式下满足退避条件后由模块触发）。
4. 在 Wi-Fi 下可点按“B站 CDN · 完整探索”面板，对当前视频运行全量探索，目标预算 100 MiB、最长约 60 秒。

面板的定期刷新只读取缓存，不会下载任何数据。

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

## 升级到 v0.3.1

更新模块与 `surge/` 中全部脚本。旧版未分网络的失败缓存会自动忽略，旧决策中未标明已确认的备选会被丢弃。五项审查修复与回归范围见[开发文档 §18.4](docs/development-design.md#184-审查修复与升级行为)。

## 开发

需要 Node.js 18 或更高版本，无第三方依赖。

```sh
npm test                  # 单元测试与集成测试
node tools/build.mjs      # 生成 surge/ 下的脚本与模块
npm run check             # 校验脚本、本地与远程模块格式和构建一致性，并运行测试
```

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 配置、网络画像、候选与短名单、Range 探测、滚动调度、预算、动态淘汰线、选择与冷却、持久化 |
| `src/media/` | URL 字节保持解析、Host 处理、主机校验、`upos-m4s` 资源适配器 |
| `src/app/` | 请求路由、响应观察、测速任务、面板、网络事件 |
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
