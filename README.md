# koishi-plugin-share-links-analysis

Koishi 分享链接解析插件。机器人收到支持平台的分享链接后，会自动提取标题、作者、正文、封面、媒体文件和源链接，并按配置发送为普通消息、合并转发或混合模式。

目前插件内置以下平台解析器：

- Bilibili
- Xiaohongshu
- Twitter / X
- Xiaoheihe
- YouTube
- Netease Music
- QQ Music
- Kugou Music
- GitHub

## 功能概览

- 自动识别聊天消息中的分享链接
- 统一输出标题、作者、统计信息、正文、封面、媒体文件和源链接
- 支持普通发送、合并转发、混合发送三种发送模式
- 支持按群组分别开关解析器和 NSFW 策略
- 支持解析结果时间线缓存与媒体文件缓存
- 支持乐观缓存回退，接口异常时优先返回最近一次可用结果
- 支持 CookieCloud 同步和部分平台本地 Cookie 采集
- 支持按平台代理设置
- 支持 `share.directlink` 获取直链，便于排障和手动转发

## 运行要求

这个插件不是一个纯 npm 依赖包，它依赖 Koishi 运行时已经启用的服务：

- `database`
- `puppeteer`
- `http`

另外有两项环境相关前提：

- 如果你使用 `forward` 或 `mixed` 发送模式，当前实现按 OneBot/Napcat 转发消息能力设计，实际兼容性以你的适配器为准。
- YouTube 解析必须额外部署仓库里的 `yt_server.py`，只安装本插件本身不够。

## 配置

### 基础发送

- `Video_ClarityPriority`: 视频清晰度优先级。
- `Max_size`: 允许发送的最大文件大小，单位 MB。
- `useForward`: 发送模式，可选 `plain`、`forward`、`mixed`。
- `usingLocal`: 是否先下载到本地再发送。
- `sendFiles`: 是否发送视频、音频等文件。
- `sendVoice`: 音乐解析时是否额外发送语音。
- `sendLinks`: 在部分发送模式下追加直链。

### 缓存

- `enableCache`: 开启解析缓存和文件缓存。
- `cacheExpiration`: L1 解析缓存有效期，单位小时，`0` 表示永不过期。
- `optimisticCache`: 开启乐观缓存。
- `optimisticExpiration`: L2 乐观缓存保留时长，单位小时，`0` 表示永不过期。
- `autoCleanInterval`: 自动清理检查周期，单位小时，`0` 表示不自动清理。

缓存行为是两层的：

- 解析结果保存在 `sla_parse_timeline`
- 下载过的媒体文件保存在 `sla_file_cache`

当重新解析结果没有变化时，插件会只刷新最新时间线节点的 `last_checked_at`；当结果有变化时，会写入新的时间线节点，并记录自动生成的差异摘要。

### 模板格式

默认模板支持以下占位符：

- `{title}`
- `{cover}`
- `{authorName}`
- `{mainbody}`
- `{stats}`
- `{cache}`
- `{sourceUrl}`

### 群组策略

- `default_parsers`: 全局默认启用的解析器集合
- `allow_sensitive`: 默认是否允许敏感内容

群里可以再用指令覆盖默认值，覆盖结果保存在 `sla_group_settings`。

### 代理与 Cookie

- `proxy`: 全局代理地址
- `proxy_settings.<parser>`: 是否对特定解析器启用代理
- `cookieCloud.*`: CookieCloud 同步配置

插件会优先尝试 CookieCloud，同步不到时，再对支持的平台执行本地 Cookie 采集。

### 路径映射

如果 Koishi 和 OneBot 实现在不同容器或不同挂载路径中运行，需要正确设置：

- `onebotReadDir`
- `localDownloadDir`

这两个配置用于把 Koishi 下载后的本地文件路径映射成 OneBot 侧可读取的路径。

## YouTube 解析服务部署

YouTube 解析依赖仓库内的 `yt_server.py`。TypeScript 侧会向这个服务的 `/api/parse` 发起请求；插件配置项 `youtube_ApiUrl` 填的是服务基础地址，不是完整接口地址。

### 环境要求

- Python 3.8+
- Node.js
- 可访问 YouTube 的网络代理

`yt-dlp` 这里通过 Node runtime 处理 YouTube 相关脚本，所以机器上需要可用的 Node.js。

### 安装依赖

```bash
pip install httpx fastapi uvicorn yt-dlp
```

### 配置代理

编辑 [yt_server.py](./yt_server.py)，修改顶部的 `proxy`：

```python
proxy = "http://127.0.0.1:7890"
```

### 启动服务

```bash
python yt_server.py
```

默认监听：

```text
http://127.0.0.1:12001
```

### 在插件中填写配置

将 `youtube_ApiUrl` 设为：

```text
http://127.0.0.1:12001
```

不要写成 `http://127.0.0.1:12001/api/parse `，因为插件代码会自动拼接 `/api/parse`。

### 这个服务还做了什么

- 启动时自动检查一次 `yt-dlp` 更新
- 每 12 小时自动检查一次更新
- 更新后通过 `os.execv` 热重启自己
- 暴露 `/api/stream` 给插件做媒体流透传

## 支持平台

| 平台            | 说明                               |
|---------------|----------------------------------|
| Bilibili      | 视频、直播、专栏、动态、空间、音频、番剧等常见分享链接      |
| Xiaohongshu   | 图文与视频笔记                          |
| Twitter / X   | 推文内容与媒体                          |
| Xiaoheihe     | 帖子内容与媒体                          |
| YouTube       | 视频与 Shorts，需要独立 Python 服务        |
| Netease Music | 歌曲、节目，依赖 NeteaseCloudMusicApi 服务 |
| QQ Music      | 常见歌曲分享链接                         |
| Kugou Music   | 常见歌曲分享链接                         |
| GitHub        | 仓库、分支/标签、发行版、用户与组织主页             |

## 指令

所有指令都挂在 `share` 下。

| 指令                                 | 权限 | 作用                                    |
|------------------------------------|----|---------------------------------------|
| `share`                            | 1  | 查看当前群的解析器状态和 NSFW 状态                  |
| `share.parsers [name] [mode]`      | 1  | 开关当前群某个解析器，写入需要群管理员                   |
| `share.nsfw [value]`               | 1  | 开关当前群 NSFW 解析，写入需要群管理员                |
| `share.reset`                      | 1  | 当前群恢复全局默认策略                           |
| `share.checkcache <url> [index]`   | 1  | 查看时间线缓存，或读取指定历史节点                     |
| `share.forceparse <url>`           | 2  | 忽略缓存强制解析，并更新缓存时间线                     |
| `share.forcecache <url>`           | 2  | 强制刷新缓存，但不发送解析结果                       |
| `share.directlink <url> [quality]` | 1  | 获取视频或音频直链，`quality` 支持 `high` / `low` |
| `share.clean`                      | 3  | 清空解析时间线、文件缓存记录和已缓存文件                  |
| `share.refresh`                    | 3  | 强制刷新所有平台 Cookie                       |
| `share.migratecache`               | 4  | 将旧 `sla_parse_cache` 迁移到新时间线结构        |
| `share.migratecacheformat`         | 4  | 迁移新旧 cacheKey 格式并合并重复节点               |
| `share.dropoldcache`               | 4  | 清空并尝试删除旧 `sla_parse_cache`            |

## 数据表

插件会使用这些 Koishi 数据表：

- `sla_parse_timeline`: 解析结果时间线
- `sla_file_cache`: 已下载文件缓存
- `sla_cookie_cache`: 平台 Cookie 缓存
- `sla_group_settings`: 群组解析器与 NSFW 覆盖配置
- `sla_parse_cache`: 不在使用，支持通过迁移指令迁移到新数据库

## 开发说明

### 目录结构

- [src/index.ts](./src/index.ts): 插件入口、命令注册、缓存生命周期、数据库模型
- [src/core.ts](./src/core.ts): 解析器注册与分发
- [src/types.ts](./src/types.ts): 类型定义与 Koishi 模块扩展
- [src/utils.ts](./src/utils.ts): 下载、缓存、Cookie、发送、代理、权限判断
- [src/parsers/](./src/parsers): 各平台解析器实现


### 新增平台解析器

1. 在 `src/parsers/` 下新增平台文件。
2. 实现统一的解析器接口：`name`、`match()`、`process()`，按需补充 `init()`、`lc_get_cookie()`、`getFileCacheKey()`。
3. 在 src/core.ts 的 `parsers` 数组中注册。

## 鸣谢

本插件的实现参考或依赖了以下项目与资料：

- [koishi-plugin-bilibili-videolink-analysis](https://github.com/shangxueink/koishi-shangxue-apps/tree/main/plugins/bilibili-videolink-analysis)
- [koishi-plugin-bili-parser](https://github.com/summonhim/koishi-plugin-bili-parser)
- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
- [koishi-plugin-xiaohongshu](https://www.npmjs.com/package/koishi-plugin-xiaohongshu) 以及解析方式原作者：[@MuJie](https://mu-jie.cc/)
- [BetterTwitFix](https://github.com/dylanpdx/BetterTwitFix)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)

## License

本项目采用 [MIT](LICENSE) 开源许可。
