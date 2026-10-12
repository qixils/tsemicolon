# tsemicolon

(t)semicolon is a Discord bot written in TypeScript for server management and moderation.

## Setup

### Migrating from the old bot

Shut down the old bot so all the state files flush then copy these files relative to `package.json`

| Copy from                  | To (new bot)               |
| -------------------------- | -------------------------- |
| `data/config.db`           | `legacy_data/config.db`    |
| `data/pokemon.json`        | `legacy_data/pokemon.json` |
| `pkmn/` (very legacy data) | `legacy_data/pkmn/`        |

### Discord Developer Portal

Under **Installation** enable **User Install** and **Guild Install**.

Under **Bot -> Privileged Gateway Intents**
enable **Server Members Intent** and **Message Content Intent**.

Bot oauth links are recommended to suggest View Audit Log, Manage Roles,
Manage Channels, Manage Messages, Moderate Members, Kick Members, Ban Members,
Add Reactions, Embed Links, and Read Message History

### Environment

Setup in `.env` or environment variables.

| Variable         | Default      | Purpose                                                       |
| ---------------- | ------------ | ------------------------------------------------------------- |
| `TOKEN`          | **required** |                                                               |
| `APPLICATION_ID` | **required** | Command registration                                          |
| `DATA_DIR`       | `data`       | Path to where the bot keeps its database and caches           |
| `OWNER_ID`       | undefined    | User ID snowflake of who can DM the bot `logout` and `update` |

### Building & Running

```sh
npm i
npm run build
npm start  # or `node dist/index.js`
```
