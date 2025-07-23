const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express');
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

// Улучшенное подключение к базе данных
const db = new sqlite3.Database('./birthdays.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('❌ DB Error:', err.message);
    process.exit(1);
  }
  console.log('✅ Database connected');
  db.run('PRAGMA journal_mode = WAL');
  
  // Создание таблицы с улучшенной структурой
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]'),
      guild_id TEXT
    )
  `, (err) => {
    if (err) console.error('❌ Table creation error:', err.message);
  });
});

// Команды бота (оставляем без изменений)
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

// Регистрация команд (без изменений)
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

// Улучшенный обработчик команд с исправленными ошибками взаимодействий
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // Проверка прав администратора
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return await interaction.reply({
        content: '❌ Только для администраторов!',
        ephemeral: true
      });
    }

    // Отложенный ответ для предотвращения таймаутов
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        // Улучшенная проверка формата даты
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
      await interaction.editReply('⚠️ Произошла непредвиденная ошибка');
    } catch (err) {
      console.error('❌ Ошибка при отправке сообщения об ошибке:', err);
    }
  }
});

// Запуск бота (без изменений)
client.on('ready', () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  
  // Проверка каждый день в 17:00 по времени сервера (14:00 UTC)
  cron.schedule('12 14 * * *', checkBirthdays, {
    timezone: 'UTC',
    runOnInit: false
  });
});

// Обработка ошибок (без изменений)
process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

// Запуск сервера (без изменений)
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  registerCommands();
  client.login(process.env.BOT_TOKEN).catch(error => {
    console.error('❌ Ошибка входа бота:', error);
    process.exit(1);
  });
});
