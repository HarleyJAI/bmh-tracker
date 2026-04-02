# BMH Patient Journey Tracker — GHL Integration Guide

## Architecture Overview

```
GHL Form Submitted
       ↓
GHL Workflow (Trigger: Form Submission)
       ↓
Webhook Action → POST https://YOUR_DOMAIN/webhook/ghl
       ↓
BMH Tracker Server (Node.js)
       ↓
Patient appears in Tracker UI (auto-refreshes every 30s)
       ↓
Tracker embedded in GHL as Custom Page (iframe)
```

---

## Step 1 — Deploy the Server

### Option A: Railway (Recommended — Free tier available)
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Push this folder to a GitHub repo
3. Railway auto-detects Node.js and runs `npm start`
4. Copy your Railway URL: `https://bmh-tracker-xxxx.railway.app`

### Option B: Render
1. Go to https://render.com → New Web Service
2. Connect GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Copy your Render URL

### Option C: Self-hosted VPS
```bash
git clone <your-repo>
cd bmh-tracker
npm install
# Install PM2 for process management
npm install -g pm2
pm2 start server.js --name bmh-tracker
pm2 save
```

---

## Step 2 — Configure GHL Webhook

### In GoHighLevel:
1. Go to **Settings → Integrations → Webhooks** OR use a Workflow

### Workflow Method (Recommended):
1. **Automations → Workflows → Create Workflow**
2. **Trigger:** Form Submitted
   - Select your patient order form
3. **Action:** Webhook
   - Method: `POST`
   - URL: `https://YOUR_DOMAIN/webhook/ghl`
   - Headers: `Content-Type: application/json`
   - Body: Leave as default (GHL sends form data automatically)

### Optional — Add a Secret for Security:
Add a custom header in the webhook action:
- Header name: `x-ghl-secret`
- Header value: (create a random string, e.g. `bmh_secret_2026`)

Then uncomment these lines in `server.js`:
```javascript
const secret = req.headers['x-ghl-secret'];
if (secret !== process.env.GHL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
```

And set the env variable: `GHL_WEBHOOK_SECRET=bmh_secret_2026`

---

## Step 3 — Map Your GHL Form Fields

Open `server.js` and find the `GHL_FIELD_MAP` section.

Match each array to the **Field Key** in your GHL form builder
(found in Form Builder → field settings → "Field Key"):

```javascript
const GHL_FIELD_MAP = {
  name:     ['full_name', 'name', 'contact.name'],   // ← your GHL field key here
  dob:      ['date_of_birth', 'dob'],
  provider: ['ordering_provider', 'provider'],
  service:  ['test_ordered', 'service'],
  phone:    ['phone', 'contact.phone'],
  email:    ['email', 'contact.email'],
  notes:    ['notes', 'special_instructions'],
};
```

**To find your field keys in GHL:**
Form Builder → Click a field → Right panel → scroll to "Field Key" (usually auto-generated, e.g. `date_of_birth_1`)

---

## Step 4 — Test the Webhook

1. Visit: `https://YOUR_DOMAIN/webhook/test`
   → This injects a test patient to confirm the server is working.

2. Submit your actual GHL form with test data.
   → Check the tracker UI — patient should appear within 30 seconds.

3. Check server logs for the raw payload:
```
[WEBHOOK] Received from GHL: { full_name: "Test Patient", ... }
[TRACKER] New patient added: Test Patient (uuid)
```
   If fields aren't mapping, use these logs to find the exact key names GHL is sending.

---

## Step 5 — Embed in GHL

### Embed as a Custom Menu Link:
1. GHL → Settings → Custom Menu Links → Add Link
2. Name: `Patient Tracker`
3. URL: `https://YOUR_DOMAIN`
4. Open in: iFrame (recommended)

### Embed in a Dashboard Widget:
1. GHL → Dashboard → Add Widget → Custom HTML
2. Paste:
```html
<iframe src="https://YOUR_DOMAIN" style="width:100%;height:700px;border:none;border-radius:12px;" allowfullscreen></iframe>
```

---

## GHL Form — Recommended Fields

Build your GHL patient order form with these fields:

| Field Label             | Field Key (suggested)    | Type     |
|-------------------------|--------------------------|----------|
| Patient Full Name       | `full_name`              | Text     |
| Date of Birth           | `date_of_birth`          | Date     |
| Ordering Provider       | `ordering_provider`      | Text     |
| Test / Service Ordered  | `test_ordered`           | Textarea |
| Patient Phone           | `phone`                  | Phone    |
| Patient Email           | `email`                  | Email    |
| Patient Address         | `address`                | Text     |
| Special Instructions    | `notes`                  | Textarea |

---

## Upgrading to a Database (Production)

The server currently uses in-memory storage (resets on restart).
For production, swap to a persistent database:

### Supabase (Free PostgreSQL):
```bash
npm install @supabase/supabase-js
```
Create a `patients` table and replace the `patients` array with Supabase queries.

### Airtable:
```bash
npm install airtable
```
Map each patient field to an Airtable column. GHL → Webhook → Airtable via server.

---

## Environment Variables

```env
PORT=3000
GHL_WEBHOOK_SECRET=your_secret_here   # optional
DATABASE_URL=...                       # if using Postgres
```

---

## Support
Beyond Mobile Health | 857-557-7197
3975 Fair Ridge Dr, Suite 250N, Fairfax, VA 22033
