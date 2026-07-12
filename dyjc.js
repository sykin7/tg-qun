class TTLCache {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) return null;
    if (Date.now() >= item.expire) {
      this.map.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttl) {
    this.map.set(key, {
      value,
      expire: Date.now() + ttl
    });
  }

  delete(key) {
    this.map.delete(key);
  }

  entries() {
    return this.map.entries();
  }
}

const userCache = new TTLCache();
const menuCache = new TTLCache();
const subCache = new TTLCache();

const CACHE_TTL = {
  MENU: 24 * 60 * 60 * 1000,
  SUBSCRIBED: 60 * 1000,
  UNSUBSCRIBED: 5 * 1000,
  KV_REFRESH: 60 * 1000,
  RATE_LIMIT_WINDOW: 3000,
  BOT_NAME_REFRESH: 24 * 60 * 60 * 1000
};

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
let botUsernameTime = 0;

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
          
          if (Math.random() < 0.01) {
            for (const [id] of menuCache.entries()) menuCache.get(id);
            for (const [id] of subCache.entries()) subCache.get(id);
            for (const [id] of userCache.entries()) userCache.get(id);
          }

          const uCache = userCache.get(chatId);
          if (uCache) {
            if (now - uCache.lastTime < 1000) {
              uCache.count += 1;
              // 👑 完美修正⑤：限流放宽至 1 秒 5 次，完美兼容手机端高频连点，体验极度平滑舒适
              if (uCache.count > 5) {
                console.warn(`[Rate Limit] Throttled user ${chatId} in memory.`);
                return new Response("OK"); 
              }
            } else {
              uCache.count = 1;
            }
            uCache.lastTime = now;
          } else {
            userCache.set(chatId, { lastTime: now, count: 1 }, CACHE_TTL.RATE_LIMIT_WINDOW);
          }

          ctx.waitUntil(
            handlePrivateMessage(update.message, env, ctx, now)
              .catch(err => console.error("Background task worker rejection:", err))
          );
        }
      } catch (e) {
        console.error("Webhook processing error:", e);
      }
    }
    return new Response("OK");
  }
};

async function setupDynamicMenu(chatId, isAdmin, token) {
  if (menuCache.get(chatId)) return;

  try {
    const commands = isAdmin 
      ? [
          { command: "start", description: "🚀 唤醒并验证身份" },
          { command: "help", description: "📖 查看节点获取指南" },
          { command: "manage", description: "🛠️ 老板专属控制台" }
        ]
      : [
          { command: "start", description: "🚀 唤醒并验证身份" },
          { command: "help", description: "📖 查看节点获取指南" }
        ];

    await telegramApi(token, "setMyCommands", {
      commands,
      scope: { type: "chat", chat_id: chatId }
    });
    
    menuCache.set(chatId, true, CACHE_TTL.MENU);
  } catch (err) {
    console.error("Dynamic menu scope matching error:", err);
  }
}

async function getBotUsername(env) {
  // 👑 完美修正④：引入 24 小时自然老化时间戳，既保证高效永久缓存，又彻底消除官方改名时的死锁烂账
  if (botUsernameCache && (Date.now() - botUsernameTime < CACHE_TTL.BOT_NAME_REFRESH)) {
    return botUsernameCache;
  }

  if (!botUsernamePromise) {
    botUsernamePromise = telegramApi(env.BOT_TOKEN, "getMe")
      .then(info => {
        botUsernameCache = info.username;
        botUsernameTime = Date.now();
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

// Telegram HTML 必须 escape
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendMessage(env, chatId, text, extra = {}) {
  return telegramApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

// 👑 完美修正①：主缓存清洗更新函数。严格对传入数据进行 Array 断言判定，物理级过滤脏数据，确保 .toLowerCase() 绝对不崩
function updateRulesCache(rules) {
  const validRules = Array.isArray(rules)
    ? rules.filter(r => r && typeof r.keywords === "string" && r.keywords.trim())
    : [];

  memoryRulesCache = validRules;
  memoryRulesTime = Date.now();
  memoryRulesMap = new Map(validRules.map(r => [r.keywords.trim().toLowerCase(), r]));
}

// 👑 完美修正②：同步并入严格脏数据数据类型净化清洗逻辑，对齐核心常驻时钟
function updateRulesCacheWithCustomTime(rules, customTime) {
  const validRules = Array.isArray(rules)
    ? rules.filter(r => r && typeof r.keywords === "string" && r.keywords.trim())
    : [];

  memoryRulesCache = validRules;
  memoryRulesTime = customTime;
  memoryRulesMap = new Map(validRules.map(r => [r.keywords.trim().toLowerCase(), r]));
}

function updateBlacklistCache(blacklist) {
  const validBlacklist = Array.isArray(blacklist) ? blacklist.filter(id => id !== null && id !== undefined) : [];
  memoryBlacklistCache = validBlacklist;
  memoryBlacklistTime = Date.now();
  memoryBlacklistSet = new Set(validBlacklist.map(id => String(id)));
}

async function handlePrivateMessage(message, env, ctx, now) {
  const chatId = message.chat.id;
  const rawText = message.text;

  if (typeof rawText !== 'string') return;
  const text = rawText.trim();
  if (!text) return;

  const isAdmin = String(chatId) === String(env.ADMIN_ID).trim();

  if (isAdmin && (text.startsWith("添加#") || text.startsWith("删除#") || text.startsWith("拉黑#") || text.startsWith("解黑#"))) {
    await handleAdminCommand(chatId, text, env, ctx, now);
    return;
  }

  if (env.TG_LIMIT_KV && (!memoryBlacklistCache || (now - memoryBlacklistTime >= CACHE_TTL.KV_REFRESH))) {
    try {
      const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
      updateBlacklistCache(rawBlacklist ? JSON.parse(rawBlacklist) : []);
    } catch (e) {
      console.error("Async context refresh blacklist fail:", e);
    }
  }

  if (memoryBlacklistSet.has(String(chatId))) {
    await sendMessage(env, chatId, "⛔ <b>访问受限</b>\n\n由于系统检测到您的账户存在异常高频请求或其他违规行为，当前已被限制获取节点信息。如有疑问请联系管理员。");
    return;
  }

  let isSubscribed = subCache.get(chatId);
  if (isSubscribed === null) {
    isSubscribed = await checkChannelSubscription(chatId, env);
    subCache.set(chatId, isSubscribed, isSubscribed ? CACHE_TTL.SUBSCRIBED : CACHE_TTL.UNSUBSCRIBED);
  }

  if (!isSubscribed) {
    await sendMessage(env, chatId, "⚠️ <b>您需要先订阅我们的官方频道，才能使用自动回复功能！</b>\n\n订阅后，请返回此处重新发送您的关键词即可。", {
      reply_markup: {
        inline_keyboard: [[{ text: "📢 立即订阅官方频道", url: env.CHANNEL_LINK }]]
      }
    });
    return;
  }

  if (text === "/start" || text === "/help") {
    await handleWelcomeCommands(chatId, env);
    return;
  }

  if (text === "/manage") {
    if (!isAdmin) {
      await sendMessage(env, chatId, "⛔ <b>权限拒绝</b>\n\n您不是本机器人的最高管理员，无权调用此控制面板。");
      return;
    }
    await handleManageConsole(chatId, env, now);
    return;
  }

  await handleKeywordMatch(message, text, isAdmin, env, ctx, now);
}

async function handleAdminCommand(chatId, text, env, ctx, now) {
  if (!env.TG_LIMIT_KV) {
    await sendMessage(env, chatId, "❌ <b>操作失败</b>\n\n动态管理与黑名单功能必须绑定 KV 命名空间！");
    return;
  }

  if (text.startsWith("拉黑#") || text.startsWith("解黑#")) {
    await handleBlacklistOp(chatId, text, env, now);
  } else if (text.startsWith("添加#")) {
    await handleRuleAddOp(chatId, text, env, ctx, now);
  } else if (text.startsWith("删除#")) {
    await handleRuleDeleteOp(chatId, text, env, now);
  }
}

async function handleBlacklistOp(chatId, text, env, now) {
  const targetId = text.split("#")[1]?.trim();
  if (!targetId) return;

  let blacklist = [];
  if (memoryBlacklistCache && (now - memoryBlacklistTime < 15000)) {
    blacklist = memoryBlacklistCache;
  } else {
    try {
      const rawBlacklist = await env.TG_LIMIT_KV.get("BLACKLIST_USERS");
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
    updateBlacklistCache(blacklist);
    await sendMessage(env, chatId, `🚫 <b>拉黑成功！</b>\n\n用户 ID <code>${escapeHtml(targetId)}</code> 已入小黑屋，彻底丧失获取节点的权限。`);
  } else {
    blacklist = blacklist.filter(id => id !== targetId);
    await env.TG_LIMIT_KV.put("BLACKLIST_USERS", JSON.stringify(blacklist));
    updateBlacklistCache(blacklist);
    await sendMessage(env, chatId, `🔓 <b>解封成功！</b>\n\n用户 ID <code>${escapeHtml(targetId)}</code> 已被移出黑名单，恢复正常使用权限。`);
  }
}

async function handleRuleAddOp(chatId, text, env, ctx, now) {
  const match = text.match(/^添加#([^#]+)#([^#]+)#([\s\S]*)$/);
  if (!match) {
    await sendMessage(env, chatId, "❌ <b>格式错误</b>\n\n请严格使用全新格式添加：\n<code>添加#关键词或网址#频道显示的遮罩备注#节点或网站真实内容</code>");
    return;
  }
  
  // 👑 完美修正③：使用正则 \s+/g 强力压缩连续多重空格为单个标准空格，彻底铲除格式分裂 Bug
  const keywords = match[1].trim().replace(/\s+/g, " ");
  const customMemo = match[2].trim();
  const response = match[3].trim();

  if (!keywords || !customMemo || !response) return;

  let currentRules = [];
  if (memoryRulesCache && (now - memoryRulesTime < 15000)) {
    currentRules = memoryRulesCache;
  } else {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      currentRules = rawRules ? JSON.parse(rawRules) : [];
    } catch (e) {
      currentRules = [];
    }
  }

  currentRules = currentRules.filter(r => r && typeof r.keywords === "string" && r.keywords.trim().replace(/\s+/g, " ").toLowerCase() !== keywords.toLowerCase());
  currentRules.push({ keywords, response, customMemo });

  await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
  updateRulesCache(currentRules);

  await sendMessage(env, chatId, `✅ <b>入库分类成功！</b>\n\n• <b>触发指令</b>：<code>${escapeHtml(keywords)}</code>\n• <b>频道备注</b>：<code>${escapeHtml(customMemo)}</code>\n• <b>保存内容</b>：已成功自动归类存储，全网实时生效。`);

  ctx.waitUntil((async () => {
    try {
      const botUsername = await getBotUsername(env);
      const cleanKeywords = escapeHtml(keywords);
      const cleanMemo = escapeHtml(customMemo);
      
      const lowerKeyword = keywords.toLowerCase();
      const isUrl = lowerKeyword.startsWith("http://") || lowerKeyword.startsWith("https://");
      
      const safeUrl = encodeURI(keywords)
        .replace(/"/g, "%22")
        .replace(/'/g, "%27");
      
      const displayTag = isUrl 
        ? `<a href="${safeUrl}">${cleanMemo}</a>`
        : `<b>${cleanKeywords}</b>`;

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
  })().catch(err => console.error("Channel post context unhandled reject:", err)));
}

async function handleRuleDeleteOp(chatId, text, env, now) {
  const deleteParam = text.split("#")[1]?.trim();
  if (!deleteParam) return;

  let currentRules = [];
  if (memoryRulesCache && (now - memoryRulesTime < 15000)) {
    currentRules = memoryRulesCache;
  } else {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      currentRules = rawRules ? JSON.parse(rawRules) : [];
    } catch (e) {
      currentRules = [];
    }
  }

  const index = parseInt(deleteParam, 10) - 1;

  if (!isNaN(index) && index >= 0 && index < currentRules.length) {
    const removedRule = currentRules[index];
    currentRules.splice(index, 1);
    await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
    updateRulesCache(currentRules);

    await sendMessage(env, chatId, `🗑️ <b>精准选择性删除成功！</b>\n\n已彻底从数据库中移除规则：\n• <b>关键词</b>：<code>${escapeHtml(removedRule.keywords)}</code>\n• <b>备注</b>：<code>${escapeHtml(removedRule.customMemo)}</code>`);
  } else {
    const initialLength = currentRules.length;
    // 👑 完美修正③：删除动作同步引入连续空格清洗比对，防止残留数据引发死锁
    const cleanDeleteParam = deleteParam.replace(/\s+/g, " ");
    currentRules = currentRules.filter(r => r && typeof r.keywords === "string" && r.keywords.trim().replace(/\s+/g, " ").toLowerCase() !== cleanDeleteParam.toLowerCase());

    if (currentRules.length === initialLength) {
      await sendMessage(env, chatId, `⚠️ <b>未找到对应的规则</b>\n\n输入的数字编号超出范围，或未匹配到关键词：<code>${escapeHtml(deleteParam)}</code>`);
    } else {
      await env.TG_LIMIT_KV.put("DYNAMIC_NODE_RULES", JSON.stringify(currentRules));
      updateRulesCache(currentRules);
      await sendMessage(env, chatId, `🗑️ <b>删除成功！</b>\n\n已通过匹配关键词彻底移除规则。`);
    }
  }
}

async function handleManageConsole(chatId, env, now) {
  let currentRules = [];

  if (memoryRulesCache && (now - memoryRulesTime < CACHE_TTL.KV_REFRESH)) {
    currentRules = memoryRulesCache;
  } else if (env.TG_LIMIT_KV) {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      currentRules = rawRules ? JSON.parse(rawRules) : [];
      updateRulesCache(currentRules);
    } catch (e) {
      currentRules = [];
    }
  }

  let rulesListText = "";
  if (currentRules.length === 0) {
    rulesListText = "<i>(暂无动态规则，请使用下方模板添加)</i>\n\n";
  } else {
    currentRules.forEach((rule, i) => {
      if (rule && rule.keywords) {
        rulesListText += `<b>${i + 1}.</b> <code>${escapeHtml(rule.keywords)}</code>\n<blockquote>└ ${escapeHtml(rule.customMemo || "")}</blockquote>\n\n`;
      }
    });
  }

  const botUsername = await getBotUsername(env);
  const myBotUrl = `https://t.me/${botUsername}`;

  const manageText = 
    `🛠️ <b>管理控制台</b>\n\n` +
    `📊 <b>当前 KV 数据库规则明细：</b>\n\n` +
    `${rulesListText}` +
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

  await sendMessage(env, chatId, manageText, { disable_web_page_preview: true });
}

async function handleWelcomeCommands(chatId, env) {
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

  await sendMessage(env, chatId, welcomeText, {
    reply_markup: {
      inline_keyboard: [[{ text: "✍️ 节点不能用？联系老板", url: "https://t.me/AGsykin_bot" }]]
    }
  });
}

async function handleKeywordMatch(message, text, isAdmin, env, ctx, now) {
  const chatId = message.chat.id;

  if (env.TG_LIMIT_KV && (!memoryRulesCache || (now - memoryRulesTime >= CACHE_TTL.KV_REFRESH))) {
    try {
      const rawRules = await env.TG_LIMIT_KV.get("DYNAMIC_NODE_RULES");
      updateRulesCache(rawRules ? JSON.parse(rawRules) : []);
    } catch (e) {
      console.error("Async context refresh rules fail:", e);
    }
  }

  // KV为空时回退环境变量
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
    // 👑 完美修正：优雅替换为统一函数入口，维持全生命周期的状态一致
    updateRulesCacheWithCustomTime(backupRules, now);
  }

  // 👑 完美修正③：用户发词判定同步并入连续多重空格压缩，实现完美抗污
  const lookupKey = text.replace(/\s+/g, " ").toLowerCase();
  const matchedRule = memoryRulesMap.get(lookupKey);

  if (matchedRule) {
    const rawResponse = String(matchedRule.response ?? "");
    const formattedResponse = rawResponse.replace(/\\n/g, '\n');
    await sendMessage(env, chatId, formattedResponse);

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

          await sendMessage(env, env.ADMIN_ID, adminNotice);
        } catch (err) {
          console.error("Failed to push log to admin:", err);
        }
      })().catch(err => console.error("Admin push context unhandled reject:", err)));
    }
    return;
  }

  await sendMessage(env, chatId, "❓ <b>未找到匹配的节点内容。</b>\n\n请检查您的关键词是否正确，或者发送 /help 查看指南。");
}

async function checkChannelSubscription(chatId, env) {
  try {
    const member = await telegramApi(env.BOT_TOKEN, "getChatMember", {
      chat_id: env.CHANNEL_ID,
      user_id: chatId
    });
    return ["creator", "administrator", "member"].includes(member.status);
  } catch (err) {
    console.error("Check channel subscription fail:", err);
    return false;
  }
}

async function telegramApi(token, methodName, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${methodName}`;
  
  // 👑 完美修正⑥：在底层网络 fetch 外层并入 1 次自动重试，休眠 500ms 对冲电报 5xx 故障，全面增强工业级稳定性
  for (let i = 0; i < 2; i++) {
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
      if (i === 1) {
        if (apiErr.name === "AbortError") {
          throw new Error(`[Timeout Alert] Telegram API 请求超时，8秒内网关未给予业务层响应，已执行硬熔断自救。`);
        }
        throw apiErr;
      }
      console.warn(`[Network Retry] Telegram API ${methodName} failed on attempt ${i + 1}. Retrying in 500ms... Error: ${apiErr.message}`);
      await new Promise(r => setTimeout(r, 500));
    } finally {
      clearTimeout(timeout);
    }
  }
}
