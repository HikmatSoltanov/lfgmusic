import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
let content = readFileSync('.env', 'utf8');
if (/^TOKEN_ENCRYPTION_KEY=\s*$/m.test(content)) {
  content = content.replace(/^TOKEN_ENCRYPTION_KEY=\s*$/m, `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env', content, { mode: 0o600 });
  console.log('Создан ключ шифрования. Сохраните .env вместе с резервной копией базы.');
}
mkdirSync('data', { recursive: true, mode: 0o700 }); mkdirSync('media', { recursive: true });
console.log('.env подготовлен; существующие значения сохранены. Заполните ключи приложений локально.');
