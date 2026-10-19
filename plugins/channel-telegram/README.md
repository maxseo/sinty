# channel-telegram

Public `POST /p/channel-telegram/telegram`. Telegram must send `X-Telegram-Bot-Api-Secret-Token`, equal to the secret `telegram.secret` (`sinty secret set telegram.secret`). The bot token is `telegram.bot`.

Each chat id is one session. The answer is `sendMessage`. Set `plugins.config.channel-telegram.apiBase` to point at a mock in tests. Register the webhook with Bot API `setWebhook` yourself; this plugin does not call `getUpdates`.

Enable `channel-telegram` in `plugins.enabled`. The site's own Telegram inbox stays as it is until you point the bot here.
