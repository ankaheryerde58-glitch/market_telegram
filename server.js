
require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const {
  BOT_TOKEN,
  ADMIN_BOT_TOKEN,
  ADMIN_ID,
  DB_PATH = "./data/anka-market.db"
} = process.env;

if (!BOT_TOKEN || !ADMIN_BOT_TOKEN || !ADMIN_ID) {
  throw new Error("BOT_TOKEN, ADMIN_BOT_TOKEN ve ADMIN_ID zorunludur.");
}

const adminId = Number(ADMIN_ID);
if (!Number.isSafeInteger(adminId) || adminId <= 0) {
  throw new Error("ADMIN_ID geçerli bir Telegram kullanıcı ID'si olmalı.");
}

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  receipt_message_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  reference_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const customerBot = new Telegraf(BOT_TOKEN);
const adminBot = new Telegraf(ADMIN_BOT_TOKEN);

const depositSessions = new Map();

const products = [
  { flag: "🇺🇸", name: "ABD İşletme Hattı", price: 100 },
  { flag: "🇨🇴", name: "Kolombiya İşletme Hattı", price: 100 },
  { flag: "🇹🇷", name: "Türkiye İşletme Hattı", price: 150 }
];

function saveUser(user) {
  db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(
    user.id,
    user.username || null,
    user.first_name || "Müşteri"
  );
}

function getUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === adminId;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛍 ÜRÜN KATALOĞU", "catalog")],
    [Markup.button.callback("👛 CÜZDANIM", "wallet")],
    [Markup.button.callback("💳 BAKİYE YÜKLE", "deposit")],
    [Markup.button.callback("📋 ÖDEME GEÇMİŞİ", "history")],
    [Markup.button.callback("👑 YÖNETİCİ", "contact_admin")]
  ]);
}

// MÜŞTERİ BOTU

customerBot.start((ctx) => {
  saveUser(ctx.from);

  return ctx.reply(
    `✦ A N K A   M A R K E T ✦

PREMIUM DIGITAL STORE

Hoş geldin ${ctx.from.first_name}.

Güvenli alışveriş ve müşteri desteği için ANKA MARKET'e hoş geldin.

Aşağıdaki menüden işlem seçebilirsin.`,
    mainMenu()
  );
});

customerBot.action("catalog", async (ctx) => {
  await ctx.answerCbQuery();

  const list = products.map(p =>
    `${p.flag} ${p.name}\n💰 ${p.price} TL`
  ).join("\n\n");

  await ctx.reply(
    `✦ ANKA MARKET KATALOĞU ✦\n\n${list}\n\nBu katalog yalnızca yasal işletme hatları içindir. Ürün satın alma özelliği henüz etkin değildir.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("◀ ANA MENÜ", "home")]
    ])
  );
});

customerBot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("✦ ANKA MARKET ANA MENÜ", mainMenu());
});

customerBot.action("wallet", async (ctx) => {
  await ctx.answerCbQuery();

  saveUser(ctx.from);
  const user = getUser(ctx.from.id);

  await ctx.reply(
    `👛 ANKA CÜZDAN

💰 Kullanılabilir bakiye:
${(user.balance / 100).toFixed(2)} TL

Cüzdan işlemlerin güvenli şekilde kayıt altında tutulur.`
  );
});

customerBot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  depositSessions.set(ctx.from.id, { step: "amount" });

  await ctx.reply(
    `💳 BAKİYE YÜKLEME

Hesap sahibi: Resul Sakal

IBAN:
TR62 0006 2000 5000 0006 8107 73

Yüklemek istediğin tutarı TL olarak yaz.

Örnek: 500

Minimum yükleme: 50 TL`
  );
});

customerBot.action("history", async (ctx) => {
  await ctx.answerCbQuery();

  const payments = db.prepare(`
    SELECT id, amount, status, created_at
    FROM payments
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(ctx.from.id);

  if (!payments.length) {
    return ctx.reply("Henüz ödeme talebin bulunmuyor.");
  }

  const text = payments.map(p => {
    const status = {
      pending: "⏳ İnceleniyor",
      approved: "✅ Onaylandı",
      rejected: "❌ Reddedildi"
    }[p.status];

    return `#${p.id} — ${p.amount} TL\n${status}`;
  }).join("\n\n");

  await ctx.reply(`📋 ÖDEME GEÇMİŞİ\n\n${text}`);
});

customerBot.action("contact_admin", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "👑 ANKA MARKET YÖNETİM\n\nDestek ve ödeme işlemleri için @sonpatronn"
  );
});

// BAKİYE TUTARI ALMA

customerBot.on("text", async (ctx) => {
  const session = depositSessions.get(ctx.from.id);
  if (!session || session.step !== "amount") return;

  const amount = Number(ctx.message.text.trim());

  if (
    !Number.isSafeInteger(amount) ||
    amount < 50 ||
    amount > 100000
  ) {
    return ctx.reply(
      "Geçersiz tutar. 50 ile 100000 TL arasında tam sayı yaz."
    );
  }

  session.amount = amount;
  session.step = "receipt";

  await ctx.reply(
    `💳 ÖDEME BİLGİLERİ

Tutar: ${amount} TL
Alıcı: Resul Sakal

IBAN:
TR62 0006 2000 5000 0006 8107 73

Transferini yaptıktan sonra dekontun fotoğrafını gönder.

Ödemen, yönetici tarafından kontrol edilecektir.`
  );
});

// DEKONT ALMA

customerBot.on("photo", async (ctx) => {
  const session = depositSessions.get(ctx.from.id);

  if (!session || session.step !== "receipt") {
    return ctx.reply("Önce bakiye yükleme talebi oluşturmalısın.");
  }

  const amount = session.amount;
  const user = ctx.from;

  const result = db.prepare(`
    INSERT INTO payments (user_id, amount, status)
    VALUES (?, ?, 'pending')
  `).run(user.id, amount);

  const paymentId = Number(result.lastInsertRowid);

  depositSessions.delete(user.id);

  saveUser(user);

  try {
    await adminBot.telegram.sendMessage(
      adminId,
      `✦ ANKA MARKET ÖDEME TALEBİ

Talep: #${paymentId}
Müşteri: ${user.first_name}
Kullanıcı: ${user.username ? "@" + user.username : "Yok"}
Telegram ID: ${user.id}
Tutar: ${amount} TL

Dekont aşağıdaki mesajdadır.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ ÖDEMEYİ ONAYLA",
            `approve_${paymentId}`
          )
        ],
        [
          Markup.button.callback(
            "❌ ÖDEMEYİ REDDET",
            `reject_${paymentId}`
          )
        ]
      ])
    );

    const photo = ctx.message.photo.at(-1).file_id;

    await adminBot.telegram.sendPhoto(adminId, photo, {
      caption: `Ödeme dekontu #${paymentId}`
    });

    await ctx.reply(
      `✅ Dekontun yöneticiye iletildi.

Talep numaran: #${paymentId}

Ödeme kontrol edildikten sonra bakiyen yüklenecek.`
    );

  } catch (error) {
    console.error("Dekont iletim hatası:", error);

    await ctx.reply(
      "Dekont kaydedildi ancak yöneticiye iletilemedi. Lütfen destekle iletişime geç."
    );
  }
});

// ADMIN BOTU

adminBot.start(async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("Yetkiniz bulunmuyor.");
  }

  await ctx.reply(
    `✦ A N K A   ADMIN ✦

YÖNETİM PANELİ

Hoş geldin yönetici.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💳 BEKLEYEN ÖDEMELER", "pending")],
      [Markup.button.callback("👥 MÜŞTERİLER", "customers")],
      [Markup.button.callback("📊 İSTATİSTİKLER", "stats")]
    ])
  );
});

// ÖDEME ONAYI - ATOMİK İŞLEM

adminBot.action(/^approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz işlem.");

  const id = Number(ctx.match[1]);

  const approve = db.transaction(() => {
    const payment = db.prepare(
      "SELECT * FROM payments WHERE id = ?"
    ).get(id);

    if (!payment || payment.status !== "pending") {
      return null;
    }

    db.prepare(`
      UPDATE payments
      SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(id);

    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(payment.amount * 100, payment.user_id);

    db.prepare(`
      INSERT INTO transactions (user_id, amount, type, reference_id)
      VALUES (?, ?, 'deposit', ?)
    `).run(payment.user_id, payment.amount * 100, id);

    return payment;
  });

  const payment = approve();

  if (!payment) {
    return ctx.answerCbQuery("Bu talep daha önce işlenmiş.");
  }

  await ctx.answerCbQuery("Ödeme onaylandı.");

  await ctx.editMessageText(
    `✅ ÖDEME ONAYLANDI

Talep: #${id}
Müşteri ID: ${payment.user_id}
Yüklenen bakiye: ${payment.amount} TL`
  );

  await customerBot.telegram.sendMessage(
    payment.user_id,
    `✅ ÖDEMEN ONAYLANDI

${payment.amount} TL bakiyen cüzdanına eklendi.

İyi alışverişler.
✦ ANKA MARKET`
  );
});

// ÖDEME REDDİ

adminBot.action(/^reject_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz işlem.");

  const id = Number(ctx.match[1]);

  const payment = db.prepare(`
    UPDATE payments
    SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
    RETURNING *
  `).get(id);

  if (!payment) {
    return ctx.answerCbQuery("Talep zaten işlenmiş.");
  }

  await ctx.answerCbQuery("Ödeme reddedildi.");

  await ctx.editMessageText(
    `❌ ÖDEME REDDEDİLDİ

Talep: #${id}
Müşteri ID: ${payment.user_id}
Tutar: ${payment.amount} TL`
  );

  await customerBot.telegram.sendMessage(
    payment.user_id,
    `❌ ÖDEME TALEBİN REDDEDİLDİ.

Talep numarası: #${id}

Lütfen @sonpatronn üzerinden iletişime geç.`
  );
});

// BEKLEYEN ÖDEMELER

adminBot.action("pending", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const rows = db.prepare(`
    SELECT * FROM payments
    WHERE status = 'pending'
    ORDER BY id DESC LIMIT 20
  `).all();

  if (!rows.length) {
    return ctx.reply("Bekleyen ödeme bulunmuyor.");
  }

  for (const p of rows) {
    await ctx.reply(
      `Talep #${p.id}
Müşteri: ${p.user_id}
Tutar: ${p.amount} TL`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Onayla", `approve_${p.id}`),
          Markup.button.callback("❌ Reddet", `reject_${p.id}`)
        ]
      ])
    );
  }
});

// MÜŞTERİLER

adminBot.action("customers", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const users = db.prepare(`
    SELECT id, username, first_name, balance
    FROM users
    ORDER BY created_at DESC
    LIMIT 30
  `).all();

  if (!users.length) return ctx.reply("Henüz müşteri yok.");

  const text = users.map(u =>
    `${u.first_name || "Müşteri"} | ${u.username ? "@" + u.username : "@" + u.id}
Bakiye: ${(u.balance / 100).toFixed(2)} TL
ID: ${u.id}`
  ).join("\n\n");

  await ctx.reply(`👥 MÜŞTERİ LİSTESİ\n\n${text}`);
});

// İSTATİSTİKLER

adminBot.action("stats", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const users = db.prepare(
    "SELECT COUNT(*) AS total FROM users"
  ).get().total;

  const pending = db.prepare(
    "SELECT COUNT(*) AS total FROM payments WHERE status='pending'"
  ).get().total;

  const approved = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status='approved'"
  ).get().total;

  await ctx.reply(
    `📊 ANKA MARKET RAPORU

👥 Müşteri: ${users}
⏳ Bekleyen ödeme: ${pending}
💰 Onaylanan toplam yükleme: ${approved} TL`
  );
});

// HATA YÖNETİMİ

customerBot.catch((err) => console.error("Müşteri botu:", err));
adminBot.catch((err) => console.error("Admin botu:", err));

async function start() {
  await customerBot.launch();
  await adminBot.launch();

  console.log("ANKA MARKET müşteri botu aktif.");
  console.log("ANKA MARKET admin botu aktif.");
}

start().catch((err) => {
  console.error("Başlatma hatası:", err);
  process.exit(1);
});

process.once("SIGINT", () => {
  customerBot.stop("SIGINT");
  adminBot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  customerBot.stop("SIGTERM");
  adminBot.stop("SIGTERM");
});
