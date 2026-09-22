<h1>kai-pa!</h1>

This bot uses Discord slash commands and MongoDB persistence.

```bash
npm ci
cp .env.example .env
npm run register
npm start
```

`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `MONGODB_URI` are required. `npm run register` registers the global slash commands; Discord may take a while to propagate global command changes.

Commands include `/help`, `/osu recent`, `/osu recent username:<username>`, `/osu add username:<username>`, `/set countdown`, `/rule`, `/number`, `/delink`, `/status`, and `/fortune`.

Counting and anti-link moderation continue to inspect normal server messages, so enable the Message Content and Server Members privileged intents. The bot also needs View Channels, Send Messages, Embed Links, Manage Messages, and Manage Roles where those features are used.


