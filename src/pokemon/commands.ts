import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  MessagePayload,
  TimestampStyles,
  escapeMarkdown,
  time,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from 'discord.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { formatNumber, t } from '../i18n.js'
import { randomItem, seededRng } from '../random.js'
import { getDex, loadedDex, startDex, statName, typeName, type Dex, type PokemonEntry } from './dex.js'
import { getSprite } from './sprites.js'
import { getStore } from './storage.js'
import { describeVariant, rollVariant, variantCount, type Variant } from './variants.js'

/** Pokémon available per channel per hour */
const POOL_SIZE = 20
/** Re-rolls allowed per catch attempt */
const CATCH_ATTEMPTS = 3
const CATCH_COOLDOWN = 60_000
const LEADERBOARD_SIZE = 10

const HOUR_MILLIS = 60 * 60 * 1000
const POKEMON_RED = 0xf93d32

const currentHour = () => Math.floor(Date.now() / HOUR_MILLIS)

/** Fetches the Pokémon available in this channel at this unix hour */
const poolFor = (dex: Dex, channelId: string, hour: number): number[] => {
  const rng = seededRng(channelId, hour)
  const size = Math.min(POOL_SIZE, dex.ids.length)
  const pool = new Set<number>()

  for (let spins = 0; pool.size < size && spins < size * 100; spins++) {
    pool.add(randomItem(dex.ids, rng))
  }

  return [...pool]
}

const baseEmbed = (interaction: ChatInputCommandInteraction) => {
  const embed = new EmbedBuilder()
    .setTimestamp(interaction.createdAt)
    .setAuthor({
      name: interaction.user.displayName,
      iconURL: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
    })

  const channel = interaction.channel
  if (channel && 'name' in channel && typeof channel.name === 'string') {
    embed.setFooter({ text: `#${channel.name}` })
  }

  return embed
}

/** Attaches the sprite to the embed, or reports that there isn't one */
const attachSprite = async (embed: EmbedBuilder, entry: PokemonEntry, variant: Variant) => {
  const sprite = await getSprite(entry, variant)
  if (!sprite) return []

  embed.setImage(`attachment://${sprite.name}`)
  return [new AttachmentBuilder(sprite.path, { name: sprite.name })]
}

export const handlePokemonSearch = async (interaction: ChatInputCommandInteraction) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const query = interaction.options.getString('pokemon', true)

  // avoid immediately deferring unless we haven't loaded the dex yet
  let dex = loadedDex()
  if (!dex) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    dex = await getDex()
  }

  const entry = dex.find(query)
  if (!entry) {
    const content = t(locales, 'pokemon.search.not_found', { query: escapeMarkdown(query) })
    if (interaction.deferred) await interaction.editReply({ content })
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    return
  }

  // now that we know the input is valid we can defer publicly (if we didn't defer yet)
  const deferredPrivately = interaction.deferred
  if (!deferredPrivately) await interaction.deferReply()

  const variant = rollVariant(entry)
  const embed = baseEmbed(interaction)
    .setColor(POKEMON_RED)
    .setTitle(describeVariant(entry, variant, locales))

  if (entry.types.length > 0) {
    embed.addFields({ name: t(locales, 'pokemon.search.types'), value: entry.types.map(type => typeName(type, locales)).join(' / '), inline: true })
  }

  if (entry.stats.length > 0) {
    const total = entry.stats.reduce((sum, stat) => sum + stat.value, 0)
    embed.addFields({
      name: t(locales, 'pokemon.search.stats'),
      value: [...entry.stats, { name: t(locales, 'pokemon.stat.total'), value: total }]
        .map(stat => t(locales, 'pokemon.search.stat_line', { stat: statName(stat.name, locales), value: stat.value })).join(' · '),
    })
  }

  const files = await attachSprite(embed, entry, variant)
  if (files.length === 0) embed.setDescription(t(locales, 'pokemon.search.no_sprite'))

  const payload = { embeds: [embed], files } satisfies InteractionReplyOptions | InteractionEditReplyOptions
  if (deferredPrivately) {
    // can't just go un-ephemeral so we need to make a new reply
    await interaction.deleteReply()
    await interaction.followUp(payload)
  } else {
    await interaction.editReply(payload)
  }
}

export const handlePokemonCatch = async (interaction: ChatInputCommandInteraction) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const store = getStore()
  const userId = interaction.user.id

  const lastCatch = store.lastCatchAt(userId)
  if (lastCatch !== null && Date.now() - lastCatch < CATCH_COOLDOWN) {
    await interaction.reply({
      content: t(locales, 'pokemon.catch.cooldown', { time: time(new Date(lastCatch + CATCH_COOLDOWN), TimestampStyles.RelativeTime) }),
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  // claim the cooldown immediately to avoid attempts to spam for more pokemon
  store.setLastCatchAt(userId, Date.now())

  await interaction.deferReply()
  const dex = await getDex()
  store.rememberTrainer(userId, interaction.user.displayName)

  const pool = poolFor(dex, interaction.channelId, currentHour())

  // re-roll if the pokémon variant was already caught
  let entry!: PokemonEntry
  let variant!: Variant
  let isNew = false
  for (let attempt = 0; attempt < CATCH_ATTEMPTS && !isNew; attempt++) {
    entry = dex.get(randomItem(pool))!
    variant = rollVariant(entry)
    isNew = !store.hasCaught(userId, entry.id, variant)
  }

  if (isNew) store.addCatch(userId, entry.id, variant)

  const poolVariants = pool.reduce((sum, id) => sum + variantCount(dex.get(id)!), 0)
  const caughtEverything = store.countAmong(userId, pool) >= poolVariants

  const description = [
    t(locales, isNew ? 'pokemon.catch.new' : 'pokemon.catch.old'),
    ...(caughtEverything ? [t(locales, 'pokemon.catch.all_caught')] : []),
  ].join('\n\n')

  const embed = baseEmbed(interaction)
    .setColor(isNew ? Colors.Green : Colors.DarkGreen)
    .setTitle(t(locales, 'pokemon.catch.title', { pokemon: describeVariant(entry, variant, locales) }))
    .setDescription(description)

  const files = await attachSprite(embed, entry, variant)

  await interaction.editReply({ embeds: [embed], files })
}

export const handlePokemonLeaderboard = async (interaction: ChatInputCommandInteraction) => {
  const locales = [interaction.locale, interaction.guildLocale]
  await interaction.deferReply()

  const dex = await getDex()
  const store = getStore()
  const rows = store.leaderboard()

  const embed = baseEmbed(interaction)
    .setColor(POKEMON_RED)
    .setTitle(t(locales, 'pokemon.leaderboard.title'))
    .setFooter({ text: t(locales, 'pokemon.leaderboard.footer', { count: dex.totalVariants, total: formatNumber(locales, dex.totalVariants) }) })

  if (rows.length === 0) {
    embed.setDescription(t(locales, 'pokemon.leaderboard.empty'))
    await interaction.editReply({ embeds: [embed] })
    return
  }

  const percent = (count: number) =>
    formatNumber(locales, Math.min(count, dex.totalVariants) / dex.totalVariants, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const nameFor = (userId: string, cached: string | null) => {
    const known = interaction.client.users.cache.get(userId)?.displayName ?? cached
    return escapeMarkdown(known ?? userId)
  }

  // trainers on the same score share a rank
  const ranks = new Map<string, number>()
  let rank = 0
  let previous = -1
  rows.forEach((row, index) => {
    if (row.count !== previous) rank = index + 1
    previous = row.count
    ranks.set(row.userId, rank)
  })

  const line = (row: (typeof rows)[number]) => t(locales, 'pokemon.leaderboard.line', {
    rank: String(ranks.get(row.userId)).padStart(2),
    name: nameFor(row.userId, row.name),
    count: formatNumber(locales, row.count),
    percent: percent(row.count),
  })

  const top = rows.slice(0, LEADERBOARD_SIZE)
  const lines = top.map(line)

  // if the requester didn't place, show them below the cut anyway
  if (!top.some(row => row.userId === interaction.user.id)) {
    const own = rows.find(row => row.userId === interaction.user.id)
    if (own) lines.push('...', line(own))
  }

  embed.setDescription(lines.join('\n'))
  await interaction.editReply({ embeds: [embed] })
}

export const pokemonFeature: Feature = {
  commands: [{
    ...localizedName('command.pokemon.name'),
    ...localizedDescription('command.pokemon.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
    options: [
      {
        ...localizedName('command.pokemon.catch.name'),
        ...localizedDescription('command.pokemon.catch.description'),
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        ...localizedName('command.pokemon.leaderboard.name'),
        ...localizedDescription('command.pokemon.leaderboard.description'),
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        ...localizedName('command.pokemon.search.name'),
        ...localizedDescription('command.pokemon.search.description'),
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            ...localizedName('command.pokemon.search.option.pokemon.name'),
            ...localizedDescription('command.pokemon.search.option.pokemon.description'),
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ],
  }],
  chat: {
    'pokemon catch': handlePokemonCatch,
    'pokemon leaderboard': handlePokemonLeaderboard,
    'pokemon search': handlePokemonSearch,
  },
  attach() {
    // download pokedex in the background
    startDex()
      .then(dex => console.log(`Loaded ${dex.entries.size} Pokémon (${dex.totalVariants} variants)`))
      .catch(error => console.error('Pokémon startup failed:', error))
  },
  forgetUser: userId => getStore().forget(userId),
}
