import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, get, set, onValue, goOnline, goOffline } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);
window.db = db; // เก็บตัวแปร db ไว้ที่ window เพื่อให้ไฟล์อื่นๆ ใช้งานได้

if (typeof window.setupConnectionManager === 'function') {
    window.setupConnectionManager(db);
} else {
    // ถ้า utils.js ยังโหลดไม่เสร็จ ให้รอ 100ms แล้วเรียกใหม่
    setTimeout(() => window.setupConnectionManager && window.setupConnectionManager(db), 100);
}

// 2. Local State
let currentMode = 'pretest';
let allStudents = [];
let profiles = {};
let fuse;
let selectedStudent = null;
let currentSortKey = 'id'; // 'id' หรือ 'score'
let currentSortDir = 'asc'; // 'asc' หรือ 'desc'


// 3. Question Limits (Validation)
const LIMITS = {
    physic: 15,
    chemistry: 15,
    biology: 6,
    introdent: 12,
    intromed: 12,
    total: 60
};

// --- [A] Real-time Listener: ดึงข้อมูลและอัปเดตหน้าจออัตโนมัติ ---
async function loadStudentsData() {
    try {
        // 1. ดึงโปรไฟล์ทั้งหมดครั้งเดียว (ข้อมูลเล็กมาก)
        const profilesSnapshot = await get(ref(db, 'students'));
        profiles = profilesSnapshot.val() || {};

        // 2. ติดตามกิ่งคะแนนแบบ Real-time (กิ่งที่เปลี่ยนแปลงบ่อย)
        onValue(ref(db, 'scores'), (scoresSnapshot) => {
            const scores = scoresSnapshot.val() || {};

            // 3. รวมโปรไฟล์เข้ากับคะแนนล่าสุด
            allStudents = Object.keys(profiles).map(id => ({
                id: id,
                ...profiles[id],
                pretest: scores[id]?.pretest || null,
                posttest: scores[id]?.posttest || null
            }));

            // อัปเดตระบบค้นหาและตาราง
            if (!fuse) fuse = setupFuzzySearch(allStudents);
            else fuse.setCollection(allStudents);

            updateLiveBoard();
        });
    } catch (error) {
        console.error("Load Error:", error);
    }
}

// เรียกทำงานทันทีที่โหลดหน้าจอ
document.addEventListener('DOMContentLoaded', loadStudentsData);

// --- [B] UI Management ---

// ฟังก์ชันสลับโหมด Pre-test / Post-test
window.setMode = (mode) => {
    currentMode = mode;
    const isPre = mode === 'pretest';
    document.getElementById('btn-pre').className = isPre ? 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-slate-200 text-slate-400';
    document.getElementById('btn-post').className = !isPre ? 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-slate-200 text-slate-400';

    if (selectedStudent) selectStudent(selectedStudent.id);
    updateLiveBoard();
};

// ฟังก์ชันสลับการเรียงลำดับใน Live Board
window.toggleSort = (key) => {
    if (currentSortKey === key) {
        currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortKey = key;
        currentSortDir = 'asc';
    }
    updateLiveBoard();
};
// [1] ฟังก์ชันอัปเดตตาราง Live Board พร้อมปุ่มลบ
function updateLiveBoard() {
    const board = document.getElementById('live-score-board');
    if (!board) return;

    const user = checkAuth();

    // 1. เตรียมข้อมูลพื้นฐานสำหรับการวิเคราะห์
    let countTotalPass = 0;
    let countGrowthPass = 0;
    let countMedianPass = 0;
    let countDeclined = 0;
    let totalEligibleForGrowth = 0;

    const allPostScores = allStudents.map(s => s.posttest?.total).filter(v => v != null);
    const medianPost = calculateMedian(allPostScores);

    // 2. กรองรายชื่อน้องที่มีคะแนนในโหมดปัจจุบัน
    let displayData = allStudents.filter(s =>
        s[currentMode] && (s[currentMode].recordedBy || s[currentMode].total > 0)
    );

    // 3. จัดเรียงลำดับตาม currentSortKey (ID, Total, หรือรายวิชา)
    displayData.sort((a, b) => {
        if (currentMode === 'posttest') {
            const checkPassStatus = (s) => {
                const pre = s.pretest?.total || 0;
                const post = s.posttest?.total || 0;
                const growth = pre > 0 ? (post - pre) / pre : (post > 0 ? 1 : 0);
                const isImproved = growth >= IMPROVEMENT_THRESHOLD;
                const isMedianPass = post >= medianPost;
                const isDeclined = pre > 0 && growth <= DECLINE_THRESHOLD;
                return (isImproved || isMedianPass) && !isDeclined;
            };
            const isPassA = checkPassStatus(a);
            const isPassB = checkPassStatus(b);
            if (isPassA && !isPassB) return -1;
            if (!isPassA && isPassB) return 1;
        }

        let valA, valB;
        if (currentSortKey === 'id') {
            valA = parseInt(a.id);
            valB = parseInt(b.id);
        } else {
            // รองรับ 'total', 'physic', 'chemistry', 'biology', 'introdent', 'intromed'
            const field = currentSortKey === 'score' ? 'total' : currentSortKey;
            valA = a[currentMode]?.[field] || 0;
            valB = b[currentMode]?.[field] || 0;
        }

        if (currentSortDir === 'asc') return valA - valB;
        return valB - valA;
    });

    updateSortIcons();

    // 4. วาดตาราง (Rendering) - ปรับจำนวน TD ให้ตรงกับ Header 11 Column
    if (displayData.length === 0) {
        board.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-slate-400 italic">ยังไม่มีข้อมูลในโหมด ${currentMode.toUpperCase()}</td></tr>`;
    } else {
        board.innerHTML = displayData.map(s => {
            const data = s[currentMode];
            const isOwner = data.recordedBy === (user.nickname || user.fullName);
            const isAdmin = user.role === 'Admin';

            const pre = s.pretest?.total || 0;
            const post = s.posttest?.total || 0;
            const growthValue = pre > 0 ? (post - pre) / pre : (post > 0 ? 1 : 0);
            const growthPercent = (growthValue * 100).toFixed(1);

            const isImproved = growthValue >= IMPROVEMENT_THRESHOLD;
            const isMedianPass = post >= medianPost;
            const isDeclined = pre > 0 && growthValue <= DECLINE_THRESHOLD;
            const isOverallPass = (isImproved || isMedianPass) && !isDeclined;

            if (currentMode === 'posttest') {
                if (pre > 0 || post > 0) totalEligibleForGrowth++;
                if (isImproved) countGrowthPass++;
                if (isMedianPass) countMedianPass++;
                if (isDeclined) countDeclined++;
                if (isOverallPass) countTotalPass++;
            }

            let statusBadges = "";
            let growthInfo = "";
            let rowClass = "hover:bg-slate-50 transition-colors border-b";

            if (currentMode === 'posttest') {
                if (isDeclined) {
                    rowClass += " bg-red-50/60";
                    statusBadges += `<span class="ml-1 bg-red-600 text-white text-[8px] px-1.5 py-0.5 rounded font-black shadow-sm">📉 DECLINED</span>`;
                    growthInfo = `<span class="text-[10px] text-red-600 font-bold block mt-0.5">(Pre: ${pre} → Post: ${post} | Drop: ${growthPercent}%)</span>`;
                } else if (isOverallPass) {
                    rowClass += " bg-emerald-50/40";
                    if (isImproved) statusBadges += `<span class="ml-1 bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded font-black shadow-sm">📈 IMPROVED</span>`;
                    if (isMedianPass) statusBadges += `<span class="ml-1 bg-blue-500 text-white text-[8px] px-1.5 py-0.5 rounded font-black shadow-sm">🏆 TOP HALF</span>`;
                    growthInfo = `<span class="text-[10px] text-emerald-600 font-bold block mt-0.5">(Pre: ${pre} → Post: ${post} | Growth: +${growthPercent}%)</span>`;
                } else {
                    rowClass += " opacity-70";
                    statusBadges += `<span class="ml-1 bg-slate-400 text-white text-[8px] px-1.5 py-0.5 rounded font-black shadow-sm">⚠️ NOT PASS</span>`;
                    growthInfo = `<span class="text-[10px] text-slate-500 font-bold block mt-0.5">(Pre: ${pre} → Post: ${post} | Growth: ${growthPercent}%)</span>`;
                }
            }

            return `
                <tr class="${rowClass} text-[13px]">
                    <td class="p-4 font-mono font-bold text-blue-600">${s.id}</td>
                    <td class="p-4">
                        <div class="font-bold text-slate-700 flex items-center flex-wrap">
                            ${s.fullName} (${s.nickname}) ${statusBadges}
                        </div>
                        <div class="text-[10px] text-slate-400 uppercase font-bold">บ้าน ${s.house}</div>
                        ${growthInfo}
                    </td>
                    <td class="p-4 text-center justify-center">
                        <span class="px-2 py-1 rounded-md text-[10px] font-bold ${currentMode === 'pretest' ? 'bg-orange-100 text-orange-600' : 'bg-green-100 text-green-600'}">
                            ${currentMode.toUpperCase()}
                        </span>
                    </td>
                    <!-- คะแนนแยกรายวิชา -->
                    <td class="p-4 text-center font-medium text-slate-600">${data.physic || 0}</td>
                    <td class="p-4 text-center font-medium text-slate-600">${data.chemistry || 0}</td>
                    <td class="p-4 text-center font-medium text-slate-600">${data.biology || 0}</td>
                    <td class="p-4 text-center font-medium text-slate-600">${data.introdent || 0}</td>
                    <td class="p-4 text-center font-medium text-slate-600">${data.intromed || 0}</td>
                    
                    <td class="p-4 text-center font-black text-lg text-blue-700">${data.total}</td>
                    <td class="p-4 text-xs text-slate-500">
                        <div class="font-bold">${data.recordedBy || 'System'}</div>
                    </td>
                    <td class="p-4 text-right">
                        ${(isAdmin || isOwner || !data.recordedBy) ? `
                            <button onclick="window.deleteScore('${s.id}', '${currentMode}')" class="text-red-300 hover:text-red-600 transition-colors">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                        ` : '<span title="Locked">🔒</span>'}
                    </td>
                </tr>
            `;
        }).join('');
    }

    // 5. ส่งข้อมูลสถิติไปยัง Analysis Dashboard (คงเดิม)
    if (currentMode === 'posttest') {
        updateElementText('summary-pass-total', countTotalPass);
        updateElementText('summary-pass-growth', countGrowthPass);
        updateElementText('summary-pass-median', countMedianPass);
        updateElementText('summary-declined', countDeclined);
        updateElementText('stat-median', medianPost.toFixed(1));
        const rate = totalEligibleForGrowth > 0 ? Math.round((countGrowthPass / totalEligibleForGrowth) * 100) : 0;
        updateElementText('stat-pass-rate', `${rate}% (${countGrowthPass}/${totalEligibleForGrowth} คน)`);
    } else {
        ['summary-pass-total', 'summary-pass-growth', 'summary-pass-median', 'summary-declined'].forEach(id => updateElementText(id, "-"));
        updateElementText('stat-median', "-");
        updateElementText('stat-pass-rate', "N/A");
    }

    if (currentMode === 'posttest') {
        // 1. กรองเฉพาะคนที่มีคะแนนทั้งคู่ และ Post > Pre (มีพัฒนาการ)
        const improvers = allStudents.filter(s =>
            s.pretest?.total != null &&
            s.posttest?.total != null &&
            s.posttest.total > s.pretest.total
        );

        let impIndex = 0;
        if (improvers.length > 0 && medianPost > 0) {
            // 2. รวมผลต่างคะแนน (Post - Pre) ของกลุ่มนี้
            const totalGain = improvers.reduce((sum, s) => sum + (s.posttest.total - s.pretest.total), 0);

            // 3. หาค่าเฉลี่ยคะแนนที่เพิ่มขึ้นต่อคน
            const avgGain = totalGain / improvers.length;

            // 4. เข้าสูตร (Average Gain / Median Post) * 100
            impIndex = (avgGain / medianPost) * 100;
        }

        // แสดงผลบน UI
        updateElementText('stat-imp-index', impIndex > 0 ? impIndex.toFixed(1) + '%' : "0.0%");
    } else {
        updateElementText('stat-imp-index', "-");
    }

    renderBoxPlot();
}

function updateElementText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function updateSortIcons() {
    const keys = ['id', 'physic', 'chemistry', 'biology', 'introdent', 'intromed', 'total'];

    keys.forEach(key => {
        const icon = document.getElementById(`sort-icon-${key}`);
        if (icon) {
            if (currentSortKey === key) {
                icon.innerText = currentSortDir === 'asc' ? '🔼' : '🔽';
                icon.className = "ml-1 text-blue-600 font-bold";
            } else {
                icon.innerText = '↕️';
                icon.className = "ml-1 text-slate-300";
            }
        }
    });
}

// [2] ฟังก์ชันลบคะแนน (เรียกใช้โดย Admin หรือ เจ้าของ)
window.deleteScore = async function (studentId, mode) {
    const result = await Swal.fire({
        title: 'ยืนยันการลบคะแนน?',
        text: `คะแนนของรหัส ${studentId} ในโหมด ${mode} จะถูกลบถาวร`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'ลบเลย',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        try {
            // แก้ Path จาก students/... เป็น scores/...
            const scoreRef = ref(db, `scores/${studentId}/${mode}`);
            await set(scoreRef, null);

            // ส่วนที่ส่งไป GAS และ update UI อื่นๆ คงเดิม
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify({
                    action: 'deleteScore',
                    key: CONFIG.syncKey,
                    id: studentId,
                    mode: mode
                })
            });

            showToast('ลบข้อมูลเรียบร้อย');
            // updateLiveBoard จะถูกเรียกอัตโนมัติจาก onValue ด้านบนอยู่แล้ว
        } catch (e) {
            Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถลบข้อมูลได้', 'error');
        }
    }
}

// ซิงค์ข้อมูลจาก Firebase ลงในช่อง Input (ถ้าไม่ได้กำลังพิมพ์อยู่)
function syncInputsWithFirebase(student) {
    const scoreData = student[currentMode] || {};
    const inputs = {
        's-phy': scoreData.physic,
        's-chem': scoreData.chemistry,
        's-bio': scoreData.biology,
        's-dent': scoreData.introdent,
        's-med': scoreData.intromed
    };

    for (const [id, val] of Object.entries(inputs)) {
        const el = document.getElementById(id);
        if (document.activeElement !== el) { // ถ้าไม่ได้ Focus ช่องนี้อยู่ ให้เปลี่ยนค่า
            el.value = (val !== undefined) ? val : "";
        }
    }
    updateTotalPreview();
}

// --- [C] Search Logic ---

// ค้นหาด้วย ID
document.getElementById('input-id').oninput = (e) => {
    const id = e.target.value.trim();
    if (allStudents.some(s => s.id === id)) {
        selectStudent(id);
        document.getElementById('input-name').value = selectedStudent.fullName;
    }
};

// ค้นหาด้วยชื่อ (Fuzzy)
function setupFuzzySearch(students) {
    const options = {
        keys: ['fullName', 'nickname', 'id'], // กำหนดฟิลด์ที่ต้องการใช้ค้นหา
        threshold: 0.4, // ค่าความแม่นยำในการค้นหาคำใกล้เคียง (0.0 = เป๊ะมาก, 1.0 = มั่วได้เยอะ)
    };
    // คืนค่าออบเจกต์ Fuse กลับไปตามที่ไลบรารี Fuse.js กำหนด
    return new Fuse(students, options);
}

document.getElementById('input-name').oninput = (e) => {
    const query = e.target.value;
    const box = document.getElementById('suggest-box');

    if (query.length < 2) {
        box.classList.add('hidden');
        return;
    }

    const results = fuse.search(query);
    if (results.length > 0) {
        box.innerHTML = results.slice(0, 5).map(res => {
            const s = res.item;

            // --- ปรับปรุงการเช็คคะแนนให้แม่นยำขึ้น ---
            // เช็คทั้งใน s.pretest หรือ s['pretest'] และต้องมีค่า total
            const scoreObj = s[currentMode];
            const hasScore = scoreObj && scoreObj.recordedBy; 
            const scoreValue = hasScore ? scoreObj.total : 0;

            const badge = hasScore
                ? `<span class="whitespace-nowrap bg-green-100 text-green-700 text-[10px] px-2 py-1 rounded-full font-bold shadow-sm border border-green-200">✅ บันทึกแล้ว (${scoreValue})</span>`
                : `<span class="whitespace-nowrap bg-slate-100 text-slate-400 text-[10px] px-2 py-1 rounded-full font-bold border border-slate-200">⏳ ยังไม่มีคะแนน</span>`;

            return `
                <div onclick="handleSelectSuggestion('${s.id}')" 
                     class="p-4 hover:bg-blue-50 cursor-pointer border-b last:border-0 flex justify-between items-center gap-4 transition-all">
                    <div class="min-w-0 flex-1">
                        <p class="font-bold text-slate-800 truncate">${s.fullName} (${s.id})</p>
                        <p class="text-xs text-slate-500 truncate italic">บ้าน ${s.house} | ${s.nickname}</p>
                    </div>
                    <div class="flex-shrink-0">
                        ${badge}
                    </div>
                </div>
            `;
        }).join('');
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
    }
};

window.handleSelectSuggestion = (id) => {
    selectStudent(id);
    document.getElementById('input-id').value = id;
    document.getElementById('input-name').value = selectedStudent.fullName;
    document.getElementById('suggest-box').classList.add('hidden');
};

// ฟังก์ชันเมื่อเลือกนักเรียน (จากการค้นหา ID หรือ ชื่อ)
async function selectStudent(id) {
    // 1. ค้นหาโปรไฟล์จากตัวแปร allStudents (ซึ่งตอนนี้มีแต่ชื่อและข้อมูลพื้นฐาน)
    selectedStudent = allStudents.find(s => s.id === id);
    if (!selectedStudent) return;

    // 2. แสดง UI พื้นฐานทันที (เพื่อให้สตาฟรู้ว่าเลือกถูกคนแล้ว ไม่ต้องรอดึงคะแนน)
    document.getElementById('score-form').classList.remove('hidden');
    document.getElementById('display-id').innerText = selectedStudent.id;
    document.getElementById('display-name').innerText = selectedStudent.fullName;
    document.getElementById('display-house').innerText = `บ้าน: ${selectedStudent.house} | ${selectedStudent.school}`;

    // แสดงสถานะ Loading ระหว่างดึงคะแนน
    const badgeContainer = document.getElementById('display-status-badge');
    badgeContainer.innerHTML = `<span class="animate-pulse text-slate-400 text-[10px]">⏳ กำลังโหลดคะแนน...</span>`;

    try {
        // 3. ดึงคะแนนเฉพาะ ID นี้จากกิ่งแยก (scores/{id})
        // หมายเหตุ: ใช้ get(ref(...)) เพื่อดึงครั้งเดียว ไม่ต้องต่อ WebSocket ค้างไว้
        const scoreSnapshot = await get(ref(db, `scores/${id}`));
        const scoreData = scoreSnapshot.val() || {};

        // 4. นำโปรไฟล์ + คะแนนมารวมกัน
        const fullData = { ...selectedStudent, ...scoreData };

        // 5. อัปเดตสถานะ Badge (บันทึกแล้ว / ยังไม่บันทึก)
        const currentScore = fullData[currentMode]; // pretest หรือ posttest
        if (currentScore && currentScore.recordedBy) {
            badgeContainer.innerHTML = `
                <span class="inline-flex items-center bg-green-500 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm">
                    ✅ บันทึกแล้ว (${currentScore.total}/60)
                </span>`;
        } else {
            badgeContainer.innerHTML = `
                <span class="inline-flex items-center bg-slate-400 text-white text-[10px] px-2 py-0.5 rounded-full font-bold opacity-50">
                    ⏳ ยังไม่มีคะแนน
                </span>`;
        }

        // 6. เติมคะแนนลงในช่อง Input (ถ้ามี)
        syncInputsWithFirebase(fullData);

    } catch (error) {
        console.error("Error fetching score:", error);
        showToast("ไม่สามารถดึงคะแนนได้", "error");
    }
}

// --- [D] Validation & Submission ---

// คำนวณคะแนนรวมแบบ Real-time บนหน้าจอ
function updateTotalPreview() {
    const p = parseFloat(document.getElementById('s-phy').value) || 0;
    const c = parseFloat(document.getElementById('s-chem').value) || 0;
    const b = parseFloat(document.getElementById('s-bio').value) || 0;
    const d = parseFloat(document.getElementById('s-dent').value) || 0;
    const m = parseFloat(document.getElementById('s-med').value) || 0;

    const total = p + c + b + d + m;
    const display = document.getElementById('total-preview');
    display.innerText = total;

    // ถ้าคะแนนรวมเกิน 60 ให้เปลี่ยนเป็นสีแดงและแจ้งเตือน
    if (total > 60) {
        display.classList.add('text-red-600', 'animate-bounce');
        showToast("คะแนนรวมเกิน 60 คะแนน!", "error");
    } else {
        display.classList.remove('text-red-600', 'animate-bounce');
    }
}

// ผูก Event การคำนวณเข้ากับทุกช่อง Input
['s-phy', 's-chem', 's-bio', 's-dent', 's-med'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateTotalPreview);
});

window.submitScore = async function () {
    if (!selectedStudent) return;

    // 1. รวบรวมข้อมูลและ Check ว่ากรอกครบหรือไม่
    const scores = {
        physic: document.getElementById('s-phy').value,
        chemistry: document.getElementById('s-chem').value,
        biology: document.getElementById('s-bio').value,
        introdent: document.getElementById('s-dent').value,
        intromed: document.getElementById('s-med').value
    };

    // ตรวจสอบว่ามีช่องว่างไหม
    if (Object.values(scores).some(v => v === "")) {
        Swal.fire("กรอกข้อมูลไม่ครบ", "กรุณาใส่คะแนนให้ครบทุกวิชา (ถ้าขาดสอบให้ใส่ 0)", "error");
        return;
    }

    // แปลงเป็น Number
    const finalScores = {
        physic: parseFloat(scores.physic),
        chemistry: parseFloat(scores.chemistry),
        biology: parseFloat(scores.biology),
        introdent: parseFloat(scores.introdent),
        intromed: parseFloat(scores.intromed)
    };

    // 2. ตรวจสอบคะแนนเกิน
    for (const [key, val] of Object.entries(finalScores)) {
        if (val > LIMITS[key]) {
            Swal.fire("คะแนนเกินจริง", `วิชา ${key} คะแนนเต็มคือ ${LIMITS[key]}`, "error");
            return;
        }
    }

    finalScores.total = Object.values(finalScores).reduce((a, b) => a + b, 0);

    // 3. ยืนยันการบันทึก
    const result = await Swal.fire({
        title: 'ยืนยันบันทึกคะแนน?',
        html: `คุณกำลังบันทึกคะแนนของ <b>${selectedStudent.fullName}</b><br>คะแนนรวม: <b>${finalScores.total} / 60</b>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#22c55e',
        confirmButtonText: 'บันทึกเลย',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        try {
            const staff = checkAuth();

            // Staff Info ที่จะบันทึกลง Firebase และส่งไป Google Sheets ด้วย
            const scoreDataWithStaff = {
                ...finalScores,
                recordedBy: staff.nickname || staff.fullName,
                timestamp: new Date().toISOString()
            };

            // A. บันทึกลง Firebase (Real-time)
            const scoreRef = ref(db, `scores/${selectedStudent.id}/${currentMode}`);
            await set(scoreRef, scoreDataWithStaff);

            // B. อัปเดตข้อมูลใน allStudents เพื่อให้ข้อมูลตรงกับ Firebase ทันที (ไม่ต้องรอ Listener)
            const idx = allStudents.findIndex(s => s.id === selectedStudent.id);
            if (idx !== -1) {
                if (!allStudents[idx][currentMode]) {
                    allStudents[idx][currentMode] = {};
                }
                allStudents[idx][currentMode] = scoreDataWithStaff;
                updateLiveBoard();
            }

            // C. ส่งลง Google Sheets (Background Sync)
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify({
                    action: 'recordScore',
                    key: CONFIG.syncKey,
                    id: selectedStudent.id,
                    mode: currentMode,
                    scores: finalScores,
                    recordedBy: staff.nickname || staff.fullName
                })
            });

            showToast(`บันทึกคะแนนของ ${selectedStudent.nickname} สำเร็จ!`);
            resetForm();

        } catch (e) {
            Swal.fire("ผิดพลาด", "ไม่สามารถเชื่อมต่อฐานข้อมูลได้", "error");
        }
    }
};

function resetForm() {
    document.getElementById('score-form').classList.add('hidden');
    document.getElementById('input-id').value = "";
    document.getElementById('input-name').value = "";
    document.querySelectorAll('#score-form input').forEach(i => i.value = "");
    document.getElementById('total-preview').innerText = "0";
    selectedStudent = null;
    document.getElementById('input-id').focus();
}

// Initial Check
document.addEventListener('DOMContentLoaded', () => {
    const user = checkAuth();
    if (!user || user.userType !== 'staff') {
        window.location.href = '../pages/login.html';
    }
});

const inputMapping = {
    's-phy': 'physic',
    's-chem': 'chemistry',
    's-bio': 'biology',
    's-dent': 'introdent',
    's-med': 'intromed'
};

const scoreInputIds = Object.keys(inputMapping);

// --- ส่วนจัดการ Input: Select on focus & Smart Auto-tab ---
scoreInputIds.forEach((id, index) => {
    const input = document.getElementById(id);

    // 1. เมื่อ Focus ให้คลุมดำทั้งหมด (ทำให้พิมพ์ทับได้ทันที)
    input.addEventListener('focus', () => {
        input.select();
    });

    // 2. เมื่อมีการพิมพ์ (Input Event)
    input.addEventListener('input', (e) => {
        const limitKey = inputMapping[id];
        const limit = LIMITS[limitKey];
        const value = e.target.value;
        const numValue = parseFloat(value);

        // ตรวจสอบคะแนนเกินลิมิต
        if (numValue > limit) {
            input.classList.add('text-red-600', 'font-bold', 'border-red-500');
            showToast(`วิชานี้คะแนนเต็มคือ ${limit} คะแนนเท่านั้น!`, "error");
        } else {
            input.classList.remove('text-red-600', 'font-bold', 'border-red-500');
        }

        // --- ระบบ Smart Auto-tab (กระโดดข้ามช่องแบบฉลาดขึ้น) ---
        let shouldJump = false;

        if (value !== "") {
            // กรณี Biology (เต็ม 6): พิมพ์เลข 0-6 ตัวเดียวแล้วโดดเลย
            if (id === 's-bio' && value.length >= 1) {
                shouldJump = true;
            }
            // กรณีวิชาอื่นๆ (เต็ม 12-15):
            else if (value.length >= 1) {
                // ถ้าพิมพ์เลข 2-9 โดดทันที (เพราะไม่มีคะแนน 20+ แน่นอน)
                if (numValue >= 2) {
                    shouldJump = true;
                }
                // ถ้าพิมพ์เลข 1 แล้วตามด้วยเลขอื่น (รวมเป็น 2 หลัก) โดดทันที
                else if (value.length >= 2) {
                    shouldJump = true;
                }
            }
        }

        if (shouldJump && numValue <= limit) {
            const nextId = scoreInputIds[index + 1];
            if (nextId) {
                const nextEl = document.getElementById(nextId);
                nextEl.focus();
                // ไม่ต้องสั่ง nextEl.select() ตรงนี้ เพราะเรามี Event focus ด้านบนดักไว้อยู่แล้ว
            }
        }

        updateTotalPreview();
    });

    // ระบบกด Enter เพื่อไปช่องถัดไป
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const nextId = scoreInputIds[index + 1];
            if (nextId) {
                document.getElementById(nextId).focus();
            } else {
                window.submitScore();
            }
        }
    });
});

const IMPROVEMENT_THRESHOLD = 0.2; 
const DECLINE_THRESHOLD = -0.11;

// --- [ฟังก์ชันคำนวณ Median] ---
function calculateMedian(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- [ฟังก์ชันวาด Boxplot ด้วย Plotly] ---
window.renderBoxPlot = function () {
    const container = document.getElementById('boxplot-container');
    if (!container) return;

    // ดึงคะแนน Total ทั้งหมดที่มีอยู่จริง
    const preTotals = allStudents.map(s => s.pretest?.total).filter(v => v !== null && v !== undefined);
    const postTotals = allStudents.map(s => s.posttest?.total).filter(v => v !== null && v !== undefined);

    const tracePre = {
        y: preTotals,
        type: 'box',
        name: 'Pre-test',
        marker: { color: '#94a3b8' }, // สีเทา
        boxpoints: 'all',
        jitter: 0.3
    };

    const tracePost = {
        y: postTotals,
        type: 'box',
        name: 'Post-test',
        marker: { color: '#3b82f6' }, // สีน้ำเงิน
        boxpoints: 'all',
        jitter: 0.3
    };

    const layout = {
        title: { text: 'คะแนน Pre-test vs Post-test', font: { family: 'Prompt', size: 16 } },
        yaxis: { title: 'คะแนน (เต็ม 60)', range: [0, 65] },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 40, b: 40, l: 40, r: 20 },
        font: { family: 'Prompt' },
        showlegend: false
    };

    Plotly.newPlot('boxplot-container', [tracePre, tracePost], layout, { responsive: true, displayModeBar: false });

    // อัปเดตตัวเลขสถิติในหน้าจอ (ถ้ามี Element รองรับ)
    const medianPost = calculateMedian(postTotals);
    if (document.getElementById('stat-median')) document.getElementById('stat-median').innerText = medianPost.toFixed(1);

    // คำนวณ Pass Rate (Development >= 20%)
    const studentsWithBoth = allStudents.filter(s => s.pretest?.total != null && s.posttest?.total != null);
    const passers = studentsWithBoth.filter(s => {
        const pre = s.pretest.total;
        const post = s.posttest.total;
        return pre > 0 ? ((post - pre) / pre) >= IMPROVEMENT_THRESHOLD : (post > 0);
    });
    const rate = studentsWithBoth.length > 0 ? Math.round((passers.length / studentsWithBoth.length) * 100) : 0;
    if (document.getElementById('stat-pass-rate')) document.getElementById('stat-pass-rate').innerText = `${rate}% (${passers.length}/${studentsWithBoth.length} คน)`;
};






window.devGeneratePostTest = async function () {
    const confirm = await Swal.fire({
        title: 'สุ่มคะแนน Post-test?',
        text: "ระบบจะสร้างคะแนน Post-test สุ่ม (30-60 คะแนน) ให้เด็กทุกคนเพื่อทดสอบระบบวิเคราะห์",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'เริ่มสุ่ม'
    });

    if (!confirm.isConfirmed) return;

    Swal.fire({ title: 'กำลังสุ่มคะแนน...', didOpen: () => Swal.showLoading() });

    try {
        const { ref, set } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js");

        for (const s of allStudents) {
            const p = Math.floor(Math.random() * 16);
            const c = Math.floor(Math.random() * 16);
            const b = Math.floor(Math.random() * 7);
            const d = Math.floor(Math.random() * 13);
            const m = Math.floor(Math.random() * 13);
            const total = p + c + b + d + m;

            const scoreData = {
                physic: p, chemistry: c, biology: b, introdent: d, intromed: m, total: total,
                recordedBy: "Dev System",
                timestamp: new Date().toISOString()
            };

            await set(ref(window.db, `scores/${s.id}/posttest`), scoreData);
        }
        Swal.fire('สำเร็จ!', 'สุ่มคะแนนเรียบร้อย กราฟจะอัปเดตอัตโนมัติ', 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}