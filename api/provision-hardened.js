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

  await notify(`${total >= limits.mailboxes ? '🎉 ALL DOMAINS PURCHASED' : '⚠️ PARTIAL'}\n${plan.customer}: ${total}/${limits.mailboxes} domains\nSpent: $${t.provisioning.budget_spent.toFixed(2)}`);

  // Auto-trigger mailbox plan if all domains are purchased
  if (total >= limits.mailboxes) {
    await notify('📧 Generating mailbox creation plan...');
    generateMailboxPlan(plan.userId).catch(e => notify('🚨 Mailbox plan failed: ' + e.message));
  }
}

// =============================================
// GOOGLE WORKSPACE: AUTH + API HELPERS
// =============================================
const crypto = require('crypto');

function base64url(data) {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken() {
  const fs = require('fs');
  let sa;
  try { sa = JSON.parse(fs.readFileSync('/opt/coldflows/service-account.json', 'utf8')); }
  catch (e) { throw new Error('Service account key not found at /opt/coldflows/service-account.json'); }

  const now_ts = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    sub: 'info@coldflows.ai',
    scope: 'https://www.googleapis.com/auth/admin.directory.user https://www.googleapis.com/auth/admin.directory.domain https://www.googleapis.com/auth/admin.directory.user.security',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now_ts,
    exp: now_ts + 3600,
  }));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const signature = base64url(sign.sign(sa.private_key));
  const jwt = header + '.' + payload + '.' + signature;

  const resp = await fetchJSON('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  if (resp.body && resp.body.access_token) return resp.body.access_token;
  throw new Error('Google auth failed: ' + JSON.stringify(resp.body));
}

async function googleAPI(method, url, body) {
  const token = await getGoogleAccessToken();
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return await fetchJSON(url, opts);
}

// =============================================
// GOOGLE WORKSPACE: ADD DOMAIN
// =============================================
async function addDomainToWorkspace(domain) {
  const resp = await googleAPI('POST', 'https://admin.googleapis.com/admin/directory/v1/customer/my_customer/domains', {
    domainName: domain,
  });
  return { success: resp.status >= 200 && resp.status < 300, body: resp.body };
}

// =============================================
// GOOGLE WORKSPACE: CREATE MAILBOX
// =============================================
async function createMailbox(email, firstName, lastName) {
  const domain = email.split('@')[1];
  const password = crypto.randomBytes(16).toString('hex') + 'A1!';
  const resp = await googleAPI('POST', 'https://admin.googleapis.com/admin/directory/v1/users', {
    primaryEmail: email,
    name: { givenName: firstName, familyName: lastName },
    password: password,
    changePasswordAtNextLogin: false,
    orgUnitPath: '/',
  });
  return {
    success: resp.status >= 200 && resp.status < 300,
    email,
    password,
    body: resp.body,
    error: resp.body && resp.body.error ? resp.body.error.message : null,
  };
}

// =============================================
// PHASE 3: GENERATE MAILBOX PLAN (no spending)
// =============================================
async function generateMailboxPlan(userId) {
  const jobId = 'mb_' + Date.now();
  log('INFO', 'Generating mailbox plan: ' + jobId);

  const customer = await getCustomer(userId);
  const t = customer._targeting;
  const limits = customer._limits;
  const prov = t.provisioning || {};
  const domains = (prov.domains || []).filter(d => d.status === 'purchased');

  if (domains.length < limits.mailboxes) {
    log('INFO', 'Not all domains purchased yet');
    return { error: 'Domains not complete' };
  }

  // Check which mailboxes already exist
  const existingMailboxes = (prov.mailboxes || []).filter(m => m.status === 'created');
  const domainsNeedingMailbox = domains.filter(d => !existingMailboxes.find(m => m.domain === d.domain));

  if (domainsNeedingMailbox.length === 0) {
    log('INFO', 'All mailboxes already created');
    return { message: 'All mailboxes exist' };
  }

  const mailboxes = domainsNeedingMailbox.map(d => ({
    email: 'outreach@' + d.domain,
    domain: d.domain,
    campaign: d.campaign,
    costPerMonth: 7.20,
  }));

  const totalMonthlyCost = mailboxes.length * 7.20;
  const audRate = 1.55;
  const toAud = (usd) => (usd * audRate).toFixed(2);

  const plan = {
    jobId,
    type: 'mailbox',
    userId,
    customer: customer.business_name,
    email: customer.email,
    plan: customer.plan,
    mailboxes,
    totalMonthlyCost,
    existing: existingMailboxes.length,
    needed: domainsNeedingMailbox.length,
    createdAt: now(),
  };

  pendingApprovals[jobId] = plan;

  if (!t.provisioning) t.provisioning = {};
  t.provisioning.mailbox_status = 'awaiting_approval';
  t.provisioning.pending_mailbox_plan = plan;
  await updateTargetMarket(userId, t);

  const list = mailboxes.map((m, i) => `  ${i+1}. ${m.email} — A$${toAud(m.costPerMonth)}/mo`).join('\n');

  await notify(
    `🧊 COLDFLOWS — MAILBOX APPROVAL REQUIRED\n━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Customer:</b> ${customer.business_name}\n` +
    `<b>Plan:</b> ${customer.plan.toUpperCase()}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Mailboxes to create (${mailboxes.length}):</b>\n${list}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>💰 Monthly cost: A$${toAud(totalMonthlyCost)}/mo (US$${totalMonthlyCost.toFixed(2)})</b>\n` +
    `Per mailbox: A$${toAud(7.20)}/mo\n` +
    `Already created: ${existingMailboxes.length}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `This adds Google Workspace users at ~A$${toAud(7.20)}/mailbox/month.\n` +
    `Billed to your Google Workspace account.\n\n` +
    `✅ Approve in Coldflows dashboard:\nhttps://coldflows.ai/app\n\n` +
    `❌ To reject, open dashboard and click Reject.`
  );

  log('INFO', `Mailbox plan sent for approval. ${mailboxes.length} mailboxes, A$${toAud(totalMonthlyCost)}/mo`);
  return { jobId, status: 'awaiting_approval' };
}

// =============================================
// PHASE 4: EXECUTE MAILBOX CREATION (after approval)
// =============================================
async function executeMailboxCreation(jobId) {
  const plan = pendingApprovals[jobId];
  if (!plan || plan.type !== 'mailbox') return { error: 'Mailbox plan not found' };

  log('INFO', '=== MAILBOX CREATION APPROVED: ' + jobId + ' ===');
  await notify('📧 Creating mailboxes for ' + plan.customer + '...');

  const customer = await getCustomer(plan.userId);
  const t = customer._targeting;
  if (!t.provisioning) t.provisioning = {};
  t.provisioning.mailbox_status = 'creating';
  if (!t.provisioning.mailboxes) t.provisioning.mailboxes = [];
  if (!t.provisioning.errors) t.provisioning.errors = [];
  await updateTargetMarket(plan.userId, t);

  let created = 0;

  for (const mb of plan.mailboxes) {
    log('INFO', 'Adding domain: ' + mb.domain);

    // Step 1: Add domain to Google Workspace
    try {
      const domResult = await addDomainToWorkspace(mb.domain);
      if (domResult.success) {
        log('INFO', '  Domain added: ' + mb.domain);
      } else {
        // Domain might already be added — check error
        const err = domResult.body && domResult.body.error ? domResult.body.error.message : 'Unknown';
        if (err.includes('already exists') || err.includes('duplicate')) {
          log('INFO', '  Domain already exists: ' + mb.domain);
        } else {
          log('WARN', '  Domain add failed: ' + mb.domain + ' — ' + err);
          t.provisioning.errors.push({ ts: now(), msg: 'Domain add failed: ' + mb.domain + ' — ' + err });
          await updateTargetMarket(plan.userId, t);
          await notify('⚠️ Domain add failed: ' + mb.domain + ' — ' + err);
          continue;
        }
      }
      await sleep(2000);
    } catch (e) {
      log('ERROR', '  Domain add error: ' + mb.domain + ' — ' + e.message);
      t.provisioning.errors.push({ ts: now(), msg: e.message, domain: mb.domain });
      await updateTargetMarket(plan.userId, t);
      continue;
    }

    // Step 2: Create the mailbox
    log('INFO', 'Creating mailbox: ' + mb.email);
    try {
      const mbResult = await createMailbox(mb.email, 'Outreach', plan.customer.replace(/[^a-zA-Z0-9 ]/g, ''));
      await sleep(2000);

      if (mbResult.success) {
        const record = {
          email: mb.email,
          domain: mb.domain,
          campaign: mb.campaign,
          status: 'created',
          created_at: now(),
          password: mbResult.password,
          cost_per_month: 7.20,
          job_id: jobId,
        };
        t.provisioning.mailboxes.push(record);
        created++;
        await updateTargetMarket(plan.userId, t);

        log('INFO', '  ✓ Mailbox created: ' + mb.email);
        await notify(`📧 ${mb.email}\nCampaign ${mb.campaign}\n(${created}/${plan.mailboxes.length})`);
      } else {
        const err = mbResult.error || 'Unknown';
        if (err.includes('already exists')) {
          log('INFO', '  Mailbox already exists: ' + mb.email);
          t.provisioning.mailboxes.push({ email: mb.email, domain: mb.domain, campaign: mb.campaign, status: 'created', created_at: now(), cost_per_month: 7.20, job_id: jobId });
          created++;
          await updateTargetMarket(plan.userId, t);
        } else {
          log('WARN', '  Mailbox failed: ' + mb.email + ' — ' + err);
          t.provisioning.errors.push({ ts: now(), msg: 'Mailbox failed: ' + err, email: mb.email });
          await updateTargetMarket(plan.userId, t);
          await notify('⚠️ Mailbox failed: ' + mb.email + ' — ' + err);
        }
      }
    } catch (e) {
      log('ERROR', '  Mailbox error: ' + mb.email + ' — ' + e.message);
      t.provisioning.errors.push({ ts: now(), msg: e.message, email: mb.email });
      await updateTargetMarket(plan.userId, t);
      await notify('🚨 Error: ' + mb.email + ' — ' + e.message);
    }
  }

  // Final status
  const totalCreated = t.provisioning.mailboxes.filter(m => m.status === 'created').length;
  const allDone = totalCreated >= plan.mailboxes.length + (t.provisioning.mailboxes.filter(m => m.status === 'created').length - created);
  t.provisioning.mailbox_status = allDone ? 'mailboxes_complete' : 'mailboxes_partial';
  t.provisioning.mailboxes_created = totalCreated;
  delete t.provisioning.pending_mailbox_plan;
  await updateTargetMarket(plan.userId, t);
  delete pendingApprovals[jobId];

  const audRate = 1.55;
  await notify(`${allDone ? '🎉 ALL MAILBOXES CREATED' : '⚠️ PARTIAL'}\n${plan.customer}: ${totalCreated} mailboxes\nMonthly cost: A$${(totalCreated * 7.20 * audRate).toFixed(2)}/mo`);
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
        if (pendingApprovals[jid]) {
          const p = pendingApprovals[jid];
          if (p.type === 'mailbox') {
            await notify('📧 Approved. Creating mailboxes...');
            executeMailboxCreation(jid).catch(e => notify('🚨 ' + e.message));
          } else {
            await notify('⏳ Approved. Purchasing domains...');
            executePurchase(jid).catch(e => notify('🚨 ' + e.message));
          }
        }
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

  // /approve/:jobId POST — execute purchase or mailbox creation (requires secret)
  } else if (req.method === 'POST' && req.url.startsWith('/approve/')) {
    const secret = req.headers['x-webhook-secret'] || '';
    if (secret !== WEBHOOK_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    const jid = req.url.split('/approve/')[1];
    if (!pendingApprovals[jid]) { res.writeHead(404); res.end('Expired'); return; }
    const p = pendingApprovals[jid];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Approved</h1><p>Processing now. Check Telegram.</p></body></html>');
    if (p.type === 'mailbox') {
      executeMailboxCreation(jid).catch(e => notify('\ud83d\udea8 ' + e.message));
    } else {
      executePurchase(jid).catch(e => notify('\ud83d\udea8 ' + e.message));
    }

  } else { res.writeHead(404); res.end('Not found'); }
}).listen(CONFIG.port, () => {
  log('INFO', 'Server on port ' + CONFIG.port + ' \u2014 APPROVAL GATE ACTIVE');
  log('INFO', '/pending BLOCKED, /health reveals nothing, approval via dashboard or Telegram only');
});
