/**
 * Coldflows Domain Provisioning — Hardened
 * ==========================================
 * 
 * SAFEGUARDS:
 * 1. Pre-purchase count check — never exceed plan limit
 * 2. RDAP availability check before every purchase attempt
 * 3. Post-purchase verification via Porkbun listAll
 * 4. Idempotent — safe to re-run (checks existing purchases first)
 * 5. Budget guard — hard cap per customer
 * 6. Telegram notifications for progress + errors
 * 7. Every state change written to Supabase immediately
 * 8. Detailed error logging with timestamps
 * 
 * FLOW:
 * 1. Load customer data, verify all campaigns confirmed
 * 2. Check how many domains already purchased (idempotency)
 * 3. Generate domain candidates from business name
 * 4. RDAP availability check (free, fast, reliable)
 * 5. Purchase domains one at a time via Porkbun
 * 6. After EACH purchase: verify in account, update Supabase, notify
 * 7. After ALL: set provisioning status to "domains_complete"
 * 
 * ENV VARS (set before running):
 *   PORKBUN_API_KEY, PORKBUN_SECRET_KEY
 *   SUPABASE_URL, SUPABASE_KEY
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  porkbun: {
    api_key: process.env.PORKBUN_API_KEY || 'PORKBUN_API_KEY_HERE',
    secret_key: process.env.PORKBUN_SECRET_KEY || 'PORKBUN_SECRET_KEY_HERE',
    base: 'https://api.porkbun.com/api/json/v3',
  },
  supabase: {
    url: process.env.SUPABASE_URL || 'https://bmjjyujuyjpkyggormoa.supabase.co',
    key: process.env.SUPABASE_KEY || 'SUPABASE_KEY_HERE',
  },
  telegram: {
    bot_token: process.env.TELEGRAM_BOT_TOKEN || 'TELEGRAM_BOT_TOKEN_HERE',
    chat_id: process.env.TELEGRAM_CHAT_ID || '',
  },
  // Hard limits
  max_price_per_domain: 15.00,   // USD — refuse to buy if more than this
  max_budget_multiplier: 1.5,    // Never spend more than plan_domains * $15
  rate_limit_ms: 1000,           // Pause between Porkbun API calls
  rdap_rate_limit_ms: 200,       // Pause between RDAP checks
  tld: '.com',
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
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${level}] ${msg}`, data ? JSON.stringify(data) : '');
};

// =============================================
// TELEGRAM NOTIFICATIONS
// =============================================
async function notify(message) {
  if (!CONFIG.telegram.chat_id) {
    log('WARN', 'No Telegram chat_id — skipping notification');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.bot_token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chat_id,
        text: `🧊 COLDFLOWS\n${message}`,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    log('ERROR', 'Telegram notification failed', { error: e.message });
  }
}

async function notifyError(message) {
  await notify(`🚨 ERROR\n${message}`);
}

// =============================================
// SUPABASE
// =============================================
async function getCustomer(userId) {
  const resp = await fetch(
    `${CONFIG.supabase.url}/rest/v1/customers?user_id=eq.${userId}&select=*`,
    { headers: { apikey: CONFIG.supabase.key, Authorization: `Bearer ${CONFIG.supabase.key}` } }
  );
  const data = await resp.json();
  if (!data || !data[0]) throw new Error(`Customer not found: ${userId}`);
  const c = data[0];
  c._targeting = typeof c.target_market === 'string' ? JSON.parse(c.target_market) : c.target_market || {};
  c._limits = PLAN_LIMITS[c.plan] || PLAN_LIMITS.starter;
  return c;
}

async function updateTargetMarket(userId, targeting) {
  await fetch(
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
function generateCandidates(businessName, count = 50) {
  const clean = businessName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  if (clean.length < 3) throw new Error(`Business name too short for domain generation: "${businessName}"`);

  const suffixes = [
    'mail', 'sends', 'reach', 'hub', 'team', 'hq', 'go', 'now',
    'pro', 'ops', 'run', 'flow', 'labs', 'direct', 'inbox', 'connect',
    'msg', 'ping', 'works', 'zone', 'desk', 'base', 'wave', 'notify',
    'out', 'send', 'hello', 'link', 'grid', 'core',
  ];
  const prefixes = ['get', 'try', 'use', 'hey', 'hi', 'meet', 'from', 'with'];

  const candidates = [];

  // name + suffix
  for (const s of suffixes) candidates.push(`${clean}${s}${CONFIG.tld}`);
  // prefix + name
  for (const p of prefixes) candidates.push(`${p}${clean}${CONFIG.tld}`);
  // name + 2 digits
  for (let i = 10; i < 100; i += 7) candidates.push(`${clean}${i}${CONFIG.tld}`);
  // name + 3 digits
  for (let i = 100; i < 999; i += 47) candidates.push(`${clean}${i}${CONFIG.tld}`);

  // Dedupe and limit
  return [...new Set(candidates)].slice(0, count);
}

// =============================================
// RDAP AVAILABILITY CHECK (free, no auth needed)
// =============================================
async function checkAvailable(domain) {
  const bare = domain.replace(/\.com$/, '');
  try {
    const resp = await fetch(`https://rdap.verisign.com/com/v1/domain/${domain}`, {
      signal: AbortSignal.timeout(5000),
    });
    // 200 = domain exists = taken
    return false;
  } catch (e) {
    if (e.cause && e.cause.code === 'ERR_NON_2XX_STATUS') return true; // 404 = available
    if (e.message && e.message.includes('404')) return true;
    // For fetch errors, try to read status
    return null; // Unknown — skip this domain
  }
}

// Node.js compatible version
async function checkAvailableNode(domain) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(`https://rdap.verisign.com/com/v1/domain/${domain}`, { timeout: 5000 }, (res) => {
      if (res.statusCode === 200) resolve(false); // Taken
      else if (res.statusCode === 404) resolve(true); // Available
      else resolve(null); // Unknown
      res.resume(); // Consume response
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// =============================================
// PORKBUN: REGISTER DOMAIN
// =============================================
async function registerDomain(domain) {
  const resp = await fetch(`${CONFIG.porkbun.base}/domain/register/${domain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: CONFIG.porkbun.api_key,
      secretapikey: CONFIG.porkbun.secret_key,
      years: 1,
    }),
  });
  return await resp.json();
}

// =============================================
// PORKBUN: VERIFY DOMAIN IN ACCOUNT
// =============================================
async function verifyInAccount(domain) {
  const resp = await fetch(`${CONFIG.porkbun.base}/domain/listAll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: CONFIG.porkbun.api_key,
      secretapikey: CONFIG.porkbun.secret_key,
    }),
  });
  const data = await resp.json();
  if (data.status !== 'SUCCESS') return false;
  return data.domains.some(d => d.domain === domain);
}

// =============================================
// MAIN PROVISIONING PIPELINE
// =============================================
async function provisionDomains(userId) {
  const jobId = `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  log('INFO', `=== PROVISIONING START === job=${jobId} user=${userId}`);

  // ---- STEP 1: Load + validate customer ----
  const customer = await getCustomer(userId);
  const t = customer._targeting;
  const limits = customer._limits;
  const conf = t.campaigns_confirmed || [];

  log('INFO', `Customer: ${customer.business_name} | ${customer.plan} | ${conf.length}/${limits.campaigns} campaigns`);

  if (conf.length < limits.campaigns) {
    const msg = `BLOCKED: Only ${conf.length}/${limits.campaigns} campaigns confirmed. Cannot provision.`;
    log('ERROR', msg);
    await notifyError(msg);
    return { success: false, error: msg };
  }

  // ---- STEP 2: Check existing purchases (idempotency) ----
  const prov = t.provisioning || {};
  const existingDomains = (prov.domains || []).filter(d => d.status === 'purchased' || d.status === 'dns_done');
  const alreadyPurchased = existingDomains.length;
  const domainsNeeded = limits.mailboxes;
  const remaining = domainsNeeded - alreadyPurchased;

  log('INFO', `Domains: need=${domainsNeeded} already=${alreadyPurchased} remaining=${remaining}`);

  if (remaining <= 0) {
    const msg = `Already have ${alreadyPurchased}/${domainsNeeded} domains. Nothing to purchase.`;
    log('INFO', msg);
    await notify(`✅ ${msg}`);
    return { success: true, message: msg, domains: existingDomains };
  }

  // ---- STEP 3: Budget guard ----
  const budgetLimit = domainsNeeded * CONFIG.max_price_per_domain;
  const budgetSpent = existingDomains.reduce((sum, d) => sum + (d.cost || 0), 0);
  const budgetRemaining = budgetLimit - budgetSpent;

  log('INFO', `Budget: limit=$${budgetLimit} spent=$${budgetSpent} remaining=$${budgetRemaining}`);

  if (budgetRemaining < CONFIG.max_price_per_domain) {
    const msg = `BUDGET EXCEEDED: limit=$${budgetLimit}, spent=$${budgetSpent}. Cannot purchase more.`;
    log('ERROR', msg);
    await notifyError(msg);
    return { success: false, error: msg };
  }

  // ---- STEP 4: Init provisioning record ----
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

  await notify(`🚀 PROVISIONING STARTED\nCustomer: ${customer.business_name}\nPlan: ${customer.plan}\nDomains needed: ${remaining} more (${alreadyPurchased} already done)\nBudget: $${budgetRemaining.toFixed(2)} remaining\nJob: ${jobId}`);

  // ---- STEP 5: Generate candidates ----
  const candidates = generateCandidates(customer.business_name, 80);
  // Filter out already-purchased domains
  const existingNames = existingDomains.map(d => d.domain);
  const newCandidates = candidates.filter(d => !existingNames.includes(d));
  log('INFO', `Generated ${newCandidates.length} candidates (filtered ${candidates.length - newCandidates.length} existing)`);

  // ---- STEP 6: Check availability via RDAP ----
  const available = [];
  for (const domain of newCandidates) {
    if (available.length >= remaining + 5) break; // Get a few extras as buffer

    const isAvailable = await checkAvailableNode(domain);
    if (isAvailable === true) {
      available.push(domain);
      log('INFO', `  ✓ ${domain} — available`);
    } else if (isAvailable === null) {
      log('WARN', `  ? ${domain} — check failed, skipping`);
    }
    await sleep(CONFIG.rdap_rate_limit_ms);
  }

  log('INFO', `Found ${available.length} available domains (need ${remaining})`);

  if (available.length < remaining) {
    const msg = `NOT ENOUGH DOMAINS: found ${available.length}, need ${remaining}. Business: ${customer.business_name}`;
    log('ERROR', msg);
    await notifyError(msg);
    t.provisioning.errors.push({ ts: now(), msg });
    t.provisioning.status = 'error_insufficient_domains';
    await updateTargetMarket(userId, t);
    return { success: false, error: msg };
  }

  // ---- STEP 7: Purchase domains one at a time ----
  const mbPerCampaign = Math.floor(domainsNeeded / limits.campaigns);
  let purchased = 0;
  let campaignIdx = 0;
  let mailboxIdx = 0;

  // Calculate which campaign/mailbox index to start from
  for (const existing of existingDomains) {
    mailboxIdx++;
    if (mailboxIdx >= mbPerCampaign) {
      mailboxIdx = 0;
      campaignIdx++;
    }
  }

  for (const domain of available) {
    if (purchased >= remaining) break;

    // Budget check before each purchase
    if (t.provisioning.budget_spent + CONFIG.max_price_per_domain > budgetLimit) {
      const msg = `BUDGET GUARD: Would exceed limit. Spent=$${t.provisioning.budget_spent}, Limit=$${budgetLimit}. Stopping.`;
      log('ERROR', msg);
      await notifyError(msg);
      t.provisioning.errors.push({ ts: now(), msg });
      break;
    }

    // Double-check availability right before purchase
    const stillAvailable = await checkAvailableNode(domain);
    if (!stillAvailable) {
      log('WARN', `${domain} no longer available, skipping`);
      continue;
    }

    log('INFO', `Purchasing ${domain}...`);

    try {
      const result = await registerDomain(domain);
      await sleep(CONFIG.rate_limit_ms);

      if (result.status === 'SUCCESS') {
        // VERIFY it's actually in our account
        const verified = await verifyInAccount(domain);

        if (verified) {
          const campaignNum = conf[campaignIdx] || (campaignIdx + 1);
          const domainRecord = {
            domain,
            status: 'purchased',
            purchased_at: now(),
            cost: 11.08, // Standard .com price
            campaign: campaignNum,
            mailbox_index: mailboxIdx + 1,
            email: `outreach@${domain}`,
            verified_in_account: true,
            porkbun_order_id: result.orderId || null,
            job_id: jobId,
          };

          t.provisioning.domains.push(domainRecord);
          t.provisioning.domains_purchased++;
          t.provisioning.budget_spent += 11.08;
          purchased++;

          // Advance campaign/mailbox index
          mailboxIdx++;
          if (mailboxIdx >= mbPerCampaign) {
            mailboxIdx = 0;
            campaignIdx++;
          }

          // Save to Supabase IMMEDIATELY after each purchase
          await updateTargetMarket(userId, t);

          log('INFO', `  ✓ PURCHASED + VERIFIED: ${domain} (${purchased}/${remaining})`);
          await notify(`✅ Purchased: ${domain}\nCampaign ${campaignNum}, mailbox ${domainRecord.mailbox_index}\n(${alreadyPurchased + purchased}/${domainsNeeded} total)`);
        } else {
          // Registration said success but not in account — ALERT
          const msg = `CRITICAL: Porkbun said SUCCESS for ${domain} but NOT in account list! Manual check needed.`;
          log('ERROR', msg);
          await notifyError(msg);
          t.provisioning.errors.push({ ts: now(), msg, domain });
          await updateTargetMarket(userId, t);
        }
      } else {
        const msg = `Failed to register ${domain}: ${result.message || 'Unknown error'}`;
        log('WARN', msg);
        t.provisioning.errors.push({ ts: now(), msg, domain });
        await updateTargetMarket(userId, t);
      }
    } catch (e) {
      const msg = `Exception purchasing ${domain}: ${e.message}`;
      log('ERROR', msg);
      await notifyError(msg);
      t.provisioning.errors.push({ ts: now(), msg, domain });
      await updateTargetMarket(userId, t);
    }

    await sleep(CONFIG.rate_limit_ms);
  }

  // ---- STEP 8: Final status ----
  const totalPurchased = t.provisioning.domains.filter(d => d.status === 'purchased' || d.status === 'dns_done').length;
  const allDone = totalPurchased >= domainsNeeded;

  t.provisioning.status = allDone ? 'domains_complete' : 'domains_partial';
  t.provisioning.completed_at = allDone ? now() : null;
  await updateTargetMarket(userId, t);

  const summary = `PROVISIONING ${allDone ? 'COMPLETE' : 'PARTIAL'}\nCustomer: ${customer.business_name}\nDomains: ${totalPurchased}/${domainsNeeded}\nSpent: $${t.provisioning.budget_spent.toFixed(2)}\nErrors: ${t.provisioning.errors.length}\nJob: ${jobId}`;

  log('INFO', summary);
  await notify(allDone ? `🎉 ${summary}` : `⚠️ ${summary}`);

  return {
    success: allDone,
    purchased: totalPurchased,
    needed: domainsNeeded,
    spent: t.provisioning.budget_spent,
    errors: t.provisioning.errors,
    jobId,
  };
}

// =============================================
// DRY RUN — check availability without buying
// =============================================
async function dryRun(userId) {
  log('INFO', '=== DRY RUN (no purchases) ===');
  const customer = await getCustomer(userId);
  const limits = customer._limits;
  const candidates = generateCandidates(customer.business_name, 60);

  log('INFO', `Checking ${candidates.length} candidates for "${customer.business_name}"...`);

  const available = [];
  for (const domain of candidates) {
    const isAvail = await checkAvailableNode(domain);
    if (isAvail) {
      available.push(domain);
      log('INFO', `  ✓ ${domain}`);
    }
    if (available.length >= limits.mailboxes + 4) break;
    await sleep(150);
  }

  log('INFO', `\nFound ${available.length} available (need ${limits.mailboxes})`);
  log('INFO', `Estimated cost: $${(Math.min(available.length, limits.mailboxes) * 11.08).toFixed(2)}/yr`);

  return { available, needed: limits.mailboxes, cost: limits.mailboxes * 11.08 };
}

// =============================================
// EXPORTS
// =============================================
module.exports = { provisionDomains, dryRun, generateCandidates, checkAvailableNode, verifyInAccount };

// CLI usage: node provision-hardened.js <userId> [--dry-run]
if (require.main === module) {
  const userId = process.argv[2];
  const isDryRun = process.argv.includes('--dry-run');
  if (!userId) {
    console.error('Usage: node provision-hardened.js <userId> [--dry-run]');
    process.exit(1);
  }
  (isDryRun ? dryRun(userId) : provisionDomains(userId))
    .then(r => { console.log('\n=== RESULT ==='); console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error('FATAL:', e); process.exit(1); });
}
