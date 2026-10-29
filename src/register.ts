import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';
if (!config.discordToken || !/^\d+$/.test(config.clientId)) throw new Error('Заполните DISCORD_TOKEN и DISCORD_CLIENT_ID в .env');
try {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId), { body: commands });
  console.log(`Зарегистрировано ${commands.length} команд (${config.guildId ? 'тестовый сервер' : 'глобально'}).`);
} catch { console.error('Регистрация не удалась. Проверьте токен, Application ID, Guild ID и доступ к Discord.'); process.exitCode = 1; }
