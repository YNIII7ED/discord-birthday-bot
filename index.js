const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, InteractionResponseFlags } = require('discord.js');
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
  db.configure("busyTimeout", 5000);
});

// Создание таблицы
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
    )
  `);
});

// Проверка именинников (остается без изменений)
async function checkBirthdays() {
  // ... (прежний код)
}

// Обработка команд
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    // Только администраторы
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: '❌ Только для администраторов!',
        flags: InteractionResponseFlags.Ephemeral
      });
    }

    // Отвечаем немедленно с флагом EPHEMERAL
    await interaction.deferReply({ flags: InteractionResponseFlags.Ephemeral });
    
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'add': {
        // ... (прежний код добавления)
        break;
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        
        try {
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

          await interaction.editReply({
            content: result > 0 
              ? `✅ <@${user.id}> удален из списка` 
              : '❌ Пользователь не найден',
            flags: InteractionResponseFlags.Ephemeral
          });
        } catch (error) {
          console.error('Ошибка удаления:', error);
          await interaction.editReply({
            content: '⚠️ Ошибка при удалении',
            flags: InteractionResponseFlags.Ephemeral
          });
        }
        break;
      }

      case 'list': {
        // ... (прежний код списка)
        break;
      }
    }
  } catch (error) {
    console.error('Ошибка обработки команды:', error);
    if (!interaction.replied) {
      await interaction.followUp({
        content: '⚠️ Произошла ошибка',
        flags: InteractionResponseFlags.Ephemeral
      });
    }
  }
});

// Остальной код (запуск бота, обработчики ошибок) остается без изменений
