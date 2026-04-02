/**
 * BMH Patient Journey Tracker — Webhook Server
 * Receives GHL form submission webhooks and serves the tracker UI
 *
 * Deploy to: Railway, Render, or any Node host
 * Port: 3000 (or process.env.PORT)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' })); // lock down to GHL domain in production
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store (swap for Postgres/Supabase/MongoDB in prod) ─────────────
let patients = [];

// ─── GHL Field Map ────────────────────────────────────────────────────────────
// Map your GHL form field names to the tracker's data model.
// Update these keys to match the "Field Key" values in your GHL form builder.
const GHL_FIELD_MAP = {
  name:         ['full_name', 'name', 'contact.name', 'first_name'],
  dob:          ['date_of_birth', 'dob', 'birthdate'],
  provider:     ['ordering_provider', 'provider', 'doctor_name', 'referring_provider'],
  service:      ['test_ordered', 'service', 'lab_order', 'tests_requested'],
  phone:        ['phone', 'contact.phone', 'phone_number'],
  email:        ['email', 'contact.email'],
  address:      ['address', 'contact.address1'],
  notes:        ['notes', 'special_instructions', 'intake_notes'],
};

function extractField(payload, keys) {
  for (const key of keys) {
    // Direct key match
    if (payload[key] !== undefined && payload[key] !== '') return payload[key];
    // Nested dot-notation (e.g. contact.name)
    const parts = key.split('.');
    if (parts.length > 1) {
      let val = payload;
      for (const p of parts) { val = val?.[p]; }
      if (val !== undefined && val !== '') return val;
    }
    // GHL sometimes wraps fields in customData or formData
    if (payload.customData?.[key]) return payload.customData[key];
    if (payload.formData?.[key]) return payload.formData[key];
  }
  return '';
}

function buildPatient(payload) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    source: 'ghl_webhook',
    receivedAt: now.toISOString(),
    // Core fields
    name:         extractField(payload, GHL_FIELD_MAP.name) || 'Unknown Patient',
    dob:          extractField(payload, GHL_FIELD_MAP.dob),
    provider:     extractField(payload, GHL_FIELD_MAP.provider),
    service:      extractField(payload, GHL_FIELD_MAP.service),
    phone:        extractField(payload, GHL_FIELD_MAP.phone),
    email:        extractField(payload, GHL_FIELD_MAP.email),
    address:      extractField(payload, GHL_FIELD_MAP.address),
    orderDate:    now.toISOString().slice(0, 10),
    // Journey state
    status:       'received',
    apptDate:     '',
    apptTime:     '',
    completedDate: '',
    completedTime: '',
    incompleteReason: '',
    unreachableReason: '',
    notes:        extractField(payload, GHL_FIELD_MAP.notes),
    // Raw payload stored for debugging
    _raw: payload,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /webhook/ghl
 * GHL sends form submission data here.
 * In GHL: Workflow → Action → Webhook → URL = https://YOUR_DOMAIN/webhook/ghl
 */
app.post('/webhook/ghl', (req, res) => {
  try {
    const payload = req.body;

    // Optional: verify a shared secret header from GHL
    // const secret = req.headers['x-ghl-secret'];
    // if (secret !== process.env.GHL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    console.log('[WEBHOOK] Received from GHL:', JSON.stringify(payload, null, 2));

    const patient = buildPatient(payload);
    patients.unshift(patient); // newest first

    console.log(`[TRACKER] New patient added: ${patient.name} (${patient.id})`);

    return res.status(200).json({ success: true, patientId: patient.id, patient });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/patients
 * Returns all patients. Tracker UI polls this every 30s.
 */
app.get('/api/patients', (req, res) => {
  res.json(patients);
});

/**
 * PATCH /api/patients/:id
 * Update a patient's journey status from the tracker UI.
 */
app.patch('/api/patients/:id', (req, res) => {
  const idx = patients.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Patient not found' });
  patients[idx] = { ...patients[idx], ...req.body, id: patients[idx].id };
  res.json(patients[idx]);
});

/**
 * POST /api/patients
 * Manual add (fallback if no webhook fired)
 */
app.post('/api/patients', (req, res) => {
  const patient = {
    id: crypto.randomUUID(),
    source: 'manual',
    receivedAt: new Date().toISOString(),
    orderDate: new Date().toISOString().slice(0, 10),
    status: 'received',
    apptDate: '', apptTime: '',
    completedDate: '', completedTime: '',
    incompleteReason: '', unreachableReason: '',
    ...req.body,
  };
  patients.unshift(patient);
  res.status(201).json(patient);
});

/**
 * DELETE /api/patients/:id
 */
app.delete('/api/patients/:id', (req, res) => {
  const before = patients.length;
  patients = patients.filter(p => p.id !== req.params.id);
  if (patients.length === before) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

/**
 * GET /webhook/test
 * Hit this in browser to simulate a GHL form submission for testing.
 */
app.get('/webhook/test', (req, res) => {
  const testPayload = {
    full_name: 'Test Patient',
    date_of_birth: '1985-06-15',
    ordering_provider: 'Dr. Demo / BMH Test Clinic',
    test_ordered: 'CBC, CMP, HbA1c',
    phone: '555-000-1234',
    email: 'test@beyondmobilehealth.com',
    notes: 'Fasting required. Patient prefers morning visits.',
  };
  const patient = buildPatient(testPayload);
  patient.source = 'test';
  patients.unshift(patient);
  res.json({ message: 'Test patient injected', patient });
});

// ─── Serve tracker UI for all other routes (SPA fallback) ────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ BMH Tracker server running on port ${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook/ghl`);
  console.log(`   Tracker UI:  http://localhost:${PORT}`);
  console.log(`   Test inject: http://localhost:${PORT}/webhook/test\n`);
});
