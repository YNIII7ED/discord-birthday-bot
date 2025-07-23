const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/', (req, res) => res.status(200).send('Birthday Bot is running'));

// Проверка переменных окружения
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'CLIENT_ID', 'GUILD_ID'];
if (requiredEnvVars.some(v => !process.env[v])) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// Улучшенное подключение к базе данных с абсолютным путем
const dbPath = path.join(__dirname, 'birthdays.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX, (err) => {
  if (err) {
    console.error('❌ DB Error:', err.message);
    process.exit(1);
  }
  console.log('✅ Database connected at', dbPath);
  
  // Включаем WAL mode для лучшей производительности
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  
  // Создание таблицы с улучшенной структурой
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      birth_date TEXT NOT NULL CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]'),
      guild_id TEXT NOT NULL,
      PRIMARY KEY (user_id, guild_id)
    )
  `, (err) => {
    if (err) {
      console.error('❌ Table creation error:', err.message);
    } else {
      console.log('✅ Table "birthdays" ready');
    }
  });
});

// Команды бота
const commands = [
  {
    name: 'birthday',
    description: 'Управление днями рождения',
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    options: [
      {
        name: 'add',
        description: 'Добавить день рождения',
        type: 1,
        options: [
          {
            name: 'user',
            description: 'Пользователь',
            type: 6,
            required: true
          },
          {
            name: 'date',
            description: 'Дата в формате DD.MM (например 15.05)',
            type: 3,
            required: true,
            min_length: 5,
            max_length: 5
          }
        ]
      },
      {
        name: 'remove',
        description: 'Удалить день рождения',
        type: 1,
        options: [
          {
            name: 'user',
            description: 'Пользователь',
            type: 6,
            required: true
          }
        ]
      },
      {
        name: 'list',
        description: 'Список дней рождения',
        type: 1
      }
    ]
  }
];

// Проверка именинников (в 17:00 по времени сервера)
async function checkBirthdays() {
  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  console.log(`[${new Date().toLocaleString()}] Проверка именинников на ${today}`);

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel?.isTextBased()) {
      console.error('❌ Канал не найден или не текстовый');
      return;
    }

    const birthdays = await new Promise((resolve) => {
      db.all(
        "SELECT user_id, username FROM birthdays WHERE birth_date = ? AND guild_id = ?", 
        [today, channel.guild.id], 
        (err, rows) => {
          if (err) {
            console.error('❌ Ошибка запроса:', err.message);
            return resolve([]);
          }
          resolve(rows || []);
        }
      );
    });

    if (birthdays.length === 0) {
      console.log('ℹ️ Сегодня нет именинников');
      return;
    }

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

// Регистрация команд
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    console.log('🔄 Регистрация команд...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Команды зарегистрированы');
  } catch (error) {
    console.error('❌ Ошибка регистрации команд:', error);
  }
}

// Улучшенный обработчик команд
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Обработка только команд birthday
  if (interaction.commandName !== 'birthday') return;

  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  try {
    // Проверка прав администратора
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return await interaction.reply({
        content: '❌ Только для администраторов!',
        ephemeral: true
      });
    }

    // Отложенный ответ с таймаутом 15 минут
    await interaction.deferReply({ ephemeral: true });

    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        // Проверка формата даты
        if (!/^\d{2}\.\d{2}$/.test(date)) {
          return await interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)');
        }

        try {
          await new Promise((resolve, reject) => {
            db.run(
              `INSERT OR REPLACE INTO birthdays (user_id, username, birth_date, guild_id) 
               VALUES (?, ?, ?, ?)`,
              [user.id, user.username, date, guildId],
              function(err) {
                if (err) return reject(err);
                resolve();
              }
            );
          });
          
          await interaction.editReply(`✅ <@${user.id}> добавлен (${date})`);
        } catch (error) {
          console.error('❌ Ошибка добавления:', error);
          await interaction.editReply('⚠️ Ошибка при добавлении в базу данных');
        }
        break;
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        
        try {
          const result = await new Promise((resolve, reject) => {
            db.run(
              "DELETE FROM birthdays WHERE user_id = ? AND guild_id = ?",
              [user.id, guildId],
              function(err) {
                if (err) return reject(err);
                resolve(this.changes);
              }
            );
          });

          const message = result > 0 
            ? `✅ <@${user.id}> удален` 
            : '❌ Пользователь не найден';
          await interaction.editReply(message);
        } catch (error) {
          console.error('❌ Ошибка удаления:', error);
          await interaction.editReply('⚠️ Ошибка при удалении из базы данных');
        }
        break;
      }

      case 'list': {
        try {
          const rows = await new Promise((resolve, reject) => {
            db.all(
              "SELECT * FROM birthdays WHERE guild_id = ? ORDER BY birth_date",
              [guildId],
              (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
              }
            );
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
        } catch (error) {
          console.error('❌ Ошибка запроса списка:', error);
          await interaction.editReply('⚠️ Ошибка при получении списка');
        }
        break;
      }
    }
  } catch (error) {
    console.error('❌ Ошибка обработки команды:', error);
    try {
      // Пытаемся отправить сообщение об ошибке разными способами
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('⚠️ Произошла непредвиденная ошибка');
      } else {
        await interaction.reply({
          content: '⚠️ Произошла непредвиденная ошибка',
          ephemeral: true
        });
      }
    } catch (err) {
      console.error('❌ Ошибка при отправке сообщения об ошибке:', err);
    }
  }
});

// Запуск бота
client.on('ready', () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  
  // Проверка каждый день в 17:00 по времени сервера (14:00 UTC)
  cron.schedule('00 21 * * *', checkBirthdays, {
    timezone: 'UTC',
    runOnInit: true // Проверка при старте
  });
});

// Обработка ошибок
process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  registerCommands();
  client.login(process.env.BOT_TOKEN).catch(error => {
    console.error('❌ Ошибка входа бота:', error);
    process.exit(1);
  });
});
