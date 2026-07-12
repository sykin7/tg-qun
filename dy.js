// 【局部内存计数器】—— 仅作为无 KV 绑定时的安全兜底
const userCache = new Map();

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.CHANNEL_ID || !env.CHANNEL_LINK) {
      return new Response("Error: Critical environment variables are missing.", { status: 500 });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        
        if (update.message && update.message.chat.type === "private" && update.message.text) {
          const chatId = update.message.chat.id;
          const now = Date.now();
          
          // ==========================================
          // 🛡️ 完美适配：分布式全局同步限流器 (KV 模式)
          // ==========================================
          // 如果你在 CF 后台绑定了名为 TG_LIMIT_KV 的空间，系统会自动平滑切换到最强防灾模式
          if (env.TG_LIMIT_KV) {
            const kvKey = `rate:${chatId}`;
            let kvData = null;
            
            try {
              // 从远程分布式 KV 中读取当前用户的发信记录
              const rawData = await env.TG_LIMIT_KV.get(kvKey);
              if (rawData) kvData = JSON.parse(rawData);
            } catch (kvErr) {
              console.error("读取 KV 失败，降级使用局部内存:", kvErr);
            }

            // 如果 KV 里面没有记录，或者距离上一次发信已经超过 1 秒，初始化计数
            if (!kvData || (now - kvData.lastTime >= 1000)) {
              kvData = { lastTime: now, count: 1 };
            } else {
              // 1 秒之内连续发信，计数器累加
              kvData.count += 1;
              if (kvData.count > 2) {
                console.warn(`[KV 熔断] 用户 ${chatId} 触发全局分布式超频限制，直接抹杀请求。`);
                return new Response("OK"); // 强行丢弃恶意刷屏请求
              }
              kvData.lastTime = now;
            }

            // 将最新计数异步写入 KV，并设置 60 秒后自动物理过期销毁，绝不堆积垃圾数据数据流
            ctx.waitUntil(env.TG_LIMIT_KV.put(kvKey, JSON.stringify(kvData), { expirationTtl: 60 }));
          } else {
            // ==========================================
            // 🛡️ 兜底方案：局部内存限流器 (单实例模式)
            // ==========================================
            if (userCache.has(chatId)) {
              const userData = userCache.get(chatId);
              if (now - userData.lastTime < 1000) {
                userData.count += 1;
                if (userData.count > 2) return new Response("OK");
              } else {
                userData.count = 1; 
              }
              userData.lastTime = now;
            } else {
              userCache.set(chatId, { lastTime: now, count: 1 });
              // 3 秒后必须自动从小黑屋抹除，防范隐患2内存堆积
              setTimeout(() => { userCache.delete(chatId); }, 3000);
            }
          }

          ctx.waitUntil(handlePrivateMessage(update.message, env));
        }
      } catch (e) {
        console.error("Webhook processing error:", e);
      }
    }
    return new Response("OK");
  }
};

async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!text) return;

  // 🔒 第一道防线：强制订阅判定
  const isSubscribed = await checkChannelSubscription(chatId, env);

  if (!isSubscribed) {
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
    return;
  }

  // 2. 基础内置指令
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
      "• 复制后打开你的代理客户端，选择“从剪贴板导入”即可。\n\n" +
      "3️⃣ **节点失效/无法使用怎么办？**\n" +
      "如果遇到节点不可用，请直接点击下方按钮联系管理员！\n" +
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

  // 3. 纯文本变量动态解析一条
  const RULES = [];
  if (env.NODE_RULES) {
    const lines = env.NODE_RULES.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

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

  for (const rule of RULES) {
    if (text.toLowerCase().includes(rule.keywords.toLowerCase())) {
      const formattedResponse = rule.response.replace(/\\n/g, '\n');
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: formattedResponse,
        parse_mode: "Markdown"
      });
      return;
    }
  }

  await telegramApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "❓ **未找到匹配的节点内容。**\n\n请检查您的关键词是否正确，或者发送 `/help` 查看指南。",
    parse_mode: "Markdown"
  });
}

async function checkChannelSubscription(userId, env) {
  try {
    const res = await telegramApi(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.CHANNEL_ID,
      user_id: userId
    });
    const validStatuses = ["creator", "administrator", "member"];
    return validStatuses.includes(res.status);
  } catch (e) {
    console.error("Critical: Failed to verify channel membership:", e);
    return false;
  }
}

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
