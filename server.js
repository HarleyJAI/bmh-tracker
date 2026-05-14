/**
 * BMH Patient Journey Tracker - Server
 * Beyond Mobile Health | beyondmobilehealth.com
 * Stack:  Node.js / Express / PostgreSQL (Supabase via pg Pool)
 * Deploy: Railway (via GitHub auto-deploy)
 *
 * FIXES APPLIED (2026):
 *   1. PATCH route — camelCase → snake_case field mapping so updates land correctly
 *   2. POST /api/patients — normalized to snake_case before calling insertPatient()
 *   3. console.error logging added to every mutating route catch block
 *   4. GET /api/patients — configurable limit via ?limit= query param (default 500, max 5000)
 *   5. Session cookie set secure: true for HTTPS on Railway
 */

var express = require('express');
var cors    = require('cors');
var crypto  = require('crypto');
var path    = require('path');
var session = require('express-session');
var pg      = require('pg');
var Pool    = pg.Pool;

var app  = express();
var PORT = process.env.PORT || 3000;

var DB_URL         = process.env.DATABASE_URL || '';
var SESSION_SECRET = process.env.SESSION_SECRET || 'bmh-session-secret-2026';
var BASE_URL       = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';

console.log('[ENV] DATABASE_URL present:', !!DB_URL);

var useDB = false;
var pool  = null;
var memPatients = [];

if (DB_URL) {
  pool  = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  useDB = true;
  console.log('[DB] Pool initialized');
} else {
  console.log('[DB] No DATABASE_URL - using in-memory store');
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // FIX #5: secure: true enforces HTTPS cookie on Railway (HIPAA-relevant)
  cookie: { secure: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// ---------------------------------------------------------------------------
// FIX #1: camelCase → snake_case field map for PATCH and POST routes
// ---------------------------------------------------------------------------
var FIELD_MAP = {
  apptDate:          'appt_date',
  apptTime:          'appt_time',
  completedDate:     'completed_date',
  completedTime:     'completed_time',
  incompleteReason:  'incomplete_reason',
  unreachableReason: 'unreachable_reason',
  orderDate:         'order_date',
  receivedAt:        'received_at',
  rawStatus:         'raw_status',
  testType:          'test_type',
  requestedDate:     'requested_date',
  zipCode:           'zip_code',
  firstName:         'first_name',
  lastName:          'last_name'
};

function toSnakeCase(obj) {
  var result = {};
  Object.keys(obj).forEach(function(k) {
    var dbKey = FIELD_MAP[k] || k;
    result[dbKey] = obj[k];
  });
  return result;
}

// ---------------------------------------------------------------------------

function extractField(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function normalizeStatus(status) {
  if (!status) return 'received';
  var v = String(status).trim().toLowerCase();
  if (v === 'showed')       return 'completed';
  if (v === 'no_show')      return 'not_completed';
  if (v === 'no show')      return 'not_completed';
  if (v === 'confirmed')    return 'scheduled';
  if (v === 'unconfirmed')  return 'received';
  if (v === 'cancelled')    return 'not_completed';
  if (v === 'invalid')      return 'not_completed';
  if (v.indexOf('complet')  !== -1) return 'completed';
  if (v.indexOf('schedule') !== -1) return 'scheduled';
  if (v.indexOf('reach')    !== -1) return 'unable_to_reach';
  return 'received';
}

function buildPatient(payload) {
  var rawStatus = extractField(payload, ['status', 'Status', 'SCHEDULING STATUS', 'appointments status', 'appointment_status']) || 'received';
  var firstName = extractField(payload, ['first_name', 'First Name', 'firstName']) || '';
  var lastName  = extractField(payload, ['last_name',  'Last Name',  'lastName'])  || '';
  var fullName  = extractField(payload, ['full_name',  'Full Name',  'name', 'Name']) || (firstName + ' ' + lastName).trim();

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

function insertPatient(p) {
  var sql = 'INSERT INTO patients (' +
    'id, source, received_at, name, first_name, last_name, ' +
    'dob, provider, service, phone, email, address, ' +
    'assignee, order_date, status, appt_date, appt_time, ' +
    'completed_date, completed_time, incomplete_reason, unreachable_reason, ' +
    'notes, raw, mrn, zip_code, test_type, requested_date, ' +
    'phlebotomist, raw_status, payload' +
    ') VALUES (' +
    '$1,$2,$3,$4,$5,$6,' +
    '$7,$8,$9,$10,$11,$12,' +
    '$13,$14,$15,$16,$17,' +
    '$18,$19,$20,$21,' +
    '$22,$23,$24,$25,$26,$27,' +
    '$28,$29,$30' +
    ')';

  var vals = [
    p.id, p.source, p.received_at, p.name, p.first_name, p.last_name,
    p.dob, p.provider, p.service, p.phone, p.email, p.address,
    p.assignee, p.order_date, p.status, p.appt_date, p.appt_time,
    p.completed_date, p.completed_time, p.incomplete_reason, p.unreachable_reason,
    p.notes, JSON.stringify(p.raw), p.mrn, p.zip_code, p.test_type, p.requested_date,
    p.phlebotomist, p.raw_status, JSON.stringify(p.payload)
  ];

  return pool.query(sql, vals);
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

app.get('/health', function(req, res) {
  res.json({
    app: 'BMH Tracker',
    status: 'running',
    database: useDB ? 'enabled' : 'memory',
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook/ghl', function(req, res) {
  var payload = req.body || {};
  console.log('[WEBHOOK/GHL] Received:', JSON.stringify(payload));
  var patient = buildPatient(payload);
  if (useDB && pool) {
    insertPatient(patient).then(function() {
      console.log('[DB] Patient inserted:', patient.id);
      res.status(200).json({ success: true, patientId: patient.id });
    }).catch(function(err) {
      // FIX #3: log insert errors
      console.error('[WEBHOOK/GHL ERROR] Insert failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.status(200).json({ success: true, patientId: patient.id });
  }
});

app.post('/webhook', function(req, res) {
  var payload = req.body || {};
  var patient = buildPatient(payload);
  if (useDB && pool) {
    insertPatient(patient).then(function() {
      res.status(200).json({ success: true, patientId: patient.id });
    }).catch(function(err) {
      // FIX #3: log insert errors
      console.error('[WEBHOOK ERROR] Insert failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.status(200).json({ success: true, patientId: patient.id });
  }
});

// FIX #4: configurable limit via ?limit= query param (default 500, max 5000)
app.get('/api/patients', function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);

  if (useDB && pool) {
    pool.query('SELECT * FROM patients ORDER BY received_at DESC LIMIT $1', [limit]).then(function(result) {
      res.json(result.rows);
    }).catch(function(err) {
      // FIX #3: log read errors
      console.error('[GET /api/patients ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    res.json(memPatients.slice(0, limit));
  }
});

// FIX #2: normalize incoming body to snake_case before calling insertPatient()
app.post('/api/patients', function(req, res) {
  var d = toSnakeCase(req.body || {});

  var patient = {
    id:                 d.id || crypto.randomUUID(),
    source:             'manual',
    received_at:        d.received_at || new Date().toISOString(),
    name:               d.name || 'Unknown',
    first_name:         d.first_name || '',
    last_name:          d.last_name  || '',
    dob:                d.dob || '',
    provider:           d.provider || '',
    service:            d.service || '',
    phone:              d.phone || '',
    email:              d.email || '',
    address:            d.address || '',
    assignee:           d.assignee || '',
    order_date:         d.order_date || new Date().toISOString().slice(0, 10),
    status:             d.status || 'received',
    appt_date:          d.appt_date || '',
    appt_time:          d.appt_time || '',
    completed_date:     d.completed_date || '',
    completed_time:     d.completed_time || '',
    incomplete_reason:  d.incomplete_reason || '',
    unreachable_reason: d.unreachable_reason || '',
    notes:              d.notes || '',
    raw:                {},
    mrn:                d.mrn || '',
    zip_code:           d.zip_code || '',
    test_type:          d.test_type || '',
    requested_date:     d.requested_date || '',
    phlebotomist:       d.phlebotomist || '',
    raw_status:         d.raw_status || d.status || 'received',
    payload:            {}
  };

  if (useDB && pool) {
    insertPatient(patient).then(function() {
      res.status(201).json(patient);
    }).catch(function(err) {
      // FIX #3: log manual insert errors
      console.error('[POST /api/patients ERROR] Insert failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.status(201).json(patient);
  }
});

// FIX #1: map camelCase keys from frontend to snake_case DB columns before UPDATE
app.patch('/api/patients/:id', function(req, res) {
  var id = req.params.id;

  // Strip id from updates, then normalize keys
  var rawUpdates = Object.assign({}, req.body);
  delete rawUpdates.id;
  var updates = toSnakeCase(rawUpdates);

  if (useDB && pool) {
    var keys   = Object.keys(updates);
    var values = Object.values(updates);

    if (keys.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    var fields = keys.map(function(k, i) { return '"' + k + '" = $' + (i + 2); }).join(', ');

    pool.query(
      'UPDATE patients SET ' + fields + ' WHERE id = $1 RETURNING *',
      [id].concat(values)
    ).then(function(result) {
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      res.json(result.rows[0]);
    }).catch(function(err) {
      // FIX #3: log patch errors with full detail
      console.error('[PATCH /api/patients/' + id + ' ERROR]', err.message, '| Fields attempted:', keys.join(', '));
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    var idx = memPatients.findIndex(function(p) { return p.id === id; });
    if (idx === -1) return res.status(404).json({ success: false, error: 'Patient not found' });
    memPatients[idx] = Object.assign({}, memPatients[idx], updates);
    res.json(memPatients[idx]);
  }
});

app.delete('/api/patients/:id', function(req, res) {
  var id = req.params.id;
  if (useDB && pool) {
    pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]).then(function(result) {
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Patient not found' });
      }
      res.json({ success: true, deleted: id });
    }).catch(function(err) {
      // FIX #3: log delete errors
      console.error('[DELETE /api/patients/' + id + ' ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    var before = memPatients.length;
    memPatients = memPatients.filter(function(p) { return p.id !== id; });
    if (memPatients.length === before) {
      return res.status(404).json({ success: false, error: 'Patient not found' });
    }
    res.json({ success: true, deleted: id });
  }
});

app.get('/webhook/test', function(req, res) {
  var testPayload = {
    full_name:  'Test Patient',
    first_name: 'Test',
    last_name:  'Patient',
    dob:        '1985-06-15',
    provider:   'Dr. Demo / BMH Test Clinic',
    test_type:  'CBC, CMP, HbA1c',
    phone:      '555-000-1234',
    email:      'test@beyondmobilehealth.com',
    notes:      'Fasting required. Patient prefers morning visits.',
    source:     'test',
    status:     'confirmed'
  };
  var patient = buildPatient(testPayload);
  if (useDB && pool) {
    insertPatient(patient).then(function() {
      res.json({ message: 'Test patient injected', patient: patient });
    }).catch(function(err) {
      console.error('[WEBHOOK/TEST ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.json({ message: 'Test patient injected', patient: patient });
  }
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  console.log('\n BMH Tracker running on port ' + PORT);
  console.log('   UI:      ' + BASE_URL);
  console.log('   Health:  ' + BASE_URL + '/health');
  console.log('   Webhook: ' + BASE_URL + '/webhook/ghl');
  console.log('   Test:    ' + BASE_URL + '/webhook/test\n');
});
