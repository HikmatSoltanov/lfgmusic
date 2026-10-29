import { SlashCommandBuilder } from 'discord.js';
export const commands = [
  new SlashCommandBuilder().setName('listen').setDescription('Следовать вашему обычному Spotify-плееру')
    .addSubcommand(s => s.setName('start').setDescription('Следовать песне, позиции и очереди вашего Spotify'))
    .addSubcommand(s => s.setName('stop').setDescription('Завершить прослушивание'))
    .addSubcommand(s => s.setName('status').setDescription('Проверить Spotify, источник аудио и Discord Voice'))
    .addSubcommand(s => s.setName('queue').setDescription('Показать доступную очередь «Далее» Spotify'))
    .addSubcommand(s => s.setName('source').setDescription('Найти и подтвердить аудиоисточник текущей песни')),
  new SlashCommandBuilder().setName('jam').setDescription('Spotify Jam и голосовая сессия')
    .addSubcommand(s => s.setName('start').setDescription('Начать сессию в вашем голосовом канале')
      .addStringOption(o => o.setName('mode').setDescription('Режим (по умолчанию real)').addChoices(
        { name: 'Real Spotify Jam — информация и ссылка', value: 'real' },
        { name: 'Discord Voice Jam — разрешённое локальное аудио', value: 'voice' },
        { name: 'Jam → Voice — точное аудио из разрешённого каталога', value: 'mirror' }))
      .addStringOption(o => o.setName('link').setDescription('Настоящая ссылка приглашения Spotify Jam')))
    .addSubcommand(s => s.setName('link').setDescription('Показать или сохранить приглашение')
      .addStringOption(o => o.setName('url').setDescription('Ссылка, скопированная в официальном Spotify')))
    .addSubcommand(s => s.setName('stop').setDescription('Завершить сессию'))
    .addSubcommand(s => s.setName('status').setDescription('Состояние Spotify и Discord'))
    .addSubcommand(s => s.setName('queue').setDescription('Показать доступную очередь')),
  new SlashCommandBuilder().setName('spotify').setDescription('Личный аккаунт Spotify')
    .addSubcommand(s => s.setName('login').setDescription('Авторизовать свой аккаунт Spotify'))
    .addSubcommand(s => s.setName('confirm').setDescription('Проверить и подтвердить свой Spotify Premium'))
    .addSubcommand(s => s.setName('logout').setDescription('Удалить сохранённую авторизацию')),
  new SlashCommandBuilder().setName('play').setDescription('Добавить разрешённое аудио в очередь Discord')
    .addStringOption(o => o.setName('query').setDescription('ID каталога, точное название или ссылка Spotify-трека').setRequired(true)),
  ...['skip', 'pause', 'resume'].map(name => new SlashCommandBuilder().setName(name).setDescription(
    { skip: 'Пропустить трек Discord', pause: 'Пауза плеера Discord', resume: 'Продолжить плеер Discord' }[name]!))
].map(c => c.toJSON());
