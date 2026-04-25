// jeopardy-logic.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get, push, remove } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// ---------------------------------------------------------
// 1. Initialize & Auth
// ---------------------------------------------------------
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);
const user = checkAuth();

// ตรวจสอบสิทธิ์การเข้าถึง (Admin หรือ วิชาการ เท่านั้น)
if (!user || user.userType !== 'staff' || (user.role !== 'Admin' && user.division !== 'วิชาการ')) {
    Swal.fire('ปฏิเสธการเข้าถึง', 'พื้นที่นี้สำหรับ Admin หรือฝ่ายวิชาการเท่านั้น', 'error')
        .then(() => {
            window.location.href = 'tutor.html';
        });
} else {
    // แสดงชื่อ Admin บน UI
    const adminNameEl = document.getElementById('admin-name');
    if (adminNameEl) adminNameEl.innerText = `Admin: ${user.nickname || user.fullName}`;
}

function safeSetText(id, text) {
    const el = document.getElementById(id);
    if (el) {
        el.innerText = text;
        return true;
    }
    return false;
}

// ---------------------------------------------------------
// 2. Global State
// ---------------------------------------------------------
let state = {};
let boardTimerInterval = null;
let countdownInterval = null;
let isBannerManuallyClosed = false;

// ---------------------------------------------------------
// 3. Main Listener (Real-time Sync)
// ---------------------------------------------------------
onValue(ref(db, 'jeopardy'), (snapshot) => {
    const data = snapshot.val() || {};
    state = data;

    // 1. จัดการปุ่ม Toggle (เฉพาะหน้า Admin)
    const btn = document.getElementById('btn-toggle-game');
    if (btn && state.config) {
        const isActive = state.config.is_active;
        btn.innerText = isActive ? "ปิดเกมซ่อนทางเข้า (ON)" : "เปิดเกมให้น้องเข้า (OFF)";
        btn.className = isActive
            ? "flex-1 md:flex-none bg-red-600 text-white px-6 py-2.5 rounded-xl font-black text-xs hover:bg-red-700 transition-all shadow-md"
            : "flex-1 md:flex-none bg-emerald-600 text-white px-6 py-2.5 rounded-xl font-black text-xs hover:bg-emerald-700 transition-all shadow-md";
    }

    if (!state.config) {
        initializeGameStructure();
    } else {
        // 2. อัปเดตข้อมูลพื้นฐาน (ใช้ safeSetText เพื่อป้องกัน Error)
        safeSetText('display-round', state.config.current_round);
        safeSetText('display-turn-house', state.game_state.active_house || 'END');
        safeSetText('display-active-house', state.game_state.active_house || '-');

        // 3. หน้า Admin Tools
        if (document.getElementById('houses-list')) renderHouseStatus();
        if (document.getElementById('jeopardy-grid')) renderQuestionGrid();
        if (document.getElementById('questions-table-body')) renderQuestionsTable();

        // 4. หน้า Admin Dashboard (Panel)
        const panelIdle = document.getElementById('panel-idle');
        if (panelIdle) renderDashboard();

        // 5. หน้า Board (Projector)
        if (window.isBoardPage) {
            renderBoard();
        }
    }
});

// ---------------------------------------------------------
// 4. Internal Initializer
// ---------------------------------------------------------
// ปรับปรุงในส่วน initializeGameStructure
async function initializeGameStructure() {
    const initialData = {
        config: {
            is_active: true,
            current_round: 1,
            max_turns_per_house: 2,
            timer_tiers: {
                "easy": 90,
                "medium": 120,
                "hard": 150
            },
            picking_house_order: [1, 2, 3, 4, 5, 6, 7, 8]
        },
        game_state: {
            status: 'BOARD',
            active_question_id: null,
            active_house: 1,
            current_turn_index: 0,
            answering_house: null,
            is_steal_open: false,
            is_timer_running: false,
            timer_duration: 0,
            timer_remaining: 0,
            last_action_log: "Game Started"
        },
        buzzers: { is_locked: false, winner: null, attempts: {} },
        houses: {}
    };

    for (let i = 1; i <= 8; i++) {
        initialData.houses[i] = {
            jeopardy_score: 0,
            correct_points: 0,
            penalty_points: 0,
            turns_played: 0,
            can_steal: true,
            active_session_id: null,
            last_active_ts: Date.now()
        };
    }
    await set(ref(db, 'jeopardy'), initialData);
}

// ---------------------------------------------------------
// 5. Render Functions
// ---------------------------------------------------------
function renderDashboard() {
    if (!state.config || !state.game_state) return;

    const gs = state.game_state;
    const turnHouse = gs.active_house;

    // ใช้ safeSetText แทนการสั่งตรงๆ
    safeSetText('display-round', state.config.current_round);
    safeSetText('display-turn-house', turnHouse || 'END');
    safeSetText('display-active-house', turnHouse || '-'); // สำหรับหน้า Board
    safeSetText('idle-turn-house', turnHouse || '-');

    const panelIdle = document.getElementById('panel-idle');
    const panelActive = document.getElementById('panel-active');

    // ถ้าเป็นหน้า Admin (มี Panel) ถึงจะรัน Logic ส่วนนี้
    if (panelIdle && panelActive) {
        if (gs.status === 'BOARD') {
            panelIdle.classList.remove('hidden');
            panelActive.classList.add('hidden');
        } else {
            panelIdle.classList.add('hidden');
            panelActive.classList.remove('hidden');
            renderActiveQuestion(gs);
        }
    }
}

function renderActiveQuestion(gs) {
    const q = state.questions?.[gs.active_question_id];
    if (!q) return;

    const optionsText = q.options
        ? q.options.replace(/\\n/g, '\n') // เปลี่ยนตัวอักษร \n เป็นการขึ้นบรรทัดใหม่
        : "ไม่มีตัวเลือก (ข้อเขียน)";

    // 1. อัปเดตข้อมูลโจทย์และเฉลยบนหน้าจอ Admin
    safeSetText('aq-category', q.category);
    safeSetText('aq-level', q.level);
    safeSetText('aq-points', q.points);
    safeSetText('aq-text', q.question_text);
    safeSetText('aq-options', optionsText);
    safeSetText('aq-answer', q.answer_text);

    // 2. อ้างอิง Panel ต่างๆ
    const ctrlOwner = document.getElementById('ctrl-owner');
    const ctrlStealOpen = document.getElementById('ctrl-steal-open');
    const ctrlStealJudge = document.getElementById('ctrl-steal-judge');
    const timerBtn = document.getElementById('btn-toggle-timer');
    const timerIcon = document.getElementById('timer-icon');
    const timerText = document.getElementById('timer-text');

    if (timerBtn) {
        if (gs.is_timer_running) {
            timerBtn.className = "bg-amber-500 text-white px-4 py-2 rounded-xl text-xs font-black shadow-md hover:bg-amber-600 transition-all flex items-center gap-2";
            timerIcon.innerText = "⏸️";
            timerText.innerText = "หยุดเวลา";
        } else {
            timerBtn.className = "bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-black shadow-md hover:bg-emerald-600 transition-all flex items-center gap-2 animate-pulse";
            timerIcon.innerText = "▶️";
            timerText.innerText = "เดินเวลาต่อ";
        }
    }

    if (!ctrlOwner || !ctrlStealOpen || !ctrlStealJudge) return;

    // ซ่อนแผงควบคุมทั้งหมดก่อนเพื่อล้างสถานะเก่า
    ctrlOwner.classList.add('hidden');
    ctrlStealOpen.classList.add('hidden');
    ctrlStealJudge.classList.add('hidden');

    // 3. แสดงแผงควบคุมตามสถานะปัจจุบัน (gs.status)
    if (gs.status === 'QUESTION') {
        // --- ช่วงที่ 1: เจ้าของข้อกำลังตอบ ---
        ctrlOwner.classList.remove('hidden');
        safeSetText('ctrl-owner-house', gs.active_house);
    }
    else if (gs.status === 'STEAL_WAIT') {
        // --- ช่วงที่ 2: รอการ Steal ---

        if (state.buzzers?.winner) {
            // จังหวะที่ A: มีบ้านกดติดแล้ว -> แสดงปุ่มตัดสินคะแนน
            ctrlStealJudge.classList.remove('hidden');
            safeSetText('steal-winner-badge', `บ้าน ${state.buzzers.winner}`);
        } else {
            // จังหวะที่ B: ยังไม่มีคนกดติด -> แสดงปุ่มให้ Admin สั่งเปิดระบบ
            ctrlStealOpen.classList.remove('hidden');
            const btnSteal = ctrlStealOpen.querySelector('button');

            if (gs.is_steal_open) {
                // ระบบเปิดอยู่แต่ยังไม่มีคนกด
                btnSteal.innerText = "⏳ ระบบเปิดแล้ว... รอน้องกดปุ่ม";
                btnSteal.disabled = true;
                btnSteal.className = "w-full bg-slate-200 text-slate-500 py-4 rounded-xl font-black cursor-not-allowed";
            } else {
                // ระบบยังปิดอยู่ (รอ Admin สั่ง 3-2-1)
                btnSteal.innerText = "⚡ ปล่อยไฟเหลือง (เริ่ม STEAL)";
                btnSteal.disabled = false;
                btnSteal.className = "w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-xl font-black shadow-lg shadow-orange-200 animate-pulse transition-all";
            }
        }
    }
}

function renderHouseStatus() {
    if (!state.houses || !state.game_state) return;
    const container = document.getElementById('houses-list');

    // ดึงว่าตอนนี้บ้านไหนถูกเลือกเป็น "ผู้เล่นหลัก"
    const activeHouse = state.game_state.active_house;

    container.innerHTML = Object.keys(state.houses).map(hId => {
        const h = state.houses[hId];
        const isActive = parseInt(hId) === activeHouse; // เช็คว่าเป็นบ้านที่กำลังเลือกแผ่นป้ายไหม
        const isOnline = h.active_session_id && (Date.now() - (h.last_active_ts || 0) < 10000);
        const ping = h.ping || 0;
        const usedAllTurns = h.turns_played >= (state.config?.max_turns_per_house || 2);

        let pingColor = 'text-slate-500';
        if (isOnline) {
            pingColor = ping < 150 ? 'text-emerald-400' : (ping < 350 ? 'text-amber-400' : 'text-red-400');
        }
        const canSteal = h.can_steal !== false; // ถ้าเป็น undefined ให้ถือว่าเป็น true

        return `
        <div class="relative group">
            <!-- ส่วน Card บ้าน (กดได้เพื่อเลือกเป็น Active House) -->
            <div onclick="setActiveHouse('${hId}')" 
                class="cursor-pointer p-3 rounded-xl border-2 transition-all 
                ${isActive ? 'bg-blue-600 border-blue-400 active-house-glow shadow-lg' : 'bg-slate-700/40 border-transparent hover:border-slate-500'} 
                ${usedAllTurns && !isActive ? 'opacity-60' : ''}">
                
                <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-3">
                        <!-- วงกลมเลขบ้าน -->
                        <div class="w-10 h-10 rounded-full flex items-center justify-center font-black text-lg shadow-inner
                            ${isActive ? 'bg-white text-blue-600' : 'bg-slate-800 text-slate-400'}">
                            ${hId}
                        </div>
                        
                        <div>
                            <p class="text-sm font-black ${isActive ? 'text-white' : 'text-slate-200'}">
                                Net: ${h.jeopardy_score} 
                                ${isActive ? '<span class="ml-2 text-[9px] bg-blue-400 px-2 py-0.5 rounded-full text-white animate-pulse uppercase">Choosing</span>' : ''}
                            </p>
                            <div class="flex items-center gap-2 mt-0.5">
                                <!-- แสดงผล Ping ตรงนี้ -->
                                <span class="text-[9px] font-mono font-bold ${pingColor}">
                                    ${isOnline ? `● ${ping}ms` : '○ Offline'}
                                </span>
                            </div>
                            <div class="flex items-center gap-2 mt-0.5">
                                <span class="text-[9px] font-bold ${isActive ? 'text-blue-100' : 'text-slate-400'} uppercase">
                                    Turns: ${h.turns_played}/2
                                </span>
                                <span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
                            </div>
                        </div>
                    </div>

                    <!-- ปุ่ม Kick -->
                    <button onclick="event.stopPropagation(); kickHouse('${hId}')" 
                        class="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-400/10 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                    </button>
                </div>

                <!-- คะแนนละเอียด (Schema ใหม่: Correct / Penalty / Steal Status) -->
                <div class="grid grid-cols-3 gap-1 border-t ${isActive ? 'border-blue-400' : 'border-slate-600/50'} pt-2 mt-2">
                    <div class="text-center">
                        <p class="text-[8px] font-black ${isActive ? 'text-blue-200' : 'text-slate-500'} uppercase">Correct</p>
                        <p class="text-[11px] font-black text-emerald-400">+${h.correct_points || 0}</p>
                    </div>
                    <div class="text-center border-x ${isActive ? 'border-blue-400' : 'border-slate-600/50'}">
                        <p class="text-[8px] font-black ${isActive ? 'text-blue-200' : 'text-slate-500'} uppercase">Penalty</p>
                        <p class="text-[11px] font-black text-red-400">-${h.penalty_points || 0}</p>
                    </div>
                    <div class="text-center">
                        <p class="text-[8px] font-black ${isActive ? 'text-blue-200' : 'text-slate-500'} uppercase">Steal</p>
                        <p class="text-[10px] font-black ${canSteal ? 'text-blue-400' : 'text-slate-500'}">
                            ${canSteal ? 'READY' : '🚫 BLOCKED'}
                        </p>
                    </div>
                </div>
            </div>
            
            <!-- ไอคอนเตือนถ้าเล่นครบแล้ว -->
            ${usedAllTurns ? `<div class="absolute -top-1 -right-1 text-xs" title="บ้านนี้ใช้สิทธิ์เลือกครบ 2 รอบแล้ว">⚠️</div>` : ''}
        </div>`;
    }).join('');
}

function renderQuestionGrid() {
    const container = document.getElementById('jeopardy-grid');
    if (!state.questions) {
        container.innerHTML = '<div class="col-span-full py-10 text-center text-slate-400 italic">ยังไม่มีคำถามในระบบ กรุณาเพิ่มที่แท็บ "จัดการคำถาม"</div>';
        return;
    }

    // แก้ไขจุดนี้: กรองเอาเฉพาะ Object ที่มีค่า และมี category
    const qs = Object.values(state.questions).filter(q => q && q.category);

    // แก้ไขการ Sort: ป้องกัน category เป็น undefined
    qs.sort((a, b) => {
        const catA = a.category || "";
        const catB = b.category || "";
        return catA.localeCompare(catB) || (a.points || 0) - (b.points || 0);
    });

    container.innerHTML = qs.map((q, index) => {
        const isPlayed = q.is_opened;
        const colorMap = { easy: 'bg-emerald-100 text-emerald-600 border-emerald-200', medium: 'bg-orange-50 text-orange-600 border-orange-200', hard: 'bg-rose-50 text-rose-600 border-rose-200' };
        const cClass = colorMap[q.level] || 'bg-slate-50 border-slate-200 text-slate-600';

        return `
        <button onclick="selectQuestion('${q.id}')" ${isPlayed ? 'disabled' : ''} 
            class="p-3 rounded-xl border-2 text-center transition-all ${isPlayed ? 'bg-slate-100 border-slate-200 text-slate-300 opacity-60 cursor-not-allowed' : `${cClass} hover:shadow-md hover:scale-105 active:scale-95`}">
            <span class="absolute top-1 left-1.5 text-[8px] font-black opacity-40">#${index + 1}</span>
            <p class="text-[9px] font-black uppercase tracking-widest opacity-70 truncate">${q.category}</p>
            <p class="text-xl font-black mt-1">${q.points}</p>
        </button>`;
    }).join('');
}

function renderQuestionsTable() {
    const tbody = document.getElementById('questions-table-body');
    const filterBadge = document.getElementById('q-filter-count');
    if (!state.questions || !tbody) return;

    let qs = Object.values(state.questions).filter(q => q && q.id);

    // --- ส่วนที่เพิ่ม: กรองข้อมูลตามคำค้นหา ---
    if (currentQSearchQuery) {
        qs = qs.filter(q =>
            q.id.toLowerCase().includes(currentQSearchQuery) ||
            q.category.toLowerCase().includes(currentQSearchQuery) ||
            q.question_text.toLowerCase().includes(currentQSearchQuery)
        );

        if (filterBadge) {
            filterBadge.innerText = `พบ ${qs.length} รายการ`;
            filterBadge.classList.remove('hidden');
        }
    } else {
        if (filterBadge) filterBadge.classList.add('hidden');
    }

    // เรียงตาม ID (A-Z)
    qs.sort((a, b) => a.id.localeCompare(b.id));

    if (qs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-10 text-center text-slate-400 italic">ไม่พบข้อมูลที่ตรงกับการค้นหา</td></tr>`;
        return;
    }

    tbody.innerHTML = qs.map(q => `
        <tr class="hover:bg-slate-50 border-b transition-colors">
            <td class="p-3 font-mono text-[11px] font-bold text-blue-600">${q.id}</td>
            <td class="p-3">
                <p class="font-bold text-slate-700 leading-none">${q.category}</p>
                <p class="text-[9px] text-slate-400 uppercase font-black mt-1">${q.level}</p>
            </td>
            <td class="p-3 font-black text-indigo-600">${q.points}</td>
            <td class="p-3 text-xs text-slate-600 max-w-[250px] truncate" title="${q.question_text}">${q.question_text}</td>
            <td class="p-3 text-center">
                ${q.is_opened
            ? '<span class="bg-red-100 text-red-600 text-[9px] px-2 py-1 rounded font-bold">เล่นแล้ว</span>'
            : '<span class="bg-green-100 text-green-600 text-[9px] px-2 py-1 rounded font-bold">พร้อมเล่น</span>'}
            </td>
            <td class="p-3 text-right">
                <div class="flex gap-2 justify-end">
                    <button onclick="editQuestion('${q.id}')" class="text-blue-500 hover:bg-blue-100 p-2 rounded-xl transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2.25 2.25 0 113.182 3.182L12 18.25H8.75V15L17.586 6.172z" /></svg>
                    </button>
                    <button onclick="deleteQuestion('${q.id}')" class="text-red-400 hover:bg-red-100 p-2 rounded-xl transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderBoard() {
    if (!window.isBoardPage || !state.questions) return;

    const boardContainer = document.getElementById('board-container');
    if (!boardContainer) return;

    const allQuestions = Object.values(state.questions).filter(q => q && q.id);
    allQuestions.sort((a, b) => a.points - b.points);

    const difficultyStyles = {
        easy: { border: 'border-emerald-100', bg: 'bg-emerald-100', text: 'text-emerald-600' },
        medium: { border: 'border-amber-100', bg: 'bg-amber-100', text: 'text-amber-600' },
        hard: { border: 'border-rose-100', bg: 'bg-rose-100', text: 'text-rose-600' },
        played: { border: 'border-slate-300', bg: 'bg-slate-300', text: 'text-slate-500' }
    };

    boardContainer.innerHTML = allQuestions.map((q, index) => {
        const style = difficultyStyles[q.level] || difficultyStyles.easy;
        const isOpened = q.is_opened;

        return `
        <button onclick="confirmOpenQuestion('${q.id}')"
            ${isOpened ? 'disabled aria-disabled="true"' : ''}
            class="jeopardy-card border-2 rounded-2xl flex flex-col items-center justify-center shadow-sm transition-all relative
            ${isOpened
            ? 'bg-slate-200 border-slate-300 text-slate-400 cursor-not-allowed opacity-80 grayscale'
            : `${style.bg} ${style.border} hover:shadow-md active:scale-95`}">
            
            <span class="card-number-badge">${index + 1}</span>
            <span class="cat-text font-black uppercase tracking-tighter ${isOpened ? 'text-slate-400' : ''}">${q.category}</span>
            <span class="points-text font-black ${isOpened ? 'text-slate-400' : style.text}">${q.points}</span>
            ${isOpened ? '<span class="mt-1 text-slate-500 text-sm">🔒 Disabled</span>' : ''}
        </button>`;
    }).join('');

    renderBoardScoreboard();
    updateBoardGameState();
}


function renderBoardScoreboard() {
    const container = document.getElementById('scoreboard');
    if (!container || !state.houses) return;

    container.innerHTML = Object.keys(state.houses).map(hId => {
        const h = state.houses[hId];
        const isActive = parseInt(hId) === state.game_state.active_house;
        const isBuzzerWinner = state.buzzers?.winner == hId;

        // ดึงข้อมูลคะแนน
        const correct = h.correct_points || 0;
        const penalty = h.penalty_points || 0;
        const score = h.jeopardy_score || 0;

        // ตรวจสอบสถานะออนไลน์และ Ping
        const isOnline = h.active_session_id && (Date.now() - (h.last_active_ts || 0) < 10000);
        const ping = h.ping || 0;
        // ถ้า Ping เกิน 400ms ให้ขึ้นไอคอนเตือน
        const lagWarning = (isOnline && ping > 400) ? '⚠️' : '';

        return `
        <div onclick="window.setActiveHouse('${hId}')" 
            class="house-card-compact border-2 transition-all cursor-pointer hover:shadow-md active:scale-95
            ${isActive ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-100 opacity-90'} 
            ${isBuzzerWinner ? 'ring-4 ring-orange-500 animate-pulse' : ''}">
            
            <div class="flex items-center justify-between w-full gap-2">
                <!-- 1. ส่วนเลขบ้าน -->
                <div class="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center font-black text-sm 
                    ${isActive ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-400'}">
                    ${hId}
                </div>
                
                <!-- 2. ส่วนคะแนนหลัก -->
                <div class="flex-1">
                    <p class="text-2xl font-black ${isActive ? 'text-blue-700' : 'text-slate-800'} leading-none">
                        ${score}
                    </p>
                </div>

                <div class="flex flex-col items-end">
                    <span class="text-md font-mono ${isOnline ? 'text-emerald-500' : 'text-slate-300'}">
                        ${isOnline ? ping + 'ms' : 'OFFLINE'}
                    </span>
                    <span class="text-[10px]">${lagWarning}</span>
                </div>

                <!-- 3. ส่วนสถิติละเอียด (Correct / Penalty) -->
                <div class="flex flex-col items-end text-lg font-bold leading-tight border-x border-slate-100 px-2 min-w-[65px]">
                    <span class="text-emerald-500">+${correct}</span>
                    <span class="text-red-400">-${penalty}</span>
                </div>

                <!-- 4. ส่วน Turns และสถานะ -->
                <div class="text-right flex flex-col items-end gap-1 min-w-[50px]">
                    <span class="text-md font-black text-black uppercase">T: ${h.turns_played}/2</span>
                    <div class="flex items-center">
                        ${isActive ? '<span class="text-blue-500 text-[10px] animate-bounce">●</span>' : ''}
                        ${isBuzzerWinner ? '<span class="text-orange-500 text-sm">🔔</span>' : ''}
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

// ---------------------------------------------------------
// 6. Game Logic Functions (Bind to Window)
// ---------------------------------------------------------
window.saveUndoState = async function () {
    await set(ref(db, 'jeopardy/history/last_state'), {
        houses: state.houses,
        game_state: state.game_state,
        config: state.config,
        buzzers: state.buzzers
    });
};
// ใน jeopardy-logic.js
window.setActiveHouse = async function (houseId) {
    if (!state.houses || !state.houses[houseId]) return;
    const h = state.houses[houseId];

    // 1. แจ้งเตือนเรื่องโควต้า (เฉพาะหน้าที่มี Swal หรือหน้า Admin)
    // ถ้าคลิกจากหน้า Board อาจจะไม่ต้องถามซ้ำซ้อน แต่ถ้าต้องการให้ถามเหมือนกันโค้ดนี้ใช้ได้เลยครับ
    if (h.turns_played >= 2) {
        const confirm = await Swal.fire({
            title: 'บ้านนี้เล่นครบ 2 รอบแล้ว',
            text: `บ้าน ${houseId} ได้ใช้สิทธิ์เลือกไปแล้วครบโควต้า ต้องการให้เล่นต่อหรือไม่?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'ยืนยัน',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#3b82f6',
        });
        if (!confirm.isConfirmed) return;
    }

    try {
        // หาตำแหน่งในคิวการเล่น
        let orderIndex = state.config.picking_house_order.indexOf(parseInt(houseId));
        if (orderIndex === -1) orderIndex = 0; // fallback ถ้าหาไม่เจอ

        await update(ref(db, 'jeopardy/game_state'), {
            active_house: parseInt(houseId),
            current_turn_index: orderIndex
        });

        if (typeof showToast === 'function') {
            showToast(`บ้าน ${houseId} เป็นคนเลือกแผ่นป้าย`, "success");
        }
    } catch (e) {
        console.error(e);
        if (typeof showToast === 'function') showToast("ไม่สามารถเปลี่ยนบ้านได้", "error");
    }
};

window.toggleJeopardyActive = async function () {
    // ดึงค่าล่าสุดจาก state ที่ Listener เก็บไว้ให้
    const currentState = state.config?.is_active || false;
    const newState = !currentState;

    try {
        await update(ref(db, 'jeopardy/config'), { is_active: newState });
        // แสดง Toast สั้นๆ เพื่อให้ Admin รู้ว่าคำสั่งถูกส่งแล้ว
        showToast(newState ? "เปิดเกมแล้ว! ปุ่มเข้าเล่นจะปรากฏบนจอน้อง" : "ซ่อนทางเข้าเกมแล้ว", "info");
    } catch (e) {
        console.error(e);
        showToast("ไม่สามารถเปลี่ยนสถานะเกมได้", "error");
    }
};

window.undoLastAction = async function () {
    const res = await Swal.fire({ title: 'ย้อนกลับ?', text: 'จะย้อนสถานะกลับไป 1 ก้าวล่าสุดเท่านั้น', icon: 'warning', showCancelButton: true });
    if (!res.isConfirmed) return;

    const snap = await get(ref(db, 'jeopardy/history/last_state'));
    if (snap.exists()) {
        await update(ref(db, 'jeopardy'), snap.val());
        showToast("ย้อนกลับสถานะสำเร็จ");
    } else {
        showToast("ไม่มีข้อมูลให้ย้อนกลับ", "error");
    }
}

// ปรับปรุงฟังก์ชัน selectQuestion ในหน้า Admin/Board
window.selectQuestion = async function (qId) {
    if (state.game_state.status !== 'BOARD') return;

    const q = state.questions[qId];
    // ดึงเวลาจาก config.timer_tiers ตามระดับความยาก
    const seconds = state.config.timer_tiers[q.level] || 90;
    const durationMs = seconds * 1000;

    await saveUndoState();

    // อัปเดตสถานะคำถาม
    await update(ref(db, `jeopardy/questions/${qId}`), { is_opened: true });

    // อัปเดต Game State ตาม Schema ใหม่
    await update(ref(db, 'jeopardy/game_state'), {
        status: 'QUESTION',
        active_question_id: qId,
        answering_house: state.game_state.active_house,
        is_timer_running: true,
        timer_duration: durationMs,
        timer_remaining: durationMs,
        timer_start_ts: Date.now(),
        options_revealed: true,
        last_action_log: `House ${state.game_state.active_house} selected ${q.category} ${q.points}`
    });

    // ล้าง Buzzer และรีเซ็ตสิทธิ์ Steal ของทุกบ้านในข้อนี้
    const housesUpdate = {};
    for (let i = 1; i <= 8; i++) {
        housesUpdate[`jeopardy/houses/${i}/can_steal`] = true;
    }
    await update(ref(db), {
        ...housesUpdate,
        'jeopardy/buzzers': { is_locked: false, winner: null, attempts: {} }
    });
};

window.revealOptions = async function () {
    await update(ref(db, 'jeopardy/game_state/options_revealed'), true);
    showToast("แสดงตัวเลือกบนจอแล้ว", "info");
}

async function processNextTurn(winnerHouseId = null, points = 0, isPenalty = false) {
    const updates = {};
    const gs = state.game_state;
    const q = state.questions[gs.active_question_id];

    if (winnerHouseId) {
        const house = state.houses[winnerHouseId];
        if (isPenalty) {
            // กรณีตอบผิด (Steal)
            const newPenalty = (house.penalty_points || 0) + points;
            updates[`jeopardy/houses/${winnerHouseId}/penalty_points`] = newPenalty;
            updates[`jeopardy/houses/${winnerHouseId}/jeopardy_score`] = (house.correct_points || 0) - newPenalty;
            updates[`jeopardy/questions/${gs.active_question_id}/winner_house`] = "PENALTY"; // ทำสัญลักษณ์ว่าเสียแต้ม
        } else {
            // กรณีตอบถูก
            const newCorrect = (house.correct_points || 0) + points;
            updates[`jeopardy/houses/${winnerHouseId}/correct_points`] = newCorrect;
            updates[`jeopardy/houses/${winnerHouseId}/jeopardy_score`] = newCorrect - (house.penalty_points || 0);
            updates[`jeopardy/questions/${gs.active_question_id}/winner_house`] = winnerHouseId;
        }
    }

    // นับเทิร์นให้บ้านที่ "เป็นเจ้าของคิว" (คนเลือก)
    const turnHouseId = gs.active_house;
    updates[`jeopardy/houses/${turnHouseId}/turns_played`] = (state.houses[turnHouseId].turns_played || 0) + 1;

    // คำนวณคิวถัดไป
    let nextIndex = gs.current_turn_index + 1;
    let nextRound = state.config.current_round;
    if (nextIndex >= state.config.picking_house_order.length) {
        nextIndex = 0;
        nextRound++;
    }

    updates[`jeopardy/config/current_round`] = nextRound;
    updates[`jeopardy/game_state/current_turn_index`] = nextIndex;
    updates[`jeopardy/game_state/active_house`] = state.config.picking_house_order[nextIndex];
    updates[`jeopardy/game_state/status`] = 'BOARD';
    updates[`jeopardy/game_state/active_question_id`] = null;
    updates[`jeopardy/game_state/is_timer_running`] = false;

    await update(ref(db), updates);
}

window.judgeOwner = async function (isCorrect) {
    await saveUndoState();
    const gs = state.game_state;
    const turnHouse = state.config.picking_house_order[gs.current_turn_index];
    const q = state.questions[gs.active_question_id];

    if (isCorrect) {
        await processNextTurn(turnHouse, q.points, false);
        showToast(`บ้าน ${turnHouse} ตอบถูก! ได้ ${q.points} คะแนน`);
    } else {
        await update(ref(db, 'jeopardy/game_state'), {
            status: 'STEAL_WAIT',
            is_steal_open: false,
            is_timer_running: false
        });
        showToast("เจ้าของข้อตอบผิด! เตรียมตัว STEAL", "warning");
    }
};

window.openStealBuzzer = async function () {
    const startTime = Date.now() + 500; // หน่วงนิดหน่อยให้ทุกคนเริ่มพร้อมกัน
    await update(ref(db), {
        'jeopardy/buzzers': { is_locked: false, winner: null, attempts: {} },
        'jeopardy/game_state/is_steal_open': false,
        'jeopardy/game_state/steal_start_ts': startTime, // เวลาที่ไฟเขียวจะติด (startTime + 4000ms)
        'jeopardy/game_state/countdown_active': true,
        'jeopardy/game_state/status': 'STEAL_WAIT'
    });

    // ตั้งเวลาให้ระบบเปิดรับคำตอบอัตโนมัติเมื่อถึงเวลาไฟเขียว (4 วินาทีหลังจากเริ่มไฟดวงแรก)
    setTimeout(async () => {
        await update(ref(db, 'jeopardy/game_state'), {
            is_steal_open: true,
            countdown_active: false
        });
    }, 4500);
};

function renderF1Lights(elapsed) {
    const lights = [1, 2, 3, 4, 5];
    const activeCount = Math.floor(elapsed / 800); // แสดงไฟทุกๆ 0.8 วินาที

    return `
        <div class="flex gap-4 justify-center my-8">
            ${lights.map(i => {
        const isActive = activeCount >= i;
        const isGreen = activeCount >= 6;
        return `
                    <div class="w-16 h-16 rounded-full border-4 border-slate-800 shadow-inner transition-all duration-200 
                        ${isGreen ? 'bg-emerald-500 shadow-[0_0_30px_#10b981]' : (isActive ? 'bg-red-600 shadow-[0_0_20px_#dc2626]' : 'bg-slate-700')}">
                    </div>
                `;
    }).join('')}
        </div>
    `;
}

window.judgeSteal = async function (isCorrect) {
    await saveUndoState();
    const winnerHouse = state.buzzers.winner;
    const q = state.questions[state.game_state.active_question_id];
    if (countdownInterval) clearInterval(countdownInterval); // หยุดการนับเวลาถอยหลัง
    countdownInterval = null;

    if (isCorrect) {
        await processNextTurn(winnerHouse, q.points, false);
        showToast(`บ้าน ${winnerHouse} STEAL สำเร็จ! +${q.points}`, "success");
    } else {
        const penalty = Math.ceil(q.points / 2);
        // ตอบผิดโดนหักคะแนน (Penalty)
        await processNextTurn(winnerHouse, penalty, true);
        showToast(`บ้าน ${winnerHouse} ตอบผิด! หัก -${penalty}`, "error");
    }
};

window.skipHouseTurn = async function () {
    const res = await Swal.fire({ title: 'ข้ามคิวบ้านนี้?', text: 'จะทำการข้ามสิทธิ์การเลือกของบ้านนี้ (นับเป็น 1 Turn ที่เสียไป)', icon: 'warning', showCancelButton: true });
    if (res.isConfirmed) {
        await saveUndoState();
        await processNextTurn(null, 0, 0);
        showToast("ข้ามคิวบ้านนี้แล้ว", "info");
    }
}

window.resetCurrentQuestion = async function () {
    const res = await Swal.fire({ title: 'ล้างสถานะข้อนี้?', text: 'จะกลับสู่หน้า Board โดยไม่คิดคะแนนและไม่นับ Turn', icon: 'error', showCancelButton: true });
    if (res.isConfirmed) {
        await saveUndoState();
        const updates = {};
        updates[`jeopardy/game_state/status`] = 'BOARD';
        updates[`jeopardy/questions/${state.game_state.active_question_id}/is_opened`] = false;
        updates[`jeopardy/game_state/active_question_id`] = null;
        updates[`jeopardy/game_state/is_timer_running`] = false;
        await update(ref(db), updates);
    }
}

window.showToast = function (message, type = 'success') {
    const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true
    });
    Toast.fire({ icon: type, title: message });
};

window.kickHouse = async function (houseId) {
    const res = await Swal.fire({ title: `เตะบ้าน ${houseId}?`, text: 'ระบบจะบังคับให้อุปกรณ์ของบ้านนี้หลุด เพื่อ Login ใหม่', icon: 'warning', showCancelButton: true });
    if (res.isConfirmed) {
        await set(ref(db, `jeopardy/houses/${houseId}/active_session_id`), null);
        showToast(`เตะบ้าน ${houseId} เรียบร้อย`);
    }
}

window.finishJeopardyGame = async function () {
    const result = await Swal.fire({
        title: 'ยืนยันการจบเกม?',
        text: "คะแนนของทั้ง 8 บ้านจะถูกส่งไปยัง Google Sheets เพื่อสรุปผล",
        icon: 'success',
        showCancelButton: true,
        confirmButtonColor: '#059669',
        confirmButtonText: 'บันทึกและจบเกม',
        cancelButtonText: 'ทำงานต่อ'
    });

    if (!result.isConfirmed) return;

    Swal.fire({ title: 'กำลังซิงค์ข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        // 1. เตรียมข้อมูลคะแนนสรุป
        const finalScores = {};
        Object.keys(state.houses).forEach(hId => {
            finalScores[hId] = state.houses[hId].jeopardy_score || 0;
        });

        // 2. ส่งไป Apps Script (ใช้ action ที่เราเพิ่มไว้ในขั้นตอนก่อนหน้า)
        await fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "syncJeopardyScore",
                key: CONFIG.syncKey,
                admin: user.nickname || user.fullName,
                scores: finalScores
            })
        });

        // 3. ปิดการทำงานของเกมใน Firebase (แต่ไม่ลบคะแนนเผื่อเรียกดู)
        await update(ref(db, 'jeopardy/game_state'), {
            status: 'BOARD',
            active_question_id: null,
            is_timer_running: false
        });

        await Swal.fire('สำเร็จ!', 'บันทึกคะแนนลง Google Sheets เรียบร้อยแล้ว', 'success');

    } catch (e) {
        Swal.fire('Error', 'ไม่สามารถส่งคะแนนได้: ' + e.message, 'error');
    }
};

window.resetWholeGame = async function () {
    const result = await Swal.fire({
        title: 'ล้างข้อมูลเกมทั้งหมด?',
        html: `<p class="text-sm text-red-500 font-bold">⚠️ คำเตือน: คะแนนใน Firebase จะหายไปทั้งหมด และแผ่นป้ายจะถูกเซ็ตเป็นยังไม่เล่นทุกใบ!</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'ล้างข้อมูลทันที',
        cancelButtonText: 'ยกเลิก'
    });

    if (!result.isConfirmed) return;

    Swal.fire({ title: 'กำลังรีเซ็ต...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        // 1. ล้างคะแนนและเทิร์นของทุกบ้าน
        const housesUpdate = {};
        for (let i = 1; i <= 8; i++) {
            housesUpdate[i] = {
                jeopardy_score: 0,
                turns_played: 0,
                active_session_id: state.houses[i]?.active_session_id || null
            };
        }

        // 2. เซ็ตคำถามทุกข้อเป็นยังไม่ได้เล่น
        const questionsUpdate = { ...state.questions };
        Object.keys(questionsUpdate).forEach(id => {
            questionsUpdate[id].is_opened = false;
        });

        // 3. อัปเดตลง Firebase พร้อมกัน
        await update(ref(db, 'jeopardy'), {
            houses: housesUpdate,
            questions: questionsUpdate,
            game_state: {
                status: 'BOARD',
                active_house: 1,
                current_turn_index: 0,
                active_question_id: null,
                is_timer_running: false,
                options_revealed: false,
                is_steal_open: false
            },
            config: {
                ...state.config,
                current_round: 1
            },
            buzzers: { is_locked: false, winner: null, attempts: {} }
        });

        Swal.fire('รีเซ็ตสำเร็จ', 'ข้อมูลถูกล้างเรียบร้อย เริ่มต้นใหม่ได้เลย!', 'success');

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
};

// ---------------------------------------------------------
// 7. Question Management
// ---------------------------------------------------------
let editingQuestionId = null;
let currentQSearchQuery = "";

window.saveQuestion = async function () {
    const idInput = document.getElementById('q-id-manual').value.trim();
    const category = document.getElementById('q-category').value;
    const level = document.getElementById('q-level').value;
    const points = parseInt(document.getElementById('q-points').value);
    const questionText = document.getElementById('q-text').value.trim();
    const options = document.getElementById('q-options').value.trim();
    const answerText = document.getElementById('q-answer').value.trim();
    const mediaUrl = document.getElementById('q-media').value.trim();
    const explainUrl = document.getElementById('q-explain-url').value.trim();
    const explanationText = document.getElementById('q-explanation').value.trim();

    if (!idInput || !questionText || !answerText || isNaN(points)) {
        return Swal.fire('ข้อมูลไม่ครบ', 'กรุณาระบุ ID, โจทย์, เฉลย และคะแนน', 'warning');
    }

    // แสดง Loading สั้นๆ
    Swal.fire({ title: 'กำลังบันทึกลงระบบ...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    try {
        const qId = editingQuestionId || idInput;
        const qData = {
            id: qId,
            category, level, points,
            question_text: questionText,
            options,
            answer_text: answerText,
            media_url: mediaUrl,
            explain_url: explainUrl,
            explanation_text: explanationText,
            is_opened: false,
            timestamp: Date.now()
        };

        // 1. บันทึกลง Firebase (จุดนี้เร็วมาก)
        await set(ref(db, `jeopardy/questions/${qId}`), qData);

        // 2. ปิด Loading และบอกว่าสำเร็จทันที (ไม่ต้องรอข้อ 3)
        Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1000, showConfirmButton: false });

        // 3. Sync ไปยัง Google Sheets ในเบื้องหลัง (เอา await ออก)
        fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors', // สำคัญ: ป้องกันปัญหาการรอนาน
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "syncJeopardyQuestions",
                key: CONFIG.syncKey,
                data: qData
            })
        }).catch(err => console.error("Sheet Sync Error (Background):", err));

        editingQuestionId = qId;
        const btn = document.querySelector('#form-question button[type="submit"]');
        btn.innerText = "🆙 อัปเดตข้อมูลข้อเดิม";
        btn.className = "bg-amber-600 text-white px-8 py-3 rounded-xl font-black shadow-lg hover:bg-amber-700 transition-all";

    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'ไม่สามารถบันทึกได้: ' + e.message, 'error');
    }
};
window.editQuestion = function (id) {
    const q = state.questions[id];
    if (!q) return;

    editingQuestionId = id;
    document.getElementById('q-id-manual').value = q.id;
    document.getElementById('q-id-manual').disabled = true; // ห้ามแก้ ID หลัก
    document.getElementById('q-category').value = q.category;
    document.getElementById('q-level').value = q.level;
    document.getElementById('q-points').value = q.points;
    document.getElementById('q-text').value = q.question_text;
    document.getElementById('q-options').value = q.options || "";
    document.getElementById('q-answer').value = q.answer_text;
    document.getElementById('q-media').value = q.media_url || "";
    document.getElementById('q-explain-url').value = q.explain_url || "";
    document.getElementById('q-explanation').value = q.explanation_text || "";

    document.querySelectorAll('.auto-resize-textarea').forEach(el => {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    });

    // เลื่อนหน้าจอขึ้นไปที่ฟอร์ม
    document.getElementById('form-question').scrollIntoView({ behavior: 'smooth' });
    showToast("เข้าสู่โหมดแก้ไข: " + id, "info");

    // เปลี่ยนปุ่มบันทึก
    const btn = document.querySelector('#form-question button[type="submit"]');
    btn.innerText = "🆙 อัปเดตข้อมูลคำถาม";
    btn.className = "bg-amber-600 text-white px-8 py-3 rounded-xl font-black shadow-lg hover:bg-amber-700 transition-all";
}

window.navigateQuestion = function (direction) {
    if (!state.questions) {
        showToast("ไม่พบข้อมูลคำถามในระบบ", "error");
        return;
    }

    // 1. ดึง ID ทั้งหมดมาทำเป็น List และเรียงลำดับ (ตาม ID เหมือนในตาราง)
    const sortedIds = Object.values(state.questions)
        .filter(q => q && q.id)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(q => q.id);

    if (sortedIds.length === 0) return;

    // 2. หาตำแหน่งปัจจุบัน (Index)
    let currentIndex = -1;
    if (editingQuestionId) {
        currentIndex = sortedIds.indexOf(editingQuestionId);
    } else {
        // ถ้ายังไม่ได้กดแก้ข้อไหนเลย ให้เริ่มที่ข้อแรก (กรณีคลิก 'ถัดไป') หรือข้อสุดท้าย (กรณีคลิก 'ก่อนหน้า')
        if (direction === 1) {
            editQuestion(sortedIds[0]);
            return;
        } else {
            editQuestion(sortedIds[sortedIds.length - 1]);
            return;
        }
    }

    // 3. คำนวณ Index ใหม่
    let nextIndex = currentIndex + direction;

    // ตรวจสอบขอบเขต
    if (nextIndex < 0) {
        showToast("นี่คือข้อแรกแล้ว", "info");
        return;
    }
    if (nextIndex >= sortedIds.length) {
        showToast("นี่คือข้อสุดท้ายแล้ว", "info");
        return;
    }

    // 4. เข้าสู่โหมดแก้ไขข้อที่คำนวณได้
    editQuestion(sortedIds[nextIndex]);
};

function resetQuestionForm() {
    editingQuestionId = null;
    document.getElementById('form-question').reset();
    document.getElementById('q-id-manual').disabled = false;
    document.getElementById('q-explanation').value = "";
    document.querySelectorAll('.auto-resize-textarea').forEach(el => {
        el.style.height = 'auto'; // กลับมาสูงเท่า min-height ที่ตั้งใน CSS
    });
    
    const btn = document.querySelector('#form-question button[type="submit"]');
    btn.innerText = "💾 บันทึกคำถาม";
    btn.className = "bg-indigo-600 text-white px-8 py-3 rounded-xl font-black shadow-lg hover:bg-indigo-700 transition-all";
}
window.prepareNewQuestion = function () {
    editingQuestionId = null;
    document.getElementById('form-question').reset();
    document.getElementById('q-id-manual').disabled = false;
    document.getElementById('q-id-manual').focus();

    document.querySelectorAll('.auto-resize-textarea').forEach(el => {
        el.style.height = 'auto';
    });

    const btn = document.querySelector('#form-question button[type="submit"]');
    btn.innerText = "💾 บันทึกคำถามใหม่";
    btn.className = "bg-indigo-600 text-white px-8 py-3 rounded-xl font-black shadow-lg hover:bg-indigo-700 transition-all";

    showToast("เข้าสู่โหมดเพิ่มคำถามใหม่", "info");
};

window.deleteQuestion = async function (id) {
    const res = await Swal.fire({ title: 'ลบคำถามนี้?', text: 'การกระทำนี้ลบถาวร', icon: 'error', showCancelButton: true });
    if (res.isConfirmed) {
        await remove(ref(db, `jeopardy/questions/${id}`));
        showToast("ลบคำถามแล้ว");
    }
}

// ---------------------------------------------------------
// 8. UI Tab Switcher
// ---------------------------------------------------------
window.switchTab = function (tab) {
    document.getElementById('view-play').classList.toggle('hidden', tab !== 'play');
    document.getElementById('view-manage').classList.toggle('hidden', tab !== 'manage');

    const playTab = document.getElementById('tab-play');
    const manageTab = document.getElementById('tab-manage');

    if (tab === 'play') {
        playTab.className = "bg-blue-600 px-4 py-2 rounded-lg text-sm font-bold shadow-md transition-all";
        manageTab.className = "bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-lg text-sm font-bold transition-all border border-slate-700";
    } else {
        manageTab.className = "bg-blue-600 px-4 py-2 rounded-lg text-sm font-bold shadow-md transition-all";
        playTab.className = "bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-lg text-sm font-bold transition-all border border-slate-700";
    }
}

window.handleQuestionSearch = function (val) {
    currentQSearchQuery = val.trim().toLowerCase();

    // แสดง/ซ่อนปุ่ม X (Clear)
    const btnClear = document.getElementById('btn-clear-qsearch');
    if (btnClear) btnClear.classList.toggle('hidden', val.length === 0);

    renderQuestionsTable();
};

window.clearQSearch = function () {
    const input = document.getElementById('q-search-input');
    if (input) input.value = "";
    currentQSearchQuery = "";
    document.getElementById('btn-clear-qsearch').classList.add('hidden');
    renderQuestionsTable();
};

// ฟังก์ชันปรับความสูง Textarea
function initAutoResize() {
    const textareas = document.querySelectorAll('.auto-resize-textarea');

    textareas.forEach(el => {
        // สร้างฟังก์ชันปรับขนาด
        const adjustHeight = () => {
            el.style.height = 'auto'; // รีเซ็ตเพื่อคำนวณใหม่
            el.style.height = el.scrollHeight + 'px'; // ตั้งตามความสูงจริง
        };

        // 1. ปรับตอนผู้ใช้พิมพ์
        el.addEventListener('input', adjustHeight);

        // 2. ปรับตอนโหลดหน้า (เผื่อมีค่าค้าง)
        adjustHeight();
    });
}

// เรียกใช้เมื่อ DOM โหลดเสร็จ
document.addEventListener('DOMContentLoaded', initAutoResize);
/// ---------------------------------------------------------
// 9. Board
// ---------------------------------------------------------

window.closeStealBanner = function () {
    const stealAlert = document.getElementById('steal-alert-container');
    if (stealAlert) {
        stealAlert.classList.add('hidden');
        isBannerManuallyClosed = true;
        console.log(stealAlert);
    }
};

window.confirmOpenQuestion = function (qId) {
    if (state.game_state.status !== 'BOARD') return;

    Swal.fire({
        title: 'เปิดคำถามนี้?',
        text: `มูลค่า ${state.questions[qId].points} แต้ม`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#3b82f6',
        confirmButtonText: 'ยืนยัน',
        cancelButtonText: 'ยกเลิก'
    }).then((res) => {
        if (res.isConfirmed) selectQuestion(qId);
    });
};

// --- ฟังก์ชันแสดงเฉลยแบบ Banner กลางจอ ---
window.revealAnswerOnBoard = function () {
    const gs = state.game_state;
    const q = state.questions[gs.active_question_id];
    if (!q) return;

    // อ้างอิง Elements ใน Banner
    const overlay = document.getElementById('answer-banner-overlay');
    const displayAnswer = document.getElementById('banner-answer-text');
    const displayExp = document.getElementById('banner-explanation-text');
    const expArea = document.getElementById('banner-explanation-area');
    const linkArea = document.getElementById('banner-link-area');
    const expLink = document.getElementById('banner-explanation-link');

    // 1. ใส่คำตอบหลัก
    displayAnswer.innerText = q.answer_text;

    // 2. จัดการคำอธิบาย (Plain Text)
    if (q.explanation_text && q.explanation_text.trim() !== "") {
        displayExp.innerText = q.explanation_text;
        expArea.classList.remove('hidden');
    } else {
        expArea.classList.add('hidden');
    }

    // 3. จัดการปุ่มลิงก์ (Media/Canva)
    if (q.explain_url && q.explain_url.trim() !== "") {
        expLink.href = q.explain_url;
        linkArea.classList.remove('hidden');
    } else {
        linkArea.classList.add('hidden');
    }

    // 4. แสดง Banner
    overlay.classList.remove('hidden');

    // 5. หยุดเวลา
    if (state.game_state.is_timer_running) {
        window.toggleTimer();
    }
};

// --- ฟังก์ชันปิด Banner ---
window.closeAnswerBanner = function () {
    const overlay = document.getElementById('answer-banner-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
};

function updateBoardGameState() {
    const gs = state.game_state;
    const overlay = document.getElementById('question-overlay');
    const stealAlert = document.getElementById('steal-alert-container');
    const buzz = state.buzzers; // ดึงข้อมูล Buzzer มาใช้

    if (!overlay) return;

    // --- [1] สถานะกลับสู่บอร์ดหลัก (Reset ทุกอย่าง) ---
    if (gs.status === 'BOARD') {
        overlay.classList.add('hidden');
        isBannerManuallyClosed = false;
        document.getElementById('answer-reveal-area')?.classList.add('hidden');
        document.getElementById('link-explanation')?.classList.add('hidden');
        if (stealAlert) {
            stealAlert.classList.add('hidden');
            stealAlert.innerHTML = "";
        }
        if (countdownInterval) clearInterval(countdownInterval);
        stopBoardTimer();
        return;
    }

    // --- [2] แสดงหน้าจอคำถาม (Overlay) ---
    overlay.classList.remove('hidden');
    const q = state.questions?.[gs.active_question_id];
    if (!q) return;

    // อัปเดตข้อมูลพื้นฐาน
    safeSetText('overlay-category', q.category);
    safeSetText('overlay-points', `${q.points} PTS`);
    safeSetText('overlay-text', q.question_text);
    safeSetText('display-final-answer', q.answer_text);

    // --- [3] จัดการข้อมูล Started By / Steal By (Badges ด้านล่าง) ---
    const ownerId = gs.active_house;
    safeSetText('display-owner-house', ownerId);
    if (document.getElementById('owner-house-badge')) {
        document.getElementById('owner-house-badge').innerText = ownerId;
    }

    const stealArea = document.getElementById('steal-status-area');
    if (stealArea) {
        if (gs.status === 'STEAL_WAIT' && buzz?.winner) {
            stealArea.classList.remove('hidden');
            const stealerId = buzz.winner;
            safeSetText('display-stealer-house', stealerId);
            if (document.getElementById('stealer-house-badge')) {
                document.getElementById('stealer-house-badge').innerText = stealerId;
            }
        } else {
            stealArea.classList.add('hidden');
        }
    }

    // --- [4] จัดการ STEAL ALERT (ระบบ F1 Countdown & Steal Active) ---
    if (stealAlert) {
        if (gs.status === 'STEAL_WAIT' && !isBannerManuallyClosed) {
            stealAlert.classList.remove('hidden');
            const closeBtn = `<button class="close-banner-btn" onclick="window.closeStealBanner()" title="ปิดการแจ้งเตือน">✕</button>`;

            // -- [A] ช่วงนับไฟ F1 (Countdown Active) --
            if (gs.countdown_active) {
                const elapsed = Date.now() - (gs.steal_start_ts || Date.now());
                const activeCount = Math.floor(elapsed / 800); // ติดหนึ่งดวงทุกๆ 0.8 วินาที

                // สร้าง HTML ไฟ 5 ดวง
                let lightsHTML = '<div class="flex gap-6 justify-center my-10">';
                for (let i = 1; i <= 5; i++) {
                    const isOn = activeCount >= i;
                    lightsHTML += `
                        <div class="w-24 h-24 rounded-full border-8 border-slate-900 transition-all duration-150 
                            ${isOn ? 'bg-red-600 shadow-[0_0_50px_rgba(220,38,38,0.8)]' : 'bg-slate-800 shadow-inner'}">
                        </div>`;
                }
                lightsHTML += '</div>';

                stealAlert.innerHTML = `
                    <div class="steal-prep-banner relative border-slate-900 bg-slate-950 shadow-[0_0_100px_rgba(0,0,0,0.5)]">
                        ${closeBtn}
                        <p class="text-2xl font-black text-slate-500 uppercase tracking-[0.4em] mb-2">Prepare to Steal</p>
                        ${lightsHTML}
                        <p class="text-3xl font-black text-white italic animate-pulse">WAIT FOR GREEN...</p>
                    </div>`;

                // สั่งให้หน้าจอ Refresh ตัวเองเพื่อขยับไฟ
                if (!window.countdownInterval) {
                    window.countdownInterval = setInterval(() => { updateBoardGameState(); }, 50);
                }
            }

            // -- [B] ช่วงไฟเขียว / มีคนกดแล้ว (Steal Open) --
            else if (gs.is_steal_open) {
                // ล้าง Interval การนับถอยหลัง (ถ้ามี)
                if (window.countdownInterval) {
                    clearInterval(window.countdownInterval);
                    window.countdownInterval = null;
                }

                const attempts = buzz?.attempts || {};
                const winnerId = buzz?.winner;
                const startTime = gs.steal_start_ts + 4000; // จุดที่ไฟเขียวติด (800ms * 5)
                const sortedAttempts = Object.entries(attempts).sort((a, b) => a[1] - b[1]);

                // คำนวณเวลานับถอยหลัง 5 วิหลังคนแรกกด
                let countdownHTML = '';
                if (winnerId && buzz.timestamp) {
                    const remaining = Math.max(0, (5000 - (Date.now() - buzz.timestamp)) / 1000);
                    if (remaining > 0) {
                        countdownHTML = `<p class="text-emerald-500 font-black animate-pulse">🔒 SYSTEM LOCKING IN: ${remaining.toFixed(1)}s</p>`;
                        if (!window.countdownInterval) window.countdownInterval = setInterval(() => updateBoardGameState(), 100);
                    } else {
                        countdownHTML = `<p class="text-red-600 font-black uppercase">🚫 CLOSED (TIME OUT)</p>`;
                        if (window.countdownInterval) { clearInterval(window.countdownInterval); window.countdownInterval = null; }
                    }
                } else {
                    countdownHTML = `<p class="text-2xl font-black text-emerald-500 uppercase tracking-[0.5em] animate-bounce">● RELEASED ●</p>`;
                }

                const attemptsHTML = sortedAttempts.map(([hId, ts]) => {
                    const diff = (ts - startTime) / 1000;
                    const isWinner = winnerId == hId;
                    return `
                        <div class="flex items-center gap-2 px-4 py-1.5 rounded-full ${isWinner ? 'bg-emerald-600 text-white shadow-md scale-110' : 'bg-white/80 border border-emerald-200'} transition-all">
                            <span class="font-black ${isWinner ? 'text-white' : 'text-emerald-600'} text-sm">H${hId}:</span>
                            <span class="font-mono text-xs font-bold ${isWinner ? 'text-emerald-100' : 'text-slate-600'}">+${diff.toFixed(3)}s</span>
                        </div>`;
                }).join('');

                const headerContent = winnerId
                    ? `<p class="text-2xl font-black text-emerald-600 uppercase tracking-widest mb-2">🎉 SUCCESS!</p>
                       <h2 class="text-7xl font-black text-slate-900 mb-2 italic">บ้าน ${winnerId} กดติด!</h2>`
                    : `<div class="w-full flex justify-center gap-4 mb-6">
                        ${[1, 2, 3, 4, 5].map(() => `<div class="w-12 h-12 rounded-full bg-emerald-500 shadow-[0_0_30px_#10b981]"></div>`).join('')}
                       </div>
                       <h2 class="text-8xl font-black text-slate-900 mb-4 italic animate-pulse">กดปุ่มเลย!!!</h2>`;

                stealAlert.innerHTML = `
                    <div class="steal-prep-banner steal-active-banner relative" style="border-color: #10b981; background: #f0fdf4; max-width: 900px;">
                        ${closeBtn}
                        ${headerContent}
                        <div class="mb-6">${countdownHTML}</div>
                        
                        <div class="border-t border-emerald-200 pt-5 mt-2">
                            <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Reaction Time (from green light)</p>
                            <div class="flex flex-wrap justify-center gap-3">
                                ${attemptsHTML || '<p class="text-slate-300 italic text-sm">Waiting for first press...</p>'}
                            </div>
                        </div>
                    </div>`;
            }

            // -- [C] กรณีรอ Admin สั่งเริ่ม --
            else {
                stealAlert.innerHTML = `
                    <div class="steal-prep-banner relative bg-amber-50 border-amber-500">
                        ${closeBtn}
                        <p class="text-2xl font-black text-amber-600 uppercase mb-2">❌ เจ้าของข้อตอบไม่ถูก</p>
                        <h2 class="text-6xl font-black text-slate-800 mb-4">เตรียมตัว STEAL...</h2>
                        <p class="text-xl font-bold text-amber-700 animate-pulse">⚠️ รอสัญญาณไฟจากพี่สตาฟ</p>
                    </div>`;
            }
        } else {
            // ซ่อน Overlay และล้างค่า
            if (gs.status !== 'STEAL_WAIT') {
                isBannerManuallyClosed = false;
                if (window.countdownInterval) {
                    clearInterval(window.countdownInterval);
                    window.countdownInterval = null;
                }
            }
            stealAlert.classList.add('hidden');
        }
    }

    // --- [5] เตรียมลิงก์คำอธิบาย ---
    const expLink = document.getElementById('link-explanation');
    if (expLink) {
        if (q.explain_url) {
            expLink.href = q.explain_url;
            expLink.classList.remove('hidden');
        } else {
            expLink.classList.add('hidden');
        }
    }

    // --- [6] จัดการตัวเลือก (Kahoot Style) ---
    const optionsContainer = document.getElementById('overlay-options');
    if (optionsContainer) {
        if (q.options && q.options.trim() !== "") {
            optionsContainer.classList.remove('hidden');
            // แยกข้อความด้วยการขึ้นบรรทัดใหม่
            const choices = q.options.split(/\r?\n|\\n/).filter(line => line.trim() !== "");

            // สัญลักษณ์ Kahoot: สามเหลี่ยม, ขนมเปียกปูน, วงกลม, สี่เหลี่ยม
            const symbols = [
                '<svg viewBox="0 0 32 32" style="fill:white;width:45px"><path d="M27,24.56L5,24.56L16,7L27,24.56Z"/></svg>', // Triangle
                '<svg viewBox="0 0 32 32" style="fill:white;width:45px"><path d="M4,16L16,4L28,16L16,28L4,16Z"/></svg>',   // Diamond
                '<svg viewBox="0 0 32 32" style="fill:white;width:45px"><circle cx="16" cy="16" r="11"/></svg>',         // Circle
                '<svg viewBox="0 0 32 32" style="fill:white;width:45px"><rect x="6" y="6" width="20" height="20"/></svg>' // Square
            ];

            optionsContainer.innerHTML = choices.slice(0, 4).map((choice, index) => {
                // ลบพวก "A." "B." ออกถ้าครูพิมพ์ติดมา
                let cleanChoice = choice.trim().replace(/^[A-D][.:]\s*/i, "");

                return `
                <div class="kahoot-option opt-${index}">
                    <span class="kahoot-symbol">${symbols[index]}</span>
                    <span class="kahoot-text">${cleanChoice}</span>
                </div>`;
            }).join('');

            optionsContainer.className = "kahoot-grid revealed"; // ใช้ grid layout
        } else {
            optionsContainer.classList.add('hidden');
        }
    }

    // --- [7] จัดการ Answering House (ใครกำลังตอบ) ---
    const currentAnswering = (gs.status === 'STEAL_WAIT' && buzz?.winner) ? buzz.winner : gs.active_house;
    safeSetText('display-answering-house', currentAnswering);

    // --- [8] จัดการ Timer (นาที:วินาที) ---
    if (gs.is_timer_running) {
        startBoardTimer(gs.timer_duration, gs.timer_start_ts);
    } else {
        stopBoardTimer();
        const secTotal = Math.floor(gs.timer_remaining / 1000);
        const mins = Math.floor(secTotal / 60);
        const secs = secTotal % 60;
        safeSetText('overlay-timer', `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
    }
}

function startBoardTimer(duration, startTs) {
    if (boardTimerInterval) clearInterval(boardTimerInterval);
    const display = document.getElementById('overlay-timer');

    boardTimerInterval = setInterval(() => {
        const elapsed = Date.now() - startTs;
        const remaining = Math.max(0, duration - elapsed);

        // --- ส่วนที่แก้ไข: คำนวณ นาที และ วินาที ---
        const totalSeconds = Math.floor(remaining / 1000);
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;

        if (display) {
            // แสดงผลรูปแบบ 01:30
            display.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

            // ถ้าเหลือน้อยกว่า 10 วินาที ให้เป็นสีแดงและกะพริบ
            if (totalSeconds < 10) {
                display.className = "text-4xl font-black tabular-nums text-red-600 animate-pulse";
            } else {
                display.className = "text-4xl font-black tabular-nums text-slate-800";
            }
        }

        if (remaining <= 0) {
            clearInterval(boardTimerInterval);
            // พ่น Event หรือเล่นเสียงหมดเวลาตรงนี้ได้
        }
    }, 200); // ปรับการอัปเดตเป็นทุก 200ms เพื่อประหยัด CPU เพราะไม่ต้องโชว์มิลลิวินาทีแล้ว
}

window.toggleTimer = async function () {
    const gs = state.game_state;
    const isRunning = gs.is_timer_running;

    if (isRunning) {
        // --- จังหวะกด "หยุด" ---
        // คำนวณเวลาที่เหลืออยู่ ณ วินาทีที่กดหยุด
        const elapsed = Date.now() - gs.timer_start_ts;
        const remaining = Math.max(0, gs.timer_duration - elapsed);

        await update(ref(db, 'jeopardy/game_state'), {
            is_timer_running: false,
            timer_remaining: remaining // เก็บเวลาที่เหลือไว้ใน DB
        });
        showToast("หยุดเวลาชั่วคราว", "warning");
    } else {
        await update(ref(db, 'jeopardy/game_state'), {
            is_timer_running: true,
            timer_duration: gs.timer_remaining,
            timer_start_ts: Date.now()
        });
        showToast("เดินเวลาต่อ", "success");
    }
};

function stopBoardTimer() {
    if (boardTimerInterval) clearInterval(boardTimerInterval);
}

// ผูกฟังก์ชันเฉลยเพื่อเด้งไปดู Canva/คำอธิบาย
document.getElementById('btn-reveal-answer')?.addEventListener('click', () => {
    const q = state.questions[state.game_state.active_question_id];
    Swal.fire({
        title: 'เฉลยคำตอบ',
        html: `
            <div class="text-left p-4 bg-slate-50 rounded-2xl border">
                <p class="font-black text-2xl text-emerald-600 mb-4">${q.answer_text}</p>
                ${q.explain_url ? `<a href="${q.explain_url}" target="_blank" class="block w-full bg-blue-600 text-white p-3 rounded-xl text-center font-bold">ดูคำอธิบาย (Canva)</a>` : ''}
            </div>
        `,
        confirmButtonText: 'กลับสู่บอร์ด'
    });
});