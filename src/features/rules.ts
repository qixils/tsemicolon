import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { int, text, withSchema } from '../db.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { t } from '../i18n.js'
import { chunkLines, truncate } from '../util/discord.js'

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS rules (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT    NOT NULL,
    text     TEXT    NOT NULL,
    ping     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS rules_by_guild ON rules (guild_id, id);
`)

export interface Rule {
  id: number
  /** 1-based position in the list */
  number: number
  text: string
  /** whether to ping mods when used in a report */
  ping: boolean
}

export const listRules = (guildId: string): Rule[] =>
  db().prepare('SELECT id, text, ping FROM rules WHERE guild_id = ? ORDER BY id').all(guildId)
    .map((row, index) => ({ id: int(row, 'id'), number: index + 1, text: text(row, 'text'), ping: int(row, 'ping') === 1 }))

export const getRuleById = (guildId: string, id: number): Rule | undefined =>
  listRules(guildId).find(rule => rule.id === id)

export const addRule = (guildId: string, ruleText: string, ping = false) =>
  db().prepare('INSERT INTO rules (guild_id, text, ping) VALUES (?, ?, ?)').run(guildId, ruleText, ping ? 1 : 0)

const formatRule = (rule: Rule, showPing = false) =>
  `**${rule.number}.** ${rule.text}${showPing && rule.ping ? ' 🔔' : ''}`

/** chunkify large messages */
const replyInChunks = async (interaction: ChatInputCommandInteraction, content: string, ephemeral = false) => {
  const [first = '', ...rest] = chunkLines(content)
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined
  await interaction.reply({ content: first, ...(flags && { flags }) })
  for (const chunk of rest) await interaction.followUp({ content: chunk, ...(flags && { flags }) })
}

/** autocompletes rules by contents or index */
const suggestRules = (asString: boolean) => async (interaction: AutocompleteInteraction) => {
  if (!interaction.guildId) return
  const query = String(interaction.options.getFocused()).trim().toLowerCase()
  const choices = listRules(interaction.guildId)
    .filter(rule => !query || String(rule.number).startsWith(query) || rule.text.toLowerCase().includes(query))
    .slice(0, 25)
    .map(rule => ({ name: truncate(`${rule.number}. ${rule.text}`, 100), value: asString ? String(rule.number) : rule.number }))
  await interaction.respond(choices)
}

/** fetches a rule from an index */
const pickRule = async (interaction: ChatInputCommandInteraction<'cached'>): Promise<Rule | undefined> => {
  const number = interaction.options.getInteger('number', true)
  const rule = listRules(interaction.guildId)[number - 1]
  if (!rule) await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'rules.missing', { number }), flags: MessageFlags.Ephemeral })
  return rule
}

const numberOption = {
  type: ApplicationCommandOptionType.Integer as const,
  ...localizedName('command.setup.rules.option.number.name'),
  ...localizedDescription('command.setup.rules.option.number.description'),
  required: true,
  min_value: 1,
  autocomplete: true,
}

export const rulesFeature: Feature = {
  commands: [{
    ...localizedName('command.rules.name'),
    ...localizedDescription('command.rules.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
    options: [{
      type: ApplicationCommandOptionType.String,
      ...localizedName('command.rules.option.rule.name'),
      ...localizedDescription('command.rules.option.rule.description'),
      autocomplete: true,
    }],
  }],
  setup: [{
    type: ApplicationCommandOptionType.SubcommandGroup,
    ...localizedName('command.setup.rules.name'),
    ...localizedDescription('command.setup.rules.description'),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.rules.add.name'),
        ...localizedDescription('command.setup.rules.add.description'),
        options: [
          {
            type: ApplicationCommandOptionType.String,
            ...localizedName('command.setup.rules.option.text.name'),
            ...localizedDescription('command.setup.rules.option.text.description'),
            required: true,
            max_length: 1000,
          },
          {
            type: ApplicationCommandOptionType.Boolean,
            ...localizedName('command.setup.rules.option.ping.name'),
            ...localizedDescription('command.setup.rules.option.ping.description'),
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.rules.edit.name'),
        ...localizedDescription('command.setup.rules.edit.description'),
        options: [
          numberOption,
          {
            type: ApplicationCommandOptionType.String,
            ...localizedName('command.setup.rules.option.text.name'),
            ...localizedDescription('command.setup.rules.option.text.description'),
            max_length: 1000,
          },
          {
            type: ApplicationCommandOptionType.Boolean,
            ...localizedName('command.setup.rules.option.ping.name'),
            ...localizedDescription('command.setup.rules.option.ping.description'),
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.rules.remove.name'),
        ...localizedDescription('command.setup.rules.remove.description'),
        options: [numberOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.rules.list.name'),
        ...localizedDescription('command.setup.rules.list.description'),
      },
    ],
  }],
  chat: {
    rules: async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const rules = listRules(interaction.guildId)
      if (rules.length === 0) {
        await interaction.reply({ content: t(locales, 'rules.none'), flags: MessageFlags.Ephemeral })
        return
      }

      const query = interaction.options.getString('rule')?.trim()
      if (!query) {
        await replyInChunks(interaction, [...rules.map(rule => formatRule(rule)), t(locales, 'rules.disclaimer')].join('\n'), true)
        return
      }

      if (/^\d+$/.test(query)) {
        const rule = rules[Number(query) - 1]
        // intentionally non-ephemeral so you can use this to quickly point others to a specific rule
        if (rule) await interaction.reply({ content: formatRule(rule) })
        else await interaction.reply({ content: t(locales, 'rules.missing', { number: query }), flags: MessageFlags.Ephemeral })
        return
      }

      const matches = rules.filter(rule => rule.text.toLowerCase().includes(query.toLowerCase()))
      if (matches.length === 0) {
        await interaction.reply({ content: t(locales, 'rules.no_match', { query: truncate(query, 100) }), flags: MessageFlags.Ephemeral })
        return
      }

      // intentionally non-ephemeral so you can use this to quickly point others to a specific rule or rules
      await replyInChunks(interaction, matches.map(rule => formatRule(rule)).join('\n'))
    },
    'setup rules add': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      addRule(interaction.guildId, interaction.options.getString('rule', true), interaction.options.getBoolean('ping', false) ?? false)
      const number = listRules(interaction.guildId).length
      await interaction.reply({ content: t(locales, 'rules.added', { number }), flags: MessageFlags.Ephemeral })
    },
    'setup rules edit': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const text = interaction.options.getString('rule', false)
      const ping = interaction.options.getBoolean('ping', false)
      if (text == null && ping == null) {
        await interaction.reply({ content: t(locales, 'rules.no_edit'), flags: MessageFlags.Ephemeral })
        return
      }

      const rule = await pickRule(interaction)
      if (!rule) return

      const pingInt = ping ? 1 : 0
      if (text && ping !== null) {
        db().prepare('UPDATE rules SET text = ?, ping = ? WHERE id = ?').run(text, pingInt, rule.id)
      } else if (ping === null) {
        db().prepare('UPDATE rules SET text = ? WHERE id = ?').run(interaction.options.getString('rule', true), rule.id)
      } else {
        db().prepare('UPDATE rules SET ping = ? WHERE id = ?').run(pingInt, rule.id)
      }

      await interaction.reply({ content: t(locales, 'rules.edited', { number: rule.number }), flags: MessageFlags.Ephemeral })
    },
    'setup rules remove': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const rule = await pickRule(interaction)
      if (!rule) return
      db().prepare('DELETE FROM rules WHERE id = ?').run(rule.id)
      await interaction.reply({ content: t(locales, 'rules.removed', { number: rule.number }), flags: MessageFlags.Ephemeral })
    },
    'setup rules list': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const rules = listRules(interaction.guildId)
      if (rules.length === 0) {
        await interaction.reply({ content: t(locales, 'rules.none'), flags: MessageFlags.Ephemeral })
        return
      }
      await replyInChunks(interaction, [...rules.map(rule => formatRule(rule, true)), t(locales, 'rules.ping_legend')].join('\n'), true)
    },
  },
  autocomplete: {
    'rules': suggestRules(true), // TODO is this weird, showing the rules in the autocomplete of a search command?
    'setup rules edit': suggestRules(false),
    'setup rules remove': suggestRules(false),
    'setup rules ping': suggestRules(false),
  },
  forgetGuild: guildId => Number(db().prepare('DELETE FROM rules WHERE guild_id = ?').run(guildId).changes),
}
