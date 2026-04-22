const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_URL = process.env.DATABASE_URL || '';
const TENANT_ID = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bmh-admin-2026';
const BASE_URL = process.env.BASE_URL || 'https://bmh-tracker-production.up.railway.app';
const REDIRECT_URI = BASE_URL + '/auth/callback';

console.log('[ENV] DATABASE_URL present:', !!DB_URL);
console.log('[ENV] AZURE configured:', !!TENANT_ID && !!CLIENT_ID);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bmh-session-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

let useDB = false;
let pool = null;
let memPatients = [];

if (DB_URL && DB_URL.startsWith('postgresql')) {
  try {
    pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    useDB = true;
    console.log('[DB] Pool created');
  } catch (e) { console.error('[DB] Error:', e.message); }
}

async function initDB() {
  if (!useDB) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, source TEXT DEFAULT 'manual', received_at TIMESTAMPTZ DEFAULT NOW(), name TEXT NOT NULL, dob TEXT, provider TEXT, service TEXT, phone TEXT, email TEXT, address TEXT, assignee TEXT, order_date TEXT, status TEXT DEFAULT 'received', appt_date TEXT, appt_time TEXT, completed_date TEXT, completed_time TEXT, incomplete_reason TEXT, unreachable_reason TEXT, notes TEXT, raw JSONB)`);
  console.log('[DB] Ready');
}

function rowToPatient(r) {
  return { id: r.id, source: r.source, receivedAt: r.received_at, name: r.name, dob: r.dob||'', provider: r.provider||'', service: r.service||'', phone: r.phone||'', email: r.email||'', address: r.address||'', assignee: r.assignee||'', orderDate: r.order_date||'', status: r.status||'received', apptDate: r.appt_date||'', apptTime: r.appt_time||'', completedDate: r.completed_date||'', completedTime: r.completed_time||'', incompleteReason: r.incomplete_reason||'', unreachableReason: r.unreachable_reason||'', notes: r.notes||'', _raw: r.raw };
}

async function getAllPatients() {
  if (useDB) { const r = await pool.query('SELECT * FROM patients ORDER BY received_at DESC'); return r.rows.map(rowToPatient); }
  return memPatients;
}

async function insertPatient(p) {
  if (useDB) {
    await pool.query('INSERT INTO patients (id,source,received_at,name,dob,provider,service,phone,email,address,assignee,order_date,status,appt_date,appt_time,completed_date,completed_time,incomplete_reason,unreachable_reason,notes,raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (id) DO NOTHING',
      [p.id,p.source,p.receivedAt,p.name,p.dob,p.provider,p.service,p.phone,p.email,p.address||'',p.assignee||'',p.orderDate,p.status,p.apptDate,p.apptTime,p.completedDate,p.completedTime,p.incompleteReason,p.unreachableReason,p.notes,p._raw?JSON.stringify(p._raw):null]);
  } else { memPatients.unshift(p); }
}

async function updatePatient(id, d) {
  if (useDB) {
    await pool.query('UPDATE patients SET status=COALESCE($1,status),appt_date=COALESCE($2,appt_date),appt_time=COALESCE($3,appt_time),completed_date=COALESCE($4,completed_date),completed_time=COALESCE($5,completed_time),incomplete_reason=COALESCE($6,incomplete_reason),unreachable_reason=COALESCE($7,unreachable_reason),notes=COALESCE($8,notes),assignee=COALESCE($9,assignee),provider=COALESCE($10,provider) WHERE id=$11',
      [d.status,d.apptDate,d.apptTime,d.completedDate,d.completedTime,d.incompleteReason,d.unreachableReason,d.notes,d.assignee,d.provider,id]);
    const r = await pool.query('SELECT * FROM patients WHERE id=$1',[id]);
    return r.rows.length ? rowToPatient(r.rows[0]) : null;
  } else {
    const i = memPatients.findIndex(p=>p.id===id);
    if(i>-1){memPatients[i]={...memPatients[i],...d};return memPatients[i];}
    return null;
  }
}

async function removePatient(id) {
  if (useDB) { await pool.query('DELETE FROM patients WHERE id=$1',[id]); }
  else { memPatients = memPatients.filter(p=>p.id!==id); }
}

function requireAdmin(req,res,next){if(req.session&&req.session.role==='admin')return next();res.redirect('/login')}
function requireAuth(req,res,next){if(req.session&&(req.session.role==='admin'||req.session.role==='client'))return next();res.redirect('/login')}

const GHL_FIELD_MAP = {
  firstName:['first_name','firstName'], lastName:['last_name','lastName'],
  dob:['date_of_birth','dob','birthdate'], phone:['phone','phone_number'],
  email:['email'], address:['address'], mrn:['number_14fga','mrn','MRN'],
  service:['test_ordered','service'], provider:['ordering_provider','provider'],
  assignee:['appointment_owner','assigned_to','assignee'],
  notes:['notes','special_instructions','additional_information'],
};

function extractField(payload,keys){
  if(!payload||!keys)return'';
  for(const key of keys){
    if(payload[key]!==undefined&&payload[key]!==null&&payload[key]!=='')return String(payload[key]);
    if(payload.customData?.[key])return String(payload.customData[key]);
    if(payload.contact?.[key])return String(payload.contact[key]);
  }
  return'';
}

function buildPatient(payload){
  const now=new Date();
  const fn=extractField(payload,GHL_FIELD_MAP.firstName);
  const ln=extractField(payload,GHL_FIELD_MAP.lastName);
  const name=(fn+' '+ln).trim()||'Unknown Patient';
  const mrn=extractField(payload,GHL_FIELD_MAP.mrn);
  const notes=extractField(payload,GHL_FIELD_MAP.notes);
  const notesOut=mrn?('MRN: '+mrn+(notes?' | '+notes:'')):notes;
  return {id:crypto.randomUUID(),source:'ghl_webhook',receivedAt:now.toISOString(),name,dob:extractField(payload,GHL_FIELD_MAP.dob),provider:extractField(payload,GHL_FIELD_MAP.provider),service:extractField(payload,GHL_FIELD_MAP.service),phone:extractField(payload,GHL_FIELD_MAP.phone),email:extractField(payload,GHL_FIELD_MAP.email),address:extractField(payload,GHL_FIELD_MAP.address),assignee:extractField(payload,GHL_FIELD_MAP.assignee),orderDate:now.toISOString().slice(0,10),status:'received',apptDate:'',apptTime:'',completedDate:'',completedTime:'',incompleteReason:'',unreachableReason:'',notes:notesOut,_raw:payload};
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BMH Patient Tracker</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}
.mark{width:56px;height:56px;background:#00c5a1;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px}
h1{font-size:22px;font-weight:700;color:#0a1628;margin-bottom:6px}
p{font-size:14px;color:#8896ab;margin-bottom:32px}
.ms{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:13px 20px;background:#0078d4;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;margin-bottom:20px;font-family:inherit}
.ms:hover{background:#106ebe}
.div{display:flex;align-items:center;gap:12px;margin:16px 0;color:#8896ab;font-size:12px}
.div::before,.div::after{content:'';flex:1;height:1px;background:#e4eaf2}
input{width:100%;padding:11px 14px;border:1px solid #e4eaf2;border-radius:8px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit}
input:focus{border-color:#00c5a1}
.abtn{width:100%;padding:11px;background:#0a1628;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.err{color:#e8453c;font-size:13px;margin-top:10px}
</style>
</head>
<body>
<div class="card">
<div class="mark">&#128203;</div>
<h1>BMH Patient Tracker</h1>
<p>Beyond Mobile Health</p>
<a class="ms" href="/auth/microsoft">
<svg width="20" height="20" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
Sign in with Microsoft
</a>
<div class="div">or admin access</div>
<form method="POST" action="/auth/admin">
<input type="password" name="password" placeholder="Admin password" required>
<button class="abtn" type="submit">Admin Login</button>
ERROR_PLACEHOLDER
</form>
</div>
</body>
</html>`;

app.get('/login',(req,res)=>{
  if(req.session&&req.session.role)return res.redirect('/');
  res.send(LOGIN_PAGE.replace('ERROR_PLACEHOLDER',req.query.error?'<div class="err">Invalid password. Try again.</div>':''));
});

app.post('/auth/admin',(req,res)=>{
  if(req.body.password===ADMIN_PASSWORD){
    req.session.role='admin';
    req.session.user={name:'Admin',email:'admin@beyondmobilehealth.com'};
    res.redirect('/');
  } else { res.redirect('/login?error=1'); }
});

app.get('/auth/microsoft',(req,res)=>{
  if(!TENANT_ID||!CLIENT_ID)return res.send('<p>Azure SSO not configured. Add AZURE_TENANT_ID and AZURE_CLIENT_ID to Railway variables.</p>');
  const params=new URLSearchParams({client_id:CLIENT_ID,response_type:'code',redirect_uri:REDIRECT_URI,scope:'openid profile email',response_mode:'query',state:crypto.randomBytes(16).toString('hex')});
  res.redirect('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/authorize?'+params);
});

app.get('/auth/callback',async(req,res)=>{
  const{code,error}=req.query;
  if(error||!code)return res.redirect('/login?error=1');
  try{
    const tr=await fetch('https://login.microsoftonline.com/'+TENANT_ID+'/oauth2/v2.0/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,code,redirect_uri:REDIRECT_URI,grant_type:'authorization_code'})});
    const td=await tr.json();
    if(td.error)throw new Error(td.error_description);
    const payload=JSON.parse(Buffer.from(td.id_token.split('.')[1],'base64').toString());
    req.session.role='client';
    req.session.user={name:payload.name||payload.preferred_username,email:payload.email||payload.preferred_username};
    res.redirect('/');
  }catch(err){console.error('[AUTH]',err.message);res.redirect('/login?error=1');}
});

app.get('/auth/logout',(req,res)=>{req.session.destroy();res.redirect('/login')});

app.get('/',requireAuth,(req,res)=>{
  if(req.session.role==='admin')return res.sendFile(path.join(__dirname,'public','index.html'));
  res.sendFile(path.join(__dirname,'public','client.html'));
});

app.get('/api/patients',requireAuth,async(req,res)=>{
  try{res.json(await getAllPatients())}catch(err){res.status(500).json({error:err.message})}
});
app.patch('/api/patients/:id',requireAdmin,async(req,res)=>{
  try{res.json(await updatePatient(req.params.id,req.body)||{error:'Not found'})}catch(err){res.status(500).json({error:err.message})}
});
app.post('/api/patients',requireAdmin,async(req,res)=>{
  try{
    const d=req.body;
    const p={id:d.id||crypto.randomUUID(),source:d.source||'manual',receivedAt:d.receivedAt||new Date().toISOString(),name:d.name||'Unknown',dob:d.dob||'',provider:d.provider||'',service:d.service||'',phone:d.phone||'',email:d.email||'',address:d.address||'',assignee:d.assignee||'',orderDate:d.orderDate||new Date().toISOString().slice(0,10),status:d.status||'received',apptDate:d.apptDate||'',apptTime:d.apptTime||'',completedDate:d.completedDate||'',completedTime:d.completedTime||'',incompleteReason:d.incompleteReason||'',unreachableReason:d.unreachableReason||'',notes:d.notes||'',_raw:null};
    await insertPatient(p);res.status(201).json(p);
  }catch(err){res.status(500).json({error:err.message})}
});
app.delete('/api/patients/:id',requireAdmin,async(req,res)=>{
  try{await removePatient(req.params.id);res.json({success:true})}catch(err){res.status(500).json({error:err.message})}
});
app.get('/api/me',requireAuth,(req,res)=>res.json({role:req.session.role,user:req.session.user}));
app.get('/api/health',(req,res)=>res.json({status:'ok',storage:useDB?'supabase':'memory'}));

app.post('/webhook/ghl',async(req,res)=>{
  try{const p=buildPatient(req.body);await insertPatient(p);console.log('[WEBHOOK]',p.name);res.status(200).json({success:true,patientId:p.id})}
  catch(err){res.status(500).json({error:err.message})}
});
app.get('/webhook/test',async(req,res)=>{
  try{const p=buildPatient({first_name:'Test',last_name:'Patient',date_of_birth:'1980-01-01',phone:'+16175550000',number_14fga:'TEST001'});p.source='test';await insertPatient(p);res.json({message:'Test patient injected',patient:p})}
  catch(err){res.status(500).json({error:err.message})}
});

app.use(express.static(path.join(__dirname,'public')));

async function start(){
  try{await initDB()}catch(err){console.error('[DB INIT]',err.message);useDB=false}
  app.listen(PORT,()=>console.log('BMH Tracker on port '+PORT+' | Storage: '+(useDB?'Supabase':'Memory')));
}
start();
