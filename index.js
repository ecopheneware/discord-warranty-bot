import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } from 'discord.js';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

const TZ = process.env.TIMEZONE || 'Europe/Berlin';

const db = new Database('./warranty.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS warranties (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  startISO TEXT NOT NULL,
  durationDays INTEGER NOT NULL,
  endISO TEXT NOT NULL,
  channelId TEXT,
  messageId TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|ended
  PRIMARY KEY (guildId, userId)
);
`);

const upsert = db.prepare(`
INSERT INTO warranties (guildId, userId, startISO, durationDays, endISO, channelId, messageId, status)
VALUES (@guildId, @userId, @startISO, @durationDays, @endISO, @channelId, @messageId, @status)
ON CONFLICT(guildId, userId) DO UPDATE SET
  startISO=excluded.startISO,
  durationDays=excluded.durationDays,
  endISO=excluded.endISO,
  channelId=excluded.channelId,
  messageId=excluded.messageId,
  status=excluded.status
`);

const getOne = db.prepare(`SELECT * FROM warranties WHERE guildId=? AND userId=?`);
const getAllActive = db.prepare(`SELECT * FROM warranties WHERE status='active'`);
const setMessageRef = db.prepare(`UPDATE warranties SET channelId=?, messageId=? WHERE guildId=? AND userId=?`);
const setStatus = db.prepare(`UPDATE warranties SET status=? WHERE guildId=? AND userId=?`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function parseDate(input) {
  const candidates = [
    DateTime.fromFormat(input, 'M/d/yy', { zone: TZ }),
    DateTime.fromFormat(input, 'M/d/yyyy', { zone: TZ }),
    DateTime.fromFormat(input, 'yyyy-MM-dd', { zone: TZ }),
    DateTime.fromFormat(input, 'yyyy-MM-dd HH:mm', { zone: TZ }),
    DateTime.fromFormat(input, 'dd.MM.yyyy', { zone: TZ }),
    DateTime.fromISO(input, { zone: TZ })
  ].filter(dt => dt.isValid);

  if (candidates.length) return candidates[0];
  return null;
}

function fmt(dt) {
  return dt.setZone(TZ).toFormat("yyyy-LL-dd HH:mm '("+TZ+")'");
}

function humanDiff(now, end) {
  if (end <= now) return 'Expired';
  const diff = end.diff(now, ['days', 'hours', 'minutes', 'seconds']).toObject();
  const d = Math.floor(diff.days ?? 0);
  const h = Math.floor(diff.hours ?? 0);
  const m = Math.floor(diff.minutes ?? 0);
  return `${d}d ${h}h ${m}m`;
}

function buildEmbed({ userTag, start, end, durationDays, isExpired }) {
  const now = DateTime.now().setZone(TZ);
  const remaining = isExpired ? 'Expired' : humanDiff(now, end);

  return new EmbedBuilder()
    .setTitle('Warranty Countdown')
    .setDescription(`Tracking warranty for **${userTag}**`)
    .addFields(
      { name: 'Start', value: fmt(start), inline: true },
      { name: 'End', value: fmt(end), inline: true },
      { name: 'Duration', value: `${durationDays} days`, inline: true },
      { name: 'Time Left', value: remaining, inline: true }
    )
    .setColor(isExpired ? 0xE53935 : 0x2E7D32)
    .setTimestamp();
}

async function postOrUpdateMessage(record) {
  // Skip if we don't have a channel/message yet; creation happens on /warrantystart
  if (!record.channelId || !record.messageId) return;

  const channel = await client.channels.fetch(record.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const msg = await channel.messages.fetch(record.messageId).catch(() => null);
  const start = DateTime.fromISO(record.startISO, { zone: TZ });
  const end = DateTime.fromISO(record.endISO, { zone: TZ });
  const isExpired = DateTime.now().setZone(TZ) >= end;

  const userTag = `<@${record.userId}>`;
  const embed = buildEmbed({
    userTag,
    start,
    end,
    durationDays: record.durationDays,
    isExpired
  });

  if (msg) {
    await msg.edit({ embeds: [embed] }).catch(() => {});
  } else {
    // Message was deleted; try to recreate
    const newMsg = await channel.send({ content: userTag, embeds: [embed] }).catch(() => null);
    if (newMsg) {
      setMessageRef.run(newMsg.channelId, newMsg.id, record.guildId, record.userId);
    }
  }

  if (isExpired && record.status !== 'ended') {
    setStatus.run('ended', record.guildId, record.userId);
  }
}

async function tick() {
  const rows = getAllActive.all();
  for (const r of rows) {
    await postOrUpdateMessage(r);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Update every minute (safe for small/medium guilds)
  setInterval(tick, 60 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'warrantystart') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server to use this.', ephemeral: true });
    }

    const datestart = interaction.options.getString('datestart', true).trim();
    const duration = interaction.options.getInteger('duration', true);
    const user = interaction.options.getUser('user', true);

    if (duration <= 0) {
      return interaction.reply({ content: 'Duration must be a positive number of days.', ephemeral: true });
    }

    const parsed = parseDate(datestart);
    if (!parsed) {
      return interaction.reply({ content: 'Invalid date. Try formats like `8/21/25`, `2025-08-21`, `21.08.2025`, or add a time like `2025-08-21 14:30`.', ephemeral: true });
    }

    const start = parsed; // can be past or future
    const end = start.plus({ days: duration });

    const payload = {
      guildId: interaction.guildId,
      userId: user.id,
      startISO: start.toISO(),
      durationDays: duration,
      endISO: end.toISO(),
      channelId: interaction.channelId,
      messageId: null,
      status: 'active'
    };

    upsert.run(payload);

    const embed = buildEmbed({
      userTag: `${user.tag}`,
      start,
      end,
      durationDays: duration,
      isExpired: DateTime.now().setZone(TZ) >= end
    });

    const sent = await interaction.channel.send({ content: `<@${user.id}>`, embeds: [embed] });
    setMessageRef.run(sent.channelId, sent.id, interaction.guildId, user.id);

    return interaction.reply({ content: `Started/updated warranty for <@${user.id}> (${duration} days from ${fmt(start)}).`, ephemeral: true });
  }

  if (interaction.commandName === 'warrantystop') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server to use this.', ephemeral: true });
    }
    const user = interaction.options.getUser('user', true);
    const rec = getOne.get(interaction.guildId, user.id);
    if (!rec) {
      return interaction.reply({ content: 'No warranty found for that user.', ephemeral: true });
    }
    setStatus.run('ended', interaction.guildId, user.id);
    return interaction.reply({ content: `Stopped warranty tracking for <@${user.id}>.`, ephemeral: true });
  }

  if (interaction.commandName === 'warrantyshow') {
    const user = interaction.options.getUser('user', true);
    const rec = getOne.get(interaction.guildId, user.id);
    if (!rec) {
      return interaction.reply({ content: 'No warranty found for that user.', ephemeral: true });
    }

    const start = DateTime.fromISO(rec.startISO, { zone: TZ });
    const end = DateTime.fromISO(rec.endISO, { zone: TZ });
    const embed = buildEmbed({
      userTag: user.tag,
      start,
      end,
      durationDays: rec.durationDays,
      isExpired: DateTime.now().setZone(TZ) >= end
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
