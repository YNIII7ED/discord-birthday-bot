const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express');
require('dotenv').config();

// Инициализация Express для Render
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для обработки JSON
app.use(express.json());

// Health check endpoint для Render
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'online',
    bot: client.user?.tag || 'starting...'
  });
});

// Проверка переменных окружения
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'CLIENT_ID', 'GUILD_ID'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error('❌ Отсутствуют переменные окружения:', missingVars.join(', '));
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  // Уменьшаем таймауты для Render
  rest: {
    timeout: 30000,
    offset: 0
  }
});

// База данных SQLite с улучшенными настройками
const db = new sqlite3.Database('./birthdays.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX, (err) => {
  if (err) {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
  }
  console.log('✅ База данных подключена');
  // Оптимизация для Render
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA busy_timeout = 5000');
});

// Создание таблицы с обработкой ошибок
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      birth_date TEXT CHECK(birth_date GLOB '[0-9][0-9].[0-9][0-9]')
    )
  `, (err) => {
    if (err) {
      console.error('❌ Ошибка создания таблицы:', err.message);
    } else {
      console.log('✅ Таблица birthdays готова');
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
        description: 'Показать все дни рождения',
        type: 1
      }
    ]
  }
];

// Проверка именинников с улучшенной обработкой ошибок
async function checkBirthdays() {
  try {
    const now = new Date();
    const today = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    console.log(`[${now.toLocaleString('ru-RU')}] Проверка именинников...`);

    const channel = await client.channels.fetch(process.env.CHANNEL_ID).catch(console.error);
    if (!channel?.isTextBased()) {
      console.error('❌ Канал не найден или не текстовый');
      return;
    }

    const birthdays = await new Promise((resolve) => {
      db.all(
        "SELECT user_id, username FROM birthdays WHERE birth_date = ?", 
        [today],
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
      console.log('ℹ️ Именинников сегодня нет');
      return;
    }

    // Ограничиваем количество сообщений (не более 1 в секунду)
    for (let i = 0; i < birthdays.length; i++) {
      const user = birthdays[i];
      try {
        await channel.send(`🎉 **С Днём Рождения, <@${user.user_id}>!** 🎂`);
        console.log(`✅ Поздравлен: ${user.username}`);
        if (i < birthdays.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Задержка между сообщениями
        }
      } catch (error) {
        console.error(`❌ Ошибка отправки для ${user.username}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Критическая ошибка в checkBirthdays:', error);
  }
}

// Регистрация команд с повторными попытками
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
    // Повторная попытка через 5 секунд
    setTimeout(registerCommands, 5000);
  }
}

// Улучшенный обработчик команд
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  // Обработка команды в асинхронной функции для корректного отлова ошибок
  const handleCommand = async () => {
    try {
      // Проверка прав администратора
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await interaction.reply({
          content: '❌ Эта команда только для администраторов!',
          ephemeral: true
        }).catch(console.error);
      }

      // Отложенный ответ с обработкой таймаута
      const deferred = interaction.deferReply({ ephemeral: true }).catch(err => {
        console.error('Ошибка deferReply:', err);
        return false;
      });

      if (!deferred) return;

      const subcommand = interaction.options.getSubcommand();

      switch (subcommand) {
        case 'add': {
          const user = interaction.options.getUser('user');
          const date = interaction.options.getString('date');

          if (!/^\d{2}\.\d{2}$/.test(date)) {
            return await interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)').catch(console.error);
          }

          await new Promise((resolve, reject) => {
            db.run(
              "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
              [user.id, user.tag, date],
              function(err) {
                if (err) {
                  console.error('Ошибка добавления в БД:', err);
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
                  console.error('Ошибка удаления из БД:', err);
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
                console.error('Ошибка запроса списка:', err);
                interaction.editReply('⚠️ Ошибка базы данных').catch(console.error);
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
          
          await interaction.editReply({ embeds: [embed] }).catch(console.error);
          break;
        }
      }
    } catch (error) {
      console.error('❌ Необработанная ошибка в команде:', error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: '⚠️ Произошла ошибка', ephemeral: true }).catch(console.error);
        } else {
          await interaction.reply({ content: '⚠️ Произошла ошибка', ephemeral: true }).catch(console.error);
        }
      } catch (err) {
        console.error('Ошибка при отправке сообщения об ошибке:', err);
      }
    }
  };

  // Запускаем обработчик без ожидания для избежания блокировки
  handleCommand();
});

// Запуск бота
client.on('ready', async () => {
  console.log(`🤖 Бот ${client.user.tag} запущен!`);
  
  // Ежедневная проверка в 21:00 UTC (00:00 МСК)
  cron.schedule('0 21 * * *', checkBirthdays, {
    timezone: 'UTC',
    runOnInit: false
  });
  
  // Тестовая проверка (раскомментировать для отладки)
  // setTimeout(checkBirthdays, 5000);
});

// Обработка ошибок
process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

// Запуск сервера и бота
app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  
  // Регистрация команд и логин бота
  registerCommands();
  client.login(process.env.BOT_TOKEN).catch(error => {
    console.error('❌ Ошибка входа бота:', error);
    process.exit(1);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM. Завершение работы...');
  shutdown();
});

process.on('SIGINT', () => {
  console.log('🛑 Получен SIGINT. Завершение работы...');
  shutdown();
});

function shutdown() {
  db.close((err) => {
    if (err) {
      console.error('Ошибка при закрытии БД:', err);
    } else {
      console.log('✅ База данных отключена');
    }
    client.destroy();
    console.log('🤖 Бот отключен');
    process.exit(0);
  });
}
