async function dbConfigGet(key, env) {
  const row = await env.TG_BOT_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function dbConfigPut(key, value, env) {
  await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
}

// 【修复：解决并发插入导致 SQLITE_CONSTRAINT_PRIMARYKEY 主键冲突报错的 BUG】
async function dbUserGetOrCreate(userId, env) {
  let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
  if (!user) {
    try {
      await env.TG_BOT_DB.prepare(
        "INSERT OR IGNORE INTO users (user_id, user_state, is_blocked, is_muted, block_count) VALUES (?, 'new', 0, 0, 0)"
      ).bind(userId).run();
    } catch (e) {
      // 捕获并忽略极端并发下的主键冲突异常
    }
    user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
  }
  if (user) {
    user.is_blocked = user.is_blocked === 1;
    user.is_muted = user.is_muted === 1;
    user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
  }
  return user;
}

async function dbUserUpdate(userId, data, env) {
  if (data.user_info) {
    data.user_info_json = JSON.stringify(data.user_info);
    delete data.user_info;
  }
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  
  const fields = keys.map(key => `${key} = ?`).join(', ');
  const values = keys.map(key => {
    if ((key === 'is_blocked' || key === 'is_muted') && typeof data[key] === 'boolean') {
      return data[key] ? 1 : 0;
    }
    return data[key];
  });
  await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
}

async function dbTopicUserGet(topicId, env) {
  const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
  return row ? row.user_id : null;
}

async function dbMessageDataPut(userId, messageId, data, env) {
  await env.TG_BOT_DB.prepare(
    "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)"
  ).bind(userId, messageId, data.text, data.date).run();
}

async function dbMessageDataGet(userId, messageId, env) {
  const row = await env.TG_BOT_DB.prepare(
    "SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?"
  ).bind(userId, messageId).first();
  return row || null;
}

async function dbAdminStateDelete(userId, env) {
  await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run();
}

async function dbAdminStateGet(userId, env) {
  const stateJson = await dbConfigGet(`admin_state:${userId}`, env);
  return stateJson || null;
}

async function dbAdminStatePut(userId, stateJson, env) {
  await dbConfigPut(`admin_state:${userId}`, stateJson, env);
}

async function dbMigrate(env) {
  if (!env.TG_BOT_DB) {
    throw new Error("D1 database binding 'TG_BOT_DB' is missing.");
  }
  const configTableQuery = `
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `;
  const usersTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY NOT NULL,
            user_state TEXT NOT NULL DEFAULT 'new',
            is_blocked INTEGER NOT NULL DEFAULT 0,
            is_muted INTEGER NOT NULL DEFAULT 0,
            block_count INTEGER NOT NULL DEFAULT 0,
            topic_id TEXT,
            info_card_message_id TEXT, 
            user_info_json TEXT 
        );
    `;
  const messagesTableQuery = `
        CREATE TABLE IF NOT EXISTS messages (
            user_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            text TEXT,
            date INTEGER,
            PRIMARY KEY (user_id, message_id)
        );
    `;
  try {
    await env.TG_BOT_DB.batch([
      env.TG_BOT_DB.prepare(configTableQuery),
      env.TG_BOT_DB.prepare(usersTableQuery),
      env.TG_BOT_DB.prepare(messagesTableQuery),
    ]);
    const addColumns = [
      "ALTER TABLE users ADD COLUMN is_muted INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN info_card_message_id TEXT",
      "ALTER TABLE users ADD COLUMN block_log_message_id TEXT",
      "ALTER TABLE users ADD COLUMN profile_log_message_id TEXT",
      "ALTER TABLE users ADD COLUMN verification_code TEXT"
    ];
    for (const query of addColumns) {
      try {
        await env.TG_BOT_DB.prepare(query).run();
      } catch (e) {
        // 忽略列已存在的错误
      }
    }
  } catch (e) {
    throw new Error(`D1 Initialization Failed: ${e.message}`);
  }
}

// 【优化：规范化 HTML 转义，增加单双引号防注入破坏，杜绝潜在的 HTML 解析错误风险】
function escapeHtml(text) {
  if (!text) return '';
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateRandomCode(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '时间未知';
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function getUserInfo(user) {
  const userId = user.id.toString();
  const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
  const rawUsername = user.username ? `@${user.username}` : "无";
  const safeName = escapeHtml(rawName);
  const safeUsername = escapeHtml(rawUsername);
  const safeUserId = escapeHtml(userId);
  const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);
  const infoCard = `
<b>👤 用户资料卡</b>
• 用户名: <code>${safeUsername}</code>
• ID: <code>${safeUserId}</code>
    `.trim();
  return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}

function getInfoCardButtons(userId, isBlocked, isMuted) {
  const blockAction = isBlocked ? "unblock" : "block";
  const blockText = isBlocked ? "✅ 解除屏蔽" : "🚫 屏蔽此人";
  const muteAction = isMuted ? "unmute" : "mute";
  const muteText = isMuted ? "🔔 解除静音" : "🔕 静音通知";
  return {
    inline_keyboard: [
      [{
        text: blockText,
        callback_data: `${blockAction}:${userId}`
      }, {
        text: muteText,
        callback_data: `${muteAction}:${userId}`
      }],
      [{
        text: "👤 查看用户资料",
        url: `tg://user?id=${userId}`
      }],
      [{
        text: "📌 置顶此消息",
        callback_data: `pin_card:${userId}`
      }]
    ]
  };
}

async function ensureLogTopicExists(env) {
  const logTopicKey = 'user_profile_log_topic_id';
  let logTopicId = await dbConfigGet(logTopicKey, env);
  if (!logTopicId) {
    try {
      const topic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
        chat_id: env.ADMIN_GROUP_ID,
        name: "📋 用户资料卡汇总 (User Logs)",
        icon_custom_emoji_id: null
      });
      logTopicId = topic.message_thread_id.toString();
      await dbConfigPut(logTopicKey, logTopicId, env);
    } catch (e) {
      return null;
    }
  }
  return logTopicId;
}

async function ensureBlockLogTopicExists(env) {
  const logTopicKey = 'user_block_log_topic_id';
  let logTopicId = await dbConfigGet(logTopicKey, env);
  if (!logTopicId) {
    try {
      const topic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
        chat_id: env.ADMIN_GROUP_ID,
        name: "🚫 屏蔽与静音名单 (Block/Mute Log)",
        icon_custom_emoji_id: null
      });
      logTopicId = topic.message_thread_id.toString();
      await dbConfigPut(logTopicKey, logTopicId, env);
    } catch (e) {
      return null;
    }
  }
  return logTopicId;
}

async function getConfig(key, env, defaultValue) {
  const configValue = await dbConfigGet(key, env);
  if (configValue !== null) {
    return configValue;
  }
  const envKey = key.toUpperCase()
    .replace('WELCOME_MSG', 'WELCOME_MESSAGE')
    .replace('VERIF_Q', 'VERIFICATION_QUESTION')
    .replace('VERIF_A', 'VERIFICATION_ANSWER')
    .replace(/_FORWARDING/g, '_FORWARDING');
  const envValue = env[envKey];
  if (envValue !== undefined && envValue !== null) {
    return envValue;
  }
  return defaultValue;
}

function isPrimaryAdmin(userId, env) {
  if (!env.ADMIN_IDS) return false;
  const adminIds = env.ADMIN_IDS.split(',').map(id => id.trim());
  return adminIds.includes(userId.toString());
}

async function getAuthorizedAdmins(env) {
  const jsonString = await getConfig('authorized_admins', env, '[]');
  try {
    const adminList = JSON.parse(jsonString);
    return Array.isArray(adminList) ?
      adminList.map(id => id.toString().trim()).filter(id => id !== "") : [];
  } catch (e) {
    return [];
  }
}

async function isAdminUser(userId, env) {
  if (isPrimaryAdmin(userId, env)) {
    return true;
  }
  const authorizedAdmins = await getAuthorizedAdmins(env);
  return authorizedAdmins.includes(userId.toString());
}

async function getAutoReplyRules(env) {
  const jsonString = await getConfig('keyword_responses', env, '[]');
  try {
    const rules = JSON.parse(jsonString);
    return Array.isArray(rules) ? rules : [];
  } catch (e) {
    return [];
  }
}

async function getBlockKeywords(env) {
  const jsonString = await getConfig('block_keywords', env, '[]');
  try {
    const keywords = JSON.parse(jsonString);
    return Array.isArray(keywords) ? keywords : [];
  } catch (e) {
    return [];
  }
}

async function telegramApi(token, methodName, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${methodName}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`Telegram API ${methodName} returned non-JSON response`);
  }
  if (!data.ok) {
    throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
  }
  return data.result;
}

async function syncRemoteSpamRules(env) {
  const targetUrl = env.SPAM_URL || "https://raw.githubusercontent.com/sykin7/my-telegram-spam-rules/main/spam.txt";
  try {
    const res = await fetch(targetUrl, { 
      headers: { 'User-Agent': 'Cloudflare-Worker-Telegram-Bot' },
      cf: { cacheTtl: 0 } 
    });
    if (!res.ok) throw new Error(`HTTP 错误状态码: ${res.status}`);
    
    const textData = await res.text();
    const remoteKeywords = textData
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('//'));
      
    if (remoteKeywords.length === 0) {
      return { success: false, msg: "远程文件内容为空或无有效广告词" };
    }
    
    const localKeywords = await getBlockKeywords(env);
    const mergedKeywords = [...new Set([...localKeywords, ...remoteKeywords])];
    
    await dbConfigPut('block_keywords', JSON.stringify(mergedKeywords), env);
    return { success: true, count: remoteKeywords.length, total: mergedKeywords.length };
  } catch (e) {
    return { success: false, msg: e.message };
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      await dbMigrate(env);
    } catch (e) {
      return new Response(`D1 Database Initialization Error: ${e.message}`, { status: 500 });
    }
    if (request.method === "POST") {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, env));
      } catch (e) {
        // 捕获异常结构
      }
    }
    return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  if (update.message) {
    if (update.message.chat.type === "private") {
      await handlePrivateMessage(update.message, env);
    }
    else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID.toString()) {
      await handleAdminReply(update.message, env);
    }
  } else if (update.edited_message) {
    if (update.edited_message.chat.type === "private") {
      await handleRelayEditedMessage(update.edited_message, env);
    }
    else if (update.edited_message.chat.id.toString() === env.ADMIN_GROUP_ID.toString()) {
      await handleAdminEditedReply(update.edited_message, env);
    }
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
  }
}

async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id.toString();
  const text = message.text || "";
  const userId = chatId;
  const isPrimary = isPrimaryAdmin(userId, env);
  const isAdmin = await isAdminUser(userId, env);
  
  if (text === "/start" || text === "/help") {
    if (isPrimary) {
      await handleAdminConfigStart(chatId, env);
    } else {
      await handleStart(chatId, env);
    }
    return;
  }
  
  const user = await dbUserGetOrCreate(userId, env);
  const isBlocked = user.is_blocked;
  if (isBlocked) {
    return;
  }
  if (isPrimary) {
    const adminStateJson = await dbAdminStateGet(userId, env);
    if (adminStateJson) {
      await handleAdminConfigInput(userId, text, adminStateJson, env);
      return;
    }
    if (user.user_state !== "verified") {
      user.user_state = "verified";
      await dbUserUpdate(userId, { user_state: "verified" }, env);
    }
  }
  if (isAdmin && user.user_state !== "verified") {
    user.user_state = "verified";
    await dbUserUpdate(userId, { user_state: "verified" }, env);
  }
  
  const userState = user.user_state;
  if (userState === "pending_verification" ||
    (userState === "new" && text && !text.startsWith('/'))) {
    await handleVerification(chatId, text, env);
  } else if (userState === "verified") {
    const blockKeywords = await getBlockKeywords(env);
    const blockThreshold = parseInt(await getConfig('block_threshold', env, "5"), 10) || 5;
    
    const triggerText = [
      message.text,
      message.caption,
      message.forward_signature,
      message.forward_from_chat?.title,
      message.forward_from_chat?.username
    ].filter(Boolean).join(" ");

    // 【优化：用高效率的字符串包含匹配代替耗费 CPU 的正则，防止大量词库导致 Worker 超时】
    if (blockKeywords.length > 0 && triggerText) {
      const lowerTriggerText = triggerText.toLowerCase();
      let currentCount = user.block_count;
      for (const keyword of blockKeywords) {
        if (keyword && lowerTriggerText.includes(keyword.toLowerCase())) {
          currentCount += 1;
          await dbUserUpdate(userId, { block_count: currentCount }, env);
          const blockNotification = `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold}次)，此消息已被丢弃，不会转发给对方。`;
          if (currentCount >= blockThreshold) {
            await dbUserUpdate(userId, { is_blocked: true }, env);
            const autoBlockMessage = `❌ 您已多次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`;
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoBlockMessage });
            return;
          }
          await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: blockNotification,
          });
          return;
        }
      }
    }
    
    const filters = {
      media: (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true',
      link: (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true',
      text: (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true',
      audio_voice: (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true',
      sticker_gif: (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true',
      user_forward: (await getConfig('enable_user_forwarding', env, 'true')).toLowerCase() === 'true',
      group_forward: (await getConfig('enable_group_forwarding', env, 'true')).toLowerCase() === 'true',
      channel_forward: (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true',
    };
    
    let isForwardable = true;
    let filterReason = '';
    const hasLinks = (msg) => {
      const entities = msg.entities || msg.caption_entities || [];
      return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
    };
    
    if (message.forward_from) {
      if (!filters.user_forward) {
        isForwardable = false;
        filterReason = '用户转发消息';
      }
    } else if (message.forward_from_chat) {
      const type = message.forward_from_chat.type;
      if (type === 'channel') {
        if (!filters.channel_forward) {
          isForwardable = false;
          filterReason = '频道转发消息';
        }
      } else if (type === 'group' || type === 'supergroup') {
        if (!filters.group_forward) {
          isForwardable = false;
          filterReason = '群组转发消息';
        }
      }
    }
    else if (message.audio || message.voice) {
      if (!filters.audio_voice) {
        isForwardable = false;
        filterReason = '音频或语音消息';
      }
    }
    else if (message.sticker || message.animation) {
      if (!filters.sticker_gif) {
        isForwardable = false;
        filterReason = '贴纸或GIF';
      }
    }
    else if (message.photo || message.video || message.document) {
      if (!filters.media) {
        isForwardable = false;
        filterReason = '媒体内容（图片/视频/文件）';
      }
    }
    
    if (isForwardable && hasLinks(message)) {
      if (!filters.link) {
        isForwardable = false;
        filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
      }
    }
    
    const isPureText = message.text &&
      !message.photo && !message.video && !message.document &&
      !message.sticker && !message.audio && !message.voice &&
      !message.forward_from_chat && !message.forward_from && !message.animation;
      
    if (isForwardable && isPureText) {
      if (!filters.text) {
        isForwardable = false;
        filterReason = '纯文本内容';
      }
    }
    
    // 【修复：兜底机制，防止非白名单类型的消息（如联系人、地图位置、骰子等）绕过限制】
    if (isForwardable) {
      const allowedTypes = [
        'text', 'photo', 'video', 'document', 'sticker', 'audio', 'voice', 
        'animation', 'forward_from', 'forward_from_chat'
      ];
      const hasUnrecognizedType = Object.keys(message).some(key => 
        ['contact', 'location', 'venue', 'dice', 'game', 'poll'].includes(key)
      );
      if (hasUnrecognizedType) {
        isForwardable = false;
        filterReason = '未允许的特殊消息类型（如联系人/位置/投票等）';
      }
    }

    if (!isForwardable) {
      const filterNotification = `此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: filterNotification,
      });
      return;
    }
    
    const autoResponseRules = await getAutoReplyRules(env);
    if (autoResponseRules.length > 0 && text) {
      for (const rule of autoResponseRules) {
        try {
          const regex = new RegExp(rule.keywords, 'gi');
          if (regex.test(text)) {
            const autoReplyPrefix = "此消息为自动回复\n\n";
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: autoReplyPrefix + rule.response,
            });
            return;
          }
        } catch (e) {
          // 忽略异常自动回复规则
        }
      }
    }
    await handleRelayToTopic(message, user, env);
  } else {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "请使用 /start 命令开始。",
    });
  }
}

async function handleStart(chatId, env) {
  const verifyMode = await getConfig('verification_mode', env, 'button');
  const defaultWelcome = "为了防止垃圾广告骚扰，首次使用需要完成身份验证。";
  const welcomeMessage = await getConfig('welcome_msg', env, defaultWelcome);
  const user = await dbUserGetOrCreate(chatId, env);
  
  // 【修复：增加状态保护逻辑。如果是已验证的正常用户手误发了 /start，直接放行，拒绝重新要验证码的行为】
  if (user && user.user_state === 'verified') {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "🎉 您已经是通过验证的用户啦，可以直接发送消息与客服对话！",
    });
    return;
  }

  const userInfo = getUserInfo({
    id: chatId,
    first_name: user.user_info?.name || '用户',
    username: user.user_info?.username
  });
  if (verifyMode === 'button') {
    const text = `
🔐 <b>身份验证</b>

欢迎 ${userInfo.username !== '无' ? userInfo.username : userInfo.name}!

${escapeHtml(welcomeMessage)}

👇 <b>请点击下方按钮完成验证：</b>
        `.trim();
    const keyboard = {
      inline_keyboard: [[
        { text: "✅ 点击这里验证身份", callback_data: "action:verify_user" }
      ]]
    };
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } else {
    const code = generateRandomCode(4);
    await dbUserUpdate(chatId, {
      user_state: "pending_verification",
      verification_code: code
    }, env);
    const text = `
🔐 <b>身份验证</b>

欢迎 ${userInfo.username !== '无' ? userInfo.username : userInfo.name}!
${escapeHtml(welcomeMessage)}

🤖 <b>请在对话框中发送以下验证码：</b>
<code>${code}</code>
        `.trim();
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    });
  }
  await dbUserUpdate(chatId, { user_state: "pending_verification" }, env);
}

async function handleVerification(chatId, answer, env) {
  const user = await dbUserGetOrCreate(chatId, env);
  const verifyMode = await getConfig('verification_mode', env, 'button');
  if (verifyMode === 'button') {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "👇 请点击上方的按钮进行验证，无需发送文本。",
    });
    return;
  }
  const expectedCode = user.verification_code;
  if (!expectedCode) {
    await handleStart(chatId, env);
    return;
  }
  if (answer.trim().toUpperCase() === expectedCode.toUpperCase()) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "🎉 验证通过！可以开始聊天咯！",
    });
    await dbUserUpdate(chatId, { user_state: "verified", verification_code: null }, env);
  } else {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ 验证码错误，请检查后重新发送，或输入 /start 获取新验证码。",
    });
  }
}

async function handleAdminEditedReply(editedMessage, env) {
  if (!editedMessage.is_topic_message || !editedMessage.message_thread_id) return;
  const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
  if (editedMessage.chat.id.toString() !== adminGroupIdStr) return;
  if (editedMessage.from && editedMessage.from.is_bot) return;
  const senderId = editedMessage.from.id.toString();
  const isAuthorizedAdmin = await isAdminUser(senderId, env);
  if (!isAuthorizedAdmin) {
    return;
  }
  const topicId = editedMessage.message_thread_id.toString();
  const userId = await dbTopicUserGet(topicId, env);
  if (!userId) return;
  const messageId = editedMessage.message_id.toString();
  const storedMessage = await dbMessageDataGet(userId, messageId, env);
  if (!storedMessage) return;
  const newText = editedMessage.text || editedMessage.caption || "[媒体内容]";
  const originalTime = formatTimestamp(storedMessage.date);
  const editTime = formatTimestamp(editedMessage.edit_date || editedMessage.date);
  const notificationText = `
⚠️ <b>管理员编辑了回复</b>
---
<b>原发送/上次编辑时间:</b> <code>${originalTime}</code>
<b>本次编辑时间:</b> <code>${editTime}</code>
<b>原消息内容：</b>
${escapeHtml(storedMessage.text)}
<b>新消息内容：</b>
${escapeHtml(newText)}
    `.trim();
  try {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: notificationText,
      parse_mode: "HTML",
    });
    await dbMessageDataPut(userId, messageId, { text: newText, date: editedMessage.edit_date || editedMessage.date }, env);
  } catch (e) {
    // 捕获编辑推送异常
  }
}

async function handleAdminConfigStart(chatId, env, messageId = 0) {
  const isPrimary = isPrimaryAdmin(chatId, env);
  if (!isPrimary) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "您是授权协管员，已绕过验证。此菜单仅供主管理员使用。", });
    return;
  }
  const menuText = `
⚙️ <b>机器人主配置菜单</b>

请选择要管理的配置类别：
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "📝 基础配置 (验证模式)", callback_data: "config:menu:base" }],
      [{ text: "🤖 自动回复管理", callback_data: "config:menu:autoreply" }],
      [{ text: "🚫 关键词屏蔽管理", callback_data: "config:menu:keyword" }],
      [{ text: "🔗 按类型过滤管理", callback_data: "config:menu:filter" }],
      [{ text: "🧑‍💻 协管员授权设置", callback_data: "config:menu:authorized" }],
      [{ text: "💾 备份群组设置", callback_data: "config:menu:backup" }],
      [{ text: "🔄 刷新主菜单", callback_data: "config:menu" }],
    ]
  };
  await dbAdminStateDelete(chatId, env);
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params).catch(async (e) => {
    if (apiMethod === "editMessageText") {
      delete params.message_id;
      await telegramApi(env.BOT_TOKEN, "sendMessage", params).catch(() => {});
    }
  });
}

async function handleAdminBaseConfigMenu(chatId, messageId, env) {
  const welcomeMsg = await getConfig('welcome_msg', env, "为了防止...");
  const currentMode = await getConfig('verification_mode', env, 'button');
  const modeText = currentMode === 'button' ? "🖱️ 点击按钮验证" : "🔠 4位验证码验证";
  const menuText = `
⚙️ <b>基础配置 (验证设置)</b>

<b>当前验证模式:</b> ${modeText}

<b>当前欢迎/提示语:</b>
${escapeHtml(welcomeMsg).substring(0, 50)}...

请选择要修改的配置项:
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "🔄 切换验证模式", callback_data: "config:toggle_mode:verification" }],
      [{ text: "📝 编辑欢迎/提示语", callback_data: "config:edit:welcome_msg" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminAuthorizedConfigMenu(chatId, messageId, env) {
  const primaryAdmins = env.ADMIN_IDS ? env.ADMIN_IDS.split(',').map(id => id.trim()).filter(id => id !== "") : [];
  const authorizedAdmins = await getAuthorizedAdmins(env);
  const allAdmins = [...new Set([...primaryAdmins, ...authorizedAdmins])];
  const authorizedCount = authorizedAdmins.length;
  const menuText = `
🧑‍💻 <b>协管员授权设置</b>

<b>主管理员 (来自 ENV):</b> <code>${primaryAdmins.join(', ')}</code>
<b>已授权协管员 (来自 D1):</b> <code>${authorizedAdmins.join(', ') || '无'}</code>
<b>总管理员/协管员数量:</b> ${allAdmins.length} 人

<b>注意：</b>
1. 协管员 ID 或用户名必须与群组话题中的回复者一致。
2. 协管员的私聊会自动绕过验证。
3. 输入格式：ID 或用户名，多个用逗号分隔。

请选择要修改的配置项:
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "✏️ 设置/修改协管员列表", callback_data: "config:edit:authorized_admins" }],
      [{ text: `🗑️ 清空协管员列表 (${authorizedCount}人)`, callback_data: "config:edit:authorized_admins_clear" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminAutoReplyMenu(chatId, messageId, env) {
  const rules = await getAutoReplyRules(env);
  const ruleCount = rules.length;
  const menuText = `
🤖 <b>自动回复管理</b>

当前规则总数：<b>${ruleCount}</b> 条。

请选择操作：
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "➕ 新增自动回复规则", callback_data: "config:add:keyword_responses" }],
      [{ text: `🗑️ 管理/删除现有规则 (${ruleCount}条)`, callback_data: "config:list:keyword_responses" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminKeywordBlockMenu(chatId, messageId, env) {
  const blockKeywords = await getBlockKeywords(env);
  const keywordCount = blockKeywords.length;
  const blockThreshold = await getConfig('block_threshold', env, "5");
  const menuText = `
🚫 <b>关键词屏蔽管理</b>

当前屏蔽关键词总数：<b>${keywordCount}</b> 个。
屏蔽次数阈值：<code>${escapeHtml(blockThreshold)}</code> 次。

请选择操作：
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "➕ 新增屏蔽关键词", callback_data: "config:add:block_keywords" }],
      [{ text: `🗑️ 管理/删除现有关键词 (${keywordCount}个)`, callback_data: "config:list:block_keywords" }],
      [{ text: "🔄 同步远程 Spam 词库", callback_data: "config:sync:remote_spam" }],
      [{ text: `✏️ 修改屏蔽次数阈值 (${blockThreshold}次)`, callback_data: "config:edit:block_threshold" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminBackupConfigMenu(chatId, messageId, env) {
  const backupGroupId = await getConfig('backup_group_id', env, "");
  const statusText = backupGroupId ? `✅ 已设置: <code>${escapeHtml(backupGroupId)}</code>` : "❌ 未设置";
  const menuText = `
💾 <b>消息备份群组设置</b>

<b>当前群组 ID:</b> ${statusText}

<b>注意：</b>
1. 群组必须是超级群组，且 Bot 必须是管理员。
2. 设置后，所有用户消息的副本都会转发到此群组。

请选择操作：
    `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: "✏️ 设置/修改备份群组 ID", callback_data: "config:edit:backup_group_id" }],
      [{ text: "🗑️ 清除备份群组 ID", callback_data: "config:edit:backup_group_id_clear" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminRuleList(chatId, messageId, env, key) {
  let rules = [];
  let menuText = "";
  let backCallback = "";
  if (key === 'keyword_responses') {
    rules = await getAutoReplyRules(env);
    menuText = `
🤖 <b>自动回复规则列表 (${rules.length}条)</b>
请点击右侧按钮删除对应规则。
因为数据库限制，点击删除后界面不会刷新实际已经执行
请点击返回上一级菜单后重新进入就可以看到了
规则格式：<code>关键词表达式</code> ➡️ <code>回复内容</code>
---
    `.trim();
    backCallback = "config:menu:autoreply";
  } else if (key === 'block_keywords') {
    rules = await getBlockKeywords(env);
    menuText = `
🚫 <b>屏蔽关键词列表 (${rules.length}个)</b>
请点击右侧按钮删除对应关键词。
因为数据库限制，点击删除后界面不会刷新实际已经执行
请点击返回上一级菜单后重新进入就可以看到了
关键词格式：<code>关键词表达式</code>
---
    `.trim();
    backCallback = "config:menu:keyword";
  } else {
    return;
  }
  const ruleButtons = [];
  if (rules.length === 0) {
    menuText += "\n\n<i>（列表为空）</i>";
  } else {
    rules.forEach((rule, index) => {
      let label = "";
      let deleteId = "";
      if (key === 'keyword_responses') {
        const keywordsSnippet = rule.keywords.substring(0, 15);
        const responseSnippet = rule.response.substring(0, 20);
        label = `${index + 1}. <code>${escapeHtml(keywordsSnippet)}...</code> ➡️ ${escapeHtml(responseSnippet)}...`;
        deleteId = rule.id;
      } else if (key === 'block_keywords') {
        const keywordSnippet = rule.substring(0, 25);
        label = `${index + 1}. <code>${escapeHtml(keywordSnippet)}...</code>`;
        deleteId = rule;
      }
      menuText += `\n${label}`;
      ruleButtons.push([
        {
          text: `🗑️ 删除 ${index + 1}`,
          callback_data: `config:delete:${key}:${deleteId}`
        }
      ]);
    });
  }
  const finalKeyboard = {
    inline_keyboard: [
      ...ruleButtons,
      [{ text: "⬅️ 返回", callback_data: backCallback }]
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: finalKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminRuleDelete(chatId, messageId, env, key, deleteValue, callbackQueryId) {
  let rules = [];
  let typeName = "";
  if (key === 'keyword_responses') {
    rules = await getAutoReplyRules(env);
    typeName = "自动回复规则";
    const newRules = rules.filter(rule => rule.id.toString() !== deleteValue.toString());
    await dbConfigPut(key, JSON.stringify(newRules), env);
  } else if (key === 'block_keywords') {
    rules = await getBlockKeywords(env);
    typeName = "屏蔽关键词";
    const newRules = rules.filter(keyword => keyword !== deleteValue);
    await dbConfigPut(key, JSON.stringify(newRules), env);
  } else {
    return;
  }
  if (callbackQueryId) {
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: `✅ ${typeName}已删除并更新。`,
      show_alert: false
    }).catch(() => {});
  }
  await handleAdminRuleList(chatId, messageId, env, key);
}

async function handleAdminTypeBlockMenu(chatId, messageId, env) {
  const mediaStatus = (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true';
  const linkStatus = (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true';
  const textStatus = (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true';
  const audioVoiceStatus = (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true';
  const stickerGifStatus = (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true';
  const userForwardStatus = (await getConfig('enable_user_forwarding', env, 'true')).toLowerCase() === 'true';
  const groupForwardStatus = (await getConfig('enable_group_forwarding', env, 'true')).toLowerCase() === 'true';
  const channelForwardStatus = (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true';
  const s = (status) => status ? "✅ <b>允许</b>" : "❌ <b>屏蔽</b>";
  const cb = (key, status) => `config:toggle:${key}:${status ? 'false' : 'true'}`;
  const btnText = (status) => status ? "✅ 允许" : "❌ 屏蔽";
  const menuText = `
🔗 <b>按类型过滤管理</b>
点击下方按钮切换状态。

<b>--- 转发来源控制 ---</b>
1. ${s(userForwardStatus)} | 转发消息 (用户)
2. ${s(groupForwardStatus)} | 转发消息 (群组)
3. ${s(channelForwardStatus)} | 转发消息 (频道)

<b>--- 媒体类型控制 ---</b>
4. ${s(audioVoiceStatus)} | 音频/语音消息
5. ${s(stickerGifStatus)} | 贴纸/GIF (动画)
6. ${s(mediaStatus)} | 图片/视频/文件

<b>--- 基础内容控制 ---</b>
7. ${s(linkStatus)} | 链接消息
8. ${s(textStatus)} | 纯文本消息
      `.trim();
  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: `1. ${btnText(userForwardStatus)}`, callback_data: cb('enable_user_forwarding', userForwardStatus) },
        { text: `2. ${btnText(groupForwardStatus)}`, callback_data: cb('enable_group_forwarding', groupForwardStatus) }
      ],
      [
        { text: `3. ${btnText(channelForwardStatus)}`, callback_data: cb('enable_channel_forwarding', channelForwardStatus) },
        { text: `4. ${btnText(audioVoiceStatus)}`, callback_data: cb('enable_audio_forwarding', audioVoiceStatus) }
      ],
      [
        { text: `5. ${btnText(stickerGifStatus)}`, callback_data: cb('enable_sticker_forwarding', stickerGifStatus) },
        { text: `6. ${btnText(mediaStatus)}`, callback_data: cb('enable_image_forwarding', mediaStatus) }
      ],
      [
        { text: `7. ${btnText(linkStatus)}`, callback_data: cb('enable_link_forwarding', linkStatus) },
        { text: `8. ${btnText(textStatus)}`, callback_data: cb('enable_text_forwarding', textStatus) }
      ],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
    ]
  };
  const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
  const params = {
    chat_id: chatId,
    text: menuText,
    parse_mode: "HTML",
    reply_markup: menuKeyboard,
  };
  if (apiMethod === "editMessageText") {
    params.message_id = messageId;
  }
  await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

async function handleAdminConfigInput(userId, text, adminStateJson, env) {
  let adminState;
  try {
    adminState = JSON.parse(adminStateJson);
  } catch (e) {
    await dbAdminStateDelete(userId, env);
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "⚠️ 状态错误，已重置。请重新使用 /start 访问菜单。", });
    return;
  }
  if (adminState.action === 'awaiting_input') {
    let successMsg = "";
    let finalValue = text;
    if (text.toLowerCase() === '/cancel') {
      await dbAdminStateDelete(userId, env);
      let cancelBack = "config:menu";
      if (adminState.key === 'block_keywords_add') {
        cancelBack = "config:menu:keyword";
      }
      else if (adminState.key === 'keyword_responses_add') {
        cancelBack = "config:menu:autoreply";
      }
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "❌ 已取消输入。", });
      if (cancelBack === 'config:menu:keyword') {
        await handleAdminKeywordBlockMenu(userId, 0, env);
      }
      else if (cancelBack === 'config:menu:autoreply') {
        await handleAdminAutoReplyMenu(userId, 0, env);
      }
      else {
        await handleAdminConfigStart(userId, env);
      }
      return;
    }
    if (adminState.key === 'verif_a' || adminState.key === 'block_threshold') {
      finalValue = text.trim();
    } else if (adminState.key === 'backup_group_id') {
      finalValue = text.trim();
    } else if (adminState.key === 'authorized_admins') {
      const adminList = text.split(',').map(id => id.trim()).filter(id => id !== "") ;
      finalValue = JSON.stringify(adminList);
    }
    if (adminState.key === 'block_keywords_add') {
      const blockKeywords = await getBlockKeywords(env);
      const newKeyword = finalValue.trim();
      if (newKeyword && !blockKeywords.includes(newKeyword)) {
        blockKeywords.push(newKeyword);
        await dbConfigPut('block_keywords', JSON.stringify(blockKeywords), env);
        successMsg = `✅ 屏蔽关键词 <code>${escapeHtml(newKeyword)}</code> 已添加。`;
      } else {
        successMsg = `⚠️ 屏蔽关键词未添加，内容为空或已存在。`;
      }
      await dbAdminStateDelete(userId, env);
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
      await handleAdminKeywordBlockMenu(userId, 0, env);
      return;
    } else if (adminState.key === 'keyword_responses_add') {
      const rules = await getAutoReplyRules(env);
      const separatorIndex = finalValue.indexOf('===');
      if (separatorIndex > -1) {
        const keywords = finalValue.substring(0, separatorIndex).trim();
        const response = finalValue.substring(separatorIndex + 3).trim();
        if (keywords && response) {
          const newRule = {
            keywords: keywords,
            response: response,
            id: Date.now(),
          };
          rules.push(newRule);
          await dbConfigPut('keyword_responses', JSON.stringify(rules), env);
          successMsg = `✅ 自动回复规则已添加。关键词: <code>${escapeHtml(newRule.keywords)}</code>`;
        } else {
          successMsg = `⚠️ 自动回复规则未添加，内容不能为空。`;
        }
      } else {
        successMsg = `⚠️ 自动回复规则未添加。请确保格式正确：<code>关键词表达式===回复内容</code>`;
      }
      await dbAdminStateDelete(userId, env);
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
      await handleAdminAutoReplyMenu(userId, 0, env);
      return;
    }
    if (finalValue.length === 0 && adminState.key !== 'backup_group_id') {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "⚠️ 输入内容不能为空，请重新发送。", });
      return;
    }
    await dbConfigPut(adminState.key, finalValue, env);
    await dbAdminStateDelete(userId, env);
    successMsg = `✅ 配置项 <code>${adminState.key}</code> 已更新。新值：<code>${escapeHtml(finalValue).substring(0, 50)}...</code>`;
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
    let nextMenuAction = '';
    if (adminState.key === 'welcome_msg' || adminState.key === 'verif_q' || adminState.key === 'verif_a') {
      nextMenuAction = 'config:menu:base';
    } else if (adminState.key === 'block_threshold') {
      nextMenuAction = 'config:menu:keyword';
    } else if (adminState.key === 'backup_group_id') {
      nextMenuAction = 'config:menu:backup';
    } else if (adminState.key === 'authorized_admins') {
      nextMenuAction = 'config:menu:authorized';
    }
    if (nextMenuAction === 'config:menu:base') {
      await handleAdminBaseConfigMenu(userId, 0, env);
    } else if (nextMenuAction === 'config:menu:autoreply') {
      await handleAdminAutoReplyMenu(userId, 0, env);
    } else if (nextMenuAction === 'config:menu:keyword') {
      await handleAdminKeywordBlockMenu(userId, 0, env);
    } else if (nextMenuAction === 'config:menu:backup') {
      await handleAdminBackupConfigMenu(userId, 0, env);
    } else if (nextMenuAction === 'config:menu:authorized') {
      await handleAdminAuthorizedConfigMenu(userId, 0, env);
    } else {
      await handleAdminConfigStart(userId, env);
    }
  } else {
    await dbAdminStateDelete(userId, env);
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "⚠️ 状态错误，已重置。请重新使用 /start 访问菜单。", });
  }
}

async function handleRelayToTopic(message, user, env) {
  const { from: userDetails, date } = message;
  const { userId, topicName, infoCard } = getUserInfo(userDetails);
  let topicId = user.topic_id;
  const isBlocked = user.is_blocked;
  const isMuted = user.is_muted || false;
  
  const createTopicForUser = async () => {
    try {
      const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
        chat_id: env.ADMIN_GROUP_ID,
        name: topicName,
      });
      const newTopicId = newTopic.message_thread_id.toString();
      const { name, username } = getUserInfo(userDetails);
      const newInfo = { name, username, first_message_date: date };
      const cardMarkup = getInfoCardButtons(userId, isBlocked, isMuted);
      const sentMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id: newTopicId,
        text: infoCard,
        parse_mode: "HTML",
        reply_markup: cardMarkup,
      });
      await dbUserUpdate(userId, {
        topic_id: newTopicId,
        user_info_json: JSON.stringify(newInfo),
        block_count: 0,
        info_card_message_id: sentMsg.message_id.toString()
      }, env);
      try {
        let logTopicId = await ensureLogTopicExists(env);
        if (logTopicId) {
          const cleanGroupId = env.ADMIN_GROUP_ID.toString().replace(/^-100/, '');
          const jumpUrl = `https://t.me/c/${cleanGroupId}/${newTopicId}`;
          const logMarkup = JSON.parse(JSON.stringify(cardMarkup));
          logMarkup.inline_keyboard.push([{ text: "💬 跳转到会话窗口", url: jumpUrl }]);
          const logText = `<b>#新用户连接</b>\n话题ID: <code>${newTopicId}</code>\n\n${infoCard}`;
          const sendParams = { chat_id: env.ADMIN_GROUP_ID, message_thread_id: logTopicId, text: logText, parse_mode: "HTML", reply_markup: logMarkup };
          try {
            const logMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", sendParams);
            await dbUserUpdate(userId, { profile_log_message_id: logMsg.message_id.toString() }, env);
          } catch (sendErr) {
            const errStr = sendErr.message || sendErr.toString();
            if (errStr.includes("thread not found") || errStr.includes("TOPIC_DELETED")) {
              await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind('user_profile_log_topic_id').run();
              logTopicId = await ensureLogTopicExists(env);
              if (logTopicId) {
                sendParams.message_thread_id = logTopicId;
                const retryMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", sendParams);
                await dbUserUpdate(userId, { profile_log_message_id: retryMsg.message_id.toString() }, env);
              }
            }
          }
        }
      } catch (logErr) {
        // 捕获汇总话题异常
      }
      return newTopicId;
    } catch (e) {
      throw e;
    }
  };
  
  const tryCopyToTopic = async (targetTopicId) => {
    const copyResult = await telegramApi(env.BOT_TOKEN, "copyMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: targetTopicId,
      from_chat_id: userId,
      message_id: message.message_id,
      disable_notification: isBlocked || isMuted,
    });
    return copyResult.message_id.toString();
  };
  
  if (!topicId) {
    try {
      topicId = await createTopicForUser();
    } catch (e) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "抱歉，无法创建客服话题（请稍后再试）。", });
      return;
    }
  }
  try {
    await tryCopyToTopic(topicId);
    if (message.text || message.caption) {
      const messageData = {
        text: message.text || message.caption || '', date: message.date
      };
      await dbMessageDataPut(userId, message.message_id.toString(), messageData, env);
    }
  } catch (e) {
    try {
      await dbUserUpdate(userId, { topic_id: null }, env);
      const newTopicId = await createTopicForUser();
      try {
        await tryCopyToTopic(newTopicId);
        if (message.text || message.caption) {
          const messageData = {
            text: message.text || message.caption || '', date: message.date
          };
          await dbMessageDataPut(userId, message.message_id.toString(), messageData, env);
        }
      } catch (e2) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "抱歉，消息转发失败（请稍后再试或联系管理员）。", });
        return;
      }
    } catch (createErr) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "抱歉，无法创建新的客服话题（请稍后再试）。", });
      return;
    }
  }
  const backupGroupId = await getConfig('backup_group_id', env, "");
  if (backupGroupId) {
    const userInfo = getUserInfo(message.from);
    const fromUserHeader = ` 
<b>--- 备份消息 ---</b>
👤 <b>来自用户:</b> <a href="tg://user?id=${userInfo.userId}">${userInfo.name || '无昵称'}</a> • ID: <code>${userInfo.userId}</code> • 用户名: ${userInfo.username} 
------------------
    `.trim() + '\n\n';
    const backupParams = { chat_id: backupGroupId, disable_notification: true, parse_mode: "HTML", };
    try {
      if (message.text) {
        const combinedText = fromUserHeader + message.text;
        await telegramApi(env.BOT_TOKEN, "sendMessage", { ...backupParams, text: combinedText, });
      } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { ...backupParams, text: fromUserHeader.trim(), parse_mode: "HTML", });
        await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: backupGroupId, from_chat_id: userId, message_id: message.message_id, });
      }
    } catch (e) {
      // 捕获备份失效流
    }
  }
}

async function handleRelayEditedMessage(editedMessage, env) {
  const { from: user } = editedMessage;
  const userId = user.id.toString();
  const userData = await dbUserGetOrCreate(userId, env);
  const topicId = userData.topic_id;
  if (!topicId) {
    return;
  }
  const storedData = await dbMessageDataGet(userId, editedMessage.message_id.toString(), env);
  let originalText = "[原始内容无法获取/非文本内容]";
  let originalDate = "[发送时间无法获取]";
  if (storedData) {
    originalText = storedData.text || originalText;
    originalDate = formatTimestamp(storedData.date);
    const updatedData = {
      text: editedMessage.text || editedMessage.caption || '',
      date: editedMessage.date
    };
    await dbMessageDataPut(userId, editedMessage.message_id.toString(), updatedData, env);
  }
  const newContent = editedMessage.text || editedMessage.caption || "[非文本/媒体说明内容]";
  const notificationText = `
⚠️ <b>用户消息已修改</b>
<b>原消息发送时间:</b> <code>${originalDate}</code>
<b>原始信息:</b> <code>${originalText}</code>
<b>修改后的新内容:</b>
${escapeHtml(newContent)}
    `.trim();
  try {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      text: notificationText,
      message_thread_id: topicId,
      parse_mode: "HTML",
    });
  } catch (e) {
    // 捕获推送流异常
  }
}

async function handleAdminReply(message, env) {
  if (!message.is_topic_message || !message.message_thread_id) return;
  const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
  if (message.chat.id.toString() !== adminGroupIdStr) return;
  if (message.from && message.from.is_bot) return;
  const senderId = message.from.id.toString();
  const isAuthorizedAdmin = await isAdminUser(senderId, env);
  if (!isAuthorizedAdmin) {
    return;
  }
  const topicId = message.message_thread_id.toString();
  const userId = await dbTopicUserGet(topicId, env);
  if (!userId) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminGroupIdStr,
      message_thread_id: topicId,
      text: "❌ 找不到该话题对应的用户 ID，无法转发消息。",
    });
    return;
  }
  try {
    if (message.text) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text: message.text,
      });
    } else if (message.photo) {
      await telegramApi(env.BOT_TOKEN, "sendPhoto", {
        chat_id: userId,
        photo: message.photo[message.photo.length - 1].file_id,
        caption: message.caption || "",
      });
    } else if (message.video) {
      await telegramApi(env.BOT_TOKEN, "sendVideo", {
        chat_id: userId,
        video: message.video.file_id,
        caption: message.caption || "",
      });
    } else if (message.audio) {
      await telegramApi(env.BOT_TOKEN, "sendAudio", {
        chat_id: userId,
        audio: message.audio.file_id,
        caption: message.caption || "",
      });
    } else if (message.voice) {
      await telegramApi(env.BOT_TOKEN, "sendVoice", {
        chat_id: userId,
        voice: message.voice.file_id,
        caption: message.caption || "",
      });
    } else if (message.sticker) {
      await telegramApi(env.BOT_TOKEN, "sendSticker", {
        chat_id: userId,
        sticker: message.sticker.file_id,
      });
    } else if (message.animation) {
      await telegramApi(env.BOT_TOKEN, "sendAnimation", {
        chat_id: userId,
        animation: message.animation.file_id,
        caption: message.caption || "",
      });
    }
    else if (message.video_note) {
      await telegramApi(env.BOT_TOKEN, "sendVideoNote", {
        chat_id: userId,
        video_note: message.video_note.file_id,
      });
    }
    else if (message.document) {
      await telegramApi(env.BOT_TOKEN, "sendDocument", {
        chat_id: userId,
        document: message.document.file_id,
        caption: message.caption || "",
      });
    }
    else {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text: "管理员发送了机器人无法直接转发的内容（例如投票或某些特殊媒体）。",
      });
    }
  } catch (e2) {
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminGroupIdStr,
      message_thread_id: topicId,
      text: `❌ 转发消息给用户 ${userId} 失败: ${e2.message || e2}`,
    });
  }
  try {
    if (message.text || message.caption) {
      const messageData = {
        text: message.text || message.caption || '',
        date: message.date
      };
      await dbMessageDataPut(userId, message.message_id.toString(), messageData, env);
    }
  } catch (e) {
    // 捕获存储组件异常
  }
}

async function syncToBlockLog(userId, user, isBlocked, isMuted, env) {
  const blockLogTopicId = await ensureBlockLogTopicExists(env);
  if (!blockLogTopicId) return;
  const userName = user.user_info?.name || userId;
  const jumpUrl = `https://t.me/c/${env.ADMIN_GROUP_ID.toString().replace(/^-100/, '')}/${user.topic_id}`;
  let statusText = "";
  if (isBlocked) statusText += "🚫 <b>用户被屏蔽</b>";
  else if (isMuted) statusText += "🔕 <b>用户被静音</b>";
  else statusText += "✅ <b>用户正常 (无屏蔽/无静音)</b>";
  const logText = `${statusText}\n` +
    `用户: <a href="tg://user?id=${userId}">${escapeHtml(userName)}</a>\n` +
    `ID: <code>${userId}</code>`;
  const buttons = getInfoCardButtons(userId, isBlocked, isMuted);
  const logMarkup = JSON.parse(JSON.stringify(buttons));
  if (user.topic_id) {
    logMarkup.inline_keyboard.push([{ text: "💬 跳转到会话窗口", url: jumpUrl }]);
  }
  const storedLogMsgId = user.block_log_message_id;
  const sendNewLog = async (targetTopicId) => {
    const sentMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: targetTopicId,
      text: logText,
      parse_mode: "HTML",
      reply_markup: logMarkup
    });
    await dbUserUpdate(userId, { block_log_message_id: sentMsg.message_id.toString() }, env);
  };
  if (storedLogMsgId) {
    try {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: storedLogMsgId,
        text: logText,
        parse_mode: "HTML",
        reply_markup: logMarkup
      });
      return;
    } catch (e) {
      if (e.description && e.description.includes("message is not modified")) {
        return;
      }
      await dbUserUpdate(userId, { block_log_message_id: null }, env);
    }
  }
  try {
    await sendNewLog(blockLogTopicId);
  } catch (e) {
    const errStr = e.message || e.toString();
    if (errStr.includes("thread not found") || errStr.includes("TOPIC_DELETED")) {
      await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind('user_block_log_topic_id').run();
      const newLogId = await ensureBlockLogTopicExists(env);
      if (newLogId) {
        await sendNewLog(newLogId);
      }
    }
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;
  const message = callbackQuery.message;
  const isAdmin = await isAdminUser(chatId, env);
  if (data === 'action:verify_user') {
    let user = await dbUserGetOrCreate(chatId, env);
    if (user.user_state === 'verified') {
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "您已经通过验证啦！", show_alert: true });
      return;
    }
    await dbUserUpdate(chatId, { user_state: "verified" }, env);
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "✅ 验证成功！", show_alert: false });
    try {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: message.text + "\n\n✅ <b>已通过验证</b>",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }
      });
    } catch (e) { }
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "🎉 验证通过！您可以开始发送消息了。",
    });
    return;
  }
  if (!isAdmin) {
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "您无权操作此菜单。", show_alert: true });
    return;
  }
  if (data.startsWith('config:')) {
    const parts = data.split(':');
    const actionType = parts[1];
    const keyOrAction = parts[2];
    const value = parts[3];
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "处理中...", show_alert: false });
    if (actionType === 'menu') {
      if (keyOrAction === 'base') {
        await handleAdminBaseConfigMenu(chatId, message.message_id, env);
      }
      else if (keyOrAction === 'autoreply') {
        await handleAdminAutoReplyMenu(chatId, message.message_id, env);
      }
      else if (keyOrAction === 'keyword') {
        await handleAdminKeywordBlockMenu(chatId, message.message_id, env);
      }
      else if (keyOrAction === 'filter') {
        await handleAdminTypeBlockMenu(chatId, message.message_id, env);
      }
      else if (keyOrAction === 'backup') {
        await handleAdminBackupConfigMenu(chatId, message.message_id, env);
      }
      else if (keyOrAction === 'authorized') {
        await handleAdminAuthorizedConfigMenu(chatId, message.message_id, env);
      }
      else {
        await handleAdminConfigStart(chatId, env, message.message_id);
      }
    }
    else if (actionType === 'toggle_mode' && keyOrAction === 'verification') {
      const currentMode = await getConfig('verification_mode', env, 'button');
      const newMode = currentMode === 'button' ? 'code' : 'button';
      await dbConfigPut('verification_mode', newMode, env);
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: `✅ 模式已切换为: ${newMode === 'button' ? '点击验证' : '验证码验证'}`,
        show_alert: false
      }).catch(() => {});
      await handleAdminBaseConfigMenu(chatId, message.message_id, env);
      return;
    }
    else if (actionType === 'toggle' && keyOrAction && value) {
      await dbConfigPut(keyOrAction, value, env);
      await handleAdminTypeBlockMenu(chatId, message.message_id, env);
    } else if (actionType === 'edit' && keyOrAction) {
      if (keyOrAction === 'backup_group_id_clear') {
        await dbConfigPut('backup_group_id', '', env);
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "✅ 备份群组 ID 已清除。", show_alert: false }).catch(() => {});
        await handleAdminBackupConfigMenu(chatId, message.message_id, env);
        return;
      }
      if (keyOrAction === 'authorized_admins_clear') {
        await dbConfigPut('authorized_admins', '[]', env);
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "✅ 协管员列表已清除。", show_alert: false }).catch(() => {});
        await handleAdminAuthorizedConfigMenu(chatId, message.message_id, env);
        return;
      }
      await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: keyOrAction }), env);
      let prompt = `请发送**新的** <code>${keyOrAction}</code> **值**：`;
      let cancelBack = "config:menu";
      if (keyOrAction === 'welcome_msg') {
        prompt = "请发送**新的欢迎消息**：";
        cancelBack = "config:menu:base";
      }
      else if (keyOrAction === 'verif_q') {
        prompt = "请发送**新的验证问题**：";
        cancelBack = "config:menu:base";
      }
      else if (keyOrAction === 'verif_a') {
        prompt = "请发送你需要设置的答案...";
        cancelBack = "config:menu:base";
      }
      else if (keyOrAction === 'block_threshold') {
        prompt = "请发送**新的屏蔽次数阈值 (数字)**：";
        cancelBack = "config:menu:keyword";
      }
      else if (keyOrAction === 'backup_group_id') {
        prompt = "请发送**新的备份群组 ID**...";
        cancelBack = "config:menu:backup";
      }
      else if (keyOrAction === 'authorized_admins') {
        prompt = "请发送**新的协管员 ID 列表**...";
        cancelBack = "config:menu:authorized";
      }
      const cancelBtn = { inline_keyboard: [[{ text: "❌ 取消编辑", callback_data: cancelBack }]] };
      await telegramApi(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: message.message_id, text: `${prompt}\n\n发送 \`/cancel\` 或点击下方按钮取消。`, parse_mode: "HTML", reply_markup: cancelBtn, });
    } else if (actionType === 'add' && keyOrAction) {
      const newKey = keyOrAction + '_add';
      await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: newKey }), env);
      let prompt = "";
      let cancelBack = "";
      if (keyOrAction === 'keyword_responses') {
        prompt = "请发送**新的自动回复规则**..."; cancelBack = "config:menu:autoreply";
      }
      else if (keyOrAction === 'block_keywords') {
        prompt = "请发送**新的屏蔽关键词表达式**...";
        cancelBack = "config:menu:keyword";
      }
      const cancelBtn = { inline_keyboard: [[{ text: "❌ 取消添加", callback_data: cancelBack }]] };
      await telegramApi(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: message.message_id, text: `${prompt}\n\n发送 \`/cancel\` 或点击下方按钮取消.`, parse_mode: "HTML", reply_markup: cancelBtn, });
    } else if (actionType === 'list' && keyOrAction) {
      await handleAdminRuleList(chatId, message.message_id, env, keyOrAction);
    } else if (actionType === 'sync' && keyOrAction === 'remote_spam') {
      await telegramApi(env.BOT_TOKEN, "editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: "⏳ 正在连接 GitHub 并同步远程词库，请稍候..."
      });
      const result = await syncRemoteSpamRules(env);
      let notifyText = "";
      if (result.success) {
        notifyText = `🎉 同步成功！\n从远程获取了 <b>${result.count}</b> 个屏蔽词。\n当前本地词库总计 <b>${result.total}</b> 个。`;
      } else {
        notifyText = `❌ 同步失败！错误原因：<code>${escapeHtml(result.msg)}</code>`;
      }
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: notifyText,
        parse_mode: "HTML"
      });
      await handleAdminKeywordBlockMenu(chatId, 0, env);
    } else if (actionType === 'delete' && keyOrAction && value) {
      await handleAdminRuleDelete(chatId, message.message_id, env, keyOrAction, value, callbackQuery.id);
    }
    return;
  }
  if (message.chat.id.toString() !== env.ADMIN_GROUP_ID.toString()) {
    return;
  }
  const [action, targetUserId] = data.split(':');
  const currentTopicId = message.message_thread_id ? message.message_thread_id.toString() : null;
  let user = await dbUserGetOrCreate(targetUserId, env);
  if (user.topic_id === currentTopicId && !user.info_card_message_id) {
    await dbUserUpdate(targetUserId, { info_card_message_id: message.message_id.toString() }, env);
    user.info_card_message_id = message.message_id.toString();
  }
  const blockLogTopicId = await dbConfigGet('user_block_log_topic_id', env);
  if (blockLogTopicId === currentTopicId && !user.block_log_message_id) {
    await dbUserUpdate(targetUserId, { block_log_message_id: message.message_id.toString() }, env);
    user.block_log_message_id = message.message_id.toString();
  }
  const profileLogTopicId = await dbConfigGet('user_profile_log_topic_id', env);
  if (profileLogTopicId === currentTopicId && !user.profile_log_message_id) {
    await dbUserUpdate(targetUserId, { profile_log_message_id: message.message_id.toString() }, env);
    user.profile_log_message_id = message.message_id.toString();
  }
  if (['block', 'unblock', 'mute', 'unmute'].includes(action)) {
    const isBlockAction = action === 'block' || action === 'unblock';
    const isMuteAction = action === 'mute' || action === 'unmute';
    const newState = (action === 'block' || action === 'mute');
    try {
      const updateData = isBlockAction ? { is_blocked: newState } : { is_muted: newState };
      await dbUserUpdate(targetUserId, updateData, env);
      user = await dbUserGetOrCreate(targetUserId, env);
      const userName = user.user_info?.name || targetUserId;
      const newMarkup = getInfoCardButtons(targetUserId, user.is_blocked, user.is_muted);
      const preserveJumpLink = (originalMarkup) => {
        let updated = JSON.parse(JSON.stringify(newMarkup));
        if (originalMarkup && originalMarkup.inline_keyboard) {
          const lastRow = originalMarkup.inline_keyboard[originalMarkup.inline_keyboard.length - 1];
          if (lastRow && lastRow[0] && lastRow[0].url && lastRow[0].url.includes('t.me/c/')) {
            updated.inline_keyboard.push(lastRow);
          }
        }
        return updated;
      };
      await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: preserveJumpLink(message.reply_markup),
      });
      let toastText = "";
      if (isBlockAction) toastText = newState ? "🚫 已屏蔽该用户" : "✅ 已解除屏蔽";
      else if (isMuteAction) toastText = newState ? "🔕 已静音通知" : "🔔 已恢复通知";
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: toastText,
        show_alert: false
      });
      await syncToBlockLog(targetUserId, user, user.is_blocked, user.is_muted, env);
      if (user.info_card_message_id && message.message_id.toString() !== user.info_card_message_id) {
        try {
          await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: env.ADMIN_GROUP_ID,
            message_id: user.info_card_message_id,
            reply_markup: newMarkup,
          });
        } catch (e) { }
      }
      if (user.profile_log_message_id && message.message_id.toString() !== user.profile_log_message_id) {
        try {
          const cleanGroupId = env.ADMIN_GROUP_ID.toString().replace(/^-100/, '');
          const jumpUrl = `https://t.me/c/${cleanGroupId}/${user.topic_id}`;
          const logMarkup = JSON.parse(JSON.stringify(newMarkup));
          logMarkup.inline_keyboard.push([{ text: "💬 跳转到会话窗口", url: jumpUrl }]);
          await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: env.ADMIN_GROUP_ID,
            message_id: user.profile_log_message_id,
            reply_markup: logMarkup,
          });
        } catch (e) { }
      }
      if (isBlockAction && currentTopicId && currentTopicId === user.topic_id) {
        const confirmation = newState
          ? `❌ **用户 [${userName}] 已被屏蔽。**`
          : `✅ **用户 [${userName}] 已解除屏蔽。**`;
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: confirmation,
          message_thread_id: currentTopicId,
          parse_mode: "Markdown",
        });
      }
    } catch (e) {
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "❌ 操作失败，请重试。", show_alert: true });
    }
  }
  else if (action === 'pin_card') {
    try {
      await telegramApi(env.BOT_TOKEN, "pinChatMessage", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        message_thread_id: currentTopicId,
        disable_notification: true,
      });
      if (currentTopicId === user.topic_id) {
        await dbUserUpdate(targetUserId, { info_card_message_id: message.message_id.toString() }, env);
      } else if (currentTopicId === await dbConfigGet('user_profile_log_topic_id', env)) {
        await dbUserUpdate(targetUserId, { profile_log_message_id: message.message_id.toString() }, env);
      }
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: "✅ 已置顶该资料卡。",
        show_alert: false
      });
    } catch (e) {
      await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: `❌ 置顶失败: ${e.message}`,
        show_alert: true
      });
    }
  }
}
