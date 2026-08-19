const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= 配置中心 ================= */
const CONFIG = {
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024, // 500MB
  autoCleanDays: parseInt(process.env.AUTO_CLEAN_DAYS) || 7,              // 0 = 关闭自动清理
  uploadDir: path.join(__dirname, 'uploads'),
  metaDir: path.join(__dirname, 'metadata'),
  msgFile: path.join(__dirname, 'messages.json'),
  publicDir: path.join(__dirname, 'public')
};

/* ================= 初始化目录 ================= */
[CONFIG.uploadDir, CONFIG.metaDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(CONFIG.msgFile)) fs.writeFileSync(CONFIG.msgFile, '[]');

/* ================= 中间件 ================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 安全头 & 跨域（前后端分离或 GitHub Pages 测试时必需）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 静态文件（从根目录提供，index.html 放根目录即可）
app.use(express.static(__dirname));

/* ================= 邮件 / 支付配置 ================= */
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

const paymentConfig = {
  enabled: process.env.ENABLE_PAYMENT === 'true',
  wechatQr: process.env.WECHAT_PAY_QR || '',
  alipayQr: process.env.ALIPAY_QR || '',
  paypalLink: process.env.PAYPAL_LINK || '',
  stripeLink: process.env.STRIPE_LINK || '',
  title: process.env.PAYMENT_TITLE || 'Support RecordDrop'
};

/* ================= 上传配置 ================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CONFIG.uploadDir),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    cb(null, `${id}.webm`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: CONFIG.maxFileSize },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  }
});

// Multer 错误统一处理（文件过大、格式不对等）
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        maxSize: CONFIG.maxFileSize,
        hint: 'Try a shorter recording or lower resolution'
      });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
}

/* ================= 工具：自动清理 ================= */
function cleanExpiredFiles() {
  if (CONFIG.autoCleanDays <= 0) return;
  const now = Date.now();
  const maxAge = CONFIG.autoCleanDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    fs.readdirSync(CONFIG.uploadDir).forEach(file => {
      const ext = path.extname(file);
      if (ext !== '.webm') return;
      const filePath = path.join(CONFIG.uploadDir, file);
      const metaPath = path.join(CONFIG.metaDir, file.replace('.webm', '.json'));
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
          cleaned++;
        }
      } catch (e) {}
    });
    if (cleaned > 0) console.log(`[Cleaner] Removed ${cleaned} expired file(s)`);
  } catch (e) {
    console.error('[Cleaner] Error:', e.message);
  }
}

// 每 6 小时扫一次，启动后 5 秒先执行一次
if (CONFIG.autoCleanDays > 0) {
  setInterval(cleanExpiredFiles, 6 * 60 * 60 * 1000);
  setTimeout(cleanExpiredFiles, 5000);
}

/* ================= API 路由 ================= */

// Health Check
app.get('/health', (req, res) => {
  let videoCount = 0;
  try { videoCount = fs.readdirSync(CONFIG.uploadDir).filter(f => f.endsWith('.webm')).length; } catch (e) {}
  res.json({
    status: 'ok',
    version: '0.3.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    storage: {
      videos: videoCount,
      autoCleanDays: CONFIG.autoCleanDays,
      maxFileSizeBytes: CONFIG.maxFileSize
    }
  });
});

// 上传
app.post('/upload', upload.single('video'), handleUploadError, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = req.file.filename.replace('.webm', '');
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;

  const meta = {
    id,
    createdAt: new Date().toISOString(),
    filename: req.file.filename,
    size: req.file.size,
    views: 0,
    viewLog: []
  };
  fs.writeFileSync(path.join(CONFIG.metaDir, `${id}.json`), JSON.stringify(meta, null, 2));

  res.json({
    url: `${protocol}://${host}/v/${id}`,
    id,
    serverPath: `/uploads/${req.file.filename}`,
    size: req.file.size
  });
});

// 删除
app.delete('/uploads/:id', (req, res) => {
  const file = path.join(CONFIG.uploadDir, `${req.params.id}.webm`);
  const metaFile = path.join(CONFIG.metaDir, `${req.params.id}.json`);
  let deleted = false;
  if (fs.existsSync(file)) { fs.unlinkSync(file); deleted = true; }
  if (fs.existsSync(metaFile)) { fs.unlinkSync(metaFile); deleted = true; }
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, message: 'Deleted' });
});

// 视频元数据查询（新增）
app.get('/api/video/:id', (req, res) => {
  const file = path.join(CONFIG.uploadDir, `${req.params.id}.webm`);
  const metaFile = path.join(CONFIG.metaDir, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Video not found' });

  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch(e) {}
  }
  const stat = fs.statSync(file);
  res.json({
    id: req.params.id,
    size: stat.size,
    createdAt: meta.createdAt || stat.mtime.toISOString(),
    views: meta.views || 0,
    url: `/v/${req.params.id}`
  });
});

// 邮件分享
app.post('/api/share/email', async (req, res) => {
  if (!mailTransporter) return res.status(503).json({ error: 'SMTP not configured' });
  const { to, videoUrl, message, senderName } = req.body;
  if (!to || !videoUrl) return res.status(400).json({ error: 'Recipient and URL required' });
  try {
    await mailTransporter.sendMail({
      from: `"${senderName || 'RecordDrop'}" <${process.env.SMTP_USER}>`,
      to,
      subject: `${senderName || 'Someone'} shared a screen recording with you`,
      html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1f2937;">
        <h2 style="color:#22c55e;margin-bottom:16px;">📹 New Screen Recording</h2>
        <p style="font-size:16px;line-height:1.6;">${senderName || 'Someone'} has shared a screen recording with you via <strong>RecordDrop</strong>.</p>
        ${message ? `<div style="background:#f3f4f6;padding:16px;border-radius:10px;margin:20px 0;font-style:italic;color:#4b5563;">${message.replace(/</g,'&lt;')}</div>` : ''}
        <div style="margin:32px 0;text-align:center;">
          <a href="${videoUrl}" style="background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:600;display:inline-block;font-size:16px;">Watch Video</a>
        </div>
        <p style="color:#6b7280;font-size:14px;">Or copy this link:<br>
        <code style="background:#f3f4f6;padding:10px 14px;border-radius:8px;display:inline-block;margin-top:10px;word-break:break-all;">${videoUrl}</code></p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:40px 0;">
        <p style="color:#9ca3af;font-size:13px;text-align:center;">Powered by <a href="https://recorddrop.site" style="color:#22c55e;text-decoration:none;">RecordDrop</a></p>
      </div>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Email]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 支付配置
app.get('/api/payment/config', (req, res) => res.json(paymentConfig));

// 留言板
app.get('/api/messages', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CONFIG.msgFile, 'utf8')).reverse()); }
  catch(e) { res.json([]); }
});

app.post('/api/messages', (req, res) => {
  const { name, email, message, replyTo } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'Name and message required' });
  const msgs = JSON.parse(fs.readFileSync(CONFIG.msgFile, 'utf8'));
  const newMsg = {
    id: crypto.randomBytes(6).toString('hex'),
    name: name.slice(0, 50),
    email: email ? email.slice(0, 100) : '',
    message: message.slice(0, 2000),
    replyTo: replyTo || null,
    createdAt: new Date().toISOString()
  };
  msgs.push(newMsg);
  fs.writeFileSync(CONFIG.msgFile, JSON.stringify(msgs, null, 2));
  res.json(newMsg);
});

// 播放量
app.get('/api/views/:id', (req, res) => {
  const metaFile = path.join(CONFIG.metaDir, `${req.params.id}.json`);
  if (!fs.existsSync(metaFile)) return res.json({ views: 0 });
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    res.json({ views: meta.views || 0 });
  } catch(e) { res.json({ views: 0 }); }
});

/* ================= 页面路由 ================= */

// 播放页
app.get('/v/:id', (req, res) => {
  const file = path.join(CONFIG.uploadDir, `${req.params.id}.webm`);
  const metaFile = path.join(CONFIG.metaDir, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).send('Video not found');

  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      meta.views = (meta.views || 0) + 1;
      meta.viewLog.push({ ip: req.ip, time: new Date().toISOString() });
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    } catch(e) {}
  }

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Video - RecordDrop</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#e2e2e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}.container{width:100%;max-width:900px}.header{text-align:center;margin-bottom:32px}.header h1{font-size:18px;color:#6b7280;font-weight:500;margin-bottom:8px}.header a{color:#22c55e;text-decoration:none;font-weight:600}.video-wrap{background:linear-gradient(145deg,#13131a 0%,#1a1a24 100%);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:24px;box-shadow:0 24px 48px -12px rgba(0,0,0,0.5)}video{width:100%;border-radius:12px;display:block;background:#000}.meta{margin-top:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}.meta-left{color:#6b7280;font-size:14px}.meta-right{display:flex;gap:10px}.btn{padding:10px 20px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.2s}.btn-primary{background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);color:white}.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(34,197,94,0.3)}.btn-secondary{background:rgba(255,255,255,0.06);color:#e2e2e8;border:1px solid rgba(255,255,255,0.08)}.btn-secondary:hover{background:rgba(255,255,255,0.1)}.share-box{margin-top:16px;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;display:none}.share-box h4{color:#fff;font-size:14px;margin-bottom:12px}.share-input{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;color:#fff;font-family:inherit;margin-bottom:10px;outline:none}.share-input:focus{border-color:rgba(34,197,94,0.4)}.share-row{display:flex;gap:8px}.payment-box{margin-top:16px;padding:16px;background:rgba(34,197,94,0.05);border:1px solid rgba(34,197,94,0.15);border-radius:12px;display:none;text-align:center}.payment-box h4{color:#22c55e;font-size:14px;margin-bottom:10px}.qr-row{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}.qr-row img{width:160px;height:160px;border-radius:10px;background:#fff;padding:4px}.footer{margin-top:40px;text-align:center;color:#4b5563;font-size:13px}.footer a{color:#6b7280;text-decoration:none}@media(max-width:640px){.video-wrap{padding:16px}}</style></head><body><div class="container"><div class="header"><h1>Recorded with <a href="/">RecordDrop</a></h1><p style="color:#4b5563;font-size:13px;">Screen recording that never loses your video</p></div><div class="video-wrap"><video src="/uploads/${req.params.id}.webm" controls autoplay playsinline></video><div class="meta"><div class="meta-left"><span id="viewCount">Loading views...</span> · No login required</div><div class="meta-right"><button class="btn btn-secondary" onclick="copyLink()">Copy Link</button><button class="btn btn-secondary" onclick="toggleShare()">Send to...</button><a href="/uploads/${req.params.id}.webm" class="btn btn-primary" download>Download</a></div></div><div class="share-box" id="shareBox"><h4>📧 Send this video via email</h4><input type="email" class="share-input" id="emailTo" placeholder="recipient@example.com"><input type="text" class="share-input" id="emailMsg" placeholder="Optional message..."><div class="share-row"><button class="btn btn-primary" onclick="sendEmail()">Send Email</button><button class="btn btn-secondary" onclick="toggleShare()">Cancel</button></div><p id="emailStatus" style="margin-top:10px;font-size:13px;color:#6b7280;"></p></div><div class="payment-box" id="paymentBox"><h4>☕ Support the creator</h4><div class="qr-row" id="qrRow"></div></div></div><div class="footer"><p>Want your own videos saved safely? <a href="/">Try RecordDrop free</a></p></div></div><script>fetch('/api/views/${req.params.id}').then(r=>r.json()).then(data=>{document.getElementById('viewCount').textContent=data.views+' view'+(data.views!==1?'s':'')}).catch(()=>{document.getElementById('viewCount').textContent='0 views'});function copyLink(){navigator.clipboard.writeText(window.location.href).then(()=>{const btn=document.querySelector('.btn-secondary');btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy Link',2000)})}function toggleShare(){const box=document.getElementById('shareBox');box.style.display=box.style.display==='block'?'none':'block';}async function sendEmail(){const to=document.getElementById('emailTo').value.trim();const msg=document.getElementById('emailMsg').value.trim();const status=document.getElementById('emailStatus');if(!to){status.textContent='Please enter an email address';status.style.color='#ef4444';return;}status.textContent='Sending...';status.style.color='#6b7280';try{const res=await fetch('/api/share/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,videoUrl:window.location.href,message:msg})});if(res.ok){status.textContent='✅ Email sent!';status.style.color='#22c55e';document.getElementById('emailTo').value='';document.getElementById('emailMsg').value='';}else{const err=await res.json();status.textContent='❌ '+(err.error||'Failed');status.style.color='#ef4444';}}catch(e){status.textContent='❌ Network error';status.style.color='#ef4444';}}fetch('/api/payment/config').then(r=>r.json()).then(cfg=>{if(cfg.enabled){const box=document.getElementById('paymentBox');const row=document.getElementById('qrRow');let html='';if(cfg.wechatQr)html+='<div><img src="'+cfg.wechatQr+'" alt="WeChat Pay"></div>';if(cfg.alipayQr)html+='<div><img src="'+cfg.alipayQr+'" alt="Alipay"></div>';if(cfg.paypalLink)html+='<a href="'+cfg.paypalLink+'" target="_blank" class="btn btn-primary" style="text-decoration:none;">PayPal</a>';if(html){row.innerHTML=html;box.style.display='block';}}});</script></body></html>`);
});

// About
app.get('/about', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>About - RecordDrop</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#e2e2e8;min-height:100vh;padding:60px 24px;line-height:1.6}.container{max-width:720px;margin:0 auto}.nav{display:flex;gap:24px;margin-bottom:48px;font-size:14px}.nav a{color:#6b7280;text-decoration:none;transition:color 0.2s}.nav a:hover{color:#22c55e}h1{font-size:36px;color:#fff;margin-bottom:16px}h2{font-size:20px;color:#fff;margin:40px 0 16px}p{color:#9ca3af;margin-bottom:16px;font-size:16px}.highlight{color:#22c55e;font-weight:600}.story{background:linear-gradient(145deg,#13131a 0%,#1a1a24 100%);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:32px;margin:32px 0}.story p:last-child{margin-bottom:0}.footer{margin-top:64px;text-align:center;color:#4b5563;font-size:14px}.footer a{color:#6b7280;text-decoration:none}</style></head><body><div class="container"><div class="nav"><a href="/">← Home</a><a href="/terms">Terms</a><a href="/feedback">Feedback</a></div><h1>About RecordDrop</h1><p>RecordDrop is an <span class="highlight">open-source, local-first screen recorder</span> built for people who are tired of losing videos to failed uploads, subscription traps, and vendor lock-in.</p><div class="story"><h2>Why we built this</h2><p>It started with a 30-minute bug reproduction. Recorded. Stopped. Upload stuck at 0%. Video gone forever.</p><p>That was the moment we realized: cloud-first recording is backwards. The most important thing isn't the share link — it's the <span class="highlight">file itself</span>. If the file isn't safe on your machine first, nothing else matters.</p></div><h2>Our philosophy</h2><p><strong>Local-first:</strong> Every recording hits your hard drive instantly. Uploads are optional, not mandatory.</p><p><strong>No limits:</strong> Record for 5 seconds or 5 hours. Your only limit is disk space.</p><p><strong>Own your data:</strong> Self-host with Docker. Your videos never leave your infrastructure unless you choose to share them.</p><p><strong>Flat pricing:</strong> Core features free forever. Pro features (AI, team) start at $8/month. No per-seat tax.</p><h2>Open source</h2><p>RecordDrop is open source because we believe tools that handle your data should be transparent. The full source code is available on GitHub.</p><div class="footer"><p>© 2026 RecordDrop · <a href="/">Home</a> · <a href="/terms">Terms</a> · <a href="/feedback">Feedback</a></p></div></div></body></html>`);
});

// Terms
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Terms of Service - RecordDrop</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#e2e2e8;min-height:100vh;padding:60px 24px;line-height:1.6}.container{max-width:720px;margin:0 auto}.nav{display:flex;gap:24px;margin-bottom:48px;font-size:14px}.nav a{color:#6b7280;text-decoration:none;transition:color 0.2s}.nav a:hover{color:#22c55e}h1{font-size:36px;color:#fff;margin-bottom:16px}h2{font-size:20px;color:#fff;margin:32px 0 12px}p{color:#9ca3af;margin-bottom:16px;font-size:15px}ul{color:#9ca3af;margin:0 0 16px 20px;font-size:15px}li{margin-bottom:8px}.footer{margin-top:64px;text-align:center;color:#4b5563;font-size:14px}.footer a{color:#6b7280;text-decoration:none}</style></head><body><div class="container"><div class="nav"><a href="/">← Home</a><a href="/about">About</a><a href="/feedback">Feedback</a></div><h1>Terms of Service</h1><p><strong>Last updated:</strong> August 16, 2026</p><h2>1. Service Description</h2><p>RecordDrop provides screen recording and video sharing services. We offer both a self-hosted open-source version and a hosted web service.</p><h2>2. Data Storage</h2><p>For the self-hosted version, all video data is stored on your own server. We do not have access to your recordings.</p><p>For the hosted version (recorddrop.site), uploaded videos are stored temporarily on our servers. You can delete them at any time.</p><h2>3. Acceptable Use</h2><ul><li>Do not use RecordDrop to record or share illegal content</li><li>Do not use the service to distribute malware or spam</li><li>Respect intellectual property rights when recording</li></ul><h2>4. Disclaimer</h2><p>RecordDrop is provided "as is" without warranties of any kind. While we strive for 100% reliability, we are not responsible for lost recordings caused by browser crashes, network failures, or user error.</p><p>We strongly recommend downloading your recordings locally as a backup.</p><h2>5. Changes to Terms</h2><p>We may update these terms from time to time. Continued use of the service after changes constitutes acceptance of the new terms.</p><div class="footer"><p>© 2026 RecordDrop · <a href="/">Home</a> · <a href="/about">About</a> · <a href="/feedback">Feedback</a></p></div></div></body></html>`);
});

// Feedback
app.get('/feedback', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Feedback - RecordDrop</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#e2e2e8;min-height:100vh;padding:60px 24px;line-height:1.6}.container{max-width:720px;margin:0 auto}.nav{display:flex;gap:24px;margin-bottom:48px;font-size:14px}.nav a{color:#6b7280;text-decoration:none;transition:color 0.2s}.nav a:hover{color:#22c55e}h1{font-size:36px;color:#fff;margin-bottom:8px}.subtitle{color:#6b7280;margin-bottom:32px}.form{background:linear-gradient(145deg,#13131a 0%,#1a1a24 100%);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:32px;margin-bottom:40px}.form-group{margin-bottom:20px}label{display:block;color:#9ca3af;font-size:14px;margin-bottom:8px;font-weight:500}input,textarea{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 16px;color:#fff;font-family:inherit;font-size:15px;outline:none;transition:all 0.2s}input:focus,textarea:focus{border-color:rgba(34,197,94,0.4);background:rgba(255,255,255,0.06)}textarea{min-height:120px;resize:vertical}.btn-submit{background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);color:white;border:none;padding:14px 28px;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.2s}.btn-submit:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(34,197,94,0.3)}.messages{margin-top:32px}.msg-item{background:linear-gradient(145deg,#13131a 0%,#1a1a24 100%);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:24px;margin-bottom:16px}.msg-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}.msg-name{color:#fff;font-weight:600;font-size:15px}.msg-time{color:#4b5563;font-size:13px}.msg-body{color:#9ca3af;font-size:15px;line-height:1.6;white-space:pre-wrap}.msg-reply{margin-top:12px;padding-left:16px;border-left:2px solid rgba(34,197,94,0.3);color:#6b7280;font-size:14px}.empty{text-align:center;color:#4b5563;padding:40px 0}.footer{margin-top:64px;text-align:center;color:#4b5563;font-size:14px}.footer a{color:#6b7280;text-decoration:none}</style></head><body><div class="container"><div class="nav"><a href="/">← Home</a><a href="/about">About</a><a href="/terms">Terms</a></div><h1>Feedback</h1><p class="subtitle">Leave a public message. We read every single one.</p><div class="form"><div class="form-group"><label>Name</label><input type="text" id="msgName" placeholder="Your name" maxlength="50"></div><div class="form-group"><label>Email (optional)</label><input type="email" id="msgEmail" placeholder="you@example.com" maxlength="100"></div><div class="form-group"><label>Message</label><textarea id="msgBody" placeholder="What's on your mind? Feature requests, bug reports, or just saying hi..." maxlength="2000"></textarea></div><button class="btn-submit" onclick="submitMsg()">Post Message</button></div><div class="messages" id="msgList"><div class="empty">Loading messages...</div></div><div class="footer"><p>© 2026 RecordDrop · <a href="/">Home</a> · <a href="/about">About</a> · <a href="/terms">Terms</a></p></div></div><script>async function loadMsgs(){try{const res=await fetch('/api/messages');const msgs=await res.json();const box=document.getElementById('msgList');if(!msgs.length){box.innerHTML='<div class="empty">No messages yet. Be the first!</div>';return}box.innerHTML=msgs.map(m=>{const date=new Date(m.createdAt).toLocaleString();let html='<div class="msg-item"><div class="msg-header"><span class="msg-name">'+(m.name||'Anonymous')+'</span><span class="msg-time">'+date+'</span></div><div class="msg-body">'+escapeHtml(m.message)+'</div>';if(m.replyTo){html+='<div class="msg-reply">↳ Reply to #'+m.replyTo+'</div>'}html+='</div>';return html}).join('')}catch(e){document.getElementById('msgList').innerHTML='<div class="empty">Failed to load messages.</div>'}}function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}async function submitMsg(){const name=document.getElementById('msgName').value.trim();const email=document.getElementById('msgEmail').value.trim();const message=document.getElementById('msgBody').value.trim();if(!name||!message){alert('Please enter your name and message.');return}try{const res=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,message})});if(res.ok){document.getElementById('msgName').value='';document.getElementById('msgEmail').value='';document.getElementById('msgBody').value='';loadMsgs()}else{alert('Failed to post. Please try again.')}}catch(e){alert('Network error. Please try again.')}}loadMsgs()</script></body></html>`);
});

/* ================= Pro 预留 API（保持 501） ================= */
app.post('/api/webhook/register', (req, res) => res.status(501).json({ error: 'Webhooks are a Pro feature.', plan: 'https://github.com/dj1988022/RecordDrop#pro', docs: 'Coming in v0.4.0' }));
app.post('/api/ai/title', (req, res) => res.status(501).json({ error: 'AI features are a Pro feature.', plan: 'https://github.com/dj1988022/RecordDrop#pro', docs: 'Coming in v0.4.0' }));
app.post('/api/ai/transcribe', (req, res) => res.status(501).json({ error: 'AI transcription is a Pro feature.', plan: 'https://github.com/dj1988022/RecordDrop#pro', docs: 'Coming in v0.4.0' }));
app.post('/api/team/workspace', (req, res) => res.status(501).json({ error: 'Team workspaces are a Pro feature.', plan: 'https://github.com/dj1988022/RecordDrop#pro', docs: 'Coming in v0.5.0' }));
app.post('/api/team/comment', (req, res) => res.status(501).json({ error: 'Team comments are a Pro feature.', plan: 'https://github.com/dj1988022/RecordDrop#pro', docs: 'Coming in v0.5.0' }));
app.post('/api/trim', (req, res) => res.status(501).json({ error: 'Trim requires FFmpeg.', hint: 'apt install ffmpeg', docs: 'Coming in v0.3.0' }));
app.post('/api/convert/mp4', (req, res) => res.status(501).json({ error: 'MP4 conversion requires FFmpeg.', hint: 'apt install ffmpeg', docs: 'Coming in v0.3.0' }));

/* ================= 静态视频目录 & 兜底错误 ================= */
app.use('/uploads', express.static(CONFIG.uploadDir));

// 全局错误处理（防止进程崩溃）
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RecordDrop v0.3.0 running on http://0.0.0.0:${PORT}`);
  console.log(`Auto-clean: ${CONFIG.autoCleanDays > 0 ? CONFIG.autoCleanDays + ' days' : 'disabled'}`);
  console.log(`Max file size: ${(CONFIG.maxFileSize / 1024 / 1024).toFixed(0)} MB`);
});
