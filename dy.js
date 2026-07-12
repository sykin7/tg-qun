// 在全局内存中开辟计数器，用于实施一秒2次的防刷熔断机制
const userCache = new Map();

export default {
  async fetch(request, env, ctx) {
    // 基础安全隔离：如果核心环境变量缺失，直接报错拦截
    if (!env.BOT_TOKEN || !env.CHANNEL_ID || !env.CHANNEL_LINK) {
      return new Response("Error: Critical environment variables are missing.", { status: 500 });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        
        // 严格限定：只处理私聊纯文本消息
        if (update.message && update.message.chat.type === "private" && update.message.text) {
          const chatId = update.message.chat.id;
          const now = Date.now();
          
          // 🛡️ 核心防刷屏卡点：如果同一个用户在 1 秒（1000毫秒）内发送超过 2 次消息，直接对其熔断
          if (userCache.has(chatId)) {
            const userData = userCache.get(chatId);
            if (now - userData.lastTime < 1000) {
              userData.count += 1;
              if (userData.count > 2) {
                console.warn(`用户 ${chatId} 正在恶意刷屏，已被 Worker 强制熔断拦截。`);
                return new Response("OK"); // 假动作响应 OK，但 CF 内部直接终止，绝不调取 Telegram API，省电省额度
              }
            } else {
              userData.count = 1; // 超过 1 秒，重置计数
            }
            userData.lastTime = now;
          } else {
            userCache.set(chatId, { lastTime: now, count: 1 }); // 新用户初始化
          }

          // 定期自动清理小黑屋内存，防止 Worker 运行内存溢出
          if (userCache.size > 500) {
            for (const [id, data] of userCache.entries()) {
              if (now - data.lastTime > 5000) userCache.delete(id);
            }
          }

          // 频率安全，放行进入核心订阅验证与业务分发逻辑
          ctx.waitUntil(handlePrivateMessage(update.message, env));
        }
      } catch (e) {
        console.error("Webhook processing error:", e);
      }
    }
    return new Response("OK");
  }
};

// ==========================================
// 核心业务处理逻辑（严格卡点）
// ==========================================
async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!text) return;

  // 🔒 第一道防线：强制订阅判定（核心卡点，未订阅或异常失败绝不放行）
  const isSubscribed = await checkChannelSubscription(chatId, env);

  if (!isSubscribed) {
    // 未订阅用户，直接下发强力拦截文案及加入频道按钮
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ **您需要先订阅我们的官方频道，才能使用自动回复功能！**\n\n订阅后，请返回此处重新发送您的关键词即可。",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 立即订阅官方频道", url: env.CHANNEL_LINK }]
        ]
      }
    });
    return; // 强行阻断死锁，绝对无法向下运行
  }

  // 2. 已通过订阅验证，处理系统内置基础指令（小白指南与双向客服入口）
  if (text === "/start" || text === "/help") {
    const welcomeText = 
      "🎉 **身份验证成功！欢迎使用自动获取系统。**\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "📖 **【节点获取与使用指南】**\n\n" +
      "1️⃣ **如何获取节点？**\n" +
      "直接在下方对话框中发送对应的**关键词**即可获取实时节点：\n" +
      "• 发送 `香港节点` 获取港线专线\n" +
      "• 发送 `日本节点` 获取低延迟游戏线\n" +
      "• 发送 `帮助` 重新查看此指南\n\n" +
      "2️⃣ **如何使用节点？**\n" +
      "• 机器人发给你的节点链接，**直接点击即可自动复制**。\n" +
      "• 复制后打开你的代理客户端（如 Clash / v2rayN / Shadowrocket），选择“从剪贴板导入”即可完成配置。\n\n" +
      "3️⃣ **节点失效/无法使用怎么办？**\n" +
      "如果遇到节点不可用、网络波动或其它技术故障，请直接点击下方按钮联系管理员，我会第一时间进行修复！\n" +
      "━━━━━━━━━━━━━━━";

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: welcomeText,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✍️ 节点不能用？联系老板", url: "https://t.me/AGsykin_bot" }]
        ]
      }
    });
    return;
  }

  // ==========================================
  // 📝 纯文本变量动态解析（一行一条，防崩溃过滤）
  // ==========================================
  const RULES = [];
  if (env.NODE_RULES) {
    const lines = env.NODE_RULES.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue; // 过滤空行

      const separatorIndex = trimmedLine.indexOf('===');
      if (separatorIndex > -1) {
        const keywords = trimmedLine.substring(0, separatorIndex).trim();
        const response = trimmedLine.substring(separatorIndex + 3).trim();
        if (keywords && response) {
          RULES.push({ keywords, response });
        }
      }
    }
  }

  // 3. 稳妥的字符串包含匹配机制
  for (const rule of RULES) {
    if (text.toLowerCase().includes(rule.keywords.toLowerCase())) {
      // 支持通过 \n 进行文本内换行解析
      const formattedResponse = rule.response.replace(/\\n/g, '\n');
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: formattedResponse,
        parse_mode: "Markdown"
      });
      return;
    }
  }

  // 4. 未匹配到任何节点关键词的兜底回复
  await telegramApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "❓ **未找到匹配的节点内容。**\n\n请检查您的关键词是否正确，或者发送 `/help` 查看指南。",
    parse_mode: "Markdown"
  });
}

// ==========================================
// 🛡️ 强制订阅安全性隔离函数
// ==========================================
async function checkChannelSubscription(userId, env) {
  try {
    const res = await telegramApi(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.CHANNEL_ID,
      user_id: userId
    });
    // 只有这三种状态属于有效订阅者：创建者、管理员、普通成员
    const validStatuses = ["creator", "administrator", "member"];
    return validStatuses.includes(res.status);
  } catch (e) {
    // 安全加固：如果接口请求报错，一律视为未订阅（返回 false），严防异常绕过漏洞。
    console.error("Critical: Failed to verify channel membership:", e);
    return false;
  }
}

// ==========================================
// Telegram API 请求封装
// ==========================================
async function telegramApi(token, methodName, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${methodName}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${methodName} API Execution Failed:${data.description}`);
  }
  return data.result;
}
