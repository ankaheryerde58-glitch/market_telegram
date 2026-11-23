/* =====================================================================
   ANKA MARKET — Telegram Bot
   -----------------------------------------------------------------
   Yetkili ve yasal dijital ürünlerin satıldığı, TL bakiye sistemi ve
   IBAN/EFT bildirimli ödeme akışı olan bir Telegram mağaza botu.

   ÖNEMLİ GÜVENLİK KURALLARI:
   - BOT_TOKEN, ADMIN_CHAT_ID, SMS_TC_API_KEY, IBAN SADECE Render
     Environment Variables'tan okunur. Hiçbiri koda yazılmaz.
   - Hiçbir secret log'a yazdırılmaz.
   - .env dosyası repoya gönderilmez (.gitignore'da).
   - Bu bot, doğrulama kısıtlamalarını aşmaya yönelik geçici numara
     veya e-posta satışı/otomasyonu YAPMAZ. SMS_TC_API_KEY burada
     yalnızca ileride izin verilen, doğrulama dışı entegrasyonlar
     için okunur; şu an hiçbir yerde kullanılmamaktadır.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

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

if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN ortam değişkeni gerekli (Render Environment Variables).');
}
if (!ADMIN_CHAT_ID) {
    throw new Error('ADMIN_CHAT_ID ortam değişkeni gerekli (Render Environment Variables).');
}

/* ---------------------------------------------------------------------
   2) KALICI VERİTABANI (JSON dosyası)
   -----------------------------------------------------------------
   NOT: Render'ın ücretsiz/standart servislerinde disk EPHEMERAL'dir
   (yeniden deploy'da sıfırlanabilir). Veritabanının gerçek anlamda
   kalıcı olması (restart/redeploy sonrası da kaybolmaması) için bu
   serviste bir Render "Persistent Disk" (Disk) bağlanmalı ve DB_PATH
   o disk yoluna ayarlanmalıdır. Persistent Disk bağlanmadan sadece
   "servis yeniden başlatma" (restart, redeploy değil) sırasında veri
   korunur; yeni bir deploy dosya sistemini sıfırlayabilir.
   --------------------------------------------------------------------- */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');

function emptyDB() {
    return {
        users: {},       // chatId -> { chatId, username, firstName, balance, createdAt, banned }
        products: {},     // id -> { id, name, description, price, stock, createdAt }
        orders: {},       // id -> { id, userId, productId, productName, price, status, createdAt, decidedAt }
        payments: {},     // id -> { id, userId, amount, senderName, status, createdAt, decidedAt }
        transactions: [], // { id, userId, type, amount, note, createdAt }
        adminLog: [],      // { ts, action, detail }
        seq: { product: 0, order: 0, payment: 0, tx: 0 }
    };
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
const app = express();
app.get('/', (_req, res) => {
    res.send('ANKA MARKET botu çalışıyor.');
});
app.listen(PORT, '0.0.0.0', () => {
    console.log('[http] ANKA MARKET sağlık kontrolü ' + PORT + ' portunda dinliyor.');
});

/* ---------------------------------------------------------------------
   5) TELEGRAM BOT
   --------------------------------------------------------------------- */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    // Secret sızdırmamak için sadece hata mesajını yazdırıyoruz.
    console.error('[telegram] Bağlantı hatası: ' + (error && error.message ? error.message : error));
});

bot.setMyCommands([
    { command: 'start', description: 'ANKA MARKET\'i başlat' },
    { command: 'admin', description: 'Yönetim paneli (sadece admin)' },
    { command: 'iptal', description: 'Sürmekte olan işlemi iptal et' }
]).catch(() => {});

/* Çok adımlı akışlar için durum makinesi: chatId -> { action, data } */
const userStates = new Map();
function setState(chatId, action, data) { userStates.set(String(chatId), { action: action, data: data || {} }); }
function getState(chatId) { return userStates.get(String(chatId)); }
function clearState(chatId) { userStates.delete(String(chatId)); }

/* ---------------------------------------------------------------------
   6) MÜŞTERİ MENÜSÜ
   --------------------------------------------------------------------- */
const MENU = {
    URUNLER: '🛍️ Ürünler',
    BAKIYE: '💰 Bakiye yükle',
    SIPARISLER: '📦 Siparişlerim',
    HESABIM: '👤 Hesabım',
    GECMIS: '🧾 İşlem geçmişim',
    ADMIN_ILETISIM: '💬 Admin ile iletişim',
    WEBSITE: '🌐 Web sitemiz'
};

function mainMenuKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [MENU.URUNLER, MENU.BAKIYE],
                [MENU.SIPARISLER, MENU.HESABIM],
                [MENU.GECMIS, MENU.ADMIN_ILETISIM],
                [MENU.WEBSITE]
            ],
            resize_keyboard: true
        }
    };
}

/* ---------------------------------------------------------------------
   7) /start
   --------------------------------------------------------------------- */
bot.onText(/^\/start$/, async (msg) => {
    clearState(msg.chat.id);
    const user = getOrCreateUser(Object.assign({ chatId: msg.chat.id }, msg.from));
    const welcome = '✨ *ANKA MARKET*\'e hoş geldin, ' + (user.firstName || 'değerli müşterimiz') + '!\n\n' +
        'Yetkili ve yasal dijital ürünleri güvenle satın alabilir, bakiyeni IBAN/EFT ile yükleyebilirsin.\n\n' +
        'Aşağıdaki menüden işlem seç 👇';
    await bot.sendMessage(msg.chat.id, welcome, Object.assign({ parse_mode: 'Markdown' }, mainMenuKeyboard()));
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
    if (!products.length) {
        await bot.sendMessage(chatId, 'Şu anda listelenen ürün bulunmuyor. Daha sonra tekrar kontrol edebilirsin.', mainMenuKeyboard());
        return;
    }
    await bot.sendMessage(chatId, '🛍️ *Ürünlerimiz*\nSatın almak istediğin ürünü seç:', { parse_mode: 'Markdown' });
    for (const p of products) {
        const stokYazi = p.stock > 0 ? ('Stok: ' + p.stock) : 'Stokta yok';
        const text = '*' + p.name + '*\n' + (p.description ? (p.description + '\n') : '') + '💵 ' + fmtMoney(p.price) + '\n📦 ' + stokYazi;
        const buttons = [];
        if (p.stock > 0) {
            buttons.push([{ text: '✅ Satın Al — ' + fmtMoney(p.price), callback_data: 'order:' + p.id }]);
        }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const chatId = query.message.chat.id;

    try {
        if (data.startsWith('order:')) {
            const productId = data.slice('order:'.length);
            const product = db.products[productId];
            if (!product) {
                return bot.answerCallbackQuery(query.id, { text: 'Ürün bulunamadı.' });
            }
            if (product.stock <= 0) {
                return bot.answerCallbackQuery(query.id, { text: 'Üzgünüz, stok tükendi.' });
            }
            const user = getOrCreateUser(Object.assign({ chatId: chatId }, query.from));
            if ((user.balance || 0) < product.price) {
                await bot.answerCallbackQuery(query.id, { text: 'Bakiyen yetersiz.' });
                await bot.sendMessage(chatId, '❌ Bakiyen yetersiz. Mevcut bakiye: ' + fmtMoney(user.balance) + '\nGerekli: ' + fmtMoney(product.price) + '\n\n💰 Bakiye yükle menüsünden bakiyeni yükleyebilirsin.');
                return;
            }
            // Satın alma işlemi
            user.balance = Number((user.balance - product.price).toFixed(2));
            product.stock -= 1;
            db.seq.order += 1;
            const order = {
                id: 'o' + db.seq.order,
                userId: user.chatId,
                productId: product.id,
                productName: product.name,
                price: product.price,
                status: 'beklemede',
                createdAt: nowIso(),
                decidedAt: null
            };
            db.orders[order.id] = order;
            logTx(user.chatId, 'satin_alma', -product.price, product.name + ' (Sipariş ' + order.id + ')');
            persist();

            await bot.answerCallbackQuery(query.id, { text: 'Siparişin alındı!' });
            await bot.sendMessage(chatId, '✅ Siparişin alındı!\n\nÜrün: ' + product.name + '\nTutar: ' + fmtMoney(product.price) + '\nSipariş No: ' + order.id + '\nDurum: Beklemede (yönetici onayı/teslimatı bekleniyor)\n\nKalan bakiyen: ' + fmtMoney(user.balance));
            await bot.sendMessage(ADMIN_CHAT_ID, '🛒 *Yeni sipariş*\nMüşteri: ' + userLabel(user) + '\nÜrün: ' + product.name + '\nTutar: ' + fmtMoney(product.price) + '\nSipariş No: ' + order.id, { parse_mode: 'Markdown' });
            return;
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

            const user = db.users[payment.userId];
            if (approve) {
                payment.status = 'onaylandı';
                payment.decidedAt = nowIso();
                if (user) {
                    user.balance = Number(((user.balance || 0) + payment.amount).toFixed(2));
                    logTx(user.chatId, 'bakiye_yukleme', payment.amount, 'IBAN/EFT - Gönderen: ' + payment.senderName + ' (Talep ' + payment.id + ')');
                }
                logAdmin('odeme_onay', payment.id + ' / ' + fmtMoney(payment.amount) + ' / ' + userLabel(user));
                persist();
                await bot.answerCallbackQuery(query.id, { text: 'Onaylandı.' });
                await bot.editMessageText((query.message.text || '') + '\n\n✅ ONAYLANDI', { chat_id: chatId, message_id: query.message.message_id });
                if (user) await bot.sendMessage(user.chatId, '✅ Bakiye yükleme talebin onaylandı!\nYüklenen: ' + fmtMoney(payment.amount) + '\nGüncel bakiyen: ' + fmtMoney(user.balance));
            } else {
                payment.status = 'reddedildi';
                payment.decidedAt = nowIso();
                logAdmin('odeme_red', payment.id + ' / ' + fmtMoney(payment.amount) + ' / ' + userLabel(user));
                persist();
                await bot.answerCallbackQuery(query.id, { text: 'Reddedildi.' });
                await bot.editMessageText((query.message.text || '') + '\n\n❌ REDDEDİLDİ', { chat_id: chatId, message_id: query.message.message_id });
                if (user) await bot.sendMessage(user.chatId, '❌ Bakiye yükleme talebin reddedildi. Detaylı bilgi için "💬 Admin ile iletişim" menüsünü kullanabilirsin.');
            }
            return;
        }

        if (data.startsWith('order_done:') || data.startsWith('order_cancel:')) {
            if (!isAdmin(chatId)) {
                return bot.answerCallbackQuery(query.id, { text: 'Bu işlem sadece yöneticiye özeldir.' });
            }
            const done = data.startsWith('order_done:');
            const orderId = data.slice(data.indexOf(':') + 1);
            const order = db.orders[orderId];
            if (!order) return bot.answerCallbackQuery(query.id, { text: 'Sipariş bulunamadı.' });
            if (order.status !== 'beklemede') return bot.answerCallbackQuery(query.id, { text: 'Bu sipariş zaten işlenmiş.' });

            const user = db.users[order.userId];
            if (done) {
                order.status = 'tamamlandı';
                order.decidedAt = nowIso();
                logAdmin('siparis_tamamlandi', order.id + ' / ' + userLabel(user));
                persist();
                await bot.answerCallbackQuery(query.id, { text: 'Tamamlandı olarak işaretlendi.' });
                if (user) await bot.sendMessage(user.chatId, '📦 Siparişin tamamlandı!\nSipariş No: ' + order.id + '\nÜrün: ' + order.productName);
            } else {
                order.status = 'iptal';
                order.decidedAt = nowIso();
                if (user) {
                    user.balance = Number(((user.balance || 0) + order.price).toFixed(2));
                    logTx(user.chatId, 'iade', order.price, 'Sipariş iptali - ' + order.productName + ' (' + order.id + ')');
                }
                logAdmin('siparis_iptal', order.id + ' / ' + userLabel(user));
                persist();
                await bot.answerCallbackQuery(query.id, { text: 'İptal edildi, bakiye iade edildi.' });
                if (user) await bot.sendMessage(user.chatId, '❌ Siparişin iptal edildi ve ' + fmtMoney(order.price) + ' bakiyene iade edildi.\nSipariş No: ' + order.id);
            }
            return;
        }

        if (data.startsWith('admin:')) {
            return handleAdminCallback(query);
        }

        await bot.answerCallbackQuery(query.id, { text: 'Bilinmeyen işlem.' });
    } catch (err) {
        console.error('[callback_query] Hata: ' + err.message);
        try { await bot.answerCallbackQuery(query.id, { text: 'Bir hata oluştu, tekrar dene.' }); } catch (e2) {}
    }
});

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
        '💰 *Bakiye Yükleme*\n\n' +
        'Aşağıdaki IBAN\'a EFT/Havale yapabilirsin:\n`' + IBAN + '`\n\n' +
        'Ödemeyi yaptıktan sonra, lütfen gönderdiğin *tutarı* (sadece sayı, örn: 250) yaz.\n\n' +
        'İptal etmek için /iptal yaz.',
        { parse_mode: 'Markdown' }
    );
}

/* ---------------------------------------------------------------------
   10) GENEL MESAJ İŞLEYİCİ (menü + durum makinesi)
   --------------------------------------------------------------------- */
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start') || msg.text.startsWith('/iptal')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const user = getOrCreateUser(Object.assign({ chatId: chatId }, msg.from));

    if (text === '/admin') {
        return handleAdminMenu(chatId);
    }

    // --- Çok adımlı akışlar ---
    const state = getState(chatId);
    if (state) {
        try {
            await handleStatefulMessage(chatId, text, state, user, msg);
        } catch (e) {
            console.error('[state] Hata: ' + e.message);
            clearState(chatId);
            await bot.sendMessage(chatId, 'Beklenmeyen bir hata oluştu, işlem iptal edildi.', mainMenuKeyboard());
        }
        return;
    }

    // --- Ana menü ---
    switch (text) {
        case MENU.URUNLER:
            return showProducts(chatId);
        case MENU.BAKIYE:
            return startTopup(chatId);
        case MENU.SIPARISLER:
            return showMyOrders(chatId, user);
        case MENU.HESABIM:
            return showAccount(chatId, user);
        case MENU.GECMIS:
            return showHistory(chatId, user);
        case MENU.ADMIN_ILETISIM:
            setState(chatId, 'awaiting_admin_message', {});
            return bot.sendMessage(chatId, '💬 Yöneticiye iletmek istediğin mesajı yaz. (İptal için /iptal)');
        case MENU.WEBSITE:
            return bot.sendMessage(chatId, '🌐 Web sitemiz:', {
                reply_markup: { inline_keyboard: [[{ text: 'ankaysms.site', url: SITE_URL }]] }
            });
        default:
            return; // bilinmeyen metin, sessiz geç
    }
});

async function showMyOrders(chatId, user) {
    const orders = Object.values(db.orders).filter(o => String(o.userId) === String(user.chatId)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    if (!orders.length) {
        return bot.sendMessage(chatId, 'Henüz hiç siparişin yok.', mainMenuKeyboard());
    }
    const lines = orders.slice(0, 20).map(o => {
        const durum = o.status === 'tamamlandı' ? '✅ Tamamlandı' : o.status === 'iptal' ? '❌ İptal edildi' : '⏳ Beklemede';
        return '• ' + o.productName + ' — ' + fmtMoney(o.price) + '\n  Sipariş No: ' + o.id + ' | ' + durum + ' | ' + fmtDate(o.createdAt);
    });
    await bot.sendMessage(chatId, '📦 *Siparişlerim*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
}

async function showAccount(chatId, user) {
    const text = '👤 *Hesabım*\n\n' +
        'Ad: ' + (user.firstName || '-') + '\n' +
        'Kullanıcı adı: ' + (user.username ? ('@' + user.username) : '-') + '\n' +
        'Telegram ID: ' + user.chatId + '\n' +
        'Kayıt tarihi: ' + fmtDate(user.createdAt) + '\n' +
        '💰 Bakiye: ' + fmtMoney(user.balance);
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function showHistory(chatId, user) {
    const txs = db.transactions.filter(t => String(t.userId) === String(user.chatId)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    if (!txs.length) {
        return bot.sendMessage(chatId, 'Henüz bir işlem geçmişin yok.', mainMenuKeyboard());
    }
    const typeLabel = { bakiye_yukleme: '💰 Bakiye yükleme', satin_alma: '🛒 Satın alma', iade: '↩️ İade', admin_bakiye_duzenleme: '🛠️ Yönetici düzenlemesi' };
    const lines = txs.slice(0, 25).map(t => {
        const tutar = (t.amount >= 0 ? '+' : '') + fmtMoney(t.amount);
        return '• ' + (typeLabel[t.type] || t.type) + ': ' + tutar + (t.note ? (' (' + t.note + ')') : '') + '\n  ' + fmtDate(t.createdAt);
    });
    await bot.sendMessage(chatId, '🧾 *İşlem Geçmişim*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
}

/* ---------------------------------------------------------------------
   11) DURUM MAKİNESİ İŞLEYİCİSİ (müşteri + admin ortak)
   --------------------------------------------------------------------- */
async function handleStatefulMessage(chatId, text, state, user, msg) {
    switch (state.action) {

        /* ---- Müşteri: bakiye yükleme tutarı ---- */
        case 'awaiting_topup_amount': {
            const amount = Number(String(text).replace(',', '.').replace(/[^0-9.]/g, ''));
            if (!amount || amount <= 0) {
                return bot.sendMessage(chatId, 'Geçerli bir tutar yaz (sadece sayı, örn: 250). İptal için /iptal.');
            }
            setState(chatId, 'awaiting_topup_name', { amount: Number(amount.toFixed(2)) });
            return bot.sendMessage(chatId, 'Tutar: ' + fmtMoney(amount) + '\n\nŞimdi EFT/Havaleyi gönderen kişinin *ad soyadını* yaz.', { parse_mode: 'Markdown' });
        }

        /* ---- Müşteri: bakiye yükleme gönderen ad-soyad ---- */
        case 'awaiting_topup_name': {
            const senderName = text.slice(0, 80);
            const amount = state.data.amount;
            db.seq.payment += 1;
            const payment = {
                id: 'p' + db.seq.payment,
                userId: String(user.chatId),
                amount: amount,
                senderName: senderName,
                status: 'beklemede',
                createdAt: nowIso(),
                decidedAt: null
            };
            db.payments[payment.id] = payment;
            persist();
            clearState(chatId);
            await bot.sendMessage(chatId, '✅ Bakiye yükleme talebin alındı!\n\nTutar: ' + fmtMoney(amount) + '\nGönderen: ' + senderName + '\nTalep No: ' + payment.id + '\n\nYönetici onayından sonra bakiyen otomatik güncellenecek.', mainMenuKeyboard());
            await bot.sendMessage(ADMIN_CHAT_ID,
                '💰 *Yeni bakiye yükleme talebi*\nMüşteri: ' + userLabel(user) + '\nTutar: ' + fmtMoney(amount) + '\nGönderen (beyan): ' + senderName + '\nTalep No: ' + payment.id,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[
                        { text: '✅ Onayla', callback_data: 'pay_approve:' + payment.id },
                        { text: '❌ Reddet', callback_data: 'pay_reject:' + payment.id }
                    ]] }
                }
            );
            return;
        }

        /* ---- Müşteri: admin ile iletişim mesajı ---- */
        case 'awaiting_admin_message': {
            clearState(chatId);
            await bot.sendMessage(ADMIN_CHAT_ID, '💬 *Müşteri mesajı*\nKimden: ' + userLabel(user) + '\n\n' + text, { parse_mode: 'Markdown' });
            await bot.sendMessage(chatId, '✅ Mesajın yöneticiye iletildi. En kısa sürede sana dönüş yapılacak.', mainMenuKeyboard());
            return;
        }

        default:
            return handleAdminStatefulMessage(chatId, text, state, msg);
    }
}

/* ---------------------------------------------------------------------
   12) ADMİN: /mesaj komutu (müşteriye yanıt)
   --------------------------------------------------------------------- */
bot.onText(/^\/mesaj\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const targetId = match[1];
    const text = match[2];
    const target = db.users[targetId];
    if (!target) return bot.sendMessage(msg.chat.id, 'Bu ID\'de kayıtlı kullanıcı bulunamadı: ' + targetId);
    try {
        await bot.sendMessage(targetId, '💬 *Yöneticiden mesaj:*\n\n' + text, { parse_mode: 'Markdown' });
        logAdmin('musteriye_mesaj', targetId + ': ' + text.slice(0, 120));
        persist();
        await bot.sendMessage(msg.chat.id, '✅ Mesaj gönderildi: ' + userLabel(target));
    } catch (e) {
        await bot.sendMessage(msg.chat.id, '❌ Mesaj gönderilemedi: ' + e.message);
    }
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
    await bot.sendMessage(chatId, '🛠️ *ANKA MARKET — Yönetim Paneli*', Object.assign({ parse_mode: 'Markdown' }, adminMenuKeyboard()));
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
                const durum = o.status === 'tamamlandı' ? '✅ Tamamlandı' : o.status === 'iptal' ? '❌ İptal' : '⏳ Beklemede';
                const text = 'Sipariş ' + o.id + ' | ' + durum + '\nMüşteri: ' + userLabel(u) + '\nÜrün: ' + o.productName + ' — ' + fmtMoney(o.price) + '\nTarih: ' + fmtDate(o.createdAt);
                const buttons = o.status === 'beklemede' ? [[
                    { text: '✅ Tamamlandı', callback_data: 'order_done:' + o.id },
                    { text: '❌ İptal Et (iade)', callback_data: 'order_cancel:' + o.id }
                ]] : [];
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

/* ---------------------------------------------------------------------
   14) ADMİN DURUM MAKİNESİ (ürün ekleme / düzenleme akışları)
   --------------------------------------------------------------------- */
async function handleAdminStatefulMessage(chatId, text, state, msg) {
    if (!isAdmin(chatId)) { clearState(chatId); return; }

    switch (state.action) {
        case 'admin_addproduct_name':
            setState(chatId, 'admin_addproduct_desc', { name: text.slice(0, 120) });
            return bot.sendMessage(chatId, 'Ürün açıklamasını yaz: (geçmek için "-" yaz)');

        case 'admin_addproduct_desc': {
            const description = text === '-' ? '' : text.slice(0, 500);
            setState(chatId, 'admin_addproduct_price', Object.assign({}, state.data, { description: description }));
            return bot.sendMessage(chatId, 'Fiyatını TL olarak yaz (sadece sayı, örn: 199):');
        }

        case 'admin_addproduct_price': {
            const price = Number(String(text).replace(',', '.').replace(/[^0-9.]/g, ''));
            if (!price || price <= 0) return bot.sendMessage(chatId, 'Geçersiz fiyat. Sadece sayı yaz (örn: 199):');
            setState(chatId, 'admin_addproduct_stock', Object.assign({}, state.data, { price: Number(price.toFixed(2)) }));
            return bot.sendMessage(chatId, 'Stok adedini yaz (sadece sayı, örn: 10):');
        }

        case 'admin_addproduct_stock': {
            const stock = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
            if (isNaN(stock) || stock < 0) return bot.sendMessage(chatId, 'Geçersiz stok. Sadece sayı yaz (örn: 10):');
            db.seq.product += 1;
            const product = {
                id: 'prod' + db.seq.product,
                name: state.data.name,
                description: state.data.description || '',
                price: state.data.price,
                stock: stock,
                createdAt: nowIso()
            };
            db.products[product.id] = product;
            logAdmin('urun_ekle', product.name + ' (' + product.id + ') ' + fmtMoney(product.price) + ' x' + product.stock);
            persist();
            clearState(chatId);
            return bot.sendMessage(chatId, '✅ Ürün eklendi!\n\n*' + product.name + '*\n' + (product.description || '') + '\n💵 ' + fmtMoney(product.price) + ' | 📦 Stok: ' + product.stock, { parse_mode: 'Markdown' });
        }

        case 'admin_editfield_value': {
            const product = db.products[state.data.productId];
            if (!product) { clearState(chatId); return bot.sendMessage(chatId, 'Ürün artık mevcut değil.'); }
            const field = state.data.field;
            if (field === 'price') {
                const price = Number(String(text).replace(',', '.').replace(/[^0-9.]/g, ''));
                if (!price || price <= 0) return bot.sendMessage(chatId, 'Geçersiz fiyat. Tekrar yaz:');
                product.price = Number(price.toFixed(2));
            } else if (field === 'stock') {
                const stock = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
                if (isNaN(stock) || stock < 0) return bot.sendMessage(chatId, 'Geçersiz stok. Tekrar yaz:');
                product.stock = stock;
            } else if (field === 'name') {
                product.name = text.slice(0, 120);
            } else if (field === 'description') {
                product.description = text === '-' ? '' : text.slice(0, 500);
            }
            logAdmin('urun_duzenle', product.id + ' / ' + field + ' -> ' + text.slice(0, 80));
            persist();
            clearState(chatId);
            return bot.sendMessage(chatId, '✅ Güncellendi.\n\n*' + product.name + '*\n' + (product.description || '') + '\n💵 ' + fmtMoney(product.price) + ' | 📦 Stok: ' + product.stock, { parse_mode: 'Markdown' });
        }

        default:
            clearState(chatId);
            return;
    }
}

console.log('ANKA MARKET botu çalışıyor.');
