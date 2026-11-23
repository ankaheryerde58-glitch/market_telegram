
require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const Database = require("better-sqlite3");

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN eksik!");
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Database("anka-market.db");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount REAL,
  status TEXT DEFAULT 'pending'
);
`);

const ADMIN_ID = Number(process.env.ADMIN_ID);

const products = [
  ["🇺🇸", "ABD İşletme Numarası", 100],
  ["🇨🇴", "Kolombiya İşletme Numarası", 100],
  ["🇹🇷", "Türkiye İşletme Numarası", 150]
];

function getUser(id) {
  db.prepare(
    "INSERT OR IGNORE INTO users (id) VALUES (?)"
  ).run(id);

  return db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).get(id);
}

bot.start((ctx) => {
  getUser(ctx.from.id);

  ctx.reply(
    "🖤 ANKA MARKET\n\nVIP Dijital Mağazaya Hoş Geldin.\n\nNe yapmak istersin?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🛍 Ürünler", "products")],
      [Markup.button.callback("👛 Cüzdanım", "wallet")],
      [Markup.button.callback("💳 Bakiye Yükle", "deposit")],
      [Markup.button.callback("📦 Siparişlerim", "orders")]
    ])
  );
});

bot.action("products", async (ctx) => {
  await ctx.answerCbQuery();

  const buttons = products.map((p, i) => [
    Markup.button.callback(
      `${p[0]} ${p[1]} — ${p[2]} TL`,
      `product_${i}`
    )
  ]);

  await ctx.reply(
    "🛍 ANKA MARKET ÜRÜNLERİ",
    Markup.inlineKeyboard(buttons)
  );
});

bot.action("wallet", async (ctx) => {
  await ctx.answerCbQuery();

  const user = getUser(ctx.from.id);

  await ctx.reply(
    `👛 CÜZDANIM\n\nBakiye: ${user.balance.toFixed(2)} TL`
  );
});

bot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "💳 BAKİYE YÜKLEME\n\nHavale/EFT ile ödeme talebi oluşturmak için yöneticimizle iletişime geçin."
  );
});

bot.action("orders", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "📦 Sipariş geçmişiniz henüz bulunmuyor."
  );
});

bot.action(/^product_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const product = products[Number(ctx.match[1])];

  if (!product) return;

  await ctx.reply(
    `${product[0]} ${product[1]}\nFiyat: ${product[2]} TL\n\nBu ürün için henüz satın alma etkinleştirilmedi.`
  );
});

bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("Yetkiniz bulunmuyor.");
  }

  await ctx.reply(
    "⚙️ ANKA MARKET ADMIN\n\nYönetim paneline hoş geldiniz."
  );
});

bot.catch((err) => {
  console.error("Bot hatası:", err);
});

bot.launch();

console.log("ANKA MARKET çalışıyor.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
