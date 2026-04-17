// ── Khởi tạo ───────────────────────────────────────
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());
app.use(express.static('public'));

// Lưu lịch sử hội thoại theo user_id
// { "user123": [ {role, content}, ... ] }
const histories = {};

// System prompt CSKH
const SYSTEM_PROMPT = `Bạn là nhân viên chăm sóc khách hàng của Bách Hóa Số Hasu.
Cửa hàng bán: sữa tắm, nước giặt, nước rửa chén và các sản phẩm gia dụng khác.

NHIỆM VỤ:
- Tư vấn sản phẩm phù hợp với nhu cầu khách hàng
- Giải đáp thắc mắc về thành phần, công dụng, cách dùng
- Hỗ trợ đặt hàng và kiểm tra đơn hàng
- Giải quyết khiếu nại sau mua hàng

DANH SÁCH SẢN PHẨM HIỆN CÓ:
- Sữa tắm Dove 500ml: 85.000đ — dưỡng ẩm, hương nhẹ
- Sữa tắm Lifebuoy 500ml: 65.000đ — kháng khuẩn
- Nước giặt Omo 3kg: 120.000đ — tẩy vết bẩn cứng đầu
- Nước giặt Comfort 2.4L: 95.000đ — xả vải mềm mại
- Nước rửa chén Sunlight 750ml: 35.000đ — hương chanh
- Nước rửa chén Mỹ Hảo 1kg: 28.000đ — tiết kiệm
QUY TẮC TRẢ LỜI:
- Luôn xưng "tớ" với khách, gọi khách là "Cậu" 
- Trả lời ngắn gọn, thân thiện, không quá 3-4 câu
- Nếu khách hỏi giá cụ thể mà không có thông tin: nhờ khách để lại SĐT để nhân viên báo giá
- Nếu vấn đề phức tạp (khiếu nại, đổi trả): nói "Mình sẽ chuyển cho nhân viên hỗ trợ bạn trực tiếp nhé!"
- Không bịa thông tin sản phẩm khi không chắc chắn`;

// ── Ping check ─────────────────────────────────────
app.get('/', (req, res) => res.sendStatus(200));

// ── Xác thực domain Zalo ───────────────────────────
app.get('/zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<html><body>zalo_verifierNSAS0jpJA3iEtwmmZT0-A7djgp-LctvYCJCt</body></html>');
});

// ── Nhận tin nhắn từ Zalo ──────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const event = req.body;
  if (event.event_name !== 'user_send_text') return;

  const userId  = event.sender.id;
  const message = event.message.text;
  console.log(`[${new Date().toLocaleTimeString()}] Khách ${userId}: ${message}`);

  // Khởi tạo lịch sử nếu khách nhắn lần đầu
  if (!histories[userId]) histories[userId] = [];

  // Thêm tin nhắn khách vào lịch sử
  histories[userId].push({ role: 'user', content: message });

  // Giới hạn 20 tin nhắn gần nhất để tiết kiệm token
  if (histories[userId].length > 20) {
    histories[userId] = histories[userId].slice(-20);
  }

  // Gọi Claude và gửi trả lời
  const reply = await callClaude(userId);
  histories[userId].push({ role: 'assistant', content: reply });

  await sendZaloMessage(userId, reply);
  console.log(`[Bot] → ${reply}`);
});

// ── Gọi Claude API ─────────────────────────────────
async function callClaude(userId) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system:     SYSTEM_PROMPT,
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
    console.error('Claude API lỗi:', err.message);
    console.error('Chi tiết lỗi:', JSON.stringify(err.response?.data));
    return 'Nhà đang có việc bận, vui lòng đợi chút !';
  }
}

// ── Gửi tin nhắn qua Zalo ──────────────────────────
async function sendZaloMessage(userId, text) {
  try {
    const res = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      {
        recipient: { user_id: userId },
        message:   { text }
      },
      {
        headers: {
          'access_token': process.env.ZALO_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Zalo response:', JSON.stringify(res.data));
  } catch (err) {
    console.error('Zalo gửi tin lỗi:', err.message);
    console.error('Chi tiết Zalo:', JSON.stringify(err.response?.data));
  }
}

// ── Khởi động ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));