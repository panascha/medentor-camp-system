import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, onValue, set, update } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// 1. Initialize Firebase
const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

// 2. Local State
let currentMode = 'pretest';
let allStudents = [];
let fuse;
let selectedStudent = null;

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
const studentsRef = ref(db, 'students');
onValue(studentsRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
        // แปลง Object เป็น Array เพื่อใช้กับ Fuse.js และ Table
        allStudents = Object.keys(data).map(id => ({
            id: id,
            ...data[id]
        }));

        // อัปเดตระบบค้นหา
        fuse = setupFuzzySearch(allStudents);

        // อัปเดตตาราง Live Board (10 คนล่าสุด)
        updateLiveBoard();

        // หากมีการเลือกนักเรียนอยู่ ให้คะแนนในช่อง Input เปลี่ยนตาม (กรณีสตาฟคนอื่นช่วยกรอก)
        if (selectedStudent) {
            const updatedData = allStudents.find(s => s.id === selectedStudent.id);
            if (updatedData) {
                selectedStudent = updatedData; // อัปเดตข้อมูลในตัวแปร
                syncInputsWithFirebase(updatedData);
            }
        }
    }
});

// --- [B] UI Management ---

// ฟังก์ชันสลับโหมด Pre-test / Post-test
window.setMode = (mode) => {
    currentMode = mode;
    const isPre = mode === 'pretest';
    document.getElementById('btn-pre').className = isPre ? 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-slate-200 text-slate-400';
    document.getElementById('btn-post').className = !isPre ? 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold transition-all border-2 border-slate-200 text-slate-400';

    if (selectedStudent) selectStudent(selectedStudent.id);
};

// [1] ฟังก์ชันอัปเดตตาราง Live Board พร้อมปุ่มลบ
function updateLiveBoard() {
    const board = document.getElementById('live-score-board');
    const user = checkAuth(); // ดึงข้อมูลสตาฟปัจจุบัน

    const scored = allStudents.filter(s => (s.pretest?.total > 0 || s.posttest?.total > 0));
    const lastTen = scored.slice(-10).reverse();

    if (lastTen.length === 0) {
        board.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">ยังไม่มีข้อมูล</td></tr>`;
        return;
    }

    board.innerHTML = lastTen.map(s => {
        // เช็คว่ามีคะแนนโหมดไหนบ้าง (แสดงอันล่าสุด)
        const mode = s.posttest?.total > 0 ? 'posttest' : 'pretest';
        const data = s[mode];
        const isOwner = data.recordedBy === (user.nickname || user.fullName);
        const isAdmin = user.role === 'Admin';

        return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4 font-mono font-bold">${s.id}</td>
                <td class="p-4 font-bold text-slate-700">${s.fullName}</td>
                <td class="p-4 text-xs">${mode.toUpperCase()}</td>
                <td class="p-4 text-center font-black">${data.total}</td>
                <td class="p-4 text-xs text-slate-400 italic">${data.recordedBy || '-'}</td>
                <td class="p-4 text-right">
                    ${(isAdmin || isOwner) ? `
                        <button onclick="window.deleteScore('${s.id}', '${mode}')" class="text-red-400 hover:text-red-600 p-2 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    ` : '<span class="text-slate-300">🔒</span>'}
                </td>
            </tr>
        `;
    }).join('');
}

// [2] ฟังก์ชันลบคะแนน (เรียกใช้โดย Admin หรือ เจ้าของ)
window.deleteScore = async function (studentId, mode) {
    const result = await Swal.fire({
        title: 'ยืนยันการลบคะแนน?',
        text: `คะแนนของรหัส ${studentId} ในโหมด ${mode} จะถูกลบถาวรทั้งในระบบและใน Google Sheet`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'ลบเลย',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        try {
            // 1. ลบจาก Firebase
            const scoreRef = ref(db, `students/${studentId}/${mode}`);
            await set(scoreRef, null); // ลบโหนดนั้นทิ้ง

            // 2. ลบจาก Google Sheet (ยิงไปบอก GAS)
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify({
                    action: 'deleteScore',
                    id: studentId,
                    mode: mode
                })
            });

            Swal.fire('ลบข้อมูลเรียบร้อย', '', 'success');
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
    if (query.length < 2) { box.classList.add('hidden'); return; }

    const results = fuse.search(query);
    if (results.length > 0) {
        box.innerHTML = results.slice(0, 5).map(res => `
            <div onclick="handleSelectSuggestion('${res.item.id}')" class="p-4 hover:bg-blue-50 cursor-pointer border-b last:border-0">
                <p class="font-bold text-slate-800">${res.item.fullName} (${res.item.id})</p>
                <p class="text-xs text-slate-500 italic">บ้าน ${res.item.house} | ${res.item.nickname}</p>
            </div>
        `).join('');
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

function selectStudent(id) {
    selectedStudent = allStudents.find(s => s.id === id);
    if (!selectedStudent) return;

    document.getElementById('score-form').classList.remove('hidden');
    document.getElementById('display-id').innerText = selectedStudent.id;
    document.getElementById('display-name').innerText = selectedStudent.fullName;
    document.getElementById('display-house').innerText = `บ้าน: ${selectedStudent.house} | ${selectedStudent.school}`;

    syncInputsWithFirebase(selectedStudent);
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
                recordedBy: staff.nickname || staff.fullName
            };

            // A. บันทึกลง Firebase (Real-time)
            const scoreRef = ref(db, `students/${selectedStudent.id}/${currentMode}`);
            await set(scoreRef, scoreDataWithStaff);

            // B. ส่งลง Google Sheets (Background Sync)
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify({
                    action: 'recordScore',
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

scoreInputIds.forEach((id, index) => {
    const input = document.getElementById(id);

    input.addEventListener('input', (e) => {
        const limitKey = inputMapping[id];
        const limit = LIMITS[limitKey];
        const value = e.target.value;
        const numValue = parseFloat(value);

        // 1. ถ้าคะแนนเกินลิมิตวิชา ให้เปลี่ยนเป็นสีแดงและแจ้งเตือน
        if (numValue > limit) {
            input.classList.add('text-red-600', 'font-bold', 'border-red-500');
            showToast(`วิชานี้คะแนนเต็มคือ ${limit} คะแนนเท่านั้น!`, "error");
        } else {
            input.classList.remove('text-red-600', 'font-bold', 'border-red-500');
        }

        // 2. ระบบ Auto-tab (ย้ายไปช่องถัดไป)
        let shouldJump = false;
        // กรณี Bio (6 คะแนน) พิมพ์ตัวเดียวแล้วโดดเลยถ้าไม่เกินลิมิต
        if (id === 's-bio' && value.length >= 1 && numValue <= limit) {
            shouldJump = true;
        }
        // กรณีวิชาอื่น (10-15 คะแนน) ต้องพิมพ์ 2 หลักถึงจะโดด
        else if (value.length >= 2 && numValue <= limit) {
            shouldJump = true;
        }

        if (shouldJump) {
            const nextId = scoreInputIds[index + 1];
            if (nextId) {
                const nextEl = document.getElementById(nextId);
                nextEl.focus();
                nextEl.select();
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
                document.getElementById(nextId).select();
            } else {
                window.submitScore();
            }
        }
    });
});