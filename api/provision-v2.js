/**
 * Coldflows Domain Suggestion Engine v2
 * ======================================
 * VPS: 170.64.130.130 (coldflows-automation, DigitalOcean Sydney)
 * 
 * SIMPLIFIED FLOW (SmartSenders handles infrastructure):
 * 1. New customer signs up → Stripe webhook → Supabase record
 * 2. VPS generates domain suggestions → checks availability
 * 3. Sends Telegram notification with domain list + customer details
 * 4. Thomas copy-pastes domains into SmartSenders (~5 mins)
 * 5. SmartSenders handles: domains, mailboxes, DNS, DKIM, SPF, DMARC, warmup
 * 6. Thomas records purchased domains in Coldflows dashboard
 * 
 * NO Namecheap purchasing. NO Google Workspace. NO DNS automation.
 * SmartSenders via Smartlead handles all infrastructure.
 */

const http = require('http');
const https = require('https');

// Load .env
try {
  const fs = require('fs');
  const envFile = fs.readFileSync('/opt/coldflows/.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
} catch (e) {}

const CONFIG = {
  supabase: {
    url: process.env.SUPABASE_URL || 'https://bmjjyujuyjpkyggormoa.supabase.co',
    key: process.env.SUPABASE_KEY,
  },
  telegram: {
    bot_token: process.env.TELEGRAM_BOT_TOKEN,
    chat_id: process.env.TELEGRAM_CHAT_ID || '6305738886',
  },
  webhook_secret: process.env.WEBHOOK_SECRET || 'cf_wh_coldflows_2026',
  port: 3000,
  aud_rate: 1.55,
};

const PLAN_CONFIG = {
  starter:  { mailboxes: 6,  domains: 3,  mb_per_domain: 2, campaigns: 1, price_usd: 690 },
  growth:   { mailboxes: 12, domains: 6,  mb_per_domain: 2, campaigns: 3, price_usd: 1750 },
  scale:    { mailboxes: 24, domains: 12, mb_per_domain: 2, campaigns: 6, price_usd: 3500 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (level, msg) => console.log(`[${new Date().toISOString().slice(0,19)}] [${level}] ${msg}`);

// =============================================
// HTTP HELPERS
// =============================================
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

// =============================================
// TELEGRAM
// =============================================
async function notify(message) {
  if (!CONFIG.telegram.chat_id) return;
  try {
    await fetchJSON(`https://api.telegram.org/bot${CONFIG.telegram.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegram.chat_id, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) { log('ERROR', 'Telegram failed: ' + e.message); }
}

// =============================================
// SUPABASE
// =============================================
async function getCustomer(userId) {
  const resp = await fetchJSON(`${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}&select=*`, {
    headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}` },
  });
  if (!resp.body || !resp.body[0]) throw new Error('Customer not found: ' + userId);
  return resp.body[0];
}

async function updateCustomer(userId, updates) {
  await fetchJSON(`${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(updates),
  });
}

// =============================================
// DOMAIN SUGGESTION ENGINE
// =============================================
function generateCandidates(businessName) {
  const clean = businessName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  if (clean.length < 3) throw new Error('Business name too short');

  const suffixes = ['mail','sends','reach','hub','team','go','ops','run','flow','direct',
    'inbox','connect','ping','works','zone','base','wave','out','send','hello',
    'link','grid','core','edge','up','plus','one','io','now','pro','hq','labs'];
  const prefixes = ['get','try','use','hey','hi','meet','from','with'];
  const c = [];
  for (const s of suffixes) c.push(clean + s + '.com');
  for (const p of prefixes) c.push(p + clean + '.com');
  return [...new Set(c)].slice(0, 60);
}

function checkRDAP(domain) {
  return new Promise(resolve => {
    https.get('https://rdap.verisign.com/com/v1/domain/' + domain, { timeout: 5000 }, res => {
      resolve(res.statusCode === 404);
      res.resume();
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

// =============================================
// MAIN: GENERATE SUGGESTIONS & NOTIFY
// =============================================
async function suggestDomains(userId) {
  log('INFO', 'Generating domain suggestions for user: ' + userId);

  const customer = await getCustomer(userId);
  const plan = PLAN_CONFIG[customer.plan] || PLAN_CONFIG.starter;
  const domainsNeeded = plan.domains;

  // Generate candidates and check availability via RDAP (free, fast)
  const candidates = generateCandidates(customer.business_name);
  const available = [];

  for (const domain of candidates) {
    if (available.length >= domainsNeeded + 6) break; // get extras as backup options
    const free = await checkRDAP(domain);
    if (free) {
      available.push(domain);
      log('INFO', '  ✅ ' + domain);
    }
    await sleep(200); // RDAP rate limit
  }

  if (available.length < domainsNeeded) {
    await notify(`🚨 COLDFLOWS — NOT ENOUGH DOMAINS\n\nCustomer: ${customer.business_name}\nNeeded: ${domainsNeeded}\nFound: ${available.length}\n\nTry manually with different variations.`);
    return { error: 'Not enough domains found', found: available.length, needed: domainsNeeded };
  }

  // Calculate SmartSenders costs
  const domainCostYearly = 13; // Zapmail domain cost
  const mailboxCostMonthly = 4.50; // Zapmail mailbox cost
  const totalDomainCost = domainsNeeded * domainCostYearly;
  const totalMailboxCost = plan.mailboxes * mailboxCostMonthly;
  const toAud = (usd) => (usd * CONFIG.aud_rate).toFixed(2);

  // Build copyable domain list (top picks only)
  const topPicks = available.slice(0, domainsNeeded);
  const backups = available.slice(domainsNeeded);
  const copyList = topPicks.join('\n');

  // Store suggestions in Supabase
  const provData = {
    status: 'domains_suggested',
    suggested_at: new Date().toISOString(),
    suggestions: topPicks,
    backups: backups,
    plan_config: plan,
  };
  await updateCustomer(userId, { provisioning: JSON.stringify(provData) });

  // Send to Telegram
  await notify(
    `🧊 COLDFLOWS — NEW CUSTOMER SETUP\n━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Customer:</b> ${customer.business_name}\n` +
    `<b>Email:</b> ${customer.email}\n` +
    `<b>Plan:</b> ${customer.plan.toUpperCase()} (A$${toAud(plan.price_usd)}/mo)\n` +
    `<b>Forwarding domain:</b> ${customer.forwarding_domain || 'NOT SET'}\n` +
    `<b>Sender names:</b> ${customer.sender_names || 'NOT SET'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>📋 SmartSenders Setup:</b>\n` +
    `• Mailboxes: ${plan.mailboxes} total\n` +
    `• Domains: ${domainsNeeded} (${plan.mb_per_domain} mailboxes each)\n` +
    `• ESP: Google (Zapmail)\n` +
    `• Ratio: ${plan.mb_per_domain} per domain\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>💰 SmartSenders Cost:</b>\n` +
    `• Domains: A$${toAud(totalDomainCost)}/yr (US$${totalDomainCost})\n` +
    `• Mailboxes: A$${toAud(totalMailboxCost)}/mo (US$${totalMailboxCost.toFixed(2)})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>📎 COPY-PASTE DOMAINS:</b>\n` +
    `<code>${copyList}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (backups.length > 0 ? `<b>Backup options:</b>\n<code>${backups.join('\n')}</code>\n━━━━━━━━━━━━━━━━━━━━\n` : '') +
    `\n<b>NEXT STEPS:</b>\n` +
    `1. Copy domains above\n` +
    `2. Go to Smartlead → SmartSenders\n` +
    `3. Select ${plan.mailboxes} mailboxes, ${plan.mb_per_domain}/domain\n` +
    `4. Paste domains, set sender names\n` +
    `5. Set forwarding domain: ${customer.forwarding_domain || '[ask customer]'}\n` +
    `6. Choose Google/Zapmail, checkout\n` +
    `7. Update customer status in dashboard`
  );

  log('INFO', `Suggestions sent. ${domainsNeeded} domains for ${customer.business_name}`);
  return { status: 'suggestions_sent', domains: topPicks, backups };
}

// =============================================
// STRIPE WEBHOOK HANDLER
// =============================================
async function handleStripeWebhook(body) {
  // Handle checkout.session.completed or payment_intent.succeeded
  const event = typeof body === 'string' ? JSON.parse(body) : body;
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const plan = session.metadata?.plan || 'starter';
    const businessName = session.metadata?.business_name || '';
    const forwardingDomain = session.metadata?.forwarding_domain || '';
    const senderNames = session.metadata?.sender_names || '';
    
    log('INFO', `New Stripe payment: ${email} — ${plan}`);
    
    // Create or update customer in Supabase
    const userId = session.client_reference_id || session.customer || email;
    
    const customerData = {
      user_id: userId,
      email: email,
      business_name: businessName,
      plan: plan,
      forwarding_domain: forwardingDomain,
      sender_names: senderNames,
      status: 'active',
      stripe_customer_id: session.customer,
      stripe_session_id: session.id,
      created_at: new Date().toISOString(),
    };
    
    // Upsert customer
    await fetchJSON(`${CONFIG.supabase.url}/rest/v1/customers`, {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabase.key,
        Authorization: `Bearer ${CONFIG.supabase.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(customerData),
    });
    
    // Auto-generate domain suggestions
    await suggestDomains(userId);
    
    return { status: 'ok', userId };
  }
  
  return { status: 'ignored', type: event.type };
}

// =============================================
// HTTP SERVER
// =============================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://coldflows.ai');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  try {
    // Health check
    if (path === '/health' && req.method === 'GET') {
      return json(200, { status: 'ok', version: 'v2', uptime: process.uptime() });
    }

    // Stripe webhook
    if (path === '/stripe-webhook' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      // TODO: Verify Stripe signature in production
      const result = await handleStripeWebhook(body);
      return json(200, result);
    }

    // Manual trigger: generate domain suggestions
    if (path === '/suggest' && req.method === 'POST') {
      if (req.headers['x-webhook-secret'] !== CONFIG.webhook_secret) return json(403, { error: 'Forbidden' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const { userId } = JSON.parse(body);
      const result = await suggestDomains(userId);
      return json(200, result);
    }

    // Manual trigger: check single domain availability
    if (path === '/check-domain' && req.method === 'GET') {
      const domain = url.searchParams.get('domain');
      if (!domain) return json(400, { error: 'Missing domain param' });
      const available = await checkRDAP(domain);
      return json(200, { domain, available });
    }

    // Record that domains were purchased (called from dashboard after SmartSenders setup)
    if (path === '/record-purchase' && req.method === 'POST') {
      if (req.headers['x-webhook-secret'] !== CONFIG.webhook_secret) return json(403, { error: 'Forbidden' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const { userId, domains, mailboxes } = JSON.parse(body);
      
      const customer = await getCustomer(userId);
      const provData = {
        status: 'active',
        purchased_at: new Date().toISOString(),
        domains: domains, // array of domain names
        mailboxes: mailboxes, // array of email addresses
        provider: 'smartsenders_zapmail',
      };
      await updateCustomer(userId, { provisioning: JSON.stringify(provData), status: 'active' });
      
      await notify(`✅ SETUP COMPLETE: ${customer.business_name}\n${domains.length} domains, ${mailboxes.length} mailboxes\nProvider: SmartSenders/Zapmail`);
      return json(200, { status: 'recorded' });
    }

    // 404
    json(404, { error: 'Not found' });
  } catch (e) {
    log('ERROR', e.message);
    json(500, { error: e.message });
  }
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  log('INFO', `Coldflows v2 running on port ${CONFIG.port}`);
  log('INFO', 'Endpoints: /health, /stripe-webhook, /suggest, /check-domain, /record-purchase');
  notify('🟢 Coldflows VPS v2 online — Domain Suggestion Engine');
});

// Telegram polling for commands
let lastUpdate = 0;
async function pollTelegram() {
  if (!CONFIG.telegram.bot_token || !CONFIG.telegram.chat_id) return;
  try {
    const resp = await fetchJSON(`https://api.telegram.org/bot${CONFIG.telegram.bot_token}/getUpdates?offset=${lastUpdate + 1}&timeout=30`);
    if (resp.body && resp.body.result) {
      for (const update of resp.body.result) {
        lastUpdate = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text || String(msg.chat.id) !== CONFIG.telegram.chat_id) continue;
        
        const text = msg.text.trim();
        
        // /check domain.com — quick availability check
        if (text.startsWith('/check ')) {
          const domain = text.slice(7).trim();
          const avail = await checkRDAP(domain);
          await notify(avail ? `✅ ${domain} is AVAILABLE` : `❌ ${domain} is TAKEN`);
        }
        
        // /suggest userId — manually trigger suggestions
        if (text.startsWith('/suggest ')) {
          const userId = text.slice(9).trim();
          try {
            await suggestDomains(userId);
          } catch (e) {
            await notify('🚨 Error: ' + e.message);
          }
        }
        
        // /status — show VPS status
        if (text === '/status') {
          const uptime = Math.floor(process.uptime());
          const hrs = Math.floor(uptime / 3600);
          const mins = Math.floor((uptime % 3600) / 60);
          await notify(`🟢 Coldflows VPS v2\nUptime: ${hrs}h ${mins}m\nMemory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        }
      }
    }
  } catch (e) { /* silent */ }
  setTimeout(pollTelegram, 1000);
}
pollTelegram();
