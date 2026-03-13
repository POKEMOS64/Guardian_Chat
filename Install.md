# 🛡️ Guardian Chat — Инструкция по установке

Приватный веб-чат с поддержкой PWA, сквозного шифрования файлов и разделения на группы.

## 💻 Локальный запуск (для разработки)

1.  **Установите Node.js** (версии 14 или выше).
2.  **Скачайте проект** в папку.
3.  Откройте терминал в этой папке и установите зависимости:
    ```bash
    npm install
    ```
4.  **Настройка ключей уведомлений (VAPID):**
    *   Выполните команду для генерации ключей:
        ```bash
        node gen_keys.js
        ```
    *   Скопируйте полученные `Public Key` и `Private Key`.
    *   Откройте файл `app.js`, найдите переменные `publicVapidKey` / `privateVapidKey` (в начале файла) и вставьте туда свои ключи в кавычки.

5.  Запустите сервер:
    ```bash
    node app.js
    ```
6.  Откройте браузер по адресу: `http://localhost:3000`

---

## ☁️ Развертывание на хостинге (Shared Hosting с Passenger)

Инструкция для хостингов типа Sprinthost, Beget, Timeweb, использующих **Phusion Passenger**.

### Шаг 1. Подготовка файлов
Загрузите файлы проекта в папку сайта (обычно `public_html`), **КРОМЕ** папок `node_modules` и `sessions`.

### Шаг 2. Настройка Node.js
1.  Зайдите в панель управления хостингом.
2.  Найдите раздел **"Сайты"** или **"Веб-сервер"**.
3.  Включите поддержку **Node.js** для вашего домена (рекомендуемая версия: 16, 18 или 20).

### Шаг 3. Установка зависимостей
Подключитесь к хостингу через **SSH** или используйте терминал в панели управления.
Перейдите в папку сайта:
```bash
cd domains/ваш-домен.ru/public_html
```
Установите библиотеки:
```bash
npm install
```

### Шаг 3.5. Генерация ключей (Важно!)
Перед запуском необходимо прописать уникальные ключи для Push-уведомлений.
1. Выполните в терминале: `node gen_keys.js`
2. Скопируйте полученные ключи.
3. Отредактируйте файл `app.js` (или задайте переменные окружения `VAPID_PUBLIC_KEY` и `VAPID_PRIVATE_KEY`), вставив ключи.

### Шаг 4. Настройка .htaccess
Создайте или обновите файл `.htaccess` в корне сайта:
```apache
PassengerAppRoot /home/uXXXX/domains/ваш-домен.ru/public_html
PassengerAppType node
PassengerStartupFile app.js
PassengerStickySessions on

Options -Indexes
RewriteEngine On
RewriteCond %{HTTP:X-Forwarded-Proto} !https
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

<FilesMatch "\.(db|log|js|json|ejs)$">
    Require all denied
</FilesMatch>
<FilesMatch "^(manifest\.json|service-worker\.js)$">
    Require all granted
</FilesMatch>
```
*(Замените путь в `PassengerAppRoot` на ваш реальный путь на хостинге).*

### Шаг 5. Запуск
Для перезапуска сервера создайте файл `restart.txt` в папке `tmp`:
```bash
mkdir -p tmp
touch tmp/restart.txt
```

---

## 🔑 Первый вход
1.  Первый зарегистрировавшийся пользователь автоматически становится **Администратором**.
2.  Все последующие пользователи попадают в "Лист ожидания". Админ должен одобрить их в панели управления.
3. Если забыли пароль: Подключитесь к серверу и выполните команду, подставив свой логин и желаемый пароль: node reset_password.js admin myNewPassword123 (Замените admin на ваш логин, а myNewPassword123 на новый пароль). После этого вы сможете войти с новым паролем. Сам файл reset_password.js можно удалить или оставить на будущее.
