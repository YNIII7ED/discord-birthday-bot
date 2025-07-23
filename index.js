const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express'); // Для работы 24/7 в Replit
require('dotenv').config();

// Инициализация Express для Replit
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Birthday Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
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
  ]
});

// База данных SQLite
const db = new sqlite3.Database('./birthdays.db', (err) => {
  if (err) {
    console.error('❌ Ошибка подключения к БД:', err.message);
    process.exit(1);
  }
  console.log('✅ База данных подключена');
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

// Команды бота
const commands = [
  {
    name: 'birthday',
    description: 'Управление днями рождения (только для админов)',
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

// Проверка именинников
async function checkBirthdays() {
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  console.log(`[${now.toLocaleString('ru-RU')}] Проверка именинников...`);

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
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

// Обработчики событий
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    // Проверка прав администратора
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: '❌ Эта команда только для администраторов!',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'add': {
        const user = interaction.options.getUser('user');
        const date = interaction.options.getString('date');

        if (!/^\d{2}\.\d{2}$/.test(date)) {
          return interaction.editReply('❌ Используйте формат DD.MM (например: 15.05)');
        }

        db.run(
          "INSERT OR REPLACE INTO birthdays VALUES (?, ?, ?)",
          [user.id, user.tag, date],
          function(err) {
            interaction.editReply(
              err 
                ? '⚠️ Ошибка базы данных'
                : `✅ <@${user.id}> добавлен (${date})`
            );
          }
        );
        break;
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        
        db.run(
          "DELETE FROM birthdays WHERE user_id = ?",
          [user.id],
          function(err) {
            interaction.editReply(
              err
                ? '⚠️ Ошибка базы данных'
                : this.changes > 0
                  ? `✅ <@${user.id}> удален`
                  : '❌ Пользователь не найден'
            );
          }
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
  } catch (error) {
    console.error('❌ Ошибка команды:', error);
    interaction.editReply('⚠️ Произошла ошибка');
  }
});

// Запуск бота
(async () => {
  try {
    await registerCommands();
    await client.login(process.env.BOT_TOKEN);
  } catch (error) {
    console.error('❌ Ошибка запуска:', error);
    process.exit(1);
  }
})();

// Обработка завершения
process.on('SIGINT', () => {
  db.close();
  client.destroy();
  console.log('🛑 Бот завершает работу');
  process.exit();
});
