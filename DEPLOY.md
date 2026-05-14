# BREACH PROTOCOL — ИНСТРУКЦИЯ ПО ДЕПЛОЮ

## Шаг 1 — Загрузи сервер на GitHub

1. Зайди на github.com → New repository
2. Назови: `breach-protocol-server`
3. Public, без README
4. Нажми "Create repository"

Затем загрузи файлы из папки `breach-server`:
- `server.js`
- `package.json`
- `.gitignore`
- `README.md`

Через веб-интерфейс: "uploading an existing file" → перетащи все 4 файла → Commit.

---

## Шаг 2 — Задеплой сервер на Railway

1. Зайди на **railway.app** → Login with GitHub
2. New Project → Deploy from GitHub repo → выбери `breach-protocol-server`
3. Railway автоматически определит Node.js и запустит `npm start`
4. После деплоя: Settings → Networking → Generate Domain
5. Ты получишь URL вида: `breach-protocol-server-production-xxxx.up.railway.app`

---

## Шаг 3 — Вставь URL в игру

Открой `netrunner_breach.html` в текстовом редакторе.
Найди строку:
```
const SERVER_URL = 'wss://breach-protocol-server.up.railway.app';
```
Замени на свой URL (добавь `wss://` в начало):
```
const SERVER_URL = 'wss://ТВО-URL.up.railway.app';
```
Сохрани файл.

---

## Шаг 4 — Задеплой игру на Netlify

1. Зайди на **netlify.com** → Login with GitHub
2. Sites → "Deploy manually" (внизу страницы)
3. Перетащи файл `netrunner_breach.html` в окно
4. Netlify даст ссылку вида: `random-name-12345.netlify.app`
5. Опционально: Site settings → Change site name → назови `breach-protocol`

---

## Готово!

Ссылку `https://breach-protocol.netlify.app` можно кидать другу.
Он открывает → нажимает ⚔ МАТЧ → вводит код комнаты → играете.

---

## Бесплатные лимиты

- **Railway**: 500 часов/месяц бесплатно (хватит на много игр)
- **Netlify**: 100GB трафика/месяц бесплатно

---

## Если что-то не работает

- Убедись что URL в `SERVER_URL` начинается с `wss://` (не `https://`)
- Railway иногда "засыпает" после неактивности — первое соединение может занять 5-10 секунд
- Чтобы не засыпал: Railway → Settings → Add sleep prevention
