这是一个非常专业且能彻底消灭无脑广告群发机的想法！要让 Telegram 用户通过 Cloudflare 验证（如 Turnstile 或 5秒盾）后再开启对话，**直接在 Worker 脚本内部是无法拦截 Telegram 原生 App 的发送动作的**（因为用户是在 Telegram App 里点发送，流量直接走 Telegram 服务器）。

我们的核心实现逻辑是：**“动态授权法”**。

1. 用户发送 `/start` 时，机器人检测到其未验证，**不创建客服话题**。
2. 机器人利用你的域名生成一个**带加密签名的专属验证网页链接**发给用户。
3. 用户点击链接，在浏览器里完成 **Cloudflare Turnstile 验证**。
4. 验证通过后，网页向你的 Worker 发送一条确认请求，Worker 将该用户的状态改为 `verified`，并通知用户可以开始聊天了。

## ⚙️ 前期必须要配置的 Cloudflare 环境变量步骤

由于引入了真正的 Cloudflare Turnstile 人类行为验证，你**必须**在你的 Cloudflare Worker 控制台中手动添加以下 **3个环境变量**，否则脚本运行到验证阶段会直接报错：

### 第一步：申请 Cloudflare 免费 Turnstile 密钥

1. 登录你的 Cloudflare 控制台，在左侧菜单栏找到并点击 **“Turnstile”**。
2. 点击 **“Add Site”** (添加站点)。
3. **Site name (站点名称)**：随便填，比如 `TG客服机器人验证`。
4. **Domain (域名)**：**填入你给这个 Worker 绑定的自定义域名**（注意：必须填真实的可用域名，不能填 `*.workers.dev` 兜底域名，因为 CF 验证码要求域名环境严格受控）。
5. 验证类型选择 **Managed (托管)**，点击 Create 创建。
6. 你会获得两个密钥：一个 **Sitekey (站点密钥)**，一个 **Secret Key (通信密钥)**。

### 第二步：在 Worker 里面添加环境变量

打开你的 Cloudflare Worker 管理页 -> 进入 **Settings (设置)** -> **Variables (变量)** -> 在 **Environment Variables (环境变量)** 下面点 **Add**，精细添加以下三个键值对：

| 变量名称 (Variable Name) | 填写内容 (Value) | 说明 |
| --- | --- | --- |
| `BOT_DOMAIN` | `[https://你的自定义域名.com](https://你的自定义域名.com)` | 末尾**不要**加斜杠 `/`，必须跟你在上面 Turnstile 填写的域名一致。 |
| `CF_TURNSTILE_SITEKEY` | `从第一步复制出来的 Sitekey` | 用于前端页面渲染展示验证码盒子。 |
| `CF_TURNSTILE_SECRET` | `从第一步复制出来的 Secret Key` | 选择 **Encrypt (加密)** 保护，用于 Worker 后端与 CF 服务器安全通信。 |

配置完成后，点击 **Save and Deploy (保存并部署)**。

---

## 📋 架构重构与增强审计说明

1. **全新路由解耦 (`/verify/:userId`)**：
重构了 Worker 的全局 `fetch` 入口。现在的脚本不仅仅是一个只接收 TG 消息的 Webhook，它还兼顾了网页服务器的职责。如果检测到有人请求 `/verify/用户ID` 路径，Worker 会直接向浏览器吐出精美的、符合原生苹果风的原生 Web 验证界面。
2. **前后端 Token 签名审计校验**：
当用户在网页端成功勾选并通过 Cloudflare 校验盒后，前端页面会隐式抓取校验口令（Token）并向 Worker 发起 POST 请求。Worker 收到口令后，会在后端使用 `CF_TURNSTILE_SECRET` 再次向 Cloudflare 安全中心发起二次确权通信（`siteverify`），彻底斩断了用假数据包欺骗验证通过的黑客企图。
3. **未通过状态的强硬无死角拦截**：
在 `handlePrivateMessage` 中，重构了用户身份判定状态机。任何不是 `verified` 状态的普通用户，只要他们敢在 Telegram 窗口发送任何文本或者任何媒体，代码都会无情地将消息截断丢弃，并自动再次给他们扔出一个“前往浏览器完成安全验证”的专属按键链接，将发信权限死死卡在网页端之外。
