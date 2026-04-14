const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || '';
console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] DATABASE_URL starts with:', DB_URL.slice(0, 40));

if (!DB_URL || !DB_URL.startsWith('postgresql')) {
  console.error('[FATAL] No valid DATABASE_URL. Server cannot start without Supabase connection.');
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('[DB] PostgreSQL pool created — connected to Supabase');

// ── Schema alignment with Supabase public.patients ────────────────────────────
// Supabase columns:  name, mrn, status, client_id, service_type, notes,
//                    created_at, updated_at, assignee, provider, dob, phone,
//                    email, order_date, appt_date, appt_time, completed_date,
//                    completed_time, incomplete_reason, unreachable_reason,
//                    source, received_at
//
// Supabase status constraint values:
//   'Order Received' | 'Appt Scheduled' | 'Completed' |
//   'Not Completed'  | 'Unable to Reach'

// ── GHL Field Map ─────────────────────────────────────────────────────────────
const GHL_FIELD_MAP = {
  firstName:   ['first_name', 'firstName', 'contact.first_name'],
  lastName:    ['last_name', 'lastName', 'contact.last_name'],
  dob:         ['date_of_birth', 'dob', 'birthdate'],
  phone:       ['phone', 'phone_number', 'contact.phone'],
  email:       ['email', 'contact.email'],
  mrn:         ['number_14fga', 'mrn', 'MRN', 'contact.mrn'],
  service_type:['test_ordered', 'service', 'lab_order', 'service_type'],
  provider:    ['ordering_provider', 'provider', 'referring_provider'],
  assignee:    ['appointment_owner', 'assigned_to', 'assignee'],
  notes:       ['notes', 'special_instructions', 'additional_information'],
  client_id:   ['client_id', 'location_id', 'contact.location_id'],
};

function extractField(payload, keys) {
  if (!payload || !keys) return '';
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '')
      return String(payload[key]);
    if (payload.customData?.[key]) return String(payload.customData[key]);
    if (payload.formData?.[key])   return String(payload.formData[key]);
    if (payload.contact?.[key])    return String(payload.contact[key]);
  }
  return '';
}

function buildPatientFromGHL(payload) {
  const firstName = extractField(payload, GHL_FIELD_MAP.firstName);
  const lastName  = extractField(payload, GHL_FIELD_MAP.lastName);
  const fullName  = (firstName + ' ' + lastName).trim() || 'Unknown Patient';
  const mrn       = extractField(payload, GHL_FIELD_MAP.mrn);
  const notes     = extractField(payload, GHL_FIELD_MAP.notes);
  const notesWithMrn = mrn ? ('MRN: ' + mrn + (notes ? ' | ' + notes : '')) : notes;
  const now = new Date().toISOString();

  return {
    id:                 crypto.randomUUID(),
    name:               fullName,
    mrn:                mrn || null,
    status:             'Order Received',          // matches Supabase constraint
    service_type:       extractField(payload, GHL_FIELD_MAP.service_type) || null,
    provider:           extractField(payload, GHL_FIELD_MAP.provider) || null,
    dob:                extractField(payload, GHL_FIELD_MAP.dob) || null,
    phone:              extractField(payload, GHL_FIELD_MAP.phone) || null,
    email:              extractField(payload, GHL_FIELD_MAP.email) || null,
    assignee:           extractField(payload, GHL_FIELD_MAP.assignee) || null,
    client_id:          extractField(payload, GHL_FIELD_MAP.client_id) || null,
    notes:              notesWithMrn || null,
    source:             'ghl_webhook',
    order_date:         now.slice(0, 10),
    received_at:        now,
    appt_date:          null,
    appt_time:          null,
    completed_date:     null,
    completed_time:     null,
    incomplete_reason:  null,
    unreachable_reason: null,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getAllPatients() {
  const r = await pool.query(
    'SELECT * FROM public.patients ORDER BY received_at DESC NULLS LAST'
  );
  return r.rows;
}

async function insertPatient(p) {
  await pool.query(`
    INSERT INTO public.patients (
      id, name, mrn, status, service_type, provider, dob, phone, email,
      assignee, client_id, notes, source, order_date, received_at,
      appt_date, appt_time, completed_date, completed_time,
      incomplete_reason, unreachable_reason
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21
    )
    ON CONFLICT (id) DO NOTHING
  `, [
    p.id, p.name, p.mrn, p.status, p.service_type, p.provider,
    p.dob, p.phone, p.email, p.assignee, p.client_id, p.notes,
    p.source, p.order_date, p.received_at,
    p.appt_date, p.appt_time, p.completed_date, p.completed_time,
    p.incomplete_reason, p.unreachable_reason
  ]);
}

async function updatePatient(id, d) {
  // Map camelCase from old HTML calls → snake_case Supabase columns
  // Also accept snake_case directly from new HTML
  const status             = d.status             || d.status             || null;
  const appt_date          = d.appt_date          || d.apptDate           || null;
  const appt_time          = d.appt_time          || d.apptTime           || null;
  const completed_date     = d.completed_date     || d.completedDate      || null;
  const completed_time     = d.completed_time     || d.completedTime      || null;
  const incomplete_reason  = d.incomplete_reason  || d.incompleteReason   || null;
  const unreachable_reason = d.unreachable_reason || d.unreachableReason  || null;
  const notes              = d.notes              || null;
  const assignee           = d.assignee           || null;
  const provider           = d.provider           || null;

  await pool.query(`
    UPDATE public.patients SET
      status             = COALESCE($1,  status),
      appt_date          = COALESCE($2,  appt_date),
      appt_time          = COALESCE($3,  appt_time),
      completed_date     = COALESCE($4,  completed_date),
      completed_time     = COALESCE($5,  completed_time),
      incomplete_reason  = COALESCE($6,  incomplete_reason),
      unreachable_reason = COALESCE($7,  unreachable_reason),
      notes              = COALESCE($8,  notes),
      assignee           = COALESCE($9,  assignee),
      provider           = COALESCE($10, provider),
      updated_at         = NOW()
    WHERE id = $11
  `, [
    status, appt_date, appt_time, completed_date, completed_time,
    incomplete_reason, unreachable_reason, notes, assignee, provider, id
  ]);

  const r = await pool.query('SELECT * FROM public.patients WHERE id = $1', [id]);
  return r.rows.length ? r.rows[0] : null;
}

async function removePatient(id) {
  await pool.query('DELETE FROM public.patients WHERE id = $1', [id]);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GHL Webhook — receives form submissions from GoHighLevel
app.post('/webhook/ghl', async (req, res) => {
  try {
    console.log('[WEBHOOK] Incoming GHL payload:', JSON.stringify(req.body).slice(0, 300));
    const patient = buildPatientFromGHL(req.body);
    await insertPatient(patient);
    console.log('[WEBHOOK] Patient saved to Supabase:', patient.name, '| MRN:', patient.mrn);
    res.status(200).json({ success: true, patientId: patient.id, name: patient.name });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all patients
app.get('/api/patients', async (req, res) => {
  try {
    const patients = await getAllPatients();
    res.json(patients);
  } catch (err) {
    console.error('[GET PATIENTS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update patient
app.patch('/api/patients/:id', async (req, res) => {
  try {
    const p = await updatePatient(req.params.id, req.body);
    res.json(p || { error: 'Not found' });
  } catch (err) {
    console.error('[PATCH PATIENT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add patient manually
app.post('/api/patients', async (req, res) => {
  try {
    const d = req.body;
    const patient = {
      id:                 d.id || crypto.randomUUID(),
      name:               d.name || 'Unknown',
      mrn:                d.mrn || null,
      status:             d.status || 'Order Received',
      service_type:       d.service_type || d.service || null,
      provider:           d.provider || null,
      dob:                d.dob || null,
      phone:              d.phone || null,
      email:              d.email || null,
      assignee:           d.assignee || null,
      client_id:          d.client_id || null,
      notes:              d.notes || null,
      source:             d.source || 'manual',
      order_date:         d.order_date || d.orderDate || new Date().toISOString().slice(0, 10),
      received_at:        d.received_at || d.receivedAt || new Date().toISOString(),
      appt_date:          d.appt_date || null,
      appt_time:          d.appt_time || null,
      completed_date:     d.completed_date || null,
      completed_time:     d.completed_time || null,
      incomplete_reason:  d.incomplete_reason || null,
      unreachable_reason: d.unreachable_reason || null,
    };
    await insertPatient(patient);
    res.status(201).json(patient);
  } catch (err) {
    console.error('[POST PATIENT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete patient
app.delete('/api/patients/:id', async (req, res) => {
  try {
    await removePatient(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE PATIENT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test webhook injection
app.get('/webhook/test', async (req, res) => {
  try {
    const patient = buildPatientFromGHL({
      first_name: 'Test', last_name: 'Patient',
      date_of_birth: '1980-01-15',
      phone: '617-555-0001',
      email: 'test@beyondmobilehealth.com',
      number_14fga: 'TEST-MRN-001',
      test_ordered: 'CBC',
      ordering_provider: 'Dr. Test',
    });
    patient.source = 'test_inject';
    await insertPatient(patient);
    console.log('[TEST] Test patient injected:', patient.name);
    res.json({ success: true, message: 'Test patient injected into Supabase', patient });
  } catch (err) {
    console.error('[TEST ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT count(*) FROM public.patients');
    res.json({
      status: 'ok',
      storage: 'supabase_postgresql',
      patient_count: parseInt(r.rows[0].count),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Serve HTML for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Verify Supabase connection on startup
    const r = await pool.query('SELECT count(*) FROM public.patients');
    console.log('[DB] Supabase connection verified —', r.rows[0].count, 'patients in DB');
  } catch (err) {
    console.error('[DB STARTUP ERROR]', err.message);
    console.error('[FATAL] Cannot connect to Supabase. Check DATABASE_URL.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  BMH Patient Tracker — Server Running');
    console.log('  Port:', PORT);
    console.log('  Storage: Supabase PostgreSQL (persistent)');
    console.log('  Webhook: POST /webhook/ghl');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

start();  console.log('[DB] No valid DATABASE_URL — using in-memory storage');


async function initDB() {
  if (!useDB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      source TEXT DEFAULT 'manual',
      received_at TIMESTAMPTZ DEFAULT NOW(),
      name TEXT NOT NULL,
      dob TEXT, provider TEXT, service TEXT,
      phone TEXT, email TEXT, address TEXT, assignee TEXT,
      order_date TEXT, status TEXT DEFAULT 'received',
      appt_date TEXT, appt_time TEXT,
      completed_date TEXT, completed_time TEXT,
      incomplete_reason TEXT, unreachable_reason TEXT,
      notes TEXT, raw JSONB
    )
  `);
  console.log('[DB] patients table ready');
}

function rowToPatient(r) {
  return {
    id: r.id, source: r.source, receivedAt: r.received_at,
    name: r.name, dob: r.dob||'', provider: r.provider||'',
    service: r.service||'', phone: r.phone||'', email: r.email||'',
    address: r.address||'', assignee: r.assignee||'',
    orderDate: r.order_date||'', status: r.status||'received',
    apptDate: r.appt_date||'', apptTime: r.appt_time||'',
    completedDate: r.completed_date||'', completedTime: r.completed_time||'',
    incompleteReason: r.incomplete_reason||'',
    unreachableReason: r.unreachable_reason||'',
    notes: r.notes||'', _raw: r.raw,
  };
}

async function getAllPatients() {
  if (useDB) {
    const r = await pool.query('SELECT * FROM patients ORDER BY received_at DESC');
    return r.rows.map(rowToPatient);
  }
  return memPatients;
}

async function insertPatient(p) {
  if (useDB) {
    await pool.query(`
      INSERT INTO patients (id,source,received_at,name,dob,provider,service,phone,email,address,assignee,order_date,status,appt_date,appt_time,completed_date,completed_time,incomplete_reason,unreachable_reason,notes,raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (id) DO NOTHING
    `, [p.id,p.source,p.receivedAt,p.name,p.dob,p.provider,p.service,p.phone,p.email,p.address||'',p.assignee||'',p.orderDate,p.status,p.apptDate,p.apptTime,p.completedDate,p.completedTime,p.incompleteReason,p.unreachableReason,p.notes,p._raw?JSON.stringify(p._raw):null]);
  } else {
    memPatients.unshift(p);
  }
}

async function updatePatient(id, d) {
  if (useDB) {
    await pool.query(`
      UPDATE patients SET
        status=COALESCE($1,status), appt_date=COALESCE($2,appt_date),
        appt_time=COALESCE($3,appt_time), completed_date=COALESCE($4,completed_date),
        completed_time=COALESCE($5,completed_time), incomplete_reason=COALESCE($6,incomplete_reason),
        unreachable_reason=COALESCE($7,unreachable_reason), notes=COALESCE($8,notes),
        assignee=COALESCE($9,assignee), provider=COALESCE($10,provider)
      WHERE id=$11
    `, [d.status,d.apptDate,d.apptTime,d.completedDate,d.completedTime,d.incompleteReason,d.unreachableReason,d.notes,d.assignee,d.provider,id]);
    const r = await pool.query('SELECT * FROM patients WHERE id=$1', [id]);
    return r.rows.length ? rowToPatient(r.rows[0]) : null;
  } else {
    const i = memPatients.findIndex(p => p.id === id);
    if (i > -1) { memPatients[i] = {...memPatients[i], ...d}; return memPatients[i]; }
    return null;
  }
}

async function removePatient(id) {
  if (useDB) {
    await pool.query('DELETE FROM patients WHERE id=$1', [id]);
  } else {
    memPatients = memPatients.filter(p => p.id !== id);
  }
}

// ── GHL Field Map ─────────────────────────────────────────────────────────────
const GHL_FIELD_MAP = {
  firstName: ['first_name','firstName'],
  lastName:  ['last_name','lastName'],
  dob:       ['date_of_birth','dob','birthdate'],
  phone:     ['phone','phone_number','contact.phone'],
  email:     ['email','contact.email'],
  address:   ['address','contact.address1'],
  mrn:       ['number_14fga', 'mrn', 'MRN'],
  service:   ['test_ordered','service','lab_order'],
  provider:  ['ordering_provider','provider'],
  assignee:  ['appointment_owner','assigned_to','assignee'],
  notes:     ['notes','special_instructions','additional_information'],
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
    id: crypto.randomUUID(), source: 'ghl_webhook', receivedAt: now.toISOString(),
    name: fullName, dob: extractField(payload, GHL_FIELD_MAP.dob),
    provider: extractField(payload, GHL_FIELD_MAP.provider),
    service: extractField(payload, GHL_FIELD_MAP.service),
    phone: extractField(payload, GHL_FIELD_MAP.phone),
    email: extractField(payload, GHL_FIELD_MAP.email),
    address: extractField(payload, GHL_FIELD_MAP.address),
    assignee: extractField(payload, GHL_FIELD_MAP.assignee),
    orderDate: now.toISOString().slice(0, 10),
    status: 'received', apptDate: '', apptTime: '',
    completedDate: '', completedTime: '',
    incompleteReason: '', unreachableReason: '',
    notes: notesWithMrn, _raw: payload,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/webhook/ghl', async (req, res) => {
  try {
    const patient = buildPatient(req.body);
    await insertPatient(patient);
    console.log('[WEBHOOK] Patient added:', patient.name);
    res.status(200).json({ success: true, patientId: patient.id, patient });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients', async (req, res) => {
  try { res.json(await getAllPatients()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/patients/:id', async (req, res) => {
  try {
    const p = await updatePatient(req.params.id, req.body);
    res.json(p || { error: 'Not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patients', async (req, res) => {
  try {
    const d = req.body;
    const patient = {
      id: d.id || crypto.randomUUID(), source: d.source || 'manual',
      receivedAt: d.receivedAt || new Date().toISOString(),
      name: d.name || 'Unknown', dob: d.dob||'', provider: d.provider||'',
      service: d.service||'', phone: d.phone||'', email: d.email||'',
      address: d.address||'', assignee: d.assignee||'',
      orderDate: d.orderDate || new Date().toISOString().slice(0, 10),
      status: d.status || 'received',
      apptDate: d.apptDate||'', apptTime: d.apptTime||'',
      completedDate: d.completedDate||'', completedTime: d.completedTime||'',
      incompleteReason: d.incompleteReason||'', unreachableReason: d.unreachableReason||'',
      notes: d.notes||'', _raw: null,
    };
    await insertPatient(patient);
    res.status(201).json(patient);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/patients/:id', async (req, res) => {
  try { await removePatient(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
    await insertPatient(patient);
    res.json({ message: 'Test patient injected', storage: useDB ? 'supabase' : 'memory', patient });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: useDB ? 'supabase' : 'memory', dbUrl: !!DB_URL });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('[DB INIT ERROR]', err.message);
    console.log('[DB] Falling back to in-memory storage');
    useDB = false;
  }
  app.listen(PORT, () => {
    console.log('BMH Tracker running on port ' + PORT);
    console.log('Storage mode:', useDB ? 'Supabase PostgreSQL' : 'In-memory (data will reset on restart)');
  });
}

start();
