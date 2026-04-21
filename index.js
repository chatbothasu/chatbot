// Domain ngrok giữ cố định
// ngrok http --domain=overplant-serving-copious.ngrok-free.dev 3000
// ══════════════════════════════════════════════════════════════
// CHATBOT CSKH — Bách hóa số Hasu | Phiên bản RAG
// Luồng: FAQ check → Intent detect → Product search → Claude
// ══════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const { google } = require('googleapis');
const app        = express();
app.use(express.json());
app.use(express.static('public'));

// ── DỮ LIỆU IN-MEMORY (đọc từ Google Sheets, fallback JSON) ──
let products   = [];
let faqs       = [];
let promotions = [];
let categories = [];
let policies   = [];
let lastLoaded = null;   // thời điểm load cuối

// ── LỊCH SỬ HỘI THOẠI ────────────────────────────────────────
const histories = {};

// ── ZALO TOKEN (in-memory, được refresh tự động) ─────────────
let zaloAccessToken  = process.env.ZALO_ACCESS_TOKEN  || '';
let zaloRefreshToken = process.env.ZALO_REFRESH_TOKEN || '';

// ── BASE PROMPT ───────────────────────────────────────────────
const BASE_PROMPT = `Anh/Chị là nhân viên tư vấn của Bách hóa số Hasu tại Bắc Ninh.

VAI TRÒ: Tư vấn sản phẩm, nhận đặt hàng, hỗ trợ khiếu nại.
XƯNG HÔ: Xưng "em", gọi khách là "anh/chị" hoặc "anh/chị".

DANH MỤC SẢN PHẨM ĐANG BÁN:
- Nước giặt xả (Zesty Clean các loại)
- Xả vải khô
- Nước lau sàn (Sutiki)
- Nước tẩy bồn cầu (Sutiki)
- Nước rửa chén
- Khăn ướt
- Khăn giấy rút / Giấy vệ sinh / Giấy rút (Hasu, Hasumart)
- Tã dán & tã quần trẻ em (Oubiroi)
- Viên giặt
- Yến chưng (hộp quà & hũ lẻ)
- Sản phẩm trẻ em (Nest Kids)

*** Có 1 phần cực quan trọng:giá sản phẩm đang chưa đúng lắm,có thể đó là giá của đơn vị lẻ , cũng có thể là giá của đơn vị Thùng, hãy dựa vào sự linh hoạt + tham khảo ước chừng từ trang web khác để tư vấn cho khách hàng một cách đúng nhất !
TUYỆT ĐỐI KHÔNG được bịa thêm sản phẩm ngoài danh mục trên.
Nếu khách hỏi sản phẩm không có: "Em chưa có sản phẩm đó anh/chị ơi. Anh/Chị cần thêm gì trong danh mục bên em không ạ?"

QUY TẮC:
- Trả lời ngắn gọn, thân thiện, tối đa 3-4 câu
- Nếu không có thông tin: "Để em kiểm tra và báo lại anh/chị nhé!"
- Nếu khách muốn đặt hàng: hỏi tên, SĐT, địa chỉ, sản phẩm, số lượng
- Nếu khiếu nại: chuyển quản lý
- TUYỆT ĐỐI KHÔNG dùng markdown: không dùng **, __, ##, [], () hay bất kỳ ký tự định dạng nào — chỉ viết text thuần túy
- Khi kèm link: viết thẳng URL, KHÔNG bọc trong ** hay bất kỳ ký tự nào

THÔNG TIN CỬA HÀNG:
- Địa chỉ: Khu 7, Phường Đại Phúc, TP Bắc Ninh
- Hotline: 0915359896
- Giờ mở cửa: 7h30 - 21h00, tất cả các ngày
- Shopee: https://vn.shp.ee/GB16AKre
- TikTok: https://www.tiktok.com/@bachhoasohasu

HƯỚNG DẪN DẪN KHÁCH VÀO SHOP:
- Khi khách hỏi mua hoặc muốn đặt hàng → luôn kèm link Shopee hoặc TikTok
- Khi tư vấn xong sản phẩm → tự nhiên gợi ý: "Anh/chị có thể đặt hàng trực tiếp tại Shopee bên em: https://vn.shp.ee/GB16AKre hoặc xem thêm sản phẩm trên TikTok: https://www.tiktok.com/@bachhoasohasu ạ!"
- Không spam link mỗi tin nhắn — chỉ kèm khi phù hợp (tư vấn xong, khách hỏi mua, giới thiệu shop)`;

// ══════════════════════════════════════════════════════════════
// GOOGLE SHEETS — LOAD DATA
// ══════════════════════════════════════════════════════════════

function getGoogleAuth() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('Thiếu GOOGLE_SERVICE_ACCOUNT_B64 trong env');
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

// Đọc một vùng dữ liệu từ Sheet
async function getSheetValues(sheets, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range
  });
  return res.data.values || [];
}

// Chuỗi "a, b, c" → ['a','b','c']
function parseArr(val) {
  if (!val || String(val).trim() === '') return [];
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

// Load toàn bộ data từ Google Sheets
async function loadDataFromSheets() {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    console.warn('[Sheets] Thiếu GOOGLE_SHEET_ID hoặc GOOGLE_SERVICE_ACCOUNT_B64');
    return false;
  }

  try {
    console.log('[Sheets] Đang tải data từ Google Sheets...');
    const auth   = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Hàng 1: ghi chú | Hàng 2: header | Hàng 3+: data
    // → lấy từ hàng 2, bỏ phần tử đầu (header)

    // ── San pham (15 cột A→O) ──────────────────────────────
    const spRows = await getSheetValues(sheets, 'San pham!A2:O');
    if (spRows.length > 1) {
      const [, ...data] = spRows;
      products = data
        .map(r => ({
          id:           r[0]  || '',
          name:         r[1]  || '',
          brand:        r[2]  || '',
          ma_sp:        r[3]  || '',
          price:        Number(r[4])  || 0,
          unit:         r[5]  || '',
          size:         r[6]  || '',
          quy_cach:     r[7]  || '',
          category:     r[8]  || '',
          categoryName: r[9]  || '',
          keywords:     parseArr(r[10]),
          description:  r[11] || '',
          inStock:      String(r[12] || 'TRUE').toUpperCase() !== 'FALSE',
          tags:         parseArr(r[13]),
          link:         r[14] || ''
        }))
        .filter(p => p.name);
    }

    // ── FAQ (2 cột A→B) ───────────────────────────────────
    const faqRows = await getSheetValues(sheets, 'FAQ!A2:B');
    if (faqRows.length > 1) {
      const [, ...data] = faqRows;
      faqs = data
        .map(r => ({ keywords: parseArr(r[0]), answer: r[1] || '' }))
        .filter(f => f.answer);
    }

    // ── Khuyen mai (11 cột A→K) ───────────────────────────
    const kmRows = await getSheetValues(sheets, 'Khuyen mai!A2:K');
    if (kmRows.length > 1) {
      const [, ...data] = kmRows;
      promotions = data
        .map(r => ({
          id:             r[0] || '',
          title:          r[1] || '',
          type:           r[2] || '',
          product:        r[3] || '',
          gift:           r[4] || '',
          price_original: Number(r[5]) || 0,
          price_sale:     Number(r[6]) || 0,
          keywords:       parseArr(r[7]),
          active:         String(r[8] || 'TRUE').toUpperCase() !== 'FALSE',
          note:           r[9] || '',
          link:           r[10] || ''
        }))
        .filter(p => p.title);
    }

    // ── Danh muc (3 cột A→C) ──────────────────────────────
    const dmRows = await getSheetValues(sheets, 'Danh muc!A2:C');
    if (dmRows.length > 1) {
      const [, ...data] = dmRows;
      categories = data
        .map(r => ({ id: r[0] || '', name: r[1] || '', keywords: parseArr(r[2]) }))
        .filter(c => c.id);
    }

    // ── Chinh sach (2 cột A→B) ────────────────────────────
    const csRows = await getSheetValues(sheets, 'Chinh sach!A2:B');
    if (csRows.length > 1) {
      const [, ...data] = csRows;
      policies = data
        .map(r => ({ intent: r[0] || '', content: r[1] || '' }))
        .filter(p => p.intent);
    }

    lastLoaded = new Date();
    console.log(
      `[Sheets] ✅ Load xong — ` +
      `${products.length} SP | ${faqs.length} FAQ | ` +
      `${promotions.length} KM | ${categories.length} DM | ${policies.length} CS`
    );
    return true;

  } catch (err) {
    console.error('[Sheets] ❌ Lỗi load:', err.message);
    return false;
  }
}

// Khởi tạo data: Sheets trước, fallback JSON nếu lỗi
async function initData() {
  const ok = await loadDataFromSheets();
  if (!ok) {
    console.warn('[Data] ⚠️ Dùng file JSON làm fallback...');
    try {
      products   = require('./data/products.json');
      faqs       = require('./data/faq.json');
      promotions = require('./data/promotions.json');
      categories = require('./data/categories.json');
      policies   = require('./data/policies.json');
      lastLoaded = new Date();
      console.log('[Data] ✅ Đã load từ JSON fallback.');
    } catch (e) {
      console.error('[Data] ❌ Không load được JSON fallback:', e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// CÁC HÀM RAG — TÌM KIẾM DATA
// ══════════════════════════════════════════════════════════════

function normalize(text) {
  return (text || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function findFAQ(message) {
  const msg = normalize(message);
  return faqs.find(faq =>
    faq.keywords.some(kw => msg.includes(normalize(kw)))
  ) || null;
}

function findPromotion(message) {
  const msg = ' ' + normalize(message) + ' ';
  const triggerWords = ['khuyen mai', 'uu dai', 'giam gia', 'tang', 'combo', ' km ', 'sale', 'chuong trinh'];
  if (!triggerWords.some(w => msg.includes(normalize(w)))) return null;

  const productMatches = promotions.filter(p => {
    if (!p.active) return false;
    const productName = ' ' + normalize(p.product) + ' ';
    const title       = ' ' + normalize(p.title)   + ' ';
    const stopWords   = ['co','khong','gi','nao','cua','la','va','the','dang','nha','ban','cho',
                         'toi','minh','voi','duoc','khuyen','mai','uu','dai','giam','gia',
                         'chuong','trinh','sale','km'];
    const queryWords  = msg.trim().split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));
    return queryWords.some(w =>
      productName.includes(' ' + w + ' ') || title.includes(' ' + w + ' ')
    );
  });

  if (productMatches.length > 0) return productMatches.slice(0, 2);
  return promotions.filter(p => p.active).slice(0, 10);
}

function detectIntent(message) {
  const msg = ' ' + normalize(message) + ' ';
  const map = {
    order:     [' dat hang ',' order ',' can mua ',' muon mua ',' dat truoc '],
    complaint: [' chan ',' that vong '],
    price:     [' gia bao nhieu ',' bao tien ',' cost ',' phi van chuyen '],
    stock:     [' con hang khong ',' het hang ',' con san pham khong '],
  };
  for (const [intent, keys] of Object.entries(map)) {
    if (keys.some(k => msg.includes(k))) return intent;
  }
  return 'general';
}

function findRelatedProducts(message, max = 4) {
  const msg = normalize(message);
  return products
    .map(p => {
      let score = 0;
      if (normalize(p.name).includes(msg))               score += 10;
      if (normalize(p.brand || '').includes(msg))        score += 6;
      if (normalize(p.categoryName || '').includes(msg)) score += 3;
      p.keywords.forEach(kw => {
        if (msg.includes(normalize(kw))) score += 4;
        if (normalize(kw).includes(msg)) score += 1;
      });
      (p.tags || []).forEach(tag => {
        if (msg.includes(normalize(tag))) score += 2;
      });
      return { ...p, score };
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

function findByCategory(message) {
  const msg = normalize(message);
  const cat = categories.find(c =>
    normalize(c.name).includes(msg) ||
    c.keywords.some(kw => msg.includes(normalize(kw)))
  );
  if (!cat) return [];
  return products.filter(p => p.category === cat.id && p.inStock !== false).slice(0, 5);
}

function buildProductContext(related) {
  if (!related.length) return '';
  const list = related.map(p => {
    let line = `- ${p.name}: ${p.price.toLocaleString('vi-VN')}đ/${p.unit || 'cái'}`;
    if (p.description) line += ` — ${p.description}`;
    if (p.inStock === false) line += ' [HẾT HÀNG]';
    if (p.variants?.length > 1) line += ` (có: ${p.variants.join(', ')})`;
    if (p.link) line += ` | 🛒 ${p.link}`;
    return line;
  }).join('\n');
  return `\n\nSản phẩm liên quan:\n${list}`;
}

function buildPolicyContext(intent) {
  const pol = policies.find(p => p.intent === intent);
  return pol ? `\n\nLưu ý: ${pol.content}` : '';
}

// ══════════════════════════════════════════════════════════════
// ZALO TOKEN MANAGEMENT
// ══════════════════════════════════════════════════════════════

async function checkAccessToken() {
  if (!zaloAccessToken) return false;
  try {
    const res = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { 'access_token': zaloAccessToken }
    });
    const valid = res.data?.error === 0;
    console.log('[Token] Kiểm tra access_token:', valid ? '✅ Còn hiệu lực' : `❌ Hết hạn (error ${res.data?.error})`);
    return valid;
  } catch (err) {
    console.log('[Token] Kiểm tra access_token: ❌ Lỗi —', err.message);
    return false;
  }
}

async function initToken() {
  const stillValid = await checkAccessToken();
  if (stillValid) {
    console.log('[Token] Access token còn hiệu lực — giữ nguyên, không tiêu thụ refresh_token.');
    return;
  }
  console.log('[Token] Access token hết hạn — tiến hành refresh...');
  await refreshZaloToken();
}

async function refreshZaloToken() {
  if (!zaloRefreshToken) {
    console.warn('[Token] Chưa có ZALO_REFRESH_TOKEN — bỏ qua refresh');
    return false;
  }
  if (!process.env.ZALO_APP_ID || !process.env.ZALO_APP_SECRET) {
    console.warn('[Token] Thiếu ZALO_APP_ID hoặc ZALO_APP_SECRET — bỏ qua refresh');
    return false;
  }
  try {
    console.log('[Token] Đang refresh Zalo access token...');
    const params = new URLSearchParams();
    params.append('grant_type',    'refresh_token');
    params.append('refresh_token', zaloRefreshToken);
    params.append('app_id',        process.env.ZALO_APP_ID);

    const res = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': process.env.ZALO_APP_SECRET } }
    );

    if (res.data.access_token) {
      zaloAccessToken  = res.data.access_token;
      zaloRefreshToken = res.data.refresh_token || zaloRefreshToken;
      console.log('════════════════════════════════════════');
      console.log('[Token] ✅ REFRESH THÀNH CÔNG!');
      console.log('[Token] ACCESS_TOKEN  mới:', zaloAccessToken);
      console.log('[Token] REFRESH_TOKEN mới:', zaloRefreshToken);
      console.log('[Token] Hãy copy 2 giá trị trên vào Railway env nếu cần!');
      console.log('════════════════════════════════════════');
      await updateRailwayEnvToken(zaloRefreshToken);
      return true;
    }
    console.error('[Token] Refresh thất bại — phản hồi:', JSON.stringify(res.data));
    return false;
  } catch (err) {
    console.error('[Token] Lỗi khi refresh:', err.message);
    if (err.response) console.error('[Token] Chi tiết:', JSON.stringify(err.response.data));
    return false;
  }
}

async function updateRailwayEnvToken(newRefreshToken) {
  const apiToken      = process.env.RAILWAY_API_TOKEN;
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!apiToken || !projectId || !serviceId || !environmentId) {
    console.log('[Railway] Bỏ qua cập nhật Railway env (thiếu RAILWAY_* config)');
    return;
  }
  try {
    const res = await axios.post(
      'https://backboard.railway.app/graphql/v2',
      {
        query: `mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        variables: { input: { projectId, environmentId, serviceId, name: 'ZALO_REFRESH_TOKEN', value: newRefreshToken } }
      },
      { headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }
    );
    if (res.data.errors) console.error('[Railway] Lỗi GraphQL:', JSON.stringify(res.data.errors));
    else console.log('[Railway] Đã cập nhật ZALO_REFRESH_TOKEN thành công.');
  } catch (err) {
    console.error('[Railway] Lỗi cập nhật env:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendStatus(200));

// ── ADMIN: Reload data từ Google Sheets ───────────────────────
app.get('/admin/reload-data', async (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'hasu2024';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const ok = await loadDataFromSheets();
  res.json({
    success: ok,
    message: ok ? 'Đã reload data từ Google Sheets thành công!' : 'Reload thất bại, xem log.',
    stats: { products: products.length, faqs: faqs.length, promotions: promotions.length,
             categories: categories.length, policies: policies.length },
    lastLoaded
  });
});

// ── ADMIN: Xem trạng thái tổng quan ──────────────────────────
app.get('/admin/status', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'hasu2024';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  res.json({
    data: { products: products.length, faqs: faqs.length, promotions: promotions.length,
            categories: categories.length, policies: policies.length },
    lastLoaded,
    token: {
      access_token_preview:  zaloAccessToken.slice(0, 20)  + '...',
      refresh_token_preview: zaloRefreshToken.slice(0, 20) + '...'
    }
  });
});

// ── ADMIN: Token management ───────────────────────────────────
app.get('/admin/token-status', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'hasu2024';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    access_token_preview:  zaloAccessToken.slice(0, 20)  + '...',
    refresh_token_preview: zaloRefreshToken.slice(0, 20) + '...',
    timestamp: new Date().toISOString()
  });
});

app.post('/admin/set-token', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'hasu2024';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  const { access_token, refresh_token } = req.body;
  if (!access_token && !refresh_token)
    return res.status(400).json({ error: 'Cần ít nhất access_token hoặc refresh_token' });
  if (access_token)  zaloAccessToken  = access_token;
  if (refresh_token) zaloRefreshToken = refresh_token;
  console.log('[Admin] Token đã được cập nhật thủ công.');
  res.json({ success: true, message: 'Token đã cập nhật thành công!' });
});

app.get('/admin/refresh-now', async (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'hasu2024';
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  const ok = await refreshZaloToken();
  res.json({ success: ok, message: ok ? 'Refresh thành công!' : 'Refresh thất bại. Xem log.' });
});

// ── ZALO DOMAIN VERIFY ────────────────────────────────────────
app.get('/zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<html><body>zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt</body></html>');
});

// ── WEBHOOK CHÍNH ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const event = req.body;

  if (event.event_name === 'follow') {
    const uid = event.follower?.id;
    if (uid) await sendZaloMessage(uid,
      'Chào mừng anh/chị đến với Bách hóa số Hasu! 👋\n' +
      'Em có thể tư vấn sản phẩm, báo giá và nhận đặt hàng.\n' +
      'Anh/Chị cần tìm gì hôm nay ạ? 😊'
    );
    return;
  }

  if (event.event_name !== 'user_send_text') return;

  const userId  = event.sender.id;
  const message = event.message.text;
  console.log(`[${new Date().toLocaleTimeString('vi-VN')}] Khách: ${message}`);

  const faqHit = findFAQ(message);
  if (faqHit) {
    await sendZaloMessage(userId, faqHit.answer);
    console.log('[FAQ hit] Không gọi Claude');
    return;
  }

  const promos = findPromotion(message);
  if (promos && promos.length > 0) {
    const promoText = promos.map(p =>
      `🎁 ${p.title}\n💰 Giá: ${p.price_sale.toLocaleString('vi-VN')}đ` +
      (p.gift ? `\n🎀 Quà tặng: ${p.gift}` : '') +
      (p.note ? `\n📌 ${p.note}` : '') +
      (p.link ? `\n🛒 Đặt ngay: ${p.link}` : '')
    ).join('\n\n');
    await sendZaloMessage(userId, `Ưu đãi đang có tại Hasu:\n\n${promoText}\n\nBạn muốn đặt hàng không ạ? 😊`);
    return;
  }

  const intent = detectIntent(message);
  if (intent === 'complaint') {
    await sendZaloMessage(userId,
      'Em rất tiếc về trải nghiệm của anh/chị! 😔\n' +
      'Để giải quyết nhanh nhất, em chuyển thông tin đến quản lý hỗ trợ anh/chị ngay.\n' +
      'Anh/Chị vui lòng cho em tên và SĐT để liên hệ lại nhé!'
    );
    return;
  }

  let related = findRelatedProducts(message);
  if (!related.length) related = findByCategory(message);

  const context = buildProductContext(related) + buildPolicyContext(intent);

  if (!histories[userId]) histories[userId] = [];
  histories[userId].push({ role: 'user', content: message });
  if (histories[userId].length > 20) histories[userId] = histories[userId].slice(-20);

  const reply = await callClaude(userId, context);
  histories[userId].push({ role: 'assistant', content: reply });
  await sendZaloMessage(userId, reply);
  console.log(`[Bot] → ${reply.substring(0, 80)}`);
});

// ══════════════════════════════════════════════════════════════
// GỌI CLAUDE API
// ══════════════════════════════════════════════════════════════
async function callClaude(userId, additionalContext = '') {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 300,
        system: BASE_PROMPT + additionalContext, messages: histories[userId] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY,
                   'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    return response.data.content[0].text;
  } catch (err) {
    console.error('Claude lỗi:', err.message);
    return 'Xin lỗi anh/chị, em đang gặp sự cố kỹ thuật. Vui lòng nhắn lại sau nhé!';
  }
}

// ══════════════════════════════════════════════════════════════
// GỬI TIN NHẮN QUA ZALO API v3
// ══════════════════════════════════════════════════════════════
async function sendZaloMessage(userId, text) {
  const doSend = (token) => axios.post(
    'https://openapi.zalo.me/v3.0/oa/message/cs',
    { recipient: { user_id: userId }, message: { text } },
    { headers: { 'access_token': token, 'Content-Type': 'application/json' } }
  );
  try {
    const res = await doSend(zaloAccessToken);
    console.log('Zalo OK:', JSON.stringify(res.data));
  } catch (err) {
    const errCode   = err.response?.data?.error;
    const httpStatus = err.response?.status;
    if (errCode === -216 || httpStatus === 401) {
      console.warn('[Token] Access token hết hạn — đang tự động refresh...');
      const ok = await refreshZaloToken();
      if (ok) {
        try {
          const res2 = await doSend(zaloAccessToken);
          console.log('Zalo OK (sau refresh):', JSON.stringify(res2.data));
        } catch (err2) {
          console.error('Zalo lỗi sau refresh:', err2.message);
        }
      } else {
        console.error('[Token] Refresh thất bại — không thể gửi tin nhắn.');
      }
    } else {
      console.error('Zalo lỗi:', err.message);
      console.error('Chi tiết:', JSON.stringify(err.response?.data));
    }
  }
}

// ══════════════════════════════════════════════════════════════
// KHỞI ĐỘNG SERVER
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server chạy tại cổng ${PORT}`);

  // Load data từ Google Sheets (fallback JSON)
  await initData();

  // Tự động reload data mỗi 30 phút
  setInterval(async () => {
    console.log('[Sheets] ⏰ Tự động reload data...');
    await loadDataFromSheets();
  }, 30 * 60 * 1000);
  console.log('[Sheets] Lịch reload: mỗi 30 phút.');

  // Kiểm tra và refresh Zalo token
  await initToken();

  // Lên lịch kiểm tra token mỗi 20 giờ
  setInterval(async () => {
    const stillValid = await checkAccessToken();
    if (!stillValid) await refreshZaloToken();
    else console.log('[Token] Định kỳ 20h: token còn tốt, bỏ qua refresh.');
  }, 20 * 60 * 60 * 1000);
  console.log('[Token] Lịch kiểm tra: mỗi 20 giờ.');
});
