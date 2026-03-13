const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { pipeline } = require('stream'); // Подключаем pipeline
const util = require('util'); // Добавляем модуль утилит
const { Server } = require("socket.io");
const webPush = require('web-push');

// --- PUSH УВЕДОМЛЕНИЯ ---
// Ключи генерируются через: node gen_keys.js
// Их можно вставить сюда вручную или использовать переменные окружения (рекомендуется для хостинга)
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || ''; 
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || '';

if (publicVapidKey.length > 10) { 
    webPush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'), publicVapidKey, privateVapidKey);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000
});

// Создаем промис-версию pipeline для удобного await
const streamPipeline = util.promisify(pipeline);

// Настройки БД: corruptAlertThreshold: 1 позволяет автоматически восстанавливаться
// при повреждении файла (игнорировать битые строки), вместо того чтобы ронять сервер.
const dbOptions = (filename) => ({
    filename: path.join(__dirname, filename),
    autoload: true,
    corruptAlertThreshold: 1
});

const usersDb = Datastore.create(dbOptions('users.db'));
const messagesDb = Datastore.create(dbOptions('messages.db'));
const settingsDb = Datastore.create(dbOptions('settings.db'));
const subscriptionsDb = Datastore.create(dbOptions('subscriptions.db'));

// --- ЛОГИРОВАНИЕ В ФАЙЛ (app.log) ---
const logPath = path.join(__dirname, 'app.log');
const logFile = fs.createWriteStream(logPath, { flags: 'a' });
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
    logFile.write(`[${new Date().toISOString()}] INFO: ${util.format(...args)}\n`);
    originalLog.apply(console, args);
};
console.error = function (...args) {
    logFile.write(`[${new Date().toISOString()}] ERROR: ${util.format(...args)}\n`);
    originalError.apply(console, args);
};

// Создаем папку sessions, если нет (ВАЖНО для session-file-store)
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Настройка хранилища файлов
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Раздача статических файлов (картинок)
app.use(express.static(path.join(__dirname, 'public')));

// Настройка EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const sessionMiddleware = session({
    store: new FileStore({
        path: path.join(__dirname, 'sessions'),
        ttl: 86400 // Время жизни сессии в секундах (24 часа)
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-key-change-this',
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);

// Middleware для проверки авторизации
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        // Если запрос пришел от приложения (ждет JSON) или через AJAX -> возвращаем код ошибки 401
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    next();
}

// Интеграция сессий с Socket.IO
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// Вспомогательная функция для получения групп
async function getGroupNames() {
    const doc = await settingsDb.findOne({ _id: 'groupNames' });
    if (doc && doc.names && Object.keys(doc.names).length > 0) {
        return doc.names;
    }
    // Если групп нет, создаем дефолтные 4 (чтобы не сломать существующее)
    const defaults = { '1': 'Группа 1', '2': 'Группа 2', '3': 'Группа 3', '4': 'Группа 4' };
    await settingsDb.update({ _id: 'groupNames' }, { _id: 'groupNames', names: defaults }, { upsert: true });
    return defaults;
}

// --- Роуты ---

app.get('/', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user) return res.redirect('/logout');
    
    if (!user.is_approved) {
        return res.render('pending');
    }

    // Если админ - ищем ждущих пользователей
    let pendingUsers = [];
    if (user.is_admin) {
        pendingUsers = await usersDb.find({ is_approved: 0 });
    }
    
    // Список собеседников
    let comrades = [];
    let availableGroups = [];
    // Получаем всех одобренных
    const allApproved = await usersDb.find({ is_approved: 1 });
    const groupNames = await getGroupNames();
    const allGroupIds = Object.keys(groupNames).map(Number).sort((a, b) => a - b);

    if (user.is_admin) {
        comrades = allApproved.filter(u => u._id !== user._id);
        availableGroups = allGroupIds;
    } else {
        // Вспомогательная функция для получения массива групп пользователя
        const getGroups = (u) => u.group_ids || (u.group_id ? [u.group_id] : []);
        const myGroups = getGroups(user);
        availableGroups = myGroups.sort((a, b) => a - b);

        comrades = allApproved.filter(u => {
            if (u._id === user._id) return false;
            if (u.is_admin) return true; // Админов видят все
            
            // Проверяем пересечение групп: есть ли хоть одна общая группа
            const theirGroups = getGroups(u);
            return myGroups.some(g => theirGroups.includes(g));
        });
    }

    // Передаем comrades в шаблон
    res.render('index', { 
        user, 
        messages: [], 
        pendingUsers, 
        comrades, 
        availableGroups, groupNames,
        vapidPublicKey: publicVapidKey // Передаем ключ клиенту
    });
});

// Новый роут для загрузки чанков
app.post('/upload_chunk', requireAuth, upload.single('chunk'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No chunk data' });
    }

    const { uploadId, chunkIndex, totalChunks, originalFilename } = req.body;
    const chunk = req.file.buffer;

    // Безопасное имя файла, чтобы избежать выхода из директории
    const safeOriginalFilename = path.basename(originalFilename);
    const tempFilename = `${uploadId}-${safeOriginalFilename}`;
    const tempFilepath = path.join(uploadDir, tempFilename);

    try {
        await fs.promises.appendFile(tempFilepath, chunk);

        if (parseInt(chunkIndex, 10) === parseInt(totalChunks, 10) - 1) {
            // Последний чанк, загрузка завершена
            res.json({ status: 'complete', finalFilename: tempFilename });
        } else {
            // Ожидаем еще чанки
            res.json({ status: 'chunk_received' });
        }
    } catch (e) {
        console.error('Error writing chunk:', e);
        res.status(500).json({ error: 'Error writing chunk' });
    }
});

// Роут подписки на уведомления
app.post('/subscribe', requireAuth, async (req, res) => {
    const subscription = req.body;
    // Сохраняем подписку, привязывая к ID пользователя и уникальному endpoint браузера
    // upsert: true обновит запись, если такой endpoint уже есть
    await subscriptionsDb.update({ endpoint: subscription.endpoint }, { userId: req.session.userId, subscription }, { upsert: true });
    res.status(201).json({});
});

app.post('/send_message', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const user = await usersDb.findOne({ _id: req.session.userId });
        if (!user || !user.is_approved) return res.status(403).json({error: 'Not approved'});
        
        const { content, recipient_id, group_id, file_password, uploaded_filename, reply_to_id } = req.body;
        // Разрешаем отправку, если есть текст ИЛИ файл
        if (!content && !uploaded_filename && !req.file) return res.status(400).json({error: 'Empty'});

        // Берем имя файла либо из загруженного напрямую, либо из чанка
        let filename = req.file ? req.file.filename : (uploaded_filename || null);
        let is_encrypted = false;

    // --- Логика ответов (Reply) ---
    let reply_to = null;
    if (reply_to_id) {
        const originalMsg = await messagesDb.findOne({ _id: reply_to_id });
        if (originalMsg) {
            const originalUser = await usersDb.findOne({ _id: originalMsg.user_id });
            reply_to = {
                id: originalMsg._id,
                user: originalUser ? originalUser.username : 'Unknown',
                content: originalMsg.content,
                filename: originalMsg.filename
            };
        }
    }

        // --- Логика шифрования ---
        if (filename && file_password) {
            try {
                const inputPath = path.join(uploadDir, filename);
                const outputPath = inputPath + '.enc';
                
                // 1. Создаем соль и ключ из пароля
                const algorithm = 'aes-256-ctr';
                const salt = crypto.randomBytes(16);
                
                // Асинхронная генерация ключа
                const key = await new Promise((resolve, reject) => {
                    crypto.scrypt(file_password, salt, 32, (err, derivedKey) => {
                        if (err) reject(err); else resolve(derivedKey);
                    });
                });
                const iv = crypto.randomBytes(16);
                
                // 2. Шифруем
                const cipher = crypto.createCipheriv(algorithm, key, iv);
                const input = fs.createReadStream(inputPath);
                const output = fs.createWriteStream(outputPath);

                output.write(salt);
                output.write(iv);

                // Используем pipeline для безопасного шифрования (авто-закрытие потоков)
                await streamPipeline(input, cipher, output);

                fs.unlinkSync(inputPath);
                filename = filename + '.enc';
                is_encrypted = true;
            } catch (err) {
                console.error('Encryption error:', err);
                return res.status(500).json({error: 'Encryption failed'});
            }
        }

        const msg = {
            content,
            user_id: user._id,
            timestamp: new Date(),
            recipient_id: recipient_id || null, 
            group_ids: group_id ? [parseInt(group_id)] : [], 
            filename: filename,
        is_encrypted: is_encrypted,
        reply_to: reply_to
        };
        await messagesDb.insert(msg);
        
        // --- Трансляция через WebSocket (в блоке try, чтобы не ронять запрос) ---
        try {
            const date = new Date();
            const timeStr = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
            
            const messageForSocket = {
                user: user.username,
                sender_id: user._id,
                recipient_id: msg.recipient_id,
                group_id: group_id ? parseInt(group_id) : null,
                content: msg.content,
                filename: msg.filename,
                time: timeStr,
                is_mine: false,
                id: msg._id,
            is_encrypted: msg.is_encrypted,
            reply_to: msg.reply_to
            };

            if (recipient_id) {
                io.to(recipient_id).to(user._id).emit('new_message', messageForSocket);
            } else if (group_id) {
                io.to(`group_${group_id}`).emit('new_message', messageForSocket);
            }
        } catch (socketErr) {
            console.error("Socket emission error:", socketErr);
            // Не прерываем запрос, сообщение уже сохранено
        }

        res.json({status: 'ok'});
    } catch (e) {
        console.error('Send message handler error:', e);
        res.status(500).json({error: e.message || 'Server error'});
    }
});

app.post('/delete_message', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    const { id } = req.body;
    
    // Ищем сообщение
    const msg = await messagesDb.findOne({ _id: id });
    if (!msg) return res.status(404).json({error: 'Not found'});

    // Проверка прав: удалять может Админ ИЛИ Автор сообщения
    if (!user.is_admin && msg.user_id !== user._id) {
        return res.status(403).json({error: 'Forbidden'});
    }

    // Если есть прикрепленный файл - удаляем его с диска
    if (msg.filename) {
        const filePath = path.join(uploadDir, msg.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    // Удаляем из базы
    await messagesDb.remove({ _id: id }, {});

    // Уведомляем клиентов об удалении
    io.emit('delete_message', { id });
    res.json({ status: 'ok' });
});

// Роут для безопасного скачивания
app.get('/download_secure', requireAuth, async (req, res) => {
    const { file, password } = req.query;
    const filePath = path.join(uploadDir, file);

    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    try {
        // Читаем файл
        // Первые 16 байт - соль, вторые 16 байт - IV
        const fd = fs.openSync(filePath, 'r');
        const salt = Buffer.alloc(16);
        const iv = Buffer.alloc(16);
        fs.readSync(fd, salt, 0, 16, 0);
        fs.readSync(fd, iv, 0, 16, 16);
        fs.closeSync(fd);

        // Генерируем ключ из введенного пароля и соли из файла
        // Используем асинхронный scrypt, чтобы не вешать сервер при скачивании
        const key = await new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, 32, (err, derivedKey) => {
                if (err) reject(err); else resolve(derivedKey);
            });
        });

        const algorithm = 'aes-256-ctr';
        const decipher = crypto.createDecipheriv(algorithm, key, iv);

        // Стриммим расшифрованный файл пользователю
        const readStream = fs.createReadStream(filePath, { start: 32 }); // Пропускаем соль и IV
        
        // Убираем .enc из имени при скачивании
        const originalName = file.replace('.enc', '');
        res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
        
        readStream.pipe(decipher).pipe(res);

    } catch (e) {
        console.error(e);
        res.status(500).send('Error decrypting');
    }
});

app.get('/get_messages', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_approved) return res.json([]);

    const targetId = req.query.target_id;
    const groupId = req.query.group_id;
    let query = {};
    let bgKey = '';

    // Получаем текущие настройки фонов
    const bgDoc = await settingsDb.findOne({ _id: 'chatBackgrounds' });
    const backgrounds = bgDoc ? bgDoc.values : {};

    if (targetId) {
        // Личная переписка: сообщения от меня к нему ИЛИ от него ко мне
        query = {
            $or: [
                { user_id: req.session.userId, recipient_id: targetId },
                { user_id: targetId, recipient_id: req.session.userId }
            ]
        };
        // Ключ фона для ЛС: сортируем ID, чтобы у обоих был одинаковый ключ (user1_user2)
        const ids = [req.session.userId, targetId].sort();
        bgKey = `dm_${ids[0]}_${ids[1]}`;
    } else if (groupId) {
        // Чат конкретной группы
        // Проверяем доступ (админ или участник группы)
        const myGroups = user.group_ids || (user.group_id ? [user.group_id] : []);
        const gId = parseInt(groupId);
        
        if (user.is_admin || myGroups.includes(gId)) {
            query = { 
                $or: [{ recipient_id: { $exists: false } }, { recipient_id: null }],
                group_ids: gId 
            };
            bgKey = `g_${gId}`;
        } else {
            return res.json([]); // Нет доступа к этой группе
        }
    } else {
        return res.json([]); // "Общего" чата без группы больше нет
    }

    // Получаем сообщения и всех пользователей для отображения имен
    let messages = await messagesDb.find(query).sort({ timestamp: -1 }).limit(50);
    const users = await usersDb.find({});
    const userMap = {};
    users.forEach(u => userMap[u._id] = u.username);

    const data = messages.map(m => {
        // Гарантируем преобразование в Date, даже если в базе строка
        const date = new Date(m.timestamp);
        const timeStr = isNaN(date.getTime()) 
            ? '--:--' 
            : date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
            
        return {
            user: userMap[m.user_id] || 'Unknown',
            content: m.content,
            filename: m.filename, // Передаем имя файла на клиент
            time: timeStr || '..',
            is_mine: m.user_id === req.session.userId,
            id: m._id, // Передаем ID сообщения для удаления
            is_encrypted: m.is_encrypted || false,
            reply_to: m.reply_to || null
        };
    }).reverse();
    
    res.json({
        messages: data,
        background: backgrounds[bgKey] || 'bg-default'
    });
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password, action } = req.body;

    if (action === 'register') {
        const existing = await usersDb.findOne({ username });
        if (existing) return res.render('login', { error: 'Пользователь уже существует' });

        // Проверяем, есть ли вообще пользователи. Если 0 - делаем админом
        const count = await usersDb.count({});
        const isFirst = count === 0;
        const isAdmin = isFirst ? 1 : 0;
        const isApproved = isFirst ? 1 : 0;
        const hash = bcrypt.hashSync(password, 8);

        const newUser = await usersDb.insert({ 
            username, 
            password_hash: hash, 
            is_admin: isAdmin, 
            is_approved: isApproved,
            group_ids: [] // Инициализируем пустой массив групп
        });
        req.session.userId = newUser._id;
        res.redirect('/');
    } else {
        const user = await usersDb.findOne({ username });
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.render('login', { error: 'Неверный логин или пароль' });
        }
        req.session.userId = user._id;
        res.redirect('/');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Одобрение теперь требует указания группы (1 или 2)
app.get('/admin/approve/:id/:group', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (user && user.is_admin) {
        const groupId = parseInt(req.params.group);
        const targetUser = await usersDb.findOne({ _id: req.params.id });
        
        if (targetUser) {
            // Получаем текущие группы или конвертируем старый формат
            let groups = targetUser.group_ids || (targetUser.group_id ? [targetUser.group_id] : []);
            
            // Тоггл: если группа есть - убираем, если нет - добавляем
            if (groups.includes(groupId)) {
                groups = groups.filter(g => g !== groupId);
            } else {
                groups.push(groupId);
            }
            
            // Если групп больше нет, снимаем подтверждение (опционально, но логично)
            // const isApproved = groups.length > 0 ? 1 : 0; 
            // Оставим is_approved=1, чтобы не блокировать полностью, просто без групп он никого не увидит
            
            await usersDb.update({ _id: req.params.id }, { $set: { is_approved: 1, group_ids: groups } });
        }
    }
    res.redirect('/');
});

app.get('/admin/reject/:id', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (user && user.is_admin) {
        await usersDb.remove({ _id: req.params.id }, {});
    }
    res.redirect('/');
});

// --- Новая Админ-панель ---

app.get('/admin', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_admin) return res.redirect('/');
    const groupNames = await getGroupNames();
    const allUsers = await usersDb.find({}).sort({ is_admin: -1, username: 1 });
    res.render('admin', { user, allUsers, groupNames });
});

// Добавление новой группы
app.post('/admin/add_group', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_admin) return res.status(403).send('Access Denied');

    const groupNames = await getGroupNames();
    const ids = Object.keys(groupNames).map(Number);
    const nextId = (ids.length > 0 ? Math.max(...ids) : 0) + 1;
    
    groupNames[nextId] = `Группа ${nextId}`;
    await settingsDb.update({ _id: 'groupNames' }, { $set: { names: groupNames } }, { upsert: true });
    res.redirect('/admin');
});

// Удаление группы
app.get('/admin/delete_group/:id', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_admin) return res.status(403).send('Access Denied');

    const groupNames = await getGroupNames();
    delete groupNames[req.params.id];
    await settingsDb.update({ _id: 'groupNames' }, { $set: { names: groupNames } });
    res.redirect('/admin');
});

app.post('/admin/update_groups', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_admin) return res.status(403).send('Access Denied');

    const { target_user_id, groups } = req.body;
    
    // Преобразуем выбор чекбоксов в массив чисел. Если ничего не выбрано, groups будет undefined
    let newGroups = [];
    if (groups) {
        // Если выбран 1 чекбокс, это строка/число. Если много - массив.
        newGroups = (Array.isArray(groups) ? groups : [groups]).map(Number);
    }
    
    await usersDb.update({ _id: target_user_id }, { $set: { group_ids: newGroups, is_approved: 1 } });
    res.redirect('/admin');
});

app.post('/admin/update_group_names', requireAuth, async (req, res) => {
    const user = await usersDb.findOne({ _id: req.session.userId });
    if (!user || !user.is_admin) return res.status(403).send('Access Denied');

    // req.body будет объектом вида { '1': 'Семья', '2': 'Работа' }
    await settingsDb.update(
        { _id: 'groupNames' }, 
        { _id: 'groupNames', names: req.body }, 
        { upsert: true } // Создать, если не существует
    );
    res.redirect('/admin');
});

// --- Логика Socket.IO ---

// Логирование ошибок на уровне движка
io.engine.on("connection_error", (err) => {
    console.error(`Socket.IO Engine Error: ${err.code} - ${err.message}`);
    console.error(err.context);
});

// Глобальный список онлайн пользователей (храним ID)
const onlineUsers = new Set();

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}, Transport: ${socket.conn.transport.name}`);

    socket.on("disconnect", (reason) => {
        console.log(`Socket ${socket.id} disconnected: ${reason}`);
    });

    const userId = socket.request.session.userId;
    if (!userId) {
        console.log(`Socket ${socket.id} rejected: No session found`);
        return;
    }
    console.log(`Socket ${socket.id} authenticated as User ID: ${userId}`);

    // Каждый пользователь "слушает" свою личную комнату
    socket.join(userId);
    
    // --- Логика статуса "В сети" ---
    onlineUsers.add(userId);
    // Сообщаем всем, что этот пользователь теперь онлайн
    io.emit('user_status', { userId: userId, status: 'online' });
    // Новому подключившемуся отправляем текущий список всех, кто онлайн
    socket.emit('online_list', Array.from(onlineUsers));

    // Присоединяемся к комнатам групп
    usersDb.findOne({ _id: userId }).then(user => {
        if (user && user.group_ids) {
            user.group_ids.forEach(gid => {
                socket.join(`group_${gid}`);
            });
        }
    });

    // Обработка статуса "печатает..."
    socket.on('typing', async (data) => {
        const userId = socket.request.session.userId;
        if (!userId) return;
        
        // Получаем имя пользователя (NeDB работает быстро, можно искать каждый раз)
        const user = await usersDb.findOne({ _id: userId });
        if (!user) return;

        const payload = {
            sender_id: user._id,
            username: user.username,
            group_id: data.group_id,
            recipient_id: data.recipient_id
        };

        if (data.group_id) {
            // В группе отправляем всем, КРОМЕ отправителя
            socket.to(`group_${data.group_id}`).emit('typing', payload);
        } else if (data.recipient_id) {
            // В ЛС отправляем конкретному получателю
            io.to(data.recipient_id).emit('typing', payload);
        }
    });

    socket.on('stop_typing', (data) => {
        const userId = socket.request.session.userId;
        if (!userId) return;

        const payload = {
            sender_id: userId,
            group_id: data.group_id
        };

        if (data.group_id) {
            socket.to(`group_${data.group_id}`).emit('stop_typing', payload);
        } else if (data.recipient_id) {
            io.to(data.recipient_id).emit('stop_typing', payload);
        }
    });
    
    // Смена фона чата
    socket.on('change_background', async (data) => {
        const userId = socket.request.session.userId;
        if (!userId) return;
        
        let bgKey = '';
        let room = '';

        if (data.group_id) {
            bgKey = `g_${data.group_id}`;
            room = `group_${data.group_id}`;
        } else if (data.recipient_id) {
            const ids = [userId, data.recipient_id].sort();
            bgKey = `dm_${ids[0]}_${ids[1]}`;
            room = data.recipient_id; // Для ЛС отправляем собеседнику
        } else {
            return;
        }

        // Сохраняем в БД
        const bgDoc = await settingsDb.findOne({ _id: 'chatBackgrounds' });
        const values = bgDoc ? bgDoc.values : {};
        values[bgKey] = data.background;
        
        await settingsDb.update({ _id: 'chatBackgrounds' }, { $set: { values: values } }, { upsert: true });

        // Отправляем событие обновления (себе и собеседнику/группе)
        if (room) socket.to(room).emit('update_background', { background: data.background, key: bgKey });
        // Себе тоже нужно отправить, если вдруг логика клиента полагается на сокет, но обычно мы меняем локально сразу
        socket.emit('update_background', { background: data.background, key: bgKey }); // Для синхронности
    });

    // При отключении проверяем, остались ли другие соединения у этого юзера
    socket.on('disconnect', () => {
        const room = io.sockets.adapter.rooms.get(userId);
        // Если комната пуста или не существует, значит у пользователя закрыты все вкладки
        if (!room || room.size === 0) {
            onlineUsers.delete(userId);
            io.emit('user_status', { userId: userId, status: 'offline' });
        }
    });
});

// Запуск сервера (Passenger передает порт через 'port' в конфигурации, но обычно слушает сокет)
const PORT = process.env.PORT || 3000;
// Проверка: если запущен напрямую (node app.js) или через Passenger
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
} else {
    server.listen(PORT);
}

module.exports = server;
