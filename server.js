
   ÖNEMLİ GÜVENLİK KURALLARI:
   - BOT_TOKEN, ADMIN_CHAT_ID, SMS_TC_API_KEY, IBAN SADECE Render
     Environment Variables'tan okunur. Hiçbiri koda yazılmaz.
   - Hiçbir secret log'a yazdırılmaz.
   - .env dosyası repoya gönderilmez (.gitignore'da).
   - Admin talebiyle (2026-11-24): sms.tc üzerinden (ANKA SMS ile aynı,
     zaten yetkili/lisanslı sağlayıcı hesabı) 5 sabit numara ürünü
     (NUMBER_CATALOG, aşağıda) satılıyor. Fiyat düşürme/sahte veri YOK,
     her satın alma gerçek sms.tc API çağrısıdır (demo mod yok).
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

/* ---------------------------------------------------------------------
   1) ORTAM DEĞİŞKENLERİ (Render Environment Variables)
   --------------------------------------------------------------------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID).trim() : '';
// Sadece ileride izin verilen, doğrulama dışı entegrasyonlar için saklanır. Loglanmaz, kullanılmaz.
const SMS_TC_API_KEY = process.env.SMS_TC_API_KEY || '';
const IBAN = process.env.IBAN || '';
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://ankaysms.site';
const LOGO_PATH = path.join(__dirname, 'assets', 'anka-logo.png');
const HAS_LOGO = fs.existsSync(LOGO_PATH);
const BRAND_HEADER = '🦅 *ANKA MARKET* ✨\n➖➖➖➖➖➖➖➖➖➖\n';

/* ---------------------------------------------------------------------
   1b) SMS.TC SAĞLAYICI ENTEGRASYONU (gerçek numara satışı)
   -----------------------------------------------------------------
   ANKA SMS web sitesinde kullanılan sms.tc hesabının AYNISI (admin
   tarafından verilen SMS_TC_API_KEY). Aynı handler_api.php protokolü:
   action=getNumber/getStatus/setStatus/getServicesList, cevaplar düz
   metin ("ACCESS_NUMBER:id:phone", "NO_NUMBERS", "STATUS_OK:kod" vb).
   --------------------------------------------------------------------- */
const SMSTC_URL = process.env.SMS_TC_URL || 'https://sms.tc/stubs/handler_api.php';
const SMSTC_MIN_INTERVAL_MS = 2200;
let smstcQueue = Promise.resolve();
let lastSmstcCallAt = 0;
function smstcGet(params, timeout) {
    const run = smstcQueue.then(async () => {
        const wait = SMSTC_MIN_INTERVAL_MS - (Date.now() - lastSmstcCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastSmstcCallAt = Date.now();
        return axios.get(SMSTC_URL, { params: Object.assign({ api_key: SMS_TC_API_KEY }, params), timeout: timeout || 20000 });
    });
    smstcQueue = run.then(() => {}, () => {});
    return run;
}

// Admin'in belirttiği ülke alan kodları - sağlayıcıdan dönen numara bu kodla BAŞLAMIYORSA
// sipariş otomatik iptal edilir (yanlış ülke numarası müşteriye asla verilmez).
const COUNTRY_DIAL_CODES = { tr: '90', co: '57', us: '1' };
function verifyReturnedCountry(countryKey, phoneNumber) {
    const dial = COUNTRY_DIAL_CODES[countryKey];
    if (!dial) return { ok: true };
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    return { ok: digits.startsWith(dial), dial: dial };
}

// Servis kodu isimden otomatik bulma (Trendyol Go gibi sabit kodu bilinmeyen ürünler için)
let servicesListCache = { time: 0, byCode: {} };
async function resolveServicesList() {
    if (servicesListCache.time && Date.now() - servicesListCache.time < 3600000) return servicesListCache;
    const byCode = {};
    try {
        const r = await smstcGet({ action: 'getServicesList' }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        let arr = [];
        if (Array.isArray(d)) arr = d;
        else if (d && Array.isArray(d.services)) arr = d.services;
        else if (d && typeof d === 'object') arr = Object.keys(d).map(k => ({ code: k, name: (d[k] && typeof d[k] === 'object') ? (d[k].name || d[k].title || d[k].eng) : d[k] }));
        for (const s of arr) {
            if (!s) continue;
            const code = s.code !== undefined ? s.code : (s.id !== undefined ? s.id : s.key);
            const name = s.name || s.title || s.eng || s.rus;
            if (code !== undefined && name) byCode[String(code)] = String(name);
        }
    } catch (e) { console.error('[resolveServicesList] hata: ' + e.message); }
    servicesListCache = { time: Date.now(), byCode: byCode };
    return servicesListCache;
}
function normTr(s) {
    return String(s).toLowerCase()
        .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').trim();
}
let serviceCodeCache = {};
async function resolveServiceCode(item) {
    if (item.serviceCode) return item.serviceCode;
    const cached = serviceCodeCache[item.id];
    if (cached && Date.now() - cached.time < 3600000) return cached.code;
    const { byCode } = await resolveServicesList();
    const hints = (item.serviceHints || []).map(normTr);
    let found = null;
    for (const code in byCode) {
        const n = normTr(byCode[code]);
        if (hints.some(h => n.includes(h))) { found = code; break; }
    }
    const code = found || item.id;
    serviceCodeCache[item.id] = { code: code, time: Date.now() };
    if (!found) console.log('[resolveServiceCode] "' + item.name + '" icin isimle eslesme bulunamadi, tahmini kod: ' + code);
    return code;
}

// ====== SABİT NUMARA ÜRÜNLERİ (admin talebiyle, 2026-11-24) ======
// Fiyatlar ve içerik admin tarafından TAM OLARAK belirtildi. Her satın alma gerçek sms.tc
// API çağrısıdır - bakiye SADECE gerçek, ülkesi doğrulanmış bir numara teslim edildiğinde düşülür.
const NUMBER_CATALOG = [
    { id: 'wa_us', name: '🇺🇸 WhatsApp Amerika', serviceCode: 'wa', countryKey: 'us', candidates: ['187', '12'], price: 95 },
    { id: 'wa_co', name: '🇨🇴 WhatsApp Kolombiya', serviceCode: 'wa', countryKey: 'co', candidates: ['10'], price: 80 },
    { id: 'tg_us', name: '🇺🇸 Telegram Amerika', serviceCode: 'tg', countryKey: 'us', candidates: ['187', '12'], price: 95 },
    { id: 'tg_tr', name: '🇹🇷 Telegram Türkiye', serviceCode: 'tg', countryKey: 'tr', candidates: ['62'], price: 150 },
    { id: 'trendyolgo_tr', name: '🛵 Trendyol Go Türkiye', serviceHints: ['trendyol go', 'trendyolgo'], countryKey: 'tr', candidates: ['62'], price: 200 }
];
function findNumberProduct(id) { return NUMBER_CATALOG.find(p => p.id === id); }
// Aynı anda aynı kullanıcının çift tıklayıp iki numara birden almasını engeller.
const numberBuyLocks = new Set();

if (!BOT_TOKEN || !ADMIN_BOT_TOKEN || !ADMIN_ID) {
  throw new Error("BOT_TOKEN, ADMIN_BOT_TOKEN ve ADMIN_ID gerekli.");
}

const adminId = Number(ADMIN_ID);

if (!Number.isSafeInteger(adminId) || adminId <= 0) {
  throw new Error("ADMIN_ID hatalı.");
}

let db = emptyDB();

function loadDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const raw = fs.readFileSync(DB_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            db = Object.assign(emptyDB(), parsed);
            db.seq = Object.assign({ product: 0, order: 0, payment: 0, tx: 0 }, parsed.seq || {});
            console.log('[db] Veritabanı yüklendi: ' + DB_PATH);
        } else {
            console.log('[db] Veritabanı dosyası bulunamadı, yeni oluşturulacak: ' + DB_PATH);
            persist();
        }
    } catch (e) {
        console.error('[db] Veritabanı okunamadı, boş veritabanıyla devam ediliyor. Hata: ' + e.message);
    }
}

let persistTimer = null;
function persist() {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error('[db] Veritabanı yazılamadı: ' + e.message);
    }
}

loadDB();

/* ---------------------------------------------------------------------
   3) YARDIMCI FONKSİYONLAR
   --------------------------------------------------------------------- */
function nowIso() { return new Date().toISOString(); }

function fmtDate(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    } catch (e) { return iso || ''; }
}

function fmtMoney(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
}

function isAdmin(chatId) {
    return String(chatId) === String(ADMIN_CHAT_ID);
}

function getOrCreateUser(chatOrFrom) {
    const chatId = String(chatOrFrom.chatId != null ? chatOrFrom.chatId : chatOrFrom.id);
    if (!db.users[chatId]) {
        db.users[chatId] = {
            chatId: chatId,
            username: chatOrFrom.username || '',
            firstName: chatOrFrom.first_name || chatOrFrom.firstName || '',
            balance: 0,
            createdAt: nowIso(),
            banned: false
        };
        persist();
    } else {
        // güncel kullanıcı adı/isim bilgisi tazelensin
        let changed = false;
        if (chatOrFrom.username !== undefined && db.users[chatId].username !== chatOrFrom.username) {
            db.users[chatId].username = chatOrFrom.username || '';
            changed = true;
        }
        if ((chatOrFrom.first_name || chatOrFrom.firstName) !== undefined) {
            const fn = chatOrFrom.first_name || chatOrFrom.firstName || '';
            if (db.users[chatId].firstName !== fn) { db.users[chatId].firstName = fn; changed = true; }
        }
        if (changed) persist();
    }
    return db.users[chatId];
}

function logTx(userId, type, amount, note) {
    db.seq.tx += 1;
    const tx = {
        id: 'tx' + db.seq.tx,
        userId: String(userId),
        type: type, // 'bakiye_yukleme' | 'satin_alma' | 'iade' | 'admin_bakiye_duzenleme'
        amount: Number(amount) || 0,
        note: note || '',
        createdAt: nowIso()
    };
    db.transactions.push(tx);
    if (db.transactions.length > 2000) db.transactions = db.transactions.slice(-2000);
    return tx;
}

function logAdmin(action, detail) {
    db.adminLog.push({ ts: nowIso(), action: action, detail: detail || '' });
    if (db.adminLog.length > 1000) db.adminLog = db.adminLog.slice(-1000);
}

function userLabel(u) {
    if (!u) return 'Bilinmiyor';
    const uname = u.username ? ('@' + u.username) : '(kullanıcı adı yok)';
    return (u.firstName || 'İsimsiz') + ' ' + uname + ' [' + u.chatId + ']';
}

/* ---------------------------------------------------------------------
   4) EXPRESS (Render sağlık kontrolü için)
   --------------------------------------------------------------------- */
const APP_VERSION = '2026-11-24-02-vip-tasarim-sms-tc-numara-urunleri';
const app = express();
app.get('/', (_req, res) => {
    res.send('ANKA MARKET botu çalışıyor. Versiyon: ' + APP_VERSION);
});
app.listen(PORT, '0.0.0.0', () => {
    console.log('[http] ANKA MARKET sağlık kontrolü ' + PORT + ' portunda dinliyor.');
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

/* ---------------------------------------------------------------------
   7) /start
   --------------------------------------------------------------------- */
bot.onText(/^\/start$/, async (msg) => {
    clearState(msg.chat.id);
    const chatId = msg.chat.id;
    const user = getOrCreateUser(Object.assign({ chatId: chatId }, msg.from));
    const welcome =
        '🦅 *ANKA MARKET* 💎\n' +
        '_Yetkili ve Güvenilir Dijital Ürün Mağazası_\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        'Hoş geldin, *' + (user.firstName || 'değerli müşterimiz') + '*!\n\n' +
        '✨ *Bu bot ne yapabilir?*\n' +
        '🛍️ Yasal/yetkili dijital ürünler ve anlık SMS doğrulama numaraları satın al\n' +
        '💳 IBAN/EFT ile saniyeler içinde bakiye yükle\n' +
        '📦 Siparişlerini canlı takip et\n' +
        '🔒 Güvenli, kayıt altına alınan, onaylı işlemler\n' +
        '🏆 VIP müşterilerimize özel hızlı destek\n\n' +
        '🌐 ankaysms.site\n\n' +
        'Aşağıdaki menüden işlem seç 👇';
    const opts = Object.assign({ parse_mode: 'Markdown' }, mainMenuKeyboard());
    if (HAS_LOGO) {
        try {
            await bot.sendPhoto(chatId, LOGO_PATH, Object.assign({ caption: welcome }, opts));
            return;
        } catch (e) {
            console.error('[start] logo gönderilemedi, metinle devam: ' + e.message);
        }
    }
    await bot.sendMessage(chatId, welcome, opts);
});

bot.onText(/^\/iptal$/, async (msg) => {
    clearState(msg.chat.id);
    await bot.sendMessage(msg.chat.id, 'İşlem iptal edildi.', mainMenuKeyboard());
});

/* ---------------------------------------------------------------------
   8) ÜRÜNLER
   --------------------------------------------------------------------- */
async function showProducts(chatId) {
    const products = Object.values(db.products);
    await bot.sendMessage(chatId, BRAND_HEADER + '\n🛍️ *Ürünlerimiz*\nSatın almak istediğin ürünü seç:', { parse_mode: 'Markdown' });

    // --- Gerçek zamanlı sms.tc numara ürünleri ---
    for (const n of NUMBER_CATALOG) {
        const text = '💎 *' + n.name + '*\n📲 Anlık SMS doğrulama numarası — canlı stok (sms.tc)\n💵 ' + fmtMoney(n.price);
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⚡ Satın Al — ' + fmtMoney(n.price), callback_data: 'buynum:' + n.id }]] }
        });
    }

    // --- Admin tarafından elle eklenen dijital ürünler ---
    for (const p of products) {
        const stokYazi = p.stock > 0 ? ('✅ Stok: ' + p.stock) : '🚫 Stokta yok';
        const text = '*' + p.name + '*\n' + (p.description ? (p.description + '\n') : '') + '💵 ' + fmtMoney(p.price) + '\n📦 ' + stokYazi;
        const buttons = [];
        if (p.stock > 0) {
            buttons.push([{ text: '✅ Satın Al — ' + fmtMoney(p.price), callback_data: 'order:' + p.id }]);
        }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }

    if (!products.length && !NUMBER_CATALOG.length) {
        await bot.sendMessage(chatId, 'Şu anda listelenen ürün bulunmuyor. Daha sonra tekrar kontrol edebilirsin.', mainMenuKeyboard());
    }
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

        if (data.startsWith('buynum:')) {
            const productId = data.slice('buynum:'.length);
            const item = findNumberProduct(productId);
            if (!item) return bot.answerCallbackQuery(query.id, { text: 'Ürün bulunamadı.' });
            if (!SMS_TC_API_KEY) {
                await bot.answerCallbackQuery(query.id, { text: 'Şu anda kullanılamıyor.' });
                await bot.sendMessage(ADMIN_CHAT_ID, '⚠️ SMS_TC_API_KEY ayarlı değil, numara ürünleri satılamıyor.');
                return bot.sendMessage(chatId, 'Üzgünüz, bu ürün şu anda geçici olarak kullanılamıyor.');
            }
            const user = getOrCreateUser(Object.assign({ chatId: chatId }, query.from));
            if ((user.balance || 0) < item.price) {
                await bot.answerCallbackQuery(query.id, { text: 'Bakiyen yetersiz.' });
                return bot.sendMessage(chatId, '❌ Bakiyen yetersiz. Mevcut bakiye: ' + fmtMoney(user.balance) + '\nGerekli: ' + fmtMoney(item.price) + '\n\n💰 Bakiye yükle menüsünden bakiyeni yükleyebilirsin.');
            }
            if (numberBuyLocks.has(String(chatId))) {
                return bot.answerCallbackQuery(query.id, { text: 'Zaten bir numara isteğin işleniyor, lütfen bekle.' });
            }
            numberBuyLocks.add(String(chatId));
            await bot.answerCallbackQuery(query.id, { text: 'Numara aranıyor, lütfen bekle...' });
            const waitMsg = await bot.sendMessage(chatId, '⏳ *' + item.name + '* için numara aranıyor, lütfen bekle (birkaç saniye sürebilir)...', { parse_mode: 'Markdown' });
            try {
                await buyNumberProduct(chatId, item, user, waitMsg.message_id);
            } finally {
                numberBuyLocks.delete(String(chatId));
            }
            return;
        }

        if (data.startsWith('getcode:')) {
            const orderId = data.slice('getcode:'.length);
            const order = db.orders[orderId];
            if (!order) return bot.answerCallbackQuery(query.id, { text: 'Sipariş bulunamadı.' });
            if (String(order.userId) !== String(chatId) && !isAdmin(chatId)) {
                return bot.answerCallbackQuery(query.id, { text: 'Bu sipariş sana ait değil.' });
            }
            await bot.answerCallbackQuery(query.id, { text: 'Kontrol ediliyor...' });
            return checkNumberCode(chatId, order);
        }

        if (data.startsWith('cancelnum:')) {
            const orderId = data.slice('cancelnum:'.length);
            const order = db.orders[orderId];
            if (!order) return bot.answerCallbackQuery(query.id, { text: 'Sipariş bulunamadı.' });
            if (String(order.userId) !== String(chatId) && !isAdmin(chatId)) {
                return bot.answerCallbackQuery(query.id, { text: 'Bu sipariş sana ait değil.' });
            }
            await bot.answerCallbackQuery(query.id, { text: 'İptal ediliyor...' });
            return cancelNumberOrder(chatId, order);
        }

        if (data.startsWith('pay_approve:') || data.startsWith('pay_reject:')) {
            if (!isAdmin(chatId)) {
                return bot.answerCallbackQuery(query.id, { text: 'Bu işlem sadece yöneticiye özeldir.' });
            }
            const approve = data.startsWith('pay_approve:');
            const paymentId = data.slice(data.indexOf(':') + 1);
            const payment = db.payments[paymentId];
            if (!payment) return bot.answerCallbackQuery(query.id, { text: 'Talep bulunamadı.' });
            if (payment.status !== 'beklemede') return bot.answerCallbackQuery(query.id, { text: 'Bu talep zaten işlenmiş.' });

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

/* ---------------------------------------------------------------------
   8b) GERÇEK ZAMANLI NUMARA SATIN ALMA (sms.tc)
   --------------------------------------------------------------------- */
async function buyNumberProduct(chatId, item, user, waitMessageId) {
    const candidates = item.candidates || ['0'];
    let phoneNumber = null, activationId = null, usedCountry = null;
    let lastRaw = '';

    try {
        const serviceCode = await resolveServiceCode(item);
        for (const country of candidates) {
            let raw = '';
            try {
                const resp = await smstcGet({ action: 'getNumber', service: serviceCode, country: country }, 20000);
                raw = resp.data;
                if (typeof raw === 'object') raw = JSON.stringify(raw);
                raw = raw ? String(raw).trim() : '';
            } catch (eReq) {
                console.error('[buynum] sms.tc isteği başarısız (' + item.id + ', ülke ' + country + '): ' + eReq.message);
                continue;
            }
            lastRaw = raw;
            console.log('[buynum] ' + item.id + ' ülke=' + country + ' -> "' + raw + '"');

            if (raw.startsWith('ACCESS_NUMBER')) {
                const parts = raw.split(':');
                const candId = parts[1];
                const candPhone = parts[2];
                const verify = verifyReturnedCountry(item.countryKey, candPhone);
                if (!verify.ok) {
                    console.error('[buynum] ÜLKE DOĞRULAMA HATASI: "' + item.name + '" için dönen numara (' + candPhone + ') beklenen +' + verify.dial + ' ile eşleşmiyor, iptal ediliyor.');
                    try { await smstcGet({ action: 'setStatus', status: 8, id: candId }, 15000); } catch (eCancel) {}
                    await bot.sendMessage(ADMIN_CHAT_ID, '🛑 ÜLKE DOĞRULAMA HATASI: "' + item.name + '" için sms.tc\'den gelen numara (' + candPhone + ') beklenen ülke koduyla eşleşmedi, otomatik iptal edildi. Lütfen bu ürünün ülke ID\'sini kontrol et.');
                    continue;
                }
                activationId = candId;
                phoneNumber = candPhone;
                usedCountry = country;
                break;
            }
            if (raw.startsWith('NO_NUMBERS')) continue;
            if (raw.startsWith('TOO_MANY_REQUESTS')) { await new Promise(r => setTimeout(r, 3000)); continue; }
            // NO_KEY / BAD_KEY / ERROR_SQL vb - admin'e detay, müşteriye jenerik mesaj
            console.error('[buynum] sms.tc hata yanıtı (' + item.id + '): ' + raw);
            await bot.sendMessage(ADMIN_CHAT_ID, '⚠️ sms.tc hata: "' + item.name + '" -> ' + raw);
        }
    } catch (e) {
        console.error('[buynum] beklenmeyen hata: ' + e.message);
    }

    if (waitMessageId) { try { await bot.deleteMessage(chatId, waitMessageId); } catch (e) {} }

    if (!phoneNumber) {
        await bot.sendMessage(chatId, '🚫 Üzgünüz, "' + item.name + '" için şu anda stokta numara yok. Lütfen daha sonra tekrar dene.');
        return;
    }

    // Bakiye SADECE gerçek, doğrulanmış numara teslim edildiğinde düşülür.
    user.balance = Number(((user.balance || 0) - item.price).toFixed(2));
    db.seq.order += 1;
    const order = {
        id: 'o' + db.seq.order,
        userId: String(user.chatId),
        productId: item.id,
        productName: item.name,
        price: item.price,
        status: 'numara_verildi',
        phoneNumber: phoneNumber,
        activationId: activationId,
        code: null,
        createdAt: nowIso(),
        decidedAt: null
    };
    db.orders[order.id] = order;
    logTx(user.chatId, 'satin_alma', -item.price, item.name + ' - +' + phoneNumber + ' (Sipariş ' + order.id + ')');
    logAdmin('numara_satildi', order.id + ' / ' + item.name + ' / +' + phoneNumber + ' / ' + userLabel(user));
    persist();

    await bot.sendMessage(chatId,
        '✅ *Numaran hazır!*\n\n📞 `+' + phoneNumber + '`\nÜrün: ' + item.name + '\nSipariş No: ' + order.id + '\nKalan bakiye: ' + fmtMoney(user.balance) +
        '\n\nBu numarayı ilgili uygulamaya gir, kod gelince aşağıdaki "Kod Geldi mi?" butonuna bas.',
        { parse_mode: 'Markdown', reply_markup: numberOrderKeyboard(order) }
    );
    await bot.sendMessage(ADMIN_CHAT_ID, '📲 *Numara satıldı*\nMüşteri: ' + userLabel(user) + '\nÜrün: ' + item.name + '\nNumara: +' + phoneNumber + '\nSipariş No: ' + order.id, { parse_mode: 'Markdown' });
}

function numberOrderKeyboard(order) {
    if (order.status !== 'numara_verildi') return undefined;
    return { inline_keyboard: [[
        { text: '📩 Kod Geldi mi?', callback_data: 'getcode:' + order.id },
        { text: '❌ İptal Et (iade)', callback_data: 'cancelnum:' + order.id }
    ]] };
}

async function checkNumberCode(chatId, order) {
    if (order.status !== 'numara_verildi') {
        return bot.sendMessage(chatId, 'Bu sipariş artık aktif değil (durum: ' + order.status + ').');
    }
    let raw = '';
    try {
        const resp = await smstcGet({ action: 'getStatus', id: order.activationId }, 15000);
        raw = resp.data;
        if (typeof raw === 'object') raw = JSON.stringify(raw);
        raw = raw ? String(raw).trim() : '';
    } catch (e) {
        console.error('[getcode] sms.tc hatası (' + order.id + '): ' + e.message);
        return bot.sendMessage(chatId, '⚠️ Şu anda kontrol edilemedi, birazdan tekrar dene.');
    }
    console.log('[getcode] ' + order.id + ' -> "' + raw + '"');

    if (raw.startsWith('STATUS_OK')) {
        const code = raw.split(':').slice(1).join(':');
        order.status = 'tamamlandı';
        order.code = code;
        order.decidedAt = nowIso();
        logAdmin('numara_kod_geldi', order.id + ' / kod: ' + code);
        persist();
        const msg = '📩 *Kodun geldi!*\n\nKod: `' + code + '`\nSipariş No: ' + order.id;
        await bot.sendMessage(order.userId, msg, { parse_mode: 'Markdown' });
        if (String(chatId) !== String(order.userId)) await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        await bot.sendMessage(ADMIN_CHAT_ID, '📩 "' + order.productName + '" (' + order.id + ') için kod geldi.');
        return;
    }
    if (raw.startsWith('STATUS_WAIT_CODE')) {
        return bot.sendMessage(chatId, '⏳ Henüz kod gelmedi. Birazdan tekrar "📩 Kod Geldi mi?" butonuna bas.', { reply_markup: numberOrderKeyboard(order) });
    }
    if (raw.startsWith('STATUS_CANCEL')) {
        order.status = 'iptal';
        order.decidedAt = nowIso();
        const u = db.users[order.userId];
        if (u) {
            u.balance = Number(((u.balance || 0) + order.price).toFixed(2));
            logTx(u.chatId, 'iade', order.price, 'Sağlayıcı numarayı iptal etti - ' + order.productName + ' (' + order.id + ')');
        }
        persist();
        const msgCancel = '❌ Sağlayıcı bu numarayı iptal etti, ' + fmtMoney(order.price) + ' bakiyene iade edildi.';
        await bot.sendMessage(order.userId, msgCancel);
        if (String(chatId) !== String(order.userId)) await bot.sendMessage(chatId, msgCancel);
        return;
    }
    return bot.sendMessage(chatId, '⏳ Henüz kod gelmedi. Birazdan tekrar dene.', { reply_markup: numberOrderKeyboard(order) });
}

async function cancelNumberOrder(chatId, order) {
    if (order.status !== 'numara_verildi') {
        return bot.sendMessage(chatId, 'Bu sipariş zaten işlenmiş (durum: ' + order.status + ').');
    }
    let raw = '';
    try {
        const resp = await smstcGet({ action: 'setStatus', status: 8, id: order.activationId }, 15000);
        raw = resp.data;
        if (typeof raw === 'object') raw = JSON.stringify(raw);
        raw = raw ? String(raw).trim() : '';
    } catch (e) {
        console.error('[cancelnum] sms.tc hatası (' + order.id + '): ' + e.message);
        return bot.sendMessage(chatId, '⚠️ Şu anda iptal edilemedi, birazdan tekrar dene.');
    }
    console.log('[cancelnum] ' + order.id + ' -> "' + raw + '"');

    if (raw.startsWith('EARLY_CANCEL_DENIED')) {
        return bot.sendMessage(chatId, '⏳ Bu numara birkaç dakika geçmeden iptal edilemiyor, lütfen biraz bekleyip tekrar dene.');
    }
    // ACCESS_CANCEL veya başka bir yanıt olsa da müşteri taleple iptal etmek istiyor - iade ediyoruz.
    order.status = 'iptal';
    order.decidedAt = nowIso();
    const u = db.users[order.userId];
    if (u) {
        u.balance = Number(((u.balance || 0) + order.price).toFixed(2));
        logTx(u.chatId, 'iade', order.price, 'Müşteri iptal etti - ' + order.productName + ' (' + order.id + ')');
    }
    logAdmin('numara_iptal', order.id + ' / ' + userLabel(u));
    persist();
    const msgDone = '✅ İptal edildi, ' + fmtMoney(order.price) + ' bakiyene iade edildi.\nSipariş No: ' + order.id;
    await bot.sendMessage(order.userId, msgDone);
    if (String(chatId) !== String(order.userId)) await bot.sendMessage(chatId, msgDone);
}

/* ---------------------------------------------------------------------
   9) BAKİYE YÜKLEME (IBAN/EFT akışı)
   --------------------------------------------------------------------- */
async function startTopup(chatId) {
    if (!IBAN) {
        await bot.sendMessage(chatId, 'Şu anda bakiye yükleme sistemi geçici olarak kullanılamıyor. Lütfen daha sonra tekrar dene veya "💬 Admin ile iletişim" menüsünden bize ulaş.');
        return;
    }
    setState(chatId, 'awaiting_topup_amount', {});
    await bot.sendMessage(chatId,
        BRAND_HEADER + '\n💰 *Bakiye Yükleme*\n\n' +
        'Aşağıdaki IBAN\'a EFT/Havale yapabilirsin:\n`' + IBAN + '`\n\n' +
        'Ödemeyi yaptıktan sonra, lütfen gönderdiğin *tutarı* (sadece sayı, örn: 250) yaz.\n\n' +
        'İptal etmek için /iptal yaz.',
        { parse_mode: 'Markdown' }
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

function orderStatusLabel(status) {
    if (status === 'tamamlandı') return '✅ Tamamlandı';
    if (status === 'iptal') return '❌ İptal edildi';
    if (status === 'numara_verildi') return '📲 Numara verildi (kod bekleniyor)';
    return '⏳ Beklemede';
}

async function showMyOrders(chatId, user) {
    const orders = Object.values(db.orders).filter(o => String(o.userId) === String(user.chatId)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    if (!orders.length) {
        return bot.sendMessage(chatId, BRAND_HEADER + '\nHenüz hiç siparişin yok.', { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, BRAND_HEADER + '\n📦 *Siparişlerim*', { parse_mode: 'Markdown' });
    for (const o of orders.slice(0, 15)) {
        let text = '*' + o.productName + '*' + (o.phoneNumber ? ('\n📞 +' + o.phoneNumber) : '') + (o.code ? ('\n📩 Kod: `' + o.code + '`') : '') +
            '\n💵 ' + fmtMoney(o.price) + '\nSipariş No: ' + o.id + '\n' + orderStatusLabel(o.status) + '\n' + fmtDate(o.createdAt);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: numberOrderKeyboard(o) });
    }
}

async function showAccount(chatId, user) {
    const text = BRAND_HEADER + '\n👤 *Hesabım*\n\n' +
        'Ad: ' + (user.firstName || '-') + '\n' +
        'Kullanıcı adı: ' + (user.username ? ('@' + user.username) : '-') + '\n' +
        'Telegram ID: ' + user.chatId + '\n' +
        'Kayıt tarihi: ' + fmtDate(user.createdAt) + '\n' +
        '💰 Bakiye: ' + fmtMoney(user.balance) + '\n' +
        '🏆 Durum: VIP Müşteri';
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function showHistory(chatId, user) {
    const txs = db.transactions.filter(t => String(t.userId) === String(user.chatId)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    if (!txs.length) {
        return bot.sendMessage(chatId, BRAND_HEADER + '\nHenüz bir işlem geçmişin yok.', { parse_mode: 'Markdown' });
    }
    const typeLabel = { bakiye_yukleme: '💰 Bakiye yükleme', satin_alma: '🛒 Satın alma', iade: '↩️ İade', admin_bakiye_duzenleme: '🛠️ Yönetici düzenlemesi' };
    const lines = txs.slice(0, 25).map(t => {
        const tutar = (t.amount >= 0 ? '+' : '') + fmtMoney(t.amount);
        return '• ' + (typeLabel[t.type] || t.type) + ': ' + tutar + (t.note ? (' (' + t.note + ')') : '') + '\n  ' + fmtDate(t.createdAt);
    });
    await bot.sendMessage(chatId, BRAND_HEADER + '\n🧾 *İşlem Geçmişim*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
}

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

/* ---------------------------------------------------------------------
   13) ADMİN PANELİ
   --------------------------------------------------------------------- */
function adminMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📦 Ürün Ekle', callback_data: 'admin:addproduct' }, { text: '📋 Ürünleri Yönet', callback_data: 'admin:listproducts' }],
                [{ text: '👥 Müşteriler', callback_data: 'admin:customers:0' }, { text: '💰 Bekleyen Ödemeler', callback_data: 'admin:payments' }],
                [{ text: '🧾 Siparişler', callback_data: 'admin:orders' }, { text: '📊 Satış/İşlem Geçmişi', callback_data: 'admin:history' }]
            ]
        }
    };
}

async function handleAdminMenu(chatId) {
    if (!isAdmin(chatId)) return;
    clearState(chatId);
    await bot.sendMessage(chatId, BRAND_HEADER + '\n🛠️ *Yönetim Paneli*', Object.assign({ parse_mode: 'Markdown' }, adminMenuKeyboard()));
}

async function handleAdminCallback(query) {
    const chatId = query.message.chat.id;
    if (!isAdmin(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: 'Bu panel sadece yöneticiye özeldir.' });
    }
    const parts = query.data.split(':'); // admin:action:arg
    const action = parts[1];
    const arg = parts[2];

    await bot.answerCallbackQuery(query.id);

    switch (action) {
        case 'addproduct':
            setState(chatId, 'admin_addproduct_name', {});
            return bot.sendMessage(chatId, '📦 Yeni ürün ekleniyor.\nÜrün adını yaz: (/iptal ile vazgeç)');

        case 'listproducts': {
            const products = Object.values(db.products);
            if (!products.length) return bot.sendMessage(chatId, 'Henüz ürün eklenmemiş.');
            for (const p of products) {
                const text = '*' + p.name + '*\n' + (p.description || '') + '\n💵 ' + fmtMoney(p.price) + ' | 📦 Stok: ' + p.stock;
                await bot.sendMessage(chatId, text, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[
                        { text: '✏️ Düzenle', callback_data: 'admin:editproduct:' + p.id },
                        { text: '🗑️ Sil', callback_data: 'admin:delproduct:' + p.id }
                    ]] }
                });
            }
            return;
        }

        case 'editproduct': {
            const product = db.products[arg];
            if (!product) return bot.sendMessage(chatId, 'Ürün bulunamadı.');
            return bot.sendMessage(chatId, '"' + product.name + '" için hangi alanı düzenlemek istersin?', {
                reply_markup: { inline_keyboard: [
                    [{ text: 'Ad', callback_data: 'admin:editfield:' + product.id + ':name' }, { text: 'Açıklama', callback_data: 'admin:editfield:' + product.id + ':description' }],
                    [{ text: 'Fiyat', callback_data: 'admin:editfield:' + product.id + ':price' }, { text: 'Stok', callback_data: 'admin:editfield:' + product.id + ':stock' }]
                ] }
            });
        }

        case 'editfield': {
            const productId = arg;
            const field = parts[3];
            const product = db.products[productId];
            if (!product) return bot.sendMessage(chatId, 'Ürün bulunamadı.');
            setState(chatId, 'admin_editfield_value', { productId: productId, field: field });
            const fieldLabel = { name: 'Ad', description: 'Açıklama', price: 'Fiyat (TL, sadece sayı)', stock: 'Stok (sadece sayı)' }[field] || field;
            return bot.sendMessage(chatId, 'Yeni "' + fieldLabel + '" değerini yaz: (/iptal ile vazgeç)');
        }

        case 'delproduct': {
            const product = db.products[arg];
            if (!product) return bot.sendMessage(chatId, 'Ürün bulunamadı.');
            return bot.sendMessage(chatId, '"' + product.name + '" ürününü silmek istediğine emin misin?', {
                reply_markup: { inline_keyboard: [[
                    { text: '✅ Evet, sil', callback_data: 'admin:delproduct_confirm:' + product.id },
                    { text: '❌ Vazgeç', callback_data: 'admin:cancel' }
                ]] }
            });
        }

        case 'delproduct_confirm': {
            const product = db.products[arg];
            if (!product) return bot.sendMessage(chatId, 'Ürün zaten mevcut değil.');
            delete db.products[arg];
            logAdmin('urun_sil', product.name + ' (' + product.id + ')');
            persist();
            return bot.sendMessage(chatId, '🗑️ "' + product.name + '" silindi.');
        }

        case 'cancel':
            return bot.sendMessage(chatId, 'Vazgeçildi.');

        case 'customers': {
            const page = Number(arg) || 0;
            const pageSize = 8;
            const users = Object.values(db.users).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
            const slice = users.slice(page * pageSize, page * pageSize + pageSize);
            if (!slice.length) return bot.sendMessage(chatId, 'Müşteri bulunamadı.');
            const lines = slice.map(u => userLabel(u) + ' — 💰 ' + fmtMoney(u.balance) + (u.banned ? ' 🚫 BANLI' : ''));
            const navButtons = [];
            if (page > 0) navButtons.push({ text: '⬅️ Önceki', callback_data: 'admin:customers:' + (page - 1) });
            if (users.length > (page + 1) * pageSize) navButtons.push({ text: 'Sonraki ➡️', callback_data: 'admin:customers:' + (page + 1) });
            return bot.sendMessage(chatId, '👥 *Müşteriler* (sayfa ' + (page + 1) + ')\n\n' + lines.join('\n') + '\n\nBakiye düzenlemek için: /bakiye <chatId> <miktar>\n(Örn: /bakiye 123456 +50  veya  /bakiye 123456 -20)', {
                parse_mode: 'Markdown',
                reply_markup: navButtons.length ? { inline_keyboard: [navButtons] } : undefined
            });
        }

        case 'payments': {
            const pending = Object.values(db.payments).filter(p => p.status === 'beklemede').sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
            if (!pending.length) return bot.sendMessage(chatId, 'Bekleyen ödeme talebi yok.');
            for (const p of pending) {
                const u = db.users[p.userId];
                await bot.sendMessage(chatId, '💰 Talep ' + p.id + '\nMüşteri: ' + userLabel(u) + '\nTutar: ' + fmtMoney(p.amount) + '\nGönderen (beyan): ' + p.senderName + '\nTarih: ' + fmtDate(p.createdAt), {
                    reply_markup: { inline_keyboard: [[
                        { text: '✅ Onayla', callback_data: 'pay_approve:' + p.id },
                        { text: '❌ Reddet', callback_data: 'pay_reject:' + p.id }
                    ]] }
                });
            }
            return;
        }

        case 'orders': {
            const orders = Object.values(db.orders).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1)).slice(0, 15);
            if (!orders.length) return bot.sendMessage(chatId, 'Henüz sipariş yok.');
            for (const o of orders) {
                const u = db.users[o.userId];
                let text = 'Sipariş ' + o.id + ' | ' + orderStatusLabel(o.status) + '\nMüşteri: ' + userLabel(u) + '\nÜrün: ' + o.productName +
                    (o.phoneNumber ? ('\n📞 +' + o.phoneNumber) : '') + (o.code ? ('\n📩 Kod: ' + o.code) : '') +
                    ' — ' + fmtMoney(o.price) + '\nTarih: ' + fmtDate(o.createdAt);
                let buttons = [];
                if (o.status === 'beklemede') {
                    buttons = [[
                        { text: '✅ Tamamlandı', callback_data: 'order_done:' + o.id },
                        { text: '❌ İptal Et (iade)', callback_data: 'order_cancel:' + o.id }
                    ]];
                } else if (o.status === 'numara_verildi') {
                    buttons = [[
                        { text: '📩 Kod Geldi mi?', callback_data: 'getcode:' + o.id },
                        { text: '❌ İptal Et (iade)', callback_data: 'cancelnum:' + o.id }
                    ]];
                }
                await bot.sendMessage(chatId, text, { reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined });
            }
            return;
        }

        case 'history': {
            const txs = db.transactions.slice(-25).reverse();
            if (!txs.length) return bot.sendMessage(chatId, 'Henüz işlem geçmişi yok.');
            const typeLabel = { bakiye_yukleme: '💰 Yükleme', satin_alma: '🛒 Satın alma', iade: '↩️ İade', admin_bakiye_duzenleme: '🛠️ Düzenleme' };
            const lines = txs.map(t => {
                const u = db.users[t.userId];
                return (typeLabel[t.type] || t.type) + ' | ' + userLabel(u) + ' | ' + (t.amount >= 0 ? '+' : '') + fmtMoney(t.amount) + ' | ' + fmtDate(t.createdAt);
            });
            return bot.sendMessage(chatId, '📊 *Son İşlemler*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
        }

        default:
            return bot.sendMessage(chatId, 'Bilinmeyen admin işlemi.');
    }
}

bot.onText(/^\/bakiye\s+(\S+)\s+([+-]?\d+(?:[.,]\d+)?)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const targetId = match[1];
    const delta = Number(String(match[2]).replace(',', '.'));
    const user = db.users[targetId];
    if (!user) return bot.sendMessage(msg.chat.id, 'Bu ID\'de kayıtlı kullanıcı bulunamadı: ' + targetId);
    user.balance = Number(((user.balance || 0) + delta).toFixed(2));
    logTx(user.chatId, 'admin_bakiye_duzenleme', delta, 'Yönetici bakiye düzenlemesi');
    logAdmin('bakiye_duzenle', userLabel(user) + ' : ' + (delta >= 0 ? '+' : '') + delta + ' TL -> yeni bakiye ' + user.balance);
    persist();
    await bot.sendMessage(msg.chat.id, '✅ Güncellendi. ' + userLabel(user) + ' — yeni bakiye: ' + fmtMoney(user.balance));
    try { await bot.sendMessage(user.chatId, '🛠️ Hesap bakiyende güncelleme yapıldı: ' + (delta >= 0 ? '+' : '') + fmtMoney(delta) + '\nGüncel bakiyen: ' + fmtMoney(user.balance)); } catch (e) {}
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

console.log('ANKA MARKET botu çalışıyor. Versiyon: ' + APP_VERSION);
