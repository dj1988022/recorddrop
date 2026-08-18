# RecordDrop 🎬

&gt; 开源、可自托管的屏幕录制工具，**本地优先保存**。  
&gt; 没有上传卡顿、没有视频丢失、没有暗模式。

[![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)](https://github.com/dj1988022/RecordDrop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=nodedotjs)](package.json)

## 为什么做 RecordDrop？

| 痛点 | RecordDrop 如何解决 |
|---|---|
| **上传卡死，视频丢失** | 本地优先：视频先落盘，再上传 |
| **强制登录才能录制** | 打开页面就能录，无需账号 |
| **取消订阅像解谜** | 自托管 = 没有订阅陷阱 |
| **被大厂收购后变差** | 开源、社区驱动、没有资本压力 |

## 快速开始

### Docker（推荐）

```bash
docker run -d \
  --name recorddrop \
  -p 80:3000 \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/metadata:/app/metadata \
  ghcr.io/dj1988022/recorddrop:latest
