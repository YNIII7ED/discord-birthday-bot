const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, InteractionResponse } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.status(200).send('Birthday Bot Online'));

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
const db = new sqlite3.Database('./birthdays.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('❌ DB Error:', err.message);
    process.exit(1);
  }
  console.log('✅ Database connected');
  db.run('PRAGMA journal_mode = WAL');
});

// Создание таблицы
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
  `);
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

// Проверка именинников
async function checkBirthdays() {
  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  console.log(`🔍 Checking birthdays for ${today}`);

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const birthdays = await new Promise((resolve) => {
      db.all("SELECT user_id, username FROM birthdays WHERE birth_date = ?", [today], (err, rows) => {
        resolve(err ? [] : rows || []);
      });
    });

    for (const user of birthdays) {
      try {
        await channel.send(`🎉 **Happy Birthday <@${user.user_id}>!** 🎂`);
        console.log(`✅ Congratulated: ${user.username}`);
      } catch (error) {
        console.error(`❌ Error sending to ${user.username}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Birthday check error:', error);
  }
}

// Регистрация команд
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    console.log('🔄 Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands registered');
  } catch (error) {
    console.error('❌ Command registration error:', error);
  }
}

// Обработчик взаимодействий
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    // Проверка прав администратора
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return await interaction.reply({
        content: '❌ Только для администраторов!',
        flags: InteractionResponse.Flags.Ephemeral
      });
    }

    // Отложенный ответ
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        if (!/^\d{2}\.\d{2}$/.test(date)) {
          return await interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)');
        }

        const result = await new Promise((resolve, reject) => {
          db.run(
            "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
            [user.id, user.tag, date],
            function(err) {
              if (err) reject(err);
              else resolve(this.changes);
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
            ? `✅ <@${user.id}> удален` 
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
    console.error('❌ Command error:', error);
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
      console.error('Failed to send error message:', err);
    }
  }
});

// Запуск
client.on('ready', () => {
  console.log(`🤖 ${client.user.tag} ready!`);
  cron.schedule('0 21 * * *', checkBirthdays, { timezone: 'UTC' });
});

// Обработка ошибок
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  registerCommands();
  client.login(process.env.BOT_TOKEN).catch(console.error);
});
