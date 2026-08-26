const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const { createCanvas, loadImage, registerFont } = require('canvas');

const app = express();
app.use(express.json());

// -------------------------------------------------------------
// ၁။ မြန်မာ Font Register လုပ်ခြင်း
// -------------------------------------------------------------
function setupMyanmarFont() {
    try {
        const fontPath = path.join(__dirname, 'fonts', 'Pyidaungsu.ttf');

        if (fs.existsSync(fontPath)) {
            registerFont(fontPath, { family: 'Pyidaungsu' });
            console.log('Pyidaungsu font registered successfully!');
        } else {
            console.warn('Warning: fonts/Pyidaungsu.ttf file not found. Canvas image may fallback to default font.');
        }
    } catch (e) {
        console.error('Font Setup Error:', e.message);
    }
}
setupMyanmarFont();

// Environment Variables
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'a-p-t-123';
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_DATA_GROUP_ID = process.env.TELEGRAM_DATA_GROUP_ID;
const TELEGRAM_PACKING_GROUP_ID = process.env.TELEGRAM_PACKING_GROUP_ID;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

const userSessions = {};
const pendingPayments = {};

async function getFacebookUserName(senderPsid) {
    if (!PAGE_ACCESS_TOKEN) return "Customer";
    try {
        const response = await axios.get(
            `https://graph.facebook.com/v19.0/${senderPsid}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`
        );
        return response.data.name || "Customer";
    } catch (error) {
        return "Customer";
    }
}

function getGoogleSheetsAuth() {
    if (!process.env.GOOGLE_CREDENTIALS_JSON) return null;
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

// -------------------------------------------------------------
// ၂။ Google Sheets Helper Functions
// -------------------------------------------------------------

async function getPaymentAccountsFromSheet() {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return 'Kpay / Wavepay ဖြင့် ငွေလွှဲပေးချေနိုင်ပါသည်။';

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Settings!A2:B20',
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) return 'Kpay / Wavepay ဖြင့် ငွေလွှဲပေးချေနိုင်ပါသည်။';

        let paymentListText = '';
        rows.forEach((row) => {
            if (row[0] && row[1]) {
                paymentListText += `- ${row[0]}: ${row[1]}\n`;
            }
        });
        return paymentListText;
    } catch (error) {
        return 'Kpay / Wavepay ဖြင့် ငွေလွှဲပေးချေနိုင်ပါသည်။';
    }
}

async function getShopConfigFromSheet() {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return { logoUrl: '', shopName: 'OFFICIAL STORE' };
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Config!A2:B2',
        });
        const row = response.data.values ? response.data.values[0] : [];
        return {
            logoUrl: row[0] || '',
            shopName: row[1] || 'OFFICIAL STORE'
        };
    } catch (error) {
        return { logoUrl: '', shopName: 'OFFICIAL STORE' };
    }
}

async function getProductsFromSheet() {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return 'ကုန်ပစ္စည်းစာရင်း ဖတ်၍မရသေးပါ။';
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Products!A2:C200',
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) return 'လက်ရှိတွင် ကုန်ပစ္စည်း စာရင်းမရှိသေးပါ။';

        let productListText = '';
        rows.forEach((row) => {
            productListText += `- ပစ္စည်း: ${row[0] || 'N/A'} | ဈေး: ${row[1] || 'N/A'} ကျပ် | လက်ကျန်: ${row[2] || '0'}\n`;
        });
        return productListText;
    } catch (error) {
        return 'ကုန်ပစ္စည်း အချက်အလက် မရရှိနိုင်ပါ။';
    }
}

async function getCodCitiesFromSheet() {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return 'COD မြို့နယ်အချက်အလက် မရှိသေးပါ။';
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'COD!A2:B300',
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) return 'COD ရသော မြို့နယ်စာရင်း မရှိသေးပါ။';

        let cityListText = '';
        rows.forEach((row) => {
            cityListText += `- မြို့နယ်: ${row[0] || 'N/A'} (ပို့ခ: ${row[1] || 'N/A'})\n`;
        });
        return cityListText;
    } catch (error) {
        return 'COD မြို့နယ် အချက်အလက် မရရှိနိုင်ပါ။';
    }
}

async function saveOrderToSheet(senderPsid, customerName, orderDetails, estDays = 3) {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return;
        const sheets = google.sheets({ version: 'v4', auth });

        const orderDate = new Date();
        const deliveryDate = new Date();
        deliveryDate.setDate(orderDate.getDate() + parseInt(estDays, 10));

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    senderPsid,
                    customerName,
                    orderDetails,
                    orderDate.toISOString().split('T')[0],
                    deliveryDate.toISOString().split('T')[0],
                    'PENDING'
                ]]
            }
        });
    } catch (error) {
        console.error('Save Order Error:', error.message);
    }
}

async function updateStockInSheet(itemOrderedName, quantityOrdered = 1) {
    try {
        const auth = getGoogleSheetsAuth();
        if (!auth) return;
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Products!A2:C200',
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) return;

        for (let i = 0; i < rows.length; i++) {
            const productName = rows[i][0] ? rows[i][0].trim().toLowerCase() : '';
            const orderedName = itemOrderedName.trim().toLowerCase();

            if (productName && (productName.includes(orderedName) || orderedName.includes(productName))) {
                const currentStock = parseInt(rows[i][2] || '0', 10);
                const newStock = Math.max(0, currentStock - quantityOrdered);
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `Products!C${i + 2}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[newStock]] }
                });
                break;
            }
        }
    } catch (error) {
        console.error('Stock Update Error:', error.message);
    }
}

// -------------------------------------------------------------
// ၃။ Dynamic Voucher Image Generation
// -------------------------------------------------------------
async function createVoucherBuffer(customerName, orderDetails) {
    const config = await getShopConfigFromSheet();
    const canvas = createCanvas(650, 850);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 650, 850);

    ctx.fillStyle = '#1E3A8A';
    ctx.fillRect(0, 0, 650, 130);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px "Pyidaungsu"';
    ctx.fillText(config.shopName, 130, 55);

    ctx.font = '16px "Pyidaungsu"';
    ctx.fillStyle = '#E0E7FF';
    ctx.fillText('အရောင်းပြေစာ / INVOICE', 130, 90);

    if (config.logoUrl) {
        try {
            const logo = await loadImage(config.logoUrl);
            ctx.drawImage(logo, 30, 20, 85, 85);
        } catch (e) {}
    }

    const today = new Date().toISOString().split('T')[0];
    ctx.fillStyle = '#475569';
    ctx.font = '14px "Pyidaungsu"';
    ctx.fillText(`ရက်စွဲ: ${today}`, 480, 160);

    const getVal = (key) => {
        const match = orderDetails.match(new RegExp(`${key}:\\s*(.+)`));
        return match ? match[1].trim() : '-';
    };

    const cPhone = getVal('ဖုန်း');
    const cAddress = getVal('လိပ်စာ');
    const cItem = getVal('မှာယူသည့်ပစ္စည်း');
    const cQty = getVal('အရေအတွက်');
    const cPayment = getVal('ငွေချေစနစ်');

    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(30, 180, 590, 90);

    ctx.fillStyle = '#1E293B';
    ctx.font = 'bold 15px "Pyidaungsu"';
    ctx.fillText(`ဝယ်သူအမည်: ${customerName}`, 45, 210);
    ctx.fillText(`ဖုန်းနံပါတ်: ${cPhone}`, 45, 240);
    ctx.fillText(`လိပ်စာ/မြို့နယ်: ${cAddress}`, 320, 210);
    ctx.fillText(`ငွေချေစနစ်: ${cPayment}`, 320, 240);

    ctx.fillStyle = '#334155';
    ctx.fillRect(30, 290, 590, 40);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 15px "Pyidaungsu"';
    ctx.fillText('စဉ်', 45, 315);
    ctx.fillText('ပစ္စည်းအမည်', 100, 315);
    ctx.fillText('အရေအတွက်', 380, 315);
    ctx.fillText('ငွေချေမှု', 510, 315);

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(30, 330, 590, 50);

    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.strokeRect(30, 330, 590, 50);

    ctx.fillStyle = '#0F172A';
    ctx.font = '15px "Pyidaungsu"';
    ctx.fillText('၁', 50, 360);
    ctx.fillText(cItem, 100, 360);
    ctx.fillText(`${cQty} ခု/ထုပ်`, 410, 360);
    ctx.fillText(cPayment, 510, 360);

    ctx.fillStyle = '#10B981';
    ctx.fillRect(30, 420, 590, 50);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 18px "Pyidaungsu"';
    ctx.fillText('အခြေအနေ: အော်ဒါထုတ်ပိုးပြင်ဆင်ပြီးပါပြီ ✅', 160, 452);

    ctx.fillStyle = '#64748B';
    ctx.font = '14px "Pyidaungsu"';
    ctx.fillText('ဝယ်ယူအားပေးမှုကို အထူးပင် ကျေးဇူးတင်ရှိပါသည်။', 190, 800);

    return canvas.toBuffer('image/png');
}

// -------------------------------------------------------------
// ၄။ Telegram Notifications
// -------------------------------------------------------------
async function sendTelegramOrderNotification(orderText, senderPsid) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_PACKING_GROUP_ID) {
        console.error('Error: TELEGRAM_BOT_TOKEN or TELEGRAM_PACKING_GROUP_ID is missing!');
        return;
    }
    const messageText = `📦 *[ ထုတ်ပိုးရန် အော်ဒါ - Packing List ]*\n━━━━━━━━━━━━━━━━━━\n🆔 *PSID:* \`${senderPsid}\`\n${orderText}\n━━━━━━━━━━━━━━━━━━\n🔴 *အခြေအနေ:* Packing မထုပ်ရသေးပါ`;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_PACKING_GROUP_ID,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Packing Done & Confirm", callback_data: `confirm_pack:${senderPsid}` }]]
            }
        });
        console.log('Successfully sent message to Telegram Packing Group');
    } catch (error) {
        console.error('Send Telegram Packing Error:', error.response ? error.response.data : error.message);
    }
}

async function sendPaymentCheckToDataGroup(fbName, senderPsid, photoUrl, orderDetails) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_DATA_GROUP_ID) {
        console.error('Error: TELEGRAM_BOT_TOKEN or TELEGRAM_DATA_GROUP_ID is missing!');
        return;
    }
    const captionText = `💰 *[ ငွေလွှဲ SCREENSHOT စစ်ဆေးရန် ]*\n━━━━━━━━━━━━━━━━━━\n👤 *Customer:* ${fbName}\n🆔 *PSID:* \`${senderPsid}\`\n📦 *အသေးစိတ်:*\n${orderDetails}\n\n🔴 *အခြေအနေ:* မစစ်ရသေးပါ`;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            chat_id: TELEGRAM_DATA_GROUP_ID,
            photo: photoUrl,
            caption: captionText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Confirm (ငွေဝင်သည်)", callback_data: `pay_confirm:${senderPsid}` },
                    { text: "❌ Reject (ငွေမဝင်ပါ)", callback_data: `pay_reject:${senderPsid}` }
                ]]
            }
        });
        console.log('Successfully sent photo to Telegram Data Group');
    } catch (error) {
        console.error('Send Telegram Data Group Error:', error.response ? error.response.data : error.message);
    }
}

// -------------------------------------------------------------
// ၅။ Telegram Webhook Handling
// -------------------------------------------------------------
app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const body = req.body;

        if (body.callback_query) {
            const callback = body.callback_query;
            const chatId = callback.message.chat.id;
            const messageId = callback.message.message_id;
            const data = callback.data;
            const staffName = callback.from.first_name || 'Admin';

            if (data.startsWith('pay_confirm:')) {
                const senderPsid = data.split(':')[1];
                let updatedCaption = (callback.message.caption || '').replace('🔴 အခြေအနေ: မစစ်ရသေးပါ', `🟢 *အခြေအနေ:* ငွေဝင်ကြောင်း အတည်ပြုပြီး (${staffName})`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
                    chat_id: chatId, message_id: messageId, caption: updatedCaption, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
                });

                if (pendingPayments[senderPsid]) {
                    const orderData = pendingPayments[senderPsid];
                    await sendTelegramOrderNotification(orderData.text, senderPsid);
                }
            } 
            else if (data.startsWith('pay_reject:')) {
                const senderPsid = data.split(':')[1];
                let updatedCaption = (callback.message.caption || '').replace('🔴 အခြေအနေ: မစစ်ရသေးပါ', `🔴 *အခြေအနေ:* ငွေလွှဲမဝင်သေးပါ (${staffName})`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
                    chat_id: chatId, message_id: messageId, caption: updatedCaption, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
                });

                const customerName = await getFacebookUserName(senderPsid);
                await sendFBMessage(senderPsid, `မင်္ဂလာပါ ${customerName} ရှင့်၊ ငွေလွှဲဝင်ရောက်ခြင်း မရှိသေးပါသဖြင့် ပြန်လည်စစ်ဆေးပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။`);
            }
            else if (data.startsWith('confirm_pack:')) {
                const senderPsid = data.split(':')[1];
                let updatedText = (callback.message.text || '').replace('🔴 အခြေအနေ: Packing မထုပ်ရသေးပါ', `🟢 *အခြေအနေ:* Packing ထုပ်ပြီးပါပြီ (${staffName})`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                    chat_id: chatId, message_id: messageId, text: updatedText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
                });

                const customerName = await getFacebookUserName(senderPsid);
                const orderData = pendingPayments[senderPsid];

                if (orderData) {
                    await saveOrderToSheet(senderPsid, customerName, orderData.text, orderData.days);
                    const itemMatch = orderData.text.match(/မှာယူသည့်ပစ္စည်း:\s*(.+)/);
                    const qtyMatch = orderData.text.match(/အရေအတွက်:\s*(\d+)/);
                    if (itemMatch && itemMatch[1]) {
                        await updateStockInSheet(itemMatch[1].trim(), qtyMatch ? parseInt(qtyMatch[1], 10) : 1);
                    }

                    const voucherBuffer = await createVoucherBuffer(customerName, orderData.text);
                    await sendFBPhotoBuffer(senderPsid, voucherBuffer, `မင်္ဂလာပါ ${customerName} ရှင့်၊ လူကြီးမင်း၏ အော်ဒါအား ထုတ်ပိုးပြင်ဆင်ပြီးစီးပါပြီဖြစ်၍ ဘောင်ချာ ပို့ပေးလိုက်ပါတယ်ရှင့်။ 📦✨`);

                    delete pendingPayments[senderPsid];
                }
            }
        }

        if (body.message && body.message.chat.id.toString() === TELEGRAM_DATA_GROUP_ID && body.message.photo) {
            const caption = body.message.caption || '';
            const psidMatch = caption.match(/PSID:\s*`?(\d+)`?/i) || caption.match(/(\d{15,})/);

            if (psidMatch && psidMatch[1]) {
                const senderPsid = psidMatch[1];
                const photoArray = body.message.photo;
                const largestPhoto = photoArray[photoArray.length - 1];
                
                const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${largestPhoto.file_id}`);
                const filePath = fileRes.data.result.file_path;
                const gateVoucherUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

                const imageBufferResponse = await axios.get(gateVoucherUrl, { responseType: 'arraybuffer' });
                const imageBuffer = Buffer.from(imageBufferResponse.data, 'binary');

                const customerName = await getFacebookUserName(senderPsid);
                const captionText = `မင်္ဂလာပါ ${customerName} ရှင့်၊ လူကြီးမင်း အော်ဒါအား ကားဂိတ်/အိမ်ရောက် ပို့ဆောင်ရေးသို့ လွှဲပြောင်းပေးလိုက်ပါပြီ။ ပို့ဆောင်ရေး ဘောင်ချာပုံအား ပူးတွဲ ပို့ပေးလိုက်ပါတယ်ရှင့်။ 🚌ကျေးဇူးအထူးတင်ရှိပါသည်။`;

                await sendFBPhotoBuffer(senderPsid, imageBuffer, captionText);
            }
        }

    } catch (error) {
        console.error('Telegram Webhook Handling Error:', error.message);
    }
});

// -------------------------------------------------------------
// ၆။ Gemini AI Chat Session
// -------------------------------------------------------------
async function getChatSession(senderPsid, customerName) {
    if (!userSessions[senderPsid]) {
        const productData = await getProductsFromSheet();
        const codCityData = await getCodCitiesFromSheet();
        const paymentData = await getPaymentAccountsFromSheet();

        const systemInstruction = `
သင့်နာမည်သည် အရောင်းဝန်ထမ်း AI ဖြစ်သည်။
Customer နာမည်: "${customerName}"

[ပစ္စည်းစာရင်းနှင့် လက်ကျန်]
${productData}

[COD ရရှိနိုင်သော မြို့နယ်များနှင့် ပို့ခ]
${codCityData}

[ငွေလွှဲရမည့် အကောင့်များ (Settings)]
${paymentData}

**အရောင်းဆိုင် စည်းမျဉ်းများ:**
၁။ Customer မေးသည့် ပစ္စည်းအကြောင်း၊ ဈေးနှုန်းနှင့် လက်ကျန်ကိုပဲ အရင်ဖြေပါ။
၂။ Customer က "မှာယူမည်/ယူမယ်/ဝယ်မယ်" ဟု တိကျစွာပြောမှသာ မြို့နယ်၊ ဖုန်းနံပါတ် နှင့် လိပ်စာကို တောင်းပါ။
၃။ **COD စစ်ဆေးရန်နှင့် ငွေတောင်းရန် စည်းမျဉ်း:**
   - [COD ရရှိနိုင်သော မြို့နယ်များ] ထဲတွင် ပါဝင်ပါက -> COD ရကြောင်း၊ ပို့ခ အပါအဝင် ကျသင့်ငွေကို ပြောပြပေးပါ။
   - **[COD မရသော မြို့နယ်များ] ဖြစ်ပါက:** -> COD မရပါဟု တိကျစွာပြောပါ။ ထို့နောက် [ငွေလွှဲရမည့် အကောင့်များ] စာရင်းကို အပြည့်အစုံ ပြသပေးပြီး **ငွေလွှဲပြီးပါက ငွေလွှဲပြေစာ Screenshot (SS) ပို့ပေးရန် တောင်းဆိုပါ။**

၄။ အော်ဒါအချက်အလက်များ အပြည့်အစုံ ရရှိပါက စာကြောင်း၏ နောက်ဆုံးတွင် အောက်ပါ Tag တိကျစွာ ထည့်ပေးပါ (စာလုံးပေါင်း မမှားပါစေနှင့်):
[ORDER_INFO]
အမည်: ${customerName}
ဖုန်း: (ဖုန်းနံပါတ်)
လိပ်စာ: (မြို့နယ်/ကားဂိတ်အမည်)
မှာယူသည့်ပစ္စည်း: (ပစ္စည်းအမည်)
အရေအတွက်: (အရေအတွက်)
ငွေချေစနစ်: (COD သို့မဟုတ် PREPAID)
ကြာချိန်ရက်: (3)
[/ORDER_INFO]`;

        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction: systemInstruction,
        });

        userSessions[senderPsid] = { chat: model.startChat(), count: 0 };
    }

    userSessions[senderPsid].count += 1;
    if (userSessions[senderPsid].count > 15) {
        delete userSessions[senderPsid];
        return getChatSession(senderPsid, customerName);
    }

    return userSessions[senderPsid].chat;
}

async function generateAIResponse(senderPsid, userMessage, customerName) {
    try {
        const chatSession = await getChatSession(senderPsid, customerName);
        const result = await chatSession.sendMessage(userMessage);
        const aiReply = result.response.text();

        if (aiReply.includes('[ORDER_INFO]')) {
            const orderDetails = aiReply.split('[ORDER_INFO]')[1].split('[/ORDER_INFO]')[0].trim();
            const daysMatch = orderDetails.match(/ကြာချိန်ရက်:\s*(\d+)/);
            const estDays = daysMatch ? parseInt(daysMatch[1], 10) : 3;

            pendingPayments[senderPsid] = { text: orderDetails, days: estDays };

            // COD အော်ဒါဖြစ်ပါက Packing Group သို့ တိုက်ရိုက် ပို့ပေးမည်
            if (orderDetails.includes('ငွေချေစနစ်: COD')) {
                await sendTelegramOrderNotification(orderDetails, senderPsid);
            }

            const cleanReply = aiReply.replace(/\[ORDER_INFO\][\s\S]*?\[\/ORDER_INFO\]/, '').trim();
            return cleanReply;
        }

        return aiReply;
    } catch (error) {
        if (error.message && error.message.includes('429')) {
            return 'ခါတိုင်းထက် စာပြန်တာ ပိုများနေ၍ ခဏနားနေပါသည်ရှင်။ ၁ မိနစ်ခန့်အကြာမှ ပြန်လည် စာပို့ပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။';
        }
        return 'မင်္ဂလာပါရှင်၊ ခဏစောင့်ဆိုင်းပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။';
    }
}

// -------------------------------------------------------------
// ၇။ Facebook Webhook Handling
// -------------------------------------------------------------
app.post('/facebook-webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');
        for (const entry of body.entry) {
            if (!entry.messaging || entry.messaging.length === 0) continue;
            const webhook_event = entry.messaging[0];
            const senderPsid = webhook_event.sender ? webhook_event.sender.id : null;

            if (!senderPsid) continue;
            if (webhook_event.message && (webhook_event.message.is_echo || webhook_event.message.app_id)) continue;

            const customerName = await getFacebookUserName(senderPsid);

            if (webhook_event.message?.attachments && webhook_event.message.attachments[0].type === 'image') {
                const photoUrl = webhook_event.message.attachments[0].payload.url;
                const pendingData = pendingPayments[senderPsid];
                const orderDetails = pendingData ? pendingData.text : "မှာယူမည့် အသေးစိတ် စာရင်းမရှိသေးပါ။";
                
                await sendPaymentCheckToDataGroup(customerName, senderPsid, photoUrl, orderDetails);
                await sendFBMessage(senderPsid, `မင်္ဂလာပါ ${customerName} ရှင့်၊ ပေးပို့လာသော ငွေလွှဲပြေစာအား လက်ခံရရှိပါပြီရှင်။ Admin မှ စစ်ဆေးပြီးပါက Packing အထုပ်ထုပ်ရန် အကြောင်းကြားပေးပါမည်။`);
            } else if (webhook_event.message?.text) {
                const userMessage = webhook_event.message.text;
                const aiReply = await generateAIResponse(senderPsid, userMessage, customerName);
                await sendFBMessage(senderPsid, aiReply);
            }
        }
    } else {
        res.sendStatus(404);
    }
});

app.get('/facebook-webhook', (req, res) => {
    if (req.query['hub.mode'] && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

async function sendFBMessage(senderPsid, responseText) {
    if (!PAGE_ACCESS_TOKEN) return;
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid }, message: { text: responseText }
        });
    } catch (error) {}
}

async function sendFBPhotoBuffer(senderPsid, buffer, captionText) {
    if (!PAGE_ACCESS_TOKEN) return;
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('recipient', JSON.stringify({ id: senderPsid }));
        form.append('message', JSON.stringify({ attachment: { type: 'image', payload: {} } }));
        form.append('filedata', buffer, { filename: 'image.png', contentType: 'image/png' });

        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, form, {
            headers: form.getHeaders()
        });

        if (captionText) await sendFBMessage(senderPsid, captionText);
    } catch (error) {}
}

app.get('/', (req, res) => res.send('Server Active!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));