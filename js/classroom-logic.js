import { initializeApp} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, onValue, push, remove, update, get, onDisconnect } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);
window.db = db; // แนบ db ไว้กับ window เพื่อให้ไฟล์อื่นๆ ใช้งานได้โดยไม่ต้อง initialize ซ้ำ

if (window.setupConnectionManager) {
    window.setupConnectionManager(db);
}

// 2. Local State
let currentRoom = null;
let currentSubject = null;
let quotaUsed = 0;
let allStudentsInClass = []; // เด็กทั้งหมดตามฐานข้อมูล
let onlineStudents = {};     // เด็กที่ต่อเน็ตอยู่ปัจจุบัน
let responsesHistory = {};   // เก็บแบบ { studentID: [ {activity: "...", answer: "...", time: "..."}, ... ] }
let scoresToSync = { studentScores: {}, houseScores: {} };
let activityLog = {}; // เก็บ { activity_id: { title: "...", status: "..." } }
let subjectQuotas = {}; // เก็บ { subject: { used: number, total: number } }
let selectedActivityFilter = 'current'; // 'current' หรือ activity_id เจาะจง
const HOUSE_THEMES = {
    1: 'bg-red-50 text-red-700 border-red-200',
    2: 'bg-blue-50 text-blue-700 border-blue-200',
    3: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    4: 'bg-amber-50 text-amber-700 border-amber-200',
    5: 'bg-purple-50 text-purple-700 border-purple-200',
    6: 'bg-pink-50 text-pink-700 border-pink-200',
    7: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    8: 'bg-teal-50 text-teal-700 border-teal-200'
};
const DIV_TO_SUBJECT_MAP = {
    "เคมี": "chemistry",
    "ฟิสิกส์": "physic",
    "ชีววิทยา": "biology",
    "IntroDent": "introdent",
    "IntroMed": "intromed",
    "วิชาการ": "all", // ฝ่ายวิชาการเข้าได้ทุกวิชา
    "coreteam": "all" // Core Team เข้าได้ทุกวิชา
};

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
        const savedJoinedRoom = localStorage.getItem('joined_room');
        if (savedJoinedRoom) {
            myRoom = savedJoinedRoom;
        }
        startRoomWatcher();
    }

    if (window.location.pathname.includes('tutor.html')) {
        initGlobalRoomStatusWatcher();
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
    const userDivision = user.division;

    try {
        const snapshot = await get(ref(db, `active_sessions/${room}`));
        const session = snapshot.val();

        if (session && session.isOpen) {
            const currentTutor = session.tutor || "ติวเตอร์";
            const sessionSubject = session.subject;

            // เช็คสิทธิ์: เป็น Admin หรือ อยู่ Division เดียวกับวิชาที่กำลังสอนอยู่หรือไม่
            const canJoinAsAssistant =
                user.role === 'Admin' ||
                DIV_TO_SUBJECT_MAP[userDivision] === "all" ||
                DIV_TO_SUBJECT_MAP[userDivision] === sessionSubject;

            if (canJoinAsAssistant) {
                // กรณีอยู่ฝ่ายเดียวกัน -> ให้เข้าร่วมได้เลย
                const result = await Swal.fire({
                    title: 'ห้องนี้กำลังมีการสอนอยู่',
                    html: `พี่ <b>${currentTutor}</b> กำลังสอนวิชา <b>${sessionSubject.toUpperCase()}</b><br><br>คุณอยู่ในฝ่ายเดียวกัน ต้องการเข้าร่วมเพื่อช่วยจัดการใช่หรือไม่?`,
                    icon: 'info',
                    showCancelButton: true,
                    confirmButtonColor: '#3b82f6',
                    confirmButtonText: 'เข้าร่วม (Assistant)',
                    cancelButtonText: 'ยกเลิก'
                });

                if (result.isConfirmed) {
                    // เข้าร่วมโดยไม่ต้องอัปเดต Firebase (ใช้ข้อมูลเดิมของห้อง)
                    currentRoom = room;
                    currentSubject = sessionSubject;
                    localStorage.setItem('active_tutor_room', room);

                    showUI(true);
                    await loadClassMetadata();
                    initTutorListeners();
                    showToast(`เข้าร่วมห้อง ${room} ในฐานะผู้ช่วยแล้ว`);
                }
                return;
            } else {
                // กรณีอยู่คนละฝ่าย -> ใช้ Logic เดิม (ขอ Takeover)
                const result = await Swal.fire({
                    title: 'ห้องเรียนไม่ว่าง!',
                    html: `พี่ <b>${currentTutor}</b> กำลังสอนวิชา <b>${sessionSubject.toUpperCase()}</b><br><br>ต้องการส่งสัญญาณให้ปิดห้องภายใน 30 วินาทีหรือไม่?`,
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonColor: '#ef4444',
                    confirmButtonText: 'ส่งสัญญาณแจ้งคืนห้อง',
                    cancelButtonText: 'ยกเลิก'
                });

                if (result.isConfirmed) {
                    await sendTakeoverRequest(room);
                }
                return;
            }
        }

        // --- กรณีห้องว่าง เปิดห้องใหม่ตามปกติ ---
        await set(ref(db, `active_sessions/${room}`), {
            isOpen: true,
            subject: subject,
            tutor: tutorName,
            division: userDivision, // เก็บ division ไว้ใน session ด้วย
            startTime: Date.now()
        });

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
    const interactionBar = document.getElementById('interaction-bar');
    const roomBadge = document.getElementById('room-badge');

    if (interactionBar) {
        interactionBar.classList.remove('hidden');
    }

    if (session && session.isOpen) {
        if (roomBadge) roomBadge.innerText = `${roomId.replace('_', ' ')} | ${session.subject.toUpperCase()}`;

        if (window.isInClass && interactionBar) {
            interactionBar.classList.remove('hidden');
        }
    } else {
        if (roomBadge) roomBadge.innerText = `${roomId.replace('_', ' ')} | WAITING...`;
        if (interactionBar) interactionBar.classList.add('hidden');
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

    onValue(ref(db, `active_sessions/${currentRoom}`), async (snapshot) => {
        const session = snapshot.val();

        // ถ้าห้องถูกลบไปแล้ว (session เป็น null) หรือสถานะกลายเป็นปิด
        if (!session || !session.isOpen) {

            // เช็คว่าเครื่องเรายังจำว่าอยู่ในห้องนี้ไหม (ถ้าติวเตอร์หลักเป็นคนปิด ค่านี้ในเครื่องติวเตอร์จะถูกลบไปก่อนแล้ว จะไม่เข้าเงื่อนไขนี้)
            if (localStorage.getItem('active_tutor_room') === currentRoom) {

                // ป้องกันการเด้ง Popup ซ้ำซ้อน
                if (window.isAlreadyKicked) return;
                window.isAlreadyKicked = true;

                // เคลียร์สถานะในเครื่อง Assistant
                localStorage.removeItem('active_tutor_room');
                currentRoom = null;
                currentSubject = null;

                // แจ้งเตือนและพากลับหน้าหลัก
                await Swal.fire({
                    icon: 'info',
                    title: 'ห้องเรียนถูกปิดแล้ว',
                    text: 'ติวเตอร์หลักได้ทำการปิดห้องและ Sync คะแนนเรียบร้อยแล้ว ระบบกำลังพากลับหน้าหลัก...',
                    timer: 3000,
                    showConfirmButton: false,
                    allowOutsideClick: false
                });

                window.location.href = '../index.html';
            }
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

    // 4. Listen Global Subject Quotas (มาจาก Admin กำหนด)
    onValue(ref(db, 'subject_quotas'), (snapshot) => {
        subjectQuotas = snapshot.val() || {};
        updateQuotaUI();
    });

    // 4.1 Listen การใช้ Quota ภายในคาบเรียนปัจจุบัน (คาบนี้แจกไปเท่าไหร่แล้ว)
    onValue(ref(db, `classroom_scores/${currentRoom}/quotaUsed`), (snapshot) => {
        quotaUsed = snapshot.val() || 0;
        updateQuotaUI();
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

    onValue(ref(db, `classroom_scores/${currentRoom}/live_scores`), (snapshot) => {
        const data = snapshot.val() || { studentScores: {}, houseScores: {} };
        // อัปเดตตัวแปรในเครื่องให้ตรงกับ Firebase
        scoresToSync.studentScores = data.studentScores || {};
        scoresToSync.houseScores = data.houseScores || {};
        renderSummaryTable(); // วาดตารางใหม่ทันทีที่ข้อมูลใน Firebase เปลี่ยน
    });

    // 8. Listen Private Questions: มีน้องส่งคำถามส่วนตัวมาหรือเปล่า (ถ้ามีให้แสดงในหน้าจอทันที)
    listenPrivateQuestions();
    listenSpeakRequests();
    listenForForceClose(currentRoom); // เริ่มฟังว่ามีใครมาขอให้ปิดห้องไหม (กรณีที่เราเปิดห้องทับคนอื่น)
}

// ฟังก์ชัน showUI ใช้สำหรับสลับการแสดงผลระหว่างหน้าจอ Setup (ก่อนเริ่มคาบ) กับหน้าจอ Controls (หลังเริ่มคาบ) 
function showUI(isStarted) {
    const setupCard = document.getElementById('setup-card');
    const tutorControls = document.getElementById('tutor-controls');
    const btnFinish = document.getElementById('btn-finish');
    const globalStatusCard = document.getElementById('room-status-container');

    // ถ้าเริ่ม Session แล้ว (isStarted = true) ให้ซ่อน Setup และโชว์ Controls
    if (setupCard) setupCard.classList.toggle('hidden', isStarted);
    if (tutorControls) tutorControls.classList.toggle('hidden', !isStarted);
    if (btnFinish) btnFinish.classList.toggle('hidden', !isStarted);
    if (globalStatusCard) {
        globalStatusCard.classList.toggle('hidden', isStarted);
    }

    if (isStarted && currentRoom && currentSubject) {
        document.getElementById('display-session-info').innerText = `${currentRoom} | ${currentSubject}`;
    }
}
// ค้นหาฟังก์ชัน updateQuotaUI ใน js/classroom-logic.js แล้ววางทับด้วยโค้ดนี้
function updateQuotaUI() {
    const barGlobal = document.getElementById('quota-bar-global');
    const barCurrent = document.getElementById('quota-bar-current');
    const label = document.getElementById('quota-subject-label');

    // Elements สำหรับตัวเลข
    const txtGlobal = document.getElementById('text-global-used');
    const txtCurrent = document.getElementById('text-current-session');
    const txtMax = document.getElementById('text-max-quota');
    const txtRem = document.getElementById('quota-remaining');
    const txtDisplayCurrent = document.getElementById('display-current-pts');

    if (!barGlobal || !barCurrent || !currentSubject) return;

    label.innerText = `โควต้าวิชา ${currentSubject.toUpperCase()}`;

    // 1. ดึงค่าจากข้อมูลส่วนกลาง
    const maxQuota = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].max : 0;
    const globalUsed = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].used : 0;

    // quotaUsed คือค่าคะแนนสะสมในตัวแปร Local (คาบนี้)
    const totalUsedNow = globalUsed + quotaUsed;
    const remaining = maxQuota - totalUsedNow;

    // 2. อัปเดตตัวเลข
    txtGlobal.innerText = globalUsed;
    txtCurrent.innerText = `(+${quotaUsed})`;
    txtMax.innerText = maxQuota;
    txtDisplayCurrent.innerText = `${quotaUsed} PTS`;
    txtRem.innerText = remaining >= 0 ? `เหลือแจกได้อีก: ${remaining} Pts` : `เกินโควต้า: ${Math.abs(remaining)} Pts!`;
    txtRem.className = remaining >= 0 ? "text-[9px] font-bold text-slate-400" : "text-[9px] font-black text-red-500 animate-pulse";

    // 3. คำนวณความกว้างแท่ง (Percentage)
    let globalPercent = (globalUsed / maxQuota) * 100;
    let currentPercent = (quotaUsed / maxQuota) * 100;

    // กัน Percent เกิน 100
    if (globalPercent > 100) globalPercent = 100;
    if (globalPercent + currentPercent > 100) currentPercent = 100 - globalPercent;

    // 4. สั่งเปลี่ยนสีแท่ง Current ตามสถานะความอันตราย
    const totalPercent = ((globalUsed + quotaUsed) / maxQuota) * 100;
    let statusClass = "bg-blue-500"; // ปกติเป็นสีฟ้า
    if (totalPercent > 90) statusClass = "bg-red-500";
    else if (totalPercent > 70) statusClass = "bg-amber-500";

    barGlobal.style.width = `${globalPercent}%`;
    barCurrent.style.width = `${currentPercent}%`;
    barCurrent.className = `h-full transition-all duration-500 ${statusClass}`;
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
        const indivData = scoresToSync.studentScores[s.id] || { score: 0, speakCount: 0 };
        const houseScore = scoresToSync.houseScores[s.house] || 0;
        const isOnline = onlineStudents[s.id];

        const isNewHouse = s.house !== lastHouse;
        lastHouse = s.house;

        html += `
            <tr class="${isOnline ? 'bg-white' : 'bg-slate-50 opacity-60'} hover:bg-slate-50 transition-colors">
                <!-- 1. House -->
                <td class="p-3 font-black text-blue-600 border-b align-middle">
                    ${isNewHouse ? `<div class="bg-blue-100 py-1 rounded-lg text-center">บ. ${s.house}</div>` : ''}
                </td>

                <!-- 2. House Pts (Action ใต้คะแนน) -->
                <td class="p-3 text-center border-b align-middle">
    ${isNewHouse ? `
        <div class="flex flex-col items-center gap-1">
            <span class="font-black text-orange-600 text-lg">${houseScore}</span>
            <div class="flex gap-1">
                <button onclick="giveHouseScore('${s.house}', 5)" class="text-[9px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded font-bold hover:bg-orange-600 hover:text-white">+5</button>
                <button onclick="giveHouseScore('${s.house}', -5)" class="text-[9px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded font-bold hover:bg-red-500 hover:text-white">-5</button>
                <button onclick="customScore('${s.house}', 'บ้าน ${s.house}', 'house')" class="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold hover:bg-slate-800 hover:text-white">✎</button>
            </div>
        </div>
    ` : '<span class="text-slate-200">-</span>'}
</td>

                <!-- 3. Student Info -->
                <td class="p-3 border-b align-middle">
                    <p class="font-bold text-slate-800 leading-none">${s.nickname}</p>
                    <p class="text-[9px] text-slate-400 font-mono">${s.id}</p>
                </td>

                <!-- 4. Responses Count -->
                <td class="p-3 text-center border-b align-middle">
                    <button onclick="viewHistory('${s.id}', '${s.nickname}')" class="bg-slate-100 hover:bg-blue-100 text-blue-600 px-3 py-1 rounded-full text-[11px] font-bold transition-all">
                        💬 ${history.length} ครั้ง
                    </button>
                </td>

                <!-- 5. Speak Count (โดนสุ่ม/เสนอตัว) -->
                <td class="p-3 text-center border-b align-middle">
    <div class="flex flex-col items-center gap-1">
        <!-- ตัวเลขแสดงจำนวนครั้ง -->
        <div class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-purple-50 text-purple-600 font-black border border-purple-100">
            ${indivData.speakCount || 0}
        </div>
        <!-- ปุ่ม +/- แบบย่อ -->
        <div class="flex gap-1">
            <button onclick="giveSpeakCount('${s.id}', '${s.nickname}', 1)" 
                class="text-[9px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded font-bold hover:bg-purple-600 hover:text-white transition-colors">
                +1
            </button>
            <button onclick="giveSpeakCount('${s.id}', '${s.nickname}', -1)" 
                class="text-[9px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded font-bold hover:bg-red-500 hover:text-white transition-colors">
                -1
            </button>
        </div>
    </div>
</td>

                <!-- 6. Indiv. Pts (Action ใต้คะแนน) -->
                <td class="p-3 text-center border-b align-middle">
                    <div class="flex flex-col items-center gap-1">
                        <span class="font-black text-blue-600 text-lg">${indivData.score}</span>
                        <div class="flex gap-1">
                            <button onclick="giveScore('${s.id}', '${s.nickname}', 5)" class="text-[9px] bg-green-100 text-green-600 px-1.5 py-0.5 rounded font-bold hover:bg-green-600 hover:text-white">+5</button>
                            <button onclick="giveScore('${s.id}', '${s.nickname}', -5)" class="text-[9px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded font-bold hover:bg-red-500 hover:text-white">-5</button>
                            <button onclick="customScore('${s.id}', '${s.nickname}', 'std')" class="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold hover:bg-slate-800 hover:text-white">✎</button>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}
function renderResponses(data) {
    const grid = document.getElementById('response-grid');
    if (!grid) return;

    let targetActivityId = selectedActivityFilter;
    if (selectedActivityFilter === 'current') {
        const keys = Object.keys(activityLog);
        targetActivityId = keys.length > 0 ? keys[keys.length - 1] : null;
    }

    const currentQ = activityLog[targetActivityId];
    if (!currentQ) {
        grid.innerHTML = `<div class="py-20 text-center text-slate-300 font-bold italic">ยังไม่มีกิจกรรมที่ถูกสร้าง</div>`;
        return;
    }

    // เตรียมสถานะ Badge
    const statusBadge = currentQ.status === 'open'
        ? `<span class="bg-emerald-500 text-white text-[10px] px-3 py-1 rounded-full animate-pulse font-black">● OPEN</span>`
        : `<span class="bg-red-500 text-white text-[10px] px-3 py-1 rounded-full font-black">● CLOSED</span>`;

    const entries = Object.entries(data || {});
    const filteredEntries = entries.filter(([key, res]) => res.activityID === targetActivityId).reverse();

    // ส่วนหัวของคำถามใน Live Feed
    let headerHTML = `
        <div class="col-span-full mb-6 bg-white p-5 rounded-3xl border-2 border-blue-50 shadow-sm">
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <p class="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">Current Question:</p>
                    <h3 class="text-2xl font-black text-slate-800 italic leading-tight">"${currentQ.question_title}"</h3>
                </div>
                <div class="ml-4">${statusBadge}</div>
            </div>
        </div>
    `;

    if (filteredEntries.length === 0) {
        grid.innerHTML = headerHTML + `<div class="py-10 text-center text-slate-300 font-bold italic">กำลังรอคำตอบแรก...</div>`;
    } else {
        grid.innerHTML = headerHTML + `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${filteredEntries.map(([key, res]) => `
                    <div class="response-card-tutor bg-white p-4 rounded-2xl shadow-sm border ${res.wantsToTalk ? 'border-yellow-400 bg-yellow-50' : 'border-slate-100'}">
                        <div class="flex items-center gap-2 mb-2">
                            <div class="w-7 h-7 bg-blue-600 text-white rounded-lg flex items-center justify-center font-black text-[10px]">${res.house}</div>
                            <span class="font-bold text-slate-800 text-sm truncate">${res.nickname}</span>
                            ${res.wantsToTalk ? '<span class="text-xs">🙋‍♂️</span>' : ''}
                        </div>
                        <div class="response-content text-slate-600 font-medium">${res.answer}</div>
                        <div class="mt-auto pt-3 flex justify-between items-center">
                            <span class="text-[9px] text-slate-400">${new Date(res.timestamp).toLocaleTimeString('th-TH')}</span>
                            <button onclick="giveScore('${res.studentID}', '${res.nickname}', 5)" class="bg-blue-50 text-blue-600 text-[10px] px-2 py-1 rounded-lg font-bold hover:bg-blue-600 hover:text-white transition-all">+5 PTS</button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
    }
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
function listenSpeakRequests() {
    if (!currentRoom) return;

    // ตรวจสอบก่อนว่าหน้านี้มีที่แสดงรายการไหม (ถ้าเป็นหน้าน้อง ตัวนี้จะเป็น null)
    const listEl = document.getElementById('speak-requests-list');
    const badge = document.getElementById('req-badge');

    if (!listEl) return; // ถ้าไม่มี Element นี้ ให้หยุดทำงาน (ป้องกัน Error)

    onValue(ref(db, `speak_requests/${currentRoom}`), (snapshot) => {
        const data = snapshot.val() || {};
        const keys = Object.keys(data);

        if (badge) {
            badge.innerText = keys.length;
            badge.classList.toggle('hidden', keys.length === 0);
        }

        if (keys.length === 0) {
            listEl.innerHTML = `<p class="text-center py-20 text-slate-400 italic">ไม่มีรายการรออนุมัติ</p>`;
            return;
        }

        listEl.innerHTML = keys.map(key => {
            const r = data[key];
            return `
                <div class="bg-white p-5 rounded-3xl border-2 border-purple-100 shadow-sm flex justify-between items-center animate-fade-in">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-purple-600 text-white rounded-2xl flex items-center justify-center font-black text-lg">
                            ${r.house}
                        </div>
                        <div>
                            <h4 class="font-bold text-slate-800">${r.nickname}</h4>
                            <p class="text-[10px] text-slate-400 uppercase font-black">ID: ${r.studentID} | รอยืนยันการพูด</p>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="approveSpeak('${r.studentID}', '${r.nickname}')" 
                            class="bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-emerald-600 shadow-md transition-all">
                            ยืนยัน
                        </button>
                        <button onclick="rejectSpeak('${r.studentID}')" 
                            class="bg-slate-100 text-slate-400 px-4 py-2 rounded-xl text-xs font-bold hover:bg-red-50 hover:text-red-500 transition-all">
                            ข้าม
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    });
}
function listenForForceClose(room) {
    // เปลี่ยนจากฟังแค่กิ่งย่อย forceCloseRequest เป็นฟัง "กิ่งหลักของห้อง"
    const sessionRef = ref(db, `active_sessions/${room}`);

    onValue(sessionRef, async (snapshot) => {
        const session = snapshot.val();
        if (!session) return;

        // --- [CASE 1: ADMIN FORCE CLOSE] ตรวจสอบ Flag จาก Admin ---
        // เช็คทั้ง adminForceClose หรือ forceCloseByAdmin ตามข้อมูลใน DB ของคุณ
        if (session.adminForceClose === true || session.forceCloseByAdmin === true) {

            // ป้องกันการเด้ง Popup ซ้ำซ้อน
            if (window.isAlreadyClosing) return;
            window.isAlreadyClosing = true;

            const adminName = session.adminName || "Admin";

            await Swal.fire({
                title: 'ถูกสั่งปิดโดย Admin',
                html: `พี่ <b>${adminName}</b> สั่งปิดห้องเรียนนี้<br>ระบบกำลังบันทึกคะแนนและออกจากห้อง...`,
                icon: 'error',
                timer: 3000,
                showConfirmButton: false,
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            // เรียกฟังก์ชันจบคลาส (isAuto = true)
            // ส่งค่า room เข้าไปด้วยเพื่อให้ชัวร์ว่าลบถูกห้อง
            window.finishSession(true, room);
            return;
        }

        // --- [CASE 2: TUTOR TAKEOVER] ระบบขอคืนห้องปกติ (พี่ปอนขอพี่บิว) ---
        const request = session.forceCloseRequest;
        if (request && request.status === 'pending') {
            const myName = checkAuth()?.nickname || checkAuth()?.fullName;
            // ถ้าคนขอเป็นคนเดียวกับคนล็อคอิน ไม่ต้องโชว์ (กันตัวเองขอตัวเอง)
            if (request.requestedBy === myName) return;

            let timerInterval;
            const result = await Swal.fire({
                title: 'มีคำขอคืนห้องเรียน!',
                html: `พี่ <b>${request.requestedBy}</b> รอสอนคาบถัดไป<br><br>ระบบจะปิดห้องอัตโนมัติในอีก <b><span></span></b> วินาที`,
                icon: 'warning',
                timer: 30000,
                timerProgressBar: true,
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                confirmButtonText: 'ปิดห้องและ Sync ทันที',
                cancelButtonText: 'ขอสอนต่อ (ปฏิเสธ)',
                didOpen: () => {
                    const b = Swal.getHtmlContainer().querySelector('span');
                    timerInterval = setInterval(() => { b.textContent = Math.ceil(Swal.getTimerLeft() / 1000); }, 100);
                },
                willClose: () => { clearInterval(timerInterval); }
            });

            if (result.isConfirmed || result.dismiss === Swal.DismissReason.timer) {
                window.finishSession(true, room);
            } else if (result.dismiss === Swal.DismissReason.cancel) {
                await update(ref(db, `active_sessions/${room}/forceCloseRequest`), { status: 'rejected' });
                showToast("ปฏิเสธคำขอแล้ว", "info");
            }
        }
    });
}

window.sendTakeoverRequest = async function (targetRoom) {
    const user = checkAuth();
    const tutorName = user?.nickname || user?.fullName || "พี่สตาฟ";

    const confirm = await Swal.fire({
        title: 'ส่งคำขอจองห้อง?',
        text: `ระบบจะส่งสัญญาณแจ้งเตือนให้พี่ติวเตอร์ในห้อง ${targetRoom.replace('_', ' ')} ทราบ`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'ส่งคำขอ',
        cancelButtonText: 'ยกเลิก'
    });

    if (!confirm.isConfirmed) return;

    try {
        await update(ref(db, `active_sessions/${targetRoom}/forceCloseRequest`), {
            requestedBy: tutorName,
            requestedAt: Date.now(),
            status: "pending"
        });
        showToast(`ส่งคำขอถึงห้อง ${targetRoom} แล้ว`);
    } catch (e) {
        showToast("ไม่สามารถส่งคำขอได้", "error");
    }
};

window.adminForceCloseRoom = async function (targetRoom) {
    const user = checkAuth();
    const confirm = await Swal.fire({
        title: 'ยืนยัน Force Close?',
        text: `สั่งปิดห้อง ${targetRoom} ทันทีโดยไม่รอการตอบกลับจากติวเตอร์`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'สั่งปิดห้อง!'
    });

    if (!confirm.isConfirmed) return;

    try {
        // อัปเดตข้อมูลให้ตรงกับโครงสร้างที่คุณต้องการ
        await update(ref(db, `active_sessions/${targetRoom}`), {
            adminForceClose: true,
            forceCloseByAdmin: true,
            adminName: user.nickname || user.fullName || "Admin",
            forceClosedAt: Date.now()
        });
        showToast("ส่งคำสั่ง Force Close แล้ว");
    } catch (e) {
        showToast("เกิดข้อผิดพลาด", "error");
    }
};

// Room Selector Logic: เมื่อครูเลือกห้องเรียนจาก Dropdown ในหน้าจอ Setup ระบบจะเริ่มฟังข้อมูลแบบเรียลไทม์จาก Firebase ว่าห้องนั้นมีสถานะเป็นอย่างไร (เปิด/ปิด, ใครเป็นติวเตอร์, มีคำขอปิดห้องไหม) และอัปเดต UI ตามข้อมูลที่ได้รับมา เช่น แสดงชื่อติวเตอร์ที่กำลังสอน, แสดงสถานะห้องเรียน, และถ้าเราส่งคำขอไปแล้วก็จะแสดงสถานะการรอคำตอบจากเจ้าของห้องด้วย
function initGlobalRoomStatusWatcher() {
    const statusContainer = document.getElementById('global-room-status');
    const rooms = ['Room_A', 'Room_B', 'Room_C', 'Room_D'];
    const user = checkAuth();
    const myName = user.nickname || user.fullName;
    const userDivision = user.division;
    const isAdmin = user.role === 'Admin';

    onValue(ref(db, `active_sessions`), (snapshot) => {
        const allSessions = snapshot.val() || {};
        let html = '';

        rooms.forEach(roomId => {
            const session = allSessions[roomId];
            const isLive = session && session.isOpen;

            let actionButtons = '';
            if (isLive) {
                // เช็คสิทธิ์: เป็นฝ่ายเดียวกัน หรือ Admin หรือไม่
                const canJoinAsAssistant =
                    isAdmin ||
                    DIV_TO_SUBJECT_MAP[userDivision] === "all" ||
                    DIV_TO_SUBJECT_MAP[userDivision] === session.subject;

                if (session.tutor === myName) {
                    // กรณีเราเป็นเจ้าของห้อง
                    actionButtons = `
                        <button onclick="finishSession(false, '${roomId}')" class="text-[9px] font-black bg-red-600 text-white px-2 py-1 rounded-lg hover:bg-red-700 transition-all shadow-sm">
                            ปิดห้องเรียน
                        </button>`;
                } else if (canJoinAsAssistant) {
                    // กรณีอยู่ฝ่ายเดียวกัน -> แสดงปุ่ม "ช่วยจัดการ"
                    actionButtons = `
                        <button onclick="joinAsAssistant('${roomId}')" class="text-[9px] font-black bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700 transition-all shadow-md">
                            ช่วยจัดการ
                        </button>`;
                } else {
                    // กรณีอยู่คนละฝ่าย -> แสดงปุ่ม "ขอคืนห้อง"
                    actionButtons = `
                        <button onclick="sendTakeoverRequest('${roomId}')" class="text-[9px] font-black bg-white border border-red-200 text-red-600 px-2 py-1 rounded-lg hover:bg-red-600 hover:text-white transition-all">
                            ขอจองต่อ
                        </button>`;
                }
            }

            html += `
                <div class="p-4 rounded-2xl border-2 transition-all ${isLive ? 'border-blue-100 bg-blue-50/30' : 'border-slate-100 bg-white'}">
                    <div class="flex justify-between items-start">
                        <div>
                            <div class="flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full ${isLive ? 'bg-blue-500 animate-ping' : 'bg-slate-300'}"></span>
                                <span class="text-xs font-black text-slate-800">${roomId.replace('_', ' ')}</span>
                            </div>
                            ${isLive ? `
                                <p class="text-sm font-bold text-slate-700 mt-1">${session.subject.toUpperCase()}</p>
                                <p class="text-[10px] text-slate-400 font-bold">BY: พี่ ${session.tutor}</p>
                            ` : `
                                <p class="text-[10px] text-slate-400 font-bold mt-1 uppercase italic">ว่าง (Available)</p>
                            `}
                        </div>
                        <div class="flex flex-col gap-1 items-end">
                            ${actionButtons}
                        </div>
                    </div>
                </div>
            `;
        });

        if (statusContainer) statusContainer.innerHTML = html;
    });
}

document.getElementById('select-room')?.addEventListener('change', (e) => {
    const selectedRoom = e.target.value;
    const statusDiv = document.getElementById('room-occupancy-status');
    const nameSpan = document.getElementById('occupant-name');
    const feedbackText = document.getElementById('request-feedback');

    if (!selectedRoom) return;

    // ฟังข้อมูลจาก Firebase
    onValue(ref(db, `active_sessions/${selectedRoom}`), (snapshot) => {
        const session = snapshot.val();

        if (session && session.isOpen) {
            statusDiv.classList.remove('hidden');
            nameSpan.innerText = session.tutor || "ติวเตอร์ท่านอื่น";

            // ตรวจสอบว่าเราเคยส่งคำขอไปแล้วหรือยัง และเขาตอบกลับว่าอะไร
            const request = session.forceCloseRequest;
            const myName = checkAuth()?.nickname || checkAuth()?.fullName;

            if (request && request.requestedBy === myName) {
                feedbackText.classList.remove('hidden');
                if (request.status === 'rejected') {
                    feedbackText.innerText = "⚠️ เจ้าของห้องแจ้งว่า: ขอเวลาอีกสักครู่ (ยังไม่พร้อมออก)";
                    feedbackText.className = "text-[10px] font-medium text-orange-600 mt-1 italic";
                } else {
                    feedbackText.innerText = "⏳ ส่งคำขอแล้ว... กำลังรอการตอบกลับ";
                    feedbackText.className = "text-[10px] font-medium text-blue-500 mt-1 italic";
                }
            } else {
                feedbackText.classList.add('hidden');
            }
        } else {
            statusDiv.classList.add('hidden');
            feedbackText.classList.add('hidden');
        }
    });
});

// Live board
window.openLiveBoard = function () {
    const room = document.getElementById('select-room').value || currentRoom;
    if (!room) return Swal.fire("แจ้งเตือน", "กรุณาเลือกหรือเปิดห้องเรียนก่อน", "warning");

    // เปิดหน้าใหม่แบบ New Tab
    window.open(`liveboard.html?room=${room}`, '_blank');
};

// ฟังก์ชันให้พี่สตาฟกดลบคำถามเมื่อตอบแล้ว
// ค้นหาหรือวางทับในไฟล์ js/classroom-logic.js
window.deleteQuestion = function (key) {
    if (!currentRoom) {
        showToast("ไม่พบข้อมูลห้องเรียน", "error");
        return;
    }

    Swal.fire({
        title: 'ยืนยันการลบ?',
        text: "คุณตอบคำถามส่วนตัวนี้เรียบร้อยแล้วใช่หรือไม่?",
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#22c55e',
        confirmButtonText: 'ใช่, ลบเลย',
        cancelButtonText: 'ยกเลิก'
    }).then((result) => {
        if (result.isConfirmed) {
            // ใช้ ref และ remove ที่ import มาจาก firebase/database ด้านบนของไฟล์
            const targetRef = ref(db, `private_questions/${currentRoom}/${key}`);

            remove(targetRef)
                .then(() => {
                    showToast("ลบคำถามเรียบร้อยแล้ว");
                })
                .catch((error) => {
                    console.error("Delete Question Error:", error);
                    showToast("เกิดข้อผิดพลาดในการลบ", "error");
                });
        }
    });
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
window.joinAsAssistant = async function (roomId) {
    try {
        const snapshot = await get(ref(db, `active_sessions/${roomId}`));
        const session = snapshot.val();

        if (!session || !session.isOpen) {
            showToast("ห้องนี้ถูกปิดไปแล้ว", "error");
            return;
        }

        const result = await Swal.fire({
            title: 'เข้าร่วมจัดการห้องเรียน?',
            html: `เข้าร่วมเพื่อช่วยพี่ <b>${session.tutor}</b><br>วิชา: <b>${session.subject.toUpperCase()}</b>`,
            icon: 'info',
            showCancelButton: true,
            confirmButtonColor: '#2563eb',
            confirmButtonText: 'เข้าร่วมเลย',
            cancelButtonText: 'ยกเลิก'
        });

        if (result.isConfirmed) {
            // บันทึกค่าลงสถานะเครื่อง
            currentRoom = roomId;
            currentSubject = session.subject;
            localStorage.setItem('active_tutor_room', roomId);

            // เริ่มการทำงานของ UI
            showUI(true);
            await loadClassMetadata();
            initTutorListeners();
            showToast(`เข้าร่วมห้อง ${roomId} เรียบร้อย`);
        }
    } catch (e) {
        console.error(e);
        showToast("เกิดข้อผิดพลาดในการเข้าร่วม", "error");
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
    const tabs = ['live', 'summary', 'questions', 'requests'];

    tabs.forEach(t => {
        const viewEl = document.getElementById(`view-${t}`);
        const btnEl = document.getElementById(`tab-${t}`);

        if (!viewEl || !btnEl) return; // ข้ามไปถ้าไม่มี Element ในหน้านี้

        if (t === tab) {
            // แสดงผล: ใช้ flex สำหรับหน้า Feed/Summary และ block สำหรับ Q&A/Requests
            viewEl.style.setProperty('display', (t === 'questions' || t === 'requests' ? 'block' : 'flex'), 'important');
            viewEl.classList.remove('hidden');

            // สไตล์ปุ่ม Active
            btnEl.classList.add('border-blue-600', 'text-blue-600');
            btnEl.classList.remove('border-transparent', 'text-slate-400');
        } else {
            // ซ่อน: บังคับ display none
            viewEl.style.setProperty('display', 'none', 'important');
            viewEl.classList.add('hidden');

            // สไตล์ปุ่ม Inactive
            btnEl.classList.remove('border-blue-600', 'text-blue-600');
            btnEl.classList.add('border-transparent', 'text-slate-400');
        }
    });
};
window.manualPick = function (id, name) {
    Swal.fire({
        title: `จัดการ: ${name}`,
        text: "เลือกดำเนินการสำหรับนักเรียนคนนี้",
        icon: 'info',
        showCancelButton: true,
        showDenyButton: true,
        confirmButtonText: 'เพิ่มสถิติการพูด (+1)',
        denyButtonText: 'ให้คะแนนโบนัส (+10)',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#8b5cf6', // ม่วง
        denyButtonColor: '#22c55e'    // เขียว
    }).then((result) => {
        if (result.isConfirmed) {
            // เพิ่มสถานะการพูด
            if (!scoresToSync.studentScores[id]) scoresToSync.studentScores[id] = { name: name, score: 0, speakCount: 0 };
            scoresToSync.studentScores[id].speakCount = (scoresToSync.studentScores[id].speakCount || 0) + 1;
            showToast(`${name}: บันทึกการพูดแล้ว`);
            renderSummaryTable();
        } else if (result.isDenied) {
            giveScore(id, name, 10);
        }
    });
}
window.updateActivity = async function (status) {
    const inputEl = document.getElementById('input-q-title');
    let title = inputEl.value.trim();

    if (status === 'open') {
        // 1. ถ้าไม่กรอกชื่อ ให้ตั้งเป็น "คำถามที่ n"
        if (!title) {
            const nextNum = Object.keys(activityLog).length + 1;
            title = `คำถามที่ ${nextNum}`;
        }

        const confirm = await Swal.fire({
            title: 'เริ่มกิจกรรมใหม่?',
            text: `หัวข้อ: ${title}`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'เริ่มเลย!',
            cancelButtonText: 'แก้ไขก่อน'
        });
        if (!confirm.isConfirmed) return;

        const activity_id = "act_" + Date.now();
        const activityData = {
            activity_id,
            question_title: title,
            status: 'open',
            timestamp: Date.now()
        };

        try {
            // 2. อัปเดตข้อมูลลง Firebase
            await update(ref(db, `active_sessions/${currentRoom}/current_activity`), activityData);
            await set(ref(db, `active_sessions/${currentRoom}/activities_history/${activity_id}`), activityData);

            // 3. [สำคัญ] อัปเดตสถานะในเครื่องให้มาดู "คำถามปัจจุบัน"
            selectedActivityFilter = 'current';
            activityLog[activity_id] = activityData; // เพิ่มลง log ในเครื่องทันที

            // 4. สั่งวาด UI ใหม่ทันที
            renderActivityFilter(); // อัปเดต Dropdown
            renderResponses({});    // สั่งวาด Feed (ส่ง {} เพื่อให้วาด Header รอไว้)

            // 5. สลับไปหน้า Live Feed (กรณีติวเตอร์อยู่ที่หน้าอื่น)
            window.switchTab('live');

            inputEl.value = ""; // ล้างช่องกรอก
            showToast(`เปิดรับคำตอบ: ${title}`);
        } catch (e) {
            showToast("เกิดข้อผิดพลาด", "error");
        }
    }
    else {
        // กรณี "ปิดรับคำตอบ"
        const keys = Object.keys(activityLog);
        if (keys.length === 0) return;

        const lastId = keys[keys.length - 1];
        try {
            await update(ref(db, `active_sessions/${currentRoom}/current_activity`), { status: 'closed' });
            await update(ref(db, `active_sessions/${currentRoom}/activities_history/${lastId}`), { status: 'closed' });

            // อัปเดตค่าในเครื่องและวาดใหม่เพื่อให้ขึ้นป้ายสีแดง (CLOSED)
            activityLog[lastId].status = 'closed';
            // ดึงข้อมูลคำตอบล่าสุดมาวาดใหม่ (เพื่อให้ป้ายสถานะเปลี่ยน)
            get(ref(db, `responses/${currentRoom}`)).then(snap => renderResponses(snap.val() || {}));

            showToast("ปิดรับคำตอบแล้ว", "info");
        } catch (e) {
            showToast("เกิดข้อผิดพลาด", "error");
        }
    }
};
window.approveSpeak = async function (stdID, nickname) {
    const currentData = scoresToSync.studentScores[stdID] || { score: 0, speakCount: 0 };

    // อัปเดตขึ้น Firebase โดยตรง ข้อมูลจะ Sync ไปทุกเครื่องเอง
    await update(ref(db, `classroom_scores/${currentRoom}/live_scores/studentScores/${stdID}`), {
        name: nickname,
        score: currentData.score || 0,
        speakCount: (currentData.speakCount || 0) + 1
    });

    await remove(ref(db, `speak_requests/${currentRoom}/${stdID}`));
    showToast(`ยืนยันการพูดให้ ${nickname}`);
};

window.rejectSpeak = async function (stdID) {
    await remove(ref(db, `speak_requests/${currentRoom}/${stdID}`));
    showToast("ยกเลิกรายการ", "info");
};

// อัปเดตฟังก์ชัน switchTab ใน classroom-logic.js เพื่อให้รองรับ tab 'requests'
window.switchTab = function (tab) {
    const tabs = ['live', 'summary', 'questions', 'requests'];
    tabs.forEach(t => {
        const viewEl = document.getElementById(`view-${t}`);
        const btnEl = document.getElementById(`tab-${t}`);
        if (!viewEl || !btnEl) return;

        if (t === tab) {
            viewEl.style.setProperty('display', (t === 'questions' || t === 'requests' ? 'block' : 'flex'), 'important');
            viewEl.classList.remove('hidden');
            btnEl.classList.add('border-blue-600', 'text-blue-600');
            btnEl.classList.remove('border-transparent', 'text-slate-400');
        } else {
            viewEl.style.setProperty('display', 'none', 'important');
            viewEl.classList.add('hidden');
            btnEl.classList.remove('border-blue-600', 'text-blue-600');
            btnEl.classList.add('border-transparent', 'text-slate-400');
        }
    });
};
window.runRandom = async function (mode) {
    let list = allStudentsInClass;

    // กรองเฉพาะคนที่เป็น Volunteer (ถ้าเลือกโหมด volunteer)
    if (mode === 'volunteer') {
        list = allStudentsInClass.filter(s => responsesHistory[s.id]?.some(h => h.wantsToTalk));
    }

    if (list.length === 0) return showToast("ไม่มีรายชื่อให้สุ่ม", "error");

    const slotList = document.getElementById('slot-list');
    // สุ่มผู้ชนะไว้ล่วงหน้าเพื่อเตรียมข้อมูลสถิติ
    const winner = list[Math.floor(Math.random() * list.length)];
    const responseCount = (responsesHistory[winner.id] || []).length;

    try {
        // --- [1] เริ่มการ Roll บน Firebase (เพื่อให้ Liveboard แสดงผล) ---
        await set(ref(db, `active_sessions/${currentRoom}/randomizer`), {
            status: 'rolling',
            pool: list,
            ts: Date.now()
        });

        // --- [2] เริ่มการ Roll บนหน้า Tutor (Local UI) ---
        let tutorRollInterval = setInterval(() => {
            const randomPerson = list[Math.floor(Math.random() * list.length)];
            slotList.innerHTML = `<div class="slot-item animate-pulse text-blue-600">${randomPerson.nickname}</div>`;
        }, 80);

        // --- [3] หน่วงเวลาลุ้น (3.5 วินาที) ---
        setTimeout(async () => {
            clearInterval(tutorRollInterval);

            // แสดงชื่อผู้ชนะบนหน้า Tutor
            slotList.innerHTML = `<div class="slot-item text-yellow-500 font-black scale-110 transition-transform">${winner.nickname}</div>`;

            // ส่งคำสั่งหยุดไปที่หน้า Liveboard (Firebase)
            await update(ref(db, `active_sessions/${currentRoom}/randomizer`), {
                status: 'winner',
                winner: winner
            });

            // --- [4] แสดง Popup ผลลัพธ์พร้อม Highlight สถิติ ---
            Swal.fire({
                title: '🎉 ผู้โชคดี!',
                html: `น้อง <b>${winner.nickname}</b> (บ้าน ${winner.house})`,
                icon: 'success',
                showCancelButton: true,
                confirmButtonText: 'นับการตอบ (+1)',
                cancelButtonText: 'ปิดหน้าจอ',
                confirmButtonColor: '#22c55e'
            }).then(async (res) => {
                if (res.isConfirmed) {
                    // เพิ่มจำนวนการพูดอัตโนมัติ
                    if (!scoresToSync.studentScores[winner.id]) scoresToSync.studentScores[winner.id] = { name: winner.nickname, score: 0, speakCount: 0 };
                    scoresToSync.studentScores[winner.id].speakCount = (scoresToSync.studentScores[winner.id].speakCount || 0) + 1;
                }
                await set(ref(db, `active_sessions/${currentRoom}/randomizer`), { status: 'idle' });
                slotList.innerHTML = `<div class="slot-item">READY TO ROLL</div>`;
                renderSummaryTable(); // อัปเดตตาราง
            });

        }, 3500);

    } catch (e) {
        console.error(e);
        showToast("เกิดข้อผิดพลาดในการสุ่ม", "error");
    }
};

window.finishSession = async function (isAuto = false, roomOverride = null) {
    // 1. ระบุห้องที่ต้องการปิด
    const roomToClear = roomOverride || currentRoom || localStorage.getItem('active_tutor_room');

    if (!roomToClear) {
        console.error("FinishSession Error: No room identifier found.");
        return;
    }

    // --- [ส่วนที่เพิ่มใหม่: ตรวจสอบสิทธิ์ Assistant] ---
    const user = checkAuth();
    const myName = user.nickname || user.fullName;
    const isAdmin = user.role === 'Admin';

    // ดึงข้อมูลจาก Firebase เพื่อเช็คว่าใครเป็นคนเปิดห้อง (Main Tutor)
    const sessionSnap = await get(ref(db, `active_sessions/${roomToClear}`));
    const sessionData = sessionSnap.val();

    // ตรวจสอบว่าเป็นเจ้าของห้องตัวจริงหรือไม่
    const isMainTutor = sessionData && (sessionData.tutor === myName);

    // ถ้าไม่ใช่เจ้าของห้อง, ไม่ใช่ Admin และไม่ใช่การสั่งปิดจากระบบ (isAuto)
    if (!isMainTutor && !isAdmin && !isAuto) {
        const result = await Swal.fire({
            title: 'ออกจากหน้าจัดการ?',
            text: `คุณเข้าร่วมในฐานะผู้ช่วย การกดปุ่มนี้จะเพียงแค่พาคุณกลับหน้าหลัก โดยห้องเรียนของพี่ ${sessionData?.tutor || 'ท่านอื่น'} จะยังเปิดอยู่`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#3b82f6',
            confirmButtonText: 'กลับหน้าหลัก',
            cancelButtonText: 'อยู่ช่วยต่อ'
        });

        if (result.isConfirmed) {
            localStorage.removeItem('active_tutor_room');
            currentRoom = null;
            currentSubject = null;
            window.location.href = '../index.html';
        }
        return; // หยุดการทำงาน ไม่ให้ไปถึงส่วน Sync และลบข้อมูลด้านล่าง
    }
    // --- [จบส่วนตรวจสอบสิทธิ์] ---


    // 2. จัดการเรื่องการกดยืนยัน (สำหรับเจ้าของห้อง หรือ Admin)
    if (window.isClosingProcessActive) return;

    if (!isAuto) {
        const result = await Swal.fire({
            title: 'สิ้นสุดคาบเรียน?',
            text: "ระบบจะทำการ Sync คะแนนเข้าสู่ Google Sheet และปิดห้องเรียนถาวร",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#22c55e',
            confirmButtonText: 'บันทึกและจบคลาส',
            cancelButtonText: 'ยกเลิก'
        });

        if (!result.isConfirmed) return;
    }

    // เริ่มขั้นตอนการปิด
    window.isClosingProcessActive = true;

    // 3. แสดงสถานะกำลังดำเนินการ
    Swal.fire({
        title: isAuto ? 'กำลังจบคลาสอัตโนมัติ...' : 'กำลังซิงค์ข้อมูล...',
        text: 'กรุณารอสักครู่ ระบบกำลังนำส่งข้อมูลเข้า Google Sheets',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try {
        // 4. เตรียมข้อมูลสำหรับ Sync (บันทึกเฉพาะคนที่มีส่วนร่วม)
        const studentScoresCleaned = {};
        allStudentsInClass.forEach(s => {
            const id = s.id;
            const scoreData = scoresToSync.studentScores[id] || { score: 0, speakCount: 0 };
            const respCount = responsesHistory[id] ? responsesHistory[id].length : 0;

            if (scoreData.score > 0 || scoreData.speakCount > 0 || respCount > 0) {
                studentScoresCleaned[id] = {
                    name: s.nickname,
                    house: s.house,
                    score: scoreData.score,
                    speakCount: scoreData.speakCount,
                    responseCount: respCount
                };
            }
        });

        const houseScoresCleaned = {};
        for (let hID in scoresToSync.houseScores) {
            if (scoresToSync.houseScores[hID] > 0) {
                houseScoresCleaned[hID] = scoresToSync.houseScores[hID];
            }
        }

        // 5. ส่งข้อมูลไปยัง Google Apps Script (Background Sync)
        const syncPayload = {
            action: "syncClassroomScore",
            key: CONFIG.syncKey,
            room: roomToClear,
            subject: currentSubject || "N/A",
            tutor: sessionData?.tutor || myName, // ใช้ชื่อเจ้าของห้องในการบันทึก
            studentScores: studentScoresCleaned,
            houseScores: houseScoresCleaned || {}
        };

        fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(syncPayload)
        });

        // 6. ล้างข้อมูลใน Firebase
        await Promise.all([
            remove(ref(db, `active_sessions/${roomToClear}`)),
            remove(ref(db, `presence/${roomToClear}`)),
            remove(ref(db, `responses/${roomToClear}`)),
            remove(ref(db, `classroom_scores/${roomToClear}`)),
            remove(ref(db, `private_questions/${roomToClear}`)),
            remove(ref(db, `speak_requests/${roomToClear}`)) // เพิ่มการลบคำขอพูดด้วย
        ]);

        // 7. เคลียร์สถานะในเครื่อง
        localStorage.removeItem('active_tutor_room');
        currentRoom = null;
        currentSubject = null;
        window.isClosingProcessActive = false;

        // 8. แจ้งเตือนสำเร็จ
        await Swal.fire({
            icon: 'success',
            title: isAuto ? 'ห้องเรียนถูกปิดโดย Admin' : 'จบคลาสสำเร็จ!',
            text: 'คะแนนถูกส่งเข้าสู่คลังข้อมูลกลางเรียบร้อยแล้ว',
            timer: 2000,
            showConfirmButton: false
        });

        // 9. กลับหน้าหลัก
        window.location.href = '../index.html';

    } catch (e) {
        console.error("Finish Session Error:", e);
        window.isClosingProcessActive = false;
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
        localStorage.setItem('joined_room', myRoom);
        window.isInClass = true;
        const myPresenceRef = ref(db, `presence/${myRoom}/${currentUser.id}`);
        await set(myPresenceRef, {
            fullName: currentUser.fullName,
            nickname: currentUser.nickname,
            house: currentUser.house,
            joinedAt: new Date().toISOString(),
            status: "online"
        });

        onDisconnect(myPresenceRef).remove();

        // ตั้งค่าสถานะการเข้าเรียน
        window.isInClass = true;
        localStorage.setItem('joined_room', myRoom);
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
window.initStudentListener = function () {
    if (!myRoom) return;
    const session = JSON.parse(localStorage.getItem("userSession"));
    if (session) {
        const speakRef = ref(window.db, `speak_requests/${myRoom}/${session.id}`);
        const requestKey = `speak_req_sent_${myRoom}_${session.id}`;

        onValue(speakRef, (snapshot) => {
            if (!snapshot.exists()) {
                // ถ้าใน Firebase ไม่มีข้อมูลค้างอยู่ แปลว่าพี่ติวเตอร์จัดการเสร็จแล้ว
                localStorage.removeItem(requestKey);
            }
        });
    }
    onValue(ref(db, `active_sessions/${myRoom}/current_activity`), (snapshot) => {
        const activity = snapshot.val();

        if (!activity) {
            document.getElementById('response-form').classList.add('hidden');
            document.getElementById('closed-state').classList.remove('hidden');
            document.getElementById('closed-state').innerHTML = `<p class="text-slate-400 font-bold italic">ขณะนี้ไม่มีกิจกรรมการเรียนการสอน</p>`;
            return;
        }

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
    const answerEl = document.getElementById('input-answer');
    const answer = answerEl.value.trim();
    const checkTalkEl = document.getElementById('check-talk');
    const wantsToTalk = checkTalkEl ? checkTalkEl.checked : false;

    if (!answer) return showToast("กรุณาพิมพ์คำตอบ", "error");

    try {
        // 1. ส่งข้อมูลเข้า Firebase
        await push(ref(db, `responses/${myRoom}`), {
            activityID: currentActivityId,
            studentID: userSession.id,
            nickname: userSession.nickname,
            house: userSession.house,
            answer: answer,
            wantsToTalk: wantsToTalk,
            timestamp: Date.now()
        });

        // 2. ถ้าส่งสำเร็จ ให้แสดงแจ้งเตือนเขียว
        showToast("ส่งคำตอบแล้ว! สามารถตอบเพิ่มได้", "success");

        // 3. เคลียร์ค่าในช่องพิมพ์
        if (answerEl) answerEl.value = "";
        if (checkTalkEl) checkTalkEl.checked = false;

    } catch (e) {
        // 👉 บรรทัดนี้จะช่วยพ่น Error จริงๆ ออกมาดูที่หน้าต่าง Console
        console.error("เกิดข้อผิดพลาดหลังส่งคำตอบ:", e);
        showToast("ส่งคำตอบไม่สำเร็จ", "error");
    }
};

window.sendSpeakRequest = async function () {
    const session = JSON.parse(localStorage.getItem("userSession"));
    const room = myRoom || localStorage.getItem('joined_room');

    if (!session || !room) return showToast("ไม่พบข้อมูลห้องเรียน", "error");

    const requestKey = `speak_req_sent_${room}_${session.id}`;

    // ตรวจสอบว่าโดนล็อคอยู่ไหม
    if (localStorage.getItem(requestKey)) {
        return showToast("ส่งคำขอไปแล้ว กรุณารอพี่ติวเตอร์อนุมัติ", "info");
    }

    try {
        const { ref, set, onValue } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js");

        const speakRef = ref(window.db, `speak_requests/${room}/${session.id}`);

        // 1. ส่งข้อมูลขึ้น Firebase
        await set(speakRef, {
            studentID: session.id,
            nickname: session.nickname,
            house: session.house,
            timestamp: Date.now(),
            status: "pending"
        });

        // 2. ล็อคปุ่มในเครื่องน้อง
        localStorage.setItem(requestKey, "true");
        showToast("ส่งคำขอเรียบร้อย!", "success");

        // 3. [ส่วนสำคัญ] ดักฟังว่าถ้าข้อมูลหายไป (ติวเตอร์ Approve) ให้ปลดล็อค
        onValue(speakRef, (snapshot) => {
            if (!snapshot.exists()) {
                // เมื่อข้อมูลใน Firebase ถูกลบ (Tutor กดยืนยัน) -> ปลดล็อค localStorage
                localStorage.removeItem(requestKey);
            }
        });

    } catch (e) {
        showToast("ผิดพลาด: " + e.message, "error");
    }
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
let stagedChanges = {};

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
    const maxQuota = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].max : 0;
    const globalUsed = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].used : 0;

    if (pts > 0 && (globalUsed + quotaUsed + pts) > maxQuota) {
        return Swal.fire("โควต้าเต็ม", `เหลือโควต้าแค่ ${maxQuota - (globalUsed + quotaUsed)} คะแนน`, "warning");
    }

    // ดึงค่าปัจจุบันจากตัวแปรที่ Sync กับ Firebase แล้ว
    const currentData = scoresToSync.studentScores[id] || { score: 0, speakCount: 0 };
    let newScore = currentData.score + pts;
    if (newScore < 0) newScore = 0;

    const actualDiff = newScore - currentData.score;

    // อัปเดตขึ้น Firebase กิ่งรายละเอียดคะแนน
    await update(ref(db, `classroom_scores/${currentRoom}/live_scores/studentScores/${id}`), {
        name: name,
        score: newScore,
        speakCount: currentData.speakCount || 0
    });

    // อัปเดตโควต้ารวม (เพื่อให้แท่ง Quota ขยับทุกเครื่อง)
    await update(ref(db, `classroom_scores/${currentRoom}`), {
        quotaUsed: quotaUsed + actualDiff
    });

    showToast(`${name}: ${newScore} คะแนน`);
};

window.giveHouseScore = async function (house, pts) {
    const maxQuota = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].max : 0;
    const globalUsed = subjectQuotas[currentSubject] ? subjectQuotas[currentSubject].used : 0;

    if (pts > 0 && (globalUsed + quotaUsed + pts) > maxQuota) {
        return Swal.fire("โควต้าเต็ม", "โควต้าไม่เพียงพอ", "warning");
    }

    const currentHouseScore = scoresToSync.houseScores[house] || 0;
    let newScore = currentHouseScore + pts;
    if (newScore < 0) newScore = 0;

    const actualDiff = newScore - currentHouseScore;

    // อัปเดตคะแนนบ้านรายหลังขึ้น Firebase
    await set(ref(db, `classroom_scores/${currentRoom}/live_scores/houseScores/${house}`), newScore);

    // อัปเดตโควต้ารวม
    await update(ref(db, `classroom_scores/${currentRoom}`), {
        quotaUsed: quotaUsed + actualDiff
    });

    showToast(`บ้าน ${house}: ${newScore} คะแนน`);
};

window.giveSpeakCount = async function (id, name, val) {
    const currentData = scoresToSync.studentScores[id] || { score: 0, speakCount: 0 };
    let nextSpeak = (currentData.speakCount || 0) + val;
    if (nextSpeak < 0) nextSpeak = 0;

    // อัปเดตขึ้น Firebase
    await update(ref(db, `classroom_scores/${currentRoom}/live_scores/studentScores/${id}`), {
        name: name,
        score: currentData.score || 0,
        speakCount: nextSpeak
    });
    showToast(`${name}: สถิติการพูด ${nextSpeak} ครั้ง`);
};

window.openHistoryEditor = async function () {
    const user = checkAuth();
    const subject = document.getElementById('select-subject').value;
    stagedChanges = {}; // Reset ทุกครั้งที่เปิด

    Swal.fire({ title: 'กำลังโหลดประวัติ...', didOpen: () => Swal.showLoading() });

    try {
        const stdSnapshot = await get(ref(db, `students`));
        const allStudentsArray = Object.keys(stdSnapshot.val() || {}).map(id => ({ id: id.toString(), ...stdSnapshot.val()[id] }));
        const resp = await fetch(CONFIG.appscriptUrl, { method: 'POST', body: JSON.stringify({ action: 'getPastSessionScores', key: CONFIG.syncKey, subject: subject, tutor: user.nickname, division: user.division, role: user.role }) });
        const resData = await resp.json();
        const sessions = resData.data;

        if (!sessions) return Swal.fire('ไม่พบข้อมูล', '', 'info');

        let html = `
            <div class="max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar space-y-6" id="history-container">`;

        Object.entries(sessions).reverse().forEach(([sessionId, session]) => {
            const info = session.info;
            const logRoomLetter = info.room.replace('Room_', '');
            const fullList = allStudentsArray.filter(std => std.classID === logRoomLetter).map(std => {
                const logEntry = session.data.find(d => String(d.targetId) === String(std.id));
                return logEntry || { targetId: std.id, targetName: std.nickname, house: std.house, score: 0, speakCount: 0, responseCount: 0, rowNumber: -1 };
            });
            fullList.sort((a, b) => a.house - b.house);

            html += `
                <div class="bg-white rounded-[1.5rem] border-2 border-slate-100 overflow-hidden shadow-sm mb-4">
                    <div class="bg-slate-800 p-3 text-white flex justify-between items-center">
                        <div class="text-left">
                            <p class="text-[8px] font-bold text-slate-400 uppercase">คาบเรียนวันที่ ${new Date(info.timestamp).toLocaleDateString('th-TH')}</p>
                            <h4 class="font-black text-[11px] text-blue-400">Tutor: ${info.tutor}</h4>
                        </div>
                        <span class="bg-blue-600 px-2 py-0.5 rounded-lg text-[10px] font-black">${info.room}</span>
                    </div>
                    <table class="w-full text-left text-[10px]">
                        <thead class="bg-slate-50 border-b text-slate-500 font-bold uppercase">
                            <tr class="text-center">
                                <th class="p-2 w-8">บ.</th>
                                <th class="p-2 text-left">ชื่อ</th>
                                <th class="p-2">Score</th><th class="p-2">Speak</th><th class="p-2">Resp</th><th class="p-2 w-10"></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${fullList.map(row => {
                const houseClass = HOUSE_THEMES[row.house] || 'bg-slate-50';
                return `
                                <tr class="border-b ${houseClass}" id="row-${sessionId}-${row.targetId}">
                                    <td class="p-2 text-center font-black">${row.house}</td>
                                    <td class="p-2 font-bold text-slate-700 std-nickname">${row.targetName}</td>
                                    <td class="p-2 text-center font-black" id="v-score-${sessionId}-${row.targetId}">${row.score}</td>
                                    <td class="p-2 text-center font-bold" id="v-speak-${sessionId}-${row.targetId}">${row.speakCount}</td>
                                    <td class="p-2 text-center font-bold opacity-60" id="v-resp-${sessionId}-${row.targetId}">${row.responseCount}</td>
                                    <td class="p-2 text-right" id="action-${sessionId}-${row.targetId}">
                                        <button onclick="startHistoryEdit('${sessionId}', '${row.targetId}', ${row.score}, ${row.speakCount}, ${row.responseCount}, ${row.rowNumber})" 
                                            class="bg-white/60 p-2 rounded-lg shadow-sm border border-black/5 hover:bg-white transition-all">✎</button>
                                    </td>
                                </tr>`;
            }).join('')}
                        </tbody>
                    </table>
                </div>`;
        });

        html += `</div>
            <!-- ปุ่มบันทึกลอย (Footer ของ Modal) -->
            <div class="mt-4 p-4 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 flex justify-between items-center">
                <div class="text-left">
                    <p class="text-[10px] font-bold text-slate-400 uppercase">แถวที่รอการบันทึก</p>
                    <p id="staged-count" class="text-lg font-black text-slate-700">0 รายการ</p>
                </div>
                <button onclick="saveAllHistoryChanges()" id="btn-save-bulk" disabled
                    class="bg-slate-300 text-white px-10 py-3 rounded-xl font-black shadow-lg transition-all flex items-center gap-2">
                    💾 บันทึกข้อมูลทั้งหมด
                </button>
            </div>
        `;

        Swal.fire({
            title: `จัดการคะแนน: ${subject.toUpperCase()}`,
            html: html,
            width: '850px',
            showConfirmButton: false,
            showCloseButton: true,
            allowOutsideClick: false
        });

    } catch (e) { console.error(e); }
};

// 2. ฟังก์ชันเริ่มแก้ไข (ถอดปุ่ม ✅ ออก)
window.startHistoryEdit = function (sessionId, stdId, score, speak, resp, rowNumber) {
    const fields = ['score', 'speak', 'resp'];
    const values = [score, speak, resp];

    fields.forEach((f, i) => {
        const inputId = `i-${f}-${sessionId}-${stdId}`;
        document.getElementById(`v-${f}-${sessionId}-${stdId}`).innerHTML =
            `<input type="number" id="${inputId}" 
                oninput="stageDataChange('${sessionId}', '${stdId}', ${rowNumber})"
                class="w-14 p-1 text-center border-2 border-blue-500 rounded-lg font-black text-xs" 
                value="${values[i]}">`;
    });

    // ปุ่มเปลี่ยนเป็นยกเลิก (✕) อย่างเดียว เพราะจะบันทึกรวมด้านล่าง
    document.getElementById(`action-${sessionId}-${stdId}`).innerHTML = `
        <button onclick="cancelHistoryEdit('${sessionId}', '${stdId}', ${score}, ${speak}, ${resp}, ${rowNumber})" 
            class="bg-red-50 text-red-500 w-10 h-10 rounded-lg flex items-center justify-center text-lg">✕</button>
    `;
};

window.stageDataChange = function (sessionId, stdId, rowNumber) {
    const nScore = document.getElementById(`i-score-${sessionId}-${stdId}`).value;
    const nSpeak = document.getElementById(`i-speak-${sessionId}-${stdId}`).value;
    const nResp = document.getElementById(`i-resp-${sessionId}-${stdId}`).value;

    const user = checkAuth();
    const subject = document.getElementById('select-subject').value;
    const rowEl = document.getElementById(`row-${sessionId}-${stdId}`);

    // --- จุดที่แก้ไข: ดึงข้อมูลจากคลาส std-nickname และ td ช่องแรก ---
    const nickname = rowEl.querySelector('.std-nickname').innerText.trim();
    const house = rowEl.cells[0].innerText.replace('บ.', '').trim();

    stagedChanges[`${sessionId}-${stdId}`] = {
        rowNumber: rowNumber,
        newScore: nScore,
        newSpeak: nSpeak,
        newResp: nResp,
        student: {
            id: stdId,
            nickname: nickname, // ดึงชื่อที่ถูกต้องมาแล้ว
            house: house
        },
        sessionInfo: {
            room: rowEl.closest('.bg-white').querySelector('.bg-blue-600').innerText,
            timestamp: sessionId.split('_')[1],
            subject: subject,
            tutor: user.nickname || user.fullName
        }
    };

    // อัปเดต UI ปุ่มบันทึกด้านล่าง (คงเดิม)
    const count = Object.keys(stagedChanges).length;
    const stagedCountEl = document.getElementById('staged-count');
    if (stagedCountEl) stagedCountEl.innerText = `${count} รายการ`;

    const btn = document.getElementById('btn-save-bulk');
    if (btn && count > 0) {
        btn.disabled = false;
        btn.className = "bg-blue-600 text-white px-10 py-3 rounded-xl font-black shadow-lg shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all cursor-pointer";
    }
};

window.saveAllHistoryChanges = async function () {
    const updates = Object.values(stagedChanges);
    if (updates.length === 0) return;

    const btn = document.getElementById('btn-save-bulk');
    btn.disabled = true;
    btn.innerText = "⏳ กำลังบันทึก...";

    try {
        await fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify({
                action: 'bulkEditPastSessionScores',
                key: CONFIG.syncKey,
                updates: updates
            })
        });

        // แสดงความสำเร็จแล้วปิด Modal หรือโหลดข้อมูลใหม่
        await Swal.fire({
            icon: 'success',
            title: 'บันทึกข้อมูลทั้งหมดแล้ว',
            text: `อัปเดตเรียบร้อยจำนวน ${updates.length} รายการ`,
            timer: 2000,
            showConfirmButton: false
        });

        // โหลด Modal ใหม่เพื่อแสดงข้อมูลล่าสุดที่บันทึกแล้ว
        window.openHistoryEditor();

    } catch (e) {
        showToast("เกิดข้อผิดพลาดในการบันทึกรวม", "error");
        btn.disabled = false;
        btn.innerText = "💾 บันทึกข้อมูลทั้งหมด";
    }
};

// บันทึกแบบ Background และแสดง Toast แทนการใช้ Swal.fire ปกติ
window.saveHistoryEdit = async function (sessionId, stdId, rowNumber) {
    const nScore = document.getElementById(`i-score-${sessionId}-${stdId}`).value;
    const nSpeak = document.getElementById(`i-speak-${sessionId}-${stdId}`).value;
    const nResp = document.getElementById(`i-resp-${sessionId}-${stdId}`).value;

    const actionArea = document.getElementById(`action-${sessionId}-${stdId}`);
    const user = checkAuth();

    // ดึงข้อมูลจากแถว
    const rowEl = document.getElementById(`row-${sessionId}-${stdId}`);
    const nickname = rowEl.querySelector('p.font-bold').innerText;
    const house = rowEl.cells[0].innerText.replace('บ.', '').trim();

    actionArea.innerHTML = `<div class="w-12 h-12 flex items-center justify-center animate-pulse text-orange-500">...</div>`;

    try {
        const subject = document.getElementById('select-subject').value;
        const container = rowEl.closest('.bg-white');
        const sessionRoom = container.querySelector('.bg-blue-600').innerText;

        const payload = {
            action: 'editPastSessionScore',
            key: CONFIG.syncKey,
            rowNumber: rowNumber,
            newScore: nScore, newSpeak: nSpeak, newResp: nResp,
            subject: subject,
            student: { id: stdId, nickname: nickname, house: house },
            sessionInfo: { room: sessionRoom, timestamp: sessionId.split('_')[1], subject: subject, tutor: user.nickname || user.fullName }
        };

        // ส่งข้อมูล (Background)
        fetch(CONFIG.appscriptUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(payload) });

        // อัปเดต UI ทันที
        document.getElementById(`v-score-${sessionId}-${stdId}`).innerText = nScore;
        document.getElementById(`v-speak-${sessionId}-${stdId}`).innerText = nSpeak;
        document.getElementById(`v-resp-${sessionId}-${stdId}`).innerText = nResp;

        // คืนค่าปุ่มขนาดเท่าเดิม
        actionArea.innerHTML = `
            <button onclick="startHistoryEdit('${sessionId}', '${stdId}', ${nScore}, ${nSpeak}, ${nResp}, ${rowNumber})" 
                class="bg-white/50 hover:bg-white p-3 rounded-xl shadow-sm border border-black/5 transition-all">
                <span class="text-lg">✎</span>
            </button>`;

        // แจ้งเตือนแบบ Toast (ไม่ปิด Modal หลัก)
        const Toast = Swal.mixin({
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 2000,
            timerProgressBar: true
        });
        Toast.fire({ icon: 'success', title: 'บันทึกสำเร็จ' });

    } catch (e) {
        console.error(e);
        showToast("เกิดข้อผิดพลาด", "error");
    }
};

window.cancelHistoryEdit = function (sessionId, stdId, score, speak, resp, rowNumber) {
    // คืนค่าตัวเลข
    document.getElementById(`v-score-${sessionId}-${stdId}`).innerText = score;
    document.getElementById(`v-speak-${sessionId}-${stdId}`).innerText = speak;
    document.getElementById(`v-resp-${sessionId}-${stdId}`).innerText = resp;

    // คืนค่าปุ่มแก้ไข (ใช้ Class ชุดเดิมเพื่อให้ขนาดเท่าเดิม)
    document.getElementById(`action-${sessionId}-${stdId}`).innerHTML = `
        <button onclick="startHistoryEdit('${sessionId}', '${stdId}', ${score}, ${speak}, ${resp}, ${rowNumber})" 
            class="bg-white/50 hover:bg-white p-3 rounded-xl shadow-sm border border-black/5 transition-all">
            <span class="text-lg">✎</span>
        </button>
    `;
};