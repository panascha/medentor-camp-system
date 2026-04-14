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

const scoreInputs = ['s-phy', 's-chem', 's-bio', 's-dent', 's-med'];
scoreInputs.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
        let total = 0;
        scoreInputs.forEach(sid => {
            total += parseFloat(document.getElementById(sid).value) || 0;
        });
        document.getElementById('total-preview').innerText = total;
    });
});

// [6] บันทึกคะแนน
async function submitScore() {
    if (!selectedStudent) {
        Swal.fire({
            icon: 'warning',
            title: 'ยังไม่ได้เลือกนักเรียน',
            text: 'กรุณาค้นหาและเลือกนักเรียนก่อนบันทึกคะแนน',
            confirmButtonColor: '#3085d6'
        });
        return;
    }

    // 1. ดึงค่าจาก Input
    const fields = [
        { id: 's-phy', name: 'Physics', limit: 15 },
        { id: 's-chem', name: 'Chemistry', limit: 15 },
        { id: 's-bio', name: 'Biology', limit: 6 },
        { id: 's-dent', name: 'IntroDent', limit: 12 },
        { id: 's-med', name: 'IntroMed', limit: 12 }
    ];

    let scores = {};
    let isIncomplete = false;

    // 2. ตรวจสอบว่ากรอกครบทุกช่องหรือไม่
    fields.forEach(field => {
        const value = document.getElementById(field.id).value;
        if (value === "") {
            isIncomplete = true;
            document.getElementById(field.id).classList.add('border-red-500');
        } else {
            document.getElementById(field.id).classList.remove('border-red-500');
            scores[field.id.replace('s-', '')] = parseFloat(value);
        }
    });

    if (isIncomplete) {
        Swal.fire({
            icon: 'error',
            title: 'ข้อมูลไม่ครบ!',
            text: 'กรุณากรอกคะแนนให้ครบทุกวิชา (ถ้าขาดสอบหรือได้ศูนย์ให้ใส่ 0)',
            confirmButtonColor: '#d33'
        });
        return;
    }

    // 3. ตรวจสอบคะแนนเกิน
    const overLimit = fields.find(f => scores[f.id.replace('s-', '')] > f.limit);
    if (overLimit) {
        Swal.fire({
            icon: 'error',
            title: 'คะแนนเกินจริง!',
            text: `วิชา ${overLimit.name} คะแนนเต็มคือ ${overLimit.limit}`,
            confirmButtonColor: '#d33'
        });
        return;
    }

    // 4. คำนวณผลรวม
    scores.total = Object.values(scores).reduce((a, b) => a + b, 0);

    // 5. ยืนยันการบันทึกด้วย SweetAlert2
    const result = await Swal.fire({
        title: 'ยืนยันการบันทึก?',
        html: `ต้องการบันทึกคะแนนของ <b>${selectedStudent.fullName}</b><br>คะแนนรวมทั้งหมด <b>${scores.total} / 60</b>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#22c55e',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'ใช่, บันทึกเลย',
        cancelButtonText: 'ตรวจสอบอีกครั้ง'
    });

    if (result.isConfirmed) {
        const staff = checkAuth();
        const btn = document.getElementById('btn-save');

        try {
            btn.innerText = "กำลังบันทึก...";
            btn.disabled = true;

            // บันทึกลง Firebase
            await fetch(`${CONFIG.firebaseURL}students/${selectedStudent.id}/${currentMode}.json`, {
                method: 'PUT',
                body: JSON.stringify(scores)
            });

            // ส่งลง Google Sheets
            fetch(CONFIG.appscriptUrl, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify({
                    action: 'recordScore',
                    id: selectedStudent.id,
                    mode: currentMode,
                    scores: scores,
                    recordedBy: staff.nickname || staff.fullName
                })
            });

            Swal.fire({
                icon: 'success',
                title: 'สำเร็จ!',
                text: 'บันทึกคะแนนและประวัติเรียบร้อยแล้ว',
                timer: 1500,
                showConfirmButton: false
            });

            resetForm();

        } catch (error) {
            Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้', 'error');
        } finally {
            btn.innerText = "บันทึกคะแนนลงระบบ";
            btn.disabled = false;
        }
    }
}

// ฟังก์ชันล้างฟอร์ม
function resetForm() {
    document.getElementById('score-form').classList.add('hidden');
    document.getElementById('input-id').value = "";
    document.getElementById('input-name').value = "";
    document.querySelectorAll('#score-form input[type="number"]').forEach(input => input.value = "");
    document.getElementById('total-preview').innerText = "0";
    selectedStudent = null;
    document.getElementById('input-id').focus(); // พร้อมกรอกคนถัดไป
}

document.querySelectorAll('#score-form input').forEach((input, index, inputs) => {
    input.addEventListener('input', () => {
        if (input.value.length >= 2) { // ถ้ากรอกเลข 2 หลัก ให้เลื่อนไปช่องถัดไป
            if (inputs[index + 1]) inputs[index + 1].focus();
        }
    });
});