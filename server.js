/**
 * BMH Patient Journey Tracker - Server
 * Beyond Mobile Health | beyondmobilehealth.com
 * Stack:  Node.js / Express / PostgreSQL (Supabase via pg Pool)
 * Deploy: Railway (via GitHub auto-deploy)
 * Updated: Forgot password flow added
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

var DB_URL            = process.env.DATABASE_URL || '';
var SESSION_SECRET    = process.env.SESSION_SECRET || 'bmh-session-secret-2026';
var ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
var ADMIN_EMAIL       = process.env.ADMIN_EMAIL    || 'admin@beyondmobilehealth.com';
var SMTP_HOST         = process.env.SMTP_HOST      || '';
var SMTP_PORT         = parseInt(process.env.SMTP_PORT || '587', 10);
var SMTP_USER         = process.env.SMTP_USER      || '';
var SMTP_PASS         = process.env.SMTP_PASS      || '';
var AZURE_TENANT_ID   = process.env.AZURE_TENANT_ID   || '';
var AZURE_CLIENT_ID   = process.env.AZURE_CLIENT_ID   || '';
var AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
var BASE_URL          = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
var REDIRECT_URI      = BASE_URL + '/auth/callback';

// In-memory reset token store  { token -> { expires: timestamp } }
var resetTokens = {};

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] AZURE configured:', !!AZURE_TENANT_ID && !!AZURE_CLIENT_ID);
console.log('[ENV] ADMIN_PASSWORD length:', ADMIN_PASSWORD.length, '| first char:', ADMIN_PASSWORD[0]);
console.log('[ENV] SMTP configured:', !!SMTP_HOST && !!SMTP_USER);

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
// Multi-tenant org resolution
//
// SECURITY MODEL:
//   - A client's org is derived SERVER-SIDE from their authenticated email
//     domain. The browser never supplies it and cannot override it.
//   - DEFAULT DENY: an unrecognized domain resolves to null, which returns
//     ZERO rows. Never all rows.
//   - Orders with org_id IS NULL belong to nobody and are admin-only.
// ---------------------------------------------------------------------------
var ORG_CACHE = { at: 0, rows: [] };

function loadOrgs() {
  if (!useDB || !pool) return Promise.resolve([]);
  if (Date.now() - ORG_CACHE.at < 60000) return Promise.resolve(ORG_CACHE.rows);
  return pool.query('SELECT id,name,short_name,email_domains,tag_color,tag_bg FROM organizations WHERE active = true')
    .then(function(r) { ORG_CACHE = { at: Date.now(), rows: r.rows }; return r.rows; })
    .catch(function(e) { console.error('[ORGS]', e.message); return ORG_CACHE.rows; });
}

function orgForEmail(email, orgs) {
  if (!email || email.indexOf('@') === -1) return null;
  var domain = email.split('@').pop().toLowerCase().trim();
  for (var i = 0; i < orgs.length; i++) {
    var d = orgs[i].email_domains || [];
    for (var j = 0; j < d.length; j++) {
      if (String(d[j]).toLowerCase() === domain) return orgs[i];
    }
  }
  return null; // unmapped domain -> deny
}

// Orders status -> client-facing tracker status
var STATUS_MAP = {
  received:  'received',
  assigned:  'scheduled',
  completed: 'completed',
  lab:       'completed',
  noshow:    'incomplete',
  unreach:   'unreachable'
};

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
    mrn:                mrn
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
// Email helper — sends reset link via SMTP (nodemailer if available)
// Falls back to console log if SMTP not configured
// ---------------------------------------------------------------------------
function sendResetEmail(toEmail, resetLink) {
  console.log('[RESET] Sending reset link to:', toEmail);
  console.log('[RESET] Link:', resetLink);

  // If SMTP not configured just log — admin can use the link from Railway logs
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[RESET] No SMTP configured — check Railway logs for the reset link above');
    return Promise.resolve({ fallback: true });
  }

  // Try nodemailer if available
  try {
    var nodemailer = require('nodemailer');
    var transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    return transporter.sendMail({
      from: '"BMH Tracker" <' + SMTP_USER + '>',
      to: toEmail,
      subject: 'BMH Tracker — Password Reset',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">' +
            '<h2 style="color:#0a1628">Password Reset Request</h2>' +
            '<p style="color:#444;margin:16px 0">Click the button below to reset your admin password. This link expires in 15 minutes.</p>' +
            '<a href="' + resetLink + '" style="display:inline-block;padding:12px 24px;background:#00c5a1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Reset My Password</a>' +
            '<p style="color:#999;font-size:12px;margin-top:24px">If you did not request this, ignore this email. Your password will not change.</p>' +
            '<p style="color:#999;font-size:12px">Link: ' + resetLink + '</p>' +
            '</div>'
    });
  } catch (e) {
    console.log('[RESET] nodemailer not available:', e.message);
    return Promise.resolve({ fallback: true });
  }
}

// ---------------------------------------------------------------------------
// Login + Forgot Password pages (inline HTML — ES5 style, no template literals)
// ---------------------------------------------------------------------------
var LOGIN_PAGE = '<!DOCTYPE html>' +
'<html><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>BMH Patient Tracker</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}' +
'.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}' +
'.mark{width:56px;height:56px;background:#00c5a1;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px}' +
'h1{font-size:22px;font-weight:700;color:#0a1628;margin-bottom:6px}' +
'.sub{font-size:14px;color:#8896ab;margin-bottom:32px}' +
'.ms{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:13px 20px;background:#0078d4;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;margin-bottom:20px;font-family:inherit}' +
'.ms:hover{background:#106ebe}' +
'.div{display:flex;align-items:center;gap:12px;margin:16px 0;color:#8896ab;font-size:12px}' +
'.div::before,.div::after{content:"";flex:1;height:1px;background:#e4eaf2}' +
'input{width:100%;padding:11px 14px;border:1.5px solid #e4eaf2;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit;transition:border-color .2s}' +
'input:focus{border-color:#00c5a1}' +
'.abtn{width:100%;padding:11px;background:#0a1628;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .2s}' +
'.abtn:hover{background:#1a2d4a}' +
'.err{color:#e8453c;font-size:13px;margin-top:10px;padding:8px;background:#fff5f5;border-radius:6px;border:1px solid #fecaca}' +
'.ok{color:#059669;font-size:13px;margin-top:10px;padding:8px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0}' +
'.forgot{display:block;margin-top:12px;font-size:12px;color:#8896ab;text-decoration:none;transition:color .2s}' +
'.forgot:hover{color:#00c5a1}' +
'</style>' +
'</head><body>' +
'<div class="card">' +
'<div class="mark">&#128203;</div>' +
'<h1>BMH Patient Tracker</h1>' +
'<p class="sub">Beyond Mobile Health</p>' +
'<a class="ms" href="/auth/microsoft">' +
'<svg width="20" height="20" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>' +
'Sign in with Microsoft' +
'</a>' +
'<div class="div">or admin access</div>' +
'<form method="POST" action="/auth/admin">' +
'<input type="password" name="password" placeholder="Admin password" required>' +
'<button class="abtn" type="submit">Admin Login</button>' +
'MSG_PLACEHOLDER' +
'</form>' +
'<a class="forgot" href="/forgot-password">Forgot password?</a>' +
'</div>' +
'</body></html>';

var FORGOT_PAGE = '<!DOCTYPE html>' +
'<html><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Reset Password — BMH Tracker</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}' +
'.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}' +
'.mark{width:56px;height:56px;background:#00c5a1;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px}' +
'h1{font-size:20px;font-weight:700;color:#0a1628;margin-bottom:8px}' +
'.sub{font-size:13px;color:#8896ab;margin-bottom:28px;line-height:1.5}' +
'input{width:100%;padding:11px 14px;border:1.5px solid #e4eaf2;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit}' +
'input:focus{border-color:#00c5a1}' +
'.abtn{width:100%;padding:11px;background:#0a1628;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}' +
'.abtn:hover{background:#1a2d4a}' +
'.err{color:#e8453c;font-size:13px;margin-top:10px;padding:8px;background:#fff5f5;border-radius:6px;border:1px solid #fecaca}' +
'.ok{color:#059669;font-size:13px;margin-top:10px;padding:8px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0;line-height:1.5}' +
'.back{display:block;margin-top:16px;font-size:12px;color:#8896ab;text-decoration:none}' +
'.back:hover{color:#00c5a1}' +
'</style>' +
'</head><body>' +
'<div class="card">' +
'<div class="mark">&#128274;</div>' +
'<h1>Reset Admin Password</h1>' +
'<p class="sub">Enter your admin email address. We will send a reset link to <strong>admin@beyondmobilehealth.com</strong> if it matches.</p>' +
'<form method="POST" action="/forgot-password">' +
'<input type="email" name="email" placeholder="Admin email address" required>' +
'<button class="abtn" type="submit">Send Reset Link</button>' +
'FORGOT_MSG_PLACEHOLDER' +
'</form>' +
'<a class="back" href="/login">&larr; Back to login</a>' +
'</div>' +
'</body></html>';

var RESET_PAGE = '<!DOCTYPE html>' +
'<html><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Set New Password — BMH Tracker</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}' +
'.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}' +
'.mark{width:56px;height:56px;background:#00c5a1;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px}' +
'h1{font-size:20px;font-weight:700;color:#0a1628;margin-bottom:8px}' +
'.sub{font-size:13px;color:#8896ab;margin-bottom:28px}' +
'input{width:100%;padding:11px 14px;border:1.5px solid #e4eaf2;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit}' +
'input:focus{border-color:#00c5a1}' +
'.abtn{width:100%;padding:11px;background:#0a1628;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}' +
'.err{color:#e8453c;font-size:13px;margin-top:10px;padding:8px;background:#fff5f5;border-radius:6px}' +
'.ok{color:#059669;font-size:13px;margin-top:10px;padding:8px;background:#f0fdf4;border-radius:6px}' +
'.back{display:block;margin-top:16px;font-size:12px;color:#8896ab;text-decoration:none}' +
'</style>' +
'</head><body>' +
'<div class="card">' +
'<div class="mark">&#128275;</div>' +
'<h1>Set New Password</h1>' +
'<p class="sub">Choose a new admin password.</p>' +
'<form method="POST" action="/reset-password">' +
'<input type="hidden" name="token" value="TOKEN_PLACEHOLDER">' +
'<input type="password" name="password" placeholder="New password" required minlength="8">' +
'<input type="password" name="confirm" placeholder="Confirm new password" required minlength="8">' +
'<button class="abtn" type="submit">Update Password</button>' +
'RESET_MSG_PLACEHOLDER' +
'</form>' +
'<a class="back" href="/login">&larr; Back to login</a>' +
'</div>' +
'</body></html>';

// ---------------------------------------------------------------------------
// Login routes
// ---------------------------------------------------------------------------
app.get('/login', function(req, res) {
  if (req.session && req.session.role) return res.redirect('/');
  var msg = '';
  if (req.query.error)   msg = '<div class="err">Invalid password. Try again.</div>';
  if (req.query.reset)   msg = '<div class="ok">Password updated successfully. You can now log in.</div>';
  res.send(LOGIN_PAGE.replace('MSG_PLACEHOLDER', msg));
});

app.post('/auth/admin', function(req, res) {
  var entered = (req.body.password || '').trim();
  var expected = ADMIN_PASSWORD.trim();
  console.log('[LOGIN] Attempt — entered length:', entered.length, '| expected length:', expected.length, '| match:', entered === expected);
  if (entered === expected) {
    req.session.role = 'admin';
    req.session.user = { name: 'Admin', email: ADMIN_EMAIL };
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// ---------------------------------------------------------------------------
// Forgot password routes
// ---------------------------------------------------------------------------
app.get('/forgot-password', function(req, res) {
  var msg = '';
  if (req.query.invalid) msg = '<div class="err">That email does not match the admin account.</div>';
  res.send(FORGOT_PAGE.replace('FORGOT_MSG_PLACEHOLDER', msg));
});

app.post('/forgot-password', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var adminEmail = ADMIN_EMAIL.trim().toLowerCase();

  if (email !== adminEmail) {
    console.log('[RESET] Email mismatch — entered:', email, '| expected:', adminEmail);
    return res.redirect('/forgot-password?invalid=1');
  }

  // Generate token — 32 random bytes, hex encoded
  var token = crypto.randomBytes(32).toString('hex');
  // Expires in 15 minutes
  resetTokens[token] = { expires: Date.now() + 15 * 60 * 1000 };

  var resetLink = BASE_URL + '/reset-password?token=' + token;

  sendResetEmail(ADMIN_EMAIL, resetLink).then(function(result) {
    if (result && result.fallback) {
      // SMTP not configured — show link directly on page (development mode)
      console.log('[RESET] Fallback mode — link shown in response');
      var directMsg = '<div class="ok">SMTP not configured. Copy this link to reset:<br><br>' +
                      '<a href="' + resetLink + '" style="word-break:break-all;color:#059669;font-size:11px">' + resetLink + '</a>' +
                      '<br><br>Or check Railway logs for the link.</div>';
      res.send(FORGOT_PAGE.replace('FORGOT_MSG_PLACEHOLDER', directMsg));
    } else {
      res.send(FORGOT_PAGE.replace('FORGOT_MSG_PLACEHOLDER',
        '<div class="ok">Reset link sent to ' + ADMIN_EMAIL + '. Check your inbox. Link expires in 15 minutes.</div>'
      ));
    }
  }).catch(function(err) {
    console.error('[RESET EMAIL ERROR]', err.message);
    res.send(FORGOT_PAGE.replace('FORGOT_MSG_PLACEHOLDER',
      '<div class="err">Error sending email: ' + err.message + '. Check Railway logs for the reset link.</div>'
    ));
  });
});

app.get('/reset-password', function(req, res) {
  var token = req.query.token || '';
  var entry = resetTokens[token];

  if (!entry || Date.now() > entry.expires) {
    return res.send(RESET_PAGE
      .replace('TOKEN_PLACEHOLDER', '')
      .replace('RESET_MSG_PLACEHOLDER', '<div class="err">This reset link has expired or is invalid. <a href="/forgot-password">Request a new one.</a></div>')
    );
  }

  res.send(RESET_PAGE
    .replace('TOKEN_PLACEHOLDER', token)
    .replace('RESET_MSG_PLACEHOLDER', '')
  );
});

app.post('/reset-password', function(req, res) {
  var token    = (req.body.token    || '').trim();
  var password = (req.body.password || '').trim();
  var confirm  = (req.body.confirm  || '').trim();
  var entry    = resetTokens[token];

  if (!entry || Date.now() > entry.expires) {
    return res.send(RESET_PAGE
      .replace('TOKEN_PLACEHOLDER', token)
      .replace('RESET_MSG_PLACEHOLDER', '<div class="err">Link expired. <a href="/forgot-password">Request a new one.</a></div>')
    );
  }

  if (password.length < 8) {
    return res.send(RESET_PAGE
      .replace('TOKEN_PLACEHOLDER', token)
      .replace('RESET_MSG_PLACEHOLDER', '<div class="err">Password must be at least 8 characters.</div>')
    );
  }

  if (password !== confirm) {
    return res.send(RESET_PAGE
      .replace('TOKEN_PLACEHOLDER', token)
      .replace('RESET_MSG_PLACEHOLDER', '<div class="err">Passwords do not match.</div>')
    );
  }

  // Update in-memory password AND log the new one so admin can set it in Railway
  ADMIN_PASSWORD = password;
  delete resetTokens[token];

  console.log('[RESET] Password updated successfully.');
  console.log('[RESET] *** NEW PASSWORD SET: ' + password + ' ***');
  console.log('[RESET] Go to Railway Variables and update ADMIN_PASSWORD to this value to make it permanent.');

  res.redirect('/login?reset=1');
});

// ---------------------------------------------------------------------------
// Microsoft SSO
// ---------------------------------------------------------------------------
app.get('/auth/microsoft', function(req, res) {
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID) {
    return res.send('<p style="font-family:sans-serif;padding:20px">Azure SSO not configured.</p>');
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
  var code  = req.query.code;
  var error = req.query.error;
  if (error || !code) return res.redirect('/login?error=1');
  fetch('https://login.microsoftonline.com/' + AZURE_TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     AZURE_CLIENT_ID,
      client_secret: AZURE_CLIENT_SECRET,
      code:          code,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code'
    })
  }).then(function(r) { return r.json(); }).then(function(td) {
    if (td.error) throw new Error(td.error_description);
    var payload = JSON.parse(Buffer.from(td.id_token.split('.')[1], 'base64').toString());
    req.session.role = 'client';
    req.session.user = { name: payload.name || payload.preferred_username, email: payload.email || payload.preferred_username };
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
// Root route
// ---------------------------------------------------------------------------
app.get('/', requireAuth, function(req, res) {
  if (req.session.role === 'admin') {
    return res.redirect('/dispatch');
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

// ---------------------------------------------------------------------------
// NEW: org-scoped orders feed (reads orders + people, not the legacy
// `patients` table). Returns the same camelCase shape client.html expects.
// ---------------------------------------------------------------------------
app.get('/api/orders', requireAuth, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  if (!useDB || !pool) return res.json([]);

  loadOrgs().then(function(orgs) {
    var isAdmin = req.session.role === 'admin';
    var org = isAdmin ? null : orgForEmail(req.session.user && req.session.user.email, orgs);

    // DEFAULT DENY — a client whose domain maps to no org sees nothing.
    if (!isAdmin && !org) {
      console.warn('[TENANCY] denied, unmapped domain:', req.session.user && req.session.user.email);
      return res.json([]);
    }

    var sql =
      'SELECT o.id, o.request_no, o.status, o.requested_date, o.completed_date, ' +
      '       o.provider, o.provider_npi, o.service_address, o.access_notes, ' +
      '       o.assignee, o.received_at, o.is_recurring, o.occurrence_index, ' +
      '       o.occurrence_total, o.billing_ready, o.org_id, ' +
      '       p.full_name, p.first_name, p.last_name, p.mrn, p.dob, p.phone, ' +
      '       p.language, p.interpreter_needed ' +
      '  FROM orders o JOIN people p ON p.id = o.person_id ';
    var params = [];
    if (!isAdmin) { sql += ' WHERE o.org_id = $1 '; params.push(org.id); }
    params.push(limit);
    sql += ' ORDER BY o.requested_date DESC NULLS LAST LIMIT $' + params.length;

    return pool.query(sql, params).then(function(r) {
      var byId = {};
      orgs.forEach(function(o) { byId[o.id] = o; });
      res.json(r.rows.map(function(row) {
        var o = byId[row.org_id] || null;
        return {
          id:            row.id,
          name:          row.full_name || ((row.first_name || '') + ' ' + (row.last_name || '')).trim(),
          mrn:           row.mrn || '',
          dob:           row.dob ? String(row.dob).slice(0, 10) : '',
          phone:         row.phone || '',
          language:      row.language || 'English',
          interpreter:   !!row.interpreter_needed,
          provider:      row.provider || '',
          assignee:      row.assignee || '',
          address:       row.service_address || '',
          accessNotes:   row.access_notes || '',
          requestNo:     row.request_no || 1,
          recurring:     !!row.is_recurring,
          occIndex:      row.occurrence_index,
          occTotal:      row.occurrence_total,
          orderDate:     row.received_at ? String(row.received_at).slice(0, 10) : '',
          apptDate:      row.requested_date ? String(row.requested_date).slice(0, 10) : '',
          apptTime:      '',
          completedDate: row.completed_date ? String(row.completed_date).slice(0, 10) : '',
          receivedAt:    row.received_at,
          status:        STATUS_MAP[row.status] || 'received',
          orgId:         row.org_id || null,
          orgName:       o ? (o.short_name || o.name) : null,
          orgColor:      o ? o.tag_color : '#8896ab',
          orgBg:         o ? o.tag_bg : '#f1f5f9',
          notes:         (row.mrn ? 'MRN: ' + row.mrn : '') +
                         (row.assignee ? ' | Assigned to: ' + row.assignee : '')
        };
      }));
    });
  }).catch(function(err) {
    console.error('[GET /api/orders ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message });
  });
});

// ---------------------------------------------------------------------------
// Dispatch dashboard (admin only). Full org-tagged operational view.
// ---------------------------------------------------------------------------
app.get('/dispatch', requireAdmin, function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dispatch.html'));
});

app.get('/api/dispatch', requireAdmin, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
  if (!useDB || !pool) return res.json([]);

  loadOrgs().then(function(orgs) {
    var byId = {};
    orgs.forEach(function(o) { byId[o.id] = o; });
    return pool.query(
      'SELECT o.*, ' +
      '       p.full_name, p.first_name, p.last_name, p.mrn, p.dob, p.phone, ' +
      '       p.language, p.language_other, p.interpreter_needed, ' +
      '       p.alt_contact_name, p.alt_contact_title, p.home_address ' +
      '  FROM orders o JOIN people p ON p.id = o.person_id ' +
      ' ORDER BY o.requested_date ASC NULLS LAST LIMIT $1', [limit]
    ).then(function(r) {
      // Shape matches what dispatch.html's fromDb() expects (nested `people`).
      res.json(r.rows.map(function(row) {
        var org = byId[row.org_id] || null;
        return Object.assign({}, row, {
          people: {
            full_name: row.full_name, first_name: row.first_name, last_name: row.last_name,
            mrn: row.mrn, dob: row.dob, phone: row.phone, language: row.language,
            language_other: row.language_other, interpreter_needed: row.interpreter_needed,
            alt_contact_name: row.alt_contact_name, alt_contact_title: row.alt_contact_title,
            home_address: row.home_address
          },
          org_name:  org ? (org.short_name || org.name) : null,
          org_color: org ? org.tag_color : '#8896ab',
          org_bg:    org ? org.tag_bg : '#f1f5f9'
        });
      }));
    });
  }).catch(function(err) {
    console.error('[GET /api/dispatch ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message });
  });
});

// Status updates write through Railway so every change is audit-logged.
app.patch('/api/dispatch/:id', requireAdmin, function(req, res) {
  var id = req.params.id;
  if (!useDB || !pool) return res.status(503).json({ success: false, error: 'No database' });

  // Whitelist — never let the browser set arbitrary columns.
  var ALLOWED = ['status', 'assignee', 'phlebotomist_id', 'completed_date',
                 'requested_date', 'access_notes', 'best_time', 'updated_at'];
  var updates = {};
  Object.keys(req.body || {}).forEach(function(k) {
    if (ALLOWED.indexOf(k) !== -1) updates[k] = req.body[k];
  });
  var keys = Object.keys(updates);
  if (!keys.length) return res.status(400).json({ success: false, error: 'No valid fields' });

  var fields = keys.map(function(k, i) { return '"' + k + '" = $' + (i + 2); }).join(', ');
  pool.query('UPDATE orders SET ' + fields + ' WHERE id = $1 RETURNING *', [id].concat(Object.values(updates)))
    .then(function(result) {
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
      if (req.session && req.session.user) {
        pool.query(
          'INSERT INTO access_log (id,email,name,role,action,record_id,logged_in_at,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [crypto.randomUUID(), req.session.user.email, req.session.user.name, req.session.role,
           'update_order:' + keys.join(','), id, new Date().toISOString(),
           req.headers['x-forwarded-for'] || req.ip]
        ).catch(function(e) { console.log('[ACCESS LOG]', e.message); });
      }
      res.json(result.rows[0]);
    })
    .catch(function(err) {
      console.error('[PATCH /api/dispatch ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message });
    });
});

app.get('/api/me', requireAuth, function(req, res) {
  loadOrgs().then(function(orgs) {
    var isAdmin = req.session.role === 'admin';
    var org = isAdmin ? null : orgForEmail(req.session.user && req.session.user.email, orgs);
    res.json({
      role: req.session.role,
      user: req.session.user,
      org:  isAdmin ? { id: null, name: 'All Organizations', admin: true }
                    : (org ? { id: org.id, name: org.name, short: org.short_name,
                               color: org.tag_color, bg: org.tag_bg } : null)
    });
  }).catch(function() {
    res.json({ role: req.session.role, user: req.session.user, org: null });
  });
});

app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', storage: useDB ? 'supabase' : 'memory' });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
app.post('/webhook/ghl', function(req, res) {
  var payload = req.body || {};
  var patient = buildPatient(payload);
  var mrn = patient.mrn;

  if (useDB && pool) {
    var mrnCheck = mrn
      ? pool.query('SELECT id, status FROM patients WHERE mrn = $1 LIMIT 1', [mrn])
      : Promise.resolve({ rows: [] });

    mrnCheck.then(function(existing) {
      if (existing.rows.length > 0) {
        var existingId     = existing.rows[0].id;
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
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, function() {
  console.log('\n BMH Tracker running on port ' + PORT);
  console.log('   UI:      ' + BASE_URL);
  console.log('   Health:  ' + BASE_URL + '/api/health');
  console.log('   Webhook: ' + BASE_URL + '/webhook/ghl');
  console.log('   Test:    ' + BASE_URL + '/webhook/test\n');
});
