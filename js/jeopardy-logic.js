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
    const data = snapshot.val();

    // 1. ถ้าไม่มีข้อมูลเลย (Firebase ว่างเปล่า) ให้สร้างโครงสร้างใหม่แล้วจบการทำงานรอบนี้
    if (!data || !data.config) {
        initializeGameStructure();
        return;
    }

    // 2. ดักฟังคำสั่งขึ้น Banner (เฉพาะหน้า Board)
    // ตรวจสอบข้อมูลแบบลึก (Deep Check) ป้องกัน Error ตั้งแต่บรรทัดแรก
    if (window.isBoardPage && data.game_state) {
        const gs = data.game_state;
        const oldTs = state?.game_state?.manual_result_ts || 0;
        const newTs = data.game_state.manual_result_ts || 0;
        const hasActiveQ = data.game_state.active_question_id;
        const isNotBoard = data.game_state.status !== 'BOARD';
        const lastForceClose = state?.game_state?.force_close_banner_ts || 0;
        const newForceClose = gs.force_close_banner_ts || 0;


        if (newForceClose > lastForceClose) {
            isBannerManuallyClosed = true; // สั่งปิด Banner ในเครื่อง Board นี้ทันที
        }

        // ถ้ามีการกดตัดสินใหม่ และมีคำถามเปิดอยู่จริง ถึงจะโชว์ Banner
        if (isNotBoard && hasActiveQ && newTs > oldTs) {
            window.showResultBanner(data.game_state.manual_result);
        }
    }

    // 3. [สำคัญ] อัปเดตข้อมูลลงตัวแปร state หลัก ก่อนจะเริ่ม Render ส่วนอื่นๆ
    state = data;

    // 4. จัดการปุ่ม Toggle (เฉพาะหน้า Admin)
    const btnToggle = document.getElementById('btn-toggle-game');
    if (btnToggle && state.config) {
        const isActive = state.config.is_active;
        btnToggle.innerText = isActive ? "ปิดเกมซ่อนทางเข้า (ON)" : "เปิดเกมให้น้องเข้า (OFF)";
        btnToggle.className = isActive
            ? "flex-1 md:flex-none bg-red-600 text-white px-6 py-2.5 rounded-xl font-black text-xs hover:bg-red-700 transition-all shadow-md"
            : "flex-1 md:flex-none bg-emerald-600 text-white px-6 py-2.5 rounded-xl font-black text-xs hover:bg-emerald-700 transition-all shadow-md";
    }

    // 5. อัปเดตข้อมูลพื้นฐาน (ใช้ Optional Chaining ?. เพื่อกันพัง)
    safeSetText('display-round', state.config?.current_round || 1);
    safeSetText('display-turn-house', state.game_state?.active_house || 'END');
    safeSetText('display-active-house', state.game_state?.active_house || '-');

    // 6. หน้า Admin Tools: ตรวจสอบ Elements ก่อนสั่ง Render
    if (document.getElementById('houses-list')) renderHouseStatus();
    if (document.getElementById('jeopardy-grid')) renderQuestionGrid();
    if (document.getElementById('questions-table-body')) renderQuestionsTable();

    // 7. หน้า Admin Dashboard (Panel)
    const panelIdle = document.getElementById('panel-idle');
    if (panelIdle) renderDashboard();

    // 8. หน้า Board (Projector)
    if (window.isBoardPage) {
        renderBoard(); // ฟังก์ชันนี้จะไปเรียก updateBoardGameState อีกที
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

    // 1. ดึงสถานะต่างๆ และตัวแปรพื้นฐาน
    const optionsText = q.options ? q.options.replace(/\\n/g, '\n') : "ไม่มีตัวเลือก (ข้อเขียน)";
    const selectedIdx = gs.selected_answer;
    const labels = ['A', 'B', 'C', 'D'];
    const choices = q.options ? q.options.split(/\r?\n|\\n/).filter(line => line.trim() !== "") : [];
    const isJudged = gs.is_judged || false; // ดึงสถานะว่าตัดสินไปหรือยัง

    // 2. เตรียม HTML สำหรับปุ่ม "จบคำถาม"
    // const finalizeBtnHTML = `
    //     <div class="mt-4 pt-4 border-t-2 border-slate-200 animate-fade-in">
    //         <button onclick="window.finalizeQuestion()" 
    //             class="w-full bg-slate-900 hover:bg-black text-white py-4 rounded-2xl font-black shadow-2xl transition-all flex flex-col items-center justify-center gap-1 active:scale-95 border-2 border-slate-700">
    //             <span class="text-[10px] text-slate-400 uppercase tracking-widest">Done / Next Player</span>
    //             <span class="text-base flex items-center gap-2">🏁 จบคำถามนี้ และเปลี่ยนคิว</span>
    //         </button>
    //     </div>
    // `;

    // 3. เตรียม HTML สำหรับแสดงสิ่งที่น้องเลือก (MCQ Preview)
    let choicePreviewHTML = "";
    if (selectedIdx !== null && selectedIdx !== undefined) {
        const selectedText = choices[selectedIdx] ? choices[selectedIdx].trim().replace(/^[A-D][.:]\s*/i, "") : "ไม่พบข้อความ";
        choicePreviewHTML = `
            <div class="mb-4 p-4 bg-blue-50 border-2 border-blue-200 rounded-2xl animate-fade-in">
                <p class="text-[10px] font-black text-blue-500 uppercase mb-2">Student's Selection:</p>
                <div class="flex items-center gap-3">
                    <span class="w-10 h-10 bg-blue-600 text-white rounded-lg flex items-center justify-center font-black text-xl shadow-md">${labels[selectedIdx]}</span>
                    <p class="font-bold text-slate-700 text-sm">${selectedText}</p>
                </div>
                <!-- ปุ่มตรวจคำตอบ MCQ -->
                <button onclick="window.checkCurrentOption()" 
                    class="w-full mt-3 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-xl font-black text-xs shadow-lg transition-all active:scale-95">
                    🔍 ตรวจคำตอบนี้ (โชว์ Banner บนบอร์ด)
                </button>
            </div>
        `;
    }

    // 4. อัปเดตข้อมูล Text พื้นฐานบนจอ Admin
    safeSetText('aq-category', q.category);
    safeSetText('aq-level', q.level);
    safeSetText('aq-points', q.points);
    safeSetText('aq-text', q.question_text);
    safeSetText('aq-options', optionsText);
    safeSetText('aq-answer', q.answer_text);

    // 5. จัดการแผงควบคุม (Owner / Steal)
    const ctrlOwner = document.getElementById('ctrl-owner');
    const ctrlStealOpen = document.getElementById('ctrl-steal-open');
    const ctrlStealJudge = document.getElementById('ctrl-steal-judge');

    if (!ctrlOwner || !ctrlStealOpen || !ctrlStealJudge) return;

    // ซ่อนทุดอย่างก่อนเพื่อเตรียมแสดงตามสถานะ
    ctrlOwner.classList.add('hidden');
    ctrlStealOpen.classList.add('hidden');
    ctrlStealJudge.classList.add('hidden');

    const hasOptions = q.options && q.options.trim() !== "";

    // -- CASE A: คิวเจ้าของข้อ (Owner Phase) --
    if (gs.status === 'QUESTION') {
        ctrlOwner.classList.remove('hidden');

        if (isJudged) {
            ctrlOwner.innerHTML = `
            <div class="p-4 bg-emerald-50 border-2 border-emerald-200 rounded-2xl text-center">
                <p class="text-emerald-600 font-black text-sm mb-1">✅ ตัดสินคะแนนเรียบร้อย</p>
                <p class="text-slate-400 text-[10px] uppercase">กดปุ่มสีแดงด้านบนเพื่อเริ่มข้อถัดไป</p>
            </div>
        `;
        } else {
            ctrlOwner.innerHTML = choicePreviewHTML + `
            <p class="text-xs font-black text-slate-600 mb-3 text-center uppercase tracking-widest">Judge Owner: House ${gs.active_house}</p>
            <div class="flex gap-2">
                <button onclick="window.triggerManualResult(true); judgeOwner(true);" 
                    class="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-3 rounded-xl font-bold shadow-md transition-all active:scale-95">✅ ถูก</button>
                <button onclick="window.triggerManualResult(false); judgeOwner(false);" 
                    class="flex-1 bg-red-50 hover:bg-red-100 text-red-600 py-3 rounded-xl font-bold border border-red-200 transition-all active:scale-95">❌ ผิด / ข้าม</button>
            </div>
        `;
        }
    }
    // -- CASE B: คิวขโมย (Steal Phase) --
    else if (gs.status === 'STEAL_WAIT') {
        if (state.buzzers?.winner) {
            ctrlStealJudge.classList.remove('hidden');

            if (isJudged) {
                // ตัดสิน Steal แล้ว: โชว์ปุ่มจบคำถาม
                ctrlStealJudge.innerHTML = `
                    <div class="p-4 bg-purple-50 border-2 border-purple-200 rounded-2xl text-center">
                        <p class="text-purple-600 font-black text-sm mb-1">🎯 ตัดสิน Steal เรียบร้อย</p>
                        <p class="text-slate-400 text-[10px] uppercase tracking-tighter">ข้ามไปข้อถัดไปเมื่อพร้อม</p>
                    </div>
                `;
            } else {
                // รอ Admin ตัดสินคนขโมย
                ctrlStealJudge.innerHTML = choicePreviewHTML + `
                    <div class="flex items-center justify-between mb-3">
                        <p class="text-xs font-black text-purple-700 uppercase">Judge Stealer</p>
                        <span class="bg-purple-600 text-white px-3 py-1 rounded-full text-sm font-black shadow-md italic">House ${state.buzzers.winner}</span>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="window.triggerManualResult(true); judgeSteal(true);" 
                            class="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-3 rounded-xl font-bold shadow-md transition-all active:scale-95">✅ ถูก</button>
                        <button onclick="window.triggerManualResult(false); judgeSteal(false);" 
                            class="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 rounded-xl font-bold shadow-md transition-all active:scale-95">❌ ผิด</button>
                    </div>
                `;
            }
        } else {
            // รอเปิด Steal
            ctrlStealOpen.classList.remove('hidden');
            const btnSteal = ctrlStealOpen.querySelector('button');
            if (gs.is_steal_open) {
                btnSteal.innerText = "⏳ ระบบเปิดแล้ว... รอน้องกดปุ่ม";
                btnSteal.disabled = true;
                btnSteal.className = "w-full bg-slate-200 text-slate-500 py-4 rounded-xl font-black cursor-not-allowed";

                const cancelBtnId = 'admin-cancel-steal-btn';
                if (!document.getElementById(cancelBtnId)) {
                    const cancelBtn = document.createElement('button');
                    cancelBtn.id = cancelBtnId;
                    cancelBtn.innerText = "❌ ไม่มีคนขโมย (ปิดหน้าจอโปรเจกเตอร์)";
                    cancelBtn.className = "w-full mt-3 bg-red-50 text-red-500 py-2 rounded-xl text-xs font-bold border border-red-100 hover:bg-red-500 hover:text-white transition-all";
                    cancelBtn.onclick = window.adminForceCloseSteal;
                    ctrlStealOpen.appendChild(cancelBtn);
                }
            } else {
                btnSteal.innerText = "⚡ ปล่อยสัญญาณ STEAL (ไฟเหลือง)";
                btnSteal.disabled = false;
                btnSteal.className = "w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-xl font-black shadow-lg shadow-orange-200 animate-pulse transition-all active:scale-95";
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


let lastScores = {};
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
        const isChanged = lastScores[hId] !== undefined && lastScores[hId] !== score;
        lastScores[hId] = score;

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
                
                <!-- 2. ส่วนคะแนนหลัก (ที่มี Animation) -->
                <div class="flex-1">
                    <p class="text-2xl font-black ${isActive ? 'text-blue-700' : 'text-slate-800'} leading-none ${isChanged ? 'score-animate' : ''}">
                        ${score}
                    </p>
                </div>

                <!-- 3. ส่วนสถานะ Ping -->
                <div class="flex flex-col items-end">
                    <span class="text-[10px] font-mono ${isOnline ? 'text-emerald-500' : 'text-slate-300'}">
                        ${isOnline ? ping + 'ms' : 'OFFLINE'}
                    </span>
                </div>

                <!-- 4. ส่วนสถิติละเอียด (Correct / Penalty) -->
                <div class="flex flex-col items-end text-sm font-bold leading-tight border-x border-slate-100 px-2 min-w-[55px]">
                    <span class="text-emerald-500">+${correct}</span>
                    <span class="text-red-400">-${penalty}</span>
                </div>

                <!-- 5. ส่วน Turns และสถานะพิเศษ -->
                <div class="text-right flex flex-col items-end gap-1 min-w-[45px]">
                    <span class="text-[11px] font-black text-black uppercase">T: ${h.turns_played || 0}/2</span>
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
// --- [เพิ่มใหม่] ฟังก์ชันเปิดหน้าต่างแก้ไขคะแนน Jeopardy ---
window.openJeopardyScoreEditor = async function () {
    if (!state.houses) return;

    let tableHtml = `
        <div class="overflow-x-auto custom-scrollbar">
            <table class="w-full text-left text-xs border-collapse">
                <thead>
                    <tr class="bg-slate-100 text-slate-500 uppercase font-black">
                        <th class="p-2 text-center">บ้าน</th>
                        <th class="p-2 text-center">Correct (+)</th>
                        <th class="p-2 text-center">Penalty (-)</th>
                        <th class="p-2 text-center">Net Score</th>
                    </tr>
                </thead>
                <tbody class="divide-y">
    `;

    for (let i = 1; i <= 8; i++) {
        const h = state.houses[i] || { correct_points: 0, penalty_points: 0, jeopardy_score: 0 };
        tableHtml += `
            <tr class="hover:bg-slate-50">
                <td class="p-2 text-center font-black text-blue-600 bg-blue-50/30">บ.${i}</td>
                <td class="p-2">
                    <input type="number" id="edit-correct-${i}" 
                        oninput="recalculateEditRow(${i})"
                        class="w-full p-2 border-2 border-slate-100 rounded-lg text-center font-bold text-emerald-600" 
                        value="${h.correct_points || 0}">
                </td>
                <td class="p-2">
                    <input type="number" id="edit-penalty-${i}" 
                        oninput="recalculateEditRow(${i})"
                        class="w-full p-2 border-2 border-slate-100 rounded-lg text-center font-bold text-red-500" 
                        value="${h.penalty_points || 0}">
                </td>
                <td class="p-2 text-center">
                    <span id="edit-net-display-${i}" class="text-sm font-black text-slate-700">${(h.correct_points || 0) - (h.penalty_points || 0)}</span>
                </td>
            </tr>
        `;
    }

    tableHtml += `</tbody></table></div>`;

    const { value: formValues } = await Swal.fire({
        title: 'Jeopardy Master Score Editor',
        html: tableHtml,
        width: '600px',
        showCancelButton: true,
        confirmButtonText: '💾 บันทึกการเปลี่ยนแปลง',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#4f46e5',
        preConfirm: () => {
            let updates = {};
            for (let i = 1; i <= 8; i++) {
                const correct = parseInt(document.getElementById(`edit-correct-${i}`).value) || 0;
                const penalty = parseInt(document.getElementById(`edit-penalty-${i}`).value) || 0;
                updates[i] = {
                    ...state.houses[i], // เก็บค่าเดิม (session_id, etc.)
                    correct_points: correct,
                    penalty_points: penalty,
                    jeopardy_score: correct - penalty
                };
            }
            return updates;
        }
    });

    if (formValues) {
        saveManualJeopardyScores(formValues);
    }
};

// ฟังก์ชันคำนวณคะแนน Net ในตารางแบบ Real-time (ช่วยให้ Admin เห็นผลก่อนกดบันทึก)
window.recalculateEditRow = function (houseId) {
    const c = parseInt(document.getElementById(`edit-correct-${houseId}`).value) || 0;
    const p = parseInt(document.getElementById(`edit-penalty-${houseId}`).value) || 0;
    document.getElementById(`edit-net-display-${houseId}`).innerText = (c - p).toLocaleString();
};

// ฟังก์ชันบันทึกข้อมูลทั้งหมดลง Firebase
async function saveManualJeopardyScores(updatedHouses) {
    Swal.fire({ title: 'กำลังบันทึก...', didOpen: () => Swal.showLoading() });

    try {
        await saveUndoState(); // เซฟประวัติเผื่อกดพลาด

        const { ref, update } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js");

        // อัปเดตกิ่ง houses ทั้งหมด
        await update(ref(db, 'jeopardy/houses'), updatedHouses);

        // Log กิจกรรม
        await update(ref(db, 'jeopardy/game_state'), {
            last_action_log: `Admin manually adjusted all scores at ${new Date().toLocaleTimeString()}`
        });

        Swal.fire({ icon: 'success', title: 'อัปเดตคะแนนเรียบร้อย', timer: 1500, showConfirmButton: false });
    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'ไม่สามารถบันทึกคะแนนได้', 'error');
    }
}
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
        selected_answer: null,
        wrong_answers: [],
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

window.selectJeopardyAnswer = async function (answerIndex) {
    try {
        // 1. ตรวจสอบ Database (ต้องมี db ถึงจะทำงานต่อได้)
        if (typeof db === 'undefined' || !db) {
            console.error("DB System is not ready.");
            return;
        }

        // 2. ดึงข้อมูล State (รองรับทั้งชื่อ 'state' และ 'gameState' เพื่อความยืดหยุ่น)
        const currentState = (typeof state !== 'undefined') ? state :
            (typeof gameState !== 'undefined') ? gameState : null;

        if (!currentState || !currentState.game_state) {
            console.warn("State data is missing.");
            return;
        }

        const gs = currentState.game_state;

        // 3. ตรวจสอบสถานะเกม (ห้ามกดถ้าอยู่หน้าเลือกแผ่นป้ายปกติ)
        if (gs.status === 'BOARD') return;

        // 4. ตรวจสอบสถานะ Stun (เฉพาะหน้า Buzzer ของน้อง)
        // ถ้าหน้าไหนไม่มีตัวแปร isStunned ให้ถือว่าเป็น false (ไม่มีการล็อคปุ่ม)
        const currentStunStatus = (typeof isStunned !== 'undefined') ? isStunned : false;
        if (currentStunStatus) return;

        // 5. ตรวจสอบสิทธิ์การกด (Permission Check)
        const user = (typeof checkAuth === 'function') ? checkAuth() : null;

        // ตรวจสอบว่าเราอยู่หน้า Buzzer ของน้องหรือไม่
        const isBuzzerPage = window.location.pathname.includes('jeopardy-buzzer.html');

        if (isBuzzerPage) {
            // ถ้าเป็นหน้าน้อง: ต้องเช็คว่าเป็นคิวบ้านเราจริงไหม
            if (!user || !user.house) return;

            const buzzerData = currentState.buzzers || {};
            const currentAnsweringHouse = (gs.status === 'STEAL_WAIT' && buzzerData.winner)
                ? buzzerData.winner.toString()
                : gs.active_house.toString();

            const myHouse = user.house.toString();
            if (currentAnsweringHouse !== myHouse) {
                console.log("Not your turn!");
                return;
            }
        }
        // ถ้าไม่ใช่หน้า Buzzer (เป็นหน้า Admin/Board): Admin กดได้ตลอดเพื่อช่วยเลือกให้น้อง

        // 6. ส่งข้อมูลขึ้น Firebase
        // นำเข้าฟังก์ชัน ref และ update จาก Firebase (เพื่อกัน Bug กรณีลืม Import)
        const { ref, update } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js");

        await update(ref(db, 'jeopardy/game_state'), {
            selected_answer: answerIndex
        });

        // 7. เสียงตอบรับ (ถ้ามี)
        if (typeof playBeep === 'function') playBeep(550, 0.05);

    } catch (error) {
        console.error("Critical Error in selectJeopardyAnswer:", error);
    }
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
    const q = state.questions[gs.active_question_id];
    const houseId = gs.active_house;

    if (isCorrect) {
        const house = state.houses[houseId];
        const newCorrect = (house.correct_points || 0) + q.points;
        const newScore = newCorrect - (house.penalty_points || 0);

        await update(ref(db), {
            [`jeopardy/houses/${houseId}/correct_points`]: newCorrect,
            [`jeopardy/houses/${houseId}/jeopardy_score`]: newScore,
            [`jeopardy/questions/${gs.active_question_id}/winner_house`]: houseId,
            [`jeopardy/game_state/is_judged`]: true // บันทึกว่าตัดสินแล้ว
        });
        showToast(`บวกคะแนนให้บ้าน ${houseId} เรียบร้อย`, "success");
    } else {
        await update(ref(db, 'jeopardy/game_state'), {
            status: 'STEAL_WAIT',
            is_steal_open: false,
            is_timer_running: false,
            is_judged: false // ยังไม่จบ เพราะต้องรอ Steal
        });
        showToast("เจ้าของข้อตอบผิด! เตรียมตัว STEAL", "warning");
    }
};

window.openStealBuzzer = async function () {
    const startTime = Date.now() + 500;
    // สุ่มเวลาที่จะ "แช่ไฟแดง" ไว้ ก่อนจะเขียว (1,000ms - 10,000ms)
    const randomGreenDelay = Math.floor(Math.random() * 9000) + 1000;

    await update(ref(db), {
        'jeopardy/buzzers': { is_locked: false, winner: null, attempts: {} },
        'jeopardy/game_state/is_steal_open': false,
        'jeopardy/game_state/steal_start_ts': startTime,
        'jeopardy/game_state/steal_random_delay': randomGreenDelay, // บันทึกค่าสุ่มลง DB เพื่อให้ทุกเครื่องตรงกัน
        'jeopardy/game_state/countdown_active': true,
        'jeopardy/game_state/status': 'STEAL_WAIT'
    });

    // ระบบจะเปิดเขียวอัตโนมัติเมื่อครบเวลา (4วินาทีไฟแดง + เวลาสุ่ม)
    setTimeout(async () => {
        await update(ref(db, 'jeopardy/game_state'), {
            is_steal_open: true,
            countdown_active: false
        });
    }, 4000 + randomGreenDelay + 500);
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
    const gs = state.game_state;
    const q = state.questions[gs.active_question_id];
    const winnerHouse = state.buzzers.winner;

    if (!winnerHouse) return;
    const house = state.houses[winnerHouse];

    if (isCorrect) {
        const newCorrect = (house.correct_points || 0) + q.points;
        const newScore = newCorrect - (house.penalty_points || 0);
        await update(ref(db), {
            [`jeopardy/houses/${winnerHouse}/correct_points`]: newCorrect,
            [`jeopardy/houses/${winnerHouse}/jeopardy_score`]: newScore,
            [`jeopardy/questions/${gs.active_question_id}/winner_house`]: winnerHouse,
            [`jeopardy/game_state/is_judged`]: true
        });
        showToast(`บ้าน ${winnerHouse} Steal สำเร็จ!`, "success");
    } else {
        const penalty = Math.ceil(q.points / 2);
        const newPenalty = (house.penalty_points || 0) + penalty;
        const newScore = (house.correct_points || 0) - newPenalty;
        await update(ref(db), {
            [`jeopardy/houses/${winnerHouse}/penalty_points`]: newPenalty,
            [`jeopardy/houses/${winnerHouse}/jeopardy_score`]: newScore,
            [`jeopardy/game_state/is_judged`]: true // ตัดสินแล้ว (แม้จะผิด)
        });
        showToast(`บ้าน ${winnerHouse} ตอบผิด หักคะแนนเรียบร้อย`, "error");
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

window.finalizeQuestion = async function () {
    const gs = state.game_state;
    if (!gs.active_question_id) return;
    
    // ยืนยันการปิด (เผื่อมือลั่น)
    const confirm = await Swal.fire({
        title: 'ยืนยันจบคำถามนี้?',
        text: "ระบบจะเปลี่ยนคิวไปยังบ้านถัดไปทันที",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ใช่, จบคำถาม',
        cancelButtonText: 'ยกเลิก'
    });

    if (!confirm.isConfirmed) return;

    // 1. เพิ่ม Turns Played ให้บ้านที่เป็นเจ้าของคิวเลือก (ไม่ว่าใครจะตอบถูก/ผิด)
    const turnHouseId = gs.active_house;
    const currentTurns = state.houses[turnHouseId].turns_played || 0;

    // 2. คำนวณคิวถัดไป
    let nextIndex = gs.current_turn_index + 1;
    let nextRound = state.config.current_round;
    if (nextIndex >= state.config.picking_house_order.length) {
        nextIndex = 0;
        nextRound++;
    }

    const updates = {};
    updates[`jeopardy/houses/${turnHouseId}/turns_played`] = currentTurns + 1;
    updates[`jeopardy/config/current_round`] = nextRound;
    updates[`jeopardy/game_state/current_turn_index`] = nextIndex;
    updates[`jeopardy/game_state/active_house`] = state.config.picking_house_order[nextIndex];
    updates[`jeopardy/game_state/status`] = 'BOARD'; // กลับไปหน้าบอร์ด
    updates[`jeopardy/game_state/active_question_id`] = null;
    updates[`jeopardy/game_state/is_timer_running`] = false;
    updates[`jeopardy/game_state/is_judged`] = false; // Reset สถานะการตัดสิน
    updates[`jeopardy/game_state/selected_answer`] = null;
    updates[`jeopardy/game_state/wrong_answers`] = [];

    await update(ref(db), updates);
    showToast("จบคำถามและเปลี่ยนเทิร์นแล้ว");
};

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

window.adminForceCloseSteal = async function () {
    try {
        // อัปเดต State ใน Firebase เพื่อสั่งให้ Board ทุกเครื่องรับทราบ
        await update(ref(db, 'jeopardy/game_state'), {
            is_steal_open: false,
            countdown_active: false,
            // ส่งสัญญาณพิเศษเพื่อให้ตัวแปร local 'isBannerManuallyClosed' บนบอร์ดทำงาน
            force_close_banner_ts: Date.now()
        });
        showToast("สั่งปิดหน้าจอ Steal บนบอร์ดแล้ว", "info");
    } catch (e) {
        console.error(e);
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
window.revealAnswerOnBoard = function (alreadyShownBanner = false) {
    const gs = state.game_state;
    const q = state.questions[gs.active_question_id];
    if (!q) return;

    const hasOptions = q.options && q.options.trim() !== "";

    // ถ้ามีตัวเลือก และยังไม่ได้โชว์ Banner (เช่น กดปุ่ม Check บนบอร์ดครั้งแรก)
    if (hasOptions && !alreadyShownBanner) {
        const selectedIdx = gs.selected_answer;
        const labels = ['A', 'B', 'C', 'D'];
        const choices = q.options.split(/\r?\n|\\n/).filter(line => line.trim() !== "");
        const correctText = q.answer_text.trim().toLowerCase();
        
        let isCorrect = false;
        if (selectedIdx !== null && selectedIdx !== undefined) {
            const selectedLabel = labels[selectedIdx].toLowerCase();
            const selectedFullText = choices[selectedIdx].trim().toLowerCase();
            
            // Logic: ถ้าเฉลยขึ้นต้นด้วย "A." หรือในเฉลยมีข้อความตรงกับข้อที่เลือก
            if (correctText.startsWith(selectedLabel) || correctText.includes(selectedFullText)) {
                isCorrect = true;
            }
        }
        window.showResultBanner(isCorrect); // ไปโชว์ Banner ก่อนแล้วค่อยกลับมาโชว์เฉลยละเอียด
        return;
    }

    // --- ส่วนแสดงเฉลยละเอียด (Detailed Overlay) ---
    const overlay = document.getElementById('answer-banner-overlay');
    const displayAnswer = document.getElementById('banner-answer-text');
    const displayExp = document.getElementById('banner-explanation-text');
    const expArea = document.getElementById('banner-explanation-area');
    const linkArea = document.getElementById('banner-link-area');
    const expLink = document.getElementById('banner-explanation-link');

    displayAnswer.innerText = q.answer_text;

    if (q.explanation_text) {
        displayExp.innerText = q.explanation_text;
        expArea.classList.remove('hidden');
    } else {
        expArea.classList.add('hidden');
    }

    if (q.explain_url) {
        expLink.href = q.explain_url;
        linkArea.classList.remove('hidden');
    } else {
        linkArea.classList.add('hidden');
    }

    overlay.classList.remove('hidden');
    if (gs.is_timer_running) window.toggleTimer();
};

// --- ฟังก์ชันสำหรับ Admin สั่งให้หน้า Board ขึ้น Banner ถูก/ผิด (ใช้กับข้อเขียน) ---
window.triggerManualResult = async function (isCorrect) {
    try {
        await update(ref(db, 'jeopardy/game_state'), {
            manual_result: isCorrect,
            manual_result_ts: Date.now() // ใส่ timestamp เพื่อให้ Board รู้ว่ามีการกดใหม่
        });
    } catch (e) {
        console.error("Trigger Manual Result Error:", e);
    }
};

// --- ฟังก์ชันตรวจสอบคำตอบที่ Admin เลือก และสั่งให้ขึ้น Banner (ใช้กับข้อมีตัวเลือก) ---
window.checkCurrentOption = function () {
    const gs = state?.game_state;
    const q = state?.questions?.[gs?.active_question_id];

    // 1. ตรวจสอบเบื้องต้นว่ามีข้อมูลครบไหม
    if (!gs || !q) {
        console.warn("Check failed: Missing game state or question data.");
        return;
    }

    // 2. ถ้ายังไม่มีใครเลือกข้อไหนเลย
    if (gs.selected_answer === null || gs.selected_answer === undefined) {
        if (typeof showToast === 'function') showToast("น้องยังไม่ได้เลือกคำตอบ", "warning");
        return;
    }

    const labels = ['A', 'B', 'C', 'D'];

    // 3. จัดการตัวเลือก (ตรวจสอบว่ามีตัวเลือกจริงไหม)
    const optionsRaw = q.options || "";
    const choices = optionsRaw.split(/\r?\n|\\n/).filter(line => line.trim() !== "");

    // 4. ตรวจสอบว่า Index ที่เลือก มีข้อมูลใน Array จริงๆ หรือไม่ (ป้องกัน Error toLowerCase)
    const rawSelectedChoice = choices[gs.selected_answer];
    if (!rawSelectedChoice) {
        console.error("Selected choice is undefined at index:", gs.selected_answer);
        return;
    }

    // 5. ทำความสะอาดข้อมูลก่อนเปรียบเทียบ
    const correctText = (q.answer_text || "").trim().toLowerCase();
    const selectedLabel = labels[gs.selected_answer].toLowerCase();
    const selectedFullText = rawSelectedChoice.trim().toLowerCase().replace(/^[A-D][.:]\s*/i, "");

    // 6. Logic ตรวจสอบ: ถูกถ้าเฉลยขึ้นต้นด้วย Label (เช่น 'a') หรือในเฉลยมีข้อความคำตอบนั้นอยู่
    const isCorrect = correctText.startsWith(selectedLabel) || correctText.includes(selectedFullText);

    if (!isCorrect) {
        let wrongList = gs.wrong_answers || [];
        if (!wrongList.includes(gs.selected_answer)) {
            wrongList.push(gs.selected_answer);
            // อัปเดตรายการข้อที่ผิดลง Firebase
            update(ref(db, 'jeopardy/game_state'), {
                wrong_answers: wrongList
            });
        }
    }

    // สั่งขึ้น Banner
    window.triggerManualResult(isCorrect);
};

// --- ฟังก์ชันแสดง Banner (ย้ายมาเป็นฟังก์ชันกลางเพื่อให้เรียกใช้ซ้ำได้) ---
window.showResultBanner = function (isCorrect) {

    if (!state || !state.game_state || !state.game_state.active_question_id) {
        console.warn("Banner trigger ignored: Game state or active_question_id is missing.");
        return;
    }
    
    const q = state.questions[state.game_state.active_question_id];
    if (!q) return;

    const overlay = document.getElementById('result-check-overlay');
    const card = document.getElementById('result-card');
    const icon = document.getElementById('result-icon');
    const title = document.getElementById('result-title');
    const subtitle = document.getElementById('result-subtitle');

    if (!overlay) return;

    overlay.classList.remove('hidden');

    if (isCorrect) {
        card.className = "w-[80vw] max-w-4xl p-16 rounded-[4rem] text-center shadow-2xl bg-emerald-500 border-8 border-white animate-pop";
        icon.innerText = "✅";
        title.innerText = "CORRECT";
        subtitle.innerText = "คำตอบถูกต้อง!";
        if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ['#10b981', '#ffffff'] });
    } else {
        card.className = "w-[80vw] max-w-4xl p-16 rounded-[4rem] text-center shadow-2xl bg-red-600 border-8 border-white animate-pop";
        icon.innerText = "❌";
        title.innerText = "WRONG";
        subtitle.innerText = "ยังไม่ถูกนะ...";
    }

    // ปิด Banner และโชว์เฉลยละเอียด
    setTimeout(() => {
        overlay.classList.add('hidden');
    }, 2500);
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
                const randomDelay = gs.steal_random_delay || 1000; // ดึงค่าที่ Admin สุ่มไว้มาใช้

                // ไฟแดง 5 ดวงขึ้นทุกๆ 0.8 วินาที (คงที่ 4 วินาทีแรก)
                const activeCount = Math.floor(elapsed / 800);

                let lightsHTML = '<div class="flex gap-6 justify-center my-10">';
                for (let i = 1; i <= 5; i++) {
                    const isOn = activeCount >= i;
                    lightsHTML += `
            <div class="w-24 h-24 rounded-full border-8 border-slate-900 transition-all duration-150 
                ${isOn ? 'bg-red-600 shadow-[0_0_50px_rgba(220,38,38,0.8)]' : 'bg-slate-800 shadow-inner'}">
            </div>`;
                }
                lightsHTML += '</div>';

                // ตรวจสอบว่าถ้าไฟแดงครบ 5 ดวงแล้วแต่ยังไม่ถึงเวลาสุ่ม ให้ขึ้นข้อความ "HOLD..."
                const isHoldPhase = activeCount >= 5;

                stealAlert.innerHTML = `
        <div class="steal-prep-banner relative border-slate-900 bg-slate-950 shadow-[0_0_100px_rgba(0,0,0,0.5)]" style="max-width: 950px; width: 90vw;">
            ${closeBtn}
            <p class="text-2xl font-black text-slate-500 uppercase tracking-[0.4em] mb-2">Prepare to Steal</p>
            ${lightsHTML}
            <p class="text-3xl font-black text-white italic animate-pulse">
                ${isHoldPhase ? 'READY... HOLD!' : 'WAIT FOR SEQUENCE...'}
            </p>
        </div>`;

                if (!window.countdownInterval) {
                    window.countdownInterval = setInterval(() => { updateBoardGameState(); }, 50);
                }
            }

            // -- [B] ช่วงไฟเขียว / มีคนกดแล้ว (Steal Open) --
                // -- [B] ช่วงไฟเขียว / มีคนกดแล้ว (Steal Open) --
                else if (gs.is_steal_open) {
                    if (window.countdownInterval && !state.buzzers?.winner) {
                        // ถ้ายังไม่มีคนกด ให้เคลียร์ interval เก่าเพื่อประหยัดทรัพยากร
                    }

                    const attempts = buzz?.attempts || {};
                    const winnerId = buzz?.winner;
                    const startTime = gs.steal_start_ts + 4000; // จุดที่ไฟเขียวควรจะติด

                    // ดึงทุกบ้านที่กดเข้ามา แล้วเรียงลำดับเวลา (น้อยไปมาก)
                    const sortedAttempts = Object.entries(attempts).sort((a, b) => a[1] - b[1]);

                    // สร้าง HTML สำหรับทุกบ้านที่กด (ใช้ flex-wrap เพื่อให้แสดงได้หลายแถวถ้าคนเยอะ)
                    const attemptsHTML = sortedAttempts.map(([hId, ts]) => {
                        const diff = (ts - startTime) / 1000;
                        const isWinner = winnerId == hId;
                        return `
            <div class="flex items-center gap-2 px-6 py-3 rounded-2xl ${isWinner ? 'bg-emerald-600 text-white shadow-lg scale-110' : 'bg-white border-2 border-emerald-100 text-emerald-700'} transition-all duration-300">
                <span class="font-black text-xl">H${hId}:</span>
                <span class="font-mono text-lg font-bold">${diff > 0 ? '+' + diff.toFixed(3) : diff.toFixed(3)}s</span>
            </div>`;
                    }).join('');

                    // คำนวณเวลานับถอยหลัง 5 วินาทีหลังจากคนแรกกด
                    let countdownHTML = '';
                    if (winnerId && buzz.timestamp) {
                        const remaining = Math.max(0, (5000 - (Date.now() - buzz.timestamp)) / 1000);
                        if (remaining > 0) {
                            countdownHTML = `<p class="text-emerald-600 font-black text-xl animate-pulse">🔒 ระบบกำลังบันทึกอันดับ... ปิดใน: ${remaining.toFixed(1)}s</p>`;
                            // บังคับให้หน้าจอ Refresh เพื่อให้เลขนับถอยหลังขยับ
                            if (!window.countdownInterval) window.countdownInterval = setInterval(() => updateBoardGameState(), 100);
                        } else {
                            countdownHTML = `<p class="text-red-600 font-black text-xl uppercase">🚫 หมดเวลาการบันทึก (LOCKED)</p>`;
                            if (window.countdownInterval) { clearInterval(window.countdownInterval); window.countdownInterval = null; }
                        }
                    } else {
                        countdownHTML = `<p class="text-2xl font-black text-emerald-500 uppercase tracking-[0.5em] animate-bounce">● RELEASED ●</p>`;
                    }

                stealAlert.innerHTML = `
        <div class="steal-prep-banner steal-active-banner relative" style="border-color: #10b981; background: #f0fdf4; max-width: 1000px; width: 95vw; padding: 4rem 2rem;">
            ${closeBtn}
            <div class="mb-6">
                ${winnerId ? `<h2 class="text-8xl font-black text-slate-900 mb-2 italic">บ้าน ${winnerId} ไวที่สุด!</h2>` : `<h2 class="text-8xl font-black text-slate-800 mb-2 italic animate-pulse">กดปุ่มเลย!!!</h2>`}
                ${countdownHTML}
            </div>
            
            <div class="border-t border-emerald-200 pt-8 mt-4">
                <p class="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Reaction Times (Ranked)</p>
                <div class="flex flex-wrap justify-center gap-4 max-h-[300px] overflow-y-auto p-2">
                    ${attemptsHTML || '<p class="text-slate-300 italic">Waiting for first press...</p>'}
                </div>
            </div>

            <!-- เพิ่มปุ่มนี้เข้าไปด้านล่างสุดของ Modal -->
            ${!winnerId ? `
                <div class="mt-8 pt-4 border-t border-emerald-100">
                    <button onclick="window.closeStealBanner()" 
                        class="px-6 py-2 bg-white/50 text-slate-400 hover:text-red-500 hover:bg-white rounded-xl text-xs font-bold transition-all border border-slate-200 shadow-sm">
                        ✕ ไม่มีบ้านไหนขโมย (ปิดหน้าต่างนี้)
                    </button>
                </div>
            ` : ''}
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
            const choices = q.options.split(/\r?\n|\\n/).filter(line => line.trim() !== "");
            const labels = ['A', 'B', 'C', 'D'];
            const wrongAnswers = gs.wrong_answers || []; 

            optionsContainer.innerHTML = choices.slice(0, 4).map((choice, index) => {
                let cleanChoice = choice.trim().replace(/^[A-D][.:]\s*/i, "");
                const isSelected = gs.selected_answer === index;
                const isWrong = wrongAnswers.includes(index);
                
                return `
            <div onclick="${isWrong ? '' : `window.selectJeopardyAnswer(${index})`}" 
        class="kahoot-option opt-${index} ${isSelected ? 'is-selected' : ''} ${isWrong ? 'is-disabled' : 'cursor-pointer'}">
        <span class="kahoot-letter">${labels[index]}</span>
        <span class="kahoot-text">${cleanChoice} ${isWrong ? ' (✖)' : ''}</span>
    </div>`;
            }).join('');

            optionsContainer.className = "kahoot-grid revealed";
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