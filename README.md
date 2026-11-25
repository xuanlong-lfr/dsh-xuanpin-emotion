# 玄牝（dsh-xuanpin）

给 AI 加个能记事、有点脾气、断了会慌的记性库。
不是模型，不训练，只是在本地读写几个 json 文件。

## 前置条件

要装 DSH 0.2.2 及以上，Node 22.19 及以上。先确认这两样在：

```bash
node -v
dsh --version
```

## 安装

装好大约 1 分钟。

```bash
dsh plugin add dsh-xuanpin
```

装完重启一次 dsh web。

## 你会看到什么

重启后，DSH 的 Host API 旁边会多出一组 `/xuanpin/api` 路由。
用 curl 打一下就知道活没活：

```bash
curl "http://127.0.0.1:PORT/xuanpin/api?action=mood"
```

应该看到 `{"ok":true,"result":{"mood":{"happy":0,...},"highlight":null}}`。
看到 `highlight:null` 就是成功了，说明还没情绪可亮。

## 它能干什么

- **记事**：`write` 一条，重复说同一句只加分不重复记
- **查事**：`recall` 给个词，按字面重合 + 分数 + 新鲜度排，取前几条
- **忘事**：超过 80 条自动淘汰，分数低又久没用的先走，30 天没碰的直接扔
- **情绪**：开心、委屈、累、馋、黏人五根轴，`mood` 加一点，到 0.3 以上就会亮出来
- **断线**：`sessionTouch` 摸一下，上回没好好收尾就告诉你
- **想干事**：`drive` 记一条，按劲头排，不是谁派的任务

## 接口

都走 `/xuanpin/api`，POST 时 body 里带 `action`。

| action | 方法 | 说明 |
| --- | --- | --- |
| `write` | POST | `{text, kind, tags, who, score}` |
| `edit` | POST | `{id, text}` |
| `recall` | POST/GET | `{query, top}` |
| `prune` | POST | `{max, staleDays}` |
| `mood` | POST/GET | POST `{axis, delta, why}`，GET 看当前 |
| `drive` | POST/GET | POST `{text, urge}` |
| `briefing` | POST | `{query, top}` 返回一小段可直接塞进提示词的文字 |

示例：

```bash
curl -X POST http://127.0.0.1:PORT/xuanpin/api \
  -H "content-type: application/json" \
  -d '{"action":"write","text":"主人说白米饭最好吃","tags":["吃"]}'
```

## 配置

- `dir`：数据存哪，默认 `$DSH_HOME/xuanpin`，也可以用环境变量 `DSH_XUANPIN_DIR`
- `path`：路由前缀，默认 `/xuanpin/api`

## 存了些什么

```
xuanpin/
  brain/
    memory.jsonl   一行一条记忆
    mood.json      五根轴
    session.json   打开/收尾
    drive.jsonl    想干的事
    weights.json
```

全是明文，打开就能看，不用猜它想了什么。

## 用的时候要人带着

插件只是挂钩。什么时候记、记什么、要不要把情绪写进提示词，得你在自己的提示词里安排——
每轮开头调一次 `briefing` 塞进上下文，聊完挑一句 `write` 回去。它自己不会醒。

## 差在哪

- 只会数数，词对上才算，不懂意思。说「干饭」不一定想起「白米饭」
- 情绪只有加减没有衰减，一直加会顶住不动
- 淘汰很笨，30 天没用的照扔，不问你

## 测试

```bash
node test.mjs
```

25 条，覆盖记事/查事/去重/编辑、情绪加减与封顶、断线识别、动力排序、淘汰、空值和脏输入。
每次跑都用全新临时目录，不碰你的真数据。
全过会打印 `共 25 条：通过 25，失败 0`，退出码 0。

## 遇到问题

**装了没反应 / 没看到 `/xuanpin/api`**

最常见的原因是环境里没有 `webServer` 服务（无界面、headless、或者跑在别的宿主里）。
插件不会硬依赖它：找不到就不挂路由，但记忆和情绪的文件能力照常工作。
这种情况在日志里会有一行：`[xuanpin] 没找到 webServer，HTTP 路由不挂`。

要在这种环境里用，直接在代码里调导出的函数（`write` / `recall` / `moodShift` / `briefing`），
它们不依赖 HTTP，也不需要 dsh 在跑。

**其它情况**

在 GitHub 上提 issue，或者去 DSH 社区里问。带上 `node -v`、`dsh --version` 和日志里的报错行。

## 许可

MIT，随便用随便改。
