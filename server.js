
require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const Database = require("better-sqlite3");

const {
  BOT_TOKEN,
  ADMIN_BOT_TOKEN,
  ADMIN_ID,
  DB_PATH = "/tmp/anka-market.db",
  PORT = 10000
} = process.env;

if (!BOT_TOKEN || !ADMIN_BOT_TOKEN || !ADMIN_ID) {
  throw new Error("BOT_TOKEN, ADMIN_BOT_TOKEN ve ADMIN_ID gerekli.");
}

const adminId = Number(ADMIN_ID);

if (!Number.isSafeInteger(adminId) || adminId <= 0) {
  throw new Error("ADMIN_ID hatalı.");
}

// HTTP SERVER
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ANKA MARKET ONLINE");
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log("ANKA MARKET HTTP aktif.");
});

// DATABASE
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

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
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
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
const sessions = new Map();

const BRAND = "✦ A N K A   M A R K E T ✦";

const countries = {
  us: { flag: "🇺🇸", name: "ABD", description: "Amerika Birleşik Devletleri" },
  co: { flag: "🇨🇴", name: "KOLOMBİYA", description: "Kolombiya" },
  tr: { flag: "🇹🇷", name: "TÜRKİYE", description: "Türkiye" }
};

function money(amount) {
  return (amount / 100).toFixed(2) + " TL";
}

function saveUser(user) {
  db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name
  `).run(user.id, user.username || null, user.first_name || "Müşteri");
}

function getUser(id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === adminId;
}

function mainMenu(userId) {
  const user = getUser(userId);
  const balance = user ? money(user.balance) : "0.00 TL";

  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 SANAL NUMARALAR", "catalog")],
    [
      Markup.button.callback("👛 CÜZDANIM", "wallet"),
      Markup.button.callback("💳 BAKİYE YÜKLE", "deposit")
    ],
    [Markup.button.callback("📋 İŞLEMLERİM", "history")],
    [Markup.button.url("👑 YÖNETİCİ DESTEĞİ", "https://t.me/sonpatronn")]
  ]);
}

function backMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("◀ ANA MENÜ", "home")]
  ]);
}

async function showHome(ctx) {
  saveUser(ctx.from);
  const user = getUser(ctx.from.id);

  await ctx.reply(
`${BRAND}

━━━━━━━━━━━━━━━━━━

👋 Hoş geldin, ${ctx.from.first_name || "Müşteri"}!

Premium dijital mağazana hoş geldin.

👛 CÜZDAN BAKİYESİ
💰 ${money(user.balance)}

━━━━━━━━━━━━━━━━━━

📱 Sanal numara kategorilerini incele.
💳 Bakiyeni güvenle yükle.
📋 İşlemlerini takip et.

Bir işlem seçerek devam et.`,
    mainMenu(ctx.from.id)
  );
}

// CUSTOMER START
customerBot.start(async (ctx) => {
  await showHome(ctx);
});

// HOME
customerBot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  await showHome(ctx);
});

// SANAL NUMARALAR
customerBot.action("catalog", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
`${BRAND}

📱 SANAL NUMARALAR

━━━━━━━━━━━━━━━━━━

🌍 Ülke kategorisini seç.

🇺🇸 ABD
🇨🇴 KOLOMBİYA
🇹🇷 TÜRKİYE

━━━━━━━━━━━━━━━━━━

Mevcut yasal işletme hattı seçenekleri ve koşulları kategori içinde gösterilir.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🇺🇸 ABD", "country_us"),
        Markup.button.callback("🇨🇴 KOLOMBİYA", "country_co")
      ],
      [Markup.button.callback("🇹🇷 TÜRKİYE", "country_tr")],
      [Markup.button.callback("◀ ANA MENÜ", "home")]
    ])
  );
});

// COUNTRY PAGES
for (const [code, country] of Object.entries(countries)) {
  customerBot.action(`country_${code}`, async (ctx) => {
    await ctx.answerCbQuery();

    await ctx.reply(
`${country.flag} ${country.name}

━━━━━━━━━━━━━━━━━━

${country.description}

Bu ülke için yasal işletme iletişim hattı seçenekleri burada listelenecek.

ℹ️ Şu anda gerçek ürün envanteri bağlı değil. Satın alma işlemi aktif değildir.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🌍 ÜLKELERE DÖN", "catalog")],
        [Markup.button.callback("◀ ANA MENÜ", "home")]
      ])
    );
  });
}

// WALLET
customerBot.action("wallet", async (ctx) => {
  await ctx.answerCbQuery();
  saveUser(ctx.from);

  const user = getUser(ctx.from.id);

  await ctx.reply(
`${BRAND}

👛 CÜZDANIM

━━━━━━━━━━━━━━━━━━

💰 Kullanılabilir bakiye

${money(user.balance)}

━━━━━━━━━━━━━━━━━━

Bakiye yüklemek veya işlemlerini görmek için aşağıdan seçim yap.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💳 BAKİYE YÜKLE", "deposit")],
      [Markup.button.callback("📋 İŞLEM GEÇMİŞİ", "history")],
      [Markup.button.callback("◀ ANA MENÜ", "home")]
    ])
  );
});

// DEPOSIT
customerBot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  sessions.set(ctx.from.id, { step: "amount" });

  await ctx.reply(
`${BRAND}

💳 BAKİYE YÜKLEME

━━━━━━━━━━━━━━━━━━

👤 Hesap sahibi: Resul Sakal

🏦 IBAN:
TR62 0006 2000 5000 0006 8107 73

━━━━━━━━━━━━━━━━━━

Yüklemek istediğin tutarı TL olarak gönder.

Örnek: 500

Minimum yükleme: 50 TL

İşlemi iptal etmek için /iptal yaz.`,
    backMenu()
  );
});

// CANCEL SESSION
customerBot.command("iptal", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply("İşlem iptal edildi.", mainMenu(ctx.from.id));
});

// TEXT HANDLER
customerBot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);

  if (!session) return;

  if (session.step === "amount") {
    const amount = Number(ctx.message.text.trim());

    if (!Number.isSafeInteger(amount) || amount < 50 || amount > 100000) {
      return ctx.reply("Geçersiz tutar. Minimum 50 TL.");
    }

    session.amount = amount;
    session.step = "receipt";

    return ctx.reply(
`${BRAND}

🏦 ÖDEME BİLGİLERİ

Alıcı: Resul Sakal

IBAN:
TR62 0006 2000 5000 0006 8107 73

💰 Ödeme tutarı: ${amount} TL

━━━━━━━━━━━━━━━━━━

Havale yaptıktan sonra dekont fotoğrafını gönder.

Yönetici kontrolünden sonra bakiyen hesabına eklenir.`,
      backMenu()
    );
  }
});

// RECEIPT
customerBot.on("photo", async (ctx) => {
  const session = sessions.get(ctx.from.id);

  if (!session || session.step !== "receipt") {
    return ctx.reply("Önce bakiye yükleme talebi oluştur.");
  }

  const amount = session.amount;
  const user = ctx.from;

  saveUser(user);

  const result = db.prepare(`
    INSERT INTO payments (user_id, amount, status)
    VALUES (?, ?, 'pending')
  `).run(user.id, amount);

  const paymentId = Number(result.lastInsertRowid);

  try {
    await adminBot.telegram.sendPhoto(
      adminId,
      ctx.message.photo[ctx.message.photo.length - 1].file_id,
      {
        caption:
`${BRAND}

💳 YENİ ÖDEME TALEBİ

Talep: #${paymentId}
Müşteri: ${user.first_name || "Müşteri"}
Kullanıcı: ${user.username ? "@" + user.username : "Yok"}
Telegram ID: ${user.id}

💰 Tutar: ${amount} TL`,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ ONAYLA", `approve_${paymentId}`),
            Markup.button.callback("❌ REDDET", `reject_${paymentId}`)
          ]
        ])
      }
    );

    sessions.delete(user.id);

    await ctx.reply(
`✅ DEKONTİN YÖNETİCİYE İLETİLDİ

Talep numarası: #${paymentId}

Ödemen kontrol edildikten sonra bakiyen yüklenecek.`,
      backMenu()
    );
  } catch (error) {
    console.error("Dekont gönderilemedi:", error);
    await ctx.reply("Dekont iletilemedi. Lütfen @sonpatronn ile iletişime geç.");
  }
});

// HISTORY
customerBot.action("history", async (ctx) => {
  await ctx.answerCbQuery();

  const rows = db.prepare(`
    SELECT * FROM transactions
    WHERE user_id=?
    ORDER BY id DESC LIMIT 10
  `).all(ctx.from.id);

  if (!rows.length) {
    return ctx.reply(
      "📋 Henüz tamamlanmış işlemin bulunmuyor.",
      backMenu()
    );
  }

  const list = rows.map((row) => {
    const sign = row.amount >= 0 ? "+" : "";
    return `#${row.id} | ${row.type === "deposit" ? "Bakiye yükleme" : "İşlem"}\n💰 ${sign}${money(row.amount)}`;
  }).join("\n\n");

  await ctx.reply(
`${BRAND}

📋 İŞLEM GEÇMİŞİ

━━━━━━━━━━━━━━━━━━

${list}`,
    backMenu()
  );
});

// ADMIN START
adminBot.start(async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Yetkiniz bulunmuyor.");

  await ctx.reply(
`${BRAND}

👑 YÖNETİM PANELİ

Hoş geldin yönetici.

Aşağıdaki menüden mağazanı yönetebilirsin.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💳 BEKLEYEN ÖDEMELER", "pending")],
      [Markup.button.callback("👥 MÜŞTERİLER", "customers")],
      [Markup.button.callback("📊 İSTATİSTİKLER", "stats")]
    ])
  );
});

// APPROVE
adminBot.action(/^approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz işlem.");

  const id = Number(ctx.match[1]);

  const approve = db.transaction(() => {
    const payment = db.prepare(
      "SELECT * FROM payments WHERE id=?"
    ).get(id);

    if (!payment || payment.status !== "pending") return null;

    db.prepare(`
      UPDATE payments
      SET status='approved', reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);

    db.prepare(`
      UPDATE users SET balance=balance+? WHERE id=?
    `).run(payment.amount * 100, payment.user_id);

    db.prepare(`
      INSERT INTO transactions (user_id, amount, type, reference_id)
      VALUES (?, ?, 'deposit', ?)
    `).run(payment.user_id, payment.amount * 100, id);

    return payment;
  });

  const payment = approve();

  if (!payment) return ctx.answerCbQuery("Bu talep daha önce işlendi.");

  await ctx.answerCbQuery("Ödeme onaylandı.");

  await ctx.editMessageCaption(
`✅ ÖDEME ONAYLANDI

Talep: #${id}
Müşteri: ${payment.user_id}
Tutar: ${payment.amount} TL`
  ).catch(() => {});

  await ctx.editMessageText(
`✅ ÖDEME ONAYLANDI

Talep: #${id}
Müşteri: ${payment.user_id}
Tutar: ${payment.amount} TL`
  ).catch(() => {});

  await customerBot.telegram.sendMessage(
    payment.user_id,
    `✅ Ödemen onaylandı. ${payment.amount} TL bakiyen hesabına eklendi.`
  );
});

// REJECT
adminBot.action(/^reject_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz işlem.");

  const id = Number(ctx.match[1]);

  const payment = db.prepare(`
    UPDATE payments
    SET status='rejected', reviewed_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending'
    RETURNING *
  `).get(id);

  if (!payment) return ctx.answerCbQuery("Talep zaten işlenmiş.");

  await ctx.answerCbQuery("Talep reddedildi.");

  await ctx.editMessageCaption(
    `❌ ÖDEME REDDEDİLDİ\nTalep: #${id}\nTutar: ${payment.amount} TL`
  ).catch(() => {});

  await customerBot.telegram.sendMessage(
    payment.user_id,
    "❌ Ödeme talebin reddedildi. Destek: @sonpatronn"
  );
});

// PENDING
adminBot.action("pending", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const rows = db.prepare(`
    SELECT * FROM payments
    WHERE status='pending'
    ORDER BY id DESC LIMIT 20
  `).all();

  if (!rows.length) return ctx.reply("Bekleyen ödeme bulunmuyor.");

  for (const p of rows) {
    await ctx.reply(
`💳 ÖDEME #${p.id}

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

// CUSTOMERS
adminBot.action("customers", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const users = db.prepare(`
    SELECT * FROM users ORDER BY created_at DESC LIMIT 30
  `).all();

  if (!users.length) return ctx.reply("Henüz müşteri bulunmuyor.");

  const list = users.map((u) =>
    `${u.first_name || "Müşteri"}\nID: ${u.id}\nBakiye: ${money(u.balance)}`
  ).join("\n\n");

  await ctx.reply(`👥 MÜŞTERİLER\n\n${list}`);
});

// STATS
adminBot.action("stats", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Yetkisiz.");

  await ctx.answerCbQuery();

  const users = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  const pending = db.prepare("SELECT COUNT(*) AS total FROM payments WHERE status='pending'").get().total;
  const approved = db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status='approved'").get().total;

  await ctx.reply(
`${BRAND}

📊 MAĞAZA İSTATİSTİKLERİ

👥 Müşteri: ${users}
⏳ Bekleyen ödeme: ${pending}
💰 Onaylanan yükleme: ${approved} TL`
  );
});

// ERRORS
customerBot.catch((err) => console.error("Müşteri botu:", err));
adminBot.catch((err) => console.error("Admin botu:", err));

// START
async function start() {
  await Promise.all([
    customerBot.launch(),
    adminBot.launch()
  ]);

  console.log("ANKA MARKET müşteri botu aktif.");
  console.log("ANKA ADMIN botu aktif.");
}

start().catch((err) => {
  console.error("Başlatma hatası:", err);
  process.exit(1);
});

process.once("SIGINT", () => {
  customerBot.stop("SIGINT");
  adminBot.stop("SIGINT");
  server.close();
});

process.once("SIGTERM", () => {
  customerBot.stop("SIGTERM");
  adminBot.stop("SIGTERM");
  server.close();
});
