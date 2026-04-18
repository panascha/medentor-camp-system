import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);
window.db = db; // เก็บตัวแปร db ไว้ที่ window เพื่อให้ไฟล์อื่นๆ ใช้งานได้

if (window.setupConnectionManager) {
    window.setupConnectionManager(db);
}

document.addEventListener('DOMContentLoaded', () => {
    const user = checkAuth();
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    const adminView = document.getElementById('admin-view');
    const userView = document.getElementById('user-view');
    const loading = document.getElementById('loading');

    console.log("Leaderboard: Auth Checked", user);

    // 2. ดึงข้อมูล Leaderboard
    const leaderboardRef = ref(db, 'house_leaderboard');

    onValue(leaderboardRef, (snapshot) => {
        try {
            console.log("Firebase Data Received:", snapshot.val());

            // ซ่อนหน้า Loading ทันทีที่ได้รับการตอบกลับ (ไม่ว่าจะสำเร็จหรือว่างเปล่า)
            loading.style.display = 'none';

            const data = snapshot.val();

            if (!data) {
                // ถ้าไม่มีข้อมูลเลย ให้แสดงข้อความแจ้งเตือน
                const container = user.role === 'Admin' ? adminView : userView;
                container.classList.remove('hidden');
                container.innerHTML = `<div class="text-center py-20 text-slate-400">ยังไม่มีคะแนนในระบบ <br> (Admin ต้องรันฟังก์ชัน recalculate ใน Apps Script ก่อน)</div>`;
                return;
            }

            // แปลงข้อมูลเป็น Array สำหรับจัดลำดับ
            const ranking = Object.keys(data).map(h => ({
                house: h,
                score: parseFloat(data[h]) || 0
            })).sort((a, b) => b.score - a.score);

            if (user.role === 'Admin') {
                adminView.classList.remove('hidden');
                renderAdminBoard(ranking);
            } else {
                userView.classList.remove('hidden');
                renderUserBoard(data, user.house);
            }

        } catch (error) {
            console.error("Logic Error:", error);
            loading.innerHTML = `<p class="text-red-500">เกิดข้อผิดพลาด: ${error.message}</p>`;
        }
    }, (error) => {
        console.error("Firebase Error:", error);
        loading.innerHTML = `<p class="text-red-500">เข้าถึงฐานข้อมูลไม่ได้: ${error.code}</p>`;
    });
});

function renderAdminBoard(ranking) {
    const body = document.getElementById('full-ranking-body');
    const podiumEl = document.getElementById('podium');

    // วาด Podium (เฉพาะถ้ามีข้อมูลอย่างน้อย 1 บ้าน)
    if (ranking.length > 0) {
        // ลำดับที่แสดงบน Podium: [อันดับ 2, อันดับ 1, อันดับ 3]
        const displayIndices = [1, 0, 2];

        podiumEl.innerHTML = displayIndices.map(i => {
            const item = ranking[i];
            if (!item) return `<div class="flex-1"></div>`;

            const isFirst = i === 0;
            const height = isFirst ? 'h-48' : (i === 1 ? 'h-36' : 'h-28');
            const color = isFirst ? 'bg-yellow-400' : (i === 1 ? 'bg-slate-300' : 'bg-orange-400');
            const icon = isFirst ? '👑' : (i === 1 ? '🥈' : '🥉');

            return `
                <div class="flex flex-col items-center flex-1">
                    <span class="text-sm font-black text-slate-800 mb-2">บ้าน ${item.house}</span>
                    <div class="${color} w-full ${height} rounded-t-3xl flex flex-col items-center justify-center shadow-lg">
                        <span class="text-3xl mb-1">${icon}</span>
                        <span class="font-black text-xl text-slate-800">${item.score}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    // วาดตารางรายชื่อบ้านทั้งหมด
    body.innerHTML = ranking.map((item, index) => `
        <tr class="border-b last:border-0 hover:bg-slate-50 transition-colors">
            <td class="p-5 font-black text-slate-400">#${index + 1}</td>
            <td class="p-5 font-bold text-slate-700">บ้าน ${item.house}</td>
            <td class="p-5 text-right font-black text-blue-600 text-lg">${item.score}</td>
        </tr>
    `).join('');
}

function renderUserBoard(allData, userHouse) {
    const score = allData[userHouse.toString()] || 0;
    const scoreEl = document.getElementById('my-house-score');
    const nameEl = document.getElementById('my-house-name');

    if (scoreEl) scoreEl.innerText = score;
    if (nameEl) nameEl.innerText = `บ้าน ${userHouse}`;
}