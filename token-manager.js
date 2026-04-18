const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE = path.join('/tmp', 'zalo_tokens.json');

let currentTokens = {
  access_token:  process.env.ZALO_ACCESS_TOKEN  || '',
  refresh_token: process.env.ZALO_REFRESH_TOKEN || '',
  updated_at:    Date.now()
};

function loadSavedTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      currentTokens = saved;
      console.log('[Token] Loaded từ file');
    } else {
      console.log('[Token] Dùng token từ env');
      console.log('[Token] ACCESS_TOKEN exists:', !!currentTokens.access_token);
      console.log('[Token] REFRESH_TOKEN exists:', !!currentTokens.refresh_token);
    }
  } catch (e) {
    console.log('[Token] Load lỗi:', e.message);
  }
}

function getAccessToken() {
  return currentTokens.access_token;
}

async function refreshAccessToken() {
  try {
    console.log('[Token] Đang refresh...');
    console.log('[Token] APP_ID:', process.env.ZALO_APP_ID);
    console.log('[Token] APP_SECRET exists:', !!process.env.ZALO_APP_SECRET);
    console.log('[Token] REFRESH_TOKEN (50 ký tự đầu):', 
      (currentTokens.refresh_token || '').substring(0, 50));

    const params = new URLSearchParams();
    params.append('refresh_token', currentTokens.refresh_token);
    params.append('app_id',        process.env.ZALO_APP_ID);
    params.append('grant_type',    'refresh_token');

    const res = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'secret_key':   process.env.ZALO_APP_SECRET
        }
      }
    );

    console.log('[Token] Response status:', res.status);
    console.log('[Token] Response data:', JSON.stringify(res.data));

    const { access_token, refresh_token } = res.data;
    if (!access_token) {
      throw new Error('Không có access_token trong response: ' + JSON.stringify(res.data));
    }

    currentTokens = {
      access_token,
      refresh_token: refresh_token || currentTokens.refresh_token,
      updated_at: Date.now()
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(currentTokens, null, 2));
    console.log('[Token] ✓ Refresh thành công!');
    return access_token;

  } catch (err) {
    console.error('[Token] ✗ Lỗi:', err.message);
    if (err.response) {
      console.error('[Token] HTTP Status:', err.response.status);
      console.error('[Token] Response:', JSON.stringify(err.response.data));
    }
    throw err;
  }
}

function startAutoRefresh() {
  loadSavedTokens();

  // Kiểm tra ngay xem token có hợp lệ không — KHÔNG refresh ngay khi start
  if (!currentTokens.refresh_token) {
    console.error('[Token] ⚠ ZALO_REFRESH_TOKEN chưa được set trong Railway Variables!');
    return;
  }

  // Refresh mỗi 85 ngày — KHÔNG retry liên tục khi lỗi
  const INTERVAL_MS = 85 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await refreshAccessToken();
    } catch (e) {
      console.error('[Token] Auto-refresh thất bại, sẽ thử lại lần sau:', e.message);
      // KHÔNG throw — tránh crash server
    }
  }, INTERVAL_MS);

  console.log('[Token] Auto-refresh đã bật — mỗi 85 ngày');
}

module.exports = { getAccessToken, refreshAccessToken, startAutoRefresh };