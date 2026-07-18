# Cloudflare Worker Telegram 客服机器人 (高级反垃圾盾牌版)

这是一个部署在 Cloudflare Worker 上、基于 Cloudflare D1 数据库构建的 Telegram 双向客服/群组转接机器人。

本版本进行了深度的安全审计与架构重构，引入了 **Cloudflare Turnstile 网页人类行为验证网关**，并采用全异步阻塞落盘与高效包含匹配算法，能够彻底斩断各类自动化垃圾广告群发机的骚扰。

## ✨ 核心特性

*   **🌐 终极反骚扰网关**：新用户发信触发人机拦截，必须跳转浏览器通过 Cloudflare Turnstile 验证后方可解锁聊天权限。
*   **🤖 智能双向转接**：用户在私聊中发信，管理员群组内自动创建独立会话话题（Forum Topic），管理员在话题内回复即可实现双向通信。
*   **📝 加强版自动回复**：支持通过管理后台自定义关键词表达式。匹配成功后自动下发自动回复，**且用户原消息照常转发给管理员**，绝不漏信。
*   **🚫 违禁词高频拉黑**：支持本地添加或一键从 GitHub 远程同步 Spam 逆向广告词库，触发阈值自动执行 D1 数据库永久屏蔽（Block）。
*   **🧑‍💻 协管员多工授权**：支持主管理员通过 D1 数据库在线授权协管员，协管员私聊自动绕过验证并获得客服权限。
*   **💾 全媒体备份流水**：支持配置独立的超级群组作为全盘消息副本备份库，不论文本、图片、视频还是文件均支持静音流水备份。

---

## 🛠️ 前期准备工作

在将代码部署到 Cloudflare Worker 之前，请务必完成以下三项基础准备：

### 1. 申请 Telegram Bot Token & 获取参数
1. 在 Telegram 中私聊 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 按照提示创建一个机器人，获取你的 `BOT_TOKEN`。
2. 开启机器人的群组话题权限（Forum）：在 BotFather 中发送 `/setjoingroups` 和 `/setprivacy`，并确保在群组设置中开启 **Topics** 功能。
3. 新建一个超级群组作为**客服群组**，将你的机器人拉入该群组并提升为管理员，获取该群组的 ID (`ADMIN_GROUP_ID`，通常是以 `-100` 开头的数字)。
4. 获取你本人的 Telegram User ID (`ADMIN_IDS`)，作为主管理员权限。

### 2. 创建 Cloudflare D1 数据库
1. 登录 Cloudflare 控制台，点击左侧菜单栏的 **存储与数据库 (Storage & Databases)** -> **D1**。
2. 点击 **创建数据库 (Create database)** -> 选择 **D1 数据库**。
3. 数据库名称填入：`TG_BOT_DB`（也可以自定义），点击创建。
4. **记住该数据库的 ID**，稍后需要在 `wrangler.toml` 或 Worker 设置中进行绑定。

### 3. 申请 Cloudflare Turnstile 密钥
> ⚠️ **重要提示**：因为 Turnstile 安全环境校验限制，本机器人**必须绑定你的自定义域名**（例如 `tg.yourdomain.com`），不能使用 Cloudflare 默认分配的 `*.workers.dev` 后缀，否则验证码盒子将无法加载。

1. 在 Cloudflare 控制台左侧菜单栏找到并点击 **Turnstile**。
2. 点击 **添加站点 (Add Site)**。
3. **站点名称 (Site name)**：例如 `TG客服机器人验证`。
4. **域 (Domain)**：填入你准备分配给这个 Worker 机器人的**自定义域名**（例如 `tg.yourdomain.com`）。
5. 验证类型选择 **Managed (托管)**，点击创建。
6. 保存生成的两个密钥：
   * **Sitekey (站点密钥)**：用于前端网页渲染。
   * **Secret Key (通信密钥)**：用于后端服务器二次确权。
<img width="567" height="311" alt="image" src="https://github.com/user-attachments/assets/75a10702-017e-4d88-89d9-b67feb5bbb04" />
<img width="1387" height="351" alt="image" src="https://github.com/user-attachments/assets/f7f91976-4c63-40ca-b3ec-b2afc0a75866" />
<img width="1213" height="807" alt="image" src="https://github.com/user-attachments/assets/0e2a5260-0121-4bc1-adb8-8847a45482af" />
<img width="938" height="815" alt="image" src="https://github.com/user-attachments/assets/ffd386f0-ff15-4329-8226-6a5020f94beb" />
<img width="1058" height="427" alt="image" src="https://github.com/user-attachments/assets/27a4a318-a298-4cdb-8830-dc909dc85f99" />

---

## 🚀 部署步骤

### 方式 A：通过 Cloudflare 网页端控制台直接部署 (小白推荐)

1. **创建 Worker**：在 Cloudflare 控制台点击 **Wrangler 和 Worker** -> **创建应用程序** -> **创建 Worker**，命名并保存。
2. **粘贴代码**：点击 **编辑代码 (Edit code)**，将本仓库的 `index.js` 完整代码覆盖粘贴进去，点击 **部署 (Deploy)**。
3. **绑定 D1 数据库**：
   * 返回该 Worker 的管理主页，点击 **设置 (Settings)** -> **绑定 (Bindings)**。
   * 在 **D1 数据库绑定** 处点击 **添加 (Add)**。
   * **变量名称 (Variable name)** 严格填写：`TG_BOT_DB`。
   * **D1 数据库** 选择你刚才创建的那个数据库，保存。
4. **配置环境变量**：
   * 仍在 **设置 (Settings)** 页面，找到 **变量 (Variables)** -> **环境变量**。
   * 点击 **添加 (Add)**，精细添加以下环境变量：

| 变量名称 (Variable Name) | 填写内容示例 | 是否加密 (Encrypt) | 说明 |
| :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | `12345678:ABCdefGhIJK...` | 是 | 你的 Telegram 机器人 Token |
| `ADMIN_GROUP_ID` | `-100123456789` | 否 | 接收客服消息的话题超级群组 ID |
| `ADMIN_IDS` | `987654321` | 否 | 主管理员的 TG ID，多个用逗号隔开 |
| `BOT_DOMAIN` | `https://tg.yourdomain.com` | 否 | 你的 Worker 绑定的自定义域名 (末尾无 `/`) |
| `CF_TURNSTILE_SITEKEY`| `0x4AAAAAA...` | 否 | 第一步申请的 Turnstile Sitekey |
| `CF_TURNSTILE_SECRET` | `0x4AAAAAA...` | 是 | 第一步申请的 Turnstile Secret Key |

5. **绑定自定义域名**：
   * 在 Worker 主页点击 **设置 (Settings)** -> **触发器 (Triggers)**。
   * 在 **自定义域 (Custom Domains)** 处点击 **添加自定义域**，输入你绑定的域名（例如 `tg.yourdomain.com`），保存并等待 Cloudflare 自动解析并签发证书。

6. **激活 Webhook 联通**：
   * 浏览器访问：`https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的自定义域名>`
   * 页面返回 `{"ok":true,"result":true...}` 即代表机器人上线成功！

---

## 📖 使用与管理手册

### 👑 主管理员私聊指令
主管理员直接向机器人私聊发送 `/start` 或 `/help`，可无缝唤醒**核心配置图形菜单**。协管员或普通用户无法窥探和操作此菜单。

*   **📝 基础配置**：查看当前验证模式（锁死为网页验证），在此处可随时**在线修改编辑机器人对用户的欢迎词/提示语**。
*   **🤖 自动回复管理**：
    *   点击 `➕ 新增自动回复规则`。
    *   按照规范格式发送：`关键词1\|关键词2===你的高亮回复文本`（多关键词用 `|` 隔开，关键词与回复内容用 `===` 三等号阻断）。
*   **🚫 关键词屏蔽管理**：
    *   支持手动添加敏感违禁词表达式。
    *   点击 `🔄 同步远程 Spam 词库`，Worker 会自动连接上游安全词库抓取最新的反广告词并自动去重合并。
    *   支持在线调整用户触发屏蔽词被永久拉黑（Block）的计次阈值。
*   **🔗 按类型过滤管理**：在线一键开关多媒体白名单。可随时封锁用户的音频、语音、贴纸、动态 GIF 转发、频道消息穿透等，封堵无脑群发。

### 💬 群组内部客服流交互
*   **开启对话**：新用户通过 Cloudflare Turnstile 验证后，在私聊中发信，管理员群组里会自动建立带有该用户昵称、ID 的专属话题。直接在话题中发信，即可由机器人充当信使，将消息安全推给用户。
*   **一键制裁卡片**：每个客服话题的顶部都固定有持久化资料卡。管理员可直接在话题中点击卡片上的 `🚫 屏蔽此人`、`🔕 静音通知` 或 `📌 置顶此消息` 按钮，所有惩罚状态会高并发落盘，全线同步。

---

## 📝 许可证 (License)

本项目基于 [MIT License](LICENSE) 开源，欢迎提交 Issue 和 Pull Request。
