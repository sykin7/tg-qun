import os
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.error import TelegramError

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

def parse_group_map(map_string: str):
    group_map = {}
    if not map_string:
        logger.warning("GROUP_MAP 环境变量为空。")
        return group_map
        
    try:
        pairs = map_string.split(',')
        for pair in pairs:
            parts = pair.split(':')
            if len(parts) == 2:
                alias = parts[0].strip()
                chat_id = parts[1].strip()
                group_map[alias] = chat_id
                logger.info(f"已加载别名: {alias} -> {chat_id}")
            else:
                logger.warning(f"跳过格式错误的 GROUP_MAP 键值对: {pair}")
    except Exception as e:
        logger.error(f"解析 GROUP_MAP 失败: {e}")
    
    if not group_map:
        logger.error("GROUP_MAP 解析后为空，请检查格式。")
        
    return group_map

def is_admin(user_id: int) -> bool:
    admin_id = os.environ.get("ADMIN_USER_ID")
    if not admin_id:
        logger.error("ADMIN_USER_ID 环境变量未设置！")
        return False
    return str(user_id) == admin_id

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.message.from_user.id):
        await update.message.reply_text("您无权使用此机器人。")
        return

    loaded_aliases = context.bot_data.get('group_map', {}).keys()
    
    if not loaded_aliases:
        await update.message.reply_text(
            '❌ 错误：管理员，我没有在环境变量中找到任何有效的 GROUP_MAP。\n'
            '请在 Leaflow 中正确设置 GROUP_MAP 后重启 (Redeploy) 服务。'
        )
        return

    alias_list_text = "\n".join([f"- `{alias}`" for alias in loaded_aliases])
    
    await update.message.reply_text(
        '你好，管理员！我是您的内容分发机器人。\n\n'
        '**模式切换 (推荐):**\n'
        '1. 使用 `/set <别名>` (例如: `/set g1`) 来设定目标群组。\n'
        '2. 之后您发送的【所有消息】(文字/图片/文件)都将自动匿名发送到该群。\n'
        '3. 使用 `/set none` 来取消目标，停止自动转发。\n'
        '4. 使用 `/who` 查看当前目标群组。\n\n'
        '**快速发送 (仅文本):**\n'
        '• 使用 `/to <别名> <内容>` (例如: `/to g1 临时消息`) 来快速发送纯文本消息，这不会改变您用 `/set` 设定的目标。\n\n'
        '**群组命令:**\n'
        '• 在群组中发送 `/getid` 来获取群组ID。\n\n'
        f'**我目前识别的别名有:**\n{alias_list_text}',
        parse_mode='MarkdownV2'
    )

async def get_group_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.chat.type == "private":
        await update.message.reply_text("请在群组中运行此命令。")
        return
    chat_id = update.message.chat.id
    await update.message.reply_text(
        f'✅ 此群组的 ID 是:\n\n`{chat_id}`\n\n'
        f'请在 Leaflow 的 GROUP_MAP 环境变量中使用这个ID。',
        parse_mode='MarkdownV2'
    )

async def set_target_group(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.message.from_user.id): return

    group_map = context.bot_data.get('group_map', {})
    
    try:
        target_alias = context.args[0]
    except IndexError:
        await update.message.reply_text("请提供一个别名。用法: `/set <别名>` 或 `/set none`")
        return

    if target_alias.lower() == "none":
        context.user_data['active_group_alias'] = None
        context.user_data['active_group_id'] = None
        await update.message.reply_text("✅ 模式已取消。您现在发送的消息不会被自动转发。")
        return

    target_group_id = group_map.get(target_alias)
    
    if target_group_id:
        context.user_data['active_group_alias'] = target_alias
        context.user_data['active_group_id'] = target_group_id
        await update.message.reply_text(f"✅ 已切换模式。现在您所有的消息都将自动匿名发送到: `{target_alias}`", parse_mode='MarkdownV2')
    else:
        await update.message.reply_text(f"❌ 错误：未找到别名 '{target_alias}'。")

async def who_is_target(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.message.from_user.id): return
    
    target_alias = context.user_data.get('active_group_alias')
    if target_alias:
        await update.message.reply_text(f"ℹ️ 当前消息目标群组是: `{target_alias}`", parse_mode='MarkdownV2')
    else:
        await update.message.reply_text("ℹ️ 当前未设置自动转发目标。使用 `/set <别名>` 来设置。")

async def fire_and_forget_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.message.from_user.id): return
    
    group_map = context.bot_data.get('group_map', {})
    
    try:
        target_alias = context.args[0]
        content_to_send = " ".join(context.args[1:])
        
        if not content_to_send:
            await update.message.reply_text("您没有输入内容。用法: `/to <别名> <内容>`")
            return

    except (IndexError, ValueError):
        await update.message.reply_text("格式错误。用法: `/to <别名> <内容>`")
        return

    target_group_id = group_map.get(target_alias)
    if not target_group_id:
        await update.message.reply_text(f"❌ 错误：未找到别名 '{target_alias}'。")
        return
        
    try:
        await context.bot.send_message(chat_id=target_group_id, text=content_to_send)
        await update.message.reply_text(f"✅ 临时文本消息已发送到: {target_alias}。")
    except Exception as e:
        await update.message.reply_text(f"❌ 发送到 {target_alias} 失败: {e}")

async def modal_relay_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.message.from_user.id): return
    
    target_group_id = context.user_data.get('active_group_id')
    target_alias = context.user_data.get('active_group_alias')
    
    if not target_group_id:
        return

    logger.info(f"正在自动复制消息到 {target_alias} ({target_group_id})")

    try:
        await context.bot.copy_message(
            chat_id=target_group_id,
            from_chat_id=update.message.chat_id,
            message_id=update.message.message_id
        )
        
    except TelegramError as e:
        logger.error(f"自动复制到 {target_alias} 失败: {e}")
        if "chat not found" in str(e):
            await update.message.reply_text(f"❌ 自动转发失败：找不到群组 {target_alias}。")
        elif "bot is not a member" in str(e):
            await update.message.reply_text(f"❌ 自动转发失败：机器人不是群组 {target_alias} 的成员。")
        else:
            await update.message.reply_text(f"❌ 自动转发失败 ({target_alias}): {e}")
    except Exception as e:
        logger.error(f"发生意外错误: {e}")
        await update.message.reply_text(f"❌ 发生未知错误: {e}")

def main() -> None:
    
    token = os.environ.get("BOT_TOKEN")
    if not token:
        logger.error("错误：没有找到 BOT_TOKEN 环境变量。")
        return
        
    map_string = os.environ.get("GROUP_MAP", "")
    group_map = parse_group_map(map_string)

    application = Application.builder().token(token).build()
    
    application.bot_data['group_map'] = group_map

    application.add_handler(CommandHandler("start", start, filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("set", set_target_group, filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("who", who_is_target, filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("to", fire_and_forget_text, filters.ChatType.PRIVATE))
    
    application.add_handler(CommandHandler("getid", get_group_id, filters.ChatType.GROUP | filters.ChatType.SUPERGROUP))

    application.add_handler(MessageHandler(
        filters.ChatType.PRIVATE & ~filters.COMMAND,
        modal_relay_handler
    ))
    
    logger.info("机器人开始运行 (终极模式切换版)...")
    application.run_polling()

if __name__ == '__main__':
    main()
