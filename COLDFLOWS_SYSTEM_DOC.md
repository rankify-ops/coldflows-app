# Coldflows.ai — Complete System Documentation
## Last updated: April 3, 2026

---

## 1. WHAT IS COLDFLOWS

Coldflows is a fully managed cold email outreach SaaS platform. Customers pay a monthly fee, tell us what they sell and who they want to reach, and we handle everything — domain purchasing, mailbox creation, email warmup, lead sourcing, AI copy generation, and campaign execution. Warm replies are forwarded to their inbox. That's it.

**Website:** https://coldflows.ai
**Dashboard:** https://coldflows.ai/app
**Repo:** https://github.com/rankify-ops/coldflows-app (GitHub Pages deployment)

---

## 2. PRICING (USD)

| Plan | Price/mo | Mailboxes | Campaigns | Stripe Payment Link |
|------|----------|-----------|-----------|---------------------|
| Starter | $690 | 4 | 2 | https://buy.stripe.com/eVq14odeC2Zh8RYe9Q5gc02 |
| Growth | $1,750 | 12 | 4 | https://buy.stripe.com/dRm5kEcaydDV8RYfdU5gc00 |
| Scale | $3,500 | 30 | 10 | https://buy.stripe.com/00w28s6Qe9nF3xEaXE5gc01 |

---

## 3. GITHUB

- **Account:** rankify-ops (user account, not org)
- **Repo:** rankify-ops/coldflows-app
- **Deploys via:** GitHub Pages (automatic on push to main)
- **PAT:** `GITHUB_PAT_REDACTED`
- **PAT permissions:** Actions, Administration, Contents, Metadata, Secrets, Workflows

### Key files:
- `/index.html` — Landing page
- `/app/index.html` — Dashboard (React via Babel, single file)
- `/signup.html` — Signup/login page
- `/onboarding.html` — Onboarding form
- `/privacy.html` — Privacy policy
- `/terms.html` — Terms of service
- `/api/provision-hardened.js` — Domain provisioning script (NOT deployed, reference only)

---

## 4. SUPABASE

- **Project:** bmjjyujuyjpkyggormoa
- **URL:** https://bmjjyujuyjpkyggormoa.supabase.co
- **Publishable key:** `SUPABASE_PUBLISHABLE_REDACTED`
- **Secret key:** `SUPABASE_SECRET_REDACTED`

### Database schema:
**Table: customers**
| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | FK to auth.users |
| email | text | Customer email |
| business_name | text | |
| service_description | text | What they sell |
| plan | text | starter/growth/scale |
| plan_status | text | active/pending |
| mailbox_count | int | 0 during provisioning |
| lead_email | text | Where replies go |
| target_market | jsonb | All campaign + provisioning data (see below) |
| created_at | timestamp | |

### target_market JSON structure:
```json
{
  "website": "...",
  "offer": "...",
  "pain_point": "...",
  "social_proof": "...",
  "campaign_name": "Campaign 1 custom name",
  "job_titles": ["CEO", "Founder"],
  "seniority": ["C-Suite", "VP"],
  "industries": ["Software / SaaS"],
  "company_size": ["51-200"],
  "locations": ["Australia"],
  "location_detail": "Melbourne, Sydney",
  "campaigns_confirmed": [1, 2, 3, 4],
  "campaign_2": {
    "campaign_name": "...",
    "offer": "...",
    "pain_point": "...",
    "social_proof": "...",
    "job_titles": [...],
    "seniority": [...],
    "industries": [...],
    "company_size": [...],
    "locations": [...],
    "location_detail": "..."
  },
  "campaign_3": { ... },
  "campaign_4": { ... },
  "provisioning": {
    "job_id": "prov_xxx",
    "status": "purchasing|domains_complete|dns_setup|complete|error",
    "started_at": "ISO date",
    "completed_at": "ISO date",
    "budget_limit": 180,
    "budget_spent": 0,
    "domains_needed": 12,
    "domains_purchased": 0,
    "domains": [
      {
        "domain": "rankifymail.com",
        "status": "purchased|dns_done|error",
        "purchased_at": "ISO date",
        "cost": 11.08,
        "campaign": 1,
        "mailbox_index": 1,
        "email": "outreach@rankifymail.com",
        "verified_in_account": true
      }
    ],
    "errors": [],
    "dns_status": "pending|done",
    "workspace_status": "pending|done",
    "smartlead_status": "pending|done"
  }
}
```

### Auth:
- Google OAuth for signup (consent screen still in testing mode)
- Signup page at /signup.html checks if user exists in customers table
- Active users redirect to /app, new users redirect to /onboarding

### Test account:
- **Email:** tomflood1995@gmail.com
- **user_id:** USER_ID_REDACTED
- **Plan:** Growth
- **Business:** Rankify

---

## 5. STRIPE

- **Account:** Coldflows (separate Stripe account)
- **Live key:** STRIPE_LIVE_KEY_REDACTED... (stored in Stripe, not in code)
- **Webhook secret:** STRIPE_WEBHOOK_REDACTED
- **Payment links:** See pricing table above

---

## 6. DOMAIN REGISTRAR — NAMECHEAP

- **Account:** coldflowsai
- **API key:** NAMECHEAP_KEY_REDACTED
- **API docs:** https://www.namecheap.com/support/api/intro/
- **Sandbox:** https://sandbox.namecheap.com (separate account needed for testing)
- **Balance:** $50+ required for API access
- **IMPORTANT:** Namecheap API requires IP whitelisting. Need a VPS with static IP.
- **Whitelisted IP:** 34.41.59.97 (needs updating to VPS static IP when set up)
- **Status:** API access enabled, need VPS with static IP to use programmatically

### Domain strategy:
- 1 domain per mailbox (reputation isolation)
- Domain names generated from business name + suffix (e.g. rankifymail.com)
- RDAP check (free, rdap.verisign.com) for .com availability before purchase
- .com domains ~$10-11/year each via Namecheap
- Growth plan: 12 domains = ~$133/year

---

## 7. PORKBUN (DNS management for existing domains, NOT for purchasing)

- **Account:** Rankify
- **API key (RANKIFYAUTO):** PORKBUN_KEY_REDACTED
- **API key (Coldflows):** PORKBUN_KEY_REDACTED
- **Secret key (Coldflows):** PORKBUN_SECRET_REDACTED
- **Existing domains:** rankify.au, rankify.studio
- **API base:** https://api.porkbun.com/api/json/v3
- **NOTE:** Porkbun API does NOT support domain registration — only DNS, SSL, and domain management. Used for DNS records on existing domains.

---

## 8. SMARTLEAD

- **Plan:** Base ($39/mo)
- **API key:** Stored as GitHub secret in rankify-ops
- **Purpose:** Email warmup + campaign sending
- **Warmup config:** 2/day ramp to 40-50/day per mailbox over 14-21 days

---

## 9. TELEGRAM (Admin notifications)

- **Bot token:** TELEGRAM_TOKEN_REDACTED
- **Purpose:** Provisioning progress alerts, error notifications to Thomas

---

## 10. DASHBOARD ARCHITECTURE

The dashboard is a single-page React app compiled by Babel in the browser (`<script type="text/babel">`). Everything is in `/app/index.html`.

### Key components:
- **App()** — main component, handles auth, routing, data loading
- **CampaignModal()** — separate React component for campaign setup/viewing
- **States:** pg (current page), custData (customer data from Supabase), configCampaign (which campaign modal is open), editMode, opsDetail, validationErr

### Pages (nav via `pg` state):
- overview — provisioning status, campaign cards, setup progress
- campaigns — campaign management (placeholder for active accounts)
- replies — reply inbox (placeholder)
- leads — lead management (placeholder)
- mailboxes — mailbox allocation per campaign
- experiments — A/B testing (placeholder)
- subscription — plan management
- billing — invoice history
- **ops** — ADMIN ONLY (tomflood1995@gmail.com), full pipeline view

### Design system:
- Firecrawl-inspired grid aesthetic
- borderRadius: 0 on all cards (flat edges)
- DM Sans font, JetBrains Mono for code
- Green: #006949, Orange for active/warning
- Dark mode support via CSS variables

### Customer flow:
1. Stripe payment → webhook creates Supabase row
2. Signup/login → /signup.html → Google OAuth
3. Active user check → redirect to /app or /onboarding
4. Onboarding form → saves business info to Supabase
5. Dashboard loads → shows provisioning state (0 mailboxes)
6. Configure campaigns sequentially (1→2→3→4)
7. All confirmed → success banner, provisioning triggered
8. (Automated from here) domains → DNS → workspace → warmup → leads → copy → launch

### Campaign setup flow:
- Sequential unlock: Campaign 1 must be confirmed before 2 unlocks, etc.
- Required fields: offer, pain point, social proof, product/service (Campaign 1)
- Required targeting: job titles, seniority, industries, company size, locations (all chips)
- Validation with red borders on empty fields
- Copy from another campaign via dropdown
- Confirmed campaigns show as locked/read-only (green card with checkmark)
- Data stored: Campaign 1 at root of target_market, Campaigns 2+ under campaign_X keys

---

## 11. PROVISIONING PIPELINE (automated after all campaigns confirmed)

### Order of operations (SEQUENTIAL, not parallel):
1. All campaigns confirmed (gate)
2. Purchase domains via Namecheap API (1 per mailbox)
3. Set DNS records per domain (MX, SPF, DMARC)
4. Create Google Workspace mailboxes per domain
5. Add mailboxes to Smartlead
6. Warmup phase (14-21 days)
7. Lead sourcing (SmartProspect/Apollo)
8. AI email copy generation (Claude API)
9. Campaign launch
10. Replies forwarded to customer's lead_email

### Provisioning script: `/api/provision-hardened.js`
Safeguards:
- Idempotent (checks existing purchases before buying)
- Budget guard (hard cap at plan_limit × $15)
- RDAP availability check before every purchase
- Post-purchase verification via registrar account listing
- Immediate Supabase save after each domain
- Telegram notifications for progress + errors
- Refuses to run if campaigns not all confirmed

### VPS requirement:
- Need a $4-5/mo DigitalOcean/Hetzner VPS with static IP
- Static IP whitelisted in Namecheap once, permanently
- Provisioning script runs on VPS
- Triggered by Supabase database webhook when all campaigns confirmed
- Also runs cron jobs for warmup monitoring, renewal alerts

---

## 12. SERVICES MAP

| Service | Purpose | Account | Cost |
|---------|---------|---------|------|
| GitHub Pages | Dashboard + landing hosting | rankify-ops | Free |
| Supabase | Database, auth, storage | bmjjyujuyjpkyggormoa | Free tier |
| Stripe | Payments | Coldflows account | % per transaction |
| Namecheap | Domain registration | coldflowsai | ~$11/domain/year |
| Porkbun | DNS for existing domains | Rankify | Included with domains |
| Google Workspace | Mailbox creation | TBD | ~$6/user/month |
| Smartlead | Warmup + email sending | Base plan | $39/month |
| SmartProspect/Apollo | Lead sourcing | TBD | ~$0.03-0.05/lead |
| Claude API | Email copy generation | Anthropic | Per token |
| Telegram | Admin notifications | Bot 8602324504 | Free |
| DigitalOcean/Hetzner | VPS for automation | TBD | ~$4-5/month |

---

## 13. MONTHLY COST PER CUSTOMER (Growth plan example)

| Item | Cost |
|------|------|
| Domains (12 × $11.08/yr ÷ 12) | $11/mo |
| Google Workspace (12 × $6) | $72/mo |
| Smartlead (shared) | ~$3/mo allocated |
| Lead data | ~$50-100/mo |
| **Total overhead** | **~$136-186/mo** |
| **Revenue (Growth)** | **$1,750/mo** |
| **Margin** | **~$1,564-1,614/mo (~90%)** |

---

## 14. ADMIN ACCESS

Only tomflood1995@gmail.com can see the Ops Pipeline tab in the dashboard sidebar. It shows:
- Customer summary (plan, campaigns, domains, spend)
- Horizontal pipeline flowchart with live status per stage
- Domains table (domain, campaign, mailbox, purchase date, renewal date, cost, status)
- Campaign detail table
- Error log
- Data reference cards (Supabase, APIs, costs)
- Raw target_market JSON viewer

---

## 15. WHAT'S BUILT vs WHAT'S PENDING

### BUILT:
- [x] Landing page (coldflows.ai)
- [x] Signup/login with Google OAuth
- [x] Onboarding form
- [x] Dashboard with provisioning state
- [x] Sequential campaign setup (confirm 1→2→3→4)
- [x] Campaign validation (all fields + targeting required)
- [x] Copy from another campaign
- [x] Confirmed = locked read-only view
- [x] Success banner when all campaigns done
- [x] Setup progress checklist
- [x] Mailboxes page with explainer
- [x] Subscription + billing pages
- [x] Ops Pipeline admin tab with flowchart + domain table
- [x] Privacy policy + terms of service
- [x] No-cache headers
- [x] Provisioning script (provision-hardened.js) — written but not deployed
- [x] Domain name generation algorithm
- [x] RDAP availability checking
- [x] Namecheap account + API key

### PENDING:
- [ ] VPS setup (DigitalOcean/Hetzner, $4-5/mo, static IP)
- [ ] Deploy provisioning script to VPS
- [ ] Whitelist VPS IP in Namecheap
- [ ] Supabase webhook to trigger provisioning on all-campaigns-confirmed
- [ ] Test domain purchase end-to-end
- [ ] Namecheap sandbox testing
- [ ] Google Workspace admin account setup
- [ ] Google Workspace API integration (create mailboxes)
- [ ] Smartlead API integration (add mailboxes, configure warmup)
- [ ] DNS record automation (MX, SPF, DKIM, DMARC)
- [ ] Lead sourcing pipeline (SmartProspect/Apollo)
- [ ] AI email copy generation (Claude API)
- [ ] Reply forwarding setup
- [ ] Stripe webhook for auto-creating customer records
- [ ] Google OAuth consent screen → production mode
- [ ] Rotate GitHub PAT
- [ ] Affiliate/referral system
- [ ] Mobile responsive check

---

## 16. HOW TO CONTINUE THIS BUILD

If starting a new session with an AI assistant:

1. Share this document
2. The repo is at github.com/rankify-ops/coldflows-app
3. The dashboard is a single HTML file at /app/index.html (React via Babel)
4. All customer data is in Supabase (see section 4)
5. The next step is: set up a VPS with static IP, deploy the provisioning script, whitelist the IP in Namecheap, and test a domain purchase end-to-end
6. After domains: DNS records → Google Workspace → Smartlead → warmup → leads → copy → launch
7. Thomas (tomflood1995@gmail.com) is the admin. He prefers: direct deliverables not instructions, ask before touching anything, no assumptions, Firecrawl grid aesthetic for the dashboard

---

## 17. KEY PREFERENCES

- Ask before changing anything
- No assumptions without confirmation
- Deliver working code, not instructions
- Firecrawl-inspired dashboard aesthetic (flat edges, borderRadius:0, var(--bg) backgrounds)
- Direct, casual communication style
- Automation-first philosophy ("build the machine before loading it with work")
