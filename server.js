/**
 * BMH Patient Journey Tracker — Server
 * Beyond Mobile Health | beyondmobilehealth.com
 *
 * Stack:  Node.js / Express / PostgreSQL (Supabase via pg Pool)
 * Deploy: Railway (via GitHub auto-deploy)
 * Port:   process.env.PORT || 3000
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const session = require('express-session');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Environment ──────────────────────────────────────────────────────────────
const DB_URL         = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bmh-session-secret-2026';
const BASE_URL       = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';

console.log('[ENV] DATABASE_URL present:', !!DB_URL);

// ─── Database ─────────────────────────────────────────────────────────────────
let useDB = false;
let pool  = null;
let memPatients = [];

if (DB_URL) {
  pool  = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  useDB = true;
  console.log('[DB] Pool initialized');
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
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractField(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function normalizeStatus(status) {
  if (!status) return 'received';
  const v = String(status).trim().toLowerCase();

  if (v === 'showed')       return 'completed';
  if (v === 'no_show')      return 'not_completed';
  if (v === 'no show')      return 'not_completed';
  if (v === 'confirmed')    return 'scheduled';
  if (v === 'unconfirmed')  return 'received';
  if (v === 'cancelled')    return 'not_completed';
  if (v === 'invalid')      return 'not_completed';

  if (v.includes('complet'))  return 'completed';
  if (v.includes('schedule')) return 'scheduled';
  if (v.includes('reach'))    return 'unable_to_reach';

  return 'received';
}

function buildPatient(payload) {
  const rawStatus = extractField(payload, ['status', 'Status', 'SCHEDULING STATUS', 'appointments status', 'appointment_status']) || 'received';
  const firstName = extractField(payload, ['first_name', 'First Name', 'firstName']) || '';
  const lastName  = extractField(payload, ['last_name',  'Last Name',  'lastName'])  || '';
  const fullName  = extractField(payload, ['full_name',  'Full Name',  'name', 'Name']) || (firstName + ' ' + lastName).trim();

  return {
    id:                 crypto.randomUUID(),
    source:             extractField(payload, ['source', 'Source']) || 'webhook',
    received_at:        new Date().toISOString(),
    name:               fullName,
    first_name:         firstName,
    last_name:          lastName,
    dob:                extractField(payload, ['dob', 'date_of_birth', 'DOB']) || '',
    provider:           extractField(payload, ['provider', 'ordering_provider', 'Provider']) || '',
    service:            extractField(payload, ['service', 'test_type', 'Test Type', 'requested_test']) || '',
    phone:              extractField(payload, ['phone', 'Phone', 'mobile', 'Mobile']) || '',
    email:              extractField(payload, ['email', 'Email']) || '',
    address:            extractField(payload, ['address', 'Address']) || '',
    assignee:           extractField(payload, ['phlebotomist', 'Phlebotomist', 'assignee']) || '',
    order_date:         new Date().toISOString().slice(0, 10),
    status:             normalizeStatus(rawStatus),
    appt_date:          '',
    appt_time:          '',
    completed_date:     '',
    completed_time:     '',
    incomplete_reason:  '',
    unreachable_reason: '',
    notes:              extractField(payload, ['notes', 'Notes', 'special_instructions']) || '',
    raw:                payload,
    mrn:                extractField(payload, ['mrn', 'MRN', 'number_14fga']) || '',
    zip_code:           extractField(payload, ['zip', 'Zip', 'zip_code', 'PT_ZipCode']) || '',
    test_type:          extractField(payload, ['test_type', 'Test Type', 'requested_test']) || '',
    requested_date:     extractField(payload, ['requested_date', 'Requested Date']) || '',
    phlebotomist:       extractField(payload, ['phlebotomist', 'Phlebotomist']) || '',
    raw_status:         rawStatus,
    payload:            payload
  };
}

// ─── Reusable DB Insert ───────────────────────────────────────────────────────
async function insertPatient(p) {
  await pool.query(
    `INSERT INTO patients (
      id, source, received_at, name, first_name, last_name,
      dob, provider, service, phone, email, address,
      assignee, order_date, status, appt_date, appt_time,
      completed_date, completed_time, incomplete_reason, unreachable_reason,
      notes, raw, mrn, zip_code, test_type, requested_date,
      phlebotomist, raw_status, payload
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,
      $18,$19,$20,$21,
      $22,$23,$24,$25,$26,$27,
      $28,$29,$30
    )`,
    [
      p.id, p.source, p.received_at, p.name, p.first_name, p.last_name,
      p.dob, p.provider, p.service, p.phone, p.email, p.address,
      p.assignee, p.order_date, p.status, p.appt_date, p.appt_time,
      p.completed_date, p.completed_time, p.incomplete_reason, p.unreachable_reason,
      p.notes, JSON.stringify(p.raw), p.mrn, p.zip_code, p.test_type, p.requested_date,
      p.phlebotomist, p.raw_status, JSON.stringify(p.payload)
    ]
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    app: 'BMH Tracker',
    status: 'running',
    database: useDB ? 'enabled' : 'memory',
    timestamp: new Date().toISOString()
  });
});

// GHL Webhook
app.post('/webhook/ghl', async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[WEBHOOK/GHL] Received:', JSON.stringify(payload, null, 2));
    const patient = buildPatient(payload);
    if (useDB && pool) {
      await insertPatient(patient);
      console.log('[DB] Patient inserted:', patient.id);
    } else {
      memPatients.unshift(patient);
    }
    return res.status(200).json({ success: true, patientId: patient.id });
  } catch (err) {
    console.error('[WEBHOOK/GHL ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy webhook alias
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const patient = buildPatient(payload);
    if (useDB && pool) {
      await insertPatient(patient);
    } else {
      memPatients.unshift(patient);
    }
    return res.status(200).json({ success: true, patientId: patient.id });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get all patients
app.get('/api/patients', async (req, res) => {
  try {
    if (useDB && pool) {
      const result = await pool.query('SELECT * FROM patients ORDER BY received_at DESC LIMIT 500');
      return res.json(result.rows);
    }
    return res.json(memPatients);
  } catch (err) {
    console.error('[API/PATIENTS ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Manual add patient
app.post('/api/patients', async (req, res) => {
  try {
    const patient = buildPatient({ ...req.body, source: 'manual' });
    if (useDB && pool) {
      await insertPatient(patient);
    } else {
      memPatients.unshift(patient);
    }
    return res.status(201).json(patient);
  } catch (err) {
    console.error('[API/PATIENTS POST ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Update patient
app.patch('/api/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    delete updates.id;

    if (useDB && pool) {
      const keys   = Object.keys(updates);
      const values = Object.values(updates);
      const fields = keys.map((k, i) => k + ' = $' + (i + 2)).join(', ');
      const result = await pool.query(
        'UPDATE patients SET ' + fields + ' WHERE id = $1 RETURNING *',
        [id, ...values]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      return res.json(result.rows[0]);
    } else {
      const idx = memPatients.findIndex(p => p.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      memPatients[idx] = { ...memPatients[idx], ...updates };
      return res.json(memPatients[idx]);
    }
  } catch (err) {
    console.error('[API/PATIENTS PATCH ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Delete patient
app.delete('/api/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useDB && pool) {
      const result = await pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]);
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
    return res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('[API/PATIENTS DELETE ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Test inject
app.get('/webhook/test', async (req, res) => {
  try {
    const testPayload = {
      full_name:     'Test Patient',
      first_name:    'Test',
      last_name:     'Patient',
      dob:           '1985-06-15',
      provider:      'Dr. Demo / BMH Test Clinic',
      test_type:     'CBC, CMP, HbA1c',
      phone:         '555-000-1234',
      email:         'test@beyondmobilehealth.com',
      notes:         'Fasting required. Patient prefers morning visits.',
      source:        'test',
      status:        'confirmed'
    };
    const patient = buildPatient(testPayload);
    if (useDB && pool) {
      await insertPatient(patient);
    } else {
      memPatients.unshift(patient);
    }
    return res.json({ message: 'Test patient injected', patient });
  } catch (err) {
    console.error('[WEBHOOK/TEST ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// SPA fallback — must be last route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('\n✅ BMH Tracker running on port ' + PORT);
  console.log('   UI:      ' + BASE_URL);
  console.log('   Health:  ' + BASE_URL + '/health');
  console.log('   Webhook: ' + BASE_URL + '/webhook/ghl');
  console.log('   Test:    ' + BASE_URL + '/webhook/test\n');
});
