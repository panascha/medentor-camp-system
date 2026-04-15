import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, get, set, onValue, goOnline, goOffline } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

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

    // 1. Filter: กรองเอาเฉพาะคนที่มีคะแนนใน "Mode ปัจจุบัน"
    let displayData = allStudents.filter(s =>
        s[currentMode] && (s[currentMode].recordedBy || s[currentMode].total > 0)
    );

    // 2. Sort: เรียงลำดับตาม Key และ Direction ที่เลือก
    displayData.sort((a, b) => {
        let valA, valB;
        if (currentSortKey === 'score') {
            valA = a[currentMode]?.total || 0;
            valB = b[currentMode]?.total || 0;
        } else {
            // เรียงตาม ID (แปลงเป็นตัวเลขเพื่อความถูกต้อง)
            valA = parseInt(a.id);
            valB = parseInt(b.id);
        }

        if (currentSortDir === 'asc') return valA - valB;
        return valB - valA;
    });

    // แสดงผลข้อมูล (เอาแค่ 10-20 คน หรือทั้งหมดก็ได้ตามต้องการ ในที่นี้เอาทั้งหมดที่กรองได้)
    if (displayData.length === 0) {
        board.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 italic">ยังไม่มีข้อมูลในโหมด ${currentMode.toUpperCase()}</td></tr>`;
        return;
    }

    // อัปเดตไอคอนใน Header (ถ้ามี) - เราจะไปแก้ HTML ในขั้นต่อไป
    updateSortIcons();

    board.innerHTML = displayData.map(s => {
        const data = s[currentMode];
        const isOwner = data.recordedBy === (user.nickname || user.fullName);
        const isAdmin = user.role === 'Admin';

        return `
            <tr class="hover:bg-slate-50 transition-colors border-b">
                <td class="p-4 font-mono font-bold text-blue-600">${s.id}</td>
                <td class="p-4">
                    <div class="font-bold text-slate-700">${s.fullName}</div>
                    <div class="text-[10px] text-slate-400 uppercase">บ้าน ${s.house}</div>
                </td>
                <td class="p-4">
                    <span class="px-2 py-1 rounded-md text-[10px] font-bold ${currentMode === 'pretest' ? 'bg-orange-100 text-orange-600' : 'bg-green-100 text-green-600'}">
                        ${currentMode.toUpperCase()}
                    </span>
                </td>
                <td class="p-4 text-center font-black text-lg">${data.total}</td>
                <td class="p-4 text-xs text-slate-500">
                    <div>${data.recordedBy || '<span class="text-slate-300 italic">System</span>'}</div>
                    <div class="text-[9px] opacity-50">${data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : ''}</div>
                </td>
                <td class="p-4 text-right">
                    ${(isAdmin || isOwner || !data.recordedBy) ? `
                        <button onclick="window.deleteScore('${s.id}', '${currentMode}')" class="text-red-400 hover:text-red-600 p-2 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    ` : '<span class="text-slate-200">🔒</span>'}
                </td>
            </tr>
        `;
    }).join('');
}

function updateSortIcons() {
    const idIcon = document.getElementById('sort-icon-id');
    const scoreIcon = document.getElementById('sort-icon-score');
    if (!idIcon || !scoreIcon) return;

    idIcon.innerText = currentSortKey === 'id' ? (currentSortDir === 'asc' ? '🔼' : '🔽') : '↕️';
    scoreIcon.innerText = currentSortKey === 'score' ? (currentSortDir === 'asc' ? '🔼' : '🔽') : '↕️';
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