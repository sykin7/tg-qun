const userCache = new Map();

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.CHANNEL_ID || !env.CHANNEL_LINK || !env.ADMIN_ID) {
      return new Response("Error: Critical environment variables are missing.", { status: 500 });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        
        // ==========================================
        // 🔑 核心拦截升级：管理员与普通用户菜单动态身份隔离
        // ==========================================
        if (update.message && update.message.chat.type === "private") {
          const chatId = update.message.chat.id;
          const isAdmin = String(chatId) === String(env.ADMIN_ID).trim();
          
          // 利用异步等待机制，在用户初次唤醒或触发交互时，自动刷新其本地的菜单列表结构
          if (update.message.text === "/start" || update.message.text === "/help" || update.message.text === "/manage") {
            ctx.waitUntil(setupDynamicMenu(chatId, isAdmin, env.BOT_TOKEN));
          }
        }

        if (update.message && update.message.chat.type === "private" && update.message.text) {
          const chatId = update.message.chat.id;
          const now = Date.now();
          
          if (env.TG_LIMIT_KV) {
            const kvKey = `rate:${chatId}`;
            let kvData = null;
            try {
              const rawData = await env.TG_LIMIT_KV.get(kvKey);
              if (rawData) kvData = JSON.parse(rawData);
            } catch (kvErr) {
              console.error("KV read error:", kvErr);
            }

            if (!kvData || (now - kvData.lastTime >= 1000)) {
              kvData = { lastTime: now, count: 1 };
            } else {
              kvData.count += 1;
              if (kvData.count > 2) {
                console.warn(`[KV Limit] User ${chatId} throttled.`);
                return new Response("OK"); 
              }
              kvData.lastTime = now;
            }
            ctx.waitUntil(env.TG_LIMIT_KV.put(kvKey, JSON.stringify(kvData), { expirationTtl: 60 }));
          } else {
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

// ==========================================
// 🛡️ 菜单隔离函数：精细控制不同用户的 Scope 菜单显示
// ==========================================
async function setupDynamicMenu(chatId, isAdmin, token) {
  try {
    if (isAdmin) {
      // 老板专属高级菜单：包括普通指令 + 独占的管理指令
      await telegramApi(token, "setMyCommands", {
        commands: [
          { command: "start", description: "🚀 唤醒并验证身份" },
          { command: "help", description: "📖 查看节点获取指南" },
          { command: "manage", description: "🛠️ 老板专属控制台" }
        ],
        scope: { type: "chat", chat_id: chatId }
      });
    } else {
      // 普通用户低调菜单：只保留基本查询功能，彻底抹除管理入口
      await telegramApi(token, "setMyCommands", {
        commands: [
          { command: "start", description: "🚀 唤醒并验证身份" },
          { command: "help", description: "📖 查看节点获取指南" }
        ],
        scope: { type: "chat", chat_id: chatId }
      });
    }
  } catch (err) {
    console.error("Dynamic menu scope matching error:", err);
  }
}

async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!text) return;

  const isAdmin = String(chatId) === String(env.ADMIN_ID).trim();

  if (isAdmin && (text.startsWith("添加#") || text.startsWith("删除#"))) {
    if (!env.TG_LIMIT_KV) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "❌ **操作失败**\n\n动态管理节点功能**必须绑定 KV 命名空间**！",
        parse_mode: "Markdown"
      });
      return;
    }

    let currentRules = [];
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      if (rawRules) currentRules = JSON.parse(rawRules);
    } catch (e) {
      currentRules = [];
    }

    if (text.startsWith("添加#")) {
      const parts = text.split("#");
      if (parts.length < 3) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "❌ **格式错误**\n\n请严格使用以下格式添加：\n`添加#关键词#节点内容`",
          parse_mode: "Markdown"
        });
        return;
      }
      const keywords = parts[1].trim();
      const response = parts.slice(2).join("#").trim();

      if (!keywords || !response) return;

      currentRules = currentRules.filter(r => r.keywords.toLowerCase() !== keywords.toLowerCase());
      currentRules.push({ keywords, response });

      await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));

      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: `✅ **入库分类成功！**\n\n• **触发指令**：\`${keywords}\`\n• **保存内容**：已成功自动归类存储，全网实时生效。`,
        parse_mode: "Markdown"
      });
      return;
    }

    if (text.startsWith("删除#")) {
      const keywords = text.split("#")[1].trim();
      if (!keywords) return;

      const beforeLength = currentRules.length;
      currentRules = currentRules.filter(r => r.keywords.toLowerCase() !== keywords.toLowerCase());

      if (currentRules.length === beforeLength) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `⚠️ **未找到对应的关键词**：\`${keywords}\``,
          parse_mode: "Markdown"
        });
      } else {
        await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🗑️ **删除成功！**\n\n已从数据库中彻底移除关键词为 \`${keywords}\` 的节点规则。`,
          parse_mode: "Markdown"
        });
      }
      return;
    }
  }

  if (text === "/manage") {
    if (!isAdmin) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⛔ **权限拒绝**\n\n您不是本机器人的最高管理员，无权调用此控制面板。",
        parse_mode: "Markdown"
      });
      return;
    }

    const manageText = 
      "🛠️ **【老板专属后台动态管理系统】**\n\n" +
      "请点击下方对应的代码块（点击即可自动复制模板），在对话框中修改后发送给机器人即可：\n\n" +
      "📥 **[1. 快捷添加/更新节点模板]**\n" +
      "`添加#香港节点#🇭🇰 **香港专线节点已更新**\\n\\n\`vmess://链接xxxxx#备注\``\n\n" +
      "🗑️ **[2. 快捷下架/删除节点模板]**\n" +
      "`删除#香港节点`\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "💡 *小白维护技巧：模板中的 `\\n` 代表换行，节点链接两端必须带有反引号 \` 才能让用户点击自动复制。*";

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: manageText,
      parse_mode: "Markdown"
    });
    return;
  }

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

  if (text === "/start" || text === "/help") {
    const welcomeText = 
      "🎉 **身份验证成功！欢迎使用自动获取系统。**\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "📖 **【节点获取与使用指南】**\n\n" +
      "1️⃣ **如何获取节点？**\n" +
      "直接在下方对话框中发送对应的**关键词**即可获取实时节点。\n\n" +
      "• 发送 `香港节点` 获取港线专线\n" +
      "• 发送 `日本节点` 获取低延迟游戏线\n" +
      "• 发送 `备用线路` 获取防失联备用线\n\n" +
      "2️⃣ **如何使用节点？**\n" +
      "• 机器人发给你的节点链接，**直接点击即可自动复制**。\n" +
      "• 复制后打开你的代理客户端，选择“从剪贴板导入”即可完成配置。\n\n" +
      "3️⃣ **节点失效/无法使用怎么办？**\n" +
      "如果遇到节点不可用，请直接点击下方按钮联系管理员，我会第一时间进行修复！\n" +
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

  let RULES = [];
  if (env.TG_LIMIT_KV) {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      if (rawRules) RULES = JSON.parse(rawRules);
    } catch (e) {
      RULES = [];
    }
  }

  if (RULES.length === 0 && env.NODE_RULES) {
    const lines = env.NODE_RULES.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      const separatorIndex = trimmedLine.indexOf('===');
      if (separatorIndex > -1) {
        const keywords = trimmedLine.substring(0, separatorIndex).trim();
        const response = trimmedLine.substring(separatorIndex + 3).trim();
        if (keywords && response) RULES.push({ keywords, response });
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
