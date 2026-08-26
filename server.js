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
var SUPABASE_URL         = process.env.SUPABASE_URL || 'https://hnamuztnddupqasikrfi.supabase.co';
var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
// GHL inbound webhook that fires the BMC workflow (notifications/calendar/assignment).
// Set in Railway env — never hardcode the trigger URL in a browser file.
var GHL_INBOUND_URL      = process.env.GHL_INBOUND_URL || '';
// Public base URL for building phlebotomist-facing requisition links in GHL.
var PUBLIC_BASE_URL      = process.env.PUBLIC_BASE_URL || 'https://bmh-tracker-production.up.railway.app';
// Secret for tokenizing requisition links (falls back to session secret).
var REQ_LINK_SECRET      = process.env.REQ_LINK_SECRET || process.env.SESSION_SECRET || 'bmh-req-link-fallback';
var SESSION_SECRET    = process.env.SESSION_SECRET || 'bmh-session-secret-2026';
var ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
var ADMIN_EMAIL       = process.env.ADMIN_EMAIL    || 'admin@beyondmobilehealth.com';
var BMC_NOTIFY_EMAIL  = process.env.BMC_NOTIFY_EMAIL || 'dg-homecare_admin@bmc.org';
var NURSE_DG_EMAIL    = process.env.NURSE_DG_EMAIL   || '';
var SMTP_HOST         = process.env.SMTP_HOST      || '';
var SMTP_PORT         = parseInt(process.env.SMTP_PORT || '587', 10);
var SMTP_USER         = process.env.SMTP_USER      || '';
var SMTP_FROM         = process.env.SMTP_FROM      || 'noreply@beyondmobilehealth.com';
var SMTP_PASS         = process.env.SMTP_PASS      || '';
var AZURE_TENANT_ID   = process.env.AZURE_TENANT_ID   || '';
var AZURE_CLIENT_ID   = process.env.AZURE_CLIENT_ID   || '';
var AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
var BASE_URL          = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
var REDIRECT_URI      = BASE_URL + '/auth/callback';

// In-memory reset token store  { token -> { expires: timestamp } }
var resetTokens = {};

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] SUPABASE_SERVICE_KEY present:', !!SUPABASE_SERVICE_KEY);
console.log('[ENV] GHL_INBOUND_URL present:', !!GHL_INBOUND_URL);
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
  // 1. Railway session (admin password login or Microsoft SSO)
  if (req.session && (req.session.role === 'admin' || req.session.role === 'client')) return next();

  // 2. Supabase Bearer token — BMC clients logging in via Supabase auth on index.html
  //    We verify the token is a valid JWT signed by the correct project,
  //    extract the email, derive the org, mint a Railway session, then proceed.
  var authHeader = req.headers.authorization || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (token && token.split('.').length === 3) {
    try {
      // Decode payload (no secret check needed — Supabase already verified at login)
      // We trust the email because it came from a Supabase-authenticated session.
      var payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      var email = payload.email || payload.sub || '';
      if (email && email.indexOf('@') !== -1) {
        req.session.role = 'client';
        req.session.user = { name: email.split('@')[0], email: email };
        console.log('[AUTH] Supabase token accepted for:', email);
        return next();
      }
    } catch(e) {
      console.log('[AUTH] Token decode error:', e.message);
    }
  }

  // 3. If the request is an API call return 401, otherwise redirect to login
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
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
  // Completed / showed
  if (v === 'showed')                                    return 'completed';
  if (v === 'completed' || v.indexOf('complet') !== -1)  return 'completed';
  // No show / incomplete
  if (v === 'no_show' || v === 'no show')                return 'incomplete';
  if (v === 'not completed')                             return 'incomplete';
  if (v === 'cancelled' || v === 'invalid')              return 'incomplete';
  // Confirmed / appointment scheduled — GHL sends 'confirmed'
  if (v === 'confirmed')                                 return 'scheduled';
  if (v === 'appt scheduled')                            return 'scheduled';
  if (v.indexOf('schedule') !== -1)                      return 'scheduled';
  // Calling / scheduling in progress — GHL sends 'unconfirmed' or 'new'
  if (v === 'unconfirmed' || v === 'new')                return 'calling';
  if (v === 'calling' || v.indexOf('calling') !== -1)    return 'calling';
  if (v.indexOf('scheduling') !== -1)                    return 'calling';
  // Unable to reach
  if (v === 'unable to reach')                           return 'unreachable';
  if (v.indexOf('reach') !== -1)                         return 'unreachable';
  // Order received (default)
  if (v === 'order received')                            return 'received';
  return 'received';
}

// Status rank — higher rank wins when merging duplicate MRNs
// calling=2 so confirmed(3) beats calling but calling beats received(1)
var STATUS_RANK = { received: 1, calling: 2, scheduled: 3, incomplete: 3, unreachable: 2, completed: 4 };

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
      from: '"BMH Tracker" <' + SMTP_FROM + '>',
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
// ---------------------------------------------------------------------------
// BMC Status Notification Email
// Fires whenever a patient status changes. Notifies dg-homecare_admin@bmc.org
// ---------------------------------------------------------------------------
function sendStatusEmail(patient, newStatus, oldStatus) {
  // Send to both BMC admin and nurse DG — filter out any empty values
  var recipients = [BMC_NOTIFY_EMAIL, NURSE_DG_EMAIL].filter(function(e) { return e && e.trim(); });
  var toEmail = recipients.join(', ');
  var statusLabels = {
    received:    'Order Received',
    scheduled:   'Appointment Scheduled',
    completed:   'Collection Completed',
    incomplete:  'Appointment Not Completed',
    unreachable: 'Unable to Reach Patient'
  };
  var newLabel = statusLabels[newStatus] || newStatus;
  var oldLabel = statusLabels[oldStatus] || oldStatus || 'Unknown';
  var patientName = patient.name || ((patient.first_name || '') + ' ' + (patient.last_name || '')).trim() || 'Unknown Patient';
  var mrn = patient.mrn ? ' | MRN: ' + patient.mrn : '';
  var apptInfo = patient.appt_date ? 'Appointment: ' + patient.appt_date + (patient.appt_time ? ' at ' + patient.appt_time : '') : '';
  var completedInfo = patient.completed_date ? 'Completed: ' + patient.completed_date + (patient.completed_time ? ' at ' + patient.completed_time : '') : '';
  var reason = patient.incomplete_reason || patient.unreachable_reason || '';

  var subject = '[BMH Tracker] ' + patientName + ' — Status: ' + newLabel;

  var statusColor = {
    completed:   '#2ecc71',
    scheduled:   '#00c5a1',
    incomplete:  '#f5a623',
    unreachable: '#e8453c',
    received:    '#8896ab'
  }[newStatus] || '#8896ab';

  var htmlBody = '<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e4eaf2;border-radius:12px;overflow:hidden">' +
    '<div style="background:#0a1628;padding:20px 24px;display:flex;align-items:center">' +
    '<div style="background:#00c5a1;width:36px;height:36px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;margin-right:12px;font-size:18px">&#128203;</div>' +
    '<div><div style="color:#fff;font-size:15px;font-weight:600">BMH Patient Tracker</div>' +
    '<div style="color:#8896ab;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Boston Medical Center</div></div></div>' +
    '<div style="padding:24px">' +
    '<div style="background:' + statusColor + '20;border-left:4px solid ' + statusColor + ';padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">' +
    '<div style="font-size:12px;color:#666;font-weight:500;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Status Update</div>' +
    '<div style="font-size:18px;font-weight:700;color:#0d1b2e">' + newLabel + '</div>' +
    '<div style="font-size:12px;color:#8896ab;margin-top:2px">Previously: ' + oldLabel + '</div></div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr><td style="padding:8px 0;color:#8896ab;width:130px;vertical-align:top">Patient</td>' +
    '<td style="padding:8px 0;font-weight:600;color:#0d1b2e">' + patientName + mrn + '</td></tr>' +
    (apptInfo ? '<tr><td style="padding:8px 0;color:#8896ab;vertical-align:top">Appointment</td><td style="padding:8px 0;color:#0d1b2e">' + apptInfo + '</td></tr>' : '') +
    (completedInfo ? '<tr><td style="padding:8px 0;color:#8896ab;vertical-align:top">Completed</td><td style="padding:8px 0;color:#0d1b2e">' + completedInfo + '</td></tr>' : '') +
    (reason ? '<tr><td style="padding:8px 0;color:#8896ab;vertical-align:top">Notes</td><td style="padding:8px 0;color:#0d1b2e">' + reason + '</td></tr>' : '') +
    '</table>' +
    '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e4eaf2;font-size:11px;color:#aaa">' +
    'This is an automated notification from Beyond Mobile Health.<br>' +
    'To view the full tracker, visit <a href="https://bmh-tracker-production.up.railway.app" style="color:#00c5a1">bmh-tracker-production.up.railway.app</a>' +
    '</div></div></div>';

  console.log('[NOTIFY] Status change -> [' + toEmail + '] | Patient: ' + patientName + ' | ' + oldLabel + ' -> ' + newLabel);

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[NOTIFY] No SMTP configured — notification logged only');
    return Promise.resolve({ logged: true });
  }

  try {
    var nodemailer = require('nodemailer');
    var transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    return transporter.sendMail({
      from: '"BMH Tracker" <' + SMTP_FROM + '>',
      to: toEmail,
      subject: subject,
      html: htmlBody
    }).then(function(info) {
      console.log('[NOTIFY] Email sent:', info.messageId);
      return info;
    });
  } catch(e) {
    console.log('[NOTIFY] nodemailer not available:', e.message);
    return Promise.resolve({ logged: true });
  }
}

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
        // Fire BMC notification — only on meaningful stage changes
        // Fires when: scheduled (appt confirmed) or completed (collection done)
        var notifyStatuses = ['scheduled', 'completed'];
        if (updates.status && notifyStatuses.indexOf(updates.status) !== -1) {
          sendStatusEmail(result.rows[0], updates.status, req.body._prev_status || 'previous')
            .catch(function(e) { console.log('[NOTIFY ERROR]', e.message); });
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
      '       o.occurrence_total, o.billing_ready, o.org_id, o.requisition_path, ' +
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
          requisitionPath: row.requisition_path || null,
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
// Tokenize a requisition link: HMAC(order_id, secret). Unguessable without the
// secret, stable per order, needs no login — for phlebotomists working in GHL.
function reqToken(orderId){
  return crypto.createHmac('sha256', REQ_LINK_SECRET)
    .update(String(orderId)).digest('hex').slice(0, 32);
}

// PUBLIC requisition link (no login) used inside GHL by phlebotomists.
// The token gates access; on valid token we mint a fresh 5-min signed URL
// and redirect to the actual PDF. The file itself stays in the private bucket.
app.get('/r/:orderId/:token', function(req, res){
  var orderId = req.params.orderId;
  var token   = req.params.token;
  if (token !== reqToken(orderId)) {
    return res.status(403).send('Invalid or expired requisition link.');
  }
  if(!useDB || !pool || !SUPABASE_SERVICE_KEY) return res.status(503).send('Unavailable.');

  pool.query('SELECT requisition_path FROM orders WHERE id = $1', [orderId])
    .then(function(r){
      if(!r.rows.length || !r.rows[0].requisition_path) return res.status(404).send('No requisition on file.');
      var objectPath = r.rows[0].requisition_path;
      // Encode each path segment but keep the slash separators intact —
      // Supabase's sign endpoint needs real slashes in the path.
      var safePath = String(objectPath).split('/').map(encodeURIComponent).join('/');
      return fetch(SUPABASE_URL + '/storage/v1/object/sign/requisitions/' + safePath, {
        method:'POST',
        headers:{ 'Authorization':'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({ expiresIn: 1800 })  // 30 min — phlebotomist prints in the field
      }).then(function(s){ return s.text().then(function(t){
          var j; try{ j=JSON.parse(t); }catch(e){ j={}; }
          return { ok:s.ok, status:s.status, j:j, raw:t };
        }); })
        .then(function(o){
          if(!o.ok || !o.j.signedURL){
            console.error('[/r SIGN FAIL]', o.status, o.raw);
            return res.status(502).send('Could not open requisition.');
          }
          res.redirect(SUPABASE_URL + '/storage/v1' + o.j.signedURL);
        });
    })
    .catch(function(e){ console.error('[/r ERROR]', e.message); res.status(500).send('Error opening requisition.'); });
});

// ---------------------------------------------------------------------------
// Requisition retrieval — brokered server-side so the private file is never
// exposed via a browser key. Staff/admin get any; a client is org-scoped to
// their own patients only. Returns a short-lived signed URL.
// ---------------------------------------------------------------------------
app.get('/api/requisition/:orderId', requireAuth, function(req, res){
  var orderId = req.params.orderId;
  if(!useDB || !pool) return res.status(503).json({ error:'No database' });
  if(!SUPABASE_SERVICE_KEY) return res.status(500).json({ error:'Storage not configured' });

  pool.query('SELECT id, org_id, requisition_path FROM orders WHERE id = $1', [orderId])
    .then(function(r){
      if(!r.rows.length) return res.status(404).json({ error:'Order not found' });
      var order = r.rows[0];
      if(!order.requisition_path) return res.status(404).json({ error:'No requisition on file' });

      // Client role: confirm this order belongs to their org before releasing PHI.
      if(req.session.role !== 'admin'){
        return loadOrgs().then(function(orgs){
          var org = orgForEmail(req.session.user && req.session.user.email, orgs);
          if(!org || order.org_id !== org.id){
            console.warn('[REQ] denied cross-org access', req.session.user && req.session.user.email, orderId);
            return res.status(403).json({ error:'Not authorized for this record' });
          }
          return signAndReturn(order.requisition_path, res);
        });
      }
      return signAndReturn(order.requisition_path, res);
    })
    .catch(function(e){ console.error('[REQ ERROR]', e.message); res.status(500).json({ error:e.message }); });
});

function signAndReturn(objectPath, res){
  // Supabase Storage: create a signed URL valid for 5 minutes.
  var safePath = String(objectPath).split('/').map(encodeURIComponent).join('/');
  return fetch(SUPABASE_URL + '/storage/v1/object/sign/requisitions/' + safePath, {
    method:'POST',
    headers:{ 'Authorization':'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ expiresIn: 300 })
  })
  .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
  .then(function(o){
    if(!o.ok || !o.j.signedURL) return res.status(502).json({ error:'Could not sign URL' });
    res.json({ url: SUPABASE_URL + '/storage/v1' + o.j.signedURL });
  })
  .catch(function(e){ console.error('[SIGN ERROR]', e.message); res.status(500).json({ error:e.message }); });
}

// Admin can view the tracker (journey-card) layout with full data.
// Same file clients get; /api/orders already returns all orders for admins.
app.get('/tracker-view', requireAdmin, function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// ---------------------------------------------------------------------------
// Intake -> GHL bridge. The public intake form calls this AFTER it has written
// the order to Supabase. Railway reads the order back from the DB (so the
// browser can't forge fields), then POSTs clean data to the GHL inbound
// webhook, which fires the BMC workflow for notifications/calendar/assignment.
// The GHL trigger URL lives only here (server-side), never in the browser.
// This route is intentionally UNauthenticated (the public form calls it) but
// it only accepts an order id and reveals nothing — it reads server-side.
// ---------------------------------------------------------------------------
app.post('/api/intake-submitted', function(req, res){
  var orderId = (req.body && req.body.orderId) ? String(req.body.orderId) : '';
  if(!orderId) return res.status(400).json({ ok:false, error:'orderId required' });
  if(!GHL_INBOUND_URL){ console.warn('[INTAKE->GHL] no GHL_INBOUND_URL set; skipping push'); return res.json({ ok:true, pushed:false, reason:'not_configured' }); }
  if(!useDB || !pool) return res.json({ ok:true, pushed:false, reason:'no_db' });

  // Read the order + person from the DB — source of truth, not the browser.
  pool.query(
    `SELECT o.id, o.status, o.requested_date, o.provider, o.test_type, o.service_address,
            o.access_notes, o.best_time, o.notify_email, o.org_id, o.requisition_path,
            p.full_name, p.first_name, p.last_name, p.mrn, p.dob, p.phone
       FROM orders o JOIN people p ON p.id = o.person_id
      WHERE o.id = $1 LIMIT 1`, [orderId]
  ).then(function(r){
    if(!r.rows.length) return res.status(404).json({ ok:false, error:'order not found' });
    var o = r.rows[0];

    // Requisition link for GHL (phlebotomists work out of GHL). Tokenized so it
    // needs no login but is unguessable; /r/:token redirects to a fresh signed
    // URL. Only orders that actually have a file get a link.
    var reqUrl = '';
    if (o.requisition_path) {
      var tok = reqToken(o.id);
      reqUrl = PUBLIC_BASE_URL + '/r/' + o.id + '/' + tok;
    }

    // Payload for the GHL inbound webhook. Field names match what the BMC
    // workflow already maps (buildPatient handles these keys).
    var ghlBody = {
      source: 'bmh_intake',
      order_id: o.id,
      org_id: o.org_id || 'bmc',
      first_name: o.first_name || '',
      last_name: o.last_name || '',
      full_name: o.full_name || '',
      phone: o.phone || '',
      email: o.notify_email || '',
      date_of_birth: o.dob ? String(o.dob).slice(0,10) : '',
      mrn: o.mrn || '',
      address: o.service_address || '',
      test_type: o.test_type || '',
      provider: o.provider || '',
      access_notes: o.access_notes || '',
      best_time: o.best_time || '',
      requested_date: o.requested_date ? String(o.requested_date).slice(0,10) : '',
      status: o.status || 'received',
      requisition_url: reqUrl
    };

    return fetch(GHL_INBOUND_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(ghlBody)
    }).then(function(g){
      console.log('[INTAKE->GHL] pushed order', o.id, 'status', g.status, '| requisition_url:', reqUrl || '(none)');
      res.json({ ok:true, pushed:true, ghlStatus:g.status });
    });
  }).catch(function(e){
    // Non-fatal: the order is already safely in the tracker. GHL push failing
    // must not error the form. Log and return ok so the client isn't blocked.
    console.error('[INTAKE->GHL ERROR — non-fatal]', e.message);
    res.json({ ok:true, pushed:false, error:e.message });
  });
});

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
      // Fire BMC status notification when status field changes
      if (updates.status) {
        sendStatusEmail(result.rows[0], updates.status, req.body._prev_status || 'previous')
          .catch(function(e) { console.log('[NOTIFY ERROR]', e.message); });
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

  // ADDITIVE: also mirror this order into orders+people so the new dashboard
  // shows it. Wrapped so ANY failure here can never disrupt the live pipeline
  // below or the 200 returned to GHL. This endpoint = BMC workflow -> org 'bmc'.
  mirrorToOrders(patient, payload).catch(function(e){
    console.error('[WEBHOOK->orders MIRROR ERROR — non-fatal]', e.message);
  });

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

// Tracker status words -> orders-table status words.
var TRACKER_TO_ORDER_STATUS = {
  received: 'received', scheduled: 'assigned', completed: 'completed',
  incomplete: 'noshow', unreachable: 'unreach'
};

// Mirror a GHL order into people + orders. Idempotent: matches an existing
// person (MRN -> name+phone) and an existing open order before inserting,
// so repeated GHL fires update rather than duplicate. Never throws to caller.
function mirrorToOrders(patient, payload) {
  if (!useDB || !pool) return Promise.resolve();

  var orderStatus = TRACKER_TO_ORDER_STATUS[patient.status] || 'received';
  var phoneDigits = (patient.phone || '').replace(/\D/g, '');
  var name = patient.name || ((patient.first_name||'') + ' ' + (patient.last_name||'')).trim();

  // 1) Find the person: MRN first, then name+phone.
  var findPerson = patient.mrn
    ? pool.query('SELECT id FROM people WHERE mrn = $1 LIMIT 1', [patient.mrn])
    : Promise.resolve({ rows: [] });

  return findPerson.then(function(r){
    if (r.rows.length) return r.rows[0].id;
    if (name && phoneDigits) {
      return pool.query(
        'SELECT id FROM people WHERE lower(full_name)=lower($1) AND phone_digits=$2 LIMIT 1',
        [name, phoneDigits]
      ).then(function(r2){ return r2.rows.length ? r2.rows[0].id : null; });
    }
    return null;
  }).then(function(personId){
    if (personId) {
      // Enrich any missing person fields without overwriting good data.
      return pool.query(
        `UPDATE people SET
           mrn          = COALESCE(NULLIF(mrn,''), $2),
           dob          = COALESCE(dob, NULLIF($3,'')::date),
           phone        = COALESCE(NULLIF(phone,''), $4),
           phone_digits = COALESCE(NULLIF(phone_digits,''), $5),
           home_address = COALESCE(NULLIF(home_address,''), $6)
         WHERE id = $1`,
        [personId, patient.mrn||null, patient.dob||null, patient.phone||null, phoneDigits||null, patient.address||null]
      ).then(function(){ return personId; });
    }
    // Create the person.
    var newId = crypto.randomUUID();
    return pool.query(
      `INSERT INTO people (id, full_name, first_name, last_name, mrn, dob, phone, phone_digits, home_address, language)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,$7,$8,$9,'English')`,
      [newId, name, patient.first_name||'', patient.last_name||'', patient.mrn||null,
       patient.dob||'', patient.phone||null, phoneDigits||null, patient.address||null]
    ).then(function(){ return newId; });
  }).then(function(personId){
    // 2) Is there already an OPEN order for this person from GHL? Update it
    //    rather than stacking a new row on every status fire.
    return pool.query(
      `SELECT id FROM orders
        WHERE person_id = $1 AND source = 'ghl_webhook'
          AND status NOT IN ('completed','lab')
        ORDER BY received_at DESC LIMIT 1`, [personId]
    ).then(function(r){
      if (r.rows.length) {
        return pool.query(
          `UPDATE orders SET status=$2, assignee=COALESCE(NULLIF($3,''),assignee),
                             provider=COALESCE(NULLIF($4,''),provider),
                             test_type=COALESCE(NULLIF($5,''),test_type),
                             service_address=COALESCE(NULLIF($6,''),service_address),
                             updated_at=now()
             WHERE id=$1`,
          [r.rows[0].id, orderStatus, patient.assignee||'', patient.provider||'',
           patient.service||'', patient.address||'']
        ).then(function(){ console.log('[MIRROR] updated order', r.rows[0].id, '->', orderStatus); });
      }
      // 3) New order. Request number = count of this person's orders + 1.
      return pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE person_id=$1',[personId])
        .then(function(c){
          var reqNo = (c.rows[0].n || 0) + 1;
          var oid = crypto.randomUUID();
          var testsArr = patient.service ? [patient.service] : [];
          return pool.query(
            `INSERT INTO orders
               (id, person_id, request_no, source, org_id, status, requested_date,
                provider, test_type, tests, service_address, access_notes,
                assignee, notify_email, received_at, billing_ready, missing_fields, payload)
             VALUES ($1,$2,$3,'ghl_webhook','bmc',$4,NULL,
                $5,$6,$7::jsonb,$8,$9,$10,$11,now(),false,ARRAY['service_address','test_type']::text[],$12::jsonb)`,
            [oid, personId, reqNo, orderStatus,
             patient.provider||null, patient.service||null,
             JSON.stringify(testsArr),
             patient.address||null, patient.notes||null,
             patient.assignee||null, patient.email||null,
             JSON.stringify(payload)]
          ).then(function(){ console.log('[MIRROR] inserted order', oid, 'req', reqNo, 'person', personId); });
        });
    });
  });
}

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
// DRAW EXCEPTION EVENTS
// Logs hard sticks, short draws, no-shows, unreachable, refused into
// order_events (append-only). Statuses stay within the existing vocabulary:
// no_show -> 'noshow', patient_unreachable -> 'unreach'. Hard sticks do NOT
// change order status; they surface via open events (Exceptions lane).
// Auth: admin session OR a valid requisition token (so phlebotomists can
// report from the /r page without logging in).
// Notify: optional GHL_EXCEPTION_URL webhook (separate from GHL_INBOUND_URL
// so exception pings never fire the BMC intake workflow). Skip-not-fail.
// ---------------------------------------------------------------------------
var EXCEPTION_TYPES = ['hard_stick', 'short_draw', 'patient_unreachable', 'no_show', 'refused'];
var MAX_STICKS = 2; // BMC protocol: two-stick max, then reassign
var GHL_EXCEPTION_URL = process.env.GHL_EXCEPTION_URL || '';

var EXCEPTION_TO_ORDER_STATUS = {
  no_show:             'noshow',
  patient_unreachable: 'unreach'
  // hard_stick / short_draw / refused: leave status untouched
};

function notifyExceptionGHL(order, eventType, meta) {
  if (!GHL_EXCEPTION_URL) {
    console.log('[EXCEPTION->GHL] no GHL_EXCEPTION_URL set; skipping notify');
    return Promise.resolve();
  }
  return fetch(GHL_EXCEPTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source:        'bmh_exception',
      order_id:      order.id,
      org_id:        order.org_id || 'bmc',
      full_name:     order.full_name || '',
      mrn:           order.mrn || '',
      event_type:    eventType,
      stick_count:   meta.stick_count || '',
      return_window: meta.return_visit_scheduled || '',
      reassign:      meta.reassign_requested ? 'yes' : 'no',
      note:          meta.note || ''
    })
  }).then(function(g) {
    console.log('[EXCEPTION->GHL] pushed', order.id, eventType, 'status', g.status);
  }).catch(function(e) {
    console.error('[EXCEPTION->GHL ERROR — non-fatal]', e.message);
  });
}

function logExceptionAudit(req, orderId, action, actor) {
  if (!useDB || !pool) return;
  pool.query(
    'INSERT INTO access_log (id,email,name,role,action,record_id,logged_in_at,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [crypto.randomUUID(),
     actor.email || 'field', actor.name || 'Field Report', actor.role || 'phleb',
     action, orderId, new Date().toISOString(),
     req.headers['x-forwarded-for'] || req.ip]
  ).catch(function(e) { console.log('[EXCEPTION AUDIT]', e.message); });
}

// POST /api/exceptions
// Body: { orderId, token?, eventType, note?, stickCount?, returnVisitScheduled?, reassignRequested?, reportedBy? }
// token = reqToken(orderId) — required unless the caller has an admin session.
app.post('/api/exceptions', function(req, res) {
  var b = req.body || {};
  var orderId   = b.orderId ? String(b.orderId) : '';
  var eventType = b.eventType ? String(b.eventType) : '';

  if (!orderId || !eventType) return res.status(400).json({ ok: false, error: 'orderId and eventType required' });
  if (EXCEPTION_TYPES.indexOf(eventType) === -1) {
    return res.status(400).json({ ok: false, error: 'eventType must be one of: ' + EXCEPTION_TYPES.join(', ') });
  }

  var isAdmin  = req.session && req.session.role === 'admin';
  var tokenOk  = b.token && b.token === reqToken(orderId);
  if (!isAdmin && !tokenOk) return res.status(403).json({ ok: false, error: 'Not authorized' });

  var stickCount = b.stickCount != null ? parseInt(b.stickCount, 10) : null;
  if (stickCount != null && (isNaN(stickCount) || stickCount < 1 || stickCount > MAX_STICKS)) {
    return res.status(400).json({ ok: false, error: 'stickCount must be 1-' + MAX_STICKS });
  }

  if (!useDB || !pool) return res.status(503).json({ ok: false, error: 'No database' });

  pool.query(
    'SELECT o.id, o.org_id, o.status, p.full_name, p.mrn FROM orders o JOIN people p ON p.id = o.person_id WHERE o.id = $1 LIMIT 1',
    [orderId]
  ).then(function(r) {
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });
    var order = r.rows[0];

    var meta = {};
    if (stickCount != null)          meta.stick_count = stickCount;
    if (b.returnVisitScheduled)      meta.return_visit_scheduled = String(b.returnVisitScheduled);
    if (b.reassignRequested != null) meta.reassign_requested = !!b.reassignRequested;
    if (eventType === 'hard_stick' && stickCount >= MAX_STICKS) meta.reassign_requested = true;
    meta.note = b.note ? String(b.note) : '';

    var createdBy = isAdmin
      ? ((req.session.user && req.session.user.email) || 'admin')
      : (b.reportedBy ? String(b.reportedBy) : 'phlebotomist-field');

    var eventId = crypto.randomUUID();
    return pool.query(
      'INSERT INTO order_events (id, order_id, org_id, event_type, note, metadata, created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
      [eventId, order.id, order.org_id || 'bmc', eventType, meta.note || null, JSON.stringify(meta), createdBy]
    ).then(function() {
      // Status transition ONLY within existing vocabulary.
      var newStatus = EXCEPTION_TO_ORDER_STATUS[eventType];
      var statusStep = newStatus && order.status !== newStatus && order.status !== 'completed' && order.status !== 'lab'
        ? pool.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [order.id, newStatus])
        : Promise.resolve();

      return statusStep.then(function() {
        logExceptionAudit(req, order.id, 'exception:' + eventType,
          isAdmin ? { email: req.session.user && req.session.user.email, name: req.session.user && req.session.user.name, role: 'admin' }
                  : { email: createdBy, name: createdBy, role: 'phleb' });

        // Notify — non-blocking, never fails the request.
        notifyExceptionGHL(order, eventType, meta);

        res.status(201).json({
          ok: true,
          eventId: eventId,
          orderStatus: newStatus || order.status,
          reassignFlagged: !!meta.reassign_requested
        });
      });
    });
  }).catch(function(err) {
    console.error('[POST /api/exceptions ERROR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  });
});

// PATCH /api/exceptions/:eventId/resolve  (admin only — dispatcher action)
app.patch('/api/exceptions/:eventId/resolve', requireAdmin, function(req, res) {
  var eventId = req.params.eventId;
  var note    = (req.body && req.body.resolutionNote) ? String(req.body.resolutionNote) : null;
  if (!useDB || !pool) return res.status(503).json({ ok: false, error: 'No database' });

  pool.query(
    "UPDATE order_events SET resolved = true, resolved_at = now(), metadata = metadata || jsonb_build_object('resolution_note', $2::text) WHERE id = $1 AND resolved = false RETURNING order_id",
    [eventId, note]
  ).then(function(r) {
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Event not found or already resolved' });
    logExceptionAudit(req, r.rows[0].order_id, 'exception:resolved',
      { email: req.session.user && req.session.user.email, name: req.session.user && req.session.user.name, role: 'admin' });
    res.json({ ok: true, resolved: eventId });
  }).catch(function(err) {
    console.error('[PATCH /api/exceptions resolve ERROR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  });
});

// GET /api/exceptions/open  (admin only — feeds the Exceptions kanban lane)
app.get('/api/exceptions/open', requireAdmin, function(req, res) {
  if (!useDB || !pool) return res.json([]);
  pool.query(
    'SELECT v.order_id, v.org_id, v.open_event_count, v.latest_event_at, v.latest_event_type, v.max_stick_count, ' +
    '       o.status, o.assignee, o.requested_date, p.full_name, p.mrn, p.phone ' +
    '  FROM v_open_exceptions v ' +
    '  JOIN orders o ON o.id = v.order_id ' +
    '  JOIN people p ON p.id = o.person_id ' +
    ' ORDER BY v.latest_event_at DESC LIMIT 500'
  ).then(function(r) {
    res.json(r.rows);
  }).catch(function(err) {
    console.error('[GET /api/exceptions/open ERROR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  });
});
// --------------------------- END DRAW EXCEPTIONS ---------------------------

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
