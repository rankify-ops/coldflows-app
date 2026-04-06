/**
 * Coldflows Domain Provisioning — Namecheap Edition
 * ===================================================
 * Runs on VPS: 170.64.130.130 (coldflows-automation, DigitalOcean Sydney)
 * 
 * SAFEGUARDS:
 * 1. Pre-purchase count check — never exceed plan limit
 * 2. RDAP availability check before every purchase attempt
 * 3. Post-purchase verification via Namecheap domains.getList
 * 4. Idempotent — safe to re-run (checks existing purchases first)
 * 5. Budget guard — hard cap per customer
 * 6. Telegram notifications for progress + errors
 * 7. Every state change written to Supabase immediately
 * 8. Detailed error logging with timestamps
 * 
 * TRIGGER: Supabase webhook → POST http://170.64.130.130:3000/provision
 * 
 * ENV VARS (in /opt/coldflows/.env):
 *   NAMECHEAP_API_KEY, NAMECHEAP_USER
 *   SUPABASE_URL, SUPABASE_KEY
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   VPS_IP
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// =============================================
// LOAD ENV FROM .env FILE
// =============================================
try {
  const fs = require('fs');
  const envFile = fs.readFileSync('/opt/coldflows/.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
} catch (e) { /* .env not found, use existing env */ }

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  namecheap: {
    api_key: process.env.NAMECHEAP_API_KEY,
    user: process.env.NAMECHEAP_USER || 'coldflowsai',
    base: 'https://api.namecheap.com/xml.response',
    client_ip: process.env.VPS_IP || '170.64.130.130',
  },
  supabase: {
    url: process.env.SUPABASE_URL || 'https://bmjjyujuyjpkyggormoa.supabase.co',
    key: process.env.SUPABASE_KEY,
  },
  telegram: {
    bot_token: process.env.TELEGRAM_BOT_TOKEN,
    chat_id: process.env.TELEGRAM_CHAT_ID || '',
  },
  max_price_per_domain: 15.00,
  rate_limit_ms: 1500,
  rdap_rate_limit_ms: 200,
  tld: '.com',
  port: 3000,
};

const PLAN_LIMITS = {
  starter: { mailboxes: 4, campaigns: 2 },
  growth:  { mailboxes: 12, campaigns: 4 },
  scale:   { mailboxes: 30, campaigns: 10 },
};

// =============================================
// UTILITIES
// =============================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (level, msg, data) => {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ts}] [${level}] ${msg}`, data ? JSON.stringify(data) : '');
};

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

function fetchXML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// =============================================
// TELEGRAM
// =============================================
async function notify(message) {
  if (!CONFIG.telegram.chat_id) { log('WARN', 'No Telegram chat_id'); return; }
  try {
    await fetchJSON(`https://api.telegram.org/bot${CONFIG.telegram.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegram.chat_id, text: `🧊 COLDFLOWS\n${message}` }),
    });
  } catch (e) { log('ERROR', 'Telegram failed', { error: e.message }); }
}

// =============================================
// SUPABASE
// =============================================
async function getCustomer(userId) {
  const resp = await fetchJSON(
    `${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}&select=*`,
    { headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}` } }
  );
  if (!resp.body || !resp.body[0]) throw new Error(`Customer not found: ${userId}`);
  const c = resp.body[0];
  c._targeting = typeof c.target_market === 'string' ? JSON.parse(c.target_market) : c.target_market || {};
  c._limits = PLAN_LIMITS[c.plan] || PLAN_LIMITS.starter;
  return c;
}

async function updateTargetMarket(userId, targeting) {
  await fetchJSON(
    `${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        apikey: CONFIG.supabase.key,
        Authorization: `Bearer ${CONFIG.supabase.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ target_market: JSON.stringify(targeting) }),
    }
  );
}

// =============================================
// DOMAIN NAME GENERATION
// =============================================
function generateCandidates(businessName, count = 60) {
  const clean = businessName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  if (clean.length < 3) throw new Error(`Business name too short: "${businessName}"`);

  const suffixes = [
    'mail', 'sends', 'reach', 'hub', 'team', 'hq', 'go', 'now',
    'pro', 'ops', 'run', 'flow', 'labs', 'direct', 'inbox', 'connect',
    'msg', 'ping', 'works', 'zone', 'desk', 'base', 'wave', 'notify',
    'out', 'send', 'hello', 'link', 'grid', 'core',
  ];
  const prefixes = ['get', 'try', 'use', 'hey', 'hi', 'meet', 'from', 'with'];
  const candidates = [];
  for (const s of suffixes) candidates.push(`${clean}${s}.com`);
  for (const p of prefixes) candidates.push(`${p}${clean}.com`);
  for (let i = 10; i < 100; i += 7) candidates.push(`${clean}${i}.com`);
  for (let i = 100; i < 999; i += 47) candidates.push(`${clean}${i}.com`);
  return [...new Set(candidates)].slice(0, count);
}

// =============================================
// RDAP AVAILABILITY CHECK
// =============================================
function checkAvailableRDAP(domain) {
  return new Promise((resolve) => {
    https.get(`https://rdap.verisign.com/com/v1/domain/${domain}`, { timeout: 5000 }, (res) => {
      if (res.statusCode === 200) resolve(false);
      else if (res.statusCode === 404) resolve(true);
      else resolve(null);
      res.resume();
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

// =============================================
// NAMECHEAP: CHECK AVAILABILITY (backup check)
// =============================================
async function checkAvailableNamecheap(domain) {
  const url = `${CONFIG.namecheap.base}?ApiUser=${CONFIG.namecheap.user}&ApiKey=${CONFIG.namecheap.api_key}&UserName=${CONFIG.namecheap.user}&ClientIp=${CONFIG.namecheap.client_ip}&Command=namecheap.domains.check&DomainList=${domain}`;
  const xml = await fetchXML(url);
  const availMatch = xml.match(/Available="(true|false)"/);
  const premiumMatch = xml.match(/IsPremiumName="(true|false)"/);
  return {
    available: availMatch ? availMatch[1] === 'true' : false,
    premium: premiumMatch ? premiumMatch[1] === 'true' : false,
  };
}

// =============================================
// NAMECHEAP: REGISTER DOMAIN
// =============================================
async function registerDomain(domain) {
  const sld = domain.replace('.com', '');
  const params = [
    `ApiUser=${CONFIG.namecheap.user}`,
    `ApiKey=${CONFIG.namecheap.api_key}`,
    `UserName=${CONFIG.namecheap.user}`,
    `ClientIp=${CONFIG.namecheap.client_ip}`,
    `Command=namecheap.domains.create`,
    `DomainName=${domain}`,
    `Years=1`,
    // Registrant info (required by ICANN)
    `RegistrantFirstName=Thomas`,
    `RegistrantLastName=Flood`,
    `RegistrantAddress1=Currumbin+Waters`,
    `RegistrantCity=Gold+Coast`,
    `RegistrantStateProvince=Queensland`,
    `RegistrantPostalCode=4223`,
    `RegistrantCountry=AU`,
    `RegistrantPhone=+61.400000000`,
    `RegistrantEmailAddress=REDACTED_EMAIL`,
    // Tech contact (same)
    `TechFirstName=Thomas`,
    `TechLastName=Flood`,
    `TechAddress1=Currumbin+Waters`,
    `TechCity=Gold+Coast`,
    `TechStateProvince=Queensland`,
    `TechPostalCode=4223`,
    `TechCountry=AU`,
    `TechPhone=+61.400000000`,
    `TechEmailAddress=REDACTED_EMAIL`,
    // Admin contact (same)
    `AdminFirstName=Thomas`,
    `AdminLastName=Flood`,
    `AdminAddress1=Currumbin+Waters`,
    `AdminCity=Gold+Coast`,
    `AdminStateProvince=Queensland`,
    `AdminPostalCode=4223`,
    `AdminCountry=AU`,
    `AdminPhone=+61.400000000`,
    `AdminEmailAddress=REDACTED_EMAIL`,
    // AuxBilling contact (same)
    `AuxBillingFirstName=Thomas`,
    `AuxBillingLastName=Flood`,
    `AuxBillingAddress1=Currumbin+Waters`,
    `AuxBillingCity=Gold+Coast`,
    `AuxBillingStateProvince=Queensland`,
    `AuxBillingPostalCode=4223`,
    `AuxBillingCountry=AU`,
    `AuxBillingPhone=+61.400000000`,
    `AuxBillingEmailAddress=REDACTED_EMAIL`,
    // WHOIS privacy
    `AddFreeWhoisguard=yes`,
    `WGEnabled=yes`,
  ].join('&');

  const url = `${CONFIG.namecheap.base}?${params}`;
  const xml = await fetchXML(url);
  
  const success = xml.includes('Status="OK"');
  const registered = xml.match(/Registered="(true|false)"/);
  const domainId = xml.match(/DomainID="(\d+)"/);
  const chargedAmount = xml.match(/ChargedAmount="([\d.]+)"/);
  const errorMatch = xml.match(/<Error[^>]*>(.*?)<\/Error>/);

  return {
    success: success && registered && registered[1] === 'true',
    domain,
    domainId: domainId ? domainId[1] : null,
    cost: chargedAmount ? parseFloat(chargedAmount[1]) : null,
    error: errorMatch ? errorMatch[1] : null,
    raw: xml.slice(0, 500),
  };
}

// =============================================
// NAMECHEAP: VERIFY DOMAIN IN ACCOUNT
// =============================================
async function verifyInAccount(domain) {
  const url = `${CONFIG.namecheap.base}?ApiUser=${CONFIG.namecheap.user}&ApiKey=${CONFIG.namecheap.api_key}&UserName=${CONFIG.namecheap.user}&ClientIp=${CONFIG.namecheap.client_ip}&Command=namecheap.domains.getList&PageSize=100`;
  const xml = await fetchXML(url);
  return xml.includes(`Name="${domain}"`);
}

// =============================================
// MAIN PROVISIONING PIPELINE
// =============================================
async function provisionDomains(userId) {
  const jobId = `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  log('INFO', `=== PROVISIONING START === job=${jobId} user=${userId}`);

  // ---- Load + validate customer ----
  const customer = await getCustomer(userId);
  const t = customer._targeting;
  const limits = customer._limits;
  const conf = t.campaigns_confirmed || [];

  log('INFO', `Customer: ${customer.business_name} | ${customer.plan} | ${conf.length}/${limits.campaigns} campaigns`);

  if (conf.length < limits.campaigns) {
    const msg = `BLOCKED: Only ${conf.length}/${limits.campaigns} campaigns confirmed.`;
    log('ERROR', msg);
    await notify(`🚨 ${msg}\nCustomer: ${customer.business_name}`);
    return { success: false, error: msg };
  }

  // ---- Check existing purchases (idempotency) ----
  const prov = t.provisioning || {};
  const existingDomains = (prov.domains || []).filter(d => d.status === 'purchased' || d.status === 'dns_done');
  const alreadyPurchased = existingDomains.length;
  const domainsNeeded = limits.mailboxes;
  const remaining = domainsNeeded - alreadyPurchased;

  if (remaining <= 0) {
    const msg = `Already have ${alreadyPurchased}/${domainsNeeded} domains. Nothing to buy.`;
    log('INFO', msg);
    return { success: true, message: msg };
  }

  // ---- Budget guard ----
  const budgetLimit = domainsNeeded * CONFIG.max_price_per_domain;
  const budgetSpent = existingDomains.reduce((sum, d) => sum + (d.cost || 0), 0);

  if (budgetSpent + CONFIG.max_price_per_domain > budgetLimit) {
    const msg = `BUDGET EXCEEDED: limit=$${budgetLimit}, spent=$${budgetSpent}.`;
    log('ERROR', msg);
    await notify(`🚨 BUDGET GUARD\n${msg}\nCustomer: ${customer.business_name}`);
    return { success: false, error: msg };
  }

  // ---- Init provisioning record ----
  if (!t.provisioning) t.provisioning = {};
  t.provisioning.job_id = jobId;
  t.provisioning.status = 'purchasing';
  t.provisioning.started_at = t.provisioning.started_at || now();
  t.provisioning.budget_limit = budgetLimit;
  t.provisioning.budget_spent = budgetSpent;
  t.provisioning.domains_needed = domainsNeeded;
  t.provisioning.domains_purchased = alreadyPurchased;
  if (!t.provisioning.domains) t.provisioning.domains = existingDomains;
  if (!t.provisioning.errors) t.provisioning.errors = [];
  await updateTargetMarket(userId, t);

  await notify(`🚀 PROVISIONING STARTED\nCustomer: ${customer.business_name}\nPlan: ${customer.plan}\nDomains needed: ${remaining} more\nBudget: $${(budgetLimit - budgetSpent).toFixed(2)} remaining\nJob: ${jobId}`);

  // ---- Generate candidates ----
  const candidates = generateCandidates(customer.business_name, 80);
  const existingNames = existingDomains.map(d => d.domain);
  const newCandidates = candidates.filter(d => !existingNames.includes(d));

  // ---- Check availability via RDAP ----
  const available = [];
  for (const domain of newCandidates) {
    if (available.length >= remaining + 5) break;
    const isAvailable = await checkAvailableRDAP(domain);
    if (isAvailable === true) {
      available.push(domain);
      log('INFO', `  ✓ ${domain} — available`);
    }
    await sleep(CONFIG.rdap_rate_limit_ms);
  }

  if (available.length < remaining) {
    const msg = `NOT ENOUGH DOMAINS: found ${available.length}, need ${remaining}. Business: ${customer.business_name}`;
    log('ERROR', msg);
    await notify(`🚨 ${msg}`);
    t.provisioning.status = 'error_insufficient_domains';
    t.provisioning.errors.push({ ts: now(), msg });
    await updateTargetMarket(userId, t);
    return { success: false, error: msg };
  }

  // ---- Purchase domains one at a time ----
  const mbPerCampaign = Math.floor(domainsNeeded / limits.campaigns);
  let purchased = 0;
  let campaignIdx = Math.floor(alreadyPurchased / mbPerCampaign);
  let mailboxIdx = alreadyPurchased % mbPerCampaign;

  for (const domain of available) {
    if (purchased >= remaining) break;

    // Budget check before each purchase
    if (t.provisioning.budget_spent + CONFIG.max_price_per_domain > budgetLimit) {
      log('ERROR', 'BUDGET GUARD: Would exceed limit. Stopping.');
      await notify(`🚨 BUDGET GUARD — stopping purchases`);
      break;
    }

    // Double-check with Namecheap before buying
    const ncCheck = await checkAvailableNamecheap(domain);
    if (!ncCheck.available) { log('WARN', `${domain} not available on Namecheap, skipping`); continue; }
    if (ncCheck.premium) { log('WARN', `${domain} is premium, skipping`); continue; }

    log('INFO', `Purchasing ${domain}...`);

    try {
      const result = await registerDomain(domain);
      await sleep(CONFIG.rate_limit_ms);

      if (result.success) {
        // Verify in account
        const verified = await verifyInAccount(domain);
        const campaignNum = conf[campaignIdx] || (campaignIdx + 1);

        const domainRecord = {
          domain,
          status: 'purchased',
          purchased_at: now(),
          cost: result.cost || 10.98,
          campaign: campaignNum,
          mailbox_index: mailboxIdx + 1,
          email: `outreach@${domain}`,
          verified_in_account: verified,
          namecheap_domain_id: result.domainId,
          job_id: jobId,
        };

        t.provisioning.domains.push(domainRecord);
        t.provisioning.domains_purchased++;
        t.provisioning.budget_spent += (result.cost || 10.98);
        purchased++;

        mailboxIdx++;
        if (mailboxIdx >= mbPerCampaign) { mailboxIdx = 0; campaignIdx++; }

        // Save to Supabase IMMEDIATELY
        await updateTargetMarket(userId, t);

        log('INFO', `  ✓ PURCHASED${verified ? ' + VERIFIED' : ''}: ${domain} ($${result.cost}) [${alreadyPurchased + purchased}/${domainsNeeded}]`);
        await notify(`✅ Purchased: ${domain}\nCost: $${result.cost}\nCampaign ${campaignNum}, mailbox ${domainRecord.mailbox_index}\n(${alreadyPurchased + purchased}/${domainsNeeded} total)`);

        if (!verified) {
          await notify(`⚠️ Domain ${domain} purchased but NOT found in account list. Manual check needed.`);
        }
      } else {
        const msg = `Failed: ${domain} — ${result.error || 'Unknown error'}`;
        log('WARN', msg);
        t.provisioning.errors.push({ ts: now(), msg, domain });
        await updateTargetMarket(userId, t);
      }
    } catch (e) {
      const msg = `Exception: ${domain} — ${e.message}`;
      log('ERROR', msg);
      await notify(`🚨 ${msg}`);
      t.provisioning.errors.push({ ts: now(), msg, domain });
      await updateTargetMarket(userId, t);
    }

    await sleep(CONFIG.rate_limit_ms);
  }

  // ---- Final status ----
  const totalPurchased = t.provisioning.domains.filter(d => d.status === 'purchased' || d.status === 'dns_done').length;
  const allDone = totalPurchased >= domainsNeeded;

  t.provisioning.status = allDone ? 'domains_complete' : 'domains_partial';
  t.provisioning.completed_at = allDone ? now() : null;
  await updateTargetMarket(userId, t);

  const summary = `${allDone ? '🎉 COMPLETE' : '⚠️ PARTIAL'}\nCustomer: ${customer.business_name}\nDomains: ${totalPurchased}/${domainsNeeded}\nSpent: $${t.provisioning.budget_spent.toFixed(2)}\nErrors: ${t.provisioning.errors.length}`;
  log('INFO', summary);
  await notify(summary);

  return { success: allDone, purchased: totalPurchased, needed: domainsNeeded, spent: t.provisioning.budget_spent, jobId };
}

// =============================================
// DRY RUN
// =============================================
async function dryRun(userId) {
  log('INFO', '=== DRY RUN (no purchases) ===');
  const customer = await getCustomer(userId);
  const limits = customer._limits;
  const candidates = generateCandidates(customer.business_name, 60);

  const available = [];
  for (const domain of candidates) {
    const isAvail = await checkAvailableRDAP(domain);
    if (isAvail) { available.push(domain); log('INFO', `  ✓ ${domain}`); }
    if (available.length >= limits.mailboxes + 4) break;
    await sleep(150);
  }

  log('INFO', `Found ${available.length} available (need ${limits.mailboxes})`);
  return { available, needed: limits.mailboxes, estimated_cost: limits.mailboxes * 10.98 };
}

// =============================================
// HTTP SERVER (receives Supabase webhooks)
// =============================================
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/provision') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        // Supabase webhook sends: { type, table, record, old_record }
        const record = payload.record || payload;
        const userId = record.user_id;
        
        if (!userId) {
          res.writeHead(400);
          res.end('Missing user_id');
          return;
        }

        // Check if all campaigns are confirmed before proceeding
        const tm = typeof record.target_market === 'string' ? JSON.parse(record.target_market) : record.target_market || {};
        const conf = tm.campaigns_confirmed || [];
        const plan = record.plan || 'starter';
        const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

        if (conf.length < limits.campaigns) {
          log('INFO', `Webhook received but only ${conf.length}/${limits.campaigns} campaigns confirmed. Ignoring.`);
          res.writeHead(200);
          res.end('Not ready — campaigns not all confirmed');
          return;
        }

        // Already provisioning or done?
        const prov = tm.provisioning || {};
        if (prov.status === 'domains_complete' || prov.status === 'purchasing') {
          log('INFO', `Webhook received but status is ${prov.status}. Ignoring.`);
          res.writeHead(200);
          res.end(`Already ${prov.status}`);
          return;
        }

        log('INFO', `Webhook received — starting provisioning for ${userId}`);
        res.writeHead(200);
        res.end('Provisioning started');

        // Run provisioning async (don't block the response)
        provisionDomains(userId).catch(e => {
          log('ERROR', `Provisioning failed: ${e.message}`);
          notify(`🚨 PROVISIONING CRASHED\n${e.message}`);
        });

      } catch (e) {
        log('ERROR', `Webhook parse error: ${e.message}`);
        res.writeHead(400);
        res.end('Invalid payload');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK — coldflows-automation running');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(CONFIG.port, () => {
  log('INFO', `Coldflows automation server listening on port ${CONFIG.port}`);
  log('INFO', `Health check: http://170.64.130.130:${CONFIG.port}/health`);
  log('INFO', `Provision endpoint: POST http://170.64.130.130:${CONFIG.port}/provision`);
});

// CLI usage
if (process.argv[2] === '--dry-run' && process.argv[3]) {
  dryRun(process.argv[3]).then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
} else if (process.argv[2] === '--provision' && process.argv[3]) {
  provisionDomains(process.argv[3]).then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
}

module.exports = { provisionDomains, dryRun };
