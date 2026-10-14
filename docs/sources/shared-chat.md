# 新加坡 B站网页版卡顿解决方案 原始对话存档

来源：[ChatGPT 分享页面](https://chatgpt.com/share/6acf432d-c9ac-83ec-82e4-b3eafbdb45c3)。抓取日期：2026-10-14。

保留当前分享分支的用户提问及助手最终回复，按顺序排列；不包含系统消息、内部推理、工具输出及过程播报。网页引用标记已转为可点击链接，原始文本另存于 JSON 的 source_text 字段。以下为历史对话原文，技术判断和版本信息不代表已经验证。

## 第 1 轮 用户

现在 b 站网页版在新加坡使用时，经常会中间出现画面卡住、还有声音之类的问题，有没有什么解决方案？广泛调研一下

## 第 1 轮 ChatGPT

有，而且我查了一圈以后，结论比“B站海外线路烂”更具体一点：

**现在在新加坡看 B 站网页版，确实存在一个相当明确的海外 CDN 分配/线路问题；而如果你是 macOS + Chrome，还叠加了一个最近出现的“视频画面停止/黑屏但声音继续”的 Chrome 渲染问题。** 你描述的“中间画面卡住，但还有声音”，这两种原因都能造成，而且可以很容易区分。 （[Reddit](https://www.reddit.com/r/Bilibili/comments/1vire1y/finally_fix_bilibili_buffering_issues_in_singapore/?utm_source=chatgpt.com)、[GitHub](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1803)）

## 先说我最推荐的解决办法

目前最值得试的是这个第三方扩展：

**Overseas Video Speedup for bilibili**

它最初就是作者因为**台湾/新加坡 B 站网页端 CDN 很慢**做出来的，现在已经扩展为全球版本。原理不是“开 VPN”，而是保持你的新加坡 IP 不变，只把 B 站给播放器的 `.m4s` 视频/音频 URL 换到另一个兼容的 Bilibili CDN host。 （[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)、[Reddit](https://www.reddit.com/r/Bilibili/comments/1vire1y/finally_fix_bilibili_buffering_issues_in_singapore/?utm_source=chatgpt.com)）

Chrome 商店目前显示：

- 版本 **2.3.0**
- **2026 年 10 月 10 日刚更新**
- 约 **6,000 用户**
- **99 个评分，5.0**
- 开源
- 内置约 **300 个 CDN 节点**
- 可以针对当前视频实际测速
- 可以自动选最快节点
- 当前节点坏掉时可以自动 fallback
- 开发者声明不收集用户数据，设置保存在本机。 （[Chrome Web Store](https://chromewebstore.google.com/detail/dfaddcffoondcendifiljhdbdagebgch?utm_campaign=readme&utm_content=en&utm_medium=referral&utm_source=github)）

[Chrome Web Store：Overseas Video Speedup for bilibili](https://chromewebstore.google.com/detail/dfaddcffoondcendifiljhdbdagebgch?utm_source=chatgpt.com)

[GitHub 源码](https://github.com/a0972199950/bilibili-cdn-switcher?utm_source=chatgpt.com)

Firefox 也有正式 Add-ons 版本，而且权限基本就是访问 `bilibili.com`；Mozilla 页面显示 2.3.0 也是 10 月 10 日更新。 （[Mozilla Add-ons](https://addons.mozilla.org/addon/bilibili-cdn-switcher?utm_campaign=readme&utm_content=en&utm_medium=referral&utm_source=github)）

### 为什么这个东西看起来不是“玄学加速器”

它解决的是 B 站一个很具体的问题。

B 站网页播放高画质视频时通常走 **DASH**：

```text
video.m4s ──────┐
                ├─ 浏览器同步播放
audio.m4s ──────┘
```

也就是说，**视频和音频实际上是两个独立的流**。B 站的播放 API 返回的也是独立的 `dash.video[]` 和 `dash.audio[]` URL。 （[GitHub](https://github.com/suyi-9527/bilibili_video/blob/main/API.md?utm_source=chatgpt.com)、[GitHub](https://github.com/manfred-exz/bili_textify/blob/master/docs/BILI_API_CONCEPTS.md?utm_source=chatgpt.com)）

所以会出现一个很反直觉、但完全合理的现象：

> 视频 CDN 那条连接卡死  
> ↓  
> 画面停在某一帧  
>   
> 音频 CDN / 已缓存音频仍然正常  
> ↓  
> 声音继续播放

所以**“还有声音”并不能证明网络没问题**。

2026 年有人专门测试了 B 站海外 CDN，发现 B 站给海外账号返回的往往只是少数几个海外 mirror，例如：

- `upos-hz-mirrorakam.akamaized.net`
- `upos-sz-mirroraliov.bilivideo.com`
- `upos-sz-mirrorcosov.bilivideo.com`

这些节点在某些线路上的单连接吞吐可以低得离谱，而换成另一个 B 站 CDN host 后速度直接恢复。并且哪个节点最快会随时间变化，所以**动态测速/切 CDN 比硬编码某个 host 更靠谱**。 （[GitHub](https://github.com/chrisliu298/bilibili-cdn-fix?utm_source=chatgpt.com)）

更直接的是，今年 8 月就有人在 Reddit 发帖：

> “Does Bilibili 4K... or even 720p... constantly buffer like crazy for you too?”

而帖子标题直接就是：

**“Finally Fix Bilibili Buffering Issues in Singapore”**

解决方案正是上面这个 CDN Switcher。 （[Reddit](https://www.reddit.com/r/Bilibili/comments/1vire1y/finally_fix_bilibili_buffering_issues_in_singapore/?utm_source=chatgpt.com)）

所以你在新加坡遇到这事，并不孤立。

---

# 但你这个“画面卡住，声音还在”还要排除第二个问题

最近还有一个非常巧合的 bug。

**2026 年 10 月 3 日**有人提交了：

> macOS 26.6.2 + Apple Silicon + Chrome 154  
> Bilibili 全屏播放时画面变黑，但声音继续。

更关键的是：

- Safari 同一个视频正常；
- Chrome 窗口模式正常；
- 音频、播放进度、buffer 都正常；
- 退出全屏后画面立刻恢复；
- AVC / HEVC / AV1 都可能发生；
- 无痕模式、关闭插件也会发生；
- 开/关硬件加速都没解决。 （[GitHub](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1803)）

这非常像 Chrome/macOS 的 video surface/compositor 路径出了问题，而不是 B 站 CDN。

所以你可以用下面这个方法，**不到五分钟就能判断自己到底是哪一种。**

---

# 我建议你这样诊断

在 B 站播放视频的时候：

**右键视频 →「视频信息统计」**。

B站自己的播放器目前就会显示诸如：

- Encoder / Codec
- Stream Host
- Buffer Length
- Decoded Frames
- Download Bitrate

这些指标。 （[Bilibili](https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=27585365&utm_source=chatgpt.com)）

等下一次“画面停住但声音继续”时，不要马上刷新。

### 情况 A：Buffer Length 一路掉到接近 0

并且 Download Bitrate 变成：

```text
0
几十 KB/s
几百 KB/s
```

或者明显低于视频码率。

**→ 基本就是 CDN / 网络问题。**

尤其 Host 如果看到这种：

```text
upos-sz-mirroraliov.bilivideo.com
upos-hz-mirrorakam.akamaized.net
...
```

那就更加可疑。

这种情况我会直接安装上面那个 **Overseas Video Speedup**。

---

### 情况 B：Buffer 还有十几秒甚至几十秒

例如：

```text
Buffer Length: 32s
Download Bitrate: 40 Mbps
```

但是：

```text
画面不动
声音继续
```

**→ 网络基本无罪。**

这时看 `Decoded Frames`：

如果帧数不再增加，通常是：

- decoder 卡住；
- GPU video decode 路径；
- MediaSource / decoder pipeline。

如果：

**Decoded Frames 仍然增加，但屏幕上的画面不动**

那更像：

- Chrome compositor；
- video overlay；
- GPU rendering；
- macOS fullscreen video surface。

尤其如果：

> 退出全屏 → 画面瞬间正常

那我几乎会直接把矛头指向前面那个 Chrome/macOS bug。 （[GitHub](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1803)）

---

# 新加坡环境，我建议按这个顺序处理

### ① 先装 CDN Switcher

这是我认为**收益最大、改动最小**的一步。

装完以后打开一个平时特别容易卡的视频。

扩展现在可以针对**当前这个视频、当前清晰度**测试各个 CDN，而不是拿 ping 猜。

让它：

**Singapore → 测速 → 最快节点**

然后开启：

**Automatic failover**

它甚至会检测：

> 一段时间视频进度没走，而且线路也没有数据

然后自动切到 B 站提供的 backup CDN；backup 也死了才提示你换另一条线路。 （[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

这比以前那种：

```text
/etc/hosts
手动绑一个 upos-xxx
```

靠谱得多。

---

# ② B站播放策略先强制 AVC 测试

播放器：

**设置 → 更多播放设置 → 播放策略**

先改成：

**AVC / H.264**

不要 Default / AV1 / HEVC。

B站自己现在也把：

```text
默认
AV1
HEVC
AVC
```

作为画面异常时的解码切换选项。 （[Bilibili](https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=27585365&utm_source=chatgpt.com)）

如果：

> Default 会卡  
> AVC 连续看一个小时没卡

那问题很可能和 codec / hardware decode 有关。

之后可以再试：

```text
HEVC
↓
AV1
```

看具体是哪一种有问题。

B站官方也明确建议遇到卡顿、花屏或画面异常时调整播放策略，并确保 Chromium 的 GPU 加速正常开启。 （[Bilibili](https://www.bilibili.com/blackboard/help.html?utm_source=chatgpt.com)、[Bilibili](https://www.bilibili.com/blackboard/era/KJreCa9Qz0nocM94.html?utm_source=chatgpt.com)）

---

# ③ 如果你是在 Mac 上，用 Safari 做一次 A/B test

这个非常有价值。

同一个 BV：

```text
Chrome
Safari
```

同时：

```text
同一个网络
同一个账号
同一个画质
同一个时间
```

如果：

**Chrome 卡画面 + 声音正常**

而：

**Safari 完全不发生**

那就不是 Singtel，也基本不是 B 站 CDN。

尤其如果只在全屏发生，目前已经有几乎一模一样的 macOS 26.6.2 + Chrome 报告。 （[GitHub](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1803)）

这种情况下我反而建议：

> 暂时直接 Safari 看 B 站。

没必要为了 B 站折腾一堆 Chrome flags。

---

# ④ 不要一上来关闭硬件加速

网上大量教程第一句都是：

> “关闭硬件加速！”

这里我反而不建议先这么做。

因为 B站官方当前的建议是：

**Chrome / Edge 开启 Graphics Acceleration。**

否则 HEVC 等格式有可能退回软件解码，CPU 占用反而暴涨。 （[Bilibili](https://www.bilibili.com/blackboard/help.html?utm_source=chatgpt.com)、[Bilibili](https://www.bilibili.com/blackboard/era/KJreCa9Qz0nocM94.html?utm_source=chatgpt.com)）

正确测试方法是：

```text
默认：GPU acceleration ON
        ↓
仍然稳定复现画面冻结
        ↓
OFF 一次做 A/B test
```

如果 OFF 马上不再出现，那么才说明 GPU path 有问题。

不过前面提到的 10 月 3 日那个 Chrome/macOS bug，报告者已经试过 ON/OFF，都没解决，所以如果你的症状和他完全一致，我会优先换 Safari，而不是折腾硬件加速。 （[GitHub](https://github.com/GoogleChrome/chrome-extensions-samples/issues/1803)）

---

# ⑤ 还可以注意一个比较坑的东西：B站 PCDN

近几年 B 站还有：

```text
mcdn.bilivideo.cn
*.mountaintoys.cn
```

这类 PCDN / MCDN 节点。

2026 年仍然有人反馈 B 站有时候会比较激进地把视频扔到这些节点，失败几次以后才 fallback 到商业 CDN。 （[GitHub](https://github.com/privacy-protection-tools/anti-AD/issues/1121?utm_source=chatgpt.com)、[GitHub](https://github.com/the1812/Bilibili-Evolved/discussions/5438?utm_source=chatgpt.com)）

如果你在统计信息或者 DevTools 里看到类似：

```text
xxxx.mcdn.bilivideo.cn:4483
xxxx.edge.mountaintoys.cn
```

并且正好就是它卡：

**建议换 CDN，而不是简单把整个域名 block 掉。**

因为今年 9 月已经有人测试发现，直接屏蔽：

```text
mcdn.bilivideo.com
mcdn.bilivideo.cn
szbdyd.com
mountaintoys.cn
```

会导致部分视频反而完全不能播放。 （[GitHub](https://github.com/privacy-protection-tools/anti-AD/issues/1121?utm_source=chatgpt.com)）

---

# ⑥ VPN/代理不是我的首选

理论上你可以：

```text
Singapore
  ↓
一个到中国线路很好的代理
  ↓
Bilibili
```

确实可能快很多。

海外 B站加速的老办法一直都有这么做。 （[Bilibili](https://www.bilibili.com/read/cv3118508/?utm_source=chatgpt.com)）

但相比 CDN rewrite，有几个缺点：

- B站会根据出口 IP 重新决定区域和 CDN；
- 某些数据中心 IP 容易触发风控；
- 有可能碰到 `412`；
- 番剧版权区可能发生变化；
- 流量还要绕代理。

所以现在有专门的 CDN Switcher 后，我觉得：

**CDN Switcher > VPN**

至少对于你这个单纯的播放卡顿问题是这样。

---

# 如果你愿意自己抓一下，甚至能 100% 判断

你是开发者的话，下一次卡住时可以开：

**Chrome DevTools → Network → 搜索 `m4s`**

通常会看到类似：

```text
xxxxx.m4s    206 Partial Content
xxxxx.m4s    206 Partial Content
xxxxx.m4s    Pending...
```

如果一个**视频流请求**卡在 Pending / Stalled / TTFB 很久，而音频流继续返回：

那就是：

> 视频 CDN 流卡死。

甚至可以在 Console 看一下 B站给你分了什么 host：

```js
[
  ...new Set([
    ...window.__playinfo__.data.dash.video.map(
      x => new URL(x.baseUrl).host
    ),
    ...window.__playinfo__.data.dash.audio.map(
      x => new URL(x.baseUrl).host
    ),
  ])
]
```

出现什么 `upos-xxx`，基本就能顺藤摸瓜了。

B站官方自己也有网页端网络检测页，帮助中心现在仍然推荐用它排查播放问题。 （[Bilibili](https://www.bilibili.com/blackboard/help.html?utm_source=chatgpt.com)）

[Bilibili 官方视频诊断工具](https://www.bilibili.com/blackboard/video-diagnostics.html?utm_source=chatgpt.com)

---

## 所以，针对你这个情况，我会这么做

按优先级就是：

1. **安装 Overseas Video Speedup for bilibili。**
2. 让它在新加坡环境下实际测速并选最快 CDN。
3. 开启 CDN failover。
4. B站播放策略暂时固定 **AVC**。
5. 如果仍发生“画面停、声音继续”，马上看 **Buffer Length + Decoded Frames**。
6. 同一个视频拿 **Safari** 对照。
7. 如果 Safari 正常而 Chrome 卡，尤其全屏才卡，直接按当前 Chrome/macOS bug 处理。
8. 如果 Safari 也卡，而且 Buffer 掉光，那还是 CDN。

综合我查到的近期报告，**如果你说的是“随机看到一半，画面忽然停住，声音还能继续一阵，过一会儿可能又恢复/必须拖一下进度条”——我目前更倾向于 CDN/DASH 视频轨卡住；如果是“全屏后画面直接冻住/黑掉，退出全屏立即恢复”——那更倾向于当前 Chrome/macOS 渲染 bug。**

你下次它卡的时候，把 B站右键 **「视频信息统计」那一小块截图给我**就够了。我可以直接根据 **codec、Video Host、Audio Host、buffer、decoded frames 和 download bitrate** 判断究竟是哪一层在抽风。

## 第 2 轮 用户

手机端访问 b 站卡顿呢，有什么方案？

## 第 2 轮 ChatGPT

有，而且手机端其实能处理，只是办法和网页版不同。**如果你指的是中国大陆版 Bilibili App 在新加坡播放视频频繁转圈/缓冲，我现在最推荐的是“手机端 CDN 重定向”，而不是单纯换 DNS。**

我查到一个很针对你这个场景的方案：最近有人专门整理了“海外 B 站”的手机端做法，核心也是把 App 被分配到的慢 CDN 改成实测更快的 Bilibili CDN。作者在 iPhone/iPad 上配置后称 4K 和拖动进度条都恢复流畅。（[GitHub](https://github.com/wronps/BilibiliAbroad)）

### iPhone / iPad：目前最靠谱的是 Biliverse Redirect

Biliverse 有一个维护中的 **BiliBili Redirect** 模块，本身的目的就是：

> 自定义重定向 Bilibili 视频源使用的服务器主机名，以改善加载速度。

它可以处理 OverseaVideo、BStar、PCDN、MCDN 等不同视频 CDN。最近版本是 **v0.2.24，2026 年 9 月 17 日发布**；9 月版本还专门补充了香港 Equinix CDN，并修复了国内/海外 CDN 请求重定向不完整的问题。（[biliverse.github.io](https://biliverse.github.io/guide/redirect.html?utm_source=chatgpt.com)、[GitHub](https://github.com/Biliverse/Redirect/releases)）

支持比较好的客户端主要是 **Surge、Loon、Stash、Egern**；Shadowrocket 也有人成功使用，但 Biliverse 自己把它列为“部分兼容”，所以如果你本来就有 Surge/Loon，我会优先用它们。（[GitHub](https://github.com/Biliverse/Universe?utm_source=chatgpt.com)）

安装用官方的 latest 地址最合适：

[Biliverse Redirect 官方配置说明](https://biliverse.github.io/guide/redirect.html?utm_source=chatgpt.com)

例如 Surge 当前官方模块就是：

```text
https://github.com/Biliverse/Redirect/releases/latest/download/BiliBili.Redirect.sgmodule
```

然后把几个视频相关项指向你在新加坡测试最快的节点，例如：

```text
Host.OverseaVideo = upos-sz-mirror08c.bilivideo.com
Host.BStar        = upos-sz-mirror08c.bilivideo.com
Host.PCDN         = upos-sz-mirror08c.bilivideo.com
```

社区的新加坡/海外使用案例就是这么配置的。（[GitHub](https://github.com/wronps/BilibiliAbroad)）

不过**不要照抄某个 CDN 当成永久答案**。CDN 性能会随运营商、时段和视频缓存状态变化；网页版那个 CDN Switcher 现在甚至内置约 300 个节点，就是因为“今天最快的节点，下周可能就很烂”。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

---

### 我会先在电脑上测速，然后把赢家填进手机

这个反而是最好玩的办法。

你前面装网页版的 CDN Switcher 后，用同一个新加坡网络、同一个 B 站视频做测速：

```text
Akamai       3 Mbps
Aliyun OV   25 Mbps
Huawei OV   80 Mbps
mirror08c  110 Mbps
```

假如测下来：

```text
upos-sz-mirror08c.bilivideo.com
```

最快，那么手机 Biliverse Redirect 就填这个。

也就是说：

```text
电脑负责发现最快 CDN
          ↓
手机负责强制使用这个 CDN
```

这是目前我认为**最合理的新加坡 B 站 App 解决方案**。

现有海外方案也明确建议先在网页版测出最快 CDN，再把那个 host 用到 iPhone/iPad。（[GitHub](https://github.com/wronps/BilibiliAbroad)）

---

### 为什么单纯换 1.1.1.1 / 8.8.8.8 经常没什么用？

因为问题不只是：

```text
bilivideo.com
       ↓ DNS
某个 IP
```

很多时候是 Bilibili 的 `playurl` API 本身直接给播放器：

```text
https://upos-sz-mirroraliov.bilivideo.com/...
```

也就是**服务器已经选好了具体 CDN hostname**。

所以：

```text
换 DNS
```

并不能把：

```text
mirroraliov
```

变成：

```text
mirrorhwov
```

或另一个快节点。

有海外用户专门测试过运营商 DNS、Google DNS 和 Cloudflare DNS，仍然可能被分配到很慢、甚至中国大陆的 CDN，因此最后采用的也是 CDN host 重定向。（[GitHub](https://github.com/wronps/BilibiliAbroad?utm_source=chatgpt.com)）

所以我把几个办法的优先级排成：

**CDN 重定向 > 优质代理线路 > 换 DNS。**

---

### 另一种简单方案：只把 B 站视频流走香港/大陆方向的代理

如果你本来就在手机跑 Surge/Shadowrocket，这个甚至更容易测试。

可以做：

```text
Bilibili API / 页面
        ↓
      DIRECT

bilivideo 视频流
        ↓
  HK / CN 优质节点
```

不过我不会建议你**整个 Bilibili 全局代理**。

原因是出口 IP 一换：

- 地区判定可能改变；
- 番剧版权区域可能改变；
- CDN 分配会跟着变化；
- 有时反而从新加坡附近 CDN 被送去一个更糟的节点。

比较理想的是只针对视频 CDN 做线路调整。

而且有一个很有意思的近期实测：同一个 Bilibili 视频分片，海外 mirror 能达到约 **59.5 Mbps**，错误地重写到中国大陆 CDN 后只剩 **6.5 Mbps**。所以“走中国节点一定更快”是完全不成立的，**真正需要的是实测线路**。（[GitHub](https://github.com/realzza/bilibili-accelerator/releases?utm_source=chatgpt.com)）

对于新加坡，我尤其会优先测试：

```text
香港 EQ CDN
海外 Huawei
海外 Aliyun
海外 Tencent
Akamai
```

而不是无脑强制大陆。

Biliverse 现在也已经加入：

```text
cn-hk-eq-01-01
cn-hk-eq-01-03
cn-hk-eq-01-09
cn-hk-eq-01-10
cn-hk-eq-01-12
cn-hk-eq-01-13
cn-hk-eq-01-14
```

这些香港 Equinix 节点。（[GitHub](https://github.com/Biliverse/Redirect/releases)）

---

### Android 的情况

Android 如果是原生 App，选择反而比较多。

有 root / LSPosed 的话，**BiliRoaming/BiliRoamingX** 一类模块本身就提供“港澳台 CDN 加速”功能。（[GitHub](https://github.com/jkm-maker/BiliRoamingX?utm_source=chatgpt.com)）

目前还有基于 ReVanced 实现的 BiliRoamingX 分支，支持大陆粉版、Google Play 版和 HD 版 Bilibili。（[GitHub](https://github.com/BiliRoamingX/BiliRoamingX?utm_source=chatgpt.com)）

不过这里我会分两档：

- **不 root：**优先用网络层代理/CDN 重定向。
- **已经 root + LSPosed：**BiliRoamingX 可以玩，但毕竟是在 patch B站 App，本身比 Surge/Biliverse 这类网络层方案侵入性高很多。

为了一个视频卡顿问题，我不会特意建议 root 手机。

---

### iPhone 用 MITM 有一个需要注意的地方

Biliverse Redirect 要实现这种 HTTPS URL 重写，通常需要：

```text
安装本地 CA
↓
信任 CA
↓
对指定 Bilibili hostname 开启 MITM
```

官方项目也明确要求 **Rewrite / Script / MitM**。（[GitHub](https://github.com/Biliverse/Universe?utm_source=chatgpt.com)）

这本身没什么神秘的，Surge/Loon 等就是这样工作的，但我建议：

**只 MITM 模块要求的 Bilibili 域名，不要自己偷懒写 `hostname = *`。**

尤其手机上还有银行、邮件、密码管理器之类流量，没必要让所有 HTTPS 都经过本地解密。

---

## 如果你不想折腾，先做这三个测试

在同一部手机上，同一个 B站视频、同一个清晰度：

1. **Wi-Fi → B站 App**
2. **5G → B站 App**
3. **Wi-Fi → Safari 打开 bilibili.com**

结果会非常有用。

比如：

```text
Wi-Fi App       卡
5G App          卡
Wi-Fi Safari    卡
```

非常像 **B站给新加坡 IP 的 CDN 调度问题**。

如果：

```text
Wi-Fi App       卡
5G App          流畅
```

则更像你家宽带到那个 CDN 的 peering/routing 有问题。

如果：

```text
App             卡
Safari          流畅
```

则要继续查 App 自己使用的 CDN、协议或者播放器。

如果所有线路只有 **1080P+/4K 卡，720P 永远正常**，又非常符合“分配到的 CDN 单连接吞吐不足”这个模型。

---

**所以，如果你主要用 iPhone，我现在最建议你的方案是：`Surge/Loon/Stash + Biliverse Redirect + 用网页版 CDN Switcher 找新加坡最快 host`。** 这比换 DNS、清缓存、重装 B站之类真正对症得多。

如果你告诉我是 **iPhone 还是 Android、B站大陆 App 还是国际版 App**，我可以直接按你的手机给你一套具体配置，包括哪些 CDN 域名在新加坡值得逐个测、Surge/Shadowrocket 怎么填。

## 第 3 轮 用户

# Selected text:

## Selection 1
安装用官方的 latest 地址最合适：
Biliverse Redirect 官方配置说明

## My request:
我现在用 surge，有没有办法实现让手机端自动测速，自动选择最快的节点？

## 第 3 轮 ChatGPT

可以，而且 **Surge 本身有足够的能力把它做成真正的“手机端自动测速 → 自动切最快 B 站 CDN”**。不过我查了目前的 Biliverse Redirect：截至最新的 **v0.2.24**，它仍然是让你从一组 CDN hostname 里指定目标，并**没有内置吞吐测速 + 自动择优**。BoxJs 里的 `Host.OverseaVideo / BStar / PCDN` 也仍然都是固定选择项。（[GitHub](https://github.com/Biliverse/Redirect/releases?utm_source=chatgpt.com)、[GitHub](https://github.com/Biliverse/BoxJs/blob/main/BiliBili.boxjs.json?utm_source=chatgpt.com)）

而且有一个关键点：**不能简单拿 Surge 的 `url-test` 来解决。**

Surge 的 `url-test` 测的是“代理策略到某 URL 的延迟”，然后选择代理节点；你现在要选择的是：

```text
upos-sz-mirroraliov.bilivideo.com
upos-sz-mirrorcosov.bilivideo.com
upos-sz-mirrorhwov.bilivideo.com
cn-hk-eq-01-09.bilivideo.com
...
```

这些是**目标 CDN hostname，不是代理节点**。而且我们真正关心的是持续吞吐 Mbps，不是 20 ms / 40 ms 这种 RTT。Surge 官方对 `url-test` 的定义也是延迟测试。（[NSSurge Manual](https://manual.nssurge.com/book/understanding-surge/en/understanding-surge-en.pdf?utm_source=chatgpt.com)）

### 我最推荐的实现

把网页版自动 CDN Switcher 的思路直接搬进 Surge：

```text
打开 B 站视频
      ↓
App 请求第一段 .m4s
      ↓
Surge 拿到这个真实视频分片 URL
      ↓
拿同一个 path + query
分别替换成几个候选 CDN hostname
      ↓
并发 Range 下载一小段
      ↓
实测 MB/s / Mbps
      ↓
选最快的 CDN
      ↓
缓存 10~30 分钟
      ↓
之后所有 m4s 自动 rewrite 到赢家
```

这其实就是网页版目前已经验证过的办法。现有的网页 CDN Switcher 会拿**当前视频、当前画质的真实分片**逐个换 host 测速；另一个自动优化脚本甚至会用最多约 1.2 秒/4 MB 的真实下载窗口测持续吞吐，再缓存结果约 10 分钟。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher?utm_source=chatgpt.com)、[GitHub](https://github.com/SanJerry007/bilibili-cdn-optimizer/blob/main/README.md?utm_source=chatgpt.com)）

所以手机 Surge 完全可以复制这个逻辑。

Surge 的脚本 API 正好有我们需要的全部东西：

- `http-request` 可以拿到并修改请求 URL；
- `$httpClient` 可以并发发 HTTP 请求；
- 支持 `binary-mode`，可以实际下载二进制视频片段；
- 单次脚本最多允许 **20 个并发请求**；
- `$persistentStore` 可以把胜出的 CDN 保存下来；
- `$network` 能区分当前 Wi-Fi / 蜂窝环境。（[NSSurge Manual](https://manual.nssurge.com/scripting/http-request.html?utm_source=chatgpt.com)、[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

所以这个方案不是理论上的 hack，Surge API 是正式支持这些能力的。

## 我会这样设计测速

比如你在新加坡，我不会一口气扫 300 个 CDN，那样手机会发疯 😂。先测试 6～10 个最有意义的候选：

```text
upos-sz-mirroraliov.bilivideo.com   阿里海外
upos-sz-mirrorcosov.bilivideo.com   腾讯海外
upos-sz-mirrorhwov.bilivideo.com    华为海外
upos-sz-mirrorawsov.bilivideo.com   AWS 海外

cn-hk-eq-01-01.bilivideo.com        香港 Equinix
cn-hk-eq-01-09.bilivideo.com
cn-hk-eq-01-13.bilivideo.com

upos-sz-mirror08c.bilivideo.com     社区海外常用节点
```

其中香港 Equinix 节点正是 Biliverse 在今年新增进去的一批。（[GitHub](https://github.com/Biliverse/Redirect/releases?utm_source=chatgpt.com)）

假设 B站原始请求是：

```text
https://upos-hz-mirrorakam.akamaized.net/upgcxcode/...
    ?deadline=...
    &gen=playurlv3
    &os=bcache
    &oi=...
```

脚本保持：

```text
/upgcxcode/...
?deadline=...
&gen=...
...
```

全部不动，只替换 hostname：

```text
https://upos-sz-mirrorhwov.bilivideo.com/upgcxcode/...
https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/...
https://cn-hk-eq-01-09.bilivideo.com/upgcxcode/...
```

Biliverse 现在自己的重定向逻辑也特意保证**保留视频 path 和签名 query string**。（[GitHub](https://github.com/Biliverse/Redirect/releases?utm_source=chatgpt.com)）

然后针对每一个发：

```http
Range: bytes=0-1048575
```

也就是先取约 **1 MB**。

例如：

```text
华为海外
1 MB / 0.18 s
≈ 44 Mbps

腾讯海外
1 MB / 0.52 s
≈ 15 Mbps

阿里海外
1 MB / 1.8 s
≈ 4.4 Mbps

HK EQ 09
1 MB / 0.11 s
≈ 73 Mbps
```

于是：

```text
🏆 cn-hk-eq-01-09.bilivideo.com
```

接下来把真正的 B站请求改成这个 host。

Surge `http-request` script 可以直接返回修改后的：

```js
$done({
    url: newURL,
    headers: newHeaders
});
```

而且 Surge 官方特别指出：脚本改 URL 时**不会像 URL Rewrite 那样自动同步 Host header**，所以我们会同时把：

```http
Host: cn-hk-eq-01-09.bilivideo.com
```

一起改掉。（[NSSurge Manual](https://manual.nssurge.com/scripting/http-request.html?utm_source=chatgpt.com)）

---

## 但不要每个视频都重新测速

否则你每打开一个视频：

```text
7 CDN × 1 MB
≈ 7 MB
```

先凭空浪费 7 MB，而且还有启动延迟。

我会做成：

```text
第一次打开 B站
       ↓
测速
       ↓
bestCDN = HK-EQ-09
       ↓
缓存 20 min
       ↓
接下来所有视频直接使用 HK-EQ-09
```

而且按网络分别缓存：

```text
Wi-Fi:
Singtel-Home
→ HK-EQ-09

Cellular:
StarHub
→ Huawei OV

另一个 Wi-Fi:
Office
→ Tencent OV
```

Surge 脚本可以从 `$network` 获取：

```text
Wi-Fi SSID
BSSID
IPv4 interface
cellular carrier
radio type
```

因此可以做到：

> **你从 Singtel Wi-Fi 切 StarHub 5G → 自动发现网络变了 → 重新测速。**

这是我觉得非常有价值的一点，因为同一个 CDN 在 Singtel / StarHub / SIMBA 上完全可能有截然不同的 peering。Surge 官方确实向脚本暴露这些网络环境字段。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

---

## 我甚至不建议定时 cron 测速

Surge 当然支持：

```text
*/30 * * * *
```

每半小时执行一次测速脚本。（[NSSurge Manual](https://manual.nssurge.com/scripting/cron.html?utm_source=chatgpt.com)）

但对 B站 CDN 来说不漂亮。

因为最可靠的测速对象是：

**当前真实视频的签名 `.m4s` URL。**

它有有效期。

所以没有一个很好用的：

```text
https://cdn.bilibili.com/speedtest/100MB.bin
```

让我们全天固定测。

因此最合理的触发机制不是：

```text
每 30 分钟定时测速
```

而是：

```text
用户开始播放 B站
        ↓
发现缓存没有 / 已超过20分钟 / 网络发生变化
        ↓
用眼前这个真实 m4s 分片测速
```

这个设计不仅准确，而且基本不消耗后台电量。

### 还有一个细节：测速不应该挡住播放太久

我会给它设：

```text
单 CDN timeout：1.5~2 秒
Range：1 MB
并发：6~8 个
```

所以最差大约：

```text
1.5~2 sec
```

就结束，而不是：

```text
6 CDN × 2 sec
= 12 sec
```

因为 `$httpClient` 支持并发，而且 Surge 单次脚本允许最多 20 个并行请求。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

更高级一点可以借鉴网页脚本：

```text
最快达到 1~2 MB 的节点
       或
测速时间达到 1.2~1.5 秒
```

谁先满足就结束。

这样测出来的是**真实持续吞吐**，不是：

```text
DNS + TCP + TLS latency
```

---

## 自动切换还可以再加一层 failover

最终可以做成：

```text
             ┌─ HK EQ 09 ── fastest
Bilibili ────┤
             ├─ HW OV
             ├─ COS OV
             └─ ALI OV
```

正常：

```text
HK EQ 09
```

如果发现测速：

```text
403
404
timeout
< 1 Mbps
```

就淘汰。

并保存：

```text
best   = HK EQ 09
second = Huawei OV
third  = Tencent OV
```

如果之后主节点连续出错：

```text
HK EQ 09
   ❌
   ↓
Huawei OV
```

同时把缓存标记过期：

```text
下一次视频重新测速
```

这样才算真正的：

> **自动选择 + 自动容灾**

而不是今天测一次然后永久 pin 一个 CDN。

---

## 一个很重要的现实问题：它最好不要和 Biliverse Redirect 的同类规则同时抢请求

Surge 对同一个 HTTP request：

> 最多只执行第一条匹配到的 `http-request` script。

这是官方行为。（[NSSurge Manual](https://manual.nssurge.com/scripting/http-request.html?utm_source=chatgpt.com)）

而最新版 Biliverse Redirect 自己也已经用了：

```text
Header Rewrite
+
request script
```

来处理 CDN 请求。（[GitHub](https://github.com/Biliverse/Redirect/releases?utm_source=chatgpt.com)）

所以最干净的方案不是：

```text
Biliverse Redirect
+
Auto CDN Script
两边一起抢
```

而是：

```text
Auto Bilibili CDN Module
 ├─ MITM
 ├─ CDN request matcher
 ├─ benchmark
 ├─ persistent cache
 ├─ rewrite
 └─ failover
```

直接把 **Redirect 那一部分替代掉**。

Biliverse 的 Enhanced / ADBlock / Global 等其他模块仍然可以继续用。

---

## 所以现在的结论

**能，而且 Surge 非常适合做这个。**

但目前我没有找到一个我愿意直接推荐给你的、维护良好并已经实现：

> **iOS Bilibili App + Surge + 当前视频真实分片吞吐测速 + 自动选 CDN**

的现成模块。

现在比较成熟的手机方案还是 **Biliverse Redirect 固定选择 CDN**；真正的自动 throughput selection 主要已经在网页版脚本里实现。（[GitHub](https://github.com/wronps/BilibiliAbroad?utm_source=chatgpt.com)、[GitHub](https://github.com/stabruriss/bilibili-accelerator/blob/main/README.md?utm_source=chatgpt.com)）

所以如果是我自己在你这个环境里用，我会做成：

```text
Bilibili Auto CDN for Surge

候选：
  Huawei OV
  Tencent OV
  Aliyun OV
  AWS OV
  HK EQ 01
  HK EQ 09
  HK EQ 13
  mirror08c

触发：
  第一次遇到视频 m4s

测速：
  1 MB Range
  并发
  timeout 1.5 sec

缓存：
  20 min
  按 Wi-Fi / cellular 分开

自动：
  网络切换 → 重测
  缓存过期 → 重测
  CDN 失败 → fallback + 重测
```

这比单纯固定 `mirror08c` 要漂亮很多，特别适合你这种**新加坡 + 多条蜂窝线路 + Surge 常驻**的情况。

如果你想折腾这个，我下一步可以直接给你写成一个**可以导入 Surge 的 `.sgmodule` + JS**，让它装进去以后自己测速、自动切 CDN，不需要 BoxJs 手动选。

## 第 4 轮 用户

# Selected text:

## Selection 1
比如你在新加坡，我不会一口气扫 300 个 CDN，那样手机会发疯 😂。先测试 6～10 个最有意义的候选：

## My request:
我刚刚用网页端测试了一下，发现刚刚最快的是湖北武汉的 cdn，香港的反而只有几十 kb/s，搞不好真的得 300 多个 cdn 测一遍？

## 第 4 轮 ChatGPT

对，**你这个实测基本把“只挑新加坡/香港附近 6～10 个节点”这个思路给否了** 😂。

而且我刚重新看了你正在用的那个 CDN Switcher，它最近其实已经演化到跟这个结论差不多了：仓库现在维护了 **300+ 个去重后的 VOD CDN 节点**；所谓“Singapore”列表只是从全量扫描/收集结果里整理出的 **Top 10**，并且刻意让不同 CDN pool 都有代表。选择 `All` 时，它确实允许把约 300 个节点全部测一遍。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

所以你测出：

> 新加坡 → **武汉 CDN 最快**  
> 香港 CDN → **几十 KB/s**

完全足以说明：**不能拿物理距离做候选过滤。**

## 但手机不能真的每次把 300 个节点都“完整测速”

网页版目前默认的完整测速是：

> 每个节点取当前视频真实分片，直到 **8 MB 或 5 秒**，哪个先到就停。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

如果拿这个参数扫 300 个：

```text
300 × 8 MB = 2.4 GB
```

极端情况下单次测速就可能吃掉几个 GB。

如果节点都很慢，又会接近：

```text
300 × 5 秒
= 1500 秒
= 25 分钟
```

而且目前扩展的“All”模式自己都会弹红色警告，提示耗时大约是 `节点数 × 每节点时间上限`。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

**所以：全 300 要扫，但应该做成分层筛选，而不是 300 个都跑 8 MB。**

---

# 我现在觉得 Surge 最好的算法应该是三阶段

### 第一阶段：300+ 节点“海选”

每个节点只取：

```text
128 KB
```

或：

```text
256 KB
```

而不是 8 MB。

并发例如：

```text
15~20 个
```

Surge 一个脚本执行允许最多 **20 个并发 `$httpClient` 请求**，而且支持 binary response，所以刚好适合这种模式。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

比如：

```text
300 CDN
   │
   │ 256 KB Range
   │ timeout 1.0~1.5s
   │ concurrency 20
   ▼
┌──────────────────┐
│   快速淘汰赛      │
│                  │
│  失败 / 403   ✗  │
│  100 KB/s     ✗  │
│  500 KB/s     ✗  │
│  5 MB/s       ✓  │
│  20 MB/s      ✓  │
└──────────────────┘
         │
         ▼
       Top 20
```

理论最大数据：

```text
300 × 256 KB
≈ 75 MB
```

这就从 **2.4 GB → 75 MB** 了。

而实际还会更少，因为很多节点：

- timeout
- 403
- host-bound
- 根本没数据
- 达不到完整 256 KB

---

# 第二阶段：Top 20 再认真测

留下第一轮最快的 20 个：

```text
20 × 1 MB
```

例如：

```text
武汉联通      31 MB/s
武汉电信      27 MB/s
广州移动      24 MB/s
上海某节点    22 MB/s
香港 EQ       0.06 MB/s ← 🤡
...
```

这一轮每节点：

```text
1 MB
或
1.5 秒
```

取其先到。

数据量最多也就：

```text
20 MB
```

然后留下：

```text
Top 5
```

---

# 第三阶段：Top 5 真正测速

这时才采用接近网页版的标准：

```text
4~8 MB
或
3~5 秒
```

例如：

```text
武汉 A      91 Mbps
武汉 B      74 Mbps
广州 C      63 Mbps
上海 D      58 Mbps
新加坡 E    44 Mbps
```

最后选：

```text
🏆 武汉 A
```

这一层就算：

```text
5 × 8MB = 40 MB
```

也完全可以接受。

---

## 一次完整 Discovery 大约只需要

最坏大致：

```text
第一轮
300 × 256 KB       ≈ 75 MB

第二轮
20 × 1 MB          ≈ 20 MB

第三轮
5 × 8 MB           ≈ 40 MB
─────────────────────────
总计                ≈135 MB
```

而不是：

```text
300 × 8 MB
= 2.4 GB
```

而且实际上很可能不到 100 MB。

如果第一轮进一步用：

```text
128 KB
```

那么：

```text
300 × 128 KB
≈ 37.5 MB
```

整个完整探索大概 **80～100 MB** 就能完成。

这对 Wi-Fi 下一天偶尔跑一次是完全合理的。

---

# 更重要的是：完全没必要“每个视频扫 300 个”

我会让 Surge 保存一个排行榜。

例如你家 Singtel Wi-Fi：

```text
networkProfile:
  WiFi / xxxx

lastFullScan:
  2026-10-11 02:30

Top CDN:
  1. 武汉 xxx      92 Mbps
  2. 广州 xxx      78 Mbps
  3. 上海 xxx      71 Mbps
  4. 成都 xxx      65 Mbps
  5. 新加坡 xxx    49 Mbps
  6. ...
```

然后正常看视频的时候，只测：

```text
Top 5
+
B站这次原生分配的 CDN
```

也就是：

```text
6 个节点
```

一两秒内就能决定：

```text
这支视频当前：

武汉      83 Mbps
广州      61 Mbps
上海      77 Mbps
成都      20 Mbps
SG       38 Mbps
原生      12 Mbps

→ 武汉
```

然后直接播放。

---

# 为什么每个视频还应该把 Top 5 重新小测一下？

这里还有一个特别坑的东西：

**CDN 排名不仅取决于网络线路，还取决于“这支视频有没有被这个节点缓存”。**

这个扩展作者自己也特别提醒：

> 当前视频、当前画质在 CDN 上是否已经缓存，以及当时路由拥塞情况，都会明显改变测速结果；某次测速最快不代表始终最快。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

所以可能出现：

### 视频 A

```text
武汉
└─ HIT
   → 100 Mbps

广州
└─ MISS / 回源
   → 8 Mbps
```

### 视频 B

反过来：

```text
武汉
└─ MISS
   → 12 Mbps

广州
└─ HIT
   → 95 Mbps
```

因此：

> **全量扫描负责发现“这个网络环境有哪些潜在好线路”**

而：

> **当前视频小规模测速负责决定“这支片此刻谁最快”。**

这两个层级结合才是比较漂亮的方案。

---

# 甚至可以做一个“探索”机制，防止武汉这种黑马消失

这里可以借鉴推荐系统里的 exploitation / exploration。

大部分视频：

```text
90%：
只测历史 Top 5
```

偶尔：

```text
10%：
Top 5
+
随机抽 10~20 个历史排名之外 CDN
```

假如突然发现：

```text
历史赢家武汉：65 Mbps

随机抽中的长沙：
      148 Mbps
      ↑
     ？？？
```

那么：

```text
长沙
↓
进入候选池
↓
下一轮正式测速
↓
可能成为新 Top 1
```

这样即使：

- BGP 调整；
- B站换 CDN；
- 某运营商 peering 改了；
- 某个原来很烂的节点突然变神；

系统也能自己重新发现它。

---

# 还可以利用 CDN pool 再优化

现在这个扩展的数据本身已经把 CDN 按 `pool` 分类了，比如 Huawei、Aliyun 等；Singapore Top 10 其实也是刻意从不同 pool 中挑代表，而不是单纯取十个 hostname。（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)）

所以还可以做：

```text
300 nodes
    ↓
按 pool 分类
    ↓
每个 pool 先快速探测几个
    ↓
表现好的 pool 扩大搜索
```

不过**你的武汉案例让我反而不太想过度依赖这个优化**。

因为：

```text
同一个 CDN 厂商
武汉
香港
广州
新加坡
```

实际 BGP 路由完全可能天差地别。

所以我宁可：

> **第一轮真的把 300 个 host 全碰一下，只是每个碰得很轻。**

这样不会漏黑马。

---

# Surge 很适合做这个，但有一个 iOS 限制要尊重

Surge `$httpClient`：

- 单次脚本最多 **20 个并发请求**；
- response body iOS 上单请求最大 **32 MB**；
- 支持 `binary-mode`；
- timeout 可以每个请求自行设置。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

所以：

```text
300
↓
每批20个
↓
15批
```

非常自然。

比如第一层：

```text
20 concurrently
        ↓
完成
        ↓
next 20
        ↓
...
15 batches
```

如果大部分节点 300~500ms 就得到 128/256 KB：

**一次粗筛甚至不需要很久。**

千万不要：

```text
同时发 300 个
```

这不但超过 Surge 限制，也会把无线网络/CDN 自己打爆，测出来的数据反而失真。

---

# 我现在甚至会修改之前给你的设计

之前我说：

> “候选 6～10 个”

在看到你这个结果以后，我觉得**确实过度依赖地理直觉了**。

更好的模型应该是：

```text
             ┌────────────────────┐
             │  全部 300+ CDN     │
             └─────────┬──────────┘
                       │
                 128~256 KB
                 并发20 / 分批
                       │
                       ▼
                    Top 20
                       │
                     1 MB
                       │
                       ▼
                     Top 5
                       │
                    4~8 MB
                       │
                       ▼
                当前网络排行榜
                       │
        ┌──────────────┴──────────────┐
        │                             │
       平时                         定期
        │                             │
Top 5 + 原始 CDN                全 300 重扫
        │
当前视频实测                    更新候选池
        │
        ▼
   自动选最快
```

这就是我现在最想给 Surge 实现的版本。

### Full scan 触发条件

我会定成：

- **第一次使用：**全扫；
- **换 Wi-Fi / 换蜂窝运营商：**全扫；
- **超过 12～24 小时：**后台有需要时重新扫；
- **Top 5 全部明显变慢：**立即触发重新发现；
- **用户手动点「重新探索所有 CDN」：**全扫。

除此之外：

**绝不扫描 300 个。**

这样你既不会错过“新加坡 → 武汉反而最快”这种完全违反地理直觉的神仙路由，又不会每看一个两分钟 Miku 视频先拿 2 GB 流量祭天 😂。

还有个有意思的变化：**这个浏览器扩展当前版本其实已经加了“第一次播放自动测速并切最快节点”功能，但它只会测当前国家预选出来的 10 个节点；`All` 模式反而不允许自动切最快。**（[GitHub](https://github.com/a0972199950/bilibili-cdn-switcher)） 所以你这次发现武汉最快，实际上暴露出了它“country Top 10”策略仍可能漏掉全局最佳节点。

如果我们给 Surge 做自己的版本，我反而建议**不要复制它这个限制**：直接做 **300 全域粗筛 → Top 20 → Top 5 → 日常自适应**。这会比现成网页版的自动模式还聪明。

## 第 5 轮 用户

# Selected text:

## Selection 1
每个节点取当前视频真实分片，直到 8 MB 或 5 秒，哪个先到就停。

## My request:
我刚刚的测速体验是，速度快的节点直接就蹦出来了，其他的节点根本没测完就可以直接停，有没有办法可以据此进行优化？

## 第 5 轮 ChatGPT

对，而且你观察到的这个现象正好可以利用。**我们根本不需要知道 300 个 CDN 各自准确是多少 Mbps；我们只需要尽快找出“谁有资格争第一”。** 这可以把测速从传统 benchmark 变成 **race / 淘汰赛**。

假设所有候选同时请求相同大小的 Range：

```text
Range: bytes=0-262143   # 256 KiB
```

某个武汉节点 80 ms 就完成了，而香港节点 800 ms 还没完成，那么其实已经知道：

```text
武汉：256 KiB / 80 ms  ≈ 26.2 Mbps
香港：至少 >800 ms
      => 即使下一瞬间完成也 <2.6 Mbps
```

**香港后面的精确成绩已经没有任何价值了。** 没必要继续等它。

### 我会把算法改成“first finishers win”

第一轮不要：

```text
300 个 CDN
↓
全部测到 8 MB / 5 s
↓
全部结束
↓
排序
```

而是：

```text
300 个 CDN
        ↓
请求同一个很小的 Range
        ↓
谁先完成谁立刻进入候选池
        ↓
收够 Top 20 左右
        ↓
慢节点直接放弃
```

形象一点：

```text
武汉 1    ██████████ DONE  82 ms   ← 入围
广州 3    ██████████ DONE  91 ms   ← 入围
上海 7    ██████████ DONE 105 ms   ← 入围
成都 2    ██████████ DONE 123 ms   ← 入围

香港 4    ███...
新加坡 8  ██...
北京 6    █...
沈阳 2    █...

              ↑
      根本不用等这些测完
```

这实际上是个 **race benchmark**。

---

## 但有一个 Surge 限制

Surge `$httpClient` 每个脚本最多允许 **20 个并发 HTTP 请求**。而且当前官方 API 没有提供一个明确的：

```js
request.abort()
```

接口来逐个取消已经发出的 `$httpClient` 请求。它支持给每个请求设置 timeout，但没有文档化的动态 abort handle。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

所以不能真的：

```text
300 个一起发
最快20个出来
kill剩余280个
```

在 Surge 里更适合实现成 **20 个 worker 的赛马池**。

---

# 最适合 Surge 的版本：滚动赛马

准备：

```text
300 CDN
20 workers
```

一开始：

```text
worker 1  → CDN 1
worker 2  → CDN 2
...
worker 20 → CDN 20
```

一个完成：

```text
CDN 7 DONE
↓
记录成绩
↓
worker 7 马上测试 CDN 21
```

再完成：

```text
CDN 3 DONE
↓
worker 3 → CDN 22
```

于是始终维持：

```text
≤ 20 requests
```

不用等最慢那个。

Surge 的 20 个并发限制正好允许这么干。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

---

# 更关键的优化：动态淘汰线

比如第一批里面突然蹦出来：

```text
武汉节点
128 KiB / 45 ms
≈ 23 Mbps
```

这时候我们已经有了一个：

```text
champion = 45 ms
```

那其他节点如果：

```text
> 300 ms
```

连同样的 128 KiB 都没跑完，它就算下一毫秒完成，也只有：

```text
128 KiB / 300 ms
≈ 3.5 Mbps
```

它不可能和冠军竞争。

所以以后完全没必要给第一轮：

```text
timeout = 5 sec
```

可以是类似：

```text
absolute timeout = 800 ms

如果已有非常快的冠军：
effective cutoff ≈ champion_time × 4~6
```

比如：

```text
冠军：50 ms

50 × 5 = 250 ms
```

250 ms 还没传完：

```text
淘汰。
```

这样大量垃圾节点根本不会拖你几秒。

---

## 第一轮甚至不用 256 KB

我现在倾向于：

### Phase 0：海选

```text
Range: 128 KiB
timeout: 500~800 ms
concurrency: 20
```

扫：

```text
300+
```

只留下：

```text
最快 20~30 个
```

数据流量最多：

```text
300 × 128 KiB
≈ 37.5 MiB
```

而现实通常更低，因为大量节点超时并没完成 128 KiB。

但这里不建议低到：

```text
16 KB
32 KB
```

因为那时：

```text
DNS
TCP
TLS
TTFB
```

占比太大，测出来更像“谁响应快”，而不是“谁视频吞吐高”。

**128～256 KiB 是比较合理的粗筛尺寸。**

---

# 第二轮再赛一次

第一轮 Top 20：

```text
Top 20
 ↓
Range 1 MiB
 ↓
first finishers
 ↓
Top 5
```

比如很快出现：

```text
武汉 A      88 ms
广州 B     103 ms
武汉 C     107 ms
上海 D     131 ms
杭州 E     145 ms

成都      420 ms
北京      580 ms
香港      >1000 ms
```

前五基本已经蹦出来了。

后面的精确数值：

> 我根本不关心。

---

# 最后一轮才真正测吞吐

只有：

```text
Top 5
```

使用：

```text
4~8 MiB
或
2~3 秒
```

得到比较稳定的结果：

```text
武汉 A    116 Mbps
广州 B    103 Mbps
武汉 C     92 Mbps
上海 D     87 Mbps
杭州 E     81 Mbps
```

选：

```text
武汉 A
```

于是完整逻辑变成：

```text
             300+ CDN
                │
       128 KiB / <800 ms
                │
        first finishers
                ↓
              Top 20
                │
          1 MiB race
                │
        first finishers
                ↓
               Top 5
                │
         4~8 MiB benchmark
                ↓
              Winner
```

这比“300 × 8 MB”优雅太多了。

---

## 还可以进一步玩一个很漂亮的数学优化

其实我们甚至不需要固定：

```text
Top 20
```

而是做 **relative cutoff**。

假设已经有：

```text
#1  武汉    70 ms
#2  广州    79 ms
#3  上海    83 ms
#4  武汉2   89 ms
#5  南京    94 ms
```

当前第五名：

```text
94 ms
```

那么某个还没结束的节点，到：

```text
188 ms
```

仍然没完成，就是第五名的两倍。

它已经没有多少价值。

可以设：

```text
淘汰条件：

elapsed > kthBest × α
```

例如：

```text
α = 2.5
k = 10
```

如果当前第 10 名：

```text
120 ms
```

那么：

```text
120 × 2.5 = 300 ms
```

所有超过 300ms 还没完成的节点：

```text
淘汰
```

这就是一个 **自适应 stopping threshold**。

网络整体快的时候：

```text
cutoff 自动缩短
```

网络整体慢的时候：

```text
cutoff 自动放宽
```

比硬编码：

```text
timeout=500ms
```

聪明得多。

---

# 不过这里还有一个隐藏问题：连接建立时间

如果只用：

```text
completion time
```

会混进去：

```text
DNS
TCP handshake
TLS handshake
TTFB
+
实际传输
```

但某种程度上，这其实**不是坏事**。

因为我们最终关心的不是：

> 这个 CDN 机房纯粹带宽理论上有多高？

而是：

> B站 App 真的向它请求 `.m4s` 时有多快？

如果武汉：

```text
RTT 70 ms
吞吐 200 Mbps
```

而香港：

```text
RTT 15 ms
吞吐 300 KB/s
```

对视频播放来说当然应该选武汉。

所以第一轮把连接建立成本包含进去反而很合理。

最后 Top 5 的大文件测试会自动淡化 handshake 的影响。

---

# 还可以做“冠军一出现，马上播放”

这个对实际体验特别重要。

我们甚至没必要让用户等：

```text
Phase 0
↓
Phase 1
↓
Phase 2
↓
全部做完
↓
才开始视频
```

可以这样：

```text
B站请求视频
     │
     ├──── 原始请求先正常播放
     │
     └──── 后台 CDN race
              │
           很快发现
              │
          武汉 = 超快
              │
              ↓
后续 m4s 请求自动改成武汉
```

或者有历史赢家时：

```text
打开视频
   ↓
立刻：
上次赢家武汉
   ↓
马上播放

同时后台：
武汉 / 广州 / 上海 / 随机候选
race
   ↓
发现今天广州更快
   ↓
下一个 segment 开始切广州
```

那么用户几乎感知不到测速过程。

---

## 对“300 CDN 全局探索”，我会加一个更狠的优化

你已经发现武汉可能赢香港，所以不能纯地理筛选。

但我们仍然可以用**历史成绩**排序测试顺序。

比如昨天排行榜：

```text
1 武汉 A
2 广州 C
3 上海 F
4 武汉 B
5 杭州 H
...
```

今天 full scan 时，不随机顺序跑 300 个，而是：

```text
第一优先：
历史 Top 20

第二优先：
历史表现不错的 50 个

第三优先：
剩余 230 个探索
```

这样如果：

```text
武汉 A
```

今天依然变态快，它可能在测速开始几十毫秒后就给我们一个非常高的 benchmark。

然后它马上建立一条非常严格的淘汰线。

比如：

```text
武汉 A
128 KiB = 35 ms
```

那么剩余 CDN：

```text
> 250ms
```

大概率已经可以直接判为：

> 不可能成为 Top candidate。

这会极大提高整个扫描效率。

---

# 还有个更有意思的思路：只求“足够快”，不一定求绝对第一

假设你的 B站最高码率只有：

```text
4K ≈ 20 Mbps
```

现在已经找到一个：

```text
武汉 = 180 Mbps
```

那么继续寻找：

```text
广州 = 205 Mbps
```

实际播放体验：

```text
180 Mbps
vs
205 Mbps
```

**没有区别。**

所以可以设一个 satisfactory threshold：

```text
如果已经找到：

稳定 > 80 Mbps
或
稳定 > 视频 bitrate × 4
```

那么：

```text
直接停止搜索
```

这在手机上特别值得做。

因为目标其实不是：

> 找到地球上数学意义的最快 CDN。

而是：

> B站永远秒开、拖进度条立即出画面。

假设当前视频：

```text
bitrate = 12 Mbps
```

CDN 已经：

```text
80 Mbps
```

继续花几十 MB 流量寻找一个：

```text
110 Mbps
```

没什么意义。

---

# 所以我现在最推荐的算法其实是这个

```text
打开 B站
   │
   ├─ 有历史 winner？
   │       │
   │       └─ YES → 立即使用
   │
   └─ 启动后台 race
          │
          ▼
历史 Top 节点优先
          │
          ▼
128 KiB quick race
20 concurrency
          │
          ├─ 某节点已经 > satisfactory speed
          │            ↓
          │          STOP
          │
          └─ 否
              ↓
         扫完整个 300
              ↓
            Top 20
              │
           1 MiB race
              ↓
            Top 5
              │
          4~8 MiB confirm
              ↓
            Winner
```

再结合：

```text
winner cache
+
network-specific profile
+
随机 exploration
```

就已经很接近一个小型的 **CDN adaptive routing controller** 了。

而且你说的“快节点一下就蹦出来”正说明这套方案很适合实际 B站 CDN：**节点之间不是 40 Mbps vs 45 Mbps 这种难分伯仲，而经常是 100 Mbps vs 300 KB/s 这种数量级差距。** 这种分布特别适合 early stopping。

唯一需要在 Surge 实现时注意的是：官方 `$httpClient` 有 **20 并发限制**，并且文档没有提供单个在途请求的显式 cancel API，因此我会用**短 timeout + 20-worker 滚动队列 + 分阶段 Range**，而不是依赖“发出去后立即 abort”。（[NSSurge Manual](https://manual.nssurge.com/scripting/api.html?utm_source=chatgpt.com)）

这样的话，**300 个 CDN 并没有听起来那么可怕**：绝大多数慢节点根本不需要完成一次正式测速，只要证明“你已经输得足够惨”就可以出局。

---

Here's a quick summary of the conversation:

B站网页版在新加坡遇到画面卡住但声音继续的问题，主要原因是海外CDN分配和macOS+Chrome浏览器渲染bug叠加。推荐使用“Overseas Video Speedup for bilibili”扩展，通过动态测速切换CDN节点，有效缓解播放卡顿。通过B站视频信息统计可区分网络与解码问题，若Chrome特定环境下全屏画面停滞，建议利用Safari作为临时解决方案。

手机端则不能用浏览器扩展，最好的方式是通过Biliverse Redirect模块重定向App视频源CDN。先用网页版测速找到最快的CDN节点，再配置手机App使用该节点。单纯换DNS无法解决因playurl API固定指定CDN的瓶颈问题，需针对性重定向才能改善加载速度。

- 继续阅读三阶段测速方案细节
- 总结B站CDN测速多阶段筛选关键点
- 解释B站CDN测速中网络与缓存状态影响
