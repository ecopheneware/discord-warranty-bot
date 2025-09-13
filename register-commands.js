import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('warrantystart')
    .setDescription('Start or replace a warranty countdown for a user')
    .addStringOption(o => o.setName('datestart').setDescription('Start date (e.g. 8/21/25, 2025-08-21 14:30, 21.08.2025)').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in days (e.g. 180)').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('User to track').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('warrantystop')
    .setDescription('Stop tracking a user’s warranty countdown')
    .addUserOption(o => o.setName('user').setDescription('User to stop tracking').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('warrantyshow')
    .setDescription('Show remaining time for a user’s warranty')
    .addUserOption(o => o.setName('user').setDescription('User to show').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands((await rest.get(Routes.oauth2CurrentApplication()))?.id, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('Slash commands registered to guild:', process.env.GUILD_ID);
})();
