// ============================================================
// BMH PAYROLL WEBHOOK HANDLER
// Beyond Mobile Health — GHL → Supabase Collections Pipeline
// Deploy on Railway alongside existing BMH Patient Tracker
// ============================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CALENDAR → DRAW TYPE MAPPING ──────────────────────────
// Map every GHL calendar name to a draw type for rate lookup
const CALENDAR_DRAW_TYPE = {
  'BMH4Boston Medical':           'BMC',
  'Boston Phlebs':                'BMC',
  'Boston Medical _Gariactric Pt':'BMC',
  'Appointment Kit Collection':   'private',
  'Private BMH':                  'private',
  'Mobile Phlebotomy Concierge':  'private',
  'PREMIER MOBILE LAB SERVICES':  'private',
  'Dr. Ahn\'s Clinic':            'private',
  'Jinfiniti Events':             'event',
  'Outreach Marketing Event':     'event',
  'In-Office Collection':         'private',
};

// Default fallback if calendar not in map
function getDrawType(calendarName) {
  if (!calendarName) return 'private';
  for (const [key, type] of Object.entries(CALENDAR_DRAW_TYPE)) {
    if (calendarName.toLowerCase().includes(key.toLowerCase())) return type;
  }
  if (calendarName.toLowerCase().includes('bmc')) return 'BMC';
  if (calendarName.toLowerCase().includes('event')) return 'event';
  return 'private';
}

// ── PHLEBOTOMIST NAME → ID LOOKUP ─────────────────────────
async function resolvePhlebotomist(name) {
  if (!name) return null;
  const cleanName = name.trim().toLowerCase();
  const { data, error } = await supabase
    .from('phlebotomists')
    .select('id, full_name')
    .eq('is_active', true);
  if (error || !data) return null;
  // Exact match first
  let match = data.find(p => p.full_name.toLowerCase() === cleanName);
  if (match) return match.id;
  // Partial match (first name or last name)
  match = data.find(p =>
    p.full_name.toLowerCase().includes(cleanName) ||
    cleanName.includes(p.full_name.toLowerCase().split(' ')[0])
  );
  return match ? match.id : null;
}

// ── RATE LOOKUP ───────────────────────────────────────────
async function getRate(phlebotomistId, drawType) {
  const { data, error } = await supabase
    .from('phlebotomist_rates')
    .select('rate, rate_type')
    .eq('phlebotomist_id', phlebotomistId)
    .eq('draw_type', drawType)
    .single();
  if (error || !data) {
    // Fallback to any rate for this phlebotomist
    const { data: fallback } = await supabase
      .from('phlebotomist_rates')
      .select('rate, rate_type')
      .eq('phlebotomist_id', phlebotomistId)
      .limit(1)
      .single();
    return fallback || { rate: 35.00, rate_type: 'per_draw' };
  }
  return data;
}

// ── PAY PERIOD LOOKUP ─────────────────────────────────────
async function getPayPeriod(appointmentDate) {
  const { data, error } = await supabase
    .from('pay_periods')
    .select('id, period_number')
    .lte('start_date', appointmentDate)
    .gte('end_date', appointmentDate)
    .single();
  if (error || !data) return null;
  return data;
}

// ── MAIN WEBHOOK HANDLER ──────────────────────────────────
// POST /webhook/ghl/appointment-completed
router.post('/ghl/appointment-completed', async (req, res) => {
  const payload = req.body;

  // Log raw payload immediately
  await supabase.from('webhook_log').insert({
    source: 'GHL',
    event_type: 'appointment.completed',
    raw_payload: payload,
    processed: false
  });

  try {
    // ── Extract fields from GHL payload ──────────────────
    // GHL webhook payload structure (appointment object)
    const appointment = payload.appointment || payload;

    const ghlAppointmentId = appointment.id || appointment.appointmentId;
    const calendarName     = appointment.calendarName || appointment.calendar_name || '';
    const appointmentDate  = appointment.startTime
      ? new Date(appointment.startTime).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    const appointmentTime  = appointment.startTime
      ? new Date(appointment.startTime).toTimeString().split(' ')[0]
      : null;

    // Contact/patient fields
    const contact          = payload.contact || {};
    const patientName      = contact.lastName || contact.last_name || appointment.title || '';
    const ghlContactId     = contact.id || contact.contactId || '';

    // THE KEY FIELD — assigned phlebotomist custom field
    // GHL sends custom fields as: contact.assigned_phlebotomist
    const phlebotomistName =
      contact.assigned_phlebotomist ||
      contact.customField?.assigned_phlebotomist ||
      payload.customData?.assigned_phlebotomist ||
      appointment.assignedPhlebotomist ||
      null;

    // ── Dedup check ───────────────────────────────────────
    if (ghlAppointmentId) {
      const { data: existing } = await supabase
        .from('collections')
        .select('id')
        .eq('ghl_appointment_id', ghlAppointmentId)
        .single();
      if (existing) {
        return res.status(200).json({ message: 'Duplicate — already processed', id: existing.id });
      }
    }

    // ── Resolve phlebotomist ──────────────────────────────
    const phlebotomistId = await resolvePhlebotomist(phlebotomistName);

    // ── Classify draw ─────────────────────────────────────
    const drawType = getDrawType(calendarName);

    // ── Get rate ──────────────────────────────────────────
    let rateData = { rate: 35.00, rate_type: 'per_draw' };
    if (phlebotomistId) {
      rateData = await getRate(phlebotomistId, drawType);
    }

    // ── Get pay period ────────────────────────────────────
    const payPeriod = await getPayPeriod(appointmentDate);

    // ── Insert collection record ──────────────────────────
    const { data: collection, error: insertError } = await supabase
      .from('collections')
      .insert({
        phlebotomist_id:    phlebotomistId,
        pay_period_id:      payPeriod?.id || null,
        ghl_appointment_id: ghlAppointmentId,
        ghl_calendar:       calendarName,
        ghl_contact_id:     ghlContactId,
        patient_name:       patientName,
        appointment_date:   appointmentDate,
        appointment_time:   appointmentTime,
        draw_type:          drawType,
        source_calendar:    calendarName,
        draw_count:         rateData.rate_type === 'per_draw' ? 1 : null,
        hours_worked:       rateData.rate_type === 'per_hour' ? 0 : null, // hours updated manually for events
        rate_applied:       rateData.rate,
        rate_type:          rateData.rate_type,
        status:             phlebotomistId ? 'pending' : 'unassigned' // flag if no phlebotomist found
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // ── Mark webhook as processed ─────────────────────────
    await supabase
      .from('webhook_log')
      .update({ processed: true })
      .eq('raw_payload->>id', ghlAppointmentId);

    // ── Flag unassigned draws for manual review ───────────
    if (!phlebotomistId) {
      console.warn(`[BMH PAYROLL] Unassigned draw — phlebotomist "${phlebotomistName}" not matched. Appointment: ${ghlAppointmentId}`);
    }

    return res.status(200).json({
      success: true,
      collection_id:   collection.id,
      phlebotomist_id: phlebotomistId,
      draw_type:       drawType,
      rate_applied:    rateData.rate,
      pay_period:      payPeriod?.period_number || 'not found',
      warning:         !phlebotomistId ? 'Phlebotomist not matched — manual review required' : null
    });

  } catch (err) {
    console.error('[BMH PAYROLL WEBHOOK ERROR]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── UPDATE HOURS (for event/hourly draws) ─────────────────
// PATCH /webhook/ghl/update-hours/:collectionId
router.patch('/ghl/update-hours/:collectionId', async (req, res) => {
  const { collectionId } = req.params;
  const { hours_worked } = req.body;
  if (!hours_worked || isNaN(hours_worked)) {
    return res.status(400).json({ error: 'hours_worked required' });
  }
  const { data, error } = await supabase
    .from('collections')
    .update({ hours_worked: parseFloat(hours_worked), updated_at: new Date() })
    .eq('id', collectionId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, collection: data });
});

// ── HEALTH CHECK ──────────────────────────────────────────
router.get('/ghl/health', (req, res) => {
  res.json({ status: 'BMH Payroll Webhook — Online', timestamp: new Date().toISOString() });
});

module.exports = router;
