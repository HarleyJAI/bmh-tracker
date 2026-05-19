/**
 * BMH Patient Journey Tracker - Server
 * Beyond Mobile Health | beyondmobilehealth.com
 * Stack:  Node.js / Express / PostgreSQL (Supabase via pg Pool)
 * Deploy: Railway (via GitHub auto-deploy)
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
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
var AZURE_TENANT_ID   = process.env.AZURE_TENANT_ID || '';
var AZURE_CLIENT_ID   = process.env.AZURE_CLIENT_ID || '';
var AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
var BASE_URL       = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
var REDIRECT_URI   = BASE_URL + '/auth/callback';

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] AZURE configured:', !!AZURE_TENANT_ID && !!AZURE_CLIENT_ID);

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
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.redirect('/login');
}

function requireAuth(req, res, next) {
  if (req.session && (req.session.role === 'admin' || req.session.role === 'client')) return next();
  res.redirect('/login');
}

// ---------------------------------------------------------------------------
// Field mapping
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
  if (v === 'showed')                           return 'completed';
  if (v === 'no_show' || v === 'no show')       return 'incomplete';
  if (v === 'confirmed')                        return 'scheduled';
  if (v === 'unconfirmed')                      return 'received';
  if (v === 'cancelled' || v === 'invalid')     return 'incomplete';
  if (v === 'completed')                        return 'completed';
  if (v === 'not completed')                    return 'incomplete';
  if (v === 'unable to reach')                  return 'unreachable';
  if (v === 'appt scheduled')                   return 'scheduled';
  if (v === 'order received')                   return 'received';
  if (v.indexOf('complet')  !== -1)             return 'completed';
  if (v.indexOf('schedule') !== -1)             return 'scheduled';
  if (v.indexOf('reach')    !== -1)             return 'unreachable';
  return 'received';
}

// Status rank — higher = further along in journey
var STATUS_RANK = { received: 1, scheduled: 2, incomplete: 2, unreachable: 2, completed: 3 };

function buildPatient(payload) {
  var rawStatus = extractField(payload, ['status', 'Status', 'SCHEDULING STATUS', 'appointmentStatus', 'appointment_status']) || 'received';
  var firstName = extractField(payload, ['first_name', 'First Name', 'firstName']) || '';
  var lastName  = extractField(payload, ['last_name',  'Last Name',  'lastName'])  || '';
  var fullName  = extractField(payload, ['full_name',  'Full Name',  'name', 'Name']) || (firstName + ' ' + lastName).trim() || 'Unknown';
  var mrn       = extractField(payload, ['mrn', 'MRN', 'number_14fga', 'mrn_bmc']) || '';
  var notes     = extractField(payload, ['notes', 'Notes', 'special_instructions']) || '';
  if (mrn && notes.indexOf('MRN:') === -1) {
    notes = 'MRN: ' + mrn + (notes ? ' | ' + notes : '');
  }

  return {
    id:                 crypto.randomUUID(),
    source:             'ghl_webhook',
    received_at:        new Date().toISOString(),
    name:               fullName,
    first_name:         firstName,
    last_name:          lastName,
    dob:                extractField(payload, ['dob', 'date_of_birth', 'DOB']) || '',
    provider:           extractField(payload, ['provider', 'ordering_provider', 'Provider']) || '',
    service:            extractField(payload, ['service', 'test_type', 'Test Type']) || '',
    phone:              extractField(payload, ['phone', 'Phone']) || '',
    email:              extractField(payload, ['email', 'Email']) || '',
    address:            extractField(payload, ['address', 'Address']) || '',
    assignee:           extractField(payload, ['phlebotomist', 'Phlebotomist', 'assignee', 'appointment_owner']) || '',
    order_date:         new Date().toISOString().slice(0, 10),
    status:             normalizeStatus(rawStatus),
    appt_date:          '',
    appt_time:          '',
    completed_date:     '',
    completed_time:     '',
    incomplete_reason:  '',
    unreachable_reason: '',
    notes:              notes,
    raw:                payload,
    mrn:                mrn,
    first_name:         firstName,
    last_name:          lastName
  };
}

function insertPatient(p) {
  var sql = 'INSERT INTO patients (' +
    'id, source, received_at, name, first_name, last_name, ' +
    'dob, provider, service, phone, email, address, ' +
    'assignee, order_date, status, appt_date, appt_time, ' +
    'completed_date, completed_time, incomplete_reason, unreachable_reason, ' +
    'notes, raw, mrn' +
    ') VALUES (' +
    '$1,$2,$3,$4,$5,$6,' +
    '$7,$8,$9,$10,$11,$12,' +
    '$13,$14,$15,$16,$17,' +
    '$18,$19,$20,$21,' +
    '$22,$23,$24' +
    ') ON CONFLICT (id) DO NOTHING';

  return pool.query(sql, [
    p.id, p.source, p.received_at, p.name, p.first_name || '', p.last_name || '',
    p.dob, p.provider, p.service, p.phone, p.email, p.address,
    p.assignee, p.order_date, p.status, p.appt_date, p.appt_time,
    p.completed_date, p.completed_time, p.incomplete_reason, p.unreachable_reason,
    p.notes, JSON.stringify(p.raw || {}), p.mrn || ''
  ]);
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------
var LOGIN_PAGE = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BMH Patient Tracker</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}.mark{width:56px;height:56px;background:#00c5a1;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px}h1{font-size:22px;font-weight:700;color:#0a1628;margin-bottom:6px}p{font-size:14px;color:#8896ab;margin-bottom:32px}.ms{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:13px 20px;background:#0078d4;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;margin-bottom:20px;font-family:inherit}.ms:hover{background:#106ebe}.div{display:flex;align-items:center;gap:12px;margin:16px 0;color:#8896ab;font-size:12px}.div::before,.div::after{content:"";flex:1;height:1px;background:#e4eaf2}input{width:100%;padding:11px 14px;border:1px solid #e4eaf2;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit}input:focus{border-color:#00c5a1}.abtn{width:100%;padding:11px;background:#0a1628;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}.err{color:#e8453c;font-size:13px;margin-top:10px}</style></head><body><div class="card"><div class="mark">&#128203;</div><h1>BMH Patient Tracker</h1><p>Beyond Mobile Health</p><a class="ms" href="/auth/microsoft"><svg width="20" height="20" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>Sign in with Microsoft</a><div class="div">or admin access</div><form method="POST" action="/auth/admin"><input type="password" name="password" placeholder="Admin password" required><button class="abtn" type="submit">Admin Login</button>ERROR_PLACEHOLDER</form></div></body></html>';

app.get('/login', function(req, res) {
  if (req.session && req.session.role) return res.redirect('/');
  res.send(LOGIN_PAGE.replace('ERROR_PLACEHOLDER', req.query.error ? '<div class="err">Invalid password. Try again.</div>' : ''));
});

app.post('/auth/admin', function(req, res) {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.role = 'admin';
    req.session.user = { name: 'Admin', email: 'admin@beyondmobilehealth.com' };
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/auth/microsoft', function(req, res) {
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID) {
    return res.send('<p>Azure SSO not configured.</p>');
  }
  var params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    response_mode: 'query',
    state: crypto.randomBytes(16).toString('hex')
  });
  res.redirect('https://login.microsoftonline.com/' + AZURE_TENANT_ID + '/oauth2/v2.0/authorize?' + params);
});

app.get('/auth/callback', function(req, res) {
  var code = req.query.code;
  var error = req.query.error;
  if (error || !code) return res.redirect('/login?error=1');
  fetch('https://login.microsoftonline.com/' + AZURE_TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: AZURE_CLIENT_ID,
      client_secret: AZURE_CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  }).then(function(r) { return r.json(); }).then(function(td) {
    if (td.error) throw new Error(td.error_description);
    var payload = JSON.parse(Buffer.from(td.id_token.split('.')[1], 'base64').toString());
    req.session.role = 'client';
    req.session.user = { name: payload.name || payload.preferred_username, email: payload.email || payload.preferred_username };
    // Log access
    if (useDB && pool) {
      pool.query('INSERT INTO access_log (id,email,name,role,action,logged_in_at,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [crypto.randomUUID(), req.session.user.email, req.session.user.name, 'client', 'login', new Date().toISOString(), req.headers['x-forwarded-for'] || req.ip]
      ).catch(function(e) { console.log('[ACCESS LOG]', e.message); });
    }
    res.redirect('/');
  }).catch(function(err) {
    console.error('[AUTH]', err.message);
    res.redirect('/login?error=1');
  });
});

app.get('/auth/logout', function(req, res) {
  req.session.destroy();
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Root route — serve correct portal
// ---------------------------------------------------------------------------
app.get('/', requireAuth, function(req, res) {
  if (req.session.role === 'admin') {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/patients', requireAuth, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  if (useDB && pool) {
    pool.query('SELECT * FROM patients ORDER BY received_at DESC LIMIT $1', [limit]).then(function(result) {
      res.json(result.rows);
    }).catch(function(err) {
      console.error('[GET /api/patients ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    res.json(memPatients.slice(0, limit));
  }
});

app.post('/api/patients', requireAdmin, function(req, res) {
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
    mrn:                d.mrn || ''
  };
  if (useDB && pool) {
    insertPatient(patient).then(function() {
      res.status(201).json(patient);
    }).catch(function(err) {
      console.error('[POST /api/patients ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.status(201).json(patient);
  }
});

app.patch('/api/patients/:id', requireAdmin, function(req, res) {
  var id = req.params.id;
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
    pool.query('UPDATE patients SET ' + fields + ' WHERE id = $1 RETURNING *', [id].concat(values))
      .then(function(result) {
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Patient not found' });
        // Log update
        if (req.session && req.session.user) {
          pool.query('INSERT INTO access_log (id,email,name,role,action,record_id,logged_in_at,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [crypto.randomUUID(), req.session.user.email, req.session.user.name, req.session.role, 'update_patient', id, new Date().toISOString(), req.headers['x-forwarded-for'] || req.ip]
          ).catch(function(e) { console.log('[ACCESS LOG]', e.message); });
        }
        res.json(result.rows[0]);
      }).catch(function(err) {
        console.error('[PATCH ERROR]', err.message, '| Fields:', keys.join(', '));
        res.status(500).json({ success: false, error: err.message });
      });
  } else {
    var idx = memPatients.findIndex(function(p) { return p.id === id; });
    if (idx === -1) return res.status(404).json({ success: false, error: 'Patient not found' });
    memPatients[idx] = Object.assign({}, memPatients[idx], updates);
    res.json(memPatients[idx]);
  }
});

app.delete('/api/patients/:id', requireAdmin, function(req, res) {
  var id = req.params.id;
  if (useDB && pool) {
    pool.query('DELETE FROM patients WHERE id = $1 RETURNING id', [id]).then(function(result) {
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Patient not found' });
      res.json({ success: true, deleted: id });
    }).catch(function(err) {
      console.error('[DELETE ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients = memPatients.filter(function(p) { return p.id !== id; });
    res.json({ success: true, deleted: id });
  }
});

app.get('/api/me', requireAuth, function(req, res) {
  res.json({ role: req.session.role, user: req.session.user });
});

app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', storage: useDB ? 'supabase' : 'memory' });
});

// ---------------------------------------------------------------------------
// Webhooks — upsert by MRN to prevent duplicates and status regression
// ---------------------------------------------------------------------------
app.post('/webhook/ghl', function(req, res) {
  var payload = req.body || {};
  var patient = buildPatient(payload);
  var mrn = patient.mrn;

  if (useDB && pool) {
    // Check if patient already exists by MRN
    var mrnCheck = mrn
      ? pool.query('SELECT id, status FROM patients WHERE mrn = $1 LIMIT 1', [mrn])
      : Promise.resolve({ rows: [] });

    mrnCheck.then(function(existing) {
      if (existing.rows.length > 0) {
        // Patient exists — only update if new status is same rank or higher
        var existingId = existing.rows[0].id;
        var existingStatus = existing.rows[0].status;
        var newRank = STATUS_RANK[patient.status] || 1;
        var curRank = STATUS_RANK[existingStatus] || 1;

        if (newRank >= curRank) {
          return pool.query(
            'UPDATE patients SET status=$1, notes=$2, assignee=$3 WHERE id=$4',
            [patient.status, patient.notes, patient.assignee, existingId]
          ).then(function() {
            console.log('[WEBHOOK] Updated existing patient:', existingId, '| Status:', patient.status);
            res.status(200).json({ success: true, updated: true, patientId: existingId });
          });
        } else {
          console.log('[WEBHOOK] Skipped status downgrade:', existingStatus, '->', patient.status);
          res.status(200).json({ success: true, skipped: true, reason: 'status_downgrade_prevented' });
        }
      } else {
        // New patient — insert
        return insertPatient(patient).then(function() {
          console.log('[WEBHOOK] Inserted new patient:', patient.id);
          res.status(200).json({ success: true, inserted: true, patientId: patient.id });
        });
      }
    }).catch(function(err) {
      console.error('[WEBHOOK/GHL ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
  } else {
    memPatients.unshift(patient);
    res.status(200).json({ success: true, patientId: patient.id });
  }
});

app.get('/webhook/test', function(req, res) {
  var testPayload = {
    full_name: 'Test Patient', first_name: 'Test', last_name: 'Patient',
    dob: '1985-06-15', phone: '555-000-1234', mrn: 'TEST001',
    status: 'confirmed', source: 'test'
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

// ---------------------------------------------------------------------------
// Static files — index: false so auth routes handle /
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, function() {
  console.log('\n BMH Tracker running on port ' + PORT);
  console.log('   UI:      ' + BASE_URL);
  console.log('   Health:  ' + BASE_URL + '/api/health');
  console.log('   Webhook: ' + BASE_URL + '/webhook/ghl');
  console.log('   Test:    ' + BASE_URL + '/webhook/test\n');
});
