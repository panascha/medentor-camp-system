import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, onValue, push, remove, update, get, onDisconnect } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Local State
let currentRoom = null;
let currentSubject = null;
let quotaUsed = 0;
let allStudentsInClass = []; // เด็กทั้งหมดตามฐานข้อมูล
let onlineStudents = {};     // เด็กที่ต่อเน็ตอยู่ปัจจุบัน
let responsesHistory = {};   // เก็บแบบ { studentID: [ {activity: "...", answer: "...", time: "..."}, ... ] }
let scoresToSync = { studentScores: {}, houseScores: {} };
let activityLog = {}; // เก็บ { activity_id: { title: "...", status: "..." } }
let selectedActivityFilter = 'current'; // 'current' หรือ activity_id เจาะจง

// ---------------------------------------------------------
// Persistence Logic: รีเฟรชแล้วไม่หลุด
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    const savedRoom = localStorage.getItem('active_tutor_room');
    if (savedRoom && window.location.pathname.includes('tutor.html')) {
        const snapshot = await get(ref(db, `active_sessions/${savedRoom}`));
        const session = snapshot.val();

        if (session && session.isOpen) {
            currentRoom = savedRoom;
            currentSubject = session.subject;
            showUI(true);
            await loadClassMetadata(); // โหลดรายชื่อเด็กทั้งหมด
            initTutorListeners();      // เริ่มฟังข้อมูล Real-time
        } else {
            localStorage.removeItem('active_tutor_room');
        }
    }

    if (window.location.pathname.includes('student.html')) {
        startRoomWatcher();
    }
});

// ---------------------------------------------------------
// [SECTION: TUTOR LOGIC] - สำหรับหน้า tutor.html
// ---------------------------------------------------------

window.startSession = async function () {
    const user = checkAuth();
    currentRoom = document.getElementById('select-room').value;
    currentSubject = document.getElementById('select-subject').value;

    const sessionData = {
        isOpen: true, subject: currentSubject,
        tutorID: user.studentID || user.id, tutorName: user.nickname || user.fullName,
        startedAt: new Date().toISOString(),
        current_activity: { activity_id: "init", question_title: "ยินดีต้อนรับ", status: "closed" },
        sos_count: 0,
        last_reaction: { type: "", ts: 0 }
    };

    try {
        await set(ref(db, `active_sessions/${currentRoom}`), sessionData);
        await remove(ref(db, `responses/${currentRoom}`));
        await remove(ref(db, `classroom_scores/${currentRoom}`));
        await remove(ref(db, `private_questions/${currentRoom}`));
        await remove(ref(db, `active_sessions/${currentRoom}/sos_students`));

        localStorage.setItem('active_tutor_room', currentRoom);
        showUI(true);
        await loadClassMetadata();
        initTutorListeners();
        showToast(`เปิดห้องเรียน ${currentRoom} สำเร็จ`);
    } catch (e) { Swal.fire("Error", "เปิดห้องไม่ได้", "error"); }
};

// loadClassMetadata and initTutorListeners เป็นฟังก์ชันหลักที่ใช้ดึงข้อมูลนักเรียนและตั้งค่าการฟังข้อมูลแบบเรียลไทม์จาก Firebase เพื่อให้หน้าจอของ Tutor อัปเดตอยู่เสมอเมื่อมีการเปลี่ยนแปลงข้อมูล เช่น นักเรียนออนไลน์/ออฟไลน์, คำตอบใหม่, หรือกิจกรรมใหม่ที่ถูกตั้งขึ้น
async function loadClassMetadata() {
    const roomLetter = currentRoom.replace('Room_', ''); // ตัดให้เหลือ 'A', 'B'...
    const snapshot = await get(ref(db, `students`));
    const data = snapshot.val() || {};

    // กรองเอาเฉพาะเด็กที่มี ClassID ตรงกับห้องที่สอน
    allStudentsInClass = Object.keys(data)
        .filter(id => data[id].classID === roomLetter)
        .map(id => ({ id: id, ...data[id] }))
        .sort((a, b) => a.house - b.house || a.id - b.id); // เรียงตามบ้าน
    
    renderPresenceList();
}
function initTutorListeners() {
    if (!currentRoom) return;

    // 1. Listen Presence: ตรวจสอบว่าใครออนไลน์อยู่บ้าง
    onValue(ref(db, `presence/${currentRoom}`), (snapshot) => {
        onlineStudents = snapshot.val() || {};
        renderPresenceList(); // อัปเดตรายชื่อฝั่งซ้าย (จุดเขียว/เทา)
        renderSummaryTable();  // อัปเดตสถานะในตารางสรุป
    });

    // 2. Listen Activities History: ดึงประวัติคำถามทั้งหมดที่เคยตั้ง
    onValue(ref(db, `active_sessions/${currentRoom}/activities_history`), (snapshot) => {
        activityLog = snapshot.val() || {};
        renderActivityFilter(); // วาด Dropdown สำหรับเลือกดูประวัติใน Live Feed

        // ถ้าเป็นการโหลดครั้งแรก ให้ตั้ง Filter ไปที่คำถามล่าสุด
        if (selectedActivityFilter === 'current' && Object.keys(activityLog).length > 0) {
            const keys = Object.keys(activityLog);
            selectedActivityFilter = keys[keys.length - 1];
        }
    });

    // 3. Listen Responses: ดึงคำตอบทั้งหมด (ทุกคำถาม) มาประมวลผล
    onValue(ref(db, `responses/${currentRoom}`), (snapshot) => {
        const data = snapshot.val() || {};

        // เคลียร์ประวัติในเครื่องแล้วคำนวณใหม่จาก Data ล่าสุดของ Firebase
        responsesHistory = {};

        Object.values(data).forEach(res => {
            if (!responsesHistory[res.studentID]) {
                responsesHistory[res.studentID] = [];
            }

            // ป้องกันข้อมูลซ้ำ (ตรวจสอบจาก Timestamp)
            const exists = responsesHistory[res.studentID].some(h => h.time === res.timestamp);
            if (!exists) {
                responsesHistory[res.studentID].push({
                    activityID: res.activityID, // ผูกไว้ว่าคือคำตอบของคำถามไหน
                    answer: res.answer,
                    time: res.timestamp,
                    wantsToTalk: res.wantsToTalk
                });
            }
        });

        renderResponses(data); // วาด Live Feed (แสดงเฉพาะคำถามที่เลือกใน Filter)
        renderSummaryTable(); // วาดตารางสรุป (นับจำนวนครั้งที่ตอบทั้งหมด)
    });

    // 4. Listen Quota: ติดตามการใช้คะแนนในคาบ (ห้ามเกิน 100)
    onValue(ref(db, `classroom_scores/${currentRoom}/quotaUsed`), (snapshot) => {
        quotaUsed = snapshot.val() || 0;
        updateQuotaUI(); // อัปเดตแถบสี Progress Bar ด้านบน
    });

    // 5. Listen SOS Count: มีน้องกดปุ่มตามไม่ทันกี่คน (ถ้า >0 ให้แสดงไอคอนเตือน)
    onValue(ref(db, `active_sessions/${currentRoom}/sos_students`), (snapshot) => {
        const sosData = snapshot.val() || {};
        // นับจำนวนเด็กที่อยู่ในลิสต์ (จำนวน Key)
        const count = Object.keys(sosData).length;

        const sosEl = document.getElementById('sos-monitor');
        if (sosEl) {
            if (count > 0) {
                sosEl.innerText = `🆘 ${count} คนกำลังตามไม่ทัน!`;
                sosEl.classList.remove('hidden');
            } else {
                sosEl.classList.add('hidden');
            }
        }
    });

    // 6. Listen Last Reaction: มีน้องส่ง Reaction อะไรมาบ้าง (ถ้าไม่เกิน 2 วินาที ให้แสดง Emoji ลอยขึ้นมา)
    onValue(ref(db, `active_sessions/${currentRoom}/last_reaction`), (snapshot) => {
        const data = snapshot.val();
        if (data && data.type && (Date.now() - data.ts < 2000)) {
            // เรียกฟังก์ชันแสดง Emoji ลอย (ถ้ามี)
            if (typeof spawnFloatingEmoji === 'function') spawnFloatingEmoji(data.type);
            else showToast(`ได้ Reaction: ${data.type}`, 'info');
        }
    });

    // 7. Listen Private Questions: มีน้องส่งคำถามส่วนตัวมาหรือเปล่า (ถ้ามีให้แสดงในหน้าจอทันที)
    listenPrivateQuestions();

}

// ฟังก์ชัน showUI ใช้สำหรับสลับการแสดงผลระหว่างหน้าจอ Setup (ก่อนเริ่มคาบ) กับหน้าจอ Controls (หลังเริ่มคาบ) 
function showUI(isStarted) {
    const setupCard = document.getElementById('setup-card');
    const tutorControls = document.getElementById('tutor-controls');
    const btnFinish = document.getElementById('btn-finish');

    // ถ้าเริ่ม Session แล้ว (isStarted = true) ให้ซ่อน Setup และโชว์ Controls
    if (setupCard) setupCard.classList.toggle('hidden', isStarted);
    if (tutorControls) tutorControls.classList.toggle('hidden', !isStarted);
    if (btnFinish) btnFinish.classList.toggle('hidden', !isStarted);

    if (isStarted && currentRoom && currentSubject) {
        document.getElementById('display-session-info').innerText = `${currentRoom} | ${currentSubject}`;
    }
}
function updateQuotaUI() {
    const bar = document.getElementById('quota-bar');
    const text = document.getElementById('quota-text');
    if (!bar || !text) return;

    text.innerText = `${quotaUsed} / 100 PTS`;
    bar.style.width = `${quotaUsed}%`;
    bar.className = "quota-bar " + (quotaUsed > 80 ? 'quota-danger' : (quotaUsed > 50 ? 'quota-warning' : 'quota-safe'));
}
// renderActivityFilter เป็นฟังก์ชันที่วาด Dropdown ขึ้นมาในส่วนหัวของ Live Feed เพื่อให้ครูสามารถเลือกดูคำตอบย้อนหลังได้ตามกิจกรรมที่เคยตั้งไว้ โดยจะดึงข้อมูลจาก activityLog ที่เก็บประวัติคำถามทั้งหมดมาแสดงเป็นตัวเลือกใน Dropdown และเมื่อครูเลือกคำถามไหน ตัวแปร selectedActivityFilter จะถูกอัปเดต และ Live Feed จะกรองคำตอบมาแสดงเฉพาะคำถามนั้นๆ ทันที
function renderActivityFilter() {
    const feedHeader = document.getElementById('feed-filter-area');
    if (!feedHeader) return;

    const activities = Object.values(activityLog).reverse();
    if (activities.length === 0) return;

    feedHeader.innerHTML = `
        <select onchange="changeFeedFilter(this.value)" class="text-xs font-bold p-2 bg-slate-100 border-none rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
            <option value="current">📍 คำถามปัจจุบัน</option>
            ${activities.map(a => `<option value="${a.activity_id}" ${selectedActivityFilter === a.activity_id ? 'selected' : ''}>📜 ${a.question_title}</option>`).join('')}
        </select>
    `;
}
window.changeFeedFilter = function (val) {
    selectedActivityFilter = val;
    // สั่งดึงข้อมูลจาก Firebase มา Render ใหม่ (หรือใช้ State ที่มีอยู่)
    get(ref(db, `responses/${currentRoom}`)).then(snap => renderResponses(snap.val() || {}));
};

function renderPresenceList() {
    const listEl = document.getElementById('full-student-list');
    if (!listEl) return;

    listEl.innerHTML = allStudentsInClass.map(s => {
        const isOnline = onlineStudents[s.id];
        return `
            <div onclick="manualPick('${s.id}', '${s.nickname}')" class="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition-all border border-transparent hover:border-slate-200">
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}"></span>
                    <span class="text-xs font-bold ${isOnline ? 'text-slate-700' : 'text-slate-400'}">${s.nickname}</span>
                </div>
                <span class="text-[9px] font-black text-slate-300">HOUSE ${s.house}</span>
            </div>
        `;
    }).join('');
}
function renderSummaryTable() {
    const tbody = document.getElementById('summary-table-body');
    if (!tbody) return;

    let html = '';
    let lastHouse = null;

    allStudentsInClass.forEach((s) => {
        const history = responsesHistory[s.id] || [];
        const indivScore = scoresToSync.studentScores[s.id]?.score || 0;
        const houseScore = scoresToSync.houseScores[s.house] || 0;
        const isOnline = onlineStudents[s.id];
        const hasVolunteered = history.some(h => h.wantsToTalk);

        const isNewHouse = s.house !== lastHouse;
        lastHouse = s.house;

        html += `
            <tr class="${isOnline ? 'bg-white' : 'bg-slate-50 opacity-60'} hover:bg-slate-50 transition-colors">
                <td class="p-4 font-black text-blue-600 border-b">
                    ${isNewHouse ? `<div class="bg-blue-100 py-1 rounded-lg text-center">บ. ${s.house}</div>` : ''}
                </td>
                <td class="p-4 border-b">
                    <p class="font-bold text-slate-800">${s.nickname} ${hasVolunteered ? '🙋‍♂️' : ''}</p>
                    <p class="text-[10px] text-slate-400 font-mono">${s.id}</p>
                </td>
                <td class="p-4 text-center border-b">
                    <button onclick="viewHistory('${s.id}', '${s.nickname}')" class="text-xs font-bold underline text-blue-500">
                        ${history.length} ครั้ง
                    </button>
                </td>
                <td class="p-4 text-center font-black text-blue-600 border-b">${indivScore}</td>
                <td class="p-4 text-center font-black text-orange-600 border-b">${isNewHouse ? houseScore : '-'}</td>
                <td class="p-4 text-right space-x-1 border-b">
                    <!-- Individual Score Actions -->
                    <div class="inline-flex items-center bg-slate-100 rounded-lg p-1 mb-1">
                        <button onclick="giveScore('${s.id}', '${s.nickname}', -5)" class="px-2 text-red-500 font-bold">-</button>
                        <button onclick="giveScore('${s.id}', '${s.nickname}', 5)" class="px-2 border-x font-bold text-slate-700">STD +5</button>
                        <button onclick="customScore('${s.id}', '${s.nickname}', 'std')" class="px-2 text-blue-500 font-bold">✎</button>
                    </div>
                    <!-- House Score Actions (Only on first house member) -->
                    ${isNewHouse ? `
                    <div class="inline-flex items-center bg-orange-50 rounded-lg p-1">
                        <button onclick="giveHouseScore('${s.house}', -5)" class="px-2 text-red-500 font-bold">-</button>
                        <button onclick="giveHouseScore('${s.house}', 5)" class="px-2 border-x font-bold text-orange-700">HOUSE +5</button>
                        <button onclick="customScore('${s.house}', 'บ้าน ${s.house}', 'house')" class="px-2 text-orange-500 font-bold">✎</button>
                    </div>` : ''}
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}
function renderResponses(data) {
    const feed = document.getElementById('view-live');
    if (!feed) return;

    let entries = Object.entries(data);

    // กรองข้อมูลตามคำถามที่เลือก
    let targetActivityId = selectedActivityFilter;
    if (selectedActivityFilter === 'current') {
        // หา activity_id ล่าสุดจาก Log
        const keys = Object.keys(activityLog);
        targetActivityId = keys.length > 0 ? keys[keys.length - 1] : null;
    }

    // กรองเฉพาะคำตอบที่ตรงกับ activity_id นั้น (ต้องให้น้องส่ง activity_id มาด้วยในหน้า student.html)
    const filteredEntries = entries.filter(([key, res]) => res.activityID === targetActivityId).reverse();
    const currentQ = activityLog[targetActivityId];

    if (filteredEntries.length === 0) {
        feed.innerHTML = `
            <div class="col-span-full py-20 text-center">
                <p class="text-slate-400 font-bold italic">ยังไม่มีคำตอบในหัวข้อ: ${currentQ ? currentQ.question_title : '...'}</p>
            </div>`;
        return;
    }

    feed.innerHTML = `
        <div class="col-span-full mb-2 p-4 bg-blue-600 rounded-2xl text-white shadow-lg">
            <p class="text-[10px] font-black uppercase opacity-60">กำลังแสดงคำตอบของคำถาม:</p>
            <h3 class="text-lg font-black">${currentQ.question_title}</h3>
        </div>
        ${filteredEntries.map(([key, res]) => `
            <div class="bg-white p-5 rounded-2xl border-2 ${res.wantsToTalk ? 'border-yellow-400 bg-yellow-50' : 'border-slate-100'} shadow-sm animate-fade-in relative overflow-hidden">
                ${res.wantsToTalk ? '<div class="absolute top-0 right-0 bg-yellow-400 text-[9px] font-black px-2 py-1 rounded-bl-lg">VOLUNTEER</div>' : ''}
                <div class="flex items-center gap-3 mb-3">
                    <div class="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center font-black text-slate-400 text-xs">บ.${res.house}</div>
                    <div>
                        <h4 class="font-black text-slate-800 leading-none">${res.nickname}</h4>
                        <p class="text-[10px] text-slate-400 mt-1">${new Date(res.timestamp).toLocaleTimeString()}</p>
                    </div>
                </div>
                <p class="text-sm text-slate-600 leading-relaxed">${res.answer}</p>
            </div>
        `).join('')}
    `;
}

function listenPrivateQuestions() {
    if (!currentRoom) return;
    onValue(ref(db, `private_questions/${currentRoom}`), (snapshot) => {
        const data = snapshot.val() || {};
        const listEl = document.getElementById('private-questions-list');
        const badge = document.getElementById('q-badge');
        if (!listEl) return;

        const keys = Object.keys(data);
        if (badge) {
            badge.innerText = keys.length;
            badge.classList.toggle('hidden', keys.length === 0);
        }

        if (keys.length === 0) {
            listEl.innerHTML = `<p class="text-center py-20 text-slate-400 italic">ยังไม่มีคำถามส่วนตัวส่งเข้ามา</p>`;
            return;
        }

        listEl.innerHTML = keys.map(key => {
            const q = data[key];
            return `
                <div class="bg-white p-5 rounded-3xl border-2 border-orange-100 shadow-sm relative animate-fade-in">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <span class="text-[10px] font-black text-orange-500 uppercase tracking-widest">Private Question</span>
                            <h4 class="font-bold text-slate-800">${q.studentName}</h4>
                        </div>
                        <button onclick="deleteQuestion('${key}')" class="text-slate-300 hover:text-red-500 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                            </svg>
                        </button>
                    </div>
                    <p class="text-slate-600 text-sm bg-orange-50/50 p-3 rounded-2xl">${q.question}</p>
                </div>
            `;
        }).join('');
    });
}

// ฟังก์ชันให้พี่สตาฟกดลบคำถามเมื่อตอบแล้ว
window.deleteQuestion = function (key) {
    if (confirm('ตอบคำถามนี้เรียบร้อยแล้วใช่หรือไม่?')) {
        // ใช้ ref และ db ที่ import มาแล้วที่หัวไฟล์ได้เลย ไม่ต้องมี FB.
        remove(ref(db, `private_questions/${currentRoom}/${key}`))
            .then(() => showToast("ลบคำถามแล้ว"))
            .catch(e => console.error("Delete Question Error:", e));
    }
};

window.viewHistory = function (id, name) {
    const history = responsesHistory[id] || [];
    if (history.length === 0) return Swal.fire("ไม่มีประวัติ", "น้องคนนี้ยังไม่เคยส่งคำตอบในคาบนี้", "info");

    const listHtml = history.map((h, i) => `
        <div class="text-left p-3 mb-2 rounded-xl border-2 ${h.wantsToTalk ? 'border-yellow-400 bg-yellow-50' : 'border-slate-100'}">
            <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">คำตอบที่ ${i + 1}</p>
            <p class="text-sm text-slate-700 font-medium">${h.answer}</p>
        </div>
    `).join('');

    Swal.fire({
        title: `ประวัติการตอบ: ${name}`,
        html: `<div class="max-h-60 overflow-y-auto pr-2 custom-scrollbar">${listHtml}</div>`,
        confirmButtonText: 'ปิด'
    });
}
window.switchTab = function (tab) {
    document.getElementById('view-live').classList.toggle('hidden', tab !== 'live');
    document.getElementById('view-summary').classList.toggle('hidden', tab !== 'summary');

    const isLive = tab === 'live';
    document.getElementById('tab-live').className = isLive ? 'flex-1 py-4 text-sm font-black uppercase tracking-widest border-b-4 border-blue-600 text-blue-600' : 'flex-1 py-4 text-sm font-black uppercase tracking-widest border-b-4 border-transparent text-slate-400';
    document.getElementById('tab-summary').className = !isLive ? 'flex-1 py-4 text-sm font-black uppercase tracking-widest border-b-4 border-blue-600 text-blue-600' : 'flex-1 py-4 text-sm font-black uppercase tracking-widest border-b-4 border-transparent text-slate-400';
};
window.manualPick = function (id, name) {
    Swal.fire({
        title: `จัดการ: ${name}`,
        text: "เลือกดำเนินการสำหรับนักเรียนคนนี้",
        showCancelButton: true,
        confirmButtonText: 'ให้คะแนน +10',
        denyButtonText: 'เรียกชื่อ (Highlight)',
        showDenyButton: true,
    }).then((result) => {
        if (result.isConfirmed) giveScore(id, name, 10);
    });
}
window.updateActivity = async function (status) {
    const title = document.getElementById('input-q-title').value || "กิจกรรมทั่วไป";
    const activity_id = "act_" + Date.now();

    const activityData = {
        activity_id,
        question_title: title,
        status: status
    };

    try {
        // 1. อัปเดตสถานะปัจจุบัน (ให้เด็กเห็น)
        await update(ref(db, `active_sessions/${currentRoom}/current_activity`), activityData);

        // 2. บันทึกลง Log ของ Session
        await set(ref(db, `active_sessions/${currentRoom}/activities_history/${activity_id}`), activityData);

        if (status === 'open') {
            showToast(`เริ่มกิจกรรม: ${title}`);

            // --- [ส่วนที่เพิ่มเพื่อให้ Render ทันที] ---
            selectedActivityFilter = activity_id; // สลับ Filter ไปที่อันใหม่

            // อัปเดตตัวแปร Local ทันทีไม่ต้องรอกรอบถัดไป
            activityLog[activity_id] = activityData;

            // สั่งวาด Dropdown ใหม่เพื่อให้มีชื่อกิจกรรมใหม่ขึ้นมา
            renderActivityFilter();

            // สั่งล้างหน้าจอคำตอบและแสดง Header กิจกรรมใหม่ (ส่ง {} เพื่อบอกว่ายังไม่มีคนตอบ)
            renderResponses({});

            // สลับ Tab ไปที่ Live Feed อัตโนมัติเพื่อให้พี่ติวเตอร์เห็นคำตอบน้อง
            switchTab('live');
        } else {
            showToast("ปิดรับคำตอบแล้ว", "info");
            // เมื่อปิดรับคำตอบ ให้หน้าจอยังคงแสดงคำตอบเดิมไว้ (ไม่ต้องล้างจอ)
        }
    } catch (e) {
        console.error("Update Activity Error:", e);
        showToast("ไม่สามารถอัปเดตกิจกรรมได้", "error");
    }
};

window.runRandom = function (mode) {
    // สุ่มจากเด็กทุกคนในคลาส (A, B, C, D) ตามโจทย์
    let list = allStudentsInClass;

    if (mode === 'volunteer') {
        list = allStudentsInClass.filter(s => responsesHistory[s.id]?.some(h => h.wantsToTalk));
    }

    if (list.length === 0) return showToast("ไม่มีรายชื่อให้สุ่ม", "error");

    const slotList = document.getElementById('slot-list');
    slotList.innerHTML = '';

    // สร้างรายการสุ่ม (เอาชื่อเด็กมาสลับและเพิ่มจำนวนเพื่อให้ลื่นไหล)
    const shuffle = [...list].sort(() => 0.5 - Math.random());
    const repeatCount = 30; // จำนวนชื่อที่จะวิ่งผ่านหน้าจอ

    for (let i = 0; i < repeatCount; i++) {
        const item = shuffle[i % shuffle.length];
        const div = document.createElement('div');
        div.className = 'slot-item';
        div.innerText = item.nickname;
        slotList.appendChild(div);
    }

    let currentPos = 0;
    let speed = 40; // เริ่มต้นที่ความเร็วปกติ
    let moveCount = 0;
    const totalMove = (repeatCount - 1) * 80;

    function animate() {
        currentPos += 80;
        slotList.style.transform = `translateY(-${currentPos}px)`;
        moveCount++;

        if (moveCount < repeatCount - 1) {
            // ค่อยๆ ช้าลงในช่วง 5 ชื่อสุดท้าย
            if (moveCount > repeatCount - 6) speed += 150;
            else if (moveCount > repeatCount - 10) speed += 50;

            setTimeout(animate, speed);
        } else {
            // จบการสุ่ม
            const winner = shuffle[(repeatCount - 1) % shuffle.length];
            Swal.fire({
                title: '🎉 ผู้โชคดี!',
                text: `ยินดีด้วยกับน้อง ${winner.nickname} (บ้าน ${winner.house})`,
                icon: 'success',
                confirmButtonText: 'ให้คะแนน +10',
                showCancelButton: true,
                cancelButtonText: 'ข้าม'
            }).then(res => {
                if (res.isConfirmed) giveScore(winner.id, winner.nickname, 10);
            });
        }
    }
    animate();
};

window.finishSession = async function () {
    const result = await Swal.fire({
        title: 'สิ้นสุดคาบเรียน?',
        text: "ระบบจะทำการ Sync คะแนนเข้าสู่ Google Sheet และปิดห้องเรียน",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'บันทึกและจบคลาส',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        Swal.fire({
            title: 'กำลังซิงค์ข้อมูล...',
            text: 'กรุณารอสักครู่ ระบบกำลังนำส่งข้อมูลเข้า Google Sheets',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        try {
            // 1. ส่งข้อมูลไป GAS (ไม่ใช้ await เพื่อไม่ให้การค้างของ GAS มาดึงหน้าจอเรา)
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({
                    action: "syncClassroomScore",
                    key: CONFIG.syncKey,
                    room: currentRoom,
                    subject: currentSubject,
                    tutor: checkAuth()?.nickname || "Tutor",
                    studentScores: scoresToSync.studentScores,
                    houseScores: scoresToSync.houseScores
                })
            });

            // 2. ล้างข้อมูลใน Firebase 
            // เราจะลบทีละโหนดเพื่อให้มั่นใจว่าไม่มี Error จากโหนดใดโหนดหนึ่งมาขัดขวาง
            const roomToClear = currentRoom; // เก็บชื่อห้องไว้ก่อนล้าง

            await remove(ref(db, `active_sessions/${roomToClear}`));
            await remove(ref(db, `presence/${roomToClear}`));
            await remove(ref(db, `responses/${roomToClear}`));
            await remove(ref(db, `classroom_scores/${roomToClear}`));
            await remove(ref(db, `private_questions/${roomToClear}`));

            // 3. ล้าง Local Storage และ State
            localStorage.removeItem('active_tutor_room');
            currentRoom = null;

            // 4. แสดงผลสำเร็จ (ปิด Loading เดิม)
            Swal.fire({
                icon: 'success',
                title: 'จบคลาสสำเร็จ!',
                text: 'คะแนนถูกส่งเข้าสู่คลังข้อมูลกลางแล้ว',
                timer: 2000,
                showConfirmButton: false
            }).then(() => {
                window.location.href = '../index.html';
            });

        } catch (e) {
            console.error("Sync Error:", e);
            Swal.fire({
                icon: 'error',
                title: 'เกิดข้อผิดพลาด',
                text: 'ไม่สามารถล้างข้อมูลใน Firebase ได้ แต่ข้อมูลอาจถูกส่งไป GAS แล้ว'
            });
        }
    }
};

// ---------------------------------------------------------
// [SECTION: STUDENT LOGIC] - สำหรับหน้า student.html (Auto-Detect Session)
// ---------------------------------------------------------

let userSession = checkAuth();
let myRoom = userSession?.classID ? `Room_${userSession.classID}` : null;
let currentActivityId = null;
let activeSessionData = null; // เก็บข้อมูลห้องเรียนที่กำลังเปิดอยู่
let isInClass = false;
let lastActiveSubject = "";

// --- [1] ฟังก์ชันเริ่มเฝ้าดูห้องเรียน (Watcher) ---
function startRoomWatcher() {
    const roomBadge = document.getElementById('room-badge');
    const interactionBar = document.getElementById('interaction-bar'); // เพิ่มการอ้างอิง Bar

    if (!myRoom) {
        if (roomBadge) roomBadge.innerText = "NO ROOM ASSIGNED";
        // แสดง UI ว่าน้องยังไม่มีห้อง
        const container = document.getElementById('subject-selector');
        if (container) {
            container.innerHTML = `<div class="py-10 text-slate-400 italic">คุณยังไม่มีรายชื่อในห้องเรียนใดๆ<br>กรุณารอประกาศห้องเรียนจากหน้าหลัก</div>`;
        }
        return;
    }

    onValue(ref(db, `active_sessions/${myRoom}`), (snapshot) => {
        const session = snapshot.val();
        activeSessionData = session;

        if (session && session.isOpen) {
            // --- [1] สถานะ: ห้องเรียนเปิดติวอยู่ (LIVE) ---
            if (roomBadge) {
                roomBadge.innerText = `${myRoom} | ${session.subject.toUpperCase()}`;
            }

            // เก็บชื่อวิชาไว้ใช้ตอนทำ Rating (ใช้ window. เพื่อให้ไฟล์อื่นเห็น)
            window.lastActiveSubject = session.subject;

            // ถ้าเครื่องน้องอยู่ในสถานะ "เข้าเรียนแล้ว" ให้โชว์แถบ Interaction
            if (window.isInClass && interactionBar) {
                interactionBar.classList.remove('hidden');
            }

        } else {
            // --- [2] สถานะ: ห้องเรียนถูกปิด หรือยังไม่เปิด (WAITING) ---
            if (roomBadge) {
                roomBadge.innerText = `${myRoom} | WAITING...`;
            }
            if (interactionBar) {
                interactionBar.classList.add('hidden');
            }

            // --- TRIGGER RATING LOGIC ---
            // ถ้าเคยเรียนอยู่ (isInClass = true) แต่ตอนนี้ห้องปิดแล้ว แสดงว่าพี่เพิ่งกด Finish Session
            if (window.isInClass && window.lastActiveSubject) {
                if (typeof triggerRating === 'function') {
                    triggerRating(window.lastActiveSubject);
                }
                // รีเซ็ตสถานะหลังจากเรียกหน้าประเมินแล้ว
                window.isInClass = false;
                window.lastActiveSubject = "";
            }
        }

        // วาดหน้าจอหลัก (ปุ่ม Join หรือข้อความรอ)
        renderWaitingRoom(session);
    });
}

// --- [2] ฟังก์ชันวาดหน้าจอ Waiting Room ---
function renderWaitingRoom(session) {
    const container = document.getElementById('subject-selector');

    // ถ้าห้องยังไม่เปิด
    if (!session || !session.isOpen) {
        container.innerHTML = `
            <div class="w-20 h-20 bg-slate-100 text-slate-300 rounded-3xl flex items-center justify-center mx-auto text-4xl mb-6">
                ⏳
            </div>
            <h2 class="text-2xl font-black text-slate-800">รอติวเตอร์เปิดห้องเรียน</h2>
            <p class="text-slate-400 text-sm">ขณะนี้ในห้อง ${myRoom} ยังไม่มีกิจกรรม<br>กรุณารอสักครู่...</p>
        `;
        document.getElementById('room-badge').innerText = `${myRoom} | Waiting...`;
        return;
    }

    // ถ้าห้องเปิดแล้ว! (แสดงปุ่มให้กดเข้าได้เลย)
    container.innerHTML = `
        <div class="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto text-4xl mb-6 shadow-lg animate-bounce">
            📖
        </div>
        <h2 class="text-2xl font-black text-slate-800">ห้องเรียนเปิดแล้ว!</h2>
        <div class="bg-blue-50 p-4 rounded-2xl border border-blue-100 my-6">
            <p class="text-[10px] text-blue-400 font-bold uppercase tracking-widest">กำลังสอนในวิชา</p>
            <p class="text-xl font-black text-blue-700">${session.subject.toUpperCase()}</p>
            <p class="text-xs text-slate-500 mt-1">โดย พี่${session.tutorName}</p>
        </div>
        <button onclick="joinClass()" class="w-full bg-blue-600 text-white py-4 rounded-2xl font-black text-lg shadow-xl shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all">
            เข้าเรียนตอนนี้ ➔
        </button>
    `;
}

// --- [3] ฟังก์ชันกดเข้าร่วม (Join) ---
window.joinClass = async function () {
    if (!activeSessionData) return;

    Swal.fire({ title: 'กำลังเข้าสู่ห้องเรียน...', didOpen: () => Swal.showLoading() });

    try {
        const myPresenceRef = ref(db, `presence/${myRoom}/${userSession.id}`);
        await set(myPresenceRef, {
            fullName: userSession.fullName,
            nickname: userSession.nickname,
            house: userSession.house,
            joinedAt: new Date().toISOString()
        });

        onDisconnect(myPresenceRef).remove();

        // --- [วางบรรทัดนี้ที่นี่] ---
        window.isInClass = true;
        window.lastActiveSubject = activeSessionData.subject;
        // -------------------------

        // สลับหน้าจอ UI
        document.getElementById('subject-selector').classList.add('hidden');
        document.getElementById('activity-area').classList.remove('hidden');

        // แสดงแถบ Interaction Bar (ถ้ามี)
        const interactionBar = document.getElementById('interaction-bar');
        if (interactionBar) interactionBar.classList.remove('hidden');

        document.getElementById('room-badge').innerText = `${myRoom} | ${activeSessionData.subject.toUpperCase()}`;

        Swal.close();
        initStudentListener(); // เริ่มฟังคำถาม Broadcast

    } catch (e) {
        console.error(e);
        Swal.fire("Error", "ไม่สามารถเข้าห้องเรียนได้", "error");
    }
};

// --- [4] ฟังก์ชันฟังคำถาม (เหมือนเดิม) ---
function initStudentListener() {
    onValue(ref(db, `active_sessions/${myRoom}/current_activity`), (snapshot) => {
        const activity = snapshot.val();
        if (!activity) return;

        if (currentActivityId !== activity.activity_id) {
            document.getElementById('input-answer').value = "";
            document.getElementById('check-talk').checked = false;
            currentActivityId = activity.activity_id;
        }

        document.getElementById('display-q-title').innerText = activity.question_title;
        const isOpen = activity.status === 'open';
        document.getElementById('response-form').classList.toggle('hidden', !isOpen);
        document.getElementById('closed-state').classList.toggle('hidden', isOpen);

        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (dot && text) {
            dot.className = isOpen ? "flex h-3 w-3 rounded-full bg-emerald-500 animate-pulse" : "flex h-3 w-3 rounded-full bg-slate-500";
            text.innerText = isOpen ? "LIVE: เปิดรับคำตอบ" : "Tutor Closed Responses";
        }
    });
}

// --- [5] ฟังก์ชันส่งคำตอบ (เหมือนเดิม) ---
window.submitResponse = async function () {
    const answer = document.getElementById('input-answer').value.trim();
    const wantsToTalk = document.getElementById('check-talk').checked;

    if (!answer) return showToast("กรุณาพิมพ์คำตอบ", "error");

    try {
        await push(ref(db, `responses/${myRoom}`), {
            activityID: currentActivityId,
            studentID: userSession.id,
            nickname: userSession.nickname,
            house: userSession.house,
            answer: answer,
            wantsToTalk: wantsToTalk,
            timestamp: Date.now()
        });

        Swal.fire({ icon: 'success', title: 'ส่งคำตอบแล้ว!', timer: 1500, showConfirmButton: false });
        document.getElementById('response-form').classList.add('hidden');
        document.getElementById('closed-state').innerHTML = `<p class="text-emerald-600 font-bold italic">ส่งคำตอบเรียบร้อยแล้ว ✅</p>`;
        document.getElementById('closed-state').classList.remove('hidden');
    } catch (e) { showToast("ส่งคำตอบไม่สำเร็จ", "error"); }
};

// --- [6] ตรวจสอบว่าอยู่หน้าไหน แล้วเริ่มทำงาน ---
if (window.location.pathname.includes('student.html')) {
    startRoomWatcher();
}

// ---------------------------------------------------------
// [SECTION: SCORING LOGIC] - สำหรับการให้คะแนนและจัดการโควต้า
// ---------------------------------------------------------

window.customScore = async function (id, name, type) {
    const { value: pts } = await Swal.fire({
        title: `ระบุคะแนน: ${name}`,
        input: 'number',
        inputLabel: 'ระบุจำนวนคะแนนที่ต้องการเพิ่ม (ใส่ค่าลบเพื่อลดคะแนน)',
        inputPlaceholder: 'ตัวอย่าง: 15 หรือ -5',
        showCancelButton: true
    });

    if (pts) {
        if (type === 'std') giveScore(id, name, parseInt(pts));
        else giveHouseScore(id, parseInt(pts));
    }
}
window.giveScore = async function (id, name, pts) {
    if (quotaUsed + pts > 100) return Swal.fire("โควต้าเต็ม", "ใช้คะแนนเกิน 100 แล้ว", "warning");

    await update(ref(db, `classroom_scores/${currentRoom}`), { quotaUsed: quotaUsed + pts });

    if (!scoresToSync.studentScores[id]) scoresToSync.studentScores[id] = { name: name, score: 0 };
    scoresToSync.studentScores[id].score += pts;

    showToast(`${name}: ${pts > 0 ? '+' : ''}${pts} คะแนน`);
    renderSummaryTable();
};

window.giveHouseScore = async function (house, pts) {
    if (quotaUsed + pts > 100) return Swal.fire("โควต้าเต็ม", "ใช้คะแนนเกิน 100 แล้ว", "warning");

    await update(ref(db, `classroom_scores/${currentRoom}`), { quotaUsed: quotaUsed + pts });

    if (!scoresToSync.houseScores[house]) scoresToSync.houseScores[house] = 0;
    scoresToSync.houseScores[house] += pts;

    showToast(`บ้าน ${house}: ${pts > 0 ? '+' : ''}${pts} คะแนน`);
    renderSummaryTable();
};