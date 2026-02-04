require("dotenv").config();
const { Bot, GrammyError, HttpError } = require("grammy");
const { hydrate } = require("@grammyjs/hydrate");
const https = require("https");
const { TRIGGER_WORDS } = require("./config");

const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());

// ─── Промпты ────────────────────────────────────────────────────────────────
const SYSTEM_BASE =
    "Ты — дерзкий, ёбаный в рот тролл-бот в telegram-чате друзей. " +
    "Отвечай максимально жёстко, смешно и по-русски. " +
    "Иногда вставляй эмодзи какашки 💩. " +
    "Ответ должен быть коротким — не больше 2-3 предложений. " +
    "Не будь вежливым, не извиняйся.";

const PROMPTS = {
    trigger: (text) => ({ system: SYSTEM_BASE, user: text }),
    attack: (nick) => ({
        system: SYSTEM_BASE,
        user: `Облажай и унизь человека с ником @${nick} так, чтобы было смешно и больно.`,
    }),
    reply: (text) => ({
        system: SYSTEM_BASE + " Тебя провокируют — отвечай ещё злее и смешнее.",
        user: text,
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
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
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
async function replyWithGroq(ctx, prompt) {
    try {
        const text = await askGroq(prompt);
        await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
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

    // реплу на сообщение бота — отвечаем
    if (ctx.message.reply_to_message?.from?.id === botUser.id) {
        await replyWithGroq(ctx, PROMPTS.reply(ctx.message.text));
        return;
    }

    // триггерные слова или @упоминание бота
    if (!isTrigger(ctx.message.text, botUser.username)) return;
    await replyWithGroq(ctx, PROMPTS.trigger(ctx.message.text));
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
