/* Colectas PWA - app.js
   Decisiones:
   - Folio mensual por estación
   - Firma: PIN + manuscrita
   - Usuarios administrables
   - Exportación CSV manual
*/

const DB_NAME = "colectas_pwa_db";
const DB_VER = 1;

const STATE = {
  config: null,        // { stationCode, createdAt }
  users: [],           // [{ id, name, pinHash, role }]
  session: null,       // { userId, name, role }
  deposits: [],        // [{ id, stationCode, folio, date, time, isla, turno, monto, userId, userName, sigDataUrl, status, createdAt, canceledAt, canceledBy }]
  showCanceled: false,
  installPrompt: null,
};

// --------- Utilidades (Business-grade) ----------
function now() { return new Date(); }

function pad(n, len=2){ return String(n).padStart(len, "0"); }

function localDateYYYYMMDD(d = now()){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function localTimeHHMM(d = now()){
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function monthKey(d = now()){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; // YYYY-MM
}

function money2(n){
  const x = Math.round(Number(n) * 100) / 100;
  return x.toFixed(2);
}

function normalizeName(name){
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\p{L}/gu, c => c.toUpperCase());
}

function escapeHTML(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// Hash simple (no criptografía fuerte): suficiente para PIN local.
// Si quieres nivel corporativo, se migra a WebCrypto PBKDF2.
async function pinHash(pin){
  const txt = new TextEncoder().encode("colectas|" + String(pin));
  const buf = await crypto.subtle.digest("SHA-256", txt);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}

function uuid(){
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function banner(type, msg){
  const el = document.getElementById("banner");
  el.classList.remove("hidden");
  el.className = "no-print p-3 rounded-xl border text-sm";
  if(type === "error") el.classList.add("bg-red-50","border-red-200","text-red-800");
  if(type === "ok") el.classList.add("bg-emerald-50","border-emerald-200","text-emerald-900");
  if(type === "info") el.classList.add("bg-sky-50","border-sky-200","text-sky-900");
  el.textContent = msg;
  setTimeout(()=>{ el.classList.add("hidden"); }, 3500);
}

function requireSession(){
  if(!STATE.session) throw new Error("Sesión no iniciada");
}

function isSupervisor(){
  return STATE.session?.role === "SUPERVISOR";
}

// --------- IndexedDB (persistencia offline) ----------
function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains("kv")){
        db.createObjectStore("kv"); // key-value
      }
      if(!db.objectStoreNames.contains("users")){
        db.createObjectStore("users", { keyPath: "id" });
      }
      if(!db.objectStoreNames.contains("deposits")){
        db.createObjectStore("deposits", { keyPath: "id" });
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function kvGet(key){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("kv","readonly");
    const st = tx.objectStore("kv");
    const req = st.get(key);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> reject(req.error);
  });
}

async function kvSet(key, value){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("kv","readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

async function usersAll(){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("users","readonly");
    const st = tx.objectStore("users");
    const req = st.getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = ()=> reject(req.error);
  });
}

async function userPut(user){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("users","readwrite");
    tx.objectStore("users").put(user);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

async function userDelete(id){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("users","readwrite");
    tx.objectStore("users").delete(id);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

async function depositsAll(){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("deposits","readonly");
    const st = tx.objectStore("deposits");
    const req = st.getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = ()=> reject(req.error);
  });
}

async function depositPut(dep){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("deposits","readwrite");
    tx.objectStore("deposits").put(dep);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

async function depositDelete(id){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("deposits","readwrite");
    tx.objectStore("deposits").delete(id);
    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

// --------- Folio mensual por estación ----------
async function nextFolio(stationCode){
  const mk = monthKey();
  const key = `folio:${stationCode}:${mk}`;
  const current = (await kvGet(key)) || 0;
  const next = current + 1;
  await kvSet(key, next);
  // Formato: STATION-YYYY-MM-000001
  return `${stationCode}-${mk}-${String(next).padStart(6,"0")}`;
}

async function resetMonthFolio(stationCode, supUserName){
  const mk = monthKey();
  const key = `folio:${stationCode}:${mk}`;
  await kvSet(key, 0);
  // bitácora ligera:
  await kvSet(`audit:resetfolio:${stationCode}:${mk}:${Date.now()}`, {
    by: supUserName,
    at: new Date().toISOString(),
  });
}

// --------- Firma (canvas) ----------
function setupSignature(){
  const canvas = document.getElementById("sigCanvas");
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let last = null;

  function resize(){
    // Ajuste a ancho real para que no se “estire”
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width * ratio);
    const h = Math.floor(canvas.height * ratio);
    const old = canvas.toDataURL();
    canvas.width = w;
    canvas.height = h;

    // fondo blanco
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width,canvas.height);

    // intentar reponer (si ya había firma)
    if(old && old !== "data:,"){
      const img = new Image();
      img.onload = ()=> ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = old;
    }

    ctx.lineWidth = 2.2 * ratio;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
  }

  function posFromEvent(e){
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const clientX = (e.touches ? e.touches[0].clientX : e.clientX);
    const clientY = (e.touches ? e.touches[0].clientY : e.clientY);
    return {
      x: (clientX - rect.left) * ratio,
      y: (clientY - rect.top) * ratio,
    };
  }

  function start(e){
    drawing = true;
    last = posFromEvent(e);
  }

  function move(e){
    if(!drawing) return;
    e.preventDefault();
    const p = posFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function end(){
    drawing = false;
    last = null;
  }

  window.addEventListener("resize", resize);
  resize();

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);

  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);

  return {
    clear(){
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0,0,canvas.width,canvas.height);
    },
    dataUrl(){
      return canvas.toDataURL("image/png");
    },
    hasInk(){
      // Heurística: revisar algunos píxeles
      const img = ctx.getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=0; i<img.length; i+=16){
        // si no es blanco puro en RGB (ignorando alpha)
        const r = img[i], g = img[i+1], b = img[i+2];
        if(!(r===255 && g===255 && b===255)) return true;
      }
      return false;
    }
  };
}

let SIGN;

// --------- Render / UI ----------
function show(viewId){
  for(const id of ["setupView","loginView","appView"]){
    document.getElementById(id).classList.add("hidden");
  }
  document.getElementById(viewId).classList.remove("hidden");
}

function refreshHeader(){
  const station = STATE.config?.stationCode || "—";
  const user = STATE.session ? `${STATE.session.name} (${STATE.session.role})` : "Sin sesión";
  document.getElementById("headerMeta").textContent = `Estación: ${station} · Usuario: ${user}`;
  document.getElementById("btnLogout").classList.toggle("hidden", !STATE.session);
  document.getElementById("btnSupervisor").classList.toggle("hidden", !isSupervisor());
}

function refreshSessionMeta(){
  if(!STATE.session) return;
  document.getElementById("sessionMeta").textContent =
    `Operador: ${STATE.session.name} · Rol: ${STATE.session.role} · Fecha: ${localDateYYYYMMDD()} · Hora: ${localTimeHHMM()}`;
  document.getElementById("dayMeta").textContent =
    `Estación ${STATE.config.stationCode} · ${localDateYYYYMMDD()} · Corte en proceso`;
}

function fillLoginUsers(){
  const sel = document.getElementById("loginUser");
  sel.innerHTML = "";
  const users = STATE.users.slice().sort((a,b)=> a.name.localeCompare(b.name));
  for(const u of users){
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `${u.name} ${u.role==="SUPERVISOR" ? "(Supervisor)" : ""}`;
    sel.appendChild(opt);
  }
}

function todayDeposits(){
  const today = localDateYYYYMMDD();
  const station = STATE.config.stationCode;
  return STATE.deposits.filter(d => d.stationCode === station && d.date === today);
}

function renderReport(){
  const list = document.getElementById("reportList");
  const totals = document.getElementById("reportTotals");

  const deps = todayDeposits().filter(d => STATE.showCanceled ? true : d.status !== "CANCELED");

  if(!deps.length){
    list.innerHTML = `<p class="text-slate-400 italic text-center">Sin registros.</p>`;
    totals.innerHTML = "";
    return;
  }

  // Lista
  list.innerHTML = deps
    .slice()
    .sort((a,b)=> (a.createdAt||"").localeCompare(b.createdAt||""))
    .map(d => {
      const badge = d.status==="CANCELED"
        ? `<span class="text-[10px] font-black px-2 py-0.5 rounded bg-red-100 text-red-700">CANCELADO</span>`
        : `<span class="text-[10px] font-black px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">OK</span>`;

      return `
        <div class="border rounded-xl p-2 bg-slate-50">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-bold text-slate-700">${escapeHTML(d.folio)}</div>
            <div>${badge}</div>
          </div>
          <div class="mt-1 flex items-center justify-between">
            <div class="text-sm font-black text-slate-900">${escapeHTML(d.userName)}</div>
            <div class="font-mono font-black text-sky-700">$${money2(d.monto)}</div>
          </div>
          <div class="mt-1 text-xs text-slate-500 flex justify-between">
            <span>${escapeHTML(d.isla)} · ${escapeHTML(d.turno)}</span>
            <span>${escapeHTML(d.time)}</span>
          </div>
          <div class="mt-2 no-print flex gap-2">
            <button class="btnReprint text-xs font-bold px-2 py-1 rounded border hover:bg-white" data-id="${d.id}">Reimprimir</button>
            ${isSupervisor() && d.status!=="CANCELED"
              ? `<button class="btnCancel text-xs font-bold px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50" data-id="${d.id}">Cancelar</button>`
              : ``}
          </div>
        </div>
      `;
    }).join("");

  // Totales por persona (solo OK por control)
  const okDeps = todayDeposits().filter(d => d.status !== "CANCELED");
  const per = okDeps.reduce((acc, d)=>{
    acc[d.userName] = (acc[d.userName]||0) + Number(d.monto);
    return acc;
  }, {});
  const grand = okDeps.reduce((s,d)=> s + Number(d.monto), 0);

  let html = `<div class="text-sm font-black text-slate-900">KPIs</div>`;
  html += `<div class="mt-2 flex justify-between border-b pb-2 text-sm">
      <span class="text-slate-600">Transacciones OK</span><span class="font-black">${okDeps.length}</span>
    </div>`;

  html += `<div class="mt-3 text-xs font-black text-slate-700 uppercase">Total por usuario (OK)</div>`;
  const keys = Object.keys(per).sort();
  for(const k of keys){
    html += `
      <div class="flex justify-between py-1 border-b">
        <span class="text-slate-700">${escapeHTML(k)}</span>
        <span class="font-black text-sky-800">$${money2(per[k])}</span>
      </div>
    `;
  }
  html += `
    <div class="mt-3 p-3 rounded-xl bg-sky-50 border border-sky-200 flex justify-between">
      <span class="font-black text-sky-900">GRAN TOTAL (OK)</span>
      <span class="font-black text-sky-900 text-lg">$${money2(grand)}</span>
    </div>
  `;
  totals.innerHTML = html;

  // Hooks botones
  list.querySelectorAll(".btnReprint").forEach(btn=>{
    btn.addEventListener("click", ()=> reprint(btn.dataset.id));
  });
  list.querySelectorAll(".btnCancel").forEach(btn=>{
    btn.addEventListener("click", ()=> cancelDeposit(btn.dataset.id));
  });
}

function buildTicketHTML(dep){
  const station = STATE.config.stationCode;
  const sigImg = dep.sigDataUrl ? `<img src="${dep.sigDataUrl}" style="max-height:70px; margin: 6px auto; display:block;" />` : "";

  const base = (title, footerLabel)=>`
    <div class="ticket">
      <h2 style="text-align:center;font-weight:bold;margin:0">${title}</h2>
      <p style="text-align:center;font-size:12px;margin:5px 0">Comprobante de Depósito · Estación ${escapeHTML(station)}</p>
      <hr/>
      <p><strong>FOLIO:</strong> ${escapeHTML(dep.folio)}</p>
      <p><strong>FECHA:</strong> ${escapeHTML(dep.date)} <strong>HORA:</strong> ${escapeHTML(dep.time)}</p>
      <p><strong>TURNO:</strong> ${escapeHTML(dep.turno)} <strong>ISLA:</strong> ${escapeHTML(dep.isla)}</p>
      <p><strong>USUARIO:</strong> ${escapeHTML(dep.userName)}</p>
      <p style="font-size:1.2rem;text-align:center;border:1px solid #000;padding:5px;margin:10px 0;">
        <strong>TOTAL: $${money2(dep.monto)}</strong>
      </p>

      <div style="margin-top: 10px;">
        <div style="text-align:center; font-size: 11px; font-weight: bold;">FIRMA</div>
        ${sigImg}
      </div>

      <div style="margin-top:14px;text-align:center;border-top:1px solid #ccc;padding-top:6px">
        <small>${footerLabel}</small>
      </div>

      ${dep.status==="CANCELED"
        ? `<p style="margin-top:10px; text-align:center; font-weight:bold; border:2px solid #000; padding:6px;">CANCELADO</p>`
        : ``}
    </div>
  `;

  return `
    ${base("ORIGINAL - TICKET DE COLECTA","Firma Responsable")}
    <div class="divider"></div>
    ${base("COPIA - TICKET DE COLECTA","Sello / Recepción")}
  `;
}

function printDeposit(dep){
  const area = document.getElementById("ticketPrintArea");
  area.innerHTML = buildTicketHTML(dep);
  area.classList.remove("hidden");
  window.print();
  // No lo oculto inmediatamente para evitar browsers que tardan
  setTimeout(()=> area.classList.add("hidden"), 400);
}

// --------- Casos de uso ----------
async function doSetup(){
  const stationCode = document.getElementById("setupStation").value;
  const supName = normalizeName(document.getElementById("setupSupName").value);
  const pin = String(document.getElementById("setupSupPin").value || "").trim();
  const pin2 = String(document.getElementById("setupSupPin2").value || "").trim();

  if(!supName) return banner("error","Captura nombre del supervisor.");
  if(!/^\d{4,6}$/.test(pin)) return banner("error","PIN supervisor debe ser 4–6 dígitos.");
  if(pin !== pin2) return banner("error","Confirmación de PIN no coincide.");

  const config = { stationCode, createdAt: new Date().toISOString() };
  await kvSet("config", config);

  const supUser = {
    id: uuid(),
    name: supName,
    pinHash: await pinHash(pin),
    role: "SUPERVISOR",
    createdAt: new Date().toISOString(),
  };
  await userPut(supUser);

  banner("ok","Configuración guardada. Inicia sesión como supervisor.");
  await bootstrap();
}

async function doLogin(){
  const userId = document.getElementById("loginUser").value;
  const pin = String(document.getElementById("loginPin").value || "").trim();

  if(!/^\d{4,6}$/.test(pin)) return banner("error","PIN inválido (4–6 dígitos).");

  const user = STATE.users.find(u => u.id === userId);
  if(!user) return banner("error","Usuario no encontrado.");

  const hash = await pinHash(pin);
  if(hash !== user.pinHash) return banner("error","PIN incorrecto.");

  STATE.session = { userId: user.id, name: user.name, role: user.role };
  document.getElementById("loginPin").value = "";

  document.getElementById("btnLogout").classList.remove("hidden");
  document.getElementById("btnSupervisor").classList.toggle("hidden", !isSupervisor());
  refreshHeader();
  refreshSessionMeta();

  show("appView");
  document.getElementById("inpMonto").focus();
  banner("ok","Sesión iniciada.");
  renderReport();
}

function logout(){
  STATE.session = null;
  refreshHeader();
  show("loginView");
  banner("info","Sesión cerrada.");
}

async function generateDeposit(){
  requireSession();

  const isla = document.getElementById("inpIsla").value;
  const turno = document.getElementById("inpTurno").value;
  const montoVal = Number(document.getElementById("inpMonto").value);
  const monto = Math.round(montoVal * 100) / 100;

  if(!Number.isFinite(monto) || monto <= 0){
    banner("error","Monto inválido. Captura un valor mayor a 0.");
    document.getElementById("inpMonto").focus();
    return;
  }
  if(!SIGN.hasInk()){
    banner("error","Firma obligatoria. Captura la firma antes de imprimir.");
    return;
  }

  const dep = {
    id: uuid(),
    stationCode: STATE.config.stationCode,
    folio: await nextFolio(STATE.config.stationCode),
    date: localDateYYYYMMDD(),
    time: localTimeHHMM(),
    isla, turno,
    monto,
    userId: STATE.session.userId,
    userName: STATE.session.name,
    sigDataUrl: SIGN.dataUrl(),
    status: "OK",
    createdAt: new Date().toISOString(),
  };

  await depositPut(dep);
  STATE.deposits.push(dep);

  // Imprime
  printDeposit(dep);

  // Limpieza rápida para siguiente operación
  document.getElementById("inpMonto").value = "";
  SIGN.clear();
  document.getElementById("inpMonto").focus();

  renderReport();
}

async function reprint(id){
  requireSession();
  const dep = STATE.deposits.find(d=> d.id === id);
  if(!dep) return banner("error","Registro no encontrado.");
  printDeposit(dep);
}

async function cancelDeposit(id){
  if(!isSupervisor()) return banner("error","Solo supervisor puede cancelar.");
  const dep = STATE.deposits.find(d=> d.id === id);
  if(!dep) return banner("error","Registro no encontrado.");
  if(dep.status === "CANCELED") return;

  if(!confirm(`¿Cancelar folio ${dep.folio}? Se mantendrá en bitácora.`)) return;

  dep.status = "CANCELED";
  dep.canceledAt = new Date().toISOString();
  dep.canceledBy = STATE.session.name;

  await depositPut(dep);
  banner("ok","Ticket cancelado.");
  renderReport();
}

async function clearDay(){
  if(!isSupervisor()) return banner("error","Solo supervisor puede limpiar.");
  if(!confirm("¿Borrar registros DEL DÍA en esta estación? (recomendado solo si fue una prueba)")) return;

  const today = localDateYYYYMMDD();
  const station = STATE.config.stationCode;

  // Solo borra del día actual / estación actual
  const toDelete = STATE.deposits.filter(d=> d.stationCode===station && d.date===today);
  for(const d of toDelete){
    await depositDelete(d.id);
  }
  STATE.deposits = STATE.deposits.filter(d=> !(d.stationCode===station && d.date===today));
  banner("ok","Registros del día eliminados.");
  renderReport();
}

function toggleCanceled(){
  STATE.showCanceled = !STATE.showCanceled;
  banner("info", STATE.showCanceled ? "Mostrando cancelados." : "Ocultando cancelados.");
  renderReport();
}

// --------- Supervisor modal ----------
function openSup(){
  if(!isSupervisor()) return;
  document.getElementById("supModal").classList.remove("hidden");
  document.getElementById("supPinGate").value = "";
  renderUserList();
}

function closeSup(){
  document.getElementById("supModal").classList.add("hidden");
}

function renderUserList(){
  const box = document.getElementById("userList");
  const users = STATE.users.slice().sort((a,b)=> a.name.localeCompare(b.name));
  box.innerHTML = users.map(u => `
    <div class="flex items-center justify-between border rounded-lg p-2">
      <div>
        <div class="text-sm font-black text-slate-900">${escapeHTML(u.name)}</div>
        <div class="text-xs text-slate-500">${u.role}</div>
      </div>
      <div>
        ${u.role==="SUPERVISOR"
          ? `<span class="text-[10px] font-black px-2 py-1 rounded bg-emerald-100 text-emerald-800">Protegido</span>`
          : `<button class="btnDelUser text-xs font-bold px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50" data-id="${u.id}">Baja</button>`}
      </div>
    </div>
  `).join("");

  box.querySelectorAll(".btnDelUser").forEach(btn=>{
    btn.addEventListener("click", ()=> deleteUser(btn.dataset.id));
  });
}

async function gateSupervisor(){
  const pin = String(document.getElementById("supPinGate").value || "").trim();
  if(!/^\d{4,6}$/.test(pin)) throw new Error("PIN supervisor inválido.");
  const sup = STATE.users.find(u => u.role==="SUPERVISOR" && u.id === STATE.session.userId);
  if(!sup) throw new Error("Supervisor no válido.");
  const hash = await pinHash(pin);
  if(hash !== sup.pinHash) throw new Error("PIN supervisor incorrecto.");
}

async function addUser(){
  try{
    await gateSupervisor();
  } catch(e){
    return banner("error", e.message);
  }

  const nameRaw = document.getElementById("newUserName").value;
  const pin = String(document.getElementById("newUserPin").value||"").trim();
  const name = normalizeName(nameRaw);

  if(!name) return banner("error","Nombre requerido.");
  if(!/^\d{4,6}$/.test(pin)) return banner("error","PIN usuario debe ser 4–6 dígitos.");

  const exists = STATE.users.some(u => u.name.toLowerCase() === name.toLowerCase());
  if(exists) return banner("error","Ya existe un usuario con ese nombre.");

  const user = {
    id: uuid(),
    name,
    pinHash: await pinHash(pin),
    role: "OPERADOR",
    createdAt: new Date().toISOString(),
  };
  await userPut(user);
  STATE.users.push(user);

  document.getElementById("newUserName").value = "";
  document.getElementById("newUserPin").value = "";

  fillLoginUsers();
  renderUserList();
  banner("ok","Usuario dado de alta.");
}

async function deleteUser(id){
  try{
    await gateSupervisor();
  } catch(e){
    return banner("error", e.message);
  }

  const user = STATE.users.find(u=>u.id===id);
  if(!user) return;
  if(!confirm(`¿Dar de baja a ${user.name}?`)) return;

  await userDelete(id);
  STATE.users = STATE.users.filter(u=>u.id!==id);

  fillLoginUsers();
  renderUserList();
  banner("ok","Usuario dado de baja.");
}

function exportCSV(includeCanceled=false){
  requireSession();

  const station = STATE.config.stationCode;
  const today = localDateYYYYMMDD();
  const deps = todayDeposits().filter(d => includeCanceled ? true : d.status !== "CANCELED");

  const headers = [
    "stationCode","folio","date","time","turno","isla",
    "monto","status","userName","userId","createdAt","canceledAt","canceledBy"
  ];

  const rows = deps.map(d => headers.map(h => {
    const v = d[h] ?? "";
    // CSV safe
    return `"${String(v).replaceAll('"','""')}"`;
  }).join(","));

  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `colectas_${station}_${today}${includeCanceled ? "_ALL" : ""}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  banner("ok","CSV exportado.");
}

async function resetFolio(){
  try{
    await gateSupervisor();
  } catch(e){
    return banner("error", e.message);
  }
  const station = STATE.config.stationCode;
  if(!confirm(`¿Reiniciar consecutivo mensual para ${station}?`)) return;
  await resetMonthFolio(station, STATE.session.name);
  banner("ok","Consecutivo mensual reiniciado (bitácora registrada).");
}

// --------- Bootstrap ----------
async function bootstrap(){
  // Config
  STATE.config = await kvGet("config");

  // Users
  STATE.users = await usersAll();

  // Deposits
  STATE.deposits = await depositsAll();

  // Views
  if(!STATE.config || STATE.users.length === 0){
    show("setupView");
  } else {
    fillLoginUsers();
    show("loginView");
  }

  refreshHeader();

  // signature init (solo una vez)
  if(!SIGN) SIGN = setupSignature();

  // SW register
  if("serviceWorker" in navigator){
    try{
     await navigator.serviceWorker.register("/colectas-pwa/sw.js");
    } catch (e) {
      // no bloquear operación
    }
  }

  // install button
  const btnInstall = document.getElementById("btnInstall");
  if(STATE.installPrompt){
    btnInstall.classList.remove("hidden");
  }
}

// --------- Eventos UI ----------
window.addEventListener("beforeinstallprompt", (e)=>{
  e.preventDefault();
  STATE.installPrompt = e;
  document.getElementById("btnInstall").classList.remove("hidden");
});

document.getElementById("btnInstall").addEventListener("click", async ()=>{
  if(!STATE.installPrompt) return;
  STATE.installPrompt.prompt();
  await STATE.installPrompt.userChoice;
  STATE.installPrompt = null;
  document.getElementById("btnInstall").classList.add("hidden");
});

document.getElementById("btnDoSetup").addEventListener("click", doSetup);
document.getElementById("btnLogin").addEventListener("click", doLogin);
document.getElementById("btnLogout").addEventListener("click", logout);
document.getElementById("btnGenerate").addEventListener("click", generateDeposit);

document.getElementById("btnClearSig").addEventListener("click", ()=>{
  SIGN.clear();
  banner("info","Firma limpiada.");
});

document.getElementById("btnToggleCanceled").addEventListener("click", toggleCanceled);
document.getElementById("btnClearDay").addEventListener("click", clearDay);

document.getElementById("btnExportCSV").addEventListener("click", ()=> exportCSV(false));
document.getElementById("btnSupervisor").addEventListener("click", openSup);
document.getElementById("btnCloseSup").addEventListener("click", closeSup);
document.getElementById("btnAddUser").addEventListener("click", addUser);
document.getElementById("btnExportAllCSV").addEventListener("click", ()=> exportCSV(true));
document.getElementById("btnResetMonthFolio").addEventListener("click", resetFolio);

// Enter en PIN login / monto
document.addEventListener("keydown", (e)=>{
  if(e.key !== "Enter") return;
  const id = document.activeElement?.id;
  if(id === "loginPin"){
    e.preventDefault();
    doLogin();
  }
  if(id === "inpMonto"){
    e.preventDefault();
    generateDeposit();
  }
});

// --------- Init ----------
document.addEventListener("DOMContentLoaded", async ()=>{
  await bootstrap();
  // Meta en header
  setInterval(()=>{
    if(STATE.session){
      refreshSessionMeta();
    }
  }, 1000);
});


