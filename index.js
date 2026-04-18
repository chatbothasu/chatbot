// Domain ngrok giữ cố định
// ngrok http --domain=overplant-serving-copious.ngrok-free.dev 3000
// ══════════════════════════════════════════════════════════════
// CHATBOT CSKH — Bách hóa số Hasu | Phiên bản RAG
// Luồng: FAQ check → Intent detect → Product search → Claude
// ══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());
app.use(express.static('public'));
const promotions = require('./data/promotions.json');

// ── LOAD DATA ─────────────────────────────────────────────────
const products   = require('./data/products.json');
const faqs       = require('./data/faq.json');
const categories = require('./data/categories.json');
const policies   = require('./data/policies.json');

// ── LỊCH SỬ HỘI THOẠI ────────────────────────────────────────
const histories = {};

// ── BASE PROMPT — Ngắn, không chứa data sản phẩm ─────────────
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

THÔNG TIN CỬA HÀNG:
- Địa chỉ: Khu 7, Phường Đại Phúc, TP Bắc Ninh
- Hotline: 0915359896
- Giờ mở cửa: 7h30 - 21h00, tất cả các ngày`;

// ══════════════════════════════════════════════════════════════
// CÁC HÀM RAG — TÌM KIẾM DATA
// ══════════════════════════════════════════════════════════════

// Chuẩn hóa text: bỏ dấu, lowercase — giúp tìm kiếm không phân biệt dấu
function normalize(text) {
  return (text || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

// Tìm FAQ — trả lời tức thì, KHÔNG gọi Claude
function findFAQ(message) {
  const msg = normalize(message);
  return faqs.find(faq =>
    faq.keywords.some(kw => msg.includes(normalize(kw)))
  ) || null;
}

// Tìm CTKM
function findPromotion(message) {
  const msg = ' ' + normalize(message) + ' ';

  // Bước 1: Phải có từ kích hoạt KM
  const triggerWords = ['khuyen mai', 'uu dai', 'giam gia', 'tang', 'combo', ' km ', 'sale', 'chuong trinh'];
  if (!triggerWords.some(w => msg.includes(normalize(w)))) return null;

  // Bước 2: Tìm KM theo TÊN SẢN PHẨM khách hỏi — không dùng keywords KM
  const productMatches = promotions.filter(p => {
    if (!p.active) return false;
    const productName = ' ' + normalize(p.product) + ' ';
    const title = ' ' + normalize(p.title) + ' ';

    // Lấy các từ quan trọng trong câu hỏi (bỏ stop words)
    const stopWords = ['co', 'khong', 'gi', 'nao', 'cua', 'la', 'va', 'the', 'dang', 'nha', 'ban', 'cho', 'toi', 'minh', 'voi', 'duoc', 'khuyen', 'mai', 'uu', 'dai', 'giam', 'gia', 'chuong', 'trinh', 'sale', 'km'];
    const queryWords = msg.trim().split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.includes(w));

    // Khớp từ sản phẩm với câu hỏi
    return queryWords.some(w =>
      productName.includes(' ' + w + ' ') ||
      title.includes(' ' + w + ' ')
    );
  });

  // Bước 3: Nếu không tìm được theo sản phẩm cụ thể → trả về tất cả KM đang active
  if (productMatches.length > 0) return productMatches.slice(0, 2);

  // Khách hỏi chung chung "có KM gì không" → trả về tất cả
  return promotions.filter(p => p.active).slice(0, 10);
}

// Phát hiện ý định câu hỏi (intent)
function detectIntent(message) {
  const msg = ' ' + normalize(message) + ' ';
  const map = {
    order:     [' dat hang ', ' order ', ' can mua ', ' muon mua ', ' dat truoc '],
    complaint: [' chan ',' that vong '],
    price:     [' gia bao nhieu ', ' bao tien ', ' cost ', ' phi van chuyen '],
    stock:     [' con hang khong ', ' het hang ', ' con san pham khong '],
  };
  for (const [intent, keys] of Object.entries(map)) {
    if (keys.some(k => msg.includes(k))) return intent;
  }
  return 'general';
}

// Tìm sản phẩm liên quan theo keyword — cho điểm và sắp xếp
function findRelatedProducts(message, max = 4) {
  const msg = normalize(message);
  return products
    .map(p => {
      let score = 0;
      if (normalize(p.name).includes(msg))          score += 10;
      if (normalize(p.brand || '').includes(msg))   score += 6;
      if (normalize(p.categoryName || '').includes(msg)) score += 3;
      p.keywords.forEach(kw => {
        if (msg.includes(normalize(kw)))             score += 4;
        if (normalize(kw).includes(msg))             score += 1;
      });
      (p.tags || []).forEach(tag => {
        if (msg.includes(normalize(tag)))            score += 2;
      });
      return { ...p, score };
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

// Tìm theo danh mục nếu không tìm được theo keyword
function findByCategory(message) {
  const msg = normalize(message);
  const cat = categories.find(c =>
    normalize(c.name).includes(msg) ||
    c.keywords.some(kw => msg.includes(normalize(kw)))
  );
  if (!cat) return [];
  return products
    .filter(p => p.category === cat.id && p.inStock !== false)
    .slice(0, 5);
}

// Tạo context sản phẩm ngắn gọn để ghép vào prompt
function buildProductContext(related) {
  if (!related.length) return '';
  const list = related.map(p => {
    let line = `- ${p.name}: ${p.price.toLocaleString('vi-VN')}đ/${p.unit || 'cái'}`;
    if (p.description) line += ` — ${p.description}`;
    if (p.inStock === false) line += ' [HẾT HÀNG]';
    if (p.variants?.length > 1) line += ` (có: ${p.variants.join(', ')})`;
    return line;
  }).join('\n');
  return `\n\nSản phẩm liên quan:\n${list}`;
}

// Lấy context chính sách theo intent
function buildPolicyContext(intent) {
  const pol = policies.find(p => p.intent === intent);
  return pol ? `\n\nLưu ý: ${pol.content}` : '';
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendStatus(200));

// Thay bằng mã xác thực domain Zalo của anh/chị
app.get('/zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<html><body>zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt</body></html>');
});

// ── WEBHOOK CHÍNH ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Trả lời Zalo NGAY TRƯỚC KHI xử lý

  const event = req.body;

  // Chào khách mới quan tâm OA
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

  // LỚP 1: FAQ — Trả lời ngay, không tốn token
  const faqHit = findFAQ(message);
  if (faqHit) {
    await sendZaloMessage(userId, faqHit.answer);
    console.log('[FAQ hit] Không gọi Claude');
    return;
  }

  // Kiểm tra khuyến mãi
const promos = findPromotion(message);
if (promos && promos.length > 0) {
  const promoText = promos.map(p =>
    `🎁 ${p.title}\n💰 Giá: ${p.price_sale.toLocaleString('vi-VN')}đ` +
    (p.gift ? `\n🎀 Quà tặng: ${p.gift}` : '') +
    (p.note ? `\n📌 ${p.note}` : '')
  ).join('\n\n');
  await sendZaloMessage(userId, `Ưu đãi đang có tại Hasu:\n\n${promoText}\n\nBạn muốn đặt hàng không ạ? 😊`);
  return;
}

  // LỚP 2: Phát hiện intent
  const intent = detectIntent(message);

  // Khiếu nại → chuyển người ngay
  if (intent === 'complaint') {
    await sendZaloMessage(userId,
      'Em rất tiếc về trải nghiệm của anh/chị! 😔\n' +
      'Để giải quyết nhanh nhất, em chuyển thông tin đến quản lý hỗ trợ anh/chị ngay.\n' +
      'Anh/Chị vui lòng cho em tên và SĐT để liên hệ lại nhé!'
    );
    return;
  }

  // LỚP 3: Tìm sản phẩm liên quan (RAG)
  let related = findRelatedProducts(message);
  if (!related.length) related = findByCategory(message);

  const context = buildProductContext(related) + buildPolicyContext(intent);

  // LỚP 4: Gọi Claude với context nhỏ gọn
  if (!histories[userId]) histories[userId] = [];
  histories[userId].push({ role: 'user', content: message });
  if (histories[userId].length > 20) {
    histories[userId] = histories[userId].slice(-20);
  }

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
      {
        model:      'claude-haiku-4-5',
        max_tokens: 300,
        system:     BASE_PROMPT + additionalContext,
        messages:   histories[userId]
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json'
        }
      }
    );
    return response.data.content[0].text;
  } catch (err) {
    console.error('Claude lỗi:', err.message);
    console.error('Chi tiết:', JSON.stringify(err.response?.data));
    return 'Xin lỗi anh/chị, em đang gặp sự cố kỹ thuật. Vui lòng nhắn lại sau nhé!';
  }
}

// ══════════════════════════════════════════════════════════════
// GỬI TIN NHẮN QUA ZALO API v3
// ══════════════════════════════════════════════════════════════
async function sendZaloMessage(userId, text) {
  try {
    const res = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: userId }, message: { text } },
      {
        headers: {
          'access_token': process.env.ZALO_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Zalo OK:', JSON.stringify(res.data));
  } catch (err) {
    console.error('Zalo lỗi:', err.message);
    console.error('Chi tiết:', JSON.stringify(err.response?.data));
  }
}


// ── KHỞI ĐỘNG ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));

