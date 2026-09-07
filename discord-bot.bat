@echo off
REM Seat Scout Discord bot: tag @Seat Scout (or DM it) and it scouts seats and
REM replies with the best picks. Needs a bot token — see README "Discord bot".
REM Keep this window open; the bot lives in it. Ctrl+C to stop.
cd /d "%~dp0"
node src\discord-bot.mjs
pause
