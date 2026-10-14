# 候选清单来源与许可

`cdn-candidates.json` 由 `tools/import-candidates.mjs` 从上游清单转换生成：

| 项目 | 内容 |
| --- | --- |
| 上游项目 | [bilibili-cdn-switcher](https://github.com/a0972199950/bilibili-cdn-switcher) |
| 固定提交 | `210cacd1426ba2301ec647dd90bc8957b7634196` |
| 上游文件 | `src/cdn-list.json` |
| 版权 | Copyright (c) 2024–present John H |
| 许可证 | Bilibili CDN Switcher Source-Available License 1.0 |

转换只保留 hostname、pool 标识与简体中文 pool 名称，以及各国家推荐表；所有主机名经本项目重新校验并去重，299 个主机全部通过，上游的 `backup` 特殊项被丢弃。

该许可证不是开源许可证。按其第 2 节，派生数据只能用于个人、非商业用途；第 3.4 节要求保留版权与署名说明；第 3.5 节禁止使用上游作者名或项目名暗示背书。本项目不是上游项目的一部分，也未获上游认可。公开分发或商业使用前，请重新阅读[上游许可证](https://github.com/a0972199950/bilibili-cdn-switcher/blob/210cacd1426ba2301ec647dd90bc8957b7634196/LICENSE)，必要时联系上游作者。

地区推荐表是上游随版本发布的静态先验，不是本项目在手机端验证过的结果。更新清单时运行：

```sh
curl -o /tmp/cdn-list.json https://raw.githubusercontent.com/a0972199950/bilibili-cdn-switcher/<commit>/src/cdn-list.json
node tools/import-candidates.mjs /tmp/cdn-list.json data/cdn-candidates.json --commit <commit>
node tools/build.mjs
```

`--commit` 写入来源记录并决定 `revision`；更换提交后请同步更新本文件的提交号与许可证核对结果。`revision` 变化会让脚本清空各网络的历史排行，冷却记录保留。
