// ตัวแปรภายในหน้า
let currentMode = 'pretest';
let allStudents = [];
let fuse;
let selectedStudent = null;

// [1] เริ่มต้น: เช็คสิทธิ์และโหลดรายชื่อนักเรียน
document.addEventListener('DOMContentLoaded', async () => {
    // เช็คสิทธิ์สตาฟ
    const user = checkAuth();
    if (!user || user.userType !== 'staff') {
        window.location.href = '../pages/login.html';
        return;
    }

    try {
        // ดึงข้อมูลนักเรียนจาก Firebase
        const response = await fetch(`${CONFIG.firebaseURL}students.json`);
        const data = await response.json();

        if (data) {
            allStudents = Object.values(data);
            // ตั้งค่า Fuzzy Search (เรียกจาก utils.js)
            fuse = setupFuzzySearch(allStudents);
        } else {
            showToast("ไม่พบข้อมูลนักเรียนในระบบ", "error");
        }
    } catch (e) {
        showToast("เชื่อมต่อฐานข้อมูลล้มเหลว", "error");
        console.error(e);
    }
});

// [2] ระบบค้นหาด้วย ID
document.getElementById('input-id').oninput = (e) => {
    const id = e.target.value.trim();
    const student = allStudents.find(s => s.id === id);
    if (student) {
        selectStudent(student);
        document.getElementById('input-name').value = student.fullName;
    }
};

// [3] ระบบค้นหาด้วยชื่อ (Fuzzy Search)
document.getElementById('input-name').oninput = (e) => {
    const query = e.target.value;
    const box = document.getElementById('suggest-box');

    if (query.length < 2) {
        box.classList.add('hidden');
        return;
    }

    const results = fuse.search(query);
    if (results.length > 0) {
        box.innerHTML = results.slice(0, 5).map(res => `
            <div onclick="handleSelectSuggestion('${res.item.id}')" 
                 class="p-4 hover:bg-blue-50 cursor-pointer border-b last:border-0 transition-colors">
                <p class="font-bold text-slate-800">${res.item.fullName} (${res.item.id})</p>
                <p class="text-xs text-slate-500 italic">บ้าน ${res.item.house} | ชื่อเล่น: ${res.item.nickname}</p>
            </div>
        `).join('');
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
    }
};

// ฟังก์ชันเมื่อคลิกเลือกจากรายการแนะนำ
function handleSelectSuggestion(id) {
    const student = allStudents.find(s => s.id === id);
    if (student) {
        selectStudent(student);
        document.getElementById('input-id').value = student.id;
        document.getElementById('input-name').value = student.fullName;
        document.getElementById('suggest-box').classList.add('hidden');
    }
}

// [4] ฟังก์ชันเลือกนักเรียนและแสดงแบบฟอร์มคะแนน
async function selectStudent(student) {
    selectedStudent = student;
    document.getElementById('score-form').classList.remove('hidden');

    // แสดงข้อมูลพื้นฐาน
    document.getElementById('display-id').innerText = student.id;
    document.getElementById('display-name').innerText = student.fullName;
    document.getElementById('display-house').innerText = `บ้าน: ${student.house} | โรงเรียน: ${student.school || '-'}`;

    // ดึงคะแนนเก่า (ถ้ามี) มาโชว์ในช่อง Input
    const existingScores = student[currentMode] || {};
    document.getElementById('s-phy').value = existingScores.physic || "";
    document.getElementById('s-chem').value = existingScores.chemistry || "";
    document.getElementById('s-bio').value = existingScores.biology || "";
    document.getElementById('s-dent').value = existingScores.introdent || "";
    document.getElementById('s-med').value = existingScores.intromed || "";
}

// [5] ฟังก์ชันเปลี่ยนโหมด Pre-test / Post-test
function setMode(mode) {
    currentMode = mode;
    const isPre = mode === 'pretest';

    // ปรับ UI ปุ่ม
    document.getElementById('btn-pre').className = isPre ? 'flex-1 py-3 rounded-xl font-bold border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold border-2 border-slate-200 text-slate-400';
    document.getElementById('btn-post').className = !isPre ? 'flex-1 py-3 rounded-xl font-bold border-2 border-blue-600 bg-blue-600 text-white' : 'flex-1 py-3 rounded-xl font-bold border-2 border-slate-200 text-slate-400';

    // ถ้าเลือกนักเรียนอยู่ ให้รีโหลดคะแนนของโหมดนั้นๆ
    if (selectedStudent) {
        selectStudent(selectedStudent);
    }
}

// [6] บันทึกคะแนน
async function submitScore() {
    if (!selectedStudent) {
        showToast("กรุณาเลือกนักเรียนก่อนบันทึก", "error");
        return;
    }

    // รวบรวมคะแนน
    const scores = {
        physic: parseFloat(document.getElementById('s-phy').value) || 0,
        chemistry: parseFloat(document.getElementById('s-chem').value) || 0,
        biology: parseFloat(document.getElementById('s-bio').value) || 0,
        introdent: parseFloat(document.getElementById('s-dent').value) || 0,
        intromed: parseFloat(document.getElementById('s-med').value) || 0
    };

    // คำนวณคะแนนรวม
    scores.total = scores.physic + scores.chemistry + scores.biology + scores.introdent + scores.intromed;

    const staff = checkAuth(); // ดึงข้อมูลสตาฟที่ล็อกอินอยู่

    try {
        // แสดงสถานะ Loading (Optional)
        const btn = document.getElementById('btn-save');
        btn.innerText = "กำลังบันทึก...";
        btn.disabled = true;

        // 1. บันทึกลง Firebase (Real-time)
        const fbUrl = `${CONFIG.firebaseURL}students/${selectedStudent.id}/${currentMode}.json`;
        await fetch(fbUrl, {
            method: 'PUT',
            body: JSON.stringify(scores)
        });

        // 2. ส่งข้อมูลไป Google Sheets (Background)
        // ไม่ใช้ await เพื่อไม่ให้หน้าเว็บค้างถ้าระบบ Sheet ช้า
        fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors', // ป้องกันปัญหา CORS กับ Google Apps Script
            cache: 'no-cache',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'recordScore',
                id: selectedStudent.id,
                mode: currentMode,
                scores: scores,
                recordedBy: staff.nickname || staff.fullName
            })
        });

        showToast(`บันทึกคะแนน ${currentMode} ของ ${selectedStudent.nickname || selectedStudent.fullName} สำเร็จ!`);

        // ล้างฟอร์ม
        resetForm();

    } catch (e) {
        showToast("เกิดข้อผิดพลาดในการบันทึกข้อมูล", "error");
        console.error(e);
    } finally {
        const btn = document.getElementById('btn-save');
        btn.innerText = "บันทึกคะแนนลงระบบ";
        btn.disabled = false;
    }
}

function resetForm() {
    document.getElementById('score-form').classList.add('hidden');
    document.getElementById('input-id').value = "";
    document.getElementById('input-name').value = "";
    selectedStudent = null;
}