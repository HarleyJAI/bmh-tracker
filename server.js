/**
 * BMH Patient Journey Tracker — Server
 * Beyond Mobile Health | beyondmobilehealth.com
 *
 * Stack: Node.js / Express / PostgreSQL (Supabase via pg Pool)
 * Deploy: Railway (via GitHub)
 * Port: process.env.PORT || 3000
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Environment Variables ────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
const BASE_URL = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bmh-session-secret-2026';

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] BASE_URL:', BASE_URL);

// ─── Database Setup ───────────────────────────────────────────────────────────
let useDB = false;
let pool = null;
let memPatients = [];

if (DB_URL) {
  pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }
  });
  useDB = true;
  console.log('[DB] Supabase pool initialized');
} else {
  console.log('[DB] No DATABASE_URL — using in-memory store');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ─── Helper: Extract Field from GHL Payload ──────────────────────────────────
function extractField(obj, possibleKeys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of possibleKeys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

// ─── Helper: Normalize Status ────────────────────────────────────────────────
function normalizeStatus(status) {
  if (!status) return 'received';
  const value = String(status).trim().toLowerCase();
  if (value.includes('confirm')) return 'confirmed';
  if (value.includes('schedule')) return 'scheduled';
  if (value.includes('no show') || value.includes('noshow')) return 'no_show';
  if (value.includes('show')) return 'showed';
  if (value.includes('complet')) return 'completed';
  if (value.includes('cancel')) return 'cancelled';
  if (value.includes('miss')) return 'missed_draw';
  if (value.includes('reach')) return 'unable_to_reach';
  return value.replace(/\s+/g, '_');
}

// ─── Helper: Build Patient Record from Payload ───────────────────────────────
function buildPatientRecord(payload) {
  const rawStatus = extractField(payload, [
    'status', 'Status', 'SCHEDULING STATUS',
    'appointments status', 'appointment_status'
  ]) || 'received';

  return {
    id: crypto.randomUUID(),
    first_name:      extractField(payload, ['first_name', 'First Name', 'firstName']) || '',
    last_name:       extractField(payload, ['last_name', 'Last Name', 'lastName']) || '',
    full_name:       extractField(payload, ['full_name', 'Full Name', 'name', 'Name']) || '',
    phone:           extractField(payload, ['phone', 'Phone', 'mobile', 'Mobile']) || '',
    email:           extractField(payload, ['email', 'Email']) || '',
    address:         extractField(payload, ['address', 'Address']) || '',
    zip_code:        extractField(payload, ['zip', 'Zip', 'zip_code', 'PT_ZipCode']) || '',
    mrn:             extractField(payload, ['mrn', 'MRN', 'number_14fga']) || '',
    test_type:       extractField(payload, ['test_type', 'Test Type', 'requested_test']) || '',
    requested_date:  extractField(payload, ['requested_date', 'Requested Date']) || '',
    phlebotomist:    extractField(payload, ['phlebotomist', 'Phlebotomist']) || '',
    raw_status:      rawStatus,
    status:          normalizeStatus(rawStatus),
    source:          extractField(payload, ['source', 'Source']) || 'webhook',
    notes:           extractField(payload, ['notes', 'Notes', 'special_instructions']) || '',
    payload:         payload,
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString()
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Health check — used by Railway and monitoring tools
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    app: 'BMH Tracker',
    status: 'running',
    database: useDB ? 'enabled' : 'memory',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /webhook/ghl
 * Receives GHL form submission webhooks
 * GHL Workflow → Action → Webhook → URL = https://YOUR_DOMAIN/webhook/ghl
 */
app.post('/webhook/ghl', async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[WEBHOOK/GHL] Received:', JSON.stringify(payload, null, 2));

    const patient = buildPatientRecord(payload);

    if (useDB && pool) {
      await pool.query(`
        INSERT INTO patients (
          id, first_name, last_name, full_name, phone, email,
          address, zip_code, mrn, test_type, requested_date,
          phlebotomist, raw_status, status, source, notes,
          payload, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19
        )
      `, [
        patient.id, patient.first_name, patient.last_name, patient.full_name,
        patient.phone, patient.email, patient.address, patient.zip_code,
        patient.mrn, patient.test_type, patient.requested_date,
        patient.phlebotomist, patient.raw_status, patient.status,
        patient.source, patient.notes, JSON.stringify(patient.payload),
        patient.created_at, patient.updated_at
      ]);
      console.log('[DB] Patient inserted:', patient.id);
    } else {
      memPatients.unshift(patient);
      console.log('[MEM] Patient stored:', patient.id);
    }

    return res.status(200).json({ success: true, patientId: patient.id });
  } catch (err) {
    console.error('[WEBHOOK/GHL ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /webhook
 * Legacy webhook endpoint (alias for /webhook/ghl)
 */
app.post('/webhook', async (req, res) => {
  req.url = '/webhook/ghl';
  app.handle(req, res);
});

/**
 * GET /api/patients
 * Returns all patients — polled by the tracker UI
 */
app.get('/api/patients', async (req, res) => {
  try {
    if (useDB && pool) {
      const result = await pool.query(
        'SELECT * FROM patients ORDER BY created_at DESC LIMIT 500'
      );
      return res.status(200).json(result.rows);
    }
    return res.status(200).json(memPatients);
  } catch (err) {
    console.error('[API/PATIENTS ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/patients
 * Manual patient add from the UI
 */
app.post('/api/patients', async (req, res) => {
  try {
    const patient = {
      id: crypto.randomUUID(),
      source: 'manual',
      raw_status: 'received',
      status: 'received',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...req.body
    };

    if (useDB && pool) {
      await pool.query(`
        INSERT INTO patients (
          id, first_name, last_name, full_name, phone, email,
          address, zip_code, mrn, test_type, requested_date,
          phlebotomist, raw_status, status, source, notes,
          payload, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19
        )
      `, [
        patient.id, patient.first_name || '', patient.last_name || '',
        patient.full_name || '', patient.phone || '', patient.email || '',
        patient.address || '', patient.zip_code || '', patient.mrn || '',
        patient.test_type || '', patient.requested_date || '',
        patient.phlebotomist || '', patient.raw_status, patient.status,
        patient.source, patient.notes || '', JSON.stringify({}),
        patient.created_at, patient.updated_at
      ]);
    } else {
      memPatients.unshift(patient);
    }

    return res.status(201).json(patient);
  } catch (err) {
    console.error('[API/PATIENTS POST ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/patients/:id
 * Update patient status or fields from the tracker UI
 */
app.patch('/api/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updated_at: new Date().toISOString() };

    if (useDB && pool) {
      const fields = Object.keys(updates)
        .map((key, i) => `${key} = $${i + 2}`)
        .join(', ');
      const values = Object.values(updates);

      const result = await pool.query(
        `UPDATE patients SET ${fields} WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      return res.status(200).json(result.rows[0]);
    } else {
      const idx = memPatients.findIndex(p => p.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      memPatients[idx] = { ...memPatients[idx], ...updates };
      return res.status(200).json(memPatients[idx]);
    }
  } catch (err) {
    console.error('[API/PATIENTS PATCH ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/patients/:id
 * Remove a patient record
 */
app.delete('/api/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (useDB && pool) {
      const result = await pool.query(
        'DELETE FROM patients WHERE id = $1 RETURNING id',
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
    } else {
      const before = memPatients.length;
      memPatients = memPatients.filter(p => p.id !== id);
      if (memPatients.length === before) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
    }

    return res.status(200).json({ success: true, deleted: id });
  } catch (err) {
    console.error('[API/PATIENTS DELETE ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /webhook/test
 * Injects a test patient — use in browser to verify webhook flow
 */
app.get('/webhook/test', async (req, res) => {
  const testPayload = {
    full_name: 'Test Patient',
    first_name: 'Test',
    last_name: 'Patient',
    date_of_birth: '1985-06-15',
    ordering_provider: 'Dr. Demo / BMH Test Clinic',
    test_type: 'CBC, CMP, HbA1c',
    phone: '555-000-1234',
    email: 'test@beyondmobilehealth.com',
    notes: 'Fasting required. Patient prefers morning visits.',
    source: 'test'
  };

  try {
    const patient = buildPatientRecord(testPayload);
    patient.source = 'test';

    if (useDB && pool) {
      await pool.query(`
        INSERT INTO patients (
          id, first_name, last_name, full_name, phone, email,
          address, zip_code, mrn, test_type, requested_date,
          phlebotomist, raw_status, status, source, notes,
          payload, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19
        )
      `, [
        patient.id, patient.first_name, patient.last_name, patient.full_name,
        patient.phone, patient.email, patient.address, patient.zip_code,
        patient.mrn, patient.test_type, patient.requested_date,
        patient.phlebotomist, patient.raw_status, patient.status,
        patient.source, patient.notes, JSON.stringify(testPayload),
        patient.created_at, patient.updated_at
      ]);
    } else {
      memPatients.unshift(patient);
    }

    return res.status(200).json({ message: 'Test patient injected', patient });
  } catch (err) {
    console.error('[WEBHOOK/TEST ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SPA Fallback — Serve index.html for all unmatched routes ─────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ BMH Tracker running on port ${PORT}`);
  console.log(`   Health check:  ${BASE_URL}/health`);
  console.log(`   Tracker UI:    ${BASE_URL}`);
  console.log(`   Webhook (GHL): ${BASE_URL}/webhook/ghl`);
  console.log(`   Test inject:   ${BASE_URL}/webhook/test\n`);
});
