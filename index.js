const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Веб-сервер для пинга
app.get('/', (req, res) => res.send('Birthday Bot is running!'));

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

// Настройка базы данных
const db = new sqlite3.Database('./birthdays.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
  }
  console.log('✅ База данных подключена');
  db.configure("busyTimeout", 5000); // Таймаут для избежания блокировок
});

// Создание таблицы
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
    )
  `, (err) => {
    if (err) console.error('❌ Ошибка создания таблицы:', err.message);
  });
});

// Проверка именинников
async function checkBirthdays() {
  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  console.log(`[${new Date().toLocaleString()}] Проверка именинников...`);

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const birthdays = await new Promise((resolve) => {
      db.all("SELECT user_id, username FROM birthdays WHERE birth_date = ?", [today], (err, rows) => {
        if (err) {
          console.error('❌ Ошибка запроса:', err.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });

    for (const user of birthdays) {
      try {
        await channel.send(`🎉 **С Днём Рождения, <@${user.user_id}>!** 🎂`);
        console.log(`✅ Поздравлен: ${user.username}`);
      } catch (error) {
        console.error(`❌ Ошибка отправки для ${user.username}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка в checkBirthdays:', error);
  }
}

// Команды бота
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
          return interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)');
        }

        await new Promise((resolve, reject) => {
          db.run(
            "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
            [user.id, user.tag, date],
            function(err) {
              if (err) reject(err);
              else resolve(this.lastID);
            }
          );
        });

        await interaction.editReply(`✅ <@${user.id}> добавлен (${date})`);
        break;
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        
        const result = await new Promise((resolve, reject) => {
          db.run(
            "DELETE FROM birthdays WHERE user_id = ?",
            [user.id],
            function(err) {
              if (err) reject(err);
              else resolve(this.changes);
            }
          );
        });

        await interaction.editReply(
          result > 0 
            ? `✅ <@${user.id}> удален из списка` 
            : '❌ Пользователь не найден'
        );
        break;
      }

      case 'list': {
        const rows = await new Promise((resolve) => {
          db.all("SELECT * FROM birthdays ORDER BY birth_date", (err, rows) => {
            resolve(err ? [] : rows || []);
          });
        });

        const embed = new EmbedBuilder()
          .setTitle('🎂 Список дней рождения')
          .setColor(0xFFA500)
          .setDescription(
            rows.length 
              ? rows.map(u => `• <@${u.user_id}> — ${u.birth_date}`).join('\n')
              : 'Список пуст'
          );

        await interaction.editReply({ embeds: [embed] });
        break;
      }
    }
  } catch (error) {
    console.error('❌ Ошибка команды:', error);
    await interaction.editReply('⚠️ Произошла ошибка');
  }
});

// Запуск
client.on('ready', () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  // Проверка каждый день в 00:00 МСК (21:00 UTC)
  cron.schedule('0 21 * * *', checkBirthdays, { timezone: 'UTC' });
});

// Обработка ошибок
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

// Запуск сервера и бота
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  client.login(process.env.BOT_TOKEN).catch(console.error);
});
