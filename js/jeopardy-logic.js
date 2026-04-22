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
async function initializeGameStructure() {
    const initialData = {
        config: {
            is_active: true,
            current_round: 1,
            max_turns_per_house: 2,
            picking_house_order: [1, 2, 3, 4, 5, 6, 7, 8]
        },
        game_state: {
            status: 'BOARD',
            active_question_id: null,
            active_house: 1,
            current_turn_index: 0,
            answering_house: null,
            is_steal_open: false,
            options_revealed: false
        },
        buzzers: { is_locked: false, winner: null },
        houses: {}
    };
    for (let i = 1; i <= 8; i++) {
        initialData.houses[i] = { jeopardy_score: 0, turns_played: 0, active_session_id: null };
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

    document.getElementById('aq-category').innerText = q.category;
    document.getElementById('aq-level').innerText = q.level;
    document.getElementById('aq-points').innerText = q.points;
    document.getElementById('aq-text').innerText = q.question_text;
    document.getElementById('aq-options').innerText = q.options || "ไม่มีตัวเลือก (ข้อเขียน)";
    document.getElementById('aq-answer').innerText = q.answer_text;

    const ctrlOwner = document.getElementById('ctrl-owner');
    const ctrlStealOpen = document.getElementById('ctrl-steal-open');
    const ctrlStealJudge = document.getElementById('ctrl-steal-judge');

    const turnHouse = state.config.picking_house_order[gs.current_turn_index];
    document.getElementById('ctrl-owner-house').innerText = turnHouse;

    if (gs.status === 'QUESTION') {
        ctrlOwner.classList.remove('hidden');
        ctrlStealOpen.classList.add('hidden');
        ctrlStealJudge.classList.add('hidden');
    }
    else if (gs.status === 'STEAL_WAIT') {
        ctrlOwner.classList.add('hidden');
        if (state.buzzers?.winner) {
            ctrlStealOpen.classList.add('hidden');
            ctrlStealJudge.classList.remove('hidden');
            document.getElementById('steal-winner-badge').innerText = `บ้าน ${state.buzzers.winner}`;
        } else {
            ctrlStealOpen.classList.remove('hidden');
            ctrlStealJudge.classList.add('hidden');
            const btnSteal = ctrlStealOpen.querySelector('button');
            if (gs.is_steal_open) {
                btnSteal.innerText = "กำลังจับเวลา STEAL... (รอน้องกด)";
                btnSteal.className = "w-full bg-slate-300 text-slate-600 py-4 rounded-xl font-black text-lg shadow-inner cursor-not-allowed";
            } else {
                btnSteal.innerText = "🚨 กดเปิดระบบให้บ้านอื่น STEAL";
                btnSteal.className = "w-full bg-orange-500 hover:bg-orange-600 text-white py-4 rounded-xl font-black text-lg shadow-lg shadow-orange-200 animate-pulse transition-all";
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
        const isOnline = !!h.active_session_id;
        const usedAllTurns = h.turns_played >= (state.config?.max_turns_per_house || 2);

        return `
        <div class="relative group">
            <!-- ส่วน Card บ้าน (กดได้เพื่อเลือกเป็น Active House) -->
            <div onclick="setActiveHouse('${hId}')" 
                class="cursor-pointer flex items-center justify-between p-3 rounded-xl border-2 transition-all 
                ${isActive ? 'bg-blue-600 border-blue-400 active-house-glow shadow-lg' : 'bg-slate-700/40 border-transparent hover:border-slate-500'} 
                ${usedAllTurns && !isActive ? 'opacity-50' : ''}">
                
                <div class="flex items-center gap-3">
                    <!-- วงกลมเลขบ้าน -->
                    <div class="w-10 h-10 rounded-full flex items-center justify-center font-black text-lg shadow-inner
                        ${isActive ? 'bg-white text-blue-600' : 'bg-slate-800 text-slate-400'}">
                        ${hId}
                    </div>
                    
                    <div>
                        <p class="text-sm font-black ${isActive ? 'text-white' : 'text-slate-200'}">
                            Pts: ${h.jeopardy_score} 
                            ${isActive ? '<span class="ml-2 text-[10px] bg-blue-400 px-2 py-0.5 rounded-full text-white animate-pulse">กำลังเล่น</span>' : ''}
                        </p>
                        <div class="flex items-center gap-2 mt-0.5">
                            <span class="text-[10px] font-bold ${isActive ? 'text-blue-100' : 'text-slate-400'} uppercase">
                                เล่นไปแล้ว: ${h.turns_played}/2
                            </span>
                            <span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}"></span>
                        </div>
                    </div>
                </div>

                <!-- ปุ่ม Action อื่นๆ (Kick) -->
                <button onclick="event.stopPropagation(); kickHouse('${hId}')" 
                    class="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-400/10 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                </button>
            </div>
            
            <!-- ตัวบอกใบ้ถ้าเล่นครบแล้ว -->
            ${usedAllTurns ? `<div class="absolute -top-1 -right-1 text-xs">⚠️</div>` : ''}
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

    container.innerHTML = qs.map(q => {
        const isPlayed = q.is_opened;
        const colorMap = { easy: 'bg-emerald-50 text-emerald-600 border-emerald-200', medium: 'bg-orange-50 text-orange-600 border-orange-200', hard: 'bg-rose-50 text-rose-600 border-rose-200' };
        const cClass = colorMap[q.level] || 'bg-slate-50 border-slate-200 text-slate-600';

        return `
        <button onclick="selectQuestion('${q.id}')" ${isPlayed ? 'disabled' : ''} 
            class="p-3 rounded-xl border-2 text-center transition-all ${isPlayed ? 'bg-slate-100 border-slate-200 text-slate-300 opacity-60 cursor-not-allowed' : `${cClass} hover:shadow-md hover:scale-105 active:scale-95`}">
            <p class="text-[9px] font-black uppercase tracking-widest opacity-70 truncate">${q.category}</p>
            <p class="text-xl font-black mt-1">${q.points}</p>
        </button>`;
    }).join('');
}

function renderQuestionsTable() {
    const tbody = document.getElementById('questions-table-body');
    if (!state.questions || !tbody) return;

    // กรองข้อมูลก่อนนำมาแสดง
    const qs = Object.values(state.questions).filter(q => q && q.id);

    // เรียงลำดับตาม Category (กันพัง)
    qs.sort((a, b) => {
        const catA = a.category || "";
        const catB = b.category || "";
        return catA.localeCompare(catB);
    });

    tbody.innerHTML = qs.map(q => `
        <tr class="hover:bg-slate-50 transition-colors border-b">
            <td class="p-3 text-[10px] font-mono text-slate-400">${q.id.substring(0, 8)}...</td>
            <td class="p-3">
                <span class="font-bold text-slate-700">${q.category || 'N/A'}</span><br>
                <span class="text-[9px] text-slate-400 uppercase">${q.level || 'N/A'}</span>
            </td>
            <td class="p-3 font-black text-indigo-600">${q.points || 0}</td>
            <td class="p-3 text-xs text-slate-600 truncate max-w-[200px]">${q.question_text || '-'}</td>
            <td class="p-3 text-center">
                ${q.is_opened ? '<span class="bg-red-100 text-red-600 text-[9px] px-2 py-1 rounded font-bold">เล่นแล้ว</span>' : '<span class="bg-green-100 text-green-600 text-[9px] px-2 py-1 rounded font-bold">พร้อมเล่น</span>'}
            </td>
            <td class="p-3 text-right">
                <button onclick="deleteQuestion('${q.id}')" class="text-red-400 hover:text-red-600 p-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
            </td>
        </tr>
    `).join('');
}

function renderBoard() {
    // ป้องกันการรันในหน้าอื่นที่ไม่ใช่ Board
    if (!window.isBoardPage || !state.questions) return;

    const boardContainer = document.getElementById('board-container');
    if (!boardContainer) return;

    // 1. ดึงข้อมูลคำถามออกมาเป็น Array และกรองค่าว่าง
    const allQuestions = Object.values(state.questions).filter(q => q && q.id);

    // 2. เรียงลำดับคำถามตามคะแนน (Points) จากน้อยไปมาก
    allQuestions.sort((a, b) => a.points - b.points);

    // 3. กำหนดสีตามระดับความยาก (Theme สว่าง)
    const difficultyStyles = {
        easy: {
            border: 'border-emerald-100',
            bg: 'bg-emerald-50/50',
            text: 'text-emerald-600',
            hover: 'hover:border-emerald-400 hover:bg-emerald-50'
        },
        medium: {
            border: 'border-amber-100',
            bg: 'bg-amber-50/50',
            text: 'text-amber-600',
            hover: 'hover:border-amber-400 hover:bg-amber-50'
        },
        hard: {
            border: 'border-rose-100',
            bg: 'bg-rose-50/50',
            text: 'text-rose-600',
            hover: 'hover:border-rose-400 hover:bg-rose-50'
        }
    };

    // 4. วาดการ์ดลงใน Grid (ใช้ col-span-5 ตาม HTML เดิม หรือปรับใน HTML เป็น grid-cols-6 เพื่อให้ดูเต็ม)

    boardContainer.innerHTML = allQuestions.map(q => {
        const style = difficultyStyles[q.level] || difficultyStyles.easy;
        const isOpened = q.is_opened;

        return `
        <button onclick="confirmOpenQuestion('${q.id}')" 
            ${isOpened ? 'disabled' : ''}
            class="jeopardy-card h-32 border-2 rounded-[2rem] flex flex-col items-center justify-center gap-1 shadow-sm transition-all
            ${isOpened ? 'played' : `${style.bg} ${style.border} ${style.hover}`} ">
            
            <span class="text-[10px] font-black uppercase tracking-widest opacity-40">${q.category}</span>
            <span class="text-4xl font-black ${style.text}">${q.points}</span>
            <div class="flex gap-1 mt-1">
                ${renderDifficultyDots(q.level)}
            </div>
        </button>`;
    }).join('');

    // อัปเดต Scoreboard และสถานะ Overlay
    renderBoardScoreboard();
    updateBoardGameState();
}

function renderDifficultyDots(level) {
    let count = level === 'hard' ? 3 : (level === 'medium' ? 2 : 1);
    let dots = '';
    const dotColors = { easy: 'bg-emerald-400', medium: 'bg-amber-400', hard: 'bg-rose-400' };

    for (let i = 0; i < count; i++) {
        dots += `<span class="w-1.5 h-1.5 rounded-full ${dotColors[level]}"></span>`;
    }
    return dots;
}

function renderBoardScoreboard() {
    const container = document.getElementById('scoreboard');
    if (!container || !state.houses) return;

    container.innerHTML = Object.keys(state.houses).map(hId => {
        const h = state.houses[hId];
        const isActive = parseInt(hId) === state.game_state.active_house;
        const isBuzzerWinner = state.buzzers?.winner == hId;

        // เพิ่มการตรวจสอบ cursor และการตอบสนองเมื่อ hover
        return `
        <div onclick="window.setActiveHouse('${hId}')" 
            class="p-4 bg-white rounded-3xl border-2 transition-all cursor-pointer hover:shadow-md active:scale-95
            ${isActive ? 'border-blue-500 bg-blue-50 shadow-md scale-[1.02]' : 'border-slate-100 opacity-80 hover:opacity-100'} 
            ${isBuzzerWinner ? 'ring-4 ring-orange-500' : ''}">
            <div class="flex justify-between items-center">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-2xl flex items-center justify-center font-black text-lg 
                        ${isActive ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400'}">
                        ${hId}
                    </div>
                    <div>
                        <p class="text-[10px] font-bold text-slate-400 uppercase leading-none mb-1">House ${hId}</p>
                        <p class="text-2xl font-black text-slate-800 leading-none">${h.jeopardy_score}</p>
                    </div>
                </div>
                <div class="text-right">
                    <span class="text-[9px] font-black text-slate-300 uppercase italic">Turns: ${h.turns_played}/2</span>
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

window.selectQuestion = async function (qId) {
    if (state.game_state.status !== 'BOARD') return Swal.fire("แจ้งเตือน", "มีคำถามกำลังเล่นอยู่", "warning");

    await saveUndoState();
    await update(ref(db, `jeopardy/questions/${qId}`), { is_opened: true });

    const timerMap = { easy: 90000, medium: 120000, hard: 150000 };
    const q = state.questions[qId];

    await update(ref(db, 'jeopardy/game_state'), {
        status: 'QUESTION',
        active_question_id: qId,
        options_revealed: false,
        is_steal_open: false,
        timer_duration: timerMap[q.level],
        timer_remaining: timerMap[q.level],
        is_timer_running: true,
        timer_start_ts: Date.now()
    });

    await set(ref(db, 'jeopardy/buzzers'), { is_locked: false, winner: null, attempts: {} });
}

window.revealOptions = async function () {
    await update(ref(db, 'jeopardy/game_state/options_revealed'), true);
    showToast("แสดงตัวเลือกบนจอแล้ว", "info");
}

async function processNextTurn(houseToCredit = null, pointsEarned = 0, penaltyPoints = 0) {
    const updates = {};
    const gs = state.game_state;
    const currentActiveHouse = gs.active_house;

    // 1. ให้คะแนน (ถ้ามี)
    if (houseToCredit) {
        const currentScore = state.houses[houseToCredit].jeopardy_score || 0;
        updates[`jeopardy/houses/${houseToCredit}/jeopardy_score`] = currentScore + pointsEarned - penaltyPoints;
    }

    // 2. นับเทิร์นให้บ้านที่เป็นคนเลือกแผ่นป้าย
    const currentTurns = state.houses[currentActiveHouse].turns_played || 0;
    updates[`jeopardy/houses/${currentActiveHouse}/turns_played`] = currentTurns + 1;

    // 3. คำนวณคิวถัดไปอัตโนมัติ (ตามกติกา 1-8)
    let nextTurnIndex = gs.current_turn_index + 1;
    let nextRound = state.config.current_round;

    if (nextTurnIndex >= state.config.picking_house_order.length) {
        nextTurnIndex = 0;
        nextRound++;
    }

    updates[`jeopardy/config/current_round`] = nextRound;
    updates[`jeopardy/game_state/current_turn_index`] = nextTurnIndex;
    // ตั้งค่า Active House สำหรับข้อถัดไปตามคิวปกติ
    updates[`jeopardy/game_state/active_house`] = state.config.picking_house_order[nextTurnIndex];

    // 4. รีเซ็ตหน้าจอเข้าสู่บอร์ด
    updates[`jeopardy/game_state/status`] = 'BOARD';
    updates[`jeopardy/game_state/active_question_id`] = null;
    updates[`jeopardy/game_state/is_timer_running`] = false;

    await update(ref(db), updates);
}

window.judgeOwner = async function (isCorrect) {
    await saveUndoState();
    const turnHouse = state.config.picking_house_order[state.game_state.current_turn_index];
    const q = state.questions[state.game_state.active_question_id];

    if (isCorrect) {
        await processNextTurn(turnHouse, q.points, 0);
        showToast(`บ้าน ${turnHouse} ตอบถูก! ได้ ${q.points} คะแนน`);
    } else {
        await update(ref(db, 'jeopardy/game_state'), {
            status: 'STEAL_WAIT',
            is_timer_running: false
        });
    }
}

window.openStealBuzzer = async function () {
    await update(ref(db, 'jeopardy/game_state'), { is_steal_open: true });
    showToast("เปิดระบบปุ่มกด Steal แล้ว!", "warning");
}

window.judgeSteal = async function (isCorrect) {
    await saveUndoState();
    const winnerHouse = state.buzzers.winner;
    const q = state.questions[state.game_state.active_question_id];

    if (!winnerHouse) return;

    if (isCorrect) {
        await processNextTurn(winnerHouse, q.points, 0);
        showToast(`บ้าน ${winnerHouse} Steal ถูก! ได้ ${q.points} คะแนน`);
    } else {
        const penalty = Math.ceil(q.points / 2);
        await processNextTurn(winnerHouse, 0, penalty);
        showToast(`บ้าน ${winnerHouse} Steal ผิด! โดนหัก ${penalty} คะแนน`, "error");
    }
}

window.skipHouseTurn = async function () {
    const res = await Swal.fire({ title: 'ข้ามคิวบ้านนี้?', text: 'จะทำการข้ามสิทธิ์การเลือกของบ้านนี้ (นับเป็น 1 Turn ที่เสียไป)', icon: 'warning', showCancelButton: true });
    if (res.isConfirmed) {
        await saveUndoState();
        await processNextTurn(null, 0, 0);
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

window.selectQuestion = async function (qId) {
    if (state.game_state.status !== 'BOARD') return;

    // เก็บประวัติสำหรับ Undo (ต้องทำเหมือนหน้า Admin)
    await set(ref(db, 'jeopardy/history/last_state'), {
        houses: state.houses,
        game_state: state.game_state,
        config: state.config,
        buzzers: state.buzzers
    });

    const q = state.questions[qId];
    const timerMap = { easy: 90000, medium: 120000, hard: 150000 };

    await update(ref(db, `jeopardy/questions/${qId}`), { is_opened: true });

    await update(ref(db, 'jeopardy/game_state'), {
        status: 'QUESTION',
        active_question_id: qId,
        options_revealed: false,
        is_steal_open: false,
        timer_duration: timerMap[q.level],
        timer_remaining: timerMap[q.level],
        is_timer_running: true,
        timer_start_ts: Date.now()
    });

    // ล้างสถานะ Buzzer
    await set(ref(db, 'jeopardy/buzzers'), { is_locked: false, winner: null, attempts: {} });
    window.showToast("เปิดคำถามแล้ว");
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

window.saveQuestion = async function () {
    // 1. ดึงค่าจาก Form
    const category = document.getElementById('q-category').value;
    const level = document.getElementById('q-level').value;
    const points = parseInt(document.getElementById('q-points').value);
    const questionText = document.getElementById('q-text').value.trim();
    const options = document.getElementById('q-options').value.trim();
    const answerText = document.getElementById('q-answer').value.trim();
    const mediaUrl = document.getElementById('q-media').value.trim();
    const explainUrl = document.getElementById('q-explain-url').value.trim();

    // 2. Validation เบื้องต้น
    if (!questionText || !answerText || isNaN(points)) {
        return Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกโจทย์ เฉลย และคะแนนให้ถูกต้อง', 'warning');
    }

    Swal.fire({ title: 'กำลังบันทึก...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    try {
        // 3. สร้าง Reference และดึง Unique ID จาก Firebase ล่วงหน้า
        const questionsRef = ref(db, 'jeopardy/questions');
        const newQuestionRef = push(questionsRef);
        const qId = newQuestionRef.key;

        // 4. เตรียม Object ข้อมูล (กำหนดค่า Default ป้องกัน undefined)
        const qData = {
            id: qId,
            category: category || "General",
            level: level || "easy",
            points: points || 0,
            question_text: questionText,
            options: options || "", // ถ้าไม่มีให้เป็นสายอักขระว่าง
            answer_text: answerText,
            media_url: mediaUrl || "",
            explain_url: explainUrl || "",
            is_opened: false,
            timestamp: Date.now()
        };

        // 5. บันทึกลง Firebase (ใช้ set เพื่อระบุตำแหน่งที่แน่นอนด้วย ID)
        await set(newQuestionRef, qData);

        // 6. แจ้งเตือนและล้าง Form
        Swal.fire({
            icon: 'success',
            title: 'เพิ่มคำถามสำเร็จ',
            text: `หมวด ${category} (${points} Pts) ถูกเพิ่มแล้ว`,
            timer: 1500,
            showConfirmButton: false
        });

        document.getElementById('form-question').reset();

    } catch (e) {
        console.error("Save Question Error:", e);
        Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้: ' + e.message, 'error');
    }
}

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


/// ---------------------------------------------------------
// 9. Board
// ---------------------------------------------------------

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

function updateBoardGameState() {
    const gs = state.game_state;
    const overlay = document.getElementById('question-overlay');

    // ถ้าไม่ใช่หน้า Board หรือไม่มี Overlay ให้หยุดทำงาน
    if (!overlay) return;

    if (gs.status === 'BOARD') {
        overlay.classList.add('hidden');
        stopBoardTimer();
        safeSetText('display-active-house', gs.active_house);
        return;
    }

    overlay.classList.remove('hidden');
    const q = state.questions?.[gs.active_question_id];
    if (!q) return;

    safeSetText('overlay-category', q.category);
    safeSetText('overlay-points', `${q.points} PTS`);
    safeSetText('overlay-text', q.question_text);
    safeSetText('display-active-house', gs.active_house);

    // ใครกำลังตอบ?
    const currentAnswering = (gs.status === 'STEAL_WAIT' && state.buzzers?.winner) ? state.buzzers.winner : gs.active_house;
    safeSetText('display-answering-house', currentAnswering);

    const badge = document.getElementById('answering-house-badge');
    if (badge) badge.innerText = currentAnswering;

    // สถานะ Steal
    const stealInd = document.getElementById('steal-indicator');
    if (stealInd) {
        const isStealVisible = gs.is_steal_open && !state.buzzers?.winner;
        stealInd.classList.toggle('hidden', !isStealVisible);
    }

    // จัดการเวลา
    if (gs.is_timer_running) {
        startBoardTimer(gs.timer_duration, gs.timer_start_ts);
    } else {
        stopBoardTimer();
    }
}

function startBoardTimer(duration, startTs) {
    if (boardTimerInterval) clearInterval(boardTimerInterval);
    const display = document.getElementById('overlay-timer');

    boardTimerInterval = setInterval(() => {
        const elapsed = Date.now() - startTs;
        const remaining = Math.max(0, duration - elapsed);
        const sec = Math.floor(remaining / 1000);
        const ms = Math.floor((remaining % 1000) / 10);

        if (display) {
            display.innerText = `${String(sec).padStart(2, '0')}:${String(ms).padStart(2, '0')}`;
            display.className = sec < 10 ? "text-8xl font-black tabular-nums text-red-600 animate-pulse" : "text-8xl font-black tabular-nums text-slate-800";
        }

        if (remaining <= 0) clearInterval(boardTimerInterval);
    }, 50);
}

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