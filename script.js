/* =====================================================
   SMART GRID BALANCER - LOGIC
===================================================== */

const Game = {
  running: false,
  solar: 60,
  battery: 40,
  timeLeft: 120,
  
  // حالة التوزيع
  zones: {
    'zone-hosp': { req: 40, current: 0, active: false, cable: 'cable-hosp' },
    'zone-ind':  { req: 30, current: 0, active: false, cable: 'cable-ind' },
    'zone-res':  { req: 20, current: 0, active: false, cable: 'cable-res' },
    'zone-wat':  { req: 10, current: 0, active: false, cable: 'cable-wat' },
  },

  // الكاميرا والإصبع
  camera: null, hands: null,
  fingerActive: false, fingerX: 0, fingerY: 0,
  
  holdingPack: null, // حزمة الطاقة المحمولة
  hoverStart: 0,
  timerInterval: null,
};

const el = {
  startScreen: document.getElementById('startScreen'),
  endScreen: document.getElementById('endScreen'),
  gameUI: document.getElementById('gameUI'),
  startBtn: document.getElementById('startBtn'),
  replayBtn: document.getElementById('replayBtn'),
  
  solarVal: document.getElementById('solarVal'),
  batteryVal: document.getElementById('batteryVal'),
  freqVal: document.getElementById('freqVal'),
  demandVal: document.getElementById('demandVal'),
  systemStatus: document.getElementById('systemStatus'),
  
  fingerCursor: document.getElementById('fingerCursor'),
  video: document.getElementById('video'),
  camCanvas: document.getElementById('camCanvas'),
  toast: document.getElementById('toast'),
  
  endTitle: document.getElementById('endTitle'),
  finalScore: document.getElementById('finalScore'),
  finalTime: document.getElementById('finalTime'),
};

/* ==================== الأصوات ==================== */
const Sound = {
  ctx: null,
  init() { if(!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
  beep(f, d, t='square', v=0.05) {
    if(!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = t; o.frequency.value = f;
    g.gain.setValueAtTime(v, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + d);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(); o.stop(this.ctx.currentTime + d);
  },
  ping() { this.beep(1200, 0.05, 'sine', 0.03); },
  grab() { this.beep(600, 0.1, 'square', 0.05); },
  drop() { this.beep(800, 0.1, 'sine', 0.05); },
  error() { this.beep(200, 0.3, 'sawtooth', 0.08); }
};

/* ==================== دوال مساعدة ==================== */
function showToast(text, isError=false) {
  el.toast.textContent = text;
  el.toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.toast.classList.remove('show'), 2000);
}

function updateHUD() {
  el.solarVal.textContent = `${Game.solar} MW`;
  el.batteryVal.textContent = `${Game.battery} MW`;
  
  // حساب التردد (ينخفض إذا زاد الحمل)
  const totalDemand = Object.values(Game.zones).reduce((sum, z) => sum + z.req, 0);
  const totalSupplied = Object.values(Game.zones).reduce((sum, z) => sum + z.current, 0);
  
  let freq = 50.0;
  if (totalSupplied > Game.solar + Game.battery) {
    freq = 48.5; // انخفاض التردد بسبب الحمل الزائد
    el.systemStatus.textContent = 'GRID OVERLOAD!';
    el.systemStatus.className = 'status-error';
    el.freqVal.style.color = 'var(--neon-red)';
  } else if (totalSupplied === totalDemand) {
    freq = 50.0;
    el.systemStatus.textContent = 'GRID STABLE';
    el.systemStatus.className = 'status-ok';
    el.freqVal.style.color = 'var(--neon-green)';
  } else {
    freq = 49.8;
    el.systemStatus.textContent = 'DISTRIBUTING POWER...';
    el.systemStatus.className = 'status-ok';
    el.freqVal.style.color = 'var(--neon-yellow)';
  }
  
  el.freqVal.textContent = freq.toFixed(1) + ' Hz';
  el.demandVal.textContent = `${totalDemand} MW`;
}

/* ==================== بدء اللعبة ==================== */
async function startGame() {
  Sound.init();
  el.startScreen.classList.add('hidden');
  el.endScreen.classList.add('hidden');
  el.gameUI.classList.remove('hidden');
  
  Game.running = true;
  Game.timeLeft = 120;
  Game.solar = 60;
  Game.battery = 40;
  
  // تصفير المناطق
  Object.keys(Game.zones).forEach(id => {
    Game.zones[id].current = 0;
    Game.zones[id].active = false;
    document.getElementById(id).classList.remove('active');
    document.querySelector(`#${id} .zone-status`).textContent = 'OFFLINE';
    document.querySelector(`#${id} .zone-load`).textContent = '0 MW';
    document.getElementById(Game.zones[id].cable).classList.remove('active');
  });
  
  // إعادة حزم الطاقة
  const packsContainer = document.getElementById('powerPacks');
  packsContainer.innerHTML = '';
  for(let i=0; i<5; i++) {
    const pack = document.createElement('div');
    pack.className = 'power-pack';
    pack.dataset.value = '20';
    pack.innerHTML = '20<small>MW</small>';
    packsContainer.appendChild(pack);
  }
  
  updateHUD();
  await initHands();
  await startCamera();
  startTimer();
}

/* ==================== المؤقت ==================== */
function startTimer() {
  clearInterval(Game.timerInterval);
  Game.timerInterval = setInterval(() => {
    if (!Game.running) return;
    Game.timeLeft--;
    
    // تقليل الطاقة الشمسية تدريجياً (محاكاة غروب الشمس)
    if (Game.timeLeft % 10 === 0 && Game.solar > 0) {
      Game.solar -= 5;
      if (Game.solar < 0) Game.solar = 0;
      updateHUD();
    }
    
    if (Game.timeLeft <= 0) {
      clearInterval(Game.timerInterval);
      endGame(true); // النجاة تعني الفوز
    }
  }, 1000);
}

/* ==================== الكاميرا ==================== */
async function initHands() {
  Game.hands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}` });
  Game.hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6, selfieMode: false });
  Game.hands.onResults(onHandsResults);
}

async function startCamera() {
  Game.camera = new Camera(el.video, { onFrame: async () => { await Game.hands.send({ image: el.video }); }, width: 640, height: 480 });
  await Game.camera.start();
}

/* ==================== منطق الإصبع ==================== */
function onHandsResults(results) {
  if (el.camCanvas) {
    el.camCanvas.width = el.camCanvas.clientWidth;
    el.camCanvas.height = el.camCanvas.clientHeight;
    const ctx = el.camCanvas.getContext('2d');
    ctx.save(); ctx.clearRect(0, 0, el.camCanvas.width, el.camCanvas.height);
    if (results.image) ctx.drawImage(results.image, 0, 0, el.camCanvas.width, el.camCanvas.height);
    ctx.restore();
  }

  if (!Game.running) return;

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    Game.fingerActive = false; el.fingerCursor.classList.remove('visible'); return;
  }

  const tip = results.multiHandLandmarks[0][8];
  const x = (1 - tip.x) * window.innerWidth;
  const y = tip.y * window.innerHeight;

  Game.fingerActive = true;
  Game.fingerX = x; Game.fingerY = y;
  
  el.fingerCursor.classList.remove('hidden');
  el.fingerCursor.classList.add('visible');
  el.fingerCursor.style.left = x + 'px';
  el.fingerCursor.style.top = y + 'px';

  if (Game.holdingPack) {
    // تحريك الحزمة مع الإصبع
    Game.holdingPack.style.left = x + 'px';
    Game.holdingPack.style.top = y + 'px';
    Game.holdingPack.style.position = 'fixed';
    Game.holdingPack.style.zIndex = 1500;
    Game.holdingPack.style.transform = 'translate(-50%, -50%)';
  } else {
    // التحقق من الإمساك بحزمة
    checkPackHover(x, y);
  }
}

/* ==================== 1. الإمساك بحزمة طاقة ==================== */
function checkPackHover(x, y) {
  const packs = document.querySelectorAll('.power-pack:not(.used)');
  
  packs.forEach(pack => {
    const rect = pack.getBoundingClientRect();
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    
    if (inside) {
      if (!Game.hoverStart) {
        Game.hoverStart = performance.now();
        Sound.ping();
      }
      const elapsed = performance.now() - Game.hoverStart;
      
      if (elapsed >= 500) { // نصف ثانية للإمساك
        grabPack(pack);
      }
    }
  });
  
  if (![...packs].some(p => {
    const r = p.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  })) {
    Game.hoverStart = 0;
  }
}

function grabPack(pack) {
  Game.hoverStart = 0;
  Game.holdingPack = pack;
  pack.classList.add('dragging');
  el.fingerCursor.classList.add('holding');
  Sound.grab();
  showToast('POWER PACK ACQUIRED');
  
  // إخفاء الحزمة الأصلية
  pack.style.opacity = '0';
}

/* ==================== 2. إفلات الحزمة في منطقة ==================== */
function checkDropZone() {
  if (!Game.holdingPack) return;
  
  const zones = document.querySelectorAll('.zone');
  const packValue = parseInt(Game.holdingPack.dataset.value);
  
  zones.forEach(zone => {
    const rect = zone.getBoundingClientRect();
    const inside = Game.fingerX >= rect.left && Game.fingerX <= rect.right && Game.fingerY >= rect.top && Game.fingerY <= rect.bottom;
    
    if (inside) {
      dropPackInZone(zone, packValue);
    }
  });
}

function dropPackInZone(zone, value) {
  const zoneId = zone.id;
  const zData = Game.zones[zoneId];
  
  // إضافة الطاقة
  zData.current += value;
  
  // التحقق من اكتمال الطاقة
  if (zData.current >= zData.req) {
    zData.active = true;
    zone.classList.add('active');
    zone.querySelector('.zone-status').textContent = 'ONLINE';
    document.getElementById(zData.cable).classList.add('active');
    Sound.drop();
    showToast(`✅ ${zone.dataset.name} ONLINE`);
  } else {
    zone.querySelector('.zone-load').textContent = `${zData.current} MW`;
  }
  
  // تنظيف
  Game.holdingPack.classList.remove('dragging');
  Game.holdingPack.classList.add('used');
  Game.holdingPack.style.opacity = '0';
  Game.holdingPack.style.pointerEvents = 'none';
  Game.holdingPack = null;
  el.fingerCursor.classList.remove('holding');
  
  updateHUD();
  checkWinCondition();
}

/* ==================== شروط الفوز ==================== */
function checkWinCondition() {
  const allActive = Object.values(Game.zones).every(z => z.active);
  if (allActive) {
    endGame(true);
  }
}

/* ==================== نهاية اللعبة ==================== */
function endGame(won) {
  Game.running = false;
  clearInterval(Game.timerInterval);
  el.gameUI.classList.add('hidden');
  el.fingerCursor.classList.remove('visible');
  el.endScreen.classList.remove('hidden');
  
  if (won) {
    el.endTitle.textContent = '🎉 CITY POWERED SUCCESSFULLY';
    el.endTitle.style.color = 'var(--neon-green)';
  } else {
    el.endTitle.textContent = '💥 GRID OVERLOAD';
    el.endTitle.style.color = 'var(--neon-red)';
