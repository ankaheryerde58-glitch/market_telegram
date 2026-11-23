
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
  DB_PATH = "/var/data/anka-market.db",
  PORT = 10000
} = process.env;

if (!BOT_TOKEN || !ADMIN_BOT_TOKEN || !ADMIN_ID) {
  throw new Error("Environment değişkenleri eksik!");
}

const adminId = Number(ADMIN_ID);

if (!Number.isSafeInteger(adminId) || adminId <= 0) {
  throw new Error("ADMIN_ID hatalı!");
}

// RENDER WEB SERVER
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ANKA MARKET ONLINE");
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`ANKA MARKET PORT ${PORT} READY`);
});

// DATABASE
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), {
  recursive: true
});

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

const products = [
  ["🇺🇸", "ABD İşletme Hattı", 100],
  ["🇨🇴", "Kolombiya İşletme Hattı", 100],
  ["🇹🇷", "Türkiye İşletme Hattı", 150]
];

function saveUser(user) {
  db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
    username=excluded.username,
    first_name=excluded.first_name
  `).run(
    user.id,
    user.username || null,
    user.first_name || "Müşteri"
  );
}

function getUser(id) {
  return db.prepare(
    "SELECT * FROM users WHERE id=?"
  ).get(id);
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
    [Markup.button.url("👑 YÖNETİCİ", "https://t.me/sonpatronn")]
  ]);
}

// ========================
// MÜŞTERİ BOTU
// ========================

customerBot.start(async (ctx) => {
  saveUser(ctx.from);

  await ctx.reply(
`✦ A N K A   M A R K E T ✦

PREMIUM DIGITAL STORE

Hoş geldin ${ctx.from.first_name}.

ANKA MARKET'e hoş geldin.

Güvenli alışveriş için aşağıdaki menüyü kullanabilirsin.`,
    mainMenu()
  );
});

customerBot.action("catalog", async (ctx) => {
  await ctx.answerCbQuery();

  const list = products.map((p) =>
    `${p[0]} ${p[1]}\n💰 ${p[2]} TL`
  ).join("\n\n");

  await ctx.reply(
`✦ ANKA MARKET KATALOĞU ✦

${list}

Ürün satın alma entegrasyonu henüz etkin değildir.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("◀ ANA MENÜ", "home")]
    ])
  );
});

customerBot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("✦ ANKA MARKET", mainMenu());
});

customerBot.action("wallet", async (ctx) => {
  await ctx.answerCbQuery();

  saveUser(ctx.from);

  const user = getUser(ctx.from.id);

  await ctx.reply(
`👛 ANKA CÜZDAN

💰 BAKİYE

${(user.balance / 100).toFixed(2)} TL`
  );
});

// BAKİYE YÜKLEME
customerBot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  sessions.set(ctx.from.id, {
    step: "amount"
  });

  await ctx.reply(
`✦ ANKA MARKET BAKİYE YÜKLEME ✦

HESAP SAHİBİ:
Resul Sakal

IBAN:
TR62 0006 2000 5000 0006 8107 73

Yüklemek istediğin tutarı TL olarak yaz.

Örnek: 500

Minimum yükleme: 50 TL`
  );
});

// ÖDEME TUTARI
customerBot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);

  if (!session || session.step !== "amount") return;

  const amount = Number(ctx.message.text.trim());

  if (
    !Number.isSafeInteger(amount) ||
    amount < 50 ||
    amount > 100000
  ) {
    return ctx.reply("Geçerli bir tutar gir. Minimum 50 TL.");
  }

  session.amount = amount;
  session.step = "receipt";

  await ctx.reply(
`✦ HAVALE BİLGİLERİ ✦

Alıcı: Resul Sakal

IBAN:
TR62 0006 2000 5000 0006 8107 73

Ödeme tutarı: ${amount} TL

Havale yaptıktan sonra dekont fotoğrafını gönder.

Ödemen yönetici tarafından kontrol edilecektir.`
  );
});

// DEKONT
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
    await adminBot.telegram.sendMessage(
      adminId,
`✦ ANKA MARKET ÖDEME TALEBİ ✦

Talep: #${paymentId}
Müşteri: ${user.first_name}
Kullanıcı: ${user.username ? "@" + user.username : "Yok"}
Telegram ID: ${user.id}

Tutar: ${amount} TL

Dekontu inceleyip karar ver.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ ONAYLA",
            `approve_${paymentId}`
          )
        ],
        [
          Markup.button.callback(
            "❌ REDDET",
            `reject_${paymentId}`
          )
        ]
      ])
    );

    await customerBot.telegram.copyMessage(
      adminId,
      ctx.chat.id,
      ctx.message.message_id
    );

    sessions.delete(user.id);

    await ctx.reply(
`✅ DEKONT İLETİLDİ

Talep numarası: #${paymentId}

Ödemen yönetici tarafından kontrol edilecek.

Onaylandığında bakiyen yüklenecek.`
    );

  } catch (error) {
    console.error("Dekont gönderme hatası:", error);

    await ctx.reply(
      "Dekont yöneticiye iletilemedi. Lütfen @sonpatronn ile iletişime geç."
    );
  }
});

// ========================
// ADMIN BOTU
// ========================

adminBot.start(async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ YETKİNİZ YOK.");
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

// ÖDEME ONAYLA
adminBot.action(/^approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Yetkisiz işlem.");
  }

  const id = Number(ctx.match[1]);

  const approve = db.transaction(() => {
    const payment = db.prepare(
      "SELECT * FROM payments WHERE id=?"
    ).get(id);

    if (!payment || payment.status !== "pending") {
      return null;
    }

    db.prepare(`
      UPDATE payments
      SET status='approved', reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);

    db.prepare(`
      UPDATE users
      SET balance=balance+?
      WHERE id=?
    `).run(payment.amount * 100, payment.user_id);

    db.prepare(`
      INSERT INTO transactions
      (user_id, amount, type, reference_id)
      VALUES (?, ?, 'deposit', ?)
    `).run(payment.user_id, payment.amount * 100, id);

    return payment;
  });

  const payment = approve();

  if (!payment) {
    return ctx.answerCbQuery("Bu ödeme daha önce işlendi.");
  }

  await ctx.answerCbQuery("Ödeme onaylandı.");

  await ctx.editMessageText(
`✅ ÖDEME ONAYLANDI

Talep: #${id}
Müşteri: ${payment.user_id}
Bakiye: ${payment.amount} TL`
  );

  await customerBot.telegram.sendMessage(
    payment.user_id,
`✅ ÖDEMEN ONAYLANDI

${payment.amount} TL bakiyen cüzdanına eklendi.

✦ ANKA MARKET`
  );
});

// ÖDEME REDDET
adminBot.action(/^reject_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Yetkisiz işlem.");
  }

  const id = Number(ctx.match[1]);

  const payment = db.prepare(`
    UPDATE payments
    SET status='rejected', reviewed_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending'
    RETURNING *
  `).get(id);

  if (!payment) {
    return ctx.answerCbQuery("Talep zaten işlenmiş.");
  }

  await ctx.answerCbQuery("Reddedildi.");

  await ctx.editMessageText(
`❌ ÖDEME REDDEDİLDİ

Talep: #${id}
Müşteri: ${payment.user_id}
Tutar: ${payment.amount} TL`
  );

  await customerBot.telegram.sendMessage(
    payment.user_id,
    `Ödeme talebin reddedildi. Destek: @sonpatronn`
  );
});

// BEKLEYEN ÖDEMELER
adminBot.action("pending", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Yetkisiz.");
  }

  await ctx.answerCbQuery();

  const rows = db.prepare(`
    SELECT * FROM payments
    WHERE status='pending'
    ORDER BY id DESC LIMIT 20
  `).all();

  if (!rows.length) {
    return ctx.reply("Bekleyen ödeme bulunmuyor.");
  }

  for (const p of rows) {
    await ctx.reply(
`ÖDEME #${p.id}

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
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Yetkisiz.");
  }

  await ctx.answerCbQuery();

  const users = db.prepare(`
    SELECT * FROM users
    ORDER BY created_at DESC LIMIT 30
  `).all();

  if (!users.length) {
    return ctx.reply("Henüz müşteri yok.");
  }

  const text = users.map(u =>
`${u.first_name || "Müşteri"}
ID: ${u.id}
Bakiye: ${(u.balance / 100).toFixed(2)} TL`
  ).join("\n\n");

  await ctx.reply(`👥 MÜŞTERİLER\n\n${text}`);
});

// İSTATİSTİKLER
adminBot.action("stats", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Yetkisiz.");
  }

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
`✦ ANKA MARKET RAPORU ✦

👥 Müşteri: ${users}
⏳ Bekleyen ödeme: ${pending}
💰 Onaylanan yükleme: ${approved} TL`
  );
});

// HATA YÖNETİMİ
customerBot.catch(err => {
  console.error("Müşteri botu:", err);
});

adminBot.catch(err => {
  console.error("Admin botu:", err);
});

// BAŞLAT
async function start() {
  await Promise.all([
    customerBot.launch(),
    adminBot.launch()
  ]);

  console.log("ANKA MARKET müşteri botu aktif.");
  console.log("ANKA ADMIN botu aktif.");
}

start().catch(err => {
  console.error("Bot başlatma hatası:", err);
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
