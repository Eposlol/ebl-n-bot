require("dotenv").config();
const { Bot, GrammyError, HttpError } = require("grammy");
const { hydrate } = require("@grammyjs/hydrate");
const https = require("https");
const { TRIGGER_WORDS, HISTORY_LIMIT } = require("./config");

const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());

// ─── Chat history ───────────────────────────────────────────────────────────
const chatHistory = new Map();

function addToHistory(chatId, from, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ from, text });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

function getHistoryContext(chatId) {
    const history = chatHistory.get(chatId);
    if (!history || history.length === 0) return "";
    return (
        "[Контекст последних сообщений в чате:]\n" +
        history.map((m) => `@${m.from}: ${m.text}`).join("\n") +
        "\n"
    );
}

// ─── Промпты ────────────────────────────────────────────────────────────────
const SYSTEM_BASE =
    // "Ты — дерзкий, ёбаный в рот тролл-бот в telegram-чате друзей. " +
    // "Отвечай максимально жёстко, смешно и по-русски. " +
    // "Иногда вставляй эмодзи какашки 💩. " +
    // "Ответ должен быть коротким — не больше 2-3 предложений. " +
    // "Не будь вежливым, не извиняйся.";

    "Ты высококультурный индивид - как Тони Старк." +
    "Выражаешься на русском." +
    "Можешь красиво унизить человека, так чтобы было смешно и больно, так чтобы он не понял что ты унизил его." +
    "Можешь цитировать классиков или рассказывать популярные смешные анекдоты про евреев и айтишников." +
    "Давать советы как должен жить человек." +
    "Отвечай коротко не больше 2-3 предложений и смешно.";

const PROMPTS = {
    trigger: (text, context) => ({
        system: SYSTEM_BASE,
        user: context
            ? context + "\n[Сообщение на которое нужно отреагировать:]\n" + text
            : text,
    }),
    attack: (nick) => ({
        system: SYSTEM_BASE,
        user: `Облажай и унизь человека с ником @${nick} так, чтобы было смешно и больно.`,
    }),
    reply: (text, context) => ({
        system: SYSTEM_BASE + " Тебя провокируют — отвечай ещё злее и смешнее.",
        user: context
            ? context + "\n[Сообщение на которое нужно отреагировать:]\n" + text
            : text,
    }),
};

// ─── Groq helper ────────────────────────────────────────────────────────────
async function askGroq({ system, user }) {
    const body = JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
        max_tokens: 150,
    });

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "api.groq.com",
                path: "/openai/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    try {
                        const data = Buffer.concat(chunks).toString("utf-8");
                        const json = JSON.parse(data);
                        if (!json.choices) {
                            reject(new Error("Groq response: " + data));
                            return;
                        }
                        resolve(json.choices[0].message.content);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── Trigger check ──────────────────────────────────────────────────────────
function isTrigger(text, botUsername) {
    if (!text) return false;
    const lower = text.toLowerCase();

    // direct mention of the bot
    if (botUsername && lower.includes(`@${botUsername.toLowerCase()}`)) return true;

    // any trigger word present
    return TRIGGER_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

// ─── Helper: ответить через Groq ────────────────────────────────────────────
async function replyWithGroq(ctx, prompt, chatId) {
    try {
        const text = await askGroq(prompt);
        console.log(text);
        await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
        if (chatId) addToHistory(chatId, "Ebl@n", text);
    } catch (e) {
        console.error("Groq error:", e);
        await ctx.reply("💩 кончились мозги, попробуй позже");
    }
}

// ─── /attack <ник> ──────────────────────────────────────────────────────────
bot.command("attack", async (ctx) => {
    if (ctx.chat.type === "private") return;

    const nick = ctx.match?.trim();
    if (!nick) {
        await ctx.reply("Укажи ник: /attack @кто-то");
        return;
    }
    await replyWithGroq(ctx, PROMPTS.attack(nick));
});

// ─── Main handler ───────────────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
    // личка — только приветствие
    if (ctx.chat.type === "private") {
        await ctx.reply(
            "Привет 👋\n\n" +
            "Я — Ebl@n, тролл-бот для групповых чатов.\n" +
            "Закинуть меня в чат и дай права админа — там я и развернусь 💩"
        );
        return;
    }

    const botUser = await bot.api.getMe();
    const chatId = ctx.chat.id;
    const from = ctx.message.from?.first_name || ctx.message.from?.username || "user";

    // реплу на сообщение бота — отвечаем
    if (ctx.message.reply_to_message?.from?.id === botUser.id) {
        addToHistory(chatId, from, ctx.message.text);
        const context = getHistoryContext(chatId);
        await replyWithGroq(ctx, PROMPTS.reply(ctx.message.text, context), chatId);
        return;
    }

    // триггерные слова или @упоминание бота
    if (!isTrigger(ctx.message.text, botUser.username)) return;
    addToHistory(chatId, from, ctx.message.text);
    const context = getHistoryContext(chatId);
    await replyWithGroq(ctx, PROMPTS.trigger(ctx.message.text, context), chatId);
});

// ─── Error handler ──────────────────────────────────────────────────────────
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
        console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
        console.error("Could not contact Telegram:", e);
    } else {
        console.error("Unknown error:", e);
    }
});

bot.start();
console.log("Ebl@n bot started.");
