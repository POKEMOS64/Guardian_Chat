const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const path = require('path');

// Подключаемся к базе данных пользователей
const usersDb = Datastore.create({ filename: path.join(__dirname, 'users.db'), autoload: true });

async function run() {
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log('⚠️  Использование: node reset_password.js <ЛОГИН> <НОВЫЙ_ПАРОЛЬ>');
        process.exit(1);
    }

    const username = args[0];
    const password = args[1];

    console.log(`🔍 Ищем пользователя "${username}"...`);
    const user = await usersDb.findOne({ username });

    if (!user) {
        console.log(`❌ Ошибка: Пользователь "${username}" не найден.`);
        process.exit(1);
    }

    const hash = bcrypt.hashSync(password, 8);
    await usersDb.update({ _id: user._id }, { $set: { password_hash: hash } });

    console.log(`✅ Успешно! Новый пароль для "${username}" установлен.`);
}

run();