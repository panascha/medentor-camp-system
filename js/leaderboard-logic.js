import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Configuration & State
const SUBJECT_COLORS = {
    "physic": "bg-blue-500",
    "chemistry": "bg-orange-500",
    "biology": "bg-emerald-500",
    "introdent": "bg-purple-500",
    "intromed": "bg-red-500",
    "jeopardy": "bg-amber-500",
    "ชุมนุมวิชาการ": "bg-indigo-600",
    "default": "bg-slate-400"
};

const SUBJECT_LABELS = {
    "physic": "ฟิสิกส์",
    "chemistry": "เคมี",
    "biology": "ชีวะ",
    "introdent": "Dent",
    "intromed": "Med",
    "jeopardy": "เกม",
    "ชุมนุมวิชาการ": "ชุมนุม",
    "default": "อื่นๆ"
};

let rawData = []; // เก็บข้อมูลดิบที่ประมวลผลแล้ว
let currentSortMode = 'total'; // โหมดการเรียงลำดับปัจจุบัน

document.addEventListener('DOMContentLoaded', () => {
    const user = checkAuth();
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    const adminView = document.getElementById('admin-view');
    const userView = document.getElementById('user-view');
    const loading = document.getElementById('loading');

    const leaderboardRef = ref(db, 'house_leaderboard_detailed');

    onValue(leaderboardRef, (snapshot) => {
        loading.style.display = 'none';
        const data = snapshot.val();

        if (!data) {
            const container = user.role === 'Admin' ? adminView : userView;
            container.classList.remove('hidden');
            container.innerHTML = `<div class="text-center py-20 text-slate-400">ยังไม่มีคะแนนในระบบ</div>`;
            return;
        }

        // ประมวลผลข้อมูล
        rawData = Object.keys(data).filter(key => parseInt(key) > 0 && parseInt(key) <= 8).map(key => ({
            house: parseInt(key),
            total: data[key].total || 0,
            breakdown: data[key].breakdown || {}
        }));

        if (user.role === 'Admin') {
            adminView.classList.remove('hidden');
            initAdminControls(); // สร้างปุ่มเลือกโหมดเรียงลำดับ
            renderDashboard();
        } else {
            userView.classList.remove('hidden');
            const myHouseData = rawData.find(d => d.house == user.house);
            renderUserBoard(myHouseData ? myHouseData.total : 0, user.house);
        }
    });
});

// --- ส่วนการวิเคราะห์ข้อมูล (Analysis) ---

function renderDashboard() {
    // 1. เรียงลำดับข้อมูล
    const sortedData = [...rawData].sort((a, b) => {
        if (currentSortMode === 'total') return b.total - a.total;
        const valA = a.breakdown[currentSortMode] || 0;
        const valB = b.breakdown[currentSortMode] || 0;
        return valB - valA;
    });

    // 2. คำนวณ Global Stats (คะแนนรวมทั้งค่ายแยกตามวิชา)
    const globalStats = {};
    rawData.forEach(h => {
        Object.entries(h.breakdown).forEach(([sub, score]) => {
            globalStats[sub] = (globalStats[sub] || 0) + score;
        });
    });

    renderGlobalStats(globalStats);
    renderPodium(sortedData);
    renderAdminBoard(sortedData);
}

function renderGlobalStats(stats) {
    let container = document.getElementById('global-analysis-area');
    if (!container) {
        container = document.createElement('div');
        container.id = 'global-analysis-area';
        container.className = 'grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-8';
        document.getElementById('admin-view').prepend(container);
    }

    const sortedStats = Object.entries(stats).sort((a, b) => b[1] - a[1]);

    container.innerHTML = sortedStats.map(([sub, score]) => {
        const colorClass = SUBJECT_COLORS[sub.toLowerCase()] || SUBJECT_COLORS['default'];
        const label = SUBJECT_LABELS[sub.toLowerCase()] || sub;
        return `
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col items-center">
                <div class="w-2 h-2 rounded-full ${colorClass} mb-1"></div>
                <p class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">${label}</p>
                <p class="text-lg font-black text-slate-700">${score.toLocaleString()}</p>
            </div>
        `;
    }).join('');
}

function initAdminControls() {
    const filterArea = document.querySelector('#admin-view .bg-white.p-4'); // พื้นที่ Legend เดิม
    if (!filterArea || filterArea.dataset.init === 'true') return;

    filterArea.dataset.init = 'true';
    filterArea.innerHTML = `
        <p class="w-full text-center text-[10px] font-black text-slate-400 uppercase mb-3 tracking-widest">คลิกที่วิชาเพื่อเรียงลำดับตามคะแนนวิชานั้นๆ</p>
        <div class="flex flex-wrap gap-2 justify-center">
            <button onclick="setSortMode('total')" class="sort-btn px-4 py-1.5 rounded-full border-2 text-[10px] font-black transition-all ${currentSortMode === 'total' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}">TOTAL SCORE</button>
            ${Object.entries(SUBJECT_LABELS).map(([key, label]) => `
                <button onclick="setSortMode('${key}')" 
                    class="sort-btn flex items-center gap-2 px-4 py-1.5 rounded-full border-2 text-[10px] font-black transition-all ${currentSortMode === key ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}">
                    <span class="w-2 h-2 rounded-full ${SUBJECT_COLORS[key]}"></span> ${label.toUpperCase()}
                </button>
            `).join('')}
        </div>
    `;
}

window.setSortMode = (mode) => {
    currentSortMode = mode;
    // อัปเดต UI ของปุ่ม
    document.querySelectorAll('.sort-btn').forEach(btn => {
        const isMatched = btn.innerText.includes(mode.toUpperCase()) || (mode === 'total' && btn.innerText.includes('TOTAL'));
        if (isMatched) {
            btn.classList.add('bg-slate-800', 'text-white', 'border-slate-800');
            btn.classList.remove('bg-white', 'text-slate-600', 'border-slate-200');
        } else {
            btn.classList.remove('bg-slate-800', 'text-white', 'border-slate-800');
            btn.classList.add('bg-white', 'text-slate-600', 'border-slate-200');
        }
    });
    renderDashboard();
};

function renderAdminBoard(sortedRanking) {
    const body = document.getElementById('full-ranking-body');
    if (!body) return;

    body.innerHTML = sortedRanking.map((item, index) => {
        let barsHtml = '';
        let labelsHtml = '';

        if (item.total > 0) {
            Object.entries(item.breakdown).forEach(([sub, score]) => {
                if (score > 0) {
                    const percentage = (score / item.total) * 100;
                    const subKey = sub.toLowerCase().trim();
                    const colorClass = SUBJECT_COLORS[subKey] || SUBJECT_COLORS['default'];
                    const label = SUBJECT_LABELS[subKey] || sub;

                    // แถบสี
                    barsHtml += `
                        <div class="${colorClass} h-full transition-all hover:scale-y-110 cursor-help border-r border-white/20 last:border-0" 
                             style="width: ${percentage}%" 
                             title="${sub}: ${score} pts">
                        </div>`;

                    // ป้ายบอกคะแนนย่อยด้านล่างแถบ
                    labelsHtml += `
                        <div class="flex flex-col items-center min-w-[35px]">
                            <p class="text-[8px] font-black ${colorClass.replace('bg-', 'text-')}">${label}</p>
                            <p class="text-[10px] font-bold text-slate-600">${score}</p>
                        </div>`;
                }
            });
        } else {
            barsHtml = `<div class="bg-slate-50 h-full w-full"></div>`;
        }

        return `
            <tr class="border-b hover:bg-slate-50/50 transition-colors">
                <td class="p-5 font-black text-slate-400 text-center text-lg">#${index + 1}</td>
                <td class="p-5">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-black text-lg shadow-lg">
                            ${item.house}
                        </div>
                        <div>
                            <span class="font-black text-slate-700 block">บ้าน ${item.house}</span>
                            <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">${currentSortMode === 'total' ? 'Overall Leader' : 'Sorted by ' + currentSortMode}</p>
                        </div>
                    </div>
                </td>
                <td class="p-5">
                    <div class="w-full h-8 bg-slate-100 rounded-xl overflow-hidden flex shadow-inner border border-slate-200 mb-2">
                        ${barsHtml}
                    </div>
                    <div class="flex gap-4 overflow-x-auto no-scrollbar pb-1">
                        ${labelsHtml}
                    </div>
                </td>
                <td class="p-5 text-right">
                    <span class="font-black text-blue-600 text-3xl">${item.total.toLocaleString()}</span>
                    <p class="text-[10px] font-bold text-slate-300 uppercase">Points</p>
                </td>
            </tr>`;
    }).join('');
}

function renderPodium(ranking) {
    const podiumEl = document.getElementById('podium');
    if (!podiumEl || ranking.length < 1) return;

    const displayOrder = [1, 0, 2];
    podiumEl.innerHTML = displayOrder.map(i => {
        const item = ranking[i];
        if (!item) return `<div class="flex-1"></div>`;

        const isFirst = i === 0;
        const height = isFirst ? 'h-48' : (i === 1 ? 'h-36' : 'h-28');
        const color = isFirst ? 'bg-yellow-400 shadow-yellow-200' : (i === 1 ? 'bg-slate-300 shadow-slate-100' : 'bg-orange-400 shadow-orange-100');
        const icon = isFirst ? '👑' : (i === 1 ? '🥈' : '🥉');

        return `
            <div class="flex flex-col items-center flex-1 animate-fade-in">
                <span class="text-xs font-black text-slate-800 mb-2">บ้าน ${item.house}</span>
                <div class="${color} w-full ${height} rounded-t-[2rem] flex flex-col items-center justify-center shadow-xl relative group transition-all hover:-translate-y-2">
                    <span class="text-4xl mb-1">${icon}</span>
                    <span class="font-black text-2xl text-slate-800">${item.total.toLocaleString()}</span>
                    <div class="absolute -bottom-10 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 text-white text-[9px] px-3 py-1 rounded-full whitespace-nowrap">
                        Ranked #${i + 1}
                    </div>
                </div>
            </div>`;
    }).join('');
}

function renderUserBoard(score, userHouse) {
    const scoreEl = document.getElementById('my-house-score');
    const nameEl = document.getElementById('my-house-name');
    if (scoreEl) scoreEl.innerText = score.toLocaleString();
    if (nameEl) nameEl.innerText = `บ้าน ${userHouse}`;
}