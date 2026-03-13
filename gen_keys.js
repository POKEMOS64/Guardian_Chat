// Автор: Полевой Сергей

const crypto = require('crypto');

// Генерация ключей ECDH на эллиптической кривой P-256 (prime256v1)
// Это стандарт, используемый для VAPID
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();

// Функция для конвертации в URL-Safe Base64 
// (заменяет 'base64url' кодировку, которой нет в старых Node.js)
function toUrlSafeBase64(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

console.log('=========================================');
console.log('VAPID Keys (Generated via Node.js crypto)');
console.log('=========================================');
console.log('');
console.log('Public Key:');
console.log(toUrlSafeBase64(ecdh.getPublicKey()));
console.log('');
console.log('Private Key:');
console.log(toUrlSafeBase64(ecdh.getPrivateKey()));
console.log('');
console.log('=========================================');
console.log('Скопируйте эти ключи в app.js');