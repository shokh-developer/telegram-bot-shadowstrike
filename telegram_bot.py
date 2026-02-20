import os
import asyncio
import requests
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from telegram import Update
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes, CallbackQueryHandler
from telegram.error import Conflict, InvalidToken


def _load_dotenv_if_present():
    # Minimal .env loader to avoid extra dependencies.
    # For this bot, values from server/.env should override process env
    # so old stale system variables don't break runtime unexpectedly.
    here = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(here, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("\"").strip("'")
                if k:
                    os.environ[k] = v
    except Exception:
        # If .env can't be read, just continue with normal env vars.
        return


_load_dotenv_if_present()

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
BOT_API_KEY = os.getenv("BOT_API_KEY", "").strip()
BOT_ADMIN_USERNAME = "shtursunov7"
HERE = os.path.dirname(os.path.abspath(__file__))
ADMIN_STATE_PATH = os.path.join(HERE, "bot_admin_state.json")
SEEN_TOPUPS: set[str] = set()


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/health", "/healthz"):
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        return


def _start_health_server():
    port_raw = os.getenv("PORT", "").strip()
    if not port_raw:
        return
    try:
        port = int(port_raw)
    except Exception:
        return
    if port <= 0:
        return

    def _run():
        try:
            server = ThreadingHTTPServer(("0.0.0.0", port), _HealthHandler)
            server.serve_forever()
        except Exception as e:
            print(f"health server error: {e}")

    threading.Thread(target=_run, daemon=True).start()


def _headers():
    return {
        "Content-Type": "application/json",
        "x-bot-api-key": BOT_API_KEY,
    }


def _is_admin(update: Update) -> bool:
    tg_username = (update.effective_user.username or "").lower().strip()
    return bool(tg_username and tg_username == BOT_ADMIN_USERNAME)


def _load_admin_chat_id() -> int | None:
    try:
        if not os.path.exists(ADMIN_STATE_PATH):
            return None
        with open(ADMIN_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        cid = int(data.get("adminChatId", 0) or 0)
        return cid if cid > 0 else None
    except Exception:
        return None


def _save_admin_chat_id(chat_id: int):
    try:
        with open(ADMIN_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"adminChatId": int(chat_id)}, f)
    except Exception:
        return


async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_username = (update.effective_user.username or "").lower().strip()
    if BOT_ADMIN_USERNAME and tg_username == BOT_ADMIN_USERNAME and update.effective_chat:
        _save_admin_chat_id(update.effective_chat.id)
    await update.message.reply_text(
        "ShadowStrike bot.\n"
        "1) /connect <code> - appdagi bot code bilan account ulash\n"
        "2) /reset <new_password> - parolni almashtirish (eski parol so'ralmaydi)\n"
        "3) /ban <game_username> va /unban <game_username> (admin)\n"
        "4) /topups (admin) - vales cheklarni ko'rish va tasdiqlash"
    )


async def link_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Faqat /reset ishlaydi.")
        return
    if len(context.args) < 1:
        await update.message.reply_text("Foydalanish: /link <game_username>")
        return
    tg_username = (update.effective_user.username or "").lower().strip()
    if not tg_username:
        await update.message.reply_text("Telegram username yo'q. Telegram'da username o'rnating.")
        return

    username = context.args[0].strip().lower()
    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/profile/link-telegram",
            json={"username": username, "telegramUsername": tg_username},
            timeout=10,
        )
        data = res.json()
    except Exception as e:
        await update.message.reply_text(f"Server xatosi: {e}")
        return

    if data.get("ok"):
        await update.message.reply_text(f"Ulandi: {username} <-> @{tg_username}")
    else:
        await update.message.reply_text(f"Xatolik: {data.get('message', 'unknown')}")


async def connect_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Faqat /reset ishlaydi.")
        return
    if len(context.args) < 1:
        await update.message.reply_text("Foydalanish: /connect <code>")
        return
    tg_username = (update.effective_user.username or "").lower().strip()
    if not tg_username:
        await update.message.reply_text("Telegram username yo'q. Telegram'da username o'rnating.")
        return
    if not BOT_API_KEY:
        await update.message.reply_text("BOT_API_KEY sozlanmagan.")
        return

    code = context.args[0].strip().upper()
    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/profile/link-code/confirm",
            json={"code": code, "telegramUsername": tg_username},
            headers=_headers(),
            timeout=10,
        )
        data = res.json()
    except Exception as e:
        await update.message.reply_text(f"Server xatosi: {e}")
        return

    if data.get("ok"):
        await update.message.reply_text(
            f"Muvaffaqiyatli ulanildi.\n"
            f"Account: {data.get('username')}\n"
            f"Telegram: @{tg_username}"
        )
    else:
        await update.message.reply_text(f"Xatolik: {data.get('message', 'unknown')}")


async def reset_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Foydalanish: /reset <new_password>")
        return
    tg_username = (update.effective_user.username or "").lower().strip()
    if not tg_username:
        await update.message.reply_text("Telegram username yo'q. Telegram'da username o'rnating.")
        return
    if not BOT_API_KEY:
        await update.message.reply_text("BOT_API_KEY sozlanmagan.")
        return

    new_password = context.args[0].strip()

    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/profile/reset-self-from-telegram",
            json={
                "telegramUsername": tg_username,
                "newPassword": new_password,
            },
            headers=_headers(),
            timeout=10,
        )
        data = res.json()
    except Exception as e:
        await update.message.reply_text(f"Server xatosi: {e}")
        return

    if data.get("ok"):
        await update.message.reply_text(f"Parol yangilandi: {data.get('username')}")
    else:
        await update.message.reply_text(f"Xatolik: {data.get('message', 'unknown')}")


async def _set_block(update: Update, username: str, blocked: bool):
    tg_username = (update.effective_user.username or "").lower().strip()
    if not BOT_API_KEY:
        await update.message.reply_text("BOT_API_KEY sozlanmagan.")
        return
    if tg_username != BOT_ADMIN_USERNAME:
        await update.message.reply_text("Sizda ruxsat yo'q.")
        return
    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/profile/admin/block",
            json={
                "username": username,
                "blocked": blocked,
                "actorTelegramUsername": tg_username,
            },
            headers=_headers(),
            timeout=10,
        )
        data = res.json()
    except Exception as e:
        await update.message.reply_text(f"Server xatosi: {e}")
        return

    if data.get("ok"):
        await update.message.reply_text(f"{username}: {'blocked' if blocked else 'unblocked'}")
    else:
        await update.message.reply_text(f"Xatolik: {data.get('message', 'unknown')}")


async def ban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Foydalanish: /ban <game_username>")
        return
    await _set_block(update, context.args[0].strip().lower(), True)


async def unban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Foydalanish: /unban <game_username>")
        return
    await _set_block(update, context.args[0].strip().lower(), False)


async def topups_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_username = (update.effective_user.username or "").lower().strip()
    if not BOT_API_KEY:
        await update.message.reply_text("BOT_API_KEY sozlanmagan.")
        return
    if tg_username != BOT_ADMIN_USERNAME:
        await update.message.reply_text("Sizda ruxsat yo'q.")
        return

    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/bot/topup/pending",
            json={"actorTelegramUsername": tg_username},
            headers=_headers(),
            timeout=12,
        )
        data = res.json()
    except Exception as e:
        await update.message.reply_text(f"Server xatosi: {e}")
        return

    if not data.get("ok"):
        await update.message.reply_text(f"Xatolik: {data.get('message', 'unknown')}")
        return

    rows = data.get("rows") or []
    if len(rows) == 0:
        await update.message.reply_text("Pending chek yo'q.")
        return

    for row in rows:
        SEEN_TOPUPS.add(str(row.get("id", "")))
        rid = str(row.get("id", ""))
        username = str(row.get("username", ""))
        vales = int(row.get("vales", 0) or 0)
        price_uzs = int(row.get("priceUzs", 0) or 0)
        package_label = str(row.get("packageLabel", ""))
        created_at = int(row.get("createdAt", 0) or 0)
        receipt = str(row.get("receiptImage", ""))
        caption = (
            f"Topup request\n"
            f"ID: {rid}\n"
            f"User: {username}\n"
            f"Package: {package_label}\n"
            f"Vales: {vales}\n"
            f"UZS: {price_uzs}\n"
            f"CreatedAt: {created_at}"
        )
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("To'g'ri", callback_data=f"tp:approve:{rid}"),
                InlineKeyboardButton("Xato", callback_data=f"tp:reject:{rid}"),
            ]
        ])

        try:
            if receipt.startswith("data:image/") and "," in receipt:
                b64 = receipt.split(",", 1)[1]
                import base64
                photo_bytes = base64.b64decode(b64)
                await update.message.reply_photo(photo=photo_bytes, caption=caption, reply_markup=keyboard)
            else:
                await update.message.reply_text(caption, reply_markup=keyboard)
        except Exception:
            await update.message.reply_text(caption, reply_markup=keyboard)


async def _notify_pending_topups(context: ContextTypes.DEFAULT_TYPE):
    if not BOT_API_KEY:
        return
    chat_id = _load_admin_chat_id()
    if not chat_id:
        return

    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/bot/topup/pending",
            json={"actorTelegramUsername": BOT_ADMIN_USERNAME},
            headers=_headers(),
            timeout=12,
        )
        data = res.json()
    except Exception:
        return

    if not data.get("ok"):
        return

    rows = data.get("rows") or []
    for row in rows:
        rid = str(row.get("id", ""))
        if not rid or rid in SEEN_TOPUPS:
            continue
        SEEN_TOPUPS.add(rid)
        username = str(row.get("username", ""))
        vales = int(row.get("vales", 0) or 0)
        price_uzs = int(row.get("priceUzs", 0) or 0)
        package_label = str(row.get("packageLabel", ""))
        created_at = int(row.get("createdAt", 0) or 0)
        receipt = str(row.get("receiptImage", ""))
        caption = (
            f"Topup request\n"
            f"ID: {rid}\n"
            f"User: {username}\n"
            f"Package: {package_label}\n"
            f"Vales: {vales}\n"
            f"UZS: {price_uzs}\n"
            f"CreatedAt: {created_at}"
        )
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("To'g'ri", callback_data=f"tp:approve:{rid}"),
                InlineKeyboardButton("Xato", callback_data=f"tp:reject:{rid}"),
            ]
        ])
        try:
            if receipt.startswith("data:image/") and "," in receipt:
                b64 = receipt.split(",", 1)[1]
                import base64
                photo_bytes = base64.b64decode(b64)
                await context.bot.send_photo(chat_id=chat_id, photo=photo_bytes, caption=caption, reply_markup=keyboard)
            else:
                await context.bot.send_message(chat_id=chat_id, text=caption, reply_markup=keyboard)
        except Exception:
            # keep seen flag to avoid flood retries on broken payloads
            continue


async def topup_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if not query:
        return
    await query.answer()

    tg_username = (update.effective_user.username or "").lower().strip()
    if not BOT_API_KEY:
        if query.message and query.message.caption:
            await query.edit_message_caption(caption="BOT_API_KEY sozlanmagan.")
        else:
            await query.edit_message_text("BOT_API_KEY sozlanmagan.")
        return
    if tg_username != BOT_ADMIN_USERNAME:
        await query.answer("Sizda ruxsat yo'q.", show_alert=True)
        return

    data = str(query.data or "")
    # tp:approve:<id> or tp:reject:<id>
    parts = data.split(":")
    if len(parts) != 3 or parts[0] != "tp":
        return
    action = parts[1]
    request_id = parts[2]
    if action not in ("approve", "reject"):
        return

    try:
        res = requests.post(
            f"{SERVER_BASE_URL}/api/bot/topup/resolve",
            json={
                "actorTelegramUsername": tg_username,
                "requestId": request_id,
                "action": action,
                "reason": "xato",
            },
            headers=_headers(),
            timeout=12,
        )
        payload = res.json()
    except Exception as e:
        await query.answer(f"Server xatosi: {e}", show_alert=True)
        return

    if not payload.get("ok"):
        await query.answer(payload.get("message", "Xatolik"), show_alert=True)
        return

    req = payload.get("request") or {}
    status = str(req.get("status", action))
    uname = str(req.get("username", ""))
    vales = int(req.get("vales", 0) or 0)
    text = f"Topup {status.upper()} | {uname} | +{vales} vales"

    if query.message and query.message.caption:
        await query.edit_message_caption(caption=f"{query.message.caption}\n\n{text}")
    else:
        await query.edit_message_text(text=text)


def main():
    if not BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN topilmadi")
    # Python 3.14+: default event loop is not created automatically in main thread.
    # PTB run_polling() expects a current event loop.
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    _start_health_server()
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("link", link_cmd))
    app.add_handler(CommandHandler("connect", connect_cmd))
    app.add_handler(CommandHandler("reset", reset_cmd))
    app.add_handler(CommandHandler("ban", ban_cmd))
    app.add_handler(CommandHandler("unban", unban_cmd))
    app.add_handler(CommandHandler("topups", topups_cmd))
    app.add_handler(CallbackQueryHandler(topup_callback, pattern=r"^tp:(approve|reject):"))
    if app.job_queue is not None:
        app.job_queue.run_repeating(_notify_pending_topups, interval=5, first=5)
    else:
        print(
            "JobQueue mavjud emas. Auto topup notify o'chdi.\n"
            "Yechim: pip install \"python-telegram-bot[job-queue]\""
        )
    try:
        app.run_polling()
    except Conflict:
        # This happens when another instance is polling getUpdates with the same token.
        raise SystemExit(
            "Conflict: boshqa bot instance ishlayapti (shu token bilan getUpdates).\n"
            "Windows'da tekshirish:\n"
            "  Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Select-Object ProcessId,CommandLine\n"
            "Keyin botni qayta ishga tushiring."
        )
    except InvalidToken:
        raise SystemExit(
            "Invalid Telegram token: TELEGRAM_BOT_TOKEN noto'g'ri yoki bekor qilingan.\n"
            "BotFather'dan yangi token oling va server/.env dagi TELEGRAM_BOT_TOKEN ni yangilang."
        )


if __name__ == "__main__":
    main()
