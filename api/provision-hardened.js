/**
 * Coldflows Domain Provisioning — WITH APPROVAL GATE
 * ====================================================
 * VPS: 170.64.130.130 (coldflows-automation, DigitalOcean Sydney)
 * 
 * CRITICAL: ZERO domains purchased without manual approval.
 * 
 * FLOW:
 * 1. Webhook → validate → generate domain list → check availability
 * 2. Send approval request to Telegram with: domains, pricing, total, client
 * 3. WAIT. Nothing happens until Thomas approves.
 * 4. Thomas approves via link or /approve command in Telegram
 * 5. ONLY THEN purchases happen, one at a time, with notifications
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

try {
  const fs = require('fs');
  const envFile = fs.readFileSync('/opt/coldflows/.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
} catch (e) {}

const CONFIG = {
  namecheap: { api_key: process.env.NAMECHEAP_API_KEY, user: process.env.NAMECHEAP_USER || 'coldflowsai', base: 'https://api.namecheap.com/xml.response', client_ip: process.env.VPS_IP || '170.64.130.130' },
  supabase: { url: process.env.SUPABASE_URL || 'https://bmjjyujuyjpkyggormoa.supabase.co', key: process.env.SUPABASE_KEY },
  telegram: { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID || '' },
  max_price_per_domain: 15.00, rate_limit_ms: 1500, rdap_rate_limit_ms: 200, port: 3000,
};
const PLAN_LIMITS = { starter: { mailboxes: 4, campaigns: 2 }, growth: { mailboxes: 12, campaigns: 4 }, scale: { mailboxes: 30, campaigns: 10 } };
const pendingApprovals = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (level, msg) => console.log(`[${new Date().toISOString().slice(0,19)}] [${level}] ${msg}`);

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: options.method || 'GET', headers: options.headers || {}, timeout: 15000 }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body }); } });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}
function fetchXML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve(body)); }).on('error', reject);
  });
}

async function notify(message) {
  if (!CONFIG.telegram.chat_id) return;
  try { await fetchJSON(`https://api.telegram.org/bot${CONFIG.telegram.bot_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CONFIG.telegram.chat_id, text: message, parse_mode: 'HTML' }) }); } catch (e) { log('ERROR', 'Telegram failed: ' + e.message); }
}

async function getCustomer(userId) {
  const resp = await fetchJSON(`${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}&select=*`, { headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}` } });
  if (!resp.body || !resp.body[0]) throw new Error('Customer not found: ' + userId);
  const c = resp.body[0];
  c._targeting = typeof c.target_market === 'string' ? JSON.parse(c.target_market) : c.target_market || {};
  c._limits = PLAN_LIMITS[c.plan] || PLAN_LIMITS.starter;
  return c;
}
async function updateTargetMarket(userId, targeting) {
  await fetchJSON(`${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}`, { method: 'PATCH', headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ target_market: JSON.stringify(targeting) }) });
}

function generateCandidates(businessName) {
  const clean = businessName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  if (clean.length < 3) throw new Error('Business name too short');
  const suffixes = ['mail','sends','reach','hub','team','hq','go','now','pro','ops','run','flow','labs','direct','inbox','connect','msg','ping','works','zone','desk','base','wave','notify','out','send','hello','link','grid','core'];
  const prefixes = ['get','try','use','hey','hi','meet','from','with'];
  const c = [];
  for (const s of suffixes) c.push(clean+s+'.com');
  for (const p of prefixes) c.push(p+clean+'.com');
  for (let i = 10; i < 100; i += 7) c.push(clean+i+'.com');
  return [...new Set(c)].slice(0, 60);
}

function checkRDAP(domain) {
  return new Promise(resolve => {
    https.get('https://rdap.verisign.com/com/v1/domain/' + domain, { timeout: 5000 }, res => {
      resolve(res.statusCode === 404); res.resume();
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

async function checkNamecheap(domain) {
  const xml = await fetchXML(`${CONFIG.namecheap.base}?ApiUser=${CONFIG.namecheap.user}&ApiKey=${CONFIG.namecheap.api_key}&UserName=${CONFIG.namecheap.user}&ClientIp=${CONFIG.namecheap.client_ip}&Command=namecheap.domains.check&DomainList=${domain}`);
  return { available: xml.includes('Available="true"'), premium: xml.includes('IsPremiumName="true"') };
}

async function registerDomain(domain) {
  const params = `ApiUser=${CONFIG.namecheap.user}&ApiKey=${CONFIG.namecheap.api_key}&UserName=${CONFIG.namecheap.user}&ClientIp=${CONFIG.namecheap.client_ip}&Command=namecheap.domains.create&DomainName=${domain}&Years=1&RegistrantFirstName=Thomas&RegistrantLastName=Flood&RegistrantAddress1=Currumbin+Waters&RegistrantCity=Gold+Coast&RegistrantStateProvince=Queensland&RegistrantPostalCode=4223&RegistrantCountry=AU&RegistrantPhone=%2B61.400000000&RegistrantEmailAddress=tomflood1995%40gmail.com&TechFirstName=Thomas&TechLastName=Flood&TechAddress1=Currumbin+Waters&TechCity=Gold+Coast&TechStateProvince=Queensland&TechPostalCode=4223&TechCountry=AU&TechPhone=%2B61.400000000&TechEmailAddress=tomflood1995%40gmail.com&AdminFirstName=Thomas&AdminLastName=Flood&AdminAddress1=Currumbin+Waters&AdminCity=Gold+Coast&AdminStateProvince=Queensland&AdminPostalCode=4223&AdminCountry=AU&AdminPhone=%2B61.400000000&AdminEmailAddress=tomflood1995%40gmail.com&AuxBillingFirstName=Thomas&AuxBillingLastName=Flood&AuxBillingAddress1=Currumbin+Waters&AuxBillingCity=Gold+Coast&AuxBillingStateProvince=Queensland&AuxBillingPostalCode=4223&AuxBillingCountry=AU&AuxBillingPhone=%2B61.400000000&AuxBillingEmailAddress=tomflood1995%40gmail.com&AddFreeWhoisguard=yes&WGEnabled=yes`;
  const xml = await fetchXML(`${CONFIG.namecheap.base}?${params}`);
  return {
    success: xml.includes('Status="OK"') && xml.includes('Registered="true"'),
    domainId: (xml.match(/DomainID="(\d+)"/) || [])[1],
    cost: parseFloat((xml.match(/ChargedAmount="([\d.]+)"/) || [])[1] || '10.98'),
    error: (xml.match(/<Error[^>]*>(.*?)<\/Error>/) || [])[1],
  };
}

// =============================================
// PHASE 1: PLAN (no money spent)
// =============================================
async function generatePlan(userId) {
  const jobId = 'plan_' + Date.now();
  log('INFO', 'Generating purchase plan: ' + jobId);

  const customer = await getCustomer(userId);
  const t = customer._targeting;
  const limits = customer._limits;
  const conf = t.campaigns_confirmed || [];
  if (conf.length < limits.campaigns) return { error: 'Campaigns not confirmed' };

  const existing = ((t.provisioning || {}).domains || []).filter(d => d.status === 'purchased');
  const remaining = limits.mailboxes - existing.length;
  if (remaining <= 0) return { message: 'All domains already purchased' };

  const candidates = generateCandidates(customer.business_name).filter(d => !existing.find(e => e.domain === d));
  const available = [];

  for (const domain of candidates) {
    if (available.length >= remaining + 3) break;
    const rdap = await checkRDAP(domain);
    if (rdap) {
      const nc = await checkNamecheap(domain);
      if (nc.available && !nc.premium) { available.push({ domain, price: 10.98 }); log('INFO', '  OK: ' + domain); }
      await sleep(CONFIG.rate_limit_ms);
    }
    await sleep(CONFIG.rdap_rate_limit_ms);
  }

  if (available.length < remaining) {
    await notify('🚨 Not enough domains found for ' + customer.business_name);
    return { error: 'Not enough domains' };
  }

  const selected = available.slice(0, remaining);
  const total = selected.reduce((s, d) => s + d.price, 0);

  // Get Namecheap account balance
  let ncBalance = null;
  try {
    const balXml = await fetchXML(`${CONFIG.namecheap.base}?ApiUser=${CONFIG.namecheap.user}&ApiKey=${CONFIG.namecheap.api_key}&UserName=${CONFIG.namecheap.user}&ClientIp=${CONFIG.namecheap.client_ip}&Command=namecheap.users.getBalances`);
    const balMatch = balXml.match(/AvailableBalance="([\d.]+)"/);
    ncBalance = balMatch ? parseFloat(balMatch[1]) : null;
  } catch(e) { log('WARN', 'Could not fetch Namecheap balance'); }

  const audRate = 1.55;
  const toAud = (usd) => (usd * audRate).toFixed(2);
  const balanceShortfall = ncBalance !== null ? Math.max(0, total - ncBalance) : null;

  const plan = { jobId, userId, customer: customer.business_name, email: customer.email, plan: customer.plan, domains: selected, total, existing: existing.length, needed: remaining, createdAt: now(), ncBalance, balanceShortfall };
  pendingApprovals[jobId] = plan;

  if (!t.provisioning) t.provisioning = {};
  t.provisioning.status = 'awaiting_approval';
  t.provisioning.pending_plan = plan;
  await updateTargetMarket(userId, t);

  const list = selected.map((d, i) => `  ${i+1}. ${d.domain} — A$${toAud(d.price)}`).join('\n');
  const balLine = ncBalance !== null ? `\n<b>Namecheap balance:</b> A$${toAud(ncBalance)} (US$${ncBalance.toFixed(2)})` : '';
  const shortfallLine = balanceShortfall > 0 ? `\n⚠️ <b>Need to add: A$${toAud(balanceShortfall)} (US$${balanceShortfall.toFixed(2)})</b>` : (ncBalance !== null ? '\n✅ Balance sufficient' : '');

  await notify(
    `🧊 COLDFLOWS — APPROVAL REQUIRED\n━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Customer:</b> ${customer.business_name}\n` +
    `<b>Email:</b> ${customer.email}\n` +
    `<b>Plan:</b> ${customer.plan.toUpperCase()}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Domains to purchase (${remaining}):</b>\n${list}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>💰 Total: A$${toAud(total)} (US$${total.toFixed(2)})</b>\n` +
    `Per domain: A$${toAud(selected[0].price)}` +
    balLine + shortfallLine +
    `\nAlready owned: ${existing.length}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ Approve in Coldflows dashboard:\nhttps://coldflows.ai/app\n\n` +
    `❌ To reject, open dashboard and click Reject.`
  );

  log('INFO', `Plan sent for approval. ${remaining} domains, $${total.toFixed(2)}`);
  return { jobId, status: 'awaiting_approval' };
}

// =============================================
// PHASE 2: PURCHASE (only after approval)
// =============================================
async function executePurchase(jobId) {
  const plan = pendingApprovals[jobId];
  if (!plan) return { error: 'Plan not found' };

  log('INFO', '=== PURCHASE APPROVED: ' + jobId + ' ===');
  await notify('⏳ Starting purchases for ' + plan.customer + '...');

  const customer = await getCustomer(plan.userId);
  const t = customer._targeting;
  const limits = customer._limits;
  const conf = t.campaigns_confirmed || [];
  if (!t.provisioning) t.provisioning = {};
  t.provisioning.status = 'purchasing';
  t.provisioning.job_id = jobId;
  if (!t.provisioning.domains) t.provisioning.domains = [];
  if (!t.provisioning.errors) t.provisioning.errors = [];
  t.provisioning.budget_spent = t.provisioning.budget_spent || 0;
  await updateTargetMarket(plan.userId, t);

  const mbPerCampaign = Math.floor(limits.mailboxes / limits.campaigns);
  const existingCount = t.provisioning.domains.filter(d => d.status === 'purchased').length;
  let cIdx = Math.floor(existingCount / mbPerCampaign);
  let mIdx = existingCount % mbPerCampaign;
  let bought = 0;

  for (const d of plan.domains) {
    log('INFO', 'Buying: ' + d.domain);
    try {
      const r = await registerDomain(d.domain);
      await sleep(CONFIG.rate_limit_ms);
      if (r.success) {
        const campNum = conf[cIdx] || (cIdx + 1);
        t.provisioning.domains.push({ domain: d.domain, status: 'purchased', purchased_at: now(), cost: r.cost || 10.98, campaign: campNum, mailbox_index: mIdx + 1, email: 'outreach@' + d.domain, namecheap_id: r.domainId, job_id: jobId });
        t.provisioning.budget_spent += (r.cost || 10.98);
        bought++;
        mIdx++; if (mIdx >= mbPerCampaign) { mIdx = 0; cIdx++; }
        await updateTargetMarket(plan.userId, t);
        await notify(`✅ ${d.domain} — $${r.cost}\nCampaign ${campNum} / mailbox ${mIdx}\n(${existingCount + bought}/${limits.mailboxes})`);
      } else {
        t.provisioning.errors.push({ ts: now(), msg: r.error, domain: d.domain });
        await updateTargetMarket(plan.userId, t);
        await notify('⚠️ Failed: ' + d.domain + ' — ' + r.error);
      }
    } catch (e) {
      t.provisioning.errors.push({ ts: now(), msg: e.message, domain: d.domain });
      await updateTargetMarket(plan.userId, t);
      await notify('🚨 Error: ' + d.domain + ' — ' + e.message);
    }
    await sleep(CONFIG.rate_limit_ms);
  }

  const total = t.provisioning.domains.filter(d => d.status === 'purchased').length;
  t.provisioning.status = total >= limits.mailboxes ? 'domains_complete' : 'domains_partial';
  t.provisioning.domains_purchased = total;
  t.provisioning.domains_needed = limits.mailboxes;
  delete t.provisioning.pending_plan;
  await updateTargetMarket(plan.userId, t);
  delete pendingApprovals[jobId];

  await notify(`${total >= limits.mailboxes ? '🎉 ALL DONE' : '⚠️ PARTIAL'}\n${plan.customer}: ${total}/${limits.mailboxes} domains\nSpent: $${t.provisioning.budget_spent.toFixed(2)}`);
}

// =============================================
// TELEGRAM POLLING (listens for /approve)
// =============================================
let lastUpdate = 0;
async function pollTelegram() {
  if (!CONFIG.telegram.bot_token || !CONFIG.telegram.chat_id) return;
  try {
    const r = await fetchJSON(`https://api.telegram.org/bot${CONFIG.telegram.bot_token}/getUpdates?offset=${lastUpdate+1}&timeout=5`);
    if (r.body && r.body.result) for (const u of r.body.result) {
      lastUpdate = u.update_id;
      const txt = u.message?.text || '';
      if (String(u.message?.chat?.id) !== CONFIG.telegram.chat_id) continue;
      if (txt.startsWith('/approve ')) {
        const jid = txt.replace('/approve ', '').trim();
        if (pendingApprovals[jid]) { await notify('⏳ Approved. Purchasing...'); executePurchase(jid).catch(e => notify('🚨 ' + e.message)); }
        else await notify('❌ Job not found: ' + jid);
      }
    }
  } catch (e) {}
}
setInterval(pollTelegram, 3000);

// Expire old plans
setInterval(() => { for (const [id, p] of Object.entries(pendingApprovals)) if (Date.now() - new Date(p.createdAt).getTime() > 86400000) delete pendingApprovals[id]; }, 60000);

// =============================================
// HTTP SERVER (secured)
// =============================================
http.createServer((req, res) => {
  // CORS for dashboard
  res.setHeader('Access-Control-Allow-Origin', 'https://coldflows.ai');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'cf_wh_coldflows_2026';

  // Health — public, reveals nothing
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('OK'); return;
  }

  // Everything else blocked publicly
  if (req.method === 'GET' && req.url === '/pending') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // /provision — requires webhook secret header
  if (req.method === 'POST' && req.url === '/provision') {
    const secret = req.headers['x-webhook-secret'] || '';
    if (secret !== WEBHOOK_SECRET) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const p = JSON.parse(body), rec = p.record || p, uid = rec.user_id;
        if (!uid) { res.writeHead(400); res.end('No user_id'); return; }
        const tm = typeof rec.target_market === 'string' ? JSON.parse(rec.target_market) : rec.target_market || {};
        const conf = tm.campaigns_confirmed || [], lim = PLAN_LIMITS[rec.plan || 'starter'] || PLAN_LIMITS.starter;
        if (conf.length < lim.campaigns) { res.writeHead(200); res.end('Not ready'); return; }
        const st = (tm.provisioning || {}).status;
        if (st === 'domains_complete' || st === 'purchasing' || st === 'awaiting_approval') { res.writeHead(200); res.end(st); return; }
        res.writeHead(200); res.end('Plan generation started');
        generatePlan(uid).catch(e => notify('\ud83d\udea8 ' + e.message));
      } catch (e) { res.writeHead(400); res.end('Bad request'); }
    });

  // /approve/:jobId GET — BLOCKED, use dashboard
  } else if (req.method === 'GET' && req.url.startsWith('/approve/')) {
    res.writeHead(302, { 'Location': 'https://coldflows.ai/app' }); res.end();

  // /approve/:jobId POST — execute purchase (requires secret OR valid browser session)
  } else if (req.method === 'POST' && req.url.startsWith('/approve/')) {
    const secret = req.headers['x-webhook-secret'] || '';
    if (secret !== WEBHOOK_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    const jid = req.url.split('/approve/')[1];
    if (!pendingApprovals[jid]) { res.writeHead(404); res.end('Expired'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Approved</h1><p>Purchasing now. Check Telegram.</p></body></html>');
    executePurchase(jid).catch(e => notify('\ud83d\udea8 ' + e.message));

  } else { res.writeHead(404); res.end('Not found'); }
}).listen(CONFIG.port, () => {
  log('INFO', 'Server on port ' + CONFIG.port + ' \u2014 APPROVAL GATE ACTIVE');
  log('INFO', '/pending BLOCKED, /health reveals nothing, approval via dashboard or Telegram only');
});
