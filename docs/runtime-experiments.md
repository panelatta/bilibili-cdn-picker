# M0 实机能力验证清单

本清单对应[开发设计文档](development-design.md) §13.1。代码中的 105 个自动化测试只覆盖逻辑与构建产物；下列行为依赖 iOS、Surge 和 Bilibili App 的真实运行时，必须在目标设备上逐项确认。每项都记录 iOS、Surge、Bilibili App 版本及网络类型。

## 准备

1. 备份 Surge 配置，停用 Biliverse Redirect 等会改写同类媒体 URL 的模块或脚本。
2. 安装模块（见 [README](../README.md#安装)），模块参数设 `DEBUG=true`，确认 MITM 证书已信任。
3. 在 Surge 的请求查看器中筛选 `bilivideo`、`akamaized`；脚本日志在 Surge 的脚本日志页查看，所有行以 `[BiliCDN]` 开头。
4. 持久化数据键名均以 `BiliCDNPicker.` 开头，可在 Surge 的脚本数据查看器中检查。

## 实验与判定

| 实验 | 操作 | 通过证据 | 未通过时 |
| --- | --- | --- | --- |
| 媒体请求识别 | 播放一个 UGC 视频 20 秒 | 请求记录中 `/upgcxcode/…m4s` 的请求带 `BiliCDN-Router` 脚本标记；`BiliCDNPicker.samples` 出现视频与音频样本；其他 B 站接口无标记 | 把实际 URL 族加入新适配器前保持直通，不放宽 pattern |
| Host 与 URL 改写 | 面板点按快速选择后继续播放 | 请求记录显示新主机，`Host` 与 URL 主机一致，路径与 query 未变；响应为 206 | 用快捷指令参数 `pause` 暂停改写或停用模块，保存失败请求记录后再修正适配器 |
| Range 行为 | 查看测速请求（请求头含 `X-BCP-Probe`） | 状态 206、`Content-Range` 与请求区间一致；面板流量行无“超出 Range”计数 | 对出现 200 或错位区间的节点记录型号与时段，确认冷却生效 |
| timeout 精度 | 在 `BiliCDNPicker.config` 写入 `{"coarseTimeoutMs":300}` 后点按，再恢复 | 超时请求在约 0.3 秒处结束，而非 1 秒或 5 秒 | 把 `coarseMinTimeoutMs` 调到实测最小精度 |
| 并发上限 | 完整探索时观察请求记录 | 同时进行的测速请求不超过 8，任务能结束 | 降低 `discoveryConcurrency` |
| 独立任务生命周期 | `MODE=adaptive` 后播放新视频 | 面板“自动触发”时间更新，随后 `BiliCDNPicker.lastRun` 的 `trigger` 与结果更新，同一视频后续请求被改写 | 保持 `MODE=manual`，仅用面板或快捷指令触发 |
| 脚本递归 | 运行一次快速选择 | 日志中没有 `probe re-entered`；若有，确认测速请求离开设备前已去掉 `X-BCP-Probe` 且未被改写 | 若标记头外泄且服务端拒绝，设置 `probeMarker:false` 并重新评估 |
| 出口一致性 | 分别在 DIRECT 与代理策略下播放并测速 | 请求记录中测速与播放走同一策略；更换出口后修改 `ROUTE_REVISION` 会形成新的网络画像 | 设置 `PROBE_POLICY` 为播放实际使用的策略 |
| 网络切换 | 完整探索进行中切换 Wi-Fi 或蜂窝 | `lastRun` 中出现 `commit_rejected` 或停止原因“网络已变化”，新网络没有旧决策 | 保持手动模式，禁止跨切换提交 |
| 任务互斥 | 完整探索进行中再点按快速选择 | 面板显示“已有任务在运行”，没有重叠的测速请求 | 只保留一个手动入口 |
| 响应观察归属 | 选出 winner 后，临时用 Surge Map Local 让该主机的 `/upgcxcode/` 请求返回 403，继续播放；结束后删除该规则 | 请求与响应具有相同 `$request.id`，`BiliCDNPicker.request.*` 有该请求的实际目标及原网络；`failures.networks[networkKey]` 只记录对应目标，后续请求退回已确认备选或原生 | ID 缺失、关联槽过期或不匹配时应跳过观察；不得恢复当前路由推断。Map Local 若先于脚本匹配而无法复现，等待自然失败样本 |

## 审查修复的实机补充验证

- 播放原生请求尚在进行时选出新节点；原生请求随后失败，只记录原生失败，不将新 winner 加入失败表。
- 测速标记在请求脚本中被删除后，其响应仍通过请求 ID 被识别为 probe，不产生播放失败记录。
- Wi-Fi 请求仍在进行时切到蜂窝；旧响应产生的失败只出现在旧网络的 `failures.networks` 中。
- 所有已确认目标失效后，面板快速选择可以重测；自动模式须等待 `retryAfterFailureSeconds`（默认 300 秒）并取得新鲜样本，不能每次请求都启动扫描。
- 热路径现在额外写入有界请求关联槽，必须重新测量附加延迟。模拟测试结果不能替代这一项。

## 附加延迟测量

发布门槛要求热路径 P95 不超过 100 ms。关闭与开启模块各播放同一视频 5 分钟，比较请求记录中媒体请求的脚本耗时；样本少于 50 个时不下结论。

## 记录模板

```text
日期 / iOS / Surge / Bilibili App 版本：
网络类型与出口策略：
实验：
操作步骤：
观察到的证据（截图或日志行）：
结论：通过 / 未通过 / 无法判断
后续动作：
```
