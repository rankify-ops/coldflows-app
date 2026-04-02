/**
 * Coldflows Domain Provisioning Pipeline
 * ========================================
 * Triggered when all campaigns are confirmed for a customer.
 * 
 * Pipeline:
 * 1. Generate domain names (based on business name + random suffix)
 * 2. Check availability via Porkbun
 * 3. Register available domains
 * 4. Set DNS records (MX, SPF, DKIM, DMARC) for email
 * 5. Update Supabase with domain/mailbox records
 * 6. (Future) Create Google Workspace mailboxes
 * 7. (Future) Add to Smartlead for warmup
 * 
 * Environment:
 *   PORKBUN_API_KEY - Porkbun API key (pk1_...)
 *   PORKBUN_SECRET_KEY - Porkbun secret key (sk1_...)
 *   SUPABASE_URL - Supabase project URL
 *   SUPABASE_KEY - Supabase service role key
 */

const PORKBUN_API = 'https://api.porkbun.com/api/json/v3';

// Config — will be env vars in production
const CONFIG = {
  porkbun_api_key: 'PORKBUN_API_KEY_HERE',
  porkbun_secret_key: '', // NEEDS TO BE SET
  supabase_url: 'https://bmjjyujuyjpkyggormoa.supabase.co',
  supabase_key: 'SUPABASE_SECRET_KEY_HERE',
  tlds: ['.com'], // Could expand to .io, .co etc
  max_retries: 3,
};

// ============================================
// STEP 1: Generate domain name candidates
// ============================================
function generateDomainCandidates(businessName, count = 20) {
  // Clean business name for domain use
  const clean = businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 12);
  
  const suffixes = [
    'mail', 'sends', 'reach', 'hub', 'team', 'hq', 'go', 'now',
    'io', 'co', 'biz', 'pro', 'ops', 'run', 'flow', 'labs',
    'direct', 'inbox', 'connect', 'outreach', 'msg', 'ping'
  ];
  
  const prefixes = [
    'get', 'try', 'use', 'join', 'hey', 'hi', 'meet', 'from'
  ];
  
  const candidates = [];
  
  // Pattern 1: businessname + suffix (e.g. rankifymail.com)
  for (const s of suffixes) {
    candidates.push(`${clean}${s}`);
  }
  
  // Pattern 2: prefix + businessname (e.g. getranfiky.com)  
  for (const p of prefixes) {
    candidates.push(`${p}${clean}`);
  }
  
  // Pattern 3: businessname + random 2-3 digit (e.g. rankify42.com)
  for (let i = 0; i < 10; i++) {
    const num = Math.floor(Math.random() * 900) + 100;
    candidates.push(`${clean}${num}`);
  }
  
  // Shuffle and take requested count
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(d => d + '.com');
}

// ============================================
// STEP 2: Check domain availability
// ============================================
async function checkDomainAvailability(domain) {
  try {
    const resp = await fetch(`${PORKBUN_API}/domain/checkAvailability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: CONFIG.porkbun_api_key,
        secretapikey: CONFIG.porkbun_secret_key,
        domain: domain
      })
    });
    const data = await resp.json();
    return {
      domain,
      available: data.status === 'SUCCESS' && data.avail === 'yes',
      price: data.pricing ? data.pricing.registration : null,
      error: data.status !== 'SUCCESS' ? data.message : null
    };
  } catch (e) {
    return { domain, available: false, error: e.message };
  }
}

// ============================================
// STEP 3: Register a domain
// ============================================
async function registerDomain(domain) {
  try {
    const resp = await fetch(`${PORKBUN_API}/domain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: CONFIG.porkbun_api_key,
        secretapikey: CONFIG.porkbun_secret_key,
        domain: domain,
        years: 1,
        // Porkbun provides free WHOIS privacy by default
      })
    });
    const data = await resp.json();
    return {
      domain,
      success: data.status === 'SUCCESS',
      message: data.message || 'Registered successfully',
      orderId: data.orderId || null
    };
  } catch (e) {
    return { domain, success: false, message: e.message };
  }
}

// ============================================
// STEP 4: Set DNS records for email
// ============================================
async function setEmailDNS(domain) {
  const records = [
    // MX record — points to Google Workspace (or whichever email provider)
    { type: 'MX', content: 'aspmx.l.google.com', name: '', prio: 1, ttl: 600 },
    { type: 'MX', content: 'alt1.aspmx.l.google.com', name: '', prio: 5, ttl: 600 },
    { type: 'MX', content: 'alt2.aspmx.l.google.com', name: '', prio: 5, ttl: 600 },
    
    // SPF record — authorise Google to send on behalf of this domain
    { type: 'TXT', content: 'v=spf1 include:_spf.google.com ~all', name: '', ttl: 600 },
    
    // DMARC record
    { type: 'TXT', content: 'v=DMARC1; p=none; rua=mailto:dmarc@coldflows.ai', name: '_dmarc', ttl: 600 },
    
    // DKIM will be added after Google Workspace generates the key
  ];
  
  const results = [];
  for (const record of records) {
    try {
      const resp = await fetch(`${PORKBUN_API}/dns/create/${domain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: CONFIG.porkbun_api_key,
          secretapikey: CONFIG.porkbun_secret_key,
          type: record.type,
          content: record.content,
          name: record.name,
          ttl: String(record.ttl),
          prio: record.prio ? String(record.prio) : undefined
        })
      });
      const data = await resp.json();
      results.push({
        domain,
        record: `${record.type} ${record.name || '@'}`,
        success: data.status === 'SUCCESS',
        id: data.id || null
      });
    } catch (e) {
      results.push({ domain, record: `${record.type} ${record.name}`, success: false, error: e.message });
    }
    // Rate limit — 1 second between API calls
    await new Promise(r => setTimeout(r, 1000));
  }
  return results;
}

// ============================================
// STEP 5: Update Supabase with domain records
// ============================================
async function updateSupabase(userId, domains, campaignMapping) {
  // domains is an array of {domain, campaignNum, mailboxIndex}
  // We'll store this in target_market JSON under a 'provisioning' key
  
  // First get current data
  const resp = await fetch(
    `${CONFIG.supabase_url}/rest/v1/customers?user_id=eq.${userId}&select=target_market`,
    {
      headers: {
        'apikey': CONFIG.supabase_key,
        'Authorization': `Bearer ${CONFIG.supabase_key}`
      }
    }
  );
  const [customer] = await resp.json();
  const tm = JSON.parse(customer.target_market);
  
  // Add provisioning data
  tm.provisioning = {
    status: 'domains_purchased',
    domains: domains,
    purchased_at: new Date().toISOString(),
    dns_status: 'pending',
    workspace_status: 'pending',
    smartlead_status: 'pending'
  };
  
  // Update
  await fetch(
    `${CONFIG.supabase_url}/rest/v1/customers?user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': CONFIG.supabase_key,
        'Authorization': `Bearer ${CONFIG.supabase_key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ target_market: JSON.stringify(tm) })
    }
  );
  
  return { success: true, domainsStored: domains.length };
}

// ============================================
// MAIN PIPELINE
// ============================================
async function provisionCustomer(userId) {
  console.log(`[PROVISION] Starting for user ${userId}`);
  
  // 1. Get customer data
  const resp = await fetch(
    `${CONFIG.supabase_url}/rest/v1/customers?user_id=eq.${userId}&select=*`,
    {
      headers: {
        'apikey': CONFIG.supabase_key,
        'Authorization': `Bearer ${CONFIG.supabase_key}`
      }
    }
  );
  const [customer] = await resp.json();
  if (!customer) throw new Error('Customer not found');
  
  const tm = JSON.parse(customer.target_market || '{}');
  const plans = { starter: { mailboxes: 4, campaigns: 2 }, growth: { mailboxes: 12, campaigns: 4 }, scale: { mailboxes: 30, campaigns: 10 } };
  const limits = plans[customer.plan] || plans.starter;
  
  // Check all campaigns confirmed
  const confirmed = tm.campaigns_confirmed || [];
  if (confirmed.length < limits.campaigns) {
    throw new Error(`Only ${confirmed.length}/${limits.campaigns} campaigns confirmed`);
  }
  
  console.log(`[PROVISION] ${customer.business_name} | ${customer.plan} plan | ${limits.mailboxes} mailboxes needed`);
  
  // 2. Generate domain candidates
  const candidates = generateDomainCandidates(customer.business_name, 40);
  console.log(`[PROVISION] Generated ${candidates.length} domain candidates`);
  
  // 3. Check availability (batch, with rate limiting)
  const available = [];
  for (const domain of candidates) {
    if (available.length >= limits.mailboxes) break;
    const result = await checkDomainAvailability(domain);
    if (result.available) {
      available.push(result);
      console.log(`[PROVISION] ✓ ${domain} available ($${result.price})`);
    }
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }
  
  if (available.length < limits.mailboxes) {
    throw new Error(`Only found ${available.length}/${limits.mailboxes} available domains`);
  }
  
  console.log(`[PROVISION] Found ${available.length} available domains`);
  
  // 4. Register domains
  const registered = [];
  for (const d of available.slice(0, limits.mailboxes)) {
    const result = await registerDomain(d.domain);
    if (result.success) {
      registered.push(d.domain);
      console.log(`[PROVISION] ✓ Registered ${d.domain}`);
    } else {
      console.error(`[PROVISION] ✗ Failed to register ${d.domain}: ${result.message}`);
    }
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
  
  console.log(`[PROVISION] Registered ${registered.length}/${limits.mailboxes} domains`);
  
  // 5. Set DNS records for each domain
  for (const domain of registered) {
    const dnsResults = await setEmailDNS(domain);
    const successes = dnsResults.filter(r => r.success).length;
    console.log(`[PROVISION] DNS for ${domain}: ${successes}/${dnsResults.length} records set`);
  }
  
  // 6. Map domains to campaigns
  const mbPerCampaign = Math.floor(limits.mailboxes / limits.campaigns);
  const mapping = [];
  let domainIdx = 0;
  for (let c = 1; c <= limits.campaigns; c++) {
    for (let m = 0; m < mbPerCampaign; m++) {
      if (domainIdx < registered.length) {
        mapping.push({
          domain: registered[domainIdx],
          campaignNum: c,
          mailboxIndex: m + 1,
          email: `outreach@${registered[domainIdx]}`,
          status: 'dns_propagating'
        });
        domainIdx++;
      }
    }
  }
  
  // 7. Store in Supabase
  await updateSupabase(userId, mapping);
  
  console.log(`[PROVISION] Complete! ${registered.length} domains purchased and mapped`);
  return {
    success: true,
    domains: registered,
    mapping,
    totalCost: registered.length * 11.08
  };
}

// Export for use as module or direct execution
if (typeof module !== 'undefined') module.exports = { provisionCustomer, generateDomainCandidates, checkDomainAvailability, registerDomain, setEmailDNS };
