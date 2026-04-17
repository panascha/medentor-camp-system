import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Global State (ตัวแปรเก็บสถานะปัจจุบัน)
let lastReactionTs = 0;
let rollInterval = null;
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

        // เงื่อนไข: มีข้อมูล && เป็นเวลาใหม่กว่าที่เคยแสดง && (ป้องการเรียกซ้ำตอนโหลดหน้าแรก)
        if (data && data.ts > lastReactionTs) {
            if (lastReactionTs === 0) {
                lastReactionTs = data.ts;
                return;
            }

            lastReactionTs = data.ts;
            spawnFloatingEmoji(data.type);
            console.log("Reaction received:", data.type); // เช็คใน Console
        }
    });

    // --- [PART D] ฟังคำสั่งสุ่ม (Randomizer) ---
    const randomRef = ref(db, `active_sessions/${currentRoom}/randomizer`);
    onValue(randomRef, (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        if (data.status === 'rolling') {
            startLiveRandomRoll(data.pool);
        } else if (data.status === 'winner') {
            showLiveWinner(data.winner);
        } else if (data.status === 'idle') {
            document.getElementById('random-overlay').classList.add('hidden');
        }
    });
}

function startLiveRandomRoll(pool) {
    const overlay = document.getElementById('random-overlay');
    const nameDisplay = document.getElementById('random-name-display');
    const houseDisplay = document.getElementById('random-house-display');
    const statusText = document.getElementById('random-status');
    const spotlight = document.getElementById('spotlight');

    overlay.classList.remove('hidden');
    statusText.innerText = "กำลังสุ่มผู้โชคดี";
    // ปรับสีเป็น blue-600
    statusText.className = "text-blue-600 text-xl font-black uppercase tracking-[0.5em] mb-10 animate-pulse";

    spotlight.className = "absolute inset-0 bg-blue-100 blur-[80px] rounded-full scale-150 transition-all";

    if (rollInterval) clearInterval(rollInterval);
    rollInterval = setInterval(() => {
        const randomPerson = pool[Math.floor(Math.random() * pool.length)];
        nameDisplay.innerText = randomPerson.nickname;
        // ปรับสีชื่อตอนสุ่มเป็น slate-800
        nameDisplay.className = "relative text-7xl md:text-9xl font-black text-slate-800 italic tracking-tighter transition-all";
        nameDisplay.style.transform = `scale(${0.9 + Math.random() * 0.2}) rotate(${Math.random() * 4 - 2}deg)`;
        houseDisplay.innerText = `HOUSE ${randomPerson.house}`;
        houseDisplay.className = "mt-6 text-2xl font-black text-slate-300 uppercase tracking-widest";
    }, 50);
}

function showLiveWinner(winner) {
    clearInterval(rollInterval);
    const nameDisplay = document.getElementById('random-name-display');
    const houseDisplay = document.getElementById('random-house-display');
    const statusText = document.getElementById('random-status');
    const spotlight = document.getElementById('spotlight');

    nameDisplay.innerText = winner.nickname;
    nameDisplay.style.transform = `scale(1.1) rotate(0deg)`;
    // เปลี่ยนสีชื่อผู้ชนะเป็น slate-900 หรือสีประจำแบรนด์
    nameDisplay.className = "relative text-8xl md:text-[10rem] font-black text-slate-900 italic tracking-tighter transition-all duration-500";

    houseDisplay.innerText = `ยินดีด้วยกับบ้าน ${winner.house}!`;
    // เปลี่ยนสีประกาศบ้านเป็น blue-600
    houseDisplay.className = "mt-8 text-4xl font-black text-blue-600 uppercase tracking-widest animate-bounce";

    statusText.innerText = "ผู้โชคดีได้แก่!";
    statusText.className = "text-yellow-600 text-2xl font-black uppercase tracking-[0.5em] mb-12";

    spotlight.className = "absolute inset-0 bg-yellow-100 blur-[100px] rounded-full scale-[2] transition-all duration-700";

    confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#2563eb', '#fbbf24', '#ffffff']
    });
}

// ฟังก์ชันสำหรับวาดรายการคำตอบลงหน้าจอ
function renderResponses() {
    const container = document.getElementById('live-responses');
    const entries = Object.values(allResponses)
        .filter(res => res.activityID === currentActivityId)
        .reverse();

    document.getElementById('response-count').innerText = entries.length;

    if (entries.length === 0) {
        // ปรับสีข้อความตอนว่าง
        container.innerHTML = `<div class="col-span-full py-20 text-center text-slate-300 text-xl font-bold italic">WAITING FOR RESPONSES...</div>`;
        return;
    }

    container.innerHTML = entries.map(res => `
        <div class="response-card p-5 rounded-[1.5rem] shadow-sm border border-slate-100 bg-white flex flex-col gap-2">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center font-black text-sm">
                    ${res.house}
                </div>
                <div>
                    <h4 class="font-black text-base text-slate-800 leading-tight">${res.nickname}</h4>
                    <p class="text-[9px] text-blue-500 font-bold tracking-widest uppercase">House ${res.house}</p>
                </div>
            </div>
            <!-- ปรับขนาดคำตอบให้เล็กลงและกระชับ -->
            <p class="text-slate-600 text-lg md:text-xl font-medium leading-tight tracking-tight">
                ${res.answer}
            </p>
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
    el.className = 'emoji-float';

    // สุ่มตำแหน่งแนวนอน
    const randomLeft = Math.floor(Math.random() * 80) + 10;
    el.style.left = `${randomLeft}%`;

    // บังคับ Style เพิ่มเติมเผื่อ CSS ไม่โหลด
    el.style.position = 'fixed';
    el.style.zIndex = '999';

    document.body.appendChild(el);

    // ลบ Element เมื่อจบ Animation
    setTimeout(() => {
        el.remove();
    }, 2500);
}