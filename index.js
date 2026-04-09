require('dotenv').config();
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');

// ─── Validate environment variables ──────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Помилка: TELEGRAM_BOT_TOKEN не задано у .env файлі');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Помилка: ANTHROPIC_API_KEY не задано у .env файлі');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Помилка: DATABASE_URL не задано у .env файлі');
  process.exit(1);
}
if (!process.env.TAVILY_API_KEY)    console.warn('Попередження: TAVILY_API_KEY не задано — веб-пошук вимкнено');
if (!process.env.CLICKUP_API_KEY)   console.warn('Попередження: CLICKUP_API_KEY не задано — ClickUp вимкнено');
if (!process.env.OPENAI_API_KEY)     console.warn('Попередження: OPENAI_API_KEY не задано — розпізнавання голосу вимкнено');
if (!process.env.ELEVENLABS_API_KEY) console.warn('Попередження: ELEVENLABS_API_KEY не задано — голосові відповіді вимкнено');
if (!process.env.TELEGRAM_USER_ID)  console.warn('Попередження: TELEGRAM_USER_ID не задано — дайджести вимкнено (використайте /myid щоб отримати свій ID)');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')
    ? false
    : { rejectUnauthorized: false },
});

// Conversation history stored per user: Map<userId, MessageParam[]>
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// Responses under this length → voice only; at or over → text only
const VOICE_CHAR_LIMIT = 300;

// Telegram user ID to send scheduled digests to (set TELEGRAM_USER_ID in .env)
const OWNER_ID = process.env.TELEGRAM_USER_ID ? parseInt(process.env.TELEGRAM_USER_ID, 10) : null;

const BASE_SYSTEM_PROMPT = `Ти — Мія, особистий AI-асистент Богдана. Ви працюєте разом вже не перший день, тому спілкування природне і без зайвого формалізму.

Про Богдана:
- Звати Богдан, можна звертатись "Бодя" або "Богдан"
- Працює в digital-сфері, розвиває власну команду BASH
- Активні клієнти: Hill Residence, Gurminis, Dentum Clinic, 430 полк
- Прокидається о 8:00-9:00, у пн/ср/пт ходить вранці в спортзал
- Має пса-шпіца та знімає на Fujifilm

Твій характер:
- Дружня, з гумором, але без зайвої балаканини
- Висловлюєш думку прямо — без виправдань і поблажок
- По задачах — чітко і конкретно
- Іноді в рандомні моменти питаєш як справи або що нового — щоб краще пізнати Богдана
- Не соромишся своєї думки навіть якщо вона не збігається з думкою Богдана

Мова: українська. Завжди.

Інструменти:
- web_search: пошук актуальної інформації в інтернеті. Використовуй для новин, курсів валют, погоди, актуальних фактів.
- clickup_get_lists: отримати список всіх списків задач у ClickUp. Викликай перед створенням задачі, якщо не знаєш назву списку.
- clickup_get_tasks: отримати задачі з ClickUp. Параметр filter: "today" (на сьогодні), "overdue" (прострочені), "upcoming" (майбутні), "all" (всі). Також можна вказати list_name.
- clickup_create_task: створити нову задачу в ClickUp. Вкажи name (обов'язково), та опціонально: description, due_date (ISO або "today"/"tomorrow"), list_name, priority ("urgent"/"high"/"normal"/"low"), space (назва простору/проекту, наприклад "BASH" або "Hill Residence"), assignee (true за замовчуванням — призначає на поточного користувача; false — без призначення).
- clickup_complete_task: відмітити задачу як виконану. Вкажи task_id або task_name.

Для ClickUp — використовуй інструменти щоразу, коли Богдан питає про задачі, хоче щось створити або відмітити виконаним. Не вигадуй дані — завжди бери реальні дані через інструменти.`;

// ─── Persistent memory (PostgreSQL, categorized) ─────────────────────────────

const CATEGORIES = ['clients', 'habits', 'plans', 'facts'];
const CAT_LABELS  = {
  clients: 'Клієнти й проекти',
  habits:  'Звички й розпорядок',
  plans:   'Плани й події',
  facts:   'Особисті факти',
};

function emptyCategories() {
  return { clients: [], habits: [], plans: [], facts: [] };
}

// Returns a flat [{cat, text}, …] list numbered 1-N across all categories
function flattenMemory(categories) {
  return CATEGORIES.flatMap(cat =>
    (categories[cat] ?? []).map(text => ({ cat, text }))
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_memory (
      id INTEGER PRIMARY KEY DEFAULT 1,
      facts JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO bot_memory (id, facts) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING`
  );

  // One-time migration: flat string array → cleaned + categorized object
  const res = await pool.query('SELECT facts FROM bot_memory WHERE id = 1');
  const raw = res.rows[0]?.facts;
  if (Array.isArray(raw) && raw.length) {
    console.log(`🔄 Оптимізую пам'ять (${raw.length} фактів)...`);
    const categories = await compressAndCategorize(raw);
    await pool.query(
      'UPDATE bot_memory SET facts = $1::jsonb, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(categories)]
    );
    const total = CATEGORIES.reduce((s, c) => s + (categories[c]?.length ?? 0), 0);
    console.log(`✅ Пам'ять оптимізована: ${raw.length} → ${total} фактів`);
  }
  console.log('✅ База даних підключена');
}

async function loadMemory() {
  try {
    const res = await pool.query('SELECT facts, updated_at FROM bot_memory WHERE id = 1');
    if (!res.rows.length) return { categories: emptyCategories(), updatedAt: null };
    const data = res.rows[0].facts;
    const categories = Array.isArray(data)
      ? { ...emptyCategories(), facts: data }
      : { ...emptyCategories(), ...data };
    return { categories, updatedAt: res.rows[0].updated_at };
  } catch (err) {
    console.error('🧠 loadMemory помилка:', err.message);
    return { categories: emptyCategories(), updatedAt: null };
  }
}

async function saveMemory({ categories }) {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO bot_memory (id, facts, updated_at) VALUES (1, $1::jsonb, $2)
     ON CONFLICT (id) DO UPDATE SET facts = $1::jsonb, updated_at = $2`,
    [JSON.stringify(categories), now]
  );
  return now;
}

// Clean, de-duplicate, categorize, and compress facts.
// Input: flat string[] or categories object. Returns categories object.
async function compressAndCategorize(input) {
  let factsText;
  if (Array.isArray(input)) {
    factsText = input.map(f => `- ${f}`).join('\n');
  } else {
    factsText = CATEGORIES
      .flatMap(cat => (input[cat] ?? []).map(f => `[${CAT_LABELS[cat]}] ${f}`))
      .map(f => `- ${f}`)
      .join('\n');
  }
  if (!factsText.trim()) return emptyCategories();

  const prompt = `Ти оптимізуєш базу знань AI-асистента Міі про людину на ім'я Богдан.

Поточні факти (можуть бути дублі, застарілі події, протиріччя):
${factsText}

Завдання:
1. Видали застарілі одноразові події (минулі дати, зустрічі що вже відбулись)
2. Видали технічні факти про саму Мію ("Мія вміє...", "Мія не може...")
3. Видали записи про поточний час ("Зараз X годин...")
4. Об'єднай дублі та схожі факти в один чіткий запис
5. Усунь протиріччя — залиш актуальну версію
6. Стисни кожен факт до одного короткого речення
7. Розподіли по категоріях:
   - clients: активні клієнти, проекти, їх поточний стан
   - habits: щоденний розпорядок, звички, вподобання
   - plans: майбутні плани та цілі (не минулі події)
   - facts: особисті факти (сім'я, друзі, риси характеру, бізнес)

Відповідай ТІЛЬКИ валідним JSON:
{"clients":[],"habits":[],"plans":[],"facts":[]}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text?.trim() ?? '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return emptyCategories();
    const parsed = JSON.parse(match[0]);
    return {
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      habits:  Array.isArray(parsed.habits)  ? parsed.habits  : [],
      plans:   Array.isArray(parsed.plans)   ? parsed.plans   : [],
      facts:   Array.isArray(parsed.facts)   ? parsed.facts   : [],
    };
  } catch (err) {
    console.error('Помилка стиснення пам\'яті:', err.message);
    return Array.isArray(input)
      ? { ...emptyCategories(), facts: input }
      : { ...emptyCategories(), ...input };
  }
}

// Merge newly extracted categorized facts, exact-dedup, auto-compress when bloated
async function mergeAndSaveFacts(newCategorized) {
  const { categories } = await loadMemory();
  let changed = false;

  for (const cat of CATEGORIES) {
    const incoming = newCategorized[cat] ?? [];
    if (!incoming.length) continue;
    const existing = new Set((categories[cat] ?? []).map(f => f.toLowerCase()));
    for (const fact of incoming) {
      if (!existing.has(fact.toLowerCase())) {
        categories[cat] = [...(categories[cat] ?? []), fact];
        changed = true;
      }
    }
  }
  if (!changed) return;

  const total = CATEGORIES.reduce((s, c) => s + (categories[c]?.length ?? 0), 0);
  const finalCategories = total > 60
    ? await compressAndCategorize(categories)
    : categories;

  await saveMemory({ categories: finalCategories });
}

// Returns the full system prompt with current memory appended
async function buildSystemPrompt() {
  const now = new Date().toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const timestamp = `Зараз: ${now} (Київ)`;

  const { categories } = await loadMemory();
  const sections = CATEGORIES
    .filter(cat => (categories[cat] ?? []).length)
    .map(cat =>
      `${CAT_LABELS[cat]}:\n` +
      categories[cat].map((f, i) => `${i + 1}. ${f}`).join('\n')
    );

  const memoryBlock = sections.length
    ? '\n\nЩо Мія пам\'ятає про Богдана:\n\n' + sections.join('\n\n')
    : '';

  return `${timestamp}\n\n${BASE_SYSTEM_PROMPT}${memoryBlock}`;
}

// Summarise the recent conversation and extract any facts not yet saved.
// Called every 60 minutes — broader sweep than per-message extraction.
async function autoSaveConversationSummary() {
  if (!OWNER_ID) return;
  const history = conversationHistory.get(OWNER_ID);
  if (!history?.length) return;

  const textTurns = history
    .filter(m => typeof m.content === 'string')
    .slice(-20);
  if (!textTurns.length) return;

  const { categories } = await loadMemory();
  const knownFacts = CATEGORIES
    .flatMap(cat => (categories[cat] ?? []).map(f => `[${CAT_LABELS[cat]}] ${f}`))
    .map(f => `- ${f}`)
    .join('\n') || '(нічого)';

  const dialog = textTurns
    .map(m => `${m.role === 'user' ? 'Богдан' : 'Мія'}: ${m.content}`)
    .join('\n');

  const prompt = `Ти — система пам'яті асистента Міі. Твоє завдання: АГРЕСИВНО зберігати особисту інформацію про Богдана з діалогу.

Вже відомо:
${knownFacts}

Діалог:
${dialog}

ЗБЕРІГАЙ все нове особисте — навіть якщо згадано побіжно:
✅ Імена людей (хто вони, стосунки з Богданом)
✅ Тварини (кличка, порода, характер)
✅ Місця (де живе, де буває, улюблені локації)
✅ Вподобання (їжа, напої, музика, фільми, хобі, техніка)
✅ Звички та розпорядок дня
✅ Риси характеру, поведінкові патерни
✅ Сім'я та близькі
✅ Стан справ по клієнтах і проектах
✅ Майбутні плани та наміри
✅ Думки, позиції, ставлення до речей
✅ Будь-яка деталь, яка може стати корисною пізніше

НЕ зберігай:
❌ Поточний час або дату
❌ Технічні деталі про саму Мію
❌ Вже відоме (без дублів)

Категорії: clients (клієнти/проекти/колеги), habits (звички/вподобання/хобі), plans (майбутні плани/цілі), facts (люди/місця/риси/особисті факти)

Якщо нічого нового — поверни {"clients":[],"habits":[],"plans":[],"facts":[]}
Відповідай ТІЛЬКИ JSON: {"clients":[],"habits":[],"plans":[],"facts":[]}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text?.trim() ?? '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const newFacts = JSON.parse(match[0]);
    const total = CATEGORIES.reduce((s, c) => s + (newFacts[c]?.length ?? 0), 0);
    if (!total) return;
    await mergeAndSaveFacts(newFacts);
    console.log(`🧠 Авто-збереження: +${total} фактів`);
  } catch (err) {
    console.error('Помилка авто-збереження пам\'яті:', err.message);
  }
}

// ── Evening memory review ──────────────────────────────────────────────────────

// Set to true after the 22:00 review message is sent; cleared once user replies
let memoryReviewPending = false;

async function sendMemoryReview() {
  if (!OWNER_ID) return;
  const { categories } = await loadMemory();
  const items = flattenMemory(categories);

  if (!items.length) {
    await bot.telegram.sendMessage(OWNER_ID, '🧠 Пам\'ять порожня — нічого переглядати.');
    return;
  }

  let counter = 1;
  const lines = [];
  for (const cat of CATEGORIES) {
    const catItems = items.filter(x => x.cat === cat);
    if (!catItems.length) continue;
    lines.push(`${CAT_LABELS[cat]}:`);
    for (const item of catItems) lines.push(`${counter++}. ${item.text}`);
    lines.push('');
  }

  const reviewText =
    '🧠 Вечірній огляд пам\'яті:\n\n' + lines.join('\n').trim() +
    '\n\nЩо видалити? Надішли номери через кому (напр. "1, 3"), ' +
    '"all" щоб очистити все, або "ok" щоб залишити як є.';
  for (const chunk of splitMessage(reviewText)) {
    await bot.telegram.sendMessage(OWNER_ID, chunk);
  }
  memoryReviewPending = true;
  console.log('🧠 Вечірній огляд пам\'яті надіслано');
}

async function handleMemoryReviewResponse(ctx, input) {
  const text = input.trim().toLowerCase();
  const { categories } = await loadMemory();
  const items = flattenMemory(categories);

  if (text === 'ok' || text === 'ок') {
    await ctx.reply('👍 Залишаю все як є.');
    return;
  }

  if (text === 'all' || text === 'все') {
    await saveMemory({ categories: emptyCategories() });
    await ctx.reply('🗑 Пам\'ять повністю очищена.');
    return;
  }

  const nums = [...new Set(
    text.split(/[\s,]+/)
      .map(n => parseInt(n, 10))
      .filter(n => !isNaN(n) && n >= 1 && n <= items.length)
  )];

  if (!nums.length) {
    await ctx.reply('❓ Не зрозуміла. Надішли номери фактів через кому, "all" або "ok".');
    memoryReviewPending = true;
    return;
  }

  const toRemove = new Set(nums.map(n => items[n - 1].text));
  const newCategories = {};
  for (const cat of CATEGORIES) {
    newCategories[cat] = (categories[cat] ?? []).filter(f => !toRemove.has(f));
  }
  await saveMemory({ categories: newCategories });

  await ctx.reply(
    `🗑 Видалено ${toRemove.size} факт(ів):\n` +
    [...toRemove].map(f => `• ${f}`).join('\n')
  );
}

// Extract new facts from the last exchange and save to PostgreSQL.
// Uses Haiku for speed/cost. Called fire-and-forget — never blocks the reply.
async function extractAndSaveMemory(userMessage, assistantMessage) {
  try {
    const { categories } = await loadMemory();
    const knownFacts = CATEGORIES
      .flatMap(cat => (categories[cat] ?? []).map(f => `[${CAT_LABELS[cat]}] ${f}`))
      .map(f => `- ${f}`)
      .join('\n') || '(нічого)';

    const prompt = `Ти — система пам'яті асистента Міі. Твоє завдання: АГРЕСИВНО зберігати особисту інформацію про Богдана з кожного діалогу.

Вже відомо:
${knownFacts}

Новий діалог:
Богдан: ${userMessage}
Мія: ${assistantMessage}

ЗБЕРІГАЙ все нове особисте — навіть якщо згадано побіжно:
✅ Імена людей (хто вони, стосунки з Богданом)
✅ Тварини (кличка, порода, характер)
✅ Місця (де живе, де буває, улюблені локації)
✅ Вподобання (їжа, напої, музика, фільми, хобі, техніка)
✅ Звички та розпорядок дня
✅ Риси характеру, поведінкові патерни
✅ Сім'я та близькі
✅ Стан справ по клієнтах і проектах
✅ Майбутні плани та наміри
✅ Думки, позиції, ставлення до речей
✅ Будь-яка деталь, яка може стати корисною пізніше

НЕ зберігай:
❌ Поточний час або дату
❌ Технічні деталі про саму Мію
❌ Чисті API-запити до ClickUp без особистого контексту
❌ Вже відоме (без дублів)

Категорії:
- clients: клієнти, проекти, ділові стосунки, колеги
- habits: звички, розпорядок, вподобання, хобі
- plans: майбутні плани, цілі, наміри
- facts: люди в житті, місця, риси характеру, будь-які особисті факти

Якщо нічого нового — поверни {"clients":[],"habits":[],"plans":[],"facts":[]}
Відповідай ТІЛЬКИ JSON: {"clients":[],"habits":[],"plans":[],"facts":[]}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.text?.trim() ?? '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('🧠 Екстракція: не вдалося розібрати відповідь:', raw.slice(0, 100));
      return;
    }

    const newFacts = JSON.parse(match[0]);
    const total = CATEGORIES.reduce((s, c) => s + (newFacts[c]?.length ?? 0), 0);
    if (!total) {
      console.log('🧠 Екстракція: нових фактів не знайдено');
      return;
    }

    await mergeAndSaveFacts(newFacts);
    console.log(`🧠 Збережено ${total} нових фактів:`, JSON.stringify(newFacts));
  } catch (err) {
    console.error('🧠 extractAndSaveMemory помилка:', err.message);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// Download any HTTPS URL and return a Buffer
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ─── Tavily web search ────────────────────────────────────────────────────────

function tavilySearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    });
    const options = {
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Не вдалося розібрати відповідь Tavily')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function formatSearchResults(data) {
  const parts = [];
  if (data.answer) parts.push(`Коротка відповідь: ${data.answer}`);
  if (data.results?.length) {
    parts.push('\nДжерела:');
    data.results.slice(0, 5).forEach((r, i) => {
      parts.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content?.slice(0, 300) ?? ''}...`);
    });
  }
  return parts.length ? parts.join('\n') : 'Пошук не повернув результатів.';
}

// ─── OpenAI Whisper — speech-to-text ─────────────────────────────────────────

// Download a Telegram voice file and return its Buffer
async function downloadTelegramFile(fileId) {
  const fileLink = await bot.telegram.getFileLink(fileId);
  return downloadBuffer(fileLink.href);
}

// Transcribe an audio Buffer using Whisper. Returns the transcript string.
function transcribeAudio(audioBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = `----WhisperBoundary${Date.now()}`;

    // Build multipart/form-data body manually (no extra dependencies needed)
    const textField = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

    const bodyParts = [
      Buffer.from(textField('model', 'whisper-1')),
      Buffer.from(textField('language', 'uk')),
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.ogg"\r\n` +
        `Content-Type: audio/ogg\r\n\r\n`
      ),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(bodyParts);

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Whisper ${res.statusCode}: ${parsed.error?.message ?? data}`));
          } else {
            resolve(parsed.text ?? '');
          }
        } catch {
          reject(new Error('Не вдалося розібрати відповідь Whisper'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── ElevenLabs TTS — text-to-speech ─────────────────────────────────────────

const ELEVENLABS_VOICE_ID = '9FTUWXd0yHJL1ZiZ71RK'; // Anika

// Strip markdown and URLs so TTS audio sounds natural
function cleanTextForTTS(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [label](url) → label
    .replace(/https?:\/\/\S+/g, '')              // bare URLs
    .replace(/[*_`~#>|]/g, '')                   // markdown symbols
    .replace(/\n{3,}/g, '\n\n')                  // excess blank lines
    .trim();
}

// Call ElevenLabs TTS and return an MP3 Buffer
function textToSpeech(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', chunk => { errData += chunk; });
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${errData}`)));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Send a voice reply using ElevenLabs TTS
// Send the bot response as voice-only or text-only depending on length.
// useVoice: caller signals whether voice is preferred (i.e. user sent a voice message).
async function sendReply(ctx, text, useVoice = false) {
  const clean = cleanTextForTTS(text);
  const isShort = clean.length < VOICE_CHAR_LIMIT;

  if (useVoice && isShort && process.env.ELEVENLABS_API_KEY) {
    // Short response + voice context → send voice only
    try {
      await ctx.sendChatAction('record_voice');
      const audioBuffer = await textToSpeech(clean);
      console.log(`TTS: ${audioBuffer.length} байт (${clean.length} символів) → голос`);
      await ctx.replyWithVoice({ source: audioBuffer, filename: 'voice.mp3' });
      return;
    } catch (err) {
      console.error('TTS помилка:', err.message);
      // Fall through to text on TTS failure
    }
  }

  // Long response, text context, or TTS unavailable/failed → send text only
  console.log(`Відповідь текстом (${text.length} символів)`);
  await ctx.reply(text);
}

// ─── ClickUp API ──────────────────────────────────────────────────────────────

let clickupCache = { workspaceId: null, userId: null, lists: null, fetchedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000;

function clickupRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2${path}`,
      method,
      headers: {
        Authorization: process.env.CLICKUP_API_KEY,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`ClickUp ${res.statusCode}: ${parsed.err || parsed.ECODE || JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Не вдалося розібрати відповідь ClickUp'));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getWorkspaceId() {
  if (clickupCache.workspaceId) return clickupCache.workspaceId;
  const data = await clickupRequest('GET', '/team');
  if (!data.teams?.length) throw new Error('Робочі простори ClickUp не знайдено');
  clickupCache.workspaceId = data.teams[0].id;
  return clickupCache.workspaceId;
}

// Fetch the ID of the authenticated ClickUp user (cached)
async function getCurrentUserId() {
  if (clickupCache.userId) return clickupCache.userId;
  const data = await clickupRequest('GET', '/user');
  clickupCache.userId = data.user?.id ?? null;
  return clickupCache.userId;
}

async function getAllLists() {
  const now = Date.now();
  if (clickupCache.lists && now - clickupCache.fetchedAt < CACHE_TTL) return clickupCache.lists;

  const teamId = await getWorkspaceId();
  const spacesData = await clickupRequest('GET', `/team/${teamId}/space?archived=false`);
  const lists = [];

  for (const space of spacesData.spaces || []) {
    const listsData = await clickupRequest('GET', `/space/${space.id}/list?archived=false`);
    for (const list of listsData.lists || []) {
      lists.push({ id: list.id, name: list.name, spaceName: space.name });
    }
    const foldersData = await clickupRequest('GET', `/space/${space.id}/folder?archived=false`);
    for (const folder of foldersData.folders || []) {
      const folderLists = await clickupRequest('GET', `/folder/${folder.id}/list?archived=false`);
      for (const list of folderLists.lists || []) {
        lists.push({ id: list.id, name: list.name, spaceName: space.name, folderName: folder.name });
      }
    }
  }

  clickupCache.lists = lists;
  clickupCache.fetchedAt = now;
  return lists;
}

async function findList(nameQuery, spaceName = null) {
  const lists = await getAllLists();
  if (!lists.length) throw new Error('Жодного списку задач не знайдено в ClickUp');

  // Narrow to the requested space first, fall back to all lists if no match
  let candidates = lists;
  if (spaceName) {
    const sq = spaceName.toLowerCase();
    const inSpace = lists.filter(l => l.spaceName.toLowerCase().includes(sq));
    if (inSpace.length) candidates = inSpace;
  }

  if (!nameQuery) return candidates[0];
  const q = nameQuery.toLowerCase();
  return candidates.find(l => l.name.toLowerCase().includes(q)) ?? candidates[0];
}

function parseDueDate(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();
  const d = new Date();
  if (s === 'today') {
    d.setHours(23, 59, 0, 0);
  } else if (s === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(23, 59, 0, 0);
  } else {
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return null;
    return parsed.getTime();
  }
  return d.getTime();
}

function formatTask(t) {
  const due = t.due_date
    ? new Date(parseInt(t.due_date)).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'без терміну';
  const priorityNames = { 1: 'терміново', 2: 'важливо', 3: 'нормально', 4: 'низький' };
  const priority = priorityNames[t.priority?.priority] ?? '';
  const status = t.status?.status ?? '—';
  return `• ${t.name}\n  ID: ${t.id} | Статус: ${status} | Термін: ${due}${priority ? ` | ${priority}` : ''}`;
}

// ─── ClickUp tool handlers ────────────────────────────────────────────────────

async function clickupGetLists() {
  const lists = await getAllLists();
  if (!lists.length) return 'Списки задач не знайдено.';
  return lists.map(l => {
    const path = l.folderName ? `${l.spaceName} / ${l.folderName}` : l.spaceName;
    return `• ${l.name}  (${path})`;
  }).join('\n');
}

// Returns raw task array — used by both the Claude tool handler and digest functions
async function fetchTasks({ filter = 'all', list_name } = {}) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const now = Date.now();

  const qp = new URLSearchParams({ include_closed: 'false', subtasks: 'true' });
  if (filter === 'today')         { qp.set('due_date_gt', todayStart.getTime()); qp.set('due_date_lt', todayEnd.getTime()); }
  else if (filter === 'overdue')  { qp.set('due_date_lt', todayStart.getTime()); }
  else if (filter === 'upcoming') { qp.set('due_date_gt', now); }

  if (list_name) {
    const list = await findList(list_name);
    const data = await clickupRequest('GET', `/list/${list.id}/task?${qp}`);
    return data.tasks ?? [];
  }
  const teamId = await getWorkspaceId();
  const data = await clickupRequest('GET', `/team/${teamId}/task?${qp}`);
  return data.tasks ?? [];
}

// Returns tasks closed (completed) today — used by the evening digest
async function fetchCompletedToday() {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const teamId = await getWorkspaceId();
  const qp = new URLSearchParams({
    include_closed: 'true',
    date_updated_gt: todayStart.getTime(),
    date_updated_lt: todayEnd.getTime(),
  });
  const data = await clickupRequest('GET', `/team/${teamId}/task?${qp}`);
  return (data.tasks ?? []).filter(t => t.status?.type === 'closed');
}

async function clickupGetTasks(params = {}) {
  const tasks = await fetchTasks(params);
  if (!tasks.length) {
    const label = { today: 'на сьогодні', overdue: 'прострочені', upcoming: 'майбутні', all: '' }[params.filter ?? 'all'] ?? '';
    return `Задачі ${label} не знайдено.`.trim();
  }
  return tasks.slice(0, 20).map(formatTask).join('\n\n');
}

async function clickupCreateTask({ name, description, due_date, list_name, priority, assignee = true, space } = {}) {
  if (!name) return 'Помилка: назва задачі обов\'язкова.';
  const list = await findList(list_name, space);
  const taskData = { name };

  if (description) taskData.description = description;

  const dueMsec = parseDueDate(due_date);
  if (dueMsec) { taskData.due_date = dueMsec; taskData.due_date_time = true; }

  const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4, терміново: 1, важливо: 2, нормально: 3, низький: 4 };
  if (priority) taskData.priority = priorityMap[priority.toLowerCase()] ?? 3;

  // Assign to current user by default; pass assignee: false to create unassigned
  if (assignee !== false) {
    try {
      const userId = await getCurrentUserId();
      if (userId) taskData.assignees = [userId];
    } catch {
      // Non-critical — create task without assignee if lookup fails
    }
  }

  const task = await clickupRequest('POST', `/list/${list.id}/task`, taskData);
  const dueStr = task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('uk-UA') : 'без терміну';
  const spacePart = list.spaceName ? ` (${list.spaceName})` : '';
  const assignedPart = task.assignees?.length ? ' | Призначено: вам' : '';
  return `Задачу створено!\nНазва: ${task.name}\nСписок: ${list.name}${spacePart}\nТермін: ${dueStr}${assignedPart}\nID: ${task.id}`;
}

async function clickupCompleteTask({ task_id, task_name } = {}) {
  let id = task_id;
  if (!id && task_name) {
    const teamId = await getWorkspaceId();
    const data = await clickupRequest('GET', `/team/${teamId}/task?include_closed=false`);
    const found = (data.tasks ?? []).find(t => t.name.toLowerCase().includes(task_name.toLowerCase()));
    if (!found) return `Задачу "${task_name}" не знайдено серед відкритих задач.`;
    id = found.id;
  }
  if (!id) return 'Помилка: вкажіть task_id або task_name.';

  const taskDetails = await clickupRequest('GET', `/task/${id}`);
  let closedStatusName = 'closed';
  if (taskDetails.list?.id) {
    try {
      const listDetails = await clickupRequest('GET', `/list/${taskDetails.list.id}`);
      const closedStatus = (listDetails.statuses ?? []).find(s => s.type === 'closed');
      if (closedStatus) closedStatusName = closedStatus.status;
    } catch { /* fall back to 'closed' */ }
  }

  await clickupRequest('PUT', `/task/${id}`, { status: closedStatusName });
  return `Задачу "${taskDetails.name}" відмічено як виконану.`;
}

// ─── Scheduled digests ────────────────────────────────────────────────────────

// Returns { hour, minute } in Kyiv timezone (handles DST automatically)
function getKyivHourMinute() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return {
    hour:   parseInt(parts.find(p => p.type === 'hour').value,   10),
    minute: parseInt(parts.find(p => p.type === 'minute').value, 10),
  };
}

async function sendMorningDigest() {
  if (!OWNER_ID || !process.env.CLICKUP_API_KEY) return;
  try {
    const dateStr = new Date().toLocaleDateString('uk-UA', {
      timeZone: 'Europe/Kyiv', weekday: 'long', day: 'numeric', month: 'long',
    });

    const [todayTasks, overdueTasks] = await Promise.all([
      fetchTasks({ filter: 'today' }),
      fetchTasks({ filter: 'overdue' }),
    ]);

    let msg = `🌅 Доброго ранку! ${dateStr}\n`;

    if (todayTasks.length) {
      msg += `\n📋 На сьогодні (${todayTasks.length}):\n`;
      msg += todayTasks.slice(0, 10).map(t => {
        const priority = { 1: ' 🔴', 2: ' 🟠', 3: '', 4: ' 🔵' }[t.priority?.priority] ?? '';
        return `• ${t.name}${priority}`;
      }).join('\n');
    } else {
      msg += '\n📋 На сьогодні задач немає — вільний день!';
    }

    if (overdueTasks.length) {
      msg += `\n\n⚠️ Прострочено (${overdueTasks.length}):\n`;
      msg += overdueTasks.slice(0, 5).map(t => {
        const due = t.due_date
          ? new Date(parseInt(t.due_date)).toLocaleDateString('uk-UA')
          : '';
        return `• ${t.name}${due ? ` (${due})` : ''}`;
      }).join('\n');
    }

    await bot.telegram.sendMessage(OWNER_ID, msg);
    console.log('📅 Ранковий дайджест надіслано');
  } catch (err) {
    console.error('Помилка ранкового дайджесту:', err.message);
  }
}

async function sendEveningDigest() {
  if (!OWNER_ID || !process.env.CLICKUP_API_KEY) return;
  try {
    const dateStr = new Date().toLocaleDateString('uk-UA', {
      timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
    });

    const [remainingTasks, completedTasks] = await Promise.all([
      fetchTasks({ filter: 'today' }),
      fetchCompletedToday(),
    ]);

    let msg = `🌆 Вечірній підсумок, ${dateStr}\n`;

    if (completedTasks.length) {
      msg += `\n✅ Виконано сьогодні (${completedTasks.length}):\n`;
      msg += completedTasks.slice(0, 10).map(t => `• ${t.name}`).join('\n');
    } else {
      msg += '\n✅ Завдань сьогодні не закрито.';
    }

    if (remainingTasks.length) {
      msg += `\n\n🔄 Залишилось на сьогодні (${remainingTasks.length}):\n`;
      msg += remainingTasks.slice(0, 10).map(t => `• ${t.name}`).join('\n');
    } else {
      msg += '\n\n🎉 Всі задачі на сьогодні виконано!';
    }

    await bot.telegram.sendMessage(OWNER_ID, msg);
    console.log('📅 Вечірній дайджест надіслано');
  } catch (err) {
    console.error('Помилка вечірнього дайджесту:', err.message);
  }
}

// Track last-sent dates to avoid double-firing if bot restarts within the same minute
let lastMorningDate      = '';
let lastEveningDate      = '';
let lastMemoryReviewDate = '';

// ─── Proactive messages ───────────────────────────────────────────────────────

let lastProactiveTime     = 0;   // Date.now() of last sent proactive message
let proactiveScheduleDate = '';  // 'YYYY-MM-DD' for which proactiveTimes was built
let proactiveTimes        = [];  // sorted minute-of-day values to fire today
let nextProactiveType     = 'personal'; // alternates 'task' | 'personal'

// Returns 2-3 random minute-of-day values between 08:00 and 21:00, each at
// least 120 minutes apart from each other.
function scheduleTodayProactiveMessages() {
  const count    = Math.random() < 0.5 ? 2 : 3;
  const DAY_START = 8  * 60;  // 480 min
  const DAY_END   = 21 * 60;  // 1260 min
  const MIN_GAP   = 120;

  const times = [];
  let attempts = 0;
  while (times.length < count && attempts < 300) {
    attempts++;
    const t = DAY_START + Math.floor(Math.random() * (DAY_END - DAY_START));
    if (times.every(e => Math.abs(e - t) >= MIN_GAP)) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

async function sendProactiveMessage(type) {
  if (!OWNER_ID) return;

  const { categories } = await loadMemory();
  const knownFacts = CATEGORIES
    .flatMap(cat => (categories[cat] ?? []).map(f => `[${CAT_LABELS[cat]}] ${f}`))
    .map(f => `- ${f}`)
    .join('\n') || '(нічого)';

  let prompt;
  if (type === 'task' && process.env.CLICKUP_API_KEY) {
    let taskContext = '';
    try {
      taskContext = await executeTool('clickup_get_tasks', { filter: 'today' });
    } catch { /* ClickUp unavailable — send generic check-in */ }

    prompt = `Ти — Мія, AI-асистент Богдана. Напиши одне коротке природне повідомлення про задачі — як від друга, без формалізму.
${taskContext ? `\nЗадачі на сьогодні:\n${taskContext}` : '\nСписок задач зараз недоступний — запитай загально.'}

Що відомо про Богдана:
${knownFacts}

Правила:
- Максимум 1-2 речення
- Запитай про прогрес по конкретній задачі або м'яко нагадай про щось незроблене
- Природно, неформально
- Тільки текст повідомлення, без жодних пояснень`;
  } else {
    prompt = `Ти — Мія, AI-асистент Богдана. Придумай одне коротке особисте запитання, щоб краще пізнати Богдана.

Що вже відомо:
${knownFacts}

Правила:
- Запитуй про щось чого ще НЕ знаєш — не дублюй вже відоме
- Теми: звички, вподобання, думки, спогади, плани, цікаві ситуації з життя
- Максимум 1-2 речення, природно і невимушено
- Тільки текст запитання, без жодних пояснень`;
  }

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const message = resp.content[0]?.text?.trim();
    if (!message) return;

    await bot.telegram.sendMessage(OWNER_ID, message);
    lastProactiveTime = Date.now();
    nextProactiveType = type === 'task' ? 'personal' : 'task';
    console.log(`💬 Проактивне (${type}): "${message}"`);
  } catch (err) {
    console.error('Помилка проактивного повідомлення:', err.message);
  }
}

function startScheduler() {
  if (!OWNER_ID) {
    console.log('⏰ Планувальник вимкнено (TELEGRAM_USER_ID не задано)');
    return;
  }

  // Named tick function — runs every clock minute
  async function tick() {
    const { hour, minute } = getKyivHourMinute();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    console.log(`⏰ Tick: ${hh}:${mm} Kyiv | proactive queue: [${proactiveTimes.join(',')}]`);

    if (hour === 8 && minute === 0 && lastMorningDate !== today) {
      lastMorningDate = today;
      console.log('🌅 Запускаю ранковий дайджест...');
      await sendMorningDigest();
    }
    if (hour === 21 && minute === 0 && lastEveningDate !== today) {
      lastEveningDate = today;
      console.log('🌆 Запускаю вечірній дайджест...');
      await sendEveningDigest();
    }
    if (hour === 22 && minute === 0 && lastMemoryReviewDate !== today) {
      lastMemoryReviewDate = today;
      await sendMemoryReview();
    }

    // Rebuild proactive schedule at day rollover (or first tick)
    if (proactiveScheduleDate !== today) {
      proactiveScheduleDate = today;
      proactiveTimes = scheduleTodayProactiveMessages();
      const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      console.log(`💬 Проактивні повідомлення сьогодні: ${proactiveTimes.map(fmt).join(', ')}`);
    }

    // Fire a proactive message if the current minute is scheduled and
    // at least 2 hours have passed since the last one
    const currentMinute = hour * 60 + minute;
    const TWO_HOURS_MS  = 2 * 60 * 60 * 1000;
    if (
      hour >= 8 && hour < 21 &&
      proactiveTimes.includes(currentMinute) &&
      Date.now() - lastProactiveTime >= TWO_HOURS_MS
    ) {
      proactiveTimes = proactiveTimes.filter(t => t !== currentMinute);
      console.log(`💬 Надсилаю проактивне повідомлення (${nextProactiveType})...`);
      sendProactiveMessage(nextProactiveType).catch(() => {});
    }
  }

  // Fire immediately so we don't miss the current minute on startup
  tick().catch(err => console.error('Scheduler tick error:', err.message));

  // Align to the next clock-minute boundary, then tick every 60s exactly
  const now = new Date();
  const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  console.log(`⏰ Наступний тік через ${Math.round(msUntilNextMinute / 1000)}с (вирівнювання по хвилині)`);

  setTimeout(() => {
    tick().catch(err => console.error('Scheduler tick error:', err.message));
    setInterval(() => tick().catch(err => console.error('Scheduler tick error:', err.message)), 60_000);
  }, msUntilNextMinute);

  // 60-minute auto-save of conversation summary
  setInterval(async () => {
    await autoSaveConversationSummary();
  }, 60 * 60_000);

  console.log('⏰ Планувальник запущено — дайджести 08:00/21:00, огляд пам\'яті 22:00, проактивні 2-3/день за Києвом');
  console.log('⏰ Авто-збереження пам\'яті кожні 60 хвилин');
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────

function buildTools() {
  const tools = [];
  if (process.env.TAVILY_API_KEY) {
    tools.push({
      name: 'web_search',
      description: 'Search the web for current information, news, facts, or any topic requiring up-to-date data.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
      },
    });
  }
  if (process.env.CLICKUP_API_KEY) {
    tools.push(
      {
        name: 'clickup_get_lists',
        description: 'Get all task lists available in ClickUp. Call this first if you need to know list names.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'clickup_get_tasks',
        description: 'Get tasks from ClickUp.',
        input_schema: {
          type: 'object',
          properties: {
            filter: { type: 'string', enum: ['today', 'overdue', 'upcoming', 'all'],
              description: '"today" = due today, "overdue" = past due, "upcoming" = future, "all" = no filter' },
            list_name: { type: 'string', description: 'Optional: filter by list name' },
          },
        },
      },
      {
        name: 'clickup_create_task',
        description: 'Create a new task in ClickUp.',
        input_schema: {
          type: 'object',
          properties: {
            name:        { type: 'string', description: 'Task title (required)' },
            description: { type: 'string', description: 'Optional task description' },
            due_date:    { type: 'string', description: 'Due date: ISO string, "today", or "tomorrow"' },
            list_name:   { type: 'string', description: 'Name of the list to create the task in' },
            priority:    { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
            assignee:    { type: 'boolean', description: 'Assign to current user. Default true. Pass false only if user explicitly wants an unassigned task.' },
            space:       { type: 'string', description: 'Space or project name to narrow list search (e.g. "BASH", "Hill Residence"). Use when the user mentions a specific project.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'clickup_complete_task',
        description: 'Mark a task as complete/closed in ClickUp.',
        input_schema: {
          type: 'object',
          properties: {
            task_id:   { type: 'string', description: 'ClickUp task ID (preferred)' },
            task_name: { type: 'string', description: 'Task name to search for (if task_id unknown)' },
          },
        },
      },
    );
  }
  return tools;
}

const tools = buildTools();

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'web_search': return formatSearchResults(await tavilySearch(input.query));
    case 'clickup_get_lists':     return await clickupGetLists();
    case 'clickup_get_tasks':     return await clickupGetTasks(input);
    case 'clickup_create_task':   return await clickupCreateTask(input);
    case 'clickup_complete_task': return await clickupCompleteTask(input);
    default: return `Невідомий інструмент: ${name}`;
  }
}

// ─── Claude message processing ────────────────────────────────────────────────

const TOOL_LABELS = {
  web_search:            '🔍 Шукаю в інтернеті...',
  clickup_get_lists:     '📋 Отримую списки задач...',
  clickup_get_tasks:     '📋 Отримую задачі...',
  clickup_create_task:   '✏️ Створюю задачу...',
  clickup_complete_task: '✅ Виконую задачу...',
};

// Handles multi-turn tool use (up to 5 rounds), returns final text
async function processWithClaude(history, onToolUse) {
  const apiMessages = [...history]; // shallow copy — keeps stored history clean

  for (let round = 0; round < 5; round++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: await buildSystemPrompt(),
      ...(tools.length ? { tools } : {}),
      messages: apiMessages,
    });

    if (response.stop_reason !== 'tool_use') {
      return response.content.find(b => b.type === 'text')?.text
        ?? 'Вибачте, не вдалося отримати відповідь.';
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`🔧 ${block.name}:`, JSON.stringify(block.input));
      if (onToolUse) await onToolUse(block.name);

      let result;
      try {
        result = await executeTool(block.name, block.input);
      } catch (err) {
        console.error(`Помилка інструменту ${block.name}:`, err.message);
        result = `Помилка: ${err.message}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    apiMessages.push({ role: 'assistant', content: response.content });
    apiMessages.push({ role: 'user',      content: toolResults });
  }

  return 'Не вдалося завершити обробку запиту (перевищено ліміт кроків).';
}

// ─── Core message handler (shared by text and voice) ─────────────────────────

// useVoice: true when the user sent a voice message (drives text-vs-voice reply logic)
async function handleMessage(ctx, userMessage, useVoice = false) {
  const userId = ctx.from.id;

  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  history.push({ role: 'user', content: userMessage });
  await ctx.sendChatAction('typing');

  try {
    const assistantMessage = await processWithClaude(history, async (toolName) => {
      await ctx.sendChatAction('typing').catch(() => {});
      if (TOOL_LABELS[toolName]) await ctx.reply(TOOL_LABELS[toolName]).catch(() => {});
    });

    // Store only the final text — no tool-use blocks in persistent history
    history.push({ role: 'assistant', content: assistantMessage });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    await sendReply(ctx, assistantMessage, useVoice);

    // Extract and save any new facts in the background (never blocks the reply)
    extractAndSaveMemory(userMessage, assistantMessage).catch(err =>
      console.error('🧠 extractAndSaveMemory помилка:', err.message)
    );
  } catch (error) {
    history.pop();
    console.error('Помилка API:', error.message);
    if (error.status === 401)      await ctx.reply('❌ Невірний API ключ Anthropic. Перевірте .env файл.');
    else if (error.status === 429) await ctx.reply('⏳ Перевищено ліміт запитів. Спробуйте через кілька секунд.');
    else                           await ctx.reply('❌ Виникла помилка. Спробуйте ще раз пізніше.');
  }
}

// ─── Bot commands ─────────────────────────────────────────────────────────────

bot.start((ctx) => {
  conversationHistory.delete(ctx.from.id);
  const icon = (key) => process.env[key] ? '✅' : '❌';
  ctx.reply(
    'Привіт! 👋 Я асистент на базі Claude AI.\n\n' +
    `Веб-пошук: ${icon('TAVILY_API_KEY')}  ClickUp: ${icon('CLICKUP_API_KEY')}  Голос: ${icon('OPENAI_API_KEY')}/${icon('ELEVENLABS_API_KEY')}\n\n` +
    'Можна писати текстом, надсилати голосові повідомлення або фото.\n' +
    'При голосовому вводі відповідь також озвучується.\n\n' +
    'Команди:\n' +
    '/start — почати спочатку\n' +
    '/clear — очистити історію\n' +
    '/history — кількість повідомлень у пам\'яті\n' +
    '/memory — що Мія пам\'ятає про вас (по категоріях)\n' +
    '/compress — стиснути і прибрати дублі в пам\'яті\n' +
    '/forget — видалити факт з пам\'яті\n' +
    '/testvoice — перевірити голосові відповіді (ElevenLabs)\n' +
    '/myid — показати ваш Telegram ID (для дайджестів)\n' +
    '/testdigest — надіслати обидва дайджести зараз'
  );
});

// /testvoice — test ElevenLabs TTS end-to-end and report exactly what fails
bot.command('testvoice', async (ctx) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    await ctx.reply('❌ ELEVENLABS_API_KEY не задано у .env файлі.');
    return;
  }

  const maskedKey = `${key.slice(0, 6)}...${key.slice(-4)}`;
  await ctx.reply(`🔑 ElevenLabs ключ завантажено: ${maskedKey}\n🎙 Голос: Anika (${ELEVENLABS_VOICE_ID})\nМодель: eleven_multilingual_v2\n\nГенерую тестову фразу...`);
  await ctx.sendChatAction('record_voice');

  try {
    const audioBuffer = await textToSpeech('Привіт! Це Мія. Голосові відповіді працюють.');
    await ctx.reply(`✅ ElevenLabs повернув ${audioBuffer.length} байт аудіо. Надсилаю...`);
    await ctx.replyWithVoice({ source: audioBuffer, filename: 'voice.mp3' });
    await ctx.reply('✅ Готово!');
  } catch (err) {
    await ctx.reply(
      `❌ Помилка ElevenLabs:\n${err.message}\n\n` +
      `Перевірте:\n` +
      `• Чи дійсний ELEVENLABS_API_KEY\n` +
      `• Чи не вичерпано ліміт символів на акаунті`
    );
  }
});

// /myid — show the user their Telegram ID so they can set TELEGRAM_USER_ID in .env
bot.command('myid', (ctx) => {
  const id = ctx.from.id;
  const digestStatus = OWNER_ID === id
    ? '✅ Ваш ID вже задано в .env — дайджести активні.'
    : `➡️ Щоб увімкнути дайджести, додайте у .env:\nTELEGRAM_USER_ID=${id}`;
  ctx.reply(`🪪 Ваш Telegram ID: <code>${id}</code>\n\n${digestStatus}`, { parse_mode: 'HTML' });
});

bot.command('testdigest', async (ctx) => {
  if (!OWNER_ID) {
    await ctx.reply('❌ TELEGRAM_USER_ID не задано у .env — дайджести вимкнено.');
    return;
  }
  if (!process.env.CLICKUP_API_KEY) {
    await ctx.reply('❌ CLICKUP_API_KEY не задано — немає звідки брати задачі.');
    return;
  }
  await ctx.reply('📤 Надсилаю тестові дайджести...');
  await sendMorningDigest();
  await sendEveningDigest();
  await ctx.reply('✅ Готово! Перевірте повідомлення вище.');
});

// /memory — show all remembered facts organized by category
bot.command('memory', async (ctx) => {
  const { categories, updatedAt } = await loadMemory();
  const items = flattenMemory(categories);

  if (!items.length) {
    await ctx.reply('🧠 Пам\'ять порожня — ще нічого не збережено.');
    return;
  }

  let counter = 1;
  const sections = CATEGORIES
    .filter(cat => (categories[cat] ?? []).length)
    .map(cat => {
      const lines = categories[cat].map(f => `${counter++}. ${f}`);
      return `${CAT_LABELS[cat]} (${categories[cat].length}):\n${lines.join('\n')}`;
    });

  const updated = updatedAt
    ? `\n\n_Оновлено: ${new Date(updatedAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}_`
    : '';

  const fullText = `🧠 Пам'ять Міі (${items.length}):\n\n` + sections.join('\n\n') + updated;
  for (const chunk of splitMessage(fullText)) {
    await ctx.reply(chunk);
  }
});

// /compress — manually trigger memory compression and de-duplication
bot.command('compress', async (ctx) => {
  const { categories } = await loadMemory();
  const total = CATEGORIES.reduce((s, c) => s + (categories[c]?.length ?? 0), 0);
  if (!total) {
    await ctx.reply('🧠 Пам\'ять порожня — нема чого стискати.');
    return;
  }
  await ctx.reply(`🔄 Оптимізую пам\'ять (${total} фактів)...`);
  const compressed = await compressAndCategorize(categories);
  await saveMemory({ categories: compressed });
  const newTotal = CATEGORIES.reduce((s, c) => s + (compressed[c]?.length ?? 0), 0);
  await ctx.reply(`✅ Готово! ${total} → ${newTotal} фактів.`);
});

// /forget [number|keyword|all] — remove specific fact(s) or clear all
bot.command('forget', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const { categories } = await loadMemory();
  const items = flattenMemory(categories);

  if (!items.length) {
    await ctx.reply('🧠 Пам\'ять вже порожня.');
    return;
  }

  if (!arg) {
    await ctx.reply(
      '❓ Вкажи що забути:\n' +
      '/forget all — очистити всю пам\'ять\n' +
      '/forget 3 — видалити факт №3\n' +
      '/forget слово — видалити факти, що містять це слово'
    );
    return;
  }

  if (arg.toLowerCase() === 'all' || arg.toLowerCase() === 'все') {
    await saveMemory({ categories: emptyCategories() });
    await ctx.reply('🗑 Пам\'ять повністю очищено.');
    return;
  }

  const num = parseInt(arg, 10);
  if (!isNaN(num) && num >= 1 && num <= items.length) {
    const { cat, text } = items[num - 1];
    const newCategories = { ...categories, [cat]: categories[cat].filter(f => f !== text) };
    await saveMemory({ categories: newCategories });
    await ctx.reply(`🗑 Видалено факт №${num}:\n"${text}"`);
    return;
  }

  // Keyword removal across all categories
  const keyword = arg.toLowerCase();
  let removed = 0;
  const newCategories = {};
  for (const cat of CATEGORIES) {
    const before = (categories[cat] ?? []).length;
    newCategories[cat] = (categories[cat] ?? []).filter(f => !f.toLowerCase().includes(keyword));
    removed += before - newCategories[cat].length;
  }
  if (removed === 0) {
    await ctx.reply(`🔍 Фактів зі словом "${arg}" не знайдено.`);
    return;
  }
  await saveMemory({ categories: newCategories });
  await ctx.reply(`🗑 Видалено ${removed} факт(ів) зі словом "${arg}".`);
});

bot.command('clear', (ctx) => {
  conversationHistory.delete(ctx.from.id);
  ctx.reply('✅ Історію розмови очищено.');
});

bot.command('history', (ctx) => {
  const count = conversationHistory.get(ctx.from.id)?.length ?? 0;
  ctx.reply(`📝 У пам'яті ${count} повідомлень (максимум ${MAX_HISTORY}).`);
});

// ─── Text message handler ─────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  // If the owner is responding to a memory review prompt, handle it specially
  if (memoryReviewPending && ctx.from.id === OWNER_ID) {
    memoryReviewPending = false;
    await handleMemoryReviewResponse(ctx, ctx.message.text);
    return;
  }
  await handleMessage(ctx, ctx.message.text, false);
});

// ─── Voice message handler ────────────────────────────────────────────────────

bot.on('voice', async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply('❌ OPENAI_API_KEY не задано — розпізнавання голосу недоступне.');
    return;
  }

  await ctx.sendChatAction('typing');

  let transcript;
  try {
    const audioBuffer = await downloadTelegramFile(ctx.message.voice.file_id);
    transcript = await transcribeAudio(audioBuffer);
  } catch (err) {
    console.error('Whisper помилка:', err.message);
    await ctx.reply('❌ Не вдалося розпізнати голосове повідомлення. Спробуйте ще раз.');
    return;
  }

  if (!transcript?.trim()) {
    await ctx.reply('Голосове повідомлення порожнє або нерозбірливе. Спробуйте ще раз.');
    return;
  }

  // Show the transcript so user can confirm what was heard
  await ctx.reply(`🎙 Розпізнано: "${transcript}"`);

  // Process through Claude and reply with text + voice
  await handleMessage(ctx, transcript, true);
});

// ─── Photo / image handler ────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const caption = ctx.message.caption?.trim() ?? '';

  await ctx.sendChatAction('typing');

  // Telegram sends multiple sizes — pick the largest
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  let imageBuffer;
  try {
    imageBuffer = await downloadTelegramFile(photo.file_id);
  } catch (err) {
    console.error('Помилка завантаження фото:', err.message);
    await ctx.reply('❌ Не вдалося завантажити фото. Спробуй ще раз.');
    return;
  }

  // Build Claude vision content block: image + optional caption
  const userContent = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: imageBuffer.toString('base64'),
      },
    },
    {
      type: 'text',
      text: caption || 'Що тут?',
    },
  ];

  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  history.push({ role: 'user', content: userContent });

  try {
    const assistantMessage = await processWithClaude(history, async (toolName) => {
      await ctx.sendChatAction('typing').catch(() => {});
      if (TOOL_LABELS[toolName]) await ctx.reply(TOOL_LABELS[toolName]).catch(() => {});
    });

    history.push({ role: 'assistant', content: assistantMessage });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    await sendReply(ctx, assistantMessage, false);

    // Pass caption (or placeholder) to memory extraction
    extractAndSaveMemory(caption || '[фото без підпису]', assistantMessage).catch(err =>
      console.error('🧠 extractAndSaveMemory помилка:', err.message)
    );
  } catch (error) {
    history.pop();
    console.error('Помилка аналізу фото:', error.message);
    if (error.status === 401)      await ctx.reply('❌ Невірний API ключ Anthropic.');
    else if (error.status === 429) await ctx.reply('⏳ Перевищено ліміт запитів.');
    else                           await ctx.reply('❌ Не вдалося проаналізувати фото. Спробуй ще раз.');
  }
});

// ─── Message chunking helper ──────────────────────────────────────────────────

// Split a long string into ≤4096-char chunks, breaking on newlines where possible.
function splitMessage(text, maxLen = 4096) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
        current = '';
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── Catch-all for unsupported message types ──────────────────────────────────

bot.on('message', (ctx) => {
  ctx.reply('Надішли текст, голосове або фото — розберемось 😊');
});

// ─── Launch ───────────────────────────────────────────────────────────────────

initDb().then(() => bot.launch({ dropPendingUpdates: true })).then(async () => {
  console.log('✅ Telegram-бот запущено!');
  console.log(`🔍 Веб-пошук (Tavily):     ${process.env.TAVILY_API_KEY  ? 'увімкнено' : 'вимкнено'}`);
  console.log(`📋 ClickUp:                ${process.env.CLICKUP_API_KEY ? 'увімкнено' : 'вимкнено'}`);
  console.log(`🎙 Whisper STT (OpenAI):    ${process.env.OPENAI_API_KEY     ? 'увімкнено' : 'вимкнено'}`);
  console.log(`🔊 ElevenLabs TTS (Anika):  ${process.env.ELEVENLABS_API_KEY ? 'увімкнено' : 'вимкнено'}`);
  console.log(`👤 Власник (дайджести):     ${OWNER_ID ? `ID ${OWNER_ID}` : 'не задано'}`);
  const { categories } = await loadMemory();
  const factCount = CATEGORIES.reduce((s, c) => s + (categories[c]?.length ?? 0), 0);
  console.log(`🧠 Пам'ять:                 ${factCount} фактів по ${CATEGORIES.length} категоріях (PostgreSQL)`);
  console.log('Натисніть Ctrl+C для зупинки.');
  startScheduler();
}).catch(err => {
  console.error('Помилка запуску:', err.message);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
