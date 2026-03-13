const fs = require('fs');
const path = require('path');

// Список файлов базы данных
const files = ['users.db', 'messages.db', 'settings.db'];

console.log('--- Начало восстановления баз данных ---');

files.forEach(file => {
    const filePath = path.join(__dirname, file);
    
    // Если файла нет, пропускаем
    if (!fs.existsSync(filePath)) {
        console.log(`[SKIP] ${file} не найден.`);
        return;
    }

    console.log(`[CHECK] Проверка ${file}...`);
    
    try {
        // Читаем файл как текст
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const validLines = [];
        let corruptCount = 0;

        // Проверяем каждую строку
        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed === '') return; // Пустые строки пропускаем, это нормально

            try {
                // Пытаемся разобрать строку как JSON
                JSON.parse(trimmed);
                validLines.push(trimmed);
            } catch (e) {
                console.log(`   -> ⚠️ Ошибка в строке ${index + 1}: удаляем поврежденные данные.`);
                corruptCount++;
            }
        });

        if (corruptCount > 0) {
            // Делаем бэкап перед записью
            fs.copyFileSync(filePath, filePath + '.corrupt.bak');
            console.log(`   -> Бэкап сохранен в ${file}.corrupt.bak`);

            // Перезаписываем файл только валидными строками
            // Добавляем перенос строки в конце, как любит NeDB
            fs.writeFileSync(filePath, validLines.join('\n') + '\n');
            console.log(`   -> ✅ ${file} УСПЕШНО ВОССТАНОВЛЕН (Удалено строк: ${corruptCount})`);
        } else {
            console.log(`   -> ✅ ${file} в порядке.`);
        }

    } catch (err) {
        console.error(`   -> ❌ Ошибка доступа к файлу ${file}:`, err.message);
    }
});

console.log('--- Готово ---');
