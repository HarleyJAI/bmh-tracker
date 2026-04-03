const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      source TEXT DEFAULT 'manual',
      received_at TIMESTAMPTZ DEFAULT NOW(),
      name TEXT NOT NULL,
      dob TEXT,
      provider TEXT,
      service TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      assignee TEXT,
      order_date TEXT,
      status TEXT DEFAULT 'received',
      appt_date TEXT,
      appt_time TEXT,
      completed_date TEXT,
      completed_time TEXT,
      incomplete_reason TEXT,
      unreachable_reason TEXT,
      notes TEXT,
      raw JSONB
    )
  `);
  console.log('[DB] patients table ready');
}

function rowToPatient(r) {
  return {
    id: r.id,
    source: r.source,
    receivedAt: r.received_at,
    name: r.name,
    dob: r.dob || '',
    provider: r.provider || '',
    service: r.service || '',
    phone: r.phone || '',
    email: r.email || '',
    address: r.address || '',
    assignee: r.assignee || '',
    orderDate: r.order_date || '',
    status: r.status || 'received',
    apptDate: r.appt_date || '',
    apptTime: r.appt_time || '',
    completedDate: r.completed_date || '',
    completedTime: r.completed_time || '',
    incompleteReason: r.incomplete_reason || '',
    unreachableReason: r.unreachable_reason || '',
    notes: r.notes || '',
    _raw: r.raw,
  };
}

// ── GHL Field Map ─────────────────────────────────────────────────────────────
const GHL_FIELD_MAP = {
  firstName: ['first_name', 'firstName'],
  lastName:  ['last_name', 'lastName'],
  dob:       ['date_of_birth', 'dob', 'birthdate'],
  phone:     ['phone', 'phone_number', 'contact.phone'],
  email:     ['email', 'contact.email'],
  address:   ['address', 'contact.address1'],
  mrn:       ['mrn', 'MRN'],
  service:   ['test_ordered', 'service', 'lab_order'],
  provider:  ['ordering_provider', 'provider'],
  assignee:  ['appointment_owner', 'assigned_to', 'assignee'],
  notes:     ['notes', 'special_instructions', 'additional_information'],
};

function extractField(payload, keys) {
  if (!payload || !keys) return '';
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') return String(payload[key]);
    if (payload.customData?.[key]) return String(payload.customData[key]);
    if (payload.formData?.[key]) return String(payload.formData[key]);
    if (payload.contact?.[key]) return String(payload.contact[key]);
  }
  return '';
}

function buildPatient(payload) {
  const now = new Date();
  const firstName = extractField(payload, GHL_FIELD_MAP.firstName);
  const lastName = extractField(payload, GHL_FIELD_MAP.lastName);
  const fullName = (firstName + ' ' + lastName).trim() || 'Unknown Patient';
  const mrn = extractField(payload, GHL_FIELD_MAP.mrn);
  const notes = extractField(payload, GHL_FIELD_MAP.notes);
  const notesWithMrn = mrn ? ('MRN: ' + mrn + (notes ? ' | ' + notes : '')) : notes;

  return {
    id: crypto.randomUUID(),
    source: 'ghl_webhook',
    receivedAt: now.toISOString(),
    name: fullName,
    dob: extractField(payload, GHL_FIELD_MAP.dob),
    provider: extractField(payload, GHL_FIELD_MAP.provider),
    service: extractField(payload, GHL_FIELD_MAP.service),
    phone: extractField(payload, GHL_FIELD_MAP.phone),
    email: extractField(payload, GHL_FIELD_MAP.email),
    address: extractField(payload, GHL_FIELD_MAP.address),
    assignee: extractField(payload, GHL_FIELD_MAP.assignee),
    orderDate: now.toISOString().slice(0, 10),
    status: 'received',
    apptDate: '', apptTime: '',
    completedDate: '', completedTime: '',
    incompleteReason: '', unreachableReason: '',
    notes: notesWithMrn,
    _raw: payload,
  };
}

async function savePatient(p) {
  await pool.query(`
    INSERT INTO patients (id,source,received_at,name,dob,provider,service,phone,email,address,assignee,order_date,status,appt_date,appt_time,completed_date,completed_time,incomplete_reason,unreachable_reason,notes,raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (id) DO NOTHING
  `, [p.id, p.source, p.receivedAt, p.name, p.dob, p.provider, p.service, p.phone, p.email, p.address||'', p.assignee||'', p.orderDate, p.status, p.apptDate, p.apptTime, p.completedDate, p.completedTime, p.incompleteReason, p.unreachableReason, p.notes, p._raw ? JSON.stringify(p._raw) : null]);
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/webhook/ghl', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[WEBHOOK] Received:', JSON.stringify(payload, null, 2));
    const patient = buildPatient(payload);
    await savePatient(patient);
    console.log('[TRACKER] Added:', patient.name);
    return res.status(200).json({ success: true, patientId: patient.id, patient });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

app.get('/api/patients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM patients ORDER BY received_at DESC');
    res.json(result.rows.map(rowToPatient));
  } catch (err) {
    console.error('[GET ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/patients/:id', async (req, res) => {
  try {
    const d = req.body;
    await pool.query(`
      UPDATE patients SET
        status=COALESCE($1,status), appt_date=COALESCE($2,appt_date), appt_time=COALESCE($3,appt_time),
        completed_date=COALESCE($4,completed_date), completed_time=COALESCE($5,completed_time),
        incomplete_reason=COALESCE($6,incomplete_reason), unreachable_reason=COALESCE($7,unreachable_reason),
        notes=COALESCE($8,notes), assignee=COALESCE($9,assignee), provider=COALESCE($10,provider)
      WHERE id=$11
    `, [d.status, d.apptDate, d.apptTime, d.completedDate, d.completedTime, d.incompleteReason, d.unreachableReason, d.notes, d.assignee, d.provider, req.params.id]);
    const result = await pool.query('SELECT * FROM patients WHERE id=$1', [req.params.id]);
    res.json(result.rows.length ? rowToPatient(result.rows[0]) : { error: 'Not found' });
  } catch (err) {
    console.error('[PATCH ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/patients', async (req, res) => {
  try {
    const d = req.body;
    const patient = {
      id: d.id || crypto.randomUUID(),
      source: d.source || 'manual',
      receivedAt: d.receivedAt || new Date().toISOString(),
      name: d.name || 'Unknown',
      dob: d.dob || '', provider: d.provider || '', service: d.service || '',
      phone: d.phone || '', email: d.email || '', address: d.address || '',
      assignee: d.assignee || '',
      orderDate: d.orderDate || new Date().toISOString().slice(0, 10),
      status: d.status || 'received',
      apptDate: d.apptDate || '', apptTime: d.apptTime || '',
      completedDate: d.completedDate || '', completedTime: d.completedTime || '',
      incompleteReason: d.incompleteReason || '', unreachableReason: d.unreachableReason || '',
      notes: d.notes || '', _raw: null,
    };
    await savePatient(patient);
    res.status(201).json(patient);
  } catch (err) {
    console.error('[POST ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM patients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/webhook/test', async (req, res) => {
  try {
    const patient = buildPatient({
      first_name: 'Rufus Lee', last_name: 'Darby',
      date_of_birth: '1944-08-22', phone: '+16174420507',
      email: 'test@beyondmobilehealth.com',
      address: '20 Copeland St apt 1, Roxbury, Boston MA 02119',
      mrn: '2229356',
    });
    patient.source = 'test';
    await savePatient(patient);
    res.json({ message: 'Test patient injected', patient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('BMH Tracker running on port ' + PORT);
    console.log('Database: Supabase connected');
  });
}).catch(err => {
  console.error('[DB INIT ERROR]', err);
  process.exit(1);
});
