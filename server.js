const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const payrollWebhook = require('./payroll-webhook');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_URL = process.env.DATABASE_URL || '';
const TENANT_ID = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
const BASE_URL = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] AZURE configured:', !!TENANT_ID && !!CLIENT_ID);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'bmh-session-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

let useDB = false;
let pool = null;
let memPatients = [];

if (DB_URL) {
  pool = new Pool({
    connectionString: DB_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  useDB = true;
}

function extractField(obj, possibleKeys) {
  if (!obj || typeof obj !== 'object') return null;

  for (const key of possibleKeys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }

  return null;
}

function normalizeStatus(status) {
  if (!status) return 'received';

  const value = String(status).trim().toLowerCase();

  if (value.includes('confirm')) return 'confirmed';
  if (value.includes('schedule')) return 'scheduled';
  if (value.includes('show')) return 'showed';
  if (value.includes('complete')) return 'completed';
  if (value.includes('cancel')) return 'cancelled';
  if (value.includes('no show')) return 'no_show';
  if (value.includes('miss')) return 'missed_draw';

  return value.replace(/\s+/g, '_');
}

function buildPatientRecord(payload) {
  const rawStatus =
    extractField(payload, [
      'status',
      'Status',
      'SCHEDULING STATUS',
      'appointments status',
      'appointment_status'
    ]) || 'received';

  return {
    id: crypto.randomUUID(),
    first_name:
      extractField(payload, ['first_name', 'First Name', 'firstName']) || '',
    last_name:
      extractField(payload, ['last_name', 'Last Name', 'lastName']) || '',
    full_name:
      extractField(payload, ['full_name', 'Full Name', 'name', 'Name']) || '',
    phone:
      extractField(payload, ['phone', 'Phone', 'mobile', 'Mobile']) || '',
    email:
      extractField(payload, ['email', 'Email']) || '',
    address:
      extractField(payload, ['address', 'Address']) || '',
    zip_code:
      extractField(payload, ['zip', 'Zip', 'zip_code', 'PT_ZipCode']) || '',
    test_type:
      extractField(payload, ['test_type', 'Test Type', 'requested_test']) || '',
    requested_date:
      extractField(payload, ['requested_date', 'Requested Date']) || '',
    phlebotomist:
      extractField(payload, ['phlebotomist', 'Phlebotomist']) || '',
    raw_status: rawStatus,
    status: normalizeStatus(rawStatus),
    source: extractField(payload, ['source', 'Source']) || 'webhook',
    payload,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

app.get('/', (req, res) => {
  res.status(200).json({
    app: 'BMH Tracker',
    status: 'running',
    database: useDB ? 'enabled' : 'memory'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const patient = buildPatientRecord(payload);

    if (useDB && pool) {
      await pool.query(
        `
        INSERT INTO patients (
          id,
          first_name,
          last_name,
          full_name,
          phone,
          email,
          address,
          zip_code,
          test_type,
          requested_date,
          phlebotomist,
          raw_status,
          status,
          source,
          payload,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17
        )
        `,
        [
          patient.id,
          patient.first_name,
          patient.last_name,
          patient.full_name,
          patient.phone,
          patient.email,
          patient.address,
          patient.zip_code,
          patient.test_type,
          patient.requested_date,
          patient.phlebotomist,
          patient.raw_status,
          patient.status,
          patient.source,
          patient.payload,
          patient.created_at,
          patient.updated_at
        ]
      );
    } else {
      memPatients.push(patient);
    }

    res.status(200).json({
      success: true,
      message: 'Webhook received',
      patient
    });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/payroll-webhook', payrollWebhook);

app.get('/patients', async (req, res) => {
  try {
    if (useDB && pool) {
      const result = await pool.query(
        `SELECT * FROM patients ORDER BY created_at DESC LIMIT 500`
      );

      return res.status(200).json(result.rows);
    }

    res.status(200).json(memPatients);
  } catch (error) {
    console.error('[PATIENTS ERROR]', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

app.listen(PORT, () => {
  console.log(`BMH Tracker running on port ${PORT}`);
});
