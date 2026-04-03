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

let patients = [];

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
  notes:     ['notes', 'special_instructions'],
};

function extractField(payload, keys) {
  if (!payload || !keys) return '';
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      return String(payload[key]);
    }
    if (payload.customData && payload.customData[key]) return String(payload.customData[key]);
    if (payload.formData && payload.formData[key]) return String(payload.formData[key]);
    if (payload.contact && payload.contact[key]) return String(payload.contact[key]);
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
    orderDate: now.toISOString().slice(0, 10),
    status: 'received',
    apptDate: '',
    apptTime: '',
    completedDate: '',
    completedTime: '',
    incompleteReason: '',
    unreachableReason: '',
    notes: notesWithMrn,
    _raw: payload,
  };
}

app.post('/webhook/ghl', (req, res) => {
  try {
    const payload = req.body;
    console.log('[WEBHOOK] Received:', JSON.stringify(payload, null, 2));
    const patient = buildPatient(payload);
    patients.unshift(patient);
    console.log('[TRACKER] Added:', patient.name, patient.id);
    return res.status(200).json({ success: true, patientId: patient.id, patient });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

app.get('/api/patients', (req, res) => {
  res.json(patients);
});

app.patch('/api/patients/:id', (req, res) => {
  const idx = patients.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Patient not found' });
  patients[idx] = { ...patients[idx], ...req.body, id: patients[idx].id };
  res.json(patients[idx]);
});

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

app.delete('/api/patients/:id', (req, res) => {
  const before = patients.length;
  patients = patients.filter(p => p.id !== req.params.id);
  if (patients.length === before) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.get('/webhook/test', (req, res) => {
  const patient = buildPatient({
    first_name: 'Rufus Lee',
    last_name: 'Darby',
    date_of_birth: '1944-08-22',
    phone: '+16174420507',
    email: 'test@beyondmobilehealth.com',
    address: '20 Copeland St apt 1, Roxbury, Boston MA 02119',
    mrn: '2229356',
  });
  patient.source = 'test';
  patients.unshift(patient);
  res.json({ message: 'Test patient injected', patient });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('BMH Tracker running on port ' + PORT);
});
