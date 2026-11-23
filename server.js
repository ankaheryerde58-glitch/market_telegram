const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_ID;

if (!token || !adminId) {
  throw new Error("BOT_TOKEN ve ADMIN_ID ortam değişkenleri gerekli.");
}

const app = express();

app.get("/", (_req, res) => {
  res.send("ANKA MARKET botu çalışıyor.");
});

app.listen(process.env.PORT || 3000, "0.0.0.0");

const bot = new TelegramBot(token, { polling: true });

const products = [
  { id: "urun1", name: "Örnek Dijital Ürün", price: "100 TL" },
  { id: "urun2", name: "Başka Bir Dijital Ürün", price: "150 TL" },
];

bot.onText(/^\/start$/, async (msg) => {
  const buttons = products.map((product) => [
    {
      text: `${product.name} — ${product.price}`,
      callback_data: `order:${product.id}`,
    },
  ]);

  await bot.sendMessage(msg.chat.id, "ANKA MARKET'e hoş geldin. Ürün seç:", {
    reply_markup: { inline_keyboard: buttons },
  });
});

bot.on("callback_query", async (query) => {
  const product = products.find(
    (item) => query.data === `order:${item.id}`
  );

  if (!product) {
    await bot.answerCallbackQuery(query.id, { text: "Ürün bulunamadı." });
    return;
  }

  const user = query.from;
  const username = user.username ? `@${user.username}` : "Kullanıcı adı yok";

  try {
    await bot.sendMessage(
      adminId,
      [
        "Yeni sipariş talebi",
        `Ürün: ${product.name}`,
        `Fiyat: ${product.price}`,
        `Müşteri: ${user.first_name}`,
        `Kullanıcı adı: ${username}`,
        `Telegram ID: ${user.id}`,
      ].join("\n")
    );

    await bot.answerCallbackQuery(query.id, {
      text: "Sipariş talebin iletildi.",
    });

    await bot.sendMessage(
      query.message.chat.id,
      "Sipariş talebin alındı. Ödeme ve teslimat için yönetici seninle iletişime geçecek."
    );
  } catch (error) {
    console.error("Sipariş gönderilemedi:", error.message);
    await bot.answerCallbackQuery(query.id, {
      text: "Talep gönderilemedi. Daha sonra tekrar dene.",
    });
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram bağlantı hatası:", error.message);
});

console.log("ANKA MARKET botu çalışıyor.");
