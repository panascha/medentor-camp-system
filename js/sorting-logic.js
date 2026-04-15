
let students = [];
const dbURL = CONFIG.firebaseURL;
let currentSort = 'desc'; // เก็บสถานะการ Sort

async function loadStudents() {
    try {
        const resp = await fetch(`${dbURL}students.json`);
        const data = await resp.json();
        if (!data) return;

        students = Object.keys(data).map(id => {
            const s = data[id];
            const pretestScore = (s.pretest && s.pretest.total !== undefined)
                ? parseFloat(s.pretest.total) : 0;
            return {
                id: id,
                name: s.fullName,
                nickname: s.nickname,
                house: s.house,
                classID: s.classID || "",
                score: pretestScore
            };
        });

        // Fix จำนวนห้องไว้ที่ 4 ทันที
        const fixedRoomCount = 4;
        renderRooms(fixedRoomCount);

        // 1. กระจายเด็กที่มีห้องอยู่แล้วลงใน 4 ห้องนั้น
        distributeExistingStudents();

        // 2. แสดงเด็กที่เหลือลงใน Pool (ล่างสุด)
        renderPool();

    } catch (e) {
        console.error("Error:", e);
        showToast("โหลดข้อมูลล้มเหลว", "error");
    }
}

// Security Check
document.addEventListener('DOMContentLoaded', async () => {
    const user = checkAuth();
    if (!user || user.role !== 'Admin') {
        Swal.fire('เข้าถึงไม่ได้', 'พื้นที่นี้สำหรับ Admin เท่านั้น', 'error')
            .then(() => window.location.href = '../index.html');
        return;
    }
    loadStudents();
});


function renderRooms(count) {
    const wrapper = document.getElementById('rooms-wrapper');
    wrapper.innerHTML = '';
    for (let i = 1; i <= count; i++) {
        wrapper.innerHTML += `
            <div class="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-fit">
                <div class="bg-slate-800 text-white p-4 flex justify-between items-center">
                    <h3 class="font-bold flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-blue-400"></span>
                        ห้องเรียน ${i}
                    </h3>
                    <span id="count-room-${i}" class="bg-white/20 px-2 py-0.5 rounded-lg text-[10px] font-bold">0 คน</span>
                </div>
                
                <!-- แก้ไขบรรทัดนี้: ใส่ max-h เฉพาะจอเล็ก (มือถือ) และยกเลิกในจอ md (iPad/คอม) -->
                <div id="room-${i}" 
                     class="room-column p-4 space-y-3 bg-slate-50/50 max-h-[60vh] overflow-y-auto md:max-h-none md:overflow-visible" 
                     data-room="${i}">
                </div>
            </div>
        `;
    }
    // Init Sortable
    document.querySelectorAll('.room-column, #pool').forEach(el => {
        new Sortable(el, {
            group: 'rooms',
            animation: 200,
            ghostClass: 'ghost-card',
            onEnd: updateStats
        });
    });
}

function distributeExistingStudents() {
    students.forEach(s => {
        if (s.classID && s.classID !== "") {
            const roomEl = document.getElementById(`room-${s.classID}`);
            if (roomEl) {
                roomEl.innerHTML += createStudentCard(s);
            }
        }
    });
    updateStats();
}

function createStudentCard(s) {
    let scoreColor = 'text-slate-400 bg-slate-100';
    if (s.score >= 45) scoreColor = 'text-emerald-700 bg-emerald-100';
    else if (s.score >= 30) scoreColor = 'text-orange-700 bg-orange-100';

    return `
        <div class="student-card bg-white p-4 rounded-2xl border border-slate-200 shadow-sm house-${s.house} hover:border-blue-500 cursor-pointer" 
             onclick="showRoomSelector('${s.id}', '${s.name}', '${s.nickname}', '${s.house}', '${s.score}')"
             data-id="${s.id}">
            <div class="flex justify-between items-start">
                <div class="min-w-0">
                    <p class="font-bold text-base text-slate-800 truncate">${s.name}</p>
                    <p class="text-xs text-slate-400 font-medium uppercase">ID: ${s.id} | บ. ${s.house} (${s.nickname})</p>
                </div>
                <div class="${scoreColor} px-2 py-1 rounded-lg text-xs font-black min-w-[35px] text-center shadow-sm">
                    ${s.score}
                </div>
            </div>
        </div>
    `;
}

function updateStats() {
    document.querySelectorAll('.room-column').forEach(room => {
        const count = room.children.length;
        const id = room.dataset.room;
        const countEl = document.getElementById(`count-room-${id}`);
        if (countEl) countEl.innerText = `${count} คน`;
    });
}

async function applySnakeSort() {
    const result = await Swal.fire({
        title: 'ยืนยันการจัดห้องใหม่?',
        text: "ระบบจะคำนวณ Snake Sort ตามคะแนน Pretest และล้างห้องเดิมออกทั้งหมด",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ตกลง, จัดเลย!',
        cancelButtonText: 'ยกเลิก'
    });

    if (!result.isConfirmed) return;

    const roomCount = parseInt(document.getElementById('room-count').value);
    renderRooms(roomCount);

    // Logic: Snake Sort
    const sorted = [...students].sort((a, b) => b.score - a.score);
    let rooms = Array.from({ length: roomCount }, () => []);
    let forward = true;
    let roomIdx = 0;

    sorted.forEach(s => {
        rooms[roomIdx].push(s);
        if (forward) {
            if (roomIdx === roomCount - 1) forward = false;
            else roomIdx++;
        } else {
            if (roomIdx === 0) forward = true;
            else roomIdx--;
        }
    });

    rooms.forEach((roomStudents, i) => {
        const roomEl = document.getElementById(`room-${i + 1}`);
        roomEl.innerHTML = roomStudents.map(s => createStudentCard(s)).join('');
    });

    updateStats();
    renderPool();
    showToast("จัดห้องเรียนแบบ Snake Sort เรียบร้อย!");
}

// ฟังก์ชันคลิกเพื่อย้ายห้อง
async function showRoomSelector(studentId, studentName, nickname, house, score) {
    const card = document.querySelector(`.student-card[data-id="${studentId}"]`);
    const currentRoomId = card.parentElement.dataset.room;

    const roomNames = {
        'pool': 'รายการหลัก (Pool)',
        '1': 'ห้องเรียน 1',
        '2': 'ห้องเรียน 2',
        '3': 'ห้องเรียน 3',
        '4': 'ห้องเรียน 4'
    };

    // กำหนดสีคะแนนใน Modal
    let scoreClass = 'bg-slate-100 text-slate-500';
    if (score >= 45) scoreClass = 'bg-emerald-500 text-white';
    else if (score >= 30) scoreClass = 'bg-orange-500 text-white';

    // ส่วนหัวของ Modal (Student Info Header)
    const headerHtml = `
        <div class="text-left bg-slate-50 p-5 rounded-3xl border border-slate-100 mb-6 relative overflow-hidden">
            <!-- ตกแต่งแถบสีตามบ้าน -->
            <div class="absolute left-0 top-0 bottom-0 w-2 house-${house}"></div>
            
            <div class="flex justify-between items-start mb-2">
                <div>
                    <h3 class="text-xl font-black text-slate-800 leading-tight">${studentName}</h3>
                    <p class="text-blue-600 font-bold text-sm">ชื่อเล่น: ${nickname}</p>
                </div>
                <div class="${scoreClass} w-12 h-12 rounded-2xl flex flex-col items-center justify-center shadow-lg shadow-inner">
                    <span class="text-[10px] font-bold uppercase opacity-80 leading-none">Pts</span>
                    <span class="text-lg font-black leading-none">${score}</span>
                </div>
            </div>
            
            <div class="flex items-center gap-3">
                <span class="px-2 py-0.5 bg-white border border-slate-200 rounded-md text-[10px] font-bold text-slate-500">ID: ${studentId}</span>
                <span class="px-2 py-0.5 bg-white border border-slate-200 rounded-md text-[10px] font-bold text-slate-500">บ้าน ${house}</span>
            </div>
        </div>
    `;

    // ปุ่มเลือกห้อง
    const rooms = ['1', '2', '3', '4'];
    let gridButtons = rooms.map(roomId => {
        const isCurrent = currentRoomId === roomId;
        return `
            <button onclick="${isCurrent ? '' : `Swal.clickConfirm(); moveDirect('${studentId}', '${roomId}')`}" 
                class="p-5 rounded-2xl border-2 transition-all flex flex-col items-center 
                ${isCurrent
                ? 'bg-green-50 border-green-500 cursor-default opacity-100'
                : 'bg-blue-50 border-blue-100 hover:bg-blue-600 hover:text-white cursor-pointer active:scale-95'}">
                <span class="text-2xl mb-1">${isCurrent ? '✅' : '🏫'}</span>
                <span class="font-bold text-sm">ห้อง ${roomId}</span>
            </button>
        `;
    }).join('');

    const isPool = currentRoomId === 'pool';

    Swal.fire({
        html: `
            ${headerHtml}
            <p class="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 ml-1">เลือกห้องเรียนที่ต้องการย้ายไป</p>
            <div class="grid grid-cols-2 gap-3">
                ${gridButtons}
                <button onclick="${isPool ? '' : `Swal.clickConfirm(); moveDirect('${studentId}', 'pool')`}" 
                    class="col-span-2 p-4 rounded-2xl border-2 transition-all flex items-center justify-center gap-2
                    ${isPool
                ? 'bg-slate-200 border-slate-400 cursor-default'
                : 'bg-slate-50 border-slate-200 hover:bg-slate-800 hover:text-white cursor-pointer'}">
                    <span class="text-lg">${isPool ? '📍' : '🔄'}</span>
                    <span class="font-bold text-sm">ย้ายกลับไปรายการหลัก (Pool)</span>
                </button>
            </div>
        `,
        showConfirmButton: false,
        showCloseButton: true,
        background: '#fff',
        borderRadius: '2.5rem',
        width: '400px'
    });
}

// ฟังก์ชันสั่งย้ายจริง (เรียกจากปุ่มใน HTML ด้านบน)
function moveDirect(studentId, targetRoom) {
    const card = document.querySelector(`.student-card[data-id="${studentId}"]`);
    const destination = targetRoom === 'pool'
        ? document.getElementById('pool')
        : document.getElementById(`room-${targetRoom}`);

    if (card && destination) {
        destination.appendChild(card);
        updateStats();

        // กะพริบตาเพื่อบอกว่าย้ายมาแล้ว (Visual Feedback)
        card.classList.add('ring-4', 'ring-blue-400', 'ring-opacity-50');
        setTimeout(() => card.classList.remove('ring-4', 'ring-blue-400', 'ring-opacity-50'), 1000);

        showToast(`ย้ายคุณ ${studentId} เรียบร้อย`);
    }
}

async function saveSorting() {
    const btn = document.getElementById('btn-save-all');
    const sortingData = {};

    document.querySelectorAll('.room-column').forEach(room => {
        const roomId = room.dataset.room;
        Array.from(room.children).forEach(card => {
            sortingData[card.dataset.id] = roomId;
        });
    });

    const count = Object.keys(sortingData).length;
    if (count === 0) return showToast("ยังไม่ได้จัดห้องเรียน", "error");

    const confirm = await Swal.fire({
        title: 'บันทึกการจัดห้อง?',
        text: `คุณกำลังจะอัปเดตข้อมูลนักเรียน ${count} คน ลงฐานข้อมูล`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'บันทึกข้อมูล'
    });

    if (!confirm.isConfirmed) return;

    try {
        btn.innerText = "กำลังบันทึก...";
        btn.disabled = true;

        // อัปเดตข้อมูลแบบ Batch (ใช้ PATCH ใน Firebase)
        const updates = {};
        for (let id in sortingData) {
            updates[`students/${id}/classID`] = sortingData[id];
        }

        await fetch(`${dbURL}.json`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });

        // ส่งไปบอก Google Sheet (Background)
        fetch(CONFIG.appscriptUrl, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify({
                action: 'syncClassID',
                key: CONFIG.syncKey,
                data: sortingData
            })
        });

        Swal.fire('สำเร็จ!', 'ข้อมูลห้องเรียนถูกบันทึกเรียบร้อยแล้ว', 'success');
    } catch (e) {
        Swal.fire('ผิดพลาด', 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้', 'error');
    } finally {
        btn.innerText = "บันทึกฐานข้อมูล";
        btn.disabled = false;
    }
}

function resetToPool() {
    loadStudents(); // รีโหลดจากฐานข้อมูลเพื่อล้างสิ่งที่ลากไว้
}

function renderPool() {
    const poolEl = document.getElementById('pool');
    if (!poolEl) return;

    const houseFilter = document.getElementById('filter-house').value;

    // หา ID ของเด็กที่ถูกจัดลงห้องเรียนไปแล้ว (ที่แสดงอยู่ในหน้าจอขณะนี้)
    const assignedIds = Array.from(document.querySelectorAll('.room-column[data-room]:not([data-room="pool"]) .student-card'))
        .map(el => el.dataset.id);

    // กรองเอาเฉพาะเด็กที่ "ยังไม่มีห้อง" ในหน้าจอ
    let poolStudents = students.filter(s => !assignedIds.includes(s.id));

    // กรองตามบ้าน
    if (houseFilter !== 'all') {
        poolStudents = poolStudents.filter(s => s.house.toString() === houseFilter);
    }

    // เรียงลำดับคะแนน
    poolStudents.sort((a, b) => currentSort === 'desc' ? b.score - a.score : a.score - b.score);

    // วาด Card ลงใน Pool
    if (poolStudents.length === 0) {
        poolEl.innerHTML = `<div class="w-full text-center py-8 text-slate-400 text-xs italic">ไม่มีนักเรียนที่ยังไม่ได้จัดห้อง</div>`;
    } else {
        poolEl.innerHTML = poolStudents.map(s => createStudentCard(s)).join('');
    }

    updateStats();
}

// ฟังก์ชันเปลี่ยนสถานะการ Sort
function sortPool(direction) {
    currentSort = direction;
    renderPool();
}

// ฟังก์ชันสุ่มคนที่เหลือใน Pool เข้าห้องเรียน
async function distributeRemaining() {
    const poolItems = Array.from(document.querySelectorAll('#pool .student-card'));
    if (poolItems.length === 0) return showToast("ไม่มีนักเรียนเหลือใน Pool", "error");

    const roomCount = parseInt(document.getElementById('room-count').value);

    // Shuffle รายชื่อที่เหลือ
    const shuffled = poolItems.sort(() => Math.random() - 0.5);

    // วนลูปแจกเข้าห้องเรียนที่คนน้อยที่สุดก่อน
    shuffled.forEach(item => {
        const rooms = Array.from(document.querySelectorAll('.room-column[data-room]:not([data-room="pool"])'));
        // หาห้องที่คนน้อยที่สุด
        const smallestRoom = rooms.reduce((prev, curr) => (prev.children.length < curr.children.length) ? prev : curr);
        smallestRoom.appendChild(item);
    });

    updateStats();
    showToast(`สุ่มนักเรียน ${shuffled.length} คน เข้าห้องเรียนเรียบร้อย`);
}