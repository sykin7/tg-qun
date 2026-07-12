# Telegram Private Node Bot

> 一个基于 Cloudflare Workers + Telegram Bot API 构建的高性能私聊自动发放机器人。

支持：

- ✅ Cloudflare Workers
- ✅ Telegram Bot API
- ✅ Cloudflare KV
- ✅ 动态节点管理
- ✅ 黑名单系统
- ✅ 自动验证频道订阅
- ✅ 私聊自动回复
- ✅ 后台管理
- ✅ 高频限流
- ✅ Worker 内存缓存优化

---

# 功能

## 自动验证订阅

用户首次使用机器人时，会自动检测是否加入指定频道。

未加入：

- 无法获取节点
- 自动弹出频道按钮

已加入：

- 正常使用机器人

---

## 自动菜单

首次发送：

```

/start

```

机器人自动创建菜单：

普通用户：

```

/start
/help

```

管理员：

```

/start
/help
/manage

```

菜单只创建一次。

24 小时内不会重复调用 Telegram API。

---

## 自动回复

用户发送：

```

香港节点

```

机器人：

```

返回香港节点

```

例如：

```

vmess://xxxxx

```

支持：

- HTML
- 多行文本
- 网站
- 配置
- 节点
- 公告

---

## 动态规则

管理员无需修改代码即可新增规则。

例如：

```

添加#香港节点#香港专线#vmess://xxxx

```

立即生效。

无需重新部署。

所有数据保存在 Cloudflare KV。

---

## 删除规则

支持：

按编号删除：

```

删除#1

```

或者：

按关键词删除：

```

删除#香港节点

```

---

## 黑名单

拉黑：

```

拉黑#123456789

```

解除：

```

解黑#123456789

```

被拉黑用户：

- 无法获取节点
- 自动提示禁止访问

---

## 后台管理

管理员：

```

/manage

```

即可查看：

- 当前所有规则
- 添加模板
- 删除模板
- 黑名单模板

无需登录网页后台。

---

## 获取日志

普通用户获取节点后：

管理员自动收到：

- 用户昵称
- 用户ID
- 用户名
- 获取时间
- 获取关键词
- 获取备注

方便统计。

---

## 自动频道公告

新增规则：

```

添加#香港节点#香港专线#xxxx

```

机器人自动发送频道公告。

例如：

```

📢 系统新增：

香港节点

点击机器人获取

```

无需手动发频道。

---

## API缓存

内置：

Bot Username 缓存

```

getMe()

```

仅调用一次。

---

节点规则缓存：

```

15 秒

```

---

黑名单缓存：

```

15 秒

```

---

频道订阅缓存：

成功：

```

60 秒

```

失败：

```

5 秒

```

---

# 部署教程

## 一、创建 Telegram Bot

打开：

https://t.me/BotFather

发送：

```

/newbot

```

获得：

```

BOT_TOKEN

```

例如：

```

123456:AAxxxxx

```

---

## 二、创建 Cloudflare Worker

登录：

https://dash.cloudflare.com/

Workers & Pages

Create

Worker

---

复制本项目源码。

全部覆盖默认 Worker。

部署。

---

## 三、创建 KV

Cloudflare

Workers

Storage

KV

Create namespace

例如：

```

TG_LIMIT_KV

```

绑定到 Worker。

变量名：

```

TG_LIMIT_KV

```

---

## 四、配置环境变量

Worker

Settings

Variables

添加：

| 名称 | 示例 |
|------|------|
| BOT_TOKEN | Telegram Bot Token |
| CHANNEL_ID | -100xxxxxxxx |
| CHANNEL_LINK | https://t.me/xxxxx |
| ADMIN_ID | Telegram 用户 ID |
| NODE_RULES | 默认规则（可选） |

---

## NODE_RULES 格式

例如：

```

香港节点===vmess://xxxxx

日本节点===trojan://xxxxx

美国节点===vless://xxxxx

```

每行一条。

格式：

```

关键词===回复内容

```

---

## 五、Webhook

浏览器打开：

```

https://api.telegram.org/botBOT_TOKEN/setWebhook?url=https://你的worker.workers.dev

```

返回：

```

{"ok":true}

```

部署完成。

---

# 使用方法

普通用户：

```

/start

```

或者：

```

/help

```

查看帮助。

发送：

```

香港节点

```

即可获取节点。

---

管理员：

发送：

```

/manage

```

查看后台。

新增：

```

添加#香港节点#香港专线#vmess://xxxxx

```

删除：

```

删除#香港节点

```

拉黑：

```

拉黑#123456789

```

解除：

```

解黑#123456789

```

---

# 工作流程

```

用户

↓

发送关键词

↓

Worker

↓

限流

↓

检查黑名单

↓

检查频道订阅

↓

读取缓存

↓

读取 KV

↓

匹配规则

↓

发送节点

↓

通知管理员

```

---

# FAQ

## 修改规则为什么立即生效？

所有规则保存在：

Cloudflare KV

无需重新部署。

---

## 为什么用户无法获取节点？

请确认：

- 已加入频道
- 未进入黑名单
- 关键词正确

---

## 为什么新增规则没有回复？

请确认：

```

添加#关键词#备注#内容

```

格式正确。

---

## 为什么菜单没有刷新？

菜单缓存：

```

24 小时

```

或者重新发送：

```

/start

```

即可。

---

# 技术架构

- Cloudflare Workers
- Cloudflare KV
- Telegram Bot API
- JavaScript ES Module
- Webhook

---

# License

MIT License

```

---

## 我建议再升级一下 README

如果准备放 GitHub，我建议做到**专业开源项目**的水平，再增加：

- 📷 功能截图（机器人聊天界面）
- 🏗️ 系统架构图（Mermaid）
- ⚙️ 环境变量表格（包含是否必填、默认值、说明）
- 📂 项目目录结构
- 🚀 性能特点（缓存、限流、Worker 优化）
- 🔄 更新日志（CHANGELOG）
- 🤝 Contributing（贡献指南）
- ⭐ Star History、License Badge、Cloudflare Workers Badge、Telegram Badge 等徽章

这样 README 长度会达到约 **400~600 行**，基本达到 GitHub 上高质量开源项目的文档标准。
