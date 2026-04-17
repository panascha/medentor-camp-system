import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, onValue, push, remove, update, get, onDisconnect } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Local State
const rooms = ['Room_A', 'Room_B', 'Room_C', 'Room_D'];
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
    const room = document.getElementById('select-room').value;
    const subject = document.getElementById('select-subject').value;
    const user = checkAuth();
    const tutorName = user.nickname || user.fullName;

    try {
        const snapshot = await get(ref(db, `active_sessions/${room}`));
        const session = snapshot.val();

        if (session && session.isOpen) {
            // แก้ไขจาก session.tutorName เป็น session.tutor ให้ตรงกับฐานข้อมูล
            const currentTutor = session.tutor || "ติวเตอร์";

            const result = await Swal.fire({
                title: 'ห้องเรียนไม่ว่าง!',
                html: `พี่ <b>${currentTutor}</b> กำลังสอนวิชา <b>${session.subject.toUpperCase()}</b><br><br>ต้องการส่งสัญญาณให้ปิดห้องภายใน 30 วินาทีหรือไม่?`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                confirmButtonText: 'ส่งสัญญาณแจ้งเตือน',
                cancelButtonText: 'ยกเลิก'
            });

            if (result.isConfirmed) {
                // เรียกใช้ฟังก์ชันส่งคำขอ
                await sendTakeoverRequest(room);
            }
            return;
        }

        // ตอนบันทึก ใช้คีย์ 'tutor' เป็นหลัก
        await set(ref(db, `active_sessions/${room}`), {
            isOpen: true,
            subject: subject,
            tutor: tutorName, // ใช้คำว่า tutor
            startTime: Date.now()
        });

        // บันทึกสถานะลงเครื่อง
        localStorage.setItem('active_tutor_room', room);
        currentRoom = room;
        currentSubject = subject;

        showUI(true);
        await loadClassMetadata();
        initTutorListeners();

        showToast(`เปิดห้องเรียน ${room} สำเร็จ!`);

    } catch (e) {
        console.error(e);
        showToast("ไม่สามารถเปิดห้องเรียนได้", "error");
    }
};

function handleSessionUI(session, roomId) {
    const roomBadge = document.getElementById('room-badge');
    const interactionBar = document.getElementById('interaction-bar');

    if (session && session.isOpen) {
        if (roomBadge) roomBadge.innerText = `${roomId.replace('_', ' ')} | ${session.subject.toUpperCase()}`;
        window.lastActiveSubject = session.subject;
        if (window.isInClass && interactionBar) interactionBar.classList.remove('hidden');
    } else {
        if (roomBadge) roomBadge.innerText = `${roomId.replace('_', ' ')} | WAITING...`;
        if (interactionBar) interactionBar.classList.add('hidden');

        if (window.isInClass && window.lastActiveSubject) {
            if (typeof triggerRating === 'function') triggerRating(window.lastActiveSubject);
            window.isInClass = false;
        }
    }
}

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

    // 7. Listen Current Activity: มีการตั้งคำถามใหม่หรือเปลี่ยนสถานะคำถามปัจจุบันหรือเปล่า (ถ้าใช่ ให้รีเฟรช Live Feed ทันที)
    onValue(ref(db, `active_sessions/${currentRoom}/current_activity`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            // อัปเดตตัวแปรในเครื่อง
            activityLog[data.activity_id] = data;
            // ถ้าเรากำลังดู "กิจกรรมปัจจุบัน" อยู่ ให้สั่ง Re-render
            if (selectedActivityFilter === 'current' || selectedActivityFilter === data.activity_id) {
                get(ref(db, `responses/${currentRoom}`)).then(snap => renderResponses(snap.val() || {}));
            }
        }
    });

    // 8. Listen Private Questions: มีน้องส่งคำถามส่วนตัวมาหรือเปล่า (ถ้ามีให้แสดงในหน้าจอทันที)
    listenPrivateQuestions();
    listenForForceClose(currentRoom); // เริ่มฟังว่ามีใครมาขอให้ปิดห้องไหม (กรณีที่เราเปิดห้องทับคนอื่น)
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

    // 1. หาข้อมูลกิจกรรมที่จะแสดง
    let targetActivityId = selectedActivityFilter;
    if (selectedActivityFilter === 'current') {
        const keys = Object.keys(activityLog);
        targetActivityId = keys.length > 0 ? keys[keys.length - 1] : null;
    }

    const currentQ = activityLog[targetActivityId];
    if (!currentQ) {
        feed.innerHTML = `<div class="col-span-full py-20 text-center text-slate-400 italic">ยังไม่มีกิจกรรมที่ถูกสร้าง</div>`;
        return;
    }

    // 2. กรองคำตอบ
    const entries = Object.entries(data);
    const filteredEntries = entries.filter(([key, res]) => res.activityID === targetActivityId).reverse();

    // 3. เตรียม UI Header (แสดงหัวข้อและสถานะ)
    const statusBadge = currentQ.status === 'open'
        ? `<span class="bg-emerald-500 text-white text-[10px] px-2 py-1 rounded-full animate-pulse">● LIVE</span>`
        : `<span class="bg-slate-500 text-white text-[10px] px-2 py-1 rounded-full">● CLOSED</span>`;

    let html = `
        <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <p class="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">หัวข้อกิจกรรมปัจจุบัน:</p>
                    <h3 class="text-2xl font-black text-slate-800">${currentQ.question_title}</h3>
                </div>
                <div>${statusBadge}</div>
            </div>
            <div class="text-[10px] font-bold text-slate-400 uppercase">
                <span>คำตอบทั้งหมด: ${filteredEntries.length}</span>
            </div>
        </div>
    `;

    // 4. แสดงรายการคำตอบ
    if (filteredEntries.length === 0) {
        html += `
            <div class="col-span-full py-16 text-center bg-white/50 rounded-[2rem] border-2 border-dashed border-slate-200">
                <p class="text-slate-400 font-bold italic">ยังไม่มีคำตอบส่งเข้ามา... กำลังรอรหัสน้องๆ</p>
            </div>`;
    } else {
        html += filteredEntries.map(([key, res]) => `
            <div class="bg-white p-6 rounded-[2rem] shadow-sm border-2 ${res.wantsToTalk ? 'border-yellow-400 bg-yellow-50' : 'border-transparent'} transition-all hover:shadow-md relative overflow-hidden group">
                ${res.wantsToTalk ? '<div class="absolute top-0 right-0 bg-yellow-400 text-[10px] font-black px-4 py-1 rounded-bl-2xl">VOLUNTEER 🙋‍♂️</div>' : ''}
                
                <div class="flex items-center gap-4 mb-4">
                    <div class="w-12 h-12 bg-blue-600 text-white rounded-2xl flex items-center justify-center font-black shadow-lg shadow-blue-100">
                        ${res.house}
                    </div>
                    <div>
                        <h4 class="font-black text-lg text-slate-800 leading-tight">${res.nickname}</h4>
                        <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            ${new Date(res.timestamp).toLocaleTimeString('th-TH')} | HOUSE ${res.house}
                        </p>
                    </div>
                </div>
                <div class="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <p class="text-slate-700 font-medium leading-relaxed">${res.answer}</p>
                </div>
                
                <button onclick="giveScore('${res.studentID}', '${res.nickname}', 5)" 
                    class="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity bg-blue-100 text-blue-600 px-3 py-1 rounded-lg text-[10px] font-black hover:bg-blue-600 hover:text-white">
                    QUICK +5
                </button>
            </div>
        `).join('');
    }

    feed.innerHTML = html;
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
function listenForForceClose(room) {
    const requestRef = ref(db, `active_sessions/${room}/forceCloseRequest`);

    // ฟังการเปลี่ยนแปลงในฟิลด์ forceCloseRequest
    onValue(requestRef, async (snapshot) => {
        const request = snapshot.val();
        if (!request) return;

        // ป้องกันแจ้งเตือนตัวเอง
        if (request.requestedBy === (userSession.nickname || userSession.fullName)) return;

        let timerInterval;
        const result = await Swal.fire({
            title: 'มีคำขอคืนห้องเรียน!',
            html: `พี่ <b>${request.requestedBy}</b> รอสอนคาบถัดไป<br><br>ระบบจะปิดห้องอัตโนมัติในอีก <b><span></span></b> วินาที`,
            icon: 'error',
            timer: 30000, // 30 วินาที
            timerProgressBar: true,
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            confirmButtonText: 'ปิดห้องและ Sync ทันที',
            cancelButtonText: 'ขอเวลาแป๊บนึง (ยกเลิกอัตโนมัติ)',
            didOpen: () => {
                const b = Swal.getHtmlContainer().querySelector('span');
                timerInterval = setInterval(() => {
                    b.textContent = Math.ceil(Swal.getTimerLeft() / 1000);
                }, 100);
            },
            willClose: () => { clearInterval(timerInterval); }
        });

        if (result.isConfirmed || result.dismiss === Swal.DismissReason.timer) {
            // กรณีปิดทันที หรือ หมดเวลา 30 วินาที
            if (result.dismiss === Swal.DismissReason.timer) {
                showToast("หมดเวลา! กำลังปิดห้องและบันทึกข้อมูล...", "warning");
            }
            window.finishSession(true); 
        } else if (result.dismiss === Swal.DismissReason.cancel) {
            // กรณีขอเวลาแป๊บนึง ให้ลบคำขอออกจาก Firebase
            await update(ref(db, `active_sessions/${room}`), { forceCloseRequest: null });
            showToast("ยกเลิกการปิดอัตโนมัติแล้ว โปรดรีบสรุปคะแนนและปิดห้องด้วยตัวเอง", "info");
        }
    });
}

async function sendTakeoverRequest(targetRoom) {
    const user = checkAuth();
    const tutorName = user?.nickname || user?.fullName || "พี่สตาฟ";

    try {
        // อ้างอิงไปที่ห้องนั้นๆ
        const roomRef = ref(db, `active_sessions/${targetRoom}`);

        // ใช้ update เพื่อสร้างฟิลด์ forceCloseRequest โดยไม่กระทบข้อมูลอื่น
        await update(roomRef, {
            "forceCloseRequest": {
                "requestedBy": tutorName,
                "requestedAt": Date.now()
            }
        });

        showToast(`ส่งสัญญาณขอห้องเรียนถึงพี่สตาฟคนเดิมแล้ว`, "info");
    } catch (error) {
        console.error("Takeover Request Error:", error);
        showToast("ไม่สามารถส่งสัญญาณได้ กรุณาลองใหม่", "error");
    }
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
window.selectManualRoom = function (roomId) {
    // กำหนดค่าห้องที่เลือกให้กับตัวแปร global
    myRoom = roomId;

    // ไปดึงข้อมูลของห้องนั้นมาเก็บใน activeSessionData
    get(ref(db, `active_sessions/${myRoom}`)).then((snapshot) => {
        activeSessionData = snapshot.val();
        if (activeSessionData) {
            // เมื่อเลือกห้องแล้ว ให้เข้าสู่กระบวนการ Join ปกติ
            joinClass();
        }
    });
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
    const title = document.getElementById('input-q-title').value.trim() || "กิจกรรมทั่วไป";

    // ถ้าจะเปิดรับคำตอบ ให้ยืนยันก่อน
    if (status === 'open') {
        const confirm = await Swal.fire({
            title: 'เริ่มกิจกรรมใหม่?',
            text: `หัวข้อ: ${title}`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'เริ่มเลย!',
            cancelButtonText: 'แก้ไขก่อน'
        });
        if (!confirm.isConfirmed) return;
    }

    const activity_id = "act_" + Date.now();
    const activityData = {
        activity_id,
        question_title: title,
        status: status, // 'open' หรือ 'closed'
        timestamp: Date.now()
    };

    try {
        // 1. อัปเดตข้อมูลลง Firebase
        await update(ref(db, `active_sessions/${currentRoom}/current_activity`), activityData);
        await set(ref(db, `active_sessions/${currentRoom}/activities_history/${activity_id}`), activityData);

        // 2. อัปเดตสถานะในเครื่อง
        selectedActivityFilter = activity_id;
        activityLog[activity_id] = activityData;

        // 3. สั่ง Render ทันที
        renderActivityFilter();
        renderResponses({}); // ส่ง Object ว่างเพื่อให้วาดหัวข้อรอไว้เลย
        switchTab('live');

        if (status === 'open') {
            showToast(`เปิดรับคำตอบ: ${title}`);
            document.getElementById('input-q-title').value = ""; // ล้างช่องกรอก
        } else {
            showToast("ปิดรับคำตอบแล้ว", "info");
        }
    } catch (e) {
        showToast("เกิดข้อผิดพลาด", "error");
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

window.finishSession = async function (isAuto = false) {
    // 1. ตรวจสอบว่ามีการกดยืนยันหรือไม่ (ถ้าไม่ใช่การปิดอัตโนมัติให้ถามก่อน)
    if (!isAuto) {
        const result = await Swal.fire({
            title: 'สิ้นสุดคาบเรียน?',
            text: "ระบบจะทำการ Sync คะแนนเข้าสู่ Google Sheet และปิดห้องเรียน",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#22c55e',
            confirmButtonText: 'บันทึกและจบคลาส',
            cancelButtonText: 'ยกเลิก'
        });

        if (!result.isConfirmed) return;
    }

    // 2. แสดงสถานะกำลังดำเนินการ
    Swal.fire({
        title: isAuto ? 'ระบบกำลังจบคลาสอัตโนมัติ...' : 'กำลังซิงค์ข้อมูล...',
        text: 'กรุณารอสักครู่ ระบบกำลังนำส่งข้อมูลเข้า Google Sheets',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try {
        const roomToClear = currentRoom;
        if (!roomToClear) throw new Error("No active room found");

        // 3. เตรียมข้อมูลสำหรับ Sync (ดึงข้อมูลล่าสุดจาก State)
        // หมายเหตุ: ตรวจสอบว่าตัวแปร window.classScores และ window.houseScores มีข้อมูลปัจจุบัน
        const syncPayload = {
            action: "syncClassroomScore",
            key: CONFIG.syncKey,
            room: roomToClear,
            subject: currentSubject,
            tutor: checkAuth()?.nickname || "Tutor",
            studentScores: scoresToSync.studentScores || {},
            houseScores: scoresToSync.houseScores || {}
        };

        // 4. ส่งข้อมูลไป Google Sheets (Background Sync)
        fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(syncPayload)
        });

        // 5. ล้างข้อมูลใน Firebase พร้อมกัน (ใช้ Promise.all เพื่อความเร็ว)
        // การลบกิ่ง active_sessions จะรวมถึงการลบ forceCloseRequest ทิ้งด้วย
        await Promise.all([
            remove(ref(db, `active_sessions/${roomToClear}`)),
            remove(ref(db, `presence/${roomToClear}`)),
            remove(ref(db, `responses/${roomToClear}`)),
            remove(ref(db, `classroom_scores/${roomToClear}`)),
            remove(ref(db, `private_questions/${roomToClear}`))
        ]);

        // 6. ล้างสถานะในตัวแปรและ Local Storage
        localStorage.removeItem('active_tutor_room');
        currentRoom = null;
        currentSubject = null;

        // 7. แจ้งเตือนสำเร็จ
        await Swal.fire({
            icon: 'success',
            title: isAuto ? 'หมดเวลาและจบคลาสแล้ว' : 'จบคลาสสำเร็จ!',
            text: 'คะแนนถูกส่งเข้าสู่คลังข้อมูลกลางเรียบร้อยแล้ว',
            timer: 2000,
            showConfirmButton: false
        });

        // กลับหน้าหลัก
        window.location.href = '../index.html';

    } catch (e) {
        console.error("Finish Session Error:", e);
        Swal.fire({
            icon: 'error',
            title: 'เกิดข้อผิดพลาด',
            text: 'ไม่สามารถปิดห้องเรียนได้อย่างสมบูรณ์ กรุณาแจ้งฝ่าย Academic'
        });
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

    // [CASE A] น้องมีห้องที่ถูกจัดไว้แล้ว (จาก Admin)
    if (myRoom) {
        onValue(ref(db, `active_sessions/${myRoom}`), (snapshot) => {
            const session = snapshot.val();
            activeSessionData = session;
            handleSessionUI(session, myRoom);
            renderWaitingRoom(session);
        });
    }
    // [CASE B] น้องไม่มีห้อง (หรือต้องการเลือกห้องเอง)
    else {
        if (roomBadge) roomBadge.innerText = "SELECT A ROOM";

        // ฟังข้อมูลจากกิ่ง active_sessions ทั้งหมด เพื่อดูว่าห้องไหนเปิดอยู่บ้าง
        onValue(ref(db, `active_sessions`), (snapshot) => {
            const allSessions = snapshot.val() || {};
            renderAvailableRooms(allSessions);
        });
    }
}

function renderAvailableRooms(sessions) {
    const container = document.getElementById('subject-selector');
    if (!container) return;

    const activeRooms = Object.entries(sessions).filter(([id, data]) => data.isOpen);

    if (activeRooms.length === 0) {
        container.innerHTML = `
            <div class="py-10 text-center">
                <div class="text-4xl mb-4">⏳</div>
                <h2 class="text-xl font-black text-slate-800">ยังไม่มีห้องเรียนเปิดสอน</h2>
                <p class="text-slate-400 text-sm mt-2">กรุณารอพี่ติวเตอร์เปิดระบบสักครู่...</p>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="text-left mb-6">
            <h2 class="text-xl font-black text-slate-800">เลือกห้องที่ต้องการเข้าร่วม</h2>
            <p class="text-slate-400 text-xs">พบ ${activeRooms.length} ห้องที่กำลังทำการเรียนการสอน</p>
        </div>
        <div class="grid grid-cols-1 gap-3">
            ${activeRooms.map(([id, data]) => `
                <button onclick="selectManualRoom('${id}')" 
                    class="bg-white p-5 rounded-3xl border-2 border-slate-100 hover:border-blue-500 hover:bg-blue-50 transition-all text-left group">
                    <div class="flex justify-between items-center">
                        <div>
                            <span class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">${id.replace('_', ' ')}</span>
                            <h3 class="text-lg font-black text-slate-800">${data.subject.toUpperCase()}</h3>
                            <p class="text-xs text-slate-500">ติวเตอร์: พี่${data.tutor}</p>
                        </div>
                        <div class="w-10 h-10 bg-slate-100 rounded-2xl flex items-center justify-center group-hover:bg-blue-600 group-hover:text-white transition-colors">
                            ➔
                        </div>
                    </div>
                </button>
            `).join('')}
        </div>
    `;
}

// --- [2] ฟังก์ชันวาดหน้าจอ Waiting Room ---
function renderWaitingRoom(session) {
    const container = document.getElementById('subject-selector');
    if (!container) return;

    // --- [CASE 1] ถ้าห้องยังไม่เปิดสอน (CLOSED / WAITING) ---
    if (!session || !session.isOpen) {
        container.innerHTML = `
            <div class="w-20 h-20 bg-slate-100 text-slate-300 rounded-3xl flex items-center justify-center mx-auto text-4xl mb-6">
                ⏳
            </div>
            <h2 class="text-2xl font-black text-slate-800">รอติวเตอร์เปิดห้องเรียน</h2>
            <p class="text-slate-400 text-sm">ขณะนี้ในห้อง <span class="text-blue-600 font-bold">${myRoom.replace('_', ' ')}</span> ยังไม่มีกิจกรรม<br>กรุณารอสักครู่...</p>
        `;

        // เพิ่มปุ่ม "เลือกห้องอื่น" เฉพาะน้องที่ Admin ไม่ได้ล็อกห้องไว้ (classID ว่าง)
        if (!userSession.classID) {
            container.innerHTML += `
                <div class="mt-8 pt-6 border-t border-slate-100">
                    <button onclick="location.reload()" class="text-sm font-bold text-blue-600 hover:underline flex items-center justify-center gap-2 mx-auto">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 15l-3-3m0 0l3-3m-3 3h8M3 12a9 9 0 1118 0 8 9 0 01-18 0z" />
                        </svg>
                        กลับไปเลือกห้องเรียนอื่น
                    </button>
                </div>
            `;
        }

        if (document.getElementById('room-badge')) {
            document.getElementById('room-badge').innerText = `${myRoom.replace('_', ' ')} | WAITING...`;
        }
        return;
    }

    // --- [CASE 2] ถ้าห้องเปิดแล้ว (LIVE) ---
    container.innerHTML = `
        <div class="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto text-4xl mb-6 shadow-lg animate-bounce">
            📖
        </div>
        <h2 class="text-2xl font-black text-slate-800">ห้องเรียนเปิดแล้ว!</h2>
        <div class="bg-blue-50 p-4 rounded-2xl border border-blue-100 my-6">
            <p class="text-[10px] text-blue-400 font-bold uppercase tracking-widest">กำลังสอนในวิชา</p>
            <p class="text-xl font-black text-blue-700">${session.subject.toUpperCase()}</p>
            <p class="text-xs text-slate-500 mt-1">โดย พี่${session.tutor}</p>
        </div>
        
        <button onclick="joinClass()" class="w-full bg-blue-600 text-white py-4 rounded-2xl font-black text-lg shadow-xl shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all">
            เข้าเรียนตอนนี้ ➔
        </button>
    `;

    // เพิ่มปุ่ม "เลือกห้องอื่น" กรณีเข้าเรียนผิดห้อง (เฉพาะน้องที่ไม่ได้ถูกล็อกห้อง)
    if (!userSession.classID) {
        container.innerHTML += `
            <button onclick="location.reload()" class="mt-6 text-xs font-bold text-slate-400 hover:text-blue-600 underline">
                เลือกห้องอื่น (กรณีเข้าผิดห้อง)
            </button>
        `;
    }
}

// --- [3] ฟังก์ชันกดเข้าร่วม (Join) ---
// ค้นหา window.joinClass ใน js/classroom-logic.js
window.joinClass = async function () {
    // 1. ดึงข้อมูล User ใหม่ทุกครั้งที่กด เพื่อป้องกันค่า null
    const currentUser = checkAuth();

    // 2. ตรวจสอบความพร้อมของข้อมูล
    if (!currentUser || !currentUser.id) {
        Swal.fire("ไม่พบข้อมูลผู้ใช้งาน", "กรุณาเข้าสู่ระบบใหม่อีกครั้ง", "error")
            .then(() => window.location.href = 'login.html');
        return;
    }

    if (!activeSessionData || !myRoom) {
        Swal.fire("ผิดพลาด", "ข้อมูลห้องเรียนไม่สมบูรณ์", "error");
        return;
    }

    Swal.fire({ title: 'กำลังเข้าสู่ห้องเรียน...', didOpen: () => Swal.showLoading() });

    try {
        // ใช้ currentUser.id แทน userSession.id
        const myPresenceRef = ref(db, `presence/${myRoom}/${currentUser.id}`);
        await set(myPresenceRef, {
            fullName: currentUser.fullName,
            nickname: currentUser.nickname,
            house: currentUser.house,
            joinedAt: new Date().toISOString()
        });

        onDisconnect(myPresenceRef).remove();

        // ตั้งค่าสถานะการเข้าเรียน
        window.isInClass = true;
        window.lastActiveSubject = activeSessionData.subject;

        // สลับหน้าจอ UI
        document.getElementById('subject-selector').classList.add('hidden');
        document.getElementById('activity-area').classList.remove('hidden');

        // แสดงแถบ Interaction Bar (ถ้ามี)
        const interactionBar = document.getElementById('interaction-bar');
        if (interactionBar) interactionBar.classList.remove('hidden');

        document.getElementById('room-badge').innerText = `${myRoom.replace('_', ' ')} | ${activeSessionData.subject.toUpperCase()}`;

        Swal.close();
        initStudentListener(); // เริ่มฟังคำถาม Broadcast

    } catch (e) {
        console.error("Join Class Error:", e);
        Swal.fire("Error", "ไม่สามารถเข้าห้องเรียนได้: " + e.message, "error");
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

// --- [7] ฟังก์ชันออกจากห้องเรียน (สำหรับนักเรียน) ---
window.exitClass = async function () {
    const result = await Swal.fire({
        title: 'ออกจากห้องเรียน?',
        text: "คุณต้องการกลับสู่หน้าหลักใช่หรือไม่? (สถานะออนไลน์จะถูกยกเลิก)",
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'ใช่, กลับหน้าหลัก',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#3b82f6'
    });

    if (result.isConfirmed) {
        const currentUser = checkAuth();
        if (currentUser && myRoom) {
            // ลบสถานะออนไลน์ใน Firebase
            const myPresenceRef = ref(db, `presence/${myRoom}/${currentUser.id}`);
            await remove(myPresenceRef);
        }

        // รีเซ็ตสถานะในเครื่อง
        window.isInClass = false;

        // กลับหน้าหลัก
        window.location.href = '../index.html';
    }
};

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