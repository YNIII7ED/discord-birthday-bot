const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Веб-сервер для пинга
app.get('/', (req, res) => res.send('Bot is alive!'));

// Проверка переменных окружения
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'CLIENT_ID', 'GUILD_ID'];
if (requiredEnvVars.some(v => !process.env[v])) {
  console.error('❌ Отсутствуют переменные окружения!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// База данных SQLite
const db = new sqlite3.Database('./birthdays.db', (err) => {
  if (err) console.error('❌ Ошибка БД:', err);
  else console.log('✅ База данных подключена');
});

// Создаем таблицу дней рождений
db.run(`
  CREATE TABLE IF NOT EXISTS birthdays (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
  )
`);

// Проверка именинников
async function checkBirthdays() {
  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  console.log(`🔍 Проверка именинников на ${today}`);

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const birthdays = await new Promise((resolve) => {
      db.all("SELECT user_id, username FROM birthdays WHERE birth_date = ?", [today], (err, rows) => {
        resolve(err ? [] : rows || []);
      });
    });

    for (const user of birthdays) {
      await channel.send(`🎉 **С Днём Рождения, <@${user.user_id}>!** 🎂`);
      console.log(`✅ Поздравлен: ${user.username}`);
    }
  } catch (err) {
    console.error('❌ Ошибка проверки:', err);
  }
}

// Запуск бота
client.on('ready', () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  // Проверка каждый день в 00:00 МСК (21:00 UTC)
  cron.schedule('0 21 * * *', checkBirthdays, { timezone: 'UTC' });
});

// Обработка команд
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  // Только администраторы
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: '❌ Только для администраторов!', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        if (!/^\d{2}\.\d{2}$/.test(date)) {
          return interaction.editReply('❌ Формат: DD.MM (например, 15.05)');
        }

        db.run(
          "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
          [user.id, user.tag, date],
          (err) => interaction.editReply(
            err ? '⚠️ Ошибка БД' : `✅ <@${user.id}> добавлен (${date})`
          )
        );
        break;
      }

      case 'list': {
        db.all("SELECT * FROM birthdays ORDER BY birth_date", (err, rows) => {
          const embed = new EmbedBuilder()
            .setTitle('🎂 Список дней рождения')
            .setColor(0xFFA500)
            .setDescription(
              rows?.length 
                ? rows.map(u => `• <@${u.user_id}> — ${u.birth_date}`).join('\n')
                : 'Список пуст'
            );
          interaction.editReply({ embeds: [embed] });
        });
        break;
      }
    }
  } catch (err) {
    console.error('❌ Ошибка команды:', err);
    interaction.editReply('⚠️ Произошла ошибка');
  }
});

// Запуск сервера и бота
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  client.login(process.env.BOT_TOKEN);
});
