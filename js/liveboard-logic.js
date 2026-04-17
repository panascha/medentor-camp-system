import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Global State (ตัวแปรเก็บสถานะปัจจุบัน)
let currentRoom = new URLSearchParams(window.location.search).get('room');
let currentActivityId = null;
let allResponses = {};

if (!currentRoom) {
    Swal.fire("ไม่พบรหัสห้อง", "กรุณาเข้าผ่านหน้าหลัก หรือระบุ ?room=Room_A", "error");
} else {
    initLiveBoard();
}

function initLiveBoard() {
    document.getElementById('display-room').innerText = currentRoom.replace('_', ' ');

    // --- [PART A] ฟังข้อมูล Session และหัวข้อคำถาม ---
    const sessionRef = ref(db, `active_sessions/${currentRoom}`);
    onValue(sessionRef, (snapshot) => {
        const session = snapshot.val();
        if (!session || !session.isOpen) {
            updateSessionUI("OFFLINE", "รอพี่ติวเตอร์เปิดห้องเรียน...");
            return;
        }

        // อัปเดตวิชา
        document.getElementById('display-subject').innerText = `${session.subject.toUpperCase()} | พี่${session.tutor}`;

        // อัปเดตกิจกรรมปัจจุบัน
        if (session.current_activity) {
            currentActivityId = session.current_activity.activity_id;
            document.getElementById('live-question').innerText = session.current_activity.question_title;
            // เมื่อ ID กิจกรรมเปลี่ยน ให้สั่งวาดคำตอบใหม่ทันที
            renderResponses();
        }

        // ฟัง SOS
        const sosCount = session.sos_students ? Object.keys(session.sos_students).length : 0;
        const sosEl = document.getElementById('sos-alert');
        sosEl.classList.toggle('hidden', sosCount === 0);
        if (sosCount > 0) sosEl.innerText = `🆘 ${sosCount} คนตามไม่ทัน!`;
    });

    // --- [PART B] ฟังข้อมูลคำตอบ (แบบอิสระ) ---
    const responsesRef = ref(db, `responses/${currentRoom}`);
    onValue(responsesRef, (snapshot) => {
        allResponses = snapshot.val() || {};
        renderResponses(); // วาดใหม่ทุกครั้งที่มีคำตอบเข้า
    });

    // --- [PART C] ฟัง Reaction (Emoji ลอย) ---
    const reactionRef = ref(db, `active_sessions/${currentRoom}/last_reaction`);
    onValue(reactionRef, (snapshot) => {
        const data = snapshot.val();
        if (data && (Date.now() - data.ts < 3000)) {
            spawnFloatingEmoji(data.type);
        }
    });
}

// ฟังก์ชันสำหรับวาดรายการคำตอบลงหน้าจอ
function renderResponses() {
    const container = document.getElementById('live-responses');
    if (!container) return;

    // กรองเฉพาะคำตอบที่เป็นของ Activity ปัจจุบัน
    const entries = Object.values(allResponses)
        .filter(res => res.activityID === currentActivityId)
        .reverse(); // เอาอันล่าสุดขึ้นก่อน

    document.getElementById('response-count').innerText = entries.length;

    if (entries.length === 0) {
        container.innerHTML = `<div class="col-span-full py-20 text-center text-slate-500 text-2xl italic">กำลังรอคำตอบจากน้องๆ...</div>`;
        return;
    }

    container.innerHTML = entries.map(res => `
        <div class="response-card bg-white/10 backdrop-blur-md p-8 rounded-[3rem] border border-white/10 shadow-2xl">
            <div class="flex items-center gap-4 mb-4">
                <div class="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center font-black text-2xl shadow-lg">
                    ${res.house}
                </div>
                <div>
                    <h4 class="font-black text-2xl">${res.nickname}</h4>
                    <p class="text-xs text-blue-400 font-bold uppercase tracking-widest">House ${res.house}</p>
                </div>
            </div>
            <p class="text-white text-3xl font-medium leading-tight">${res.answer}</p>
        </div>
    `).join('');
}

function updateSessionUI(subject, question) {
    document.getElementById('display-subject').innerText = subject;
    document.getElementById('live-question').innerText = question;
}

function spawnFloatingEmoji(emoji) {
    const el = document.createElement('div');
    el.innerText = emoji;
    el.className = 'fixed bottom-10 text-8xl pointer-events-none z-[100] animate-float-up';
    el.style.left = (Math.random() * 80 + 10) + '%';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}