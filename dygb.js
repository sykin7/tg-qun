const userCache = new Map();

let memoryRulesCache = null;
let memoryRulesTime = 0;
let memoryBlacklistCache = null;
let memoryBlacklistTime = 0;

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.CHANNEL_ID || !env.CHANNEL_LINK || !env.ADMIN_ID) {
      return new Response("Error: Critical environment variables are missing.", { status: 500 });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        
        if (update.message && update.message.chat.type === "private") {
          const chatId = update.message.chat.id;
          const isAdmin = String(chatId) === String(env.ADMIN_ID).trim();
          
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

          ctx.waitUntil(handlePrivateMessage(update.message, env, ctx));
        }
      } catch (e) {
        console.error("Webhook processing error:", e);
      }
    }
    return new Response("OK");
  }
};

async function setupDynamicMenu(chatId, isAdmin, token) {
  try {
    if (isAdmin) {
      await telegramApi(token, "setMyCommands", {
        commands: [
          { command: "start", description: "🚀 唤醒并验证身份" },
          { command: "help", description: "📖 查看节点获取指南" },
          { command: "manage", description: "🛠️ 老板专属控制台" }
        ],
        scope: { type: "chat", chat_id: chatId }
      });
    } else {
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

async function handlePrivateMessage(message, env, ctx) {
  const chatId = message.chat.id;
  const rawText = message.text;

  if (typeof rawText !== 'string') return;
  const text = rawText.trim();
  if (!text) return;

  const isAdmin = String(chatId) === String(env.ADMIN_ID).trim();
  const now = Date.now();

  if (isAdmin && (text.startsWith("添加#") || text.startsWith("删除#") || text.startsWith("拉黑#") || text.startsWith("解黑#"))) {
    if (!env.TG_LIMIT_KV) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "❌ **操作失败**\n\n动态管理与黑名单功能必须绑定 KV 命名空间！",
        parse_mode: "Markdown"
      });
      return;
    }

    if (text.startsWith("拉黑#") || text.startsWith("解黑#")) {
      const targetId = text.split("#")[1].trim();
      if (!targetId) return;

      let blacklist = [];
      try {
        const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
        if (rawBlacklist) blacklist = JSON.parse(rawBlacklist);
      } catch (e) {
        blacklist = [];
      }

      if (text.startsWith("拉黑#")) {
        if (!blacklist.includes(targetId)) {
          blacklist.push(targetId);
          await env.TG_LIMIT_KV.put("BLACKLIST_USERS", JSON.stringify(blacklist));
        }
        memoryBlacklistCache = blacklist;
        memoryBlacklistTime = now;
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🚫 **拉黑成功！**\n\n用户 ID \`${targetId}\` 已被关进小黑屋，彻底丧失获取节点的权限。`,
          parse_mode: "Markdown"
        });
      } else {
        blacklist = blacklist.filter(id => id !== targetId);
        await env.TG_LIMIT_KV.put("BLACKLIST_USERS", JSON.stringify(blacklist));
        memoryBlacklistCache = blacklist;
        memoryBlacklistTime = now;
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🔓 **解封成功！**\n\n用户 ID \`${targetId}\` 已被移出黑名单，恢复正常使用权限。`,
          parse_mode: "Markdown"
        });
      }
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
      if (parts.length < 4) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "❌ **格式错误**\n\n请严格使用全新格式添加：\n`添加#关键词或网址#频道显示的遮罩备注#节点或网站真实内容`",
          parse_mode: "Markdown"
        });
        return;
      }
      const keywords = parts[1].trim();
      const customMemo = parts[2].trim();
      const response = parts.slice(3).join("#").trim();

      if (!keywords || !customMemo || !response) return;

      currentRules = currentRules.filter(r => r.keywords.toLowerCase() !== keywords.toLowerCase());
      currentRules.push({ keywords, response, customMemo });

      await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
      memoryRulesCache = currentRules;
      memoryRulesTime = now;

      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: `✅ **入库分类成功！**\n\n• **触发指令**：\`${keywords}\`\n• **频道备注**：\`${customMemo}\`\n• **保存内容**：已成功自动归类存储，全网实时生效。`,
        parse_mode: "Markdown"
      });

      ctx.waitUntil((async () => {
        try {
          const botInfo = await telegramApi(env.BOT_TOKEN, "getMe");
          const botUsername = botInfo.username;
          
          const cleanKeywords = keywords.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const cleanMemo = customMemo.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          
          let isUrl = false;
          if (cleanKeywords.toLowerCase().startsWith("http://") || cleanKeywords.toLowerCase().startsWith("https://")) {
            isUrl = true;
          }

          let displayTag = `<b>${cleanKeywords}</b>`;
          if (isUrl) {
            displayTag = `<a href="${keywords}">${cleanMemo}</a>`;
          }

          const channelNotice = 
            `📢 <b>【系统专属分发动态上新】</b>\n\n` +
            `⚡ 刚刚为您上新/优化了 ${displayTag} 相关的专属获取规则！\n\n` +
            `🔒 <i>提示：敏感节点 data、内部私密网站以及福利文本已全部进行加密与安全脱敏隐藏。</i>\n\n` +
            `💬 想要提取相关福利与线路的同学，请点击下方链接直达机器人私聊，并在对话框中发送对应的触发词：\n\n` +
            `👉 <code>${cleanKeywords}</code>\n\n` +
            `🔗 <a href="https://t.me/${botUsername}">🚀 [点击此处一键直达私聊解锁提取]</a>`;

          await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.CHANNEL_ID,
            text: channelNotice,
            parse_mode: "HTML",
            disable_web_page_preview: true
          });
        } catch (channelErr) {
          console.error("Failed to post channel update notification:", channelErr);
        }
      })());

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
        memoryRulesCache = currentRules;
        memoryRulesTime = now;
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
      "请使用以下全新自由备注格式发送给机器人：\n\n" +
      "📥 **[1. 快捷添加/更新节点模板]**\n" +
      "`添加#香港节点#🇭🇰 香港专线#🇭🇰 **香港专线节点已更新**\\n\\n\`vmess://链接xxxxx#备注\``\n\n" +
      "📥 **[2. 快捷添加/链接遮罩模板]**\n" +
      "`添加#https://t.me/your_qun#💬 点击加入技术交流群#欢迎加入官方群组交流！`\n\n" +
      "🗑️ **[3. 快捷下架/删除节点模板]**\n" +
      "`删除#香港节点`\n\n" +
      "🚫 **[4. 快捷拉黑恶意用户模板]**\n" +
      "`拉黑#用户数字ID`\n\n" +
      "🔓 **[5. 快捷解封黑名单用户模板]**\n" +
      "`解黑#用户数字ID`\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "💡 *小白维护技巧：全新格式引入了第三个参数「频道显示的遮罩备注」，当第一个参数是网址时，频道里会直接把网址打包隐藏进你写的这个备注里，实现完美绿色遮罩！*";

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: manageText,
      parse_mode: "Markdown"
    });
    return;
  }

  if (env.TG_LIMIT_KV) {
    let blacklist = [];
    if (memoryBlacklistCache && (now - memoryBlacklistTime < 15000)) {
      blacklist = memoryBlacklistCache;
    } else {
      try {
        const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
        if (rawBlacklist) {
          blacklist = JSON.parse(rawBlacklist);
          memoryBlacklistCache = blacklist;
          memoryBlacklistTime = now;
        }
      } catch (e) {
        console.error("Blacklist KV read error:", e);
        if (memoryBlacklistCache) blacklist = memoryBlacklistCache;
      }
    }

    if (blacklist.includes(String(chatId))) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⛔ **访问受限**\n\n由于系统检测到您的账户存在异常高频请求或其他违规行为，当前已被限制获取节点信息。如有疑问请联系管理员。",
        parse_mode: "Markdown"
      });
      return;
    }
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
      "直接在下方对话框中发送对应的**关键词**即可获取实时节点：\n" +
      "• 发送 `香港节点` 获取港线专线\n" +
      "• 发送 `日本节点` 获取低延迟游戏线\n" +
      "• 发送 `帮助` 重新查看此指南\n\n" +
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
    if (memoryRulesCache && (now - memoryRulesTime < 15000)) {
      RULES = memoryRulesCache;
    } else {
      try {
        const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
        if (rawRules) {
          RULES = JSON.parse(rawRules);
          memoryRulesCache = RULES;
          memoryRulesTime = now;
        }
      } catch (e) {
        console.error("Rules KV read error:", e);
        if (memoryRulesCache) RULES = memoryRulesCache;
      }
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
        if (keywords && response) RULES.push({ keywords, response, customMemo: "🔗 [点击查看详情]" });
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

      if (!isAdmin) {
        ctx.waitUntil((async () => {
          try {
            const rawFirstName = message.from.first_name || "";
            const rawLastName = message.from.last_name || "";
            const username = message.from.username ? `@${message.from.username}` : "无用户名";
            
            const cleanName = `${rawFirstName} ${rawLastName}`.trim()
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;") || "未知昵称";
            
            const timeString = new Date(Date.now() + 8 * 3600000).toISOString()
              .replace('T', ' ')
              .substring(0, 16);

            const adminNotice = 
              `📢 <b>老板，有用户成功获取了节点！</b>\n\n` +
              `👤 <b>用户昵称</b>：${cleanName}\n` +
              `🆔 <b>用户账号</b>：<code>${message.from.id}</code> (${username})\n` +
              `🔑 <b>触发词条</b>：<code>${rule.keywords}</code>\n` +
              `⏱️ <b>获取时间</b>：${timeString} (北京时间)\n\n` +
              `💡 <i>提示：若此用户恶意刷屏，长按复制其账号 ID 后发送「拉黑#用户ID」即可将其永久封禁。</i>`;

            await telegramApi(env.BOT_TOKEN, "sendMessage", {
              chat_id: env.ADMIN_ID,
              text: adminNotice,
              parse_mode: "HTML"
            });
          } catch (err) {
            console.error("Failed to push log to admin:", err);
          }
        })());
      }
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
