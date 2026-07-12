// 限流防线回归纯内存 Map 吞吐
const userCache = new Map();

const menuCache = new Map();
const subCache = new Map();

// 全局首发固化高性能单例时钟实例
const bjsFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

let botUsernameCache = null;
let botUsernamePromise = null;

// 设立由 KV 触发机制维护的一级常驻主哈希表
let memoryRulesCache = null; 
let memoryRulesMap = new Map(); 
let memoryRulesTime = 0;

let memoryBlacklistCache = null; 
let memoryBlacklistSet = new Set(); 
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
          
          if (update.message.text === "/start") {
            ctx.waitUntil(setupDynamicMenu(chatId, isAdmin, env.BOT_TOKEN));
          }
        }

        if (update.message && update.message.chat.type === "private" && update.message.text) {
          const chatId = update.message.chat.id;
          const now = Date.now();
          
          // 🧠 概率随机主动扫描抽稀清理法（概率 1%），保持内存处于健康水位
          if (Math.random() < 0.01) {
            for (const [id, cacheItem] of menuCache.entries()) {
              if (now >= cacheItem.expire) menuCache.delete(id);
            }
            for (const [id, cacheItem] of subCache.entries()) {
              if (now >= cacheItem.expire) subCache.delete(id);
            }
            for (const [id, cacheItem] of userCache.entries()) {
              if (now >= cacheItem.expire) userCache.delete(id);
            }
          }

          // 极致性能的纯内存 Map 防刷漏斗
          const uCache = userCache.get(chatId);
          if (uCache && now < uCache.expire) {
            if (now - uCache.lastTime < 1000) {
              uCache.count += 1;
              if (uCache.count > 3) {
                console.warn(`[Rate Limit] Throttled user ${chatId} in memory.`);
                return new Response("OK"); 
              }
            } else {
              uCache.count = 1;
            }
            uCache.lastTime = now;
          } else {
            userCache.set(chatId, { lastTime: now, count: 1, expire: now + 3000 });
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
  const cache = menuCache.get(chatId);
  if (cache && cache.expire > Date.now()) return;

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
    
    menuCache.set(chatId, {
      expire: Date.now() + 24 * 3600 * 1000
    });

  } catch (err) {
    console.error("Dynamic menu scope matching error:", err);
  }
}

async function getBotUsername(env) {
  if (botUsernameCache) return botUsernameCache;

  if (!botUsernamePromise) {
    botUsernamePromise = telegramApi(env.BOT_TOKEN, "getMe")
      .then(info => {
        botUsernameCache = info.username;
        botUsernamePromise = null; 
        return botUsernameCache;
      })
      .catch(err => {
        botUsernamePromise = null; 
        throw err;
      });
  }
  return botUsernamePromise;
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
        text: "❌ <b>操作失败</b>\n\n动态管理与黑名单功能必须绑定 KV 命名空间！",
        parse_mode: "HTML"
      });
      return;
    }

    if (text.startsWith("拉黑#") || text.startsWith("解黑#")) {
      const targetId = text.split("#")[1].trim();
      if (!targetId) return;

      let blacklist = [];
      if (memoryBlacklistCache && (now - memoryBlacklistTime < 15000)) {
        blacklist = memoryBlacklistCache;
      } else {
        try {
          const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
          // 👑 完美修正：融入三元断言，当KV被整体删空时，无缝同步清洗内存，阻断脏读死锁
          blacklist = rawBlacklist ? JSON.parse(rawBlacklist) : [];
        } catch (e) {
          blacklist = [];
        }
      }

      if (text.startsWith("拉黑#")) {
        if (!blacklist.includes(targetId)) {
          blacklist.push(targetId);
          await env.TG_LIMIT_KV.put("BLACKLIST_USERS", JSON.stringify(blacklist));
        }
        memoryBlacklistCache = blacklist;
        memoryBlacklistTime = now;
        memoryBlacklistSet = new Set(blacklist.map(id => String(id)));

        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🚫 <b>拉黑成功！</b>\n\n用户 ID <code>${escapeHtml(targetId)}</code> 已变入小黑屋，彻底丧失获取节点的权限。`,
          parse_mode: "HTML"
        });
      } else {
        blacklist = blacklist.filter(id => id !== targetId);
        await env.TG_LIMIT_KV.put("BLACKLIST_USERS", JSON.stringify(blacklist));
        memoryBlacklistCache = blacklist;
        memoryBlacklistTime = now;
        memoryBlacklistSet = new Set(blacklist.map(id => String(id)));

        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🔓 <b>解封成功！</b>\n\n用户 ID <code>${escapeHtml(targetId)}</code> 已被移出黑名单，恢复正常使用权限。`,
          parse_mode: "HTML"
        });
      }
      return;
    }

    let currentRules = [];
    if (memoryRulesCache && (now - memoryRulesTime < 15000)) {
      currentRules = memoryRulesCache;
    } else {
      try {
        const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
        // 👑 完美修正：动态管理时同步并入三元判定，确保添加/删除时底层数组永远逻辑统一
        currentRules = rawRules ? JSON.parse(rawRules) : [];
      } catch (e) {
        currentRules = [];
      }
    }

    if (text.startsWith("添加#")) {
      const parts = text.split("#");
      if (parts.length < 4) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "❌ <b>格式错误</b>\n\n请严格使用全新格式添加：\n<code>添加#关键词或网址#频道显示的遮罩备注#节点或网站真实内容</code>",
          parse_mode: "HTML"
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
      memoryRulesMap = new Map(currentRules.map(r => [r.keywords.toLowerCase(), r]));

      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: `✅ <b>入库分类成功！</b>\n\n• <b>触发指令</b>：<code>${escapeHtml(keywords)}</code>\n• <b>频道备注</b>：<code>${escapeHtml(customMemo)}</code>\n• <b>保存内容</b>：已成功自动归类存储，全网实时生效。`,
        parse_mode: "HTML"
      });

      ctx.waitUntil((async () => {
        try {
          const botUsername = await getBotUsername(env);
          
          const cleanKeywords = escapeHtml(keywords);
          const cleanMemo = escapeHtml(customMemo);
          
          let isUrl = false;
          if (keywords.toLowerCase().startsWith("http://") || keywords.toLowerCase().startsWith("https://")) {
            isUrl = true;
          }

          let displayTag = `<b>${cleanKeywords}</b>`;
          if (isUrl) {
            const safeUrl = encodeURI(keywords).replace(/"/g, "%22");
            displayTag = `<a href="${safeUrl}">${cleanMemo}</a>`;
          }

          const channelNotice = 
            `📢 <b>【系统专属分发动态上新】</b>\n\n` +
            `⚡ 刚刚为您上新/优化了 ${displayTag} 相关的专属获取规则！\n\n` +
            `🔒 <i>提示：敏感节点数据、内部私密网站以及福利文本已全部进行加密与安全脱敏隐藏。</i>\n\n` +
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
      const deleteParam = text.split("#")[1].trim();
      if (!deleteParam) return;

      const index = parseInt(deleteParam, 10) - 1;

      if (!isNaN(index) && index >= 0 && index < currentRules.length) {
        const removedRule = currentRules[index];
        currentRules.splice(index, 1);
        await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
        memoryRulesCache = currentRules;
        memoryRulesTime = now;
        memoryRulesMap = new Map(currentRules.map(r => [r.keywords.toLowerCase(), r]));

        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `🗑️ <b>精准选择性删除成功！</b>\n\n已彻底从数据库中移除规则：\n• <b>关键词</b>：<code>${escapeHtml(removedRule.keywords)}</code>\n• <b>备注</b>：<code>${escapeHtml(removedRule.customMemo)}</code>`,
          parse_mode: "HTML"
        });
      } else {
        const initialLength = currentRules.length;
        currentRules = currentRules.filter(r => r.keywords.toLowerCase() !== deleteParam.toLowerCase());

        if (currentRules.length === initialLength) {
          await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `⚠️ <b>未找到对应的规则</b>\n\n输入的数字编号超出范围，或未匹配到关键词：<code>${escapeHtml(deleteParam)}</code>`,
            parse_mode: "HTML"
          });
        } else {
          await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
          memoryRulesCache = currentRules;
          memoryRulesTime = now;
          memoryRulesMap = new Map(currentRules.map(r => [r.keywords.toLowerCase(), r]));

          await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `🗑️ <b>删除成功！</b>\n\n已通过匹配关键词彻底移除规则。`,
            parse_mode: "HTML"
          });
        }
      }
      return;
    }
  }

  if (text === "/manage") {
    if (!isAdmin) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "⛔ <b>权限拒绝</b>\n\n您不是本机器人的最高管理员，无权调用此控制面板。",
        parse_mode: "HTML"
      });
      return;
    }

    let currentRules = [];
    if (memoryRulesCache && (now - memoryRulesTime < 60000)) {
      currentRules = memoryRulesCache;
    } else if (env.TG_LIMIT_KV) {
      try {
        const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
        // 👑 完美修正：控制面板开闸查询时同步融入三元判定，将清空状态的同步彻底规范化
        currentRules = rawRules ? JSON.parse(rawRules) : [];
        memoryRulesCache = currentRules;
        memoryRulesTime = now;
        memoryRulesMap = new Map(currentRules.map(r => [r.keywords.toLowerCase(), r]));
      } catch (e) {
        currentRules = [];
      }
    }

    let rulesListText = "";
    if (currentRules.length === 0) {
      rulesListText = "<i>(暂无动态规则，请使用下方模板添加)</i>\n\n";
    } else {
      currentRules.forEach((rule, i) => {
        const escapedKey = escapeHtml(rule.keywords);
        const escapedMemo = escapeHtml(rule.customMemo);
        rulesListText += `<b>${i + 1}.</b> <code>${escapedKey}</code>\n<blockquote>└ ${escapedMemo}</blockquote>`;
      });
    }

    const botUsername = await getBotUsername(env);
    const myBotUrl = `https://t.me/${botUsername}`;

    const manageText = 
      `🛠️ <b>管理控制台</b>\n\n` +
      `📊 <b>当前 KV 数据库规则明细：</b>\n\n` +
      `${rulesListText}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📥 <b>快捷管理指令模板 (一键秒触复制)：</b>\n\n` +
      `• <b>添加/更新任意文本或配置节点</b>\n` +
      `<code>添加#香港节点#香港专线#这里填写真实节点或任意回复内容</code>\n\n` +
      `• <b>添加网页绿色遮罩引流</b>\n` +
      `<code>添加#https://t.me/yourgroup#交流群#欢迎加入官方群组！</code>\n\n` +
      `• <b>添加机器人公告引流</b>\n` +
      `<code>添加#${myBotUrl}#官方公告#本系统已完成架构升级！</code>\n\n` +
      `• <b>添加海报图文大图引流</b>\n` +
      `<code>添加#https://t.me/xqkin/123#查看海报#欢迎参加特惠活动！</code>\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🗑️ <b>选择性精准删除：</b>\n` +
      `• 依据列表编号：<code>删除#1</code>\n` +
      `• 依据触发词条：<code>删除#香港节点</code>\n\n` +
      `🚫 <b>全局黑名单管控：</b>\n` +
      `• 拉黑用户：<code>拉黑#用户纯数字ID</code>\n` +
      `• 解除封禁：<code>解黑#用户纯数字ID</code>\n\n` +
      `💡 <i>提示：修改规则后重新发送 /manage 即可刷新列表。</i>`;

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: manageText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    return;
  }

  // 二级缓存查闸拦截
  if (env.TG_LIMIT_KV && (!memoryBlacklistCache || (now - memoryBlacklistTime >= 60000))) {
    try {
      const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
      // 👑 完美修正：黑名单开闸探测同步融入三元判定，斩断黑名单被人工置空后的脏读隐患
      const blacklist = rawBlacklist ? JSON.parse(rawBlacklist) : [];
      memoryBlacklistCache = blacklist;
      memoryBlacklistTime = now;
      memoryBlacklistSet = new Set(blacklist.map(id => String(id)));
    } catch (e) {
      console.error("Async context refresh blacklist fail:", e);
    }
  }

  if (memoryBlacklistSet.has(String(chatId))) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⛔ <b>访问受限</b>\n\n由于系统检测到您的账户存在异常高频请求或其他违规行为，当前已被限制获取节点信息。如有疑问请联系管理员。",
      parse_mode: "HTML"
    });
    return;
  }

  let isSubscribed = false;
  const subCacheItem = subCache.get(chatId);
  
  if (subCacheItem) {
    if (now < subCacheItem.expire) {
      isSubscribed = subCacheItem.status;
    } else {
      subCache.delete(chatId); 
    }
  }

  if (!subCacheItem || now >= subCacheItem.expire) {
    isSubscribed = await checkChannelSubscription(chatId, env);
    const ttl = isSubscribed ? 60000 : 5000;
    
    subCache.set(chatId, {
      status: isSubscribed,
      expire: now + ttl
    });
  }

  if (!isSubscribed) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ <b>您需要先订阅我们的官方频道，才能使用自动回复功能！</b>\n\n订阅后，请返回此处重新发送您的关键词即可。",
      parse_mode: "HTML",
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
      "🎉 <b>身份验证成功！欢迎使用自动获取系统。</b>\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "📖 <b>【节点获取与使用指南】</b>\n\n" +
      "1️⃣ <b>如何获取节点？</b>\n" +
      "直接在下方对话框中发送对应的<b>关键词</b>即可获取实时节点：\n" +
      "• 发送 <code>香港节点</code> 获取港线专线\n" +
      "• 发送 <code>日本节点</code> 获取低延迟游戏线\n" +
      "• 发送 <code>/help</code> 重新查看此指南\n\n" +
      "2️⃣ <b>如何使用节点？</b>\n" +
      "• 机器人发给你的节点链接，<b>直接点击即可自动复制</b>。\n" +
      "• 复制后打开你的代理客户端，选择“从剪贴板导入”即可完成配置。\n" +
      "3️⃣ <b>节点失效/无法使用怎么办？</b>\n" +
      "如果遇到节点不可用，请直接点击下方按钮联系管理员，我会第一时间进行修复！\n" +
      "━━━━━━━━━━━━━━━";

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: welcomeText,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✍️ 节点不能用？联系老板", url: "https://t.me/AGsykin_bot" }]
        ]
      }
    });
    return;
  }

  if (env.TG_LIMIT_KV && (!memoryRulesCache || (now - memoryRulesTime >= 60000))) {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      // 👑 完美修正：普通发词时同步融入三元判定，完成全链路状态自愈
      const RULES = rawRules ? JSON.parse(rawRules) : [];
      memoryRulesCache = RULES;
      memoryRulesTime = now;
      memoryRulesMap = new Map(RULES.map(r => [r.keywords.toLowerCase(), r]));
    } catch (e) {
      console.error("Async context refresh rules fail:", e);
    }
  }

  if (memoryRulesMap.size === 0 && env.NODE_RULES) {
    const lines = env.NODE_RULES.split('\n');
    const backupRules = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      const separatorIndex = trimmedLine.indexOf('===');
      if (separatorIndex > -1) {
        const keywords = trimmedLine.substring(0, separatorIndex).trim();
        const response = trimmedLine.substring(separatorIndex + 3).trim();
        if (keywords && response) backupRules.push({ keywords, response, customMemo: "🔗 [点击查看详情]" });
      }
    }
    memoryRulesMap = new Map(backupRules.map(r => [r.keywords.toLowerCase(), r]));
  }

  const matchedRule = memoryRulesMap.get(text.toLowerCase());

  if (matchedRule) {
    const formattedResponse = matchedRule.response.replace(/\\n/g, '\n');
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: formattedResponse,
      parse_mode: "HTML"
    });

    if (!isAdmin) {
      ctx.waitUntil((async () => {
        try {
          const rawFirstName = message.from.first_name || "";
          const rawLastName = message.from.last_name || "";
          const username = message.from.username ? `@${message.from.username}` : "无用户名";
          
          const cleanName = escapeHtml(`${rawFirstName} ${rawLastName}`.trim()) || "未知昵称";
          
          const timeString = bjsFormatter.format(new Date());

          const adminNotice = 
            `📢 <b>老板，有用户成功获取了节点！</b>\n\n` +
            `👤 <b>用户昵称</b>：${cleanName}\n` +
            `🆔 <b>用户账号</b>：<code>${message.from.id}</code> (${username})\n` +
            `🔑 <b>触发关键词</b>：<code>${escapeHtml(matchedRule.keywords)}</code>\n` +
            `🔍 <b>保存备注</b>：<code>${escapeHtml(matchedRule.customMemo || "无")}</code>\n` +
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

  await telegramApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "❓ <b>未找到匹配的节点内容。</b>\n\n请检查您的关键词是否正确，或者发送 /help 查看指南。",
    parse_mode: "HTML"
  });
}

async function telegramApi(token, methodName, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${methodName}`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    
    const rawText = await response.text();
    
    if (!response.ok) {
      throw new Error(`Telegram 网关响应 HTTP 状态码异常 [${response.status}]: ${rawText}`);
    }
    
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error(`Telegram API 返回了非标准的非 JSON 脏数据，状态码：${response.status}，返回正文：${rawText}`);
    }
    
    if (!data.ok) {
      throw new Error(`${methodName} API Execution Failed:${data.description}`);
    }
    return data.result;
  } catch (apiErr) {
    if (apiErr.name === "AbortError") {
      throw new Error(`[Timeout Alert] Telegram API 请求超时，8秒内网关未给予业务层响应，已执行硬熔断自救。`);
    }
    throw apiErr;
  } finally {
    clearTimeout(timeout);
  }
}
