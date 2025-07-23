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

// База данных с улучшенной обработкой ошибок
const db = new sqlite3.Database('./birthdays.db', (err) => {
  if (err) {
    console.error('❌ DB Error:', err.message);
    process.exit(1);
  }
  console.log('✅ Database connected');
  db.run('PRAGMA journal_mode = WAL');
});

// Создание таблицы
db.run(`
  CREATE TABLE IF NOT EXISTS birthdays (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
  )
`);

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
      db.all("SELECT user_id, username FROM birthdays WHERE birth_date = ?", [today], (err, rows) => {
        if (err) {
          console.error('❌ Ошибка запроса:', err.message);
          return resolve([]);
        }
        resolve(rows || []);
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
  if (!interaction.isCommand()) return;

  try {
    // Проверка прав администратора
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return await interaction.reply({
        content: '❌ Только для администраторов!',
        ephemeral: true
      });
    }

    // Отложенный ответ с обработкой ошибок
    await interaction.deferReply({ ephemeral: true }).catch(err => {
      console.error('Ошибка deferReply:', err);
      return;
    });

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        if (!/^\d{2}\.\d{2}$/.test(date)) {
          return await interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)');
        }

        await new Promise((resolve, reject) => {
          db.run(
            "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
            [user.id, user.tag, date],
            function(err) {
              if (err) {
                console.error('Ошибка добавления:', err);
                interaction.editReply('⚠️ Ошибка базы данных').catch(console.error);
                reject(err);
              } else {
                interaction.editReply(`✅ <@${user.id}> добавлен (${date})`).catch(console.error);
                resolve();
              }
            }
          );
        });
        break;
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        
        await new Promise((resolve, reject) => {
          db.run(
            "DELETE FROM birthdays WHERE user_id = ?",
            [user.id],
            function(err) {
              if (err) {
                console.error('Ошибка удаления:', err);
                interaction.editReply('⚠️ Ошибка базы данных').catch(console.error);
                reject(err);
              } else {
                const message = this.changes > 0 
                  ? `✅ <@${user.id}> удален` 
                  : '❌ Пользователь не найден';
                interaction.editReply(message).catch(console.error);
                resolve();
              }
            }
          );
        });
        break;
      }

      case 'list': {
        const rows = await new Promise((resolve) => {
          db.all("SELECT * FROM birthdays ORDER BY birth_date", (err, rows) => {
            if (err) {
              console.error('Ошибка запроса:', err);
              return resolve([]);
            }
            resolve(rows || []);
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
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('⚠️ Произошла ошибка');
      } else {
        await interaction.reply({
          content: '⚠️ Произошла ошибка',
          ephemeral: true
        });
      }
    } catch (err) {
      console.error('Ошибка при отправке сообщения об ошибке:', err);
    }
  }
});

// Запуск бота
client.on('ready', () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  
  // Проверка каждый день в 17:00 по времени сервера (14:00 UTC)
  cron.schedule('10 14 * * *', checkBirthdays, {
    timezone: 'UTC',
    runOnInit: false
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
