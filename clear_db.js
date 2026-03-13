// Автор: Полевой Сергей

const fs = require('fs');
const path = require('path');

const files = ['users.db', 'messages.db', 'settings.db'];

console.log('--- Очистка баз данных ---');

files.forEach(file => {
    const filePath = path.join(__dirname, file);
    
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`✅ Удален: ${file}`);
    } else {
        console.log(`ℹ️  Не найден (уже удален): ${file}`);
    }
});

console.log('--- Готово. Теперь перезагрузите сервер (touch tmp/restart.txt) ---');
console.log('--- Первый зарегистрировавшийся пользователь снова станет Админом. ---');