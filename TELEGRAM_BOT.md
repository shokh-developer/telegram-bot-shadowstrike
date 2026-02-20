# Telegram Reset Bot

## 1) Server env
Set before running `npm run server`:

- `BOT_API_KEY=your_secret_key`
- `BOT_ADMIN_USERNAME=your_tg_username` (ban/unban uchun)

## 2) Bot env
Set before running python bot:

- `TELEGRAM_BOT_TOKEN=<your_bot_token>`
- `SERVER_BASE_URL=http://127.0.0.1:3001`
- `BOT_API_KEY=your_secret_key` (must match server value)
- `BOT_ADMIN_USERNAME=your_tg_username`

## 3) Install and run bot

```bash
cd server
pip install -r requirements.txt
python telegram_bot.py
```

## 4) Usage in Telegram

1. App ichida profile'dan `CREATE BOT CODE` oling.
2. Botga yuboring: `/connect <code>`
3. Parolni almashtirish:
`/reset <new_password>`
4. Admin block/unblock:
`/ban <game_username>`
`/unban <game_username>`

5. Vales topup approve/reject (admin):
`/topups`
Bot cheklar chiqarganda `To'g'ri` bosilsa vales beriladi, `Xato` bosilsa berilmaydi.

Telegram username accountga link bo'lishi shart (`/connect` orqali).

Topup tasdiqlash faqat `@shtursunov7` uchun yoqilgan.
Admin uchun botga `/start` yozing, shunda yangi cheklar avtomatik chatga tushadi.
