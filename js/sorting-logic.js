
let students = [];
const dbURL = CONFIG.firebaseURL;
let currentSort = 'desc'; // เก็บสถานะการ Sort

async function loadStudents() {
    try {
        // 1. ดึงข้อมูล 2 กิ่งพร้อมกัน (ใช้ Promise.all เพื่อความเร็ว)
        const [profResp, scoreResp] = await Promise.all([
            fetch(`${dbURL}students.json?auth=${CONFIG.fbSecret}`),
            fetch(`${dbURL}scores.json?auth=${CONFIG.fbSecret}`)
        ]);

        const profiles = await profResp.json();
        const scores = await scoreResp.json() || {};

        if (!profiles) return;

        // 2. รวมข้อมูล (Merge) โปรไฟล์และคะแนนเข้าด้วยกัน
        students = Object.keys(profiles).map(id => {
            const p = profiles[id];
            const s = scores[id] || {};

            // ดึงคะแนน Pretest (ถ้าไม่มีให้เป็น 0)
            const pretestScore = (s.pretest && s.pretest.total !== undefined)
                ? parseFloat(s.pretest.total) : 0;

            return {
                id: id,
                name: p.fullName,
                nickname: p.nickname,
                house: p.house,
                classID: p.classID || "",
                score: pretestScore // ใช้สำหรับ Snake Sort
            };
        });

        // 3. เตรียมหน้าจอ
        const fixedRoomCount = 4;
        renderRooms(fixedRoomCount);

        // 4. กระจายเด็กที่มีห้องอยู่แล้ว (ClassID เดิม)
        distributeExistingStudents();

        // 5. แสดงเด็กที่เหลือใน Pool
        renderPool();

        console.log("Admin Load Complete: Merged profiles and scores.");

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


function getRoomLetter(index) {
    return String.fromCharCode(64 + parseInt(index));
}

const HOUSE_COLORS = {
    1: 'bg-red-500', 2: 'bg-blue-500', 3: 'bg-emerald-500', 4: 'bg-amber-500',
    5: 'bg-purple-500', 6: 'bg-pink-500', 7: 'bg-indigo-500', 8: 'bg-teal-500'
};
function sortRoomDOM(roomEl) {
    const cards = Array.from(roomEl.children);

    cards.sort((a, b) => {
        // ดึง House ID จาก class 'house-X'
        const hA = parseInt(a.className.match(/house-(\d+)/)[1]);
        const hB = parseInt(b.className.match(/house-(\d+)/)[1]);

        // ดึงคะแนนจาก Badge
        const sA = parseFloat(a.querySelector('.min-w-\\[30px\\], .min-w-\\[35px\\]').innerText) || 0;
        const sB = parseFloat(b.querySelector('.min-w-\\[30px\\], .min-w-\\[35px\\]').innerText) || 0;

        // ลอจิก: เรียงบ้าน 1->8 ถ้าบ้านเดียวกัน ให้คะแนนมากไปน้อย
        return hA - hB || sB - sA;
    });

    // นำ Card ที่เรียงแล้วใส่กลับเข้าไปใน DOM
    cards.forEach(card => roomEl.appendChild(card));
}

function renderRooms(count) {
    const wrapper = document.getElementById('rooms-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';

    for (let i = 1; i <= count; i++) {
        const letter = getRoomLetter(i);
        wrapper.innerHTML += `
            <div class="bg-white rounded-[2.5rem] shadow-sm border border-slate-200 overflow-hidden flex flex-col h-fit">
                <!-- ... ส่วน Header ห้องที่เคยเขียนไว้ (สถิติ Mean/Median) ... -->
                <div class="bg-slate-800 text-white p-5">
                    <div class="flex justify-between items-center mb-3">
                        <h3 class="font-black text-xl italic">ROOM ${letter}</h3>
                        <span id="count-room-${letter}" class="bg-white/20 px-3 py-1 rounded-full text-[10px] font-black">0/20 คน</span>
                    </div>
                    <div id="houses-in-${letter}" class="flex gap-1.5 mb-4 flex-wrap"></div>
                    <div class="grid grid-cols-2 gap-2 pt-3 border-t border-white/10" id="stats-area-${letter}">
                         <div class="text-center">
                            <p class="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Mean</p>
                            <p id="mean-room-${letter}" class="text-lg font-black text-blue-400">0.00</p>
                        </div>
                        <div class="text-center">
                            <p class="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Median</p>
                            <p id="median-room-${letter}" class="text-lg font-black text-emerald-400">0.0</p>
                        </div>
                    </div>
                </div>
                <div id="room-${letter}" 
                     class="room-column p-4 space-y-3 bg-slate-50/50 min-h-[200px]" 
                     data-room="${letter}">
                </div>
            </div>
        `;
    }

    // ตั้งค่า Sortable
    document.querySelectorAll('.room-column, #pool').forEach(el => {
        new Sortable(el, {
            group: 'rooms',
            animation: 300,
            ghostClass: 'ghost-card',
            onEnd: (evt) => {
                const item = evt.item;
                const targetRoom = evt.to; // ห้องปลายทาง

                // 1. เพิ่มไฮไลท์ให้ตัวที่พึ่งย้าย
                item.classList.add('just-moved');
                setTimeout(() => item.classList.remove('just-moved'), 1500);

                // 2. ถ้าเป็นการย้ายเข้าห้องเรียน หรือย้ายไปมาระหว่างห้องเรียน ให้เรียงลำดับใหม่ (ยกเว้น Pool)
                if (targetRoom.id !== 'pool') {
                    sortRoomDOM(targetRoom);
                }

                // 3. อัปเดตสถิติต่างๆ
                updateStats();
            }
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
    // กำหนดสีตัวเลขคะแนนตามความเก่ง
    let scoreColor = 'text-slate-400 bg-slate-100';
    if (s.score >= 45) scoreColor = 'text-emerald-700 bg-emerald-100';
    else if (s.score >= 30) scoreColor = 'text-orange-700 bg-orange-100';

    return `
        <div class="student-card bg-white p-3 rounded-2xl border border-slate-200 shadow-sm house-${s.house} hover:border-blue-500 cursor-pointer transition-all" 
             onclick="showRoomSelector('${s.id}', '${s.name}', '${s.nickname}', '${s.house}', '${s.score}')"
             data-id="${s.id}">
            <div class="flex justify-between items-start gap-2">
                <div class="flex items-start gap-2 min-w-0">
                    <!-- Badge สีประจำบ้าน -->
                    <div class="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-black text-white bg-house-${s.house} shadow-sm">
                        ${s.house}
                    </div>
                    <div class="min-w-0">
                        <p class="font-bold text-sm text-slate-800 truncate">${s.name}</p>
                        <p class="text-[10px] text-slate-400 font-medium uppercase truncate">
                            ID: ${s.id} | ${s.nickname}
                        </p>
                    </div>
                </div>
                <!-- คะแนน Pretest -->
                <div class="${scoreColor} px-2 py-0.5 rounded-lg text-[10px] font-black min-w-[30px] text-center shadow-sm">
                    ${s.score}
                </div>
            </div>
        </div>
    `;
}

// ฟังก์ชันหลักในการอัปเดตข้อมูลบ้าน (เรียกจาก updateStats)
function updateHouseInsights() {
    const insightsGrid = document.getElementById('house-insights-grid');
    if (!insightsGrid) return;

    // 1. กำหนดสไตล์สีตามคลาส
    const CLASS_THEMES = {
        'A': { text: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200', dot: 'bg-blue-500' },
        'B': { text: 'text-indigo-700', bg: 'bg-indigo-50', border: 'border-indigo-200', dot: 'bg-indigo-500' },
        'C': { text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500' },
        'D': { text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' }
    };

    // 2. จัดกลุ่มนักเรียน (เหมือนเดิม)
    const houseGroups = {};
    for (let i = 1; i <= 8; i++) {
        houseGroups[i] = { all: [], assigned: { 'A': [], 'B': [], 'C': [], 'D': [], 'pool': [] } };
    }

    students.forEach(s => {
        const h = s.house;
        if (!houseGroups[h]) return;
        houseGroups[h].all.push(s.score);
        const cardEl = document.querySelector(`.student-card[data-id="${s.id}"]`);
        if (cardEl) {
            const currentRoom = cardEl.parentElement.dataset.room || 'pool';
            houseGroups[h].assigned[currentRoom].push(s.score);
        }
    });

    // 3. วาด UI
    insightsGrid.innerHTML = Object.keys(houseGroups).map(hId => {
        const house = houseGroups[hId];
        const globalMean = house.all.length > 0 ? (house.all.reduce((a, b) => a + b, 0) / house.all.length) : 0;
        const rooms = ['A', 'B', 'C', 'D'];

        const distHtml = rooms.map(r => {
            const count = house.assigned[r].length;
            const mean = count > 0 ? (house.assigned[r].reduce((a, b) => a + b, 0) / count) : 0;
            const theme = CLASS_THEMES[r];

            // ถ้ามีคนในคลาสนี้ ให้ใช้สีประจำคลาส ถ้าไม่มีให้เป็นสีเทาจาง
            const statusStyle = count > 0
                ? `${theme.bg} ${theme.border} ${theme.text} border-2`
                : `bg-slate-50 border-slate-100 text-slate-300 border`;

            return `
                <div class="rounded-2xl p-3 ${statusStyle} transition-all duration-300 flex flex-col justify-between">
                    <div class="flex justify-between items-start mb-1">
                        <div class="flex items-center gap-1.5">
                            ${count > 0 ? `<span class="w-1.5 h-1.5 rounded-full ${theme.dot}"></span>` : ''}
                            <span class="text-[10px] font-black uppercase tracking-tighter">คลาส ${r}</span>
                        </div>
                        <span class="text-[11px] font-black">${count} คน</span>
                    </div>
                    <div class="flex items-baseline gap-1">
                        <span class="text-[8px] font-bold opacity-60 uppercase">Avg</span>
                        <span class="text-xs font-black">${mean.toFixed(1)}</span>
                    </div>
                    <!-- หลอดไฟเช็คความสมบูรณ์ (ครบ 5 คน) -->
                    ${count === 5 ? `
                        <div class="mt-2 pt-1.5 border-t border-current/10 flex items-center gap-1">
                            <span class="text-[8px] font-black italic">✓ BALANCED</span>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        return `
            <div class="bg-white border-2 border-slate-100 rounded-[2.5rem] p-5 hover:shadow-xl hover:-translate-y-1 transition-all group">
                <div class="flex justify-between items-start mb-5">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-2xl bg-house-${hId} text-white flex items-center justify-center font-black text-lg shadow-lg shadow-house-${hId}/30">
                            ${hId}
                        </div>
                        <div>
                            <h4 class="text-base font-black text-slate-800">บ้าน ${hId}</h4>
                            <div class="flex items-center gap-1">
                                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Global Mean:</span>
                                <span class="text-[10px] font-black text-blue-600">${globalMean.toFixed(1)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-3 mb-4">
                    ${distHtml}
                </div>
                
                <div class="flex justify-between items-center bg-slate-50 p-3 rounded-2xl">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">คงเหลือใน Pool</span>
                    <span class="text-sm font-black ${house.assigned['pool'].length > 0 ? 'text-orange-500' : 'text-slate-300'}">
                        ${house.assigned['pool'].length} <span class="text-[10px]">คน</span>
                    </span>
                </div>
            </div>
        `;
    }).join('');
}

function updateStats() {
    const HOUSE_COLORS_CLASS = {
        1: 'bg-red-500', 2: 'bg-blue-500', 3: 'bg-emerald-500', 4: 'bg-amber-500',
        5: 'bg-purple-500', 6: 'bg-pink-500', 7: 'bg-indigo-500', 8: 'bg-teal-500'
    };

    document.querySelectorAll('.room-column').forEach(room => {
        const letter = room.dataset.room;
        if (letter === 'pool') return;

        const cards = Array.from(room.querySelectorAll('.student-card'));
        const scores = cards.map(c => parseFloat(c.querySelector('.min-w-\\[30px\\], .min-w-\\[35px\\]').innerText) || 0);
        const count = scores.length;

        if (count === 0) return;

        // 1. สถิติพื้นฐาน
        const mean = scores.reduce((a, b) => a + b, 0) / count;
        const sorted = [...scores].sort((a, b) => a - b);
        const median = count % 2 !== 0 ? sorted[Math.floor(count / 2)] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;

        // 2. คำนวณ SD (บอกความเหลื่อมล้ำในห้อง)
        const v = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / count;
        const sd = Math.sqrt(v);

        // 3. หาช่วงคะแนน (Gap)
        const min = sorted[0];
        const max = sorted[count - 1];

        // --- อัปเดต UI ---
        document.getElementById(`count-room-${letter}`).innerText = `${count}/20 คน`;
        document.getElementById(`mean-room-${letter}`).innerText = mean.toFixed(1);
        document.getElementById(`median-room-${letter}`).innerText = median.toFixed(1);

        // เพิ่มการแสดงผล SD และ Range ลงใน Header (ถ้าคุณเพิ่ม Tag HTML รองรับ)
        // ตัวอย่างการนำไปใช้แสดงผลเพิ่มเติมในจุดสีบ้าน
        const houseCounts = {};
        cards.forEach(card => {
            const h = card.className.match(/house-(\d+)/)[1];
            houseCounts[h] = (houseCounts[h] || 0) + 1;
        });

        const houseContainer = document.getElementById(`houses-in-${letter}`);
        houseContainer.innerHTML = `
            <div class="w-full flex justify-between text-[8px] text-slate-400 font-bold mb-2 border-b border-white/5 pb-1 uppercase tracking-tighter">
                <span>SD: ${sd.toFixed(2)}</span>
                <span>Range: ${min}-${max} (Gap: ${max - min})</span>
            </div>
        ` + Object.keys(houseCounts).sort().map(h => `
            <div class="flex items-center gap-1 bg-white/10 px-2 py-0.5 rounded-md border ${houseCounts[h] === 5 ? 'border-emerald-400' : 'border-white/5'}">
                <span class="w-2 h-2 rounded-full ${HOUSE_COLORS_CLASS[h]}"></span>
                <span class="text-[9px] font-black text-white">${houseCounts[h]}</span>
            </div>
        `).join('');
    });
    updateHouseInsights();
}

// async function applySnakeSort() {
//     const result = await Swal.fire({
//         title: 'ยืนยันการจัดห้องใหม่?',
//         text: "ระบบจะคำนวณ Snake Sort ตามคะแนน Pretest และล้างห้องเดิมออกทั้งหมด",
//         icon: 'warning',
//         showCancelButton: true,
//         confirmButtonText: 'ตกลง, จัดเลย!',
//         cancelButtonText: 'ยกเลิก'
//     });

//     if (!result.isConfirmed) return;

//     const roomCount = parseInt(document.getElementById('room-count').value);
//     renderRooms(roomCount);

//     // Logic: Snake Sort
//     const sorted = [...students].sort((a, b) => b.score - a.score);
//     let roomsData = Array.from({ length: roomCount }, () => []);
//     let forward = true;
//     let roomIdx = 0;

//     sorted.forEach(s => {
//         roomsData[roomIdx].push(s);
//         if (forward) {
//             if (roomIdx === roomCount - 1) forward = false;
//             else roomIdx++;
//         } else {
//             if (roomIdx === 0) forward = true;
//             else roomIdx--;
//         }
//     });

//     // --- จุดที่แก้ไข: เปลี่ยนจากเลข i+1 เป็นตัวอักษร A, B, C... ---
//     roomsData.forEach((roomStudents, i) => {
//         const letter = getRoomLetter(i + 1); // แปลง 1 เป็น A, 2 เป็น B...
//         const roomEl = document.getElementById(`room-${letter}`);
//         if (roomEl) {
//             roomEl.innerHTML = roomStudents.map(s => createStudentCard(s)).join('');
//         }
//     });

//     updateStats();
//     renderPool();
//     showToast("จัดห้องเรียนแบบ Snake Sort เรียบร้อย!");
// }

// ฟังก์ชันคลิกเพื่อย้ายห้อง


// ฟังก์ชันสำหรับจัดห้องแบบ Balanced (Rank Sum + Zig-Zag)
async function applyBalancedSort() {
    const result = await Swal.fire({
        title: 'ยืนยันการจัดห้องแบบ Balanced?',
        text: "ระบบจะคำนวณความเก่งของบ้านและแบ่งกลุ่มนักเรียนตามสูตร Zig-Zag เพื่อความเท่าเทียม",
        icon: 'info',
        showCancelButton: true,
        confirmButtonText: 'ตกลง, จัดเลย!',
        cancelButtonText: 'ยกเลิก'
    });

    if (!result.isConfirmed) return;

    // 1. คำนวณคะแนนเฉลี่ยของแต่ละบ้าน
    const houseStats = {};
    for (let i = 1; i <= 8; i++) houseStats[i] = { id: i, totalScore: 0, count: 0 };

    students.forEach(s => {
        if (houseStats[s.house]) {
            houseStats[s.house].totalScore += s.score;
            houseStats[s.house].count++;
        }
    });

    // 2. เรียงลำดับบ้านตามคะแนนเฉลี่ย (Rank 1 คือเก่งสุด)
    const rankedHouses = Object.values(houseStats)
        .map(h => ({ id: h.id, avg: h.count > 0 ? h.totalScore / h.count : 0 }))
        .sort((a, b) => b.avg - a.avg);

    // สร้าง Map เพื่อดูว่าบ้าน ID ไหน ได้อันดับที่เท่าไหร่ (0-indexed)
    const houseRankMap = {};
    rankedHouses.forEach((h, index) => { houseRankMap[h.id] = index + 1; });

    // 3. เตรียมห้องเรียน A-D
    renderRooms(4);
    const roomsData = { 'A': [], 'B': [], 'C': [], 'D': [] };

    // 4. จัดกลุ่มนักเรียนในแต่ละบ้านแบบ Zig-Zag (X และ Y)
    // แบ่งกลุ่มตาม House ID เพื่อแยกจัดการทีละบ้าน
    const studentsByHouse = {};
    students.forEach(s => {
        if (!studentsByHouse[s.house]) studentsByHouse[s.house] = [];
        studentsByHouse[s.house].push(s);
    });

    Object.keys(studentsByHouse).forEach(houseId => {
        // เรียงลำดับเด็กในบ้านนั้นๆ (เก่ง -> น้อย)
        const sortedInHouse = studentsByHouse[houseId].sort((a, b) => b.score - a.score);

        // ดึงอันดับของบ้านนี้ (1-8)
        const rank = houseRankMap[houseId];

        // แบ่งกลุ่ม X (อันดับ 1, 4, 5, 8, 9) และ Y (อันดับ 2, 3, 6, 7, 10)
        const groupX = [];
        const groupY = [];
        const xIndices = [0, 3, 4, 7, 8]; // Index 0-based ของ 1, 4, 5, 8, 9

        sortedInHouse.forEach((student, index) => {
            if (xIndices.includes(index)) groupX.push(student);
            else groupY.push(student);
        });

        // 5. กระจายกลุ่ม X, Y ลงห้อง A, B, C, D ตามเงื่อนไข Rank Sum Equality
        if (rank === 1) { roomsData['A'].push(...groupX); roomsData['B'].push(...groupY); }
        else if (rank === 4) { roomsData['B'].push(...groupX); roomsData['A'].push(...groupY); }
        else if (rank === 6) { roomsData['B'].push(...groupX); roomsData['A'].push(...groupY); }
        else if (rank === 7) { roomsData['A'].push(...groupX); roomsData['B'].push(...groupY); }

        else if (rank === 2) { roomsData['C'].push(...groupX); roomsData['D'].push(...groupY); }
        else if (rank === 3) { roomsData['D'].push(...groupX); roomsData['C'].push(...groupY); }
        else if (rank === 5) { roomsData['D'].push(...groupX); roomsData['C'].push(...groupY); }
        else if (rank === 8) { roomsData['C'].push(...groupX); roomsData['D'].push(...groupY); }
    });

    // 6. วาด Card ลงใน UI
    Object.keys(roomsData).forEach(letter => {
        const roomEl = document.getElementById(`room-${letter}`);
        if (roomEl) {
            roomEl.innerHTML = roomsData[letter].map(s => createStudentCard(s)).join('');
        }
    });

    updateStats();
    renderPool(); // ล้างคนออกจาก Pool

    // แสดงสรุปผล
    const houseRankOrder = rankedHouses.map((h, i) => `${i + 1}. บ้าน ${h.id}`).join('\n');
    Swal.fire('จัดห้องสำเร็จ!', `ลำดับความเก่งของบ้าน:\n${houseRankOrder}`, 'success');
}

async function showRoomSelector(studentId, studentName, nickname, house, score) {
    const card = document.querySelector(`.student-card[data-id="${studentId}"]`);
    const currentRoomId = card.parentElement.dataset.room;

    const roomNames = {
        'pool': 'รายการหลัก (Pool)',
        'A': 'ห้องเรียน A',
        'B': 'ห้องเรียน B',
        'C': 'ห้องเรียน C',
        'D': 'ห้องเรียน D'
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
    const rooms = ['A', 'B', 'C', 'D'];
    let gridButtons = rooms.map(roomLetter => {
        const isCurrent = currentRoomId === roomLetter;
        return `
            <button onclick="${isCurrent ? '' : `Swal.clickConfirm(); moveDirect('${studentId}', '${roomLetter}')`}" 
                class="p-5 rounded-2xl border-2 transition-all flex flex-col items-center 
                ${isCurrent ? 'bg-green-50 border-green-500' : 'bg-blue-50 border-blue-100 hover:bg-blue-600 hover:text-white'}">
                <span class="text-2xl mb-1">${isCurrent ? '✅' : '🏫'}</span>
                <span class="font-bold text-sm">ห้อง ${roomLetter}</span>
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

    // รวบรวมข้อมูลว่าใครอยู่ห้องไหนจากหน้าจอ
    document.querySelectorAll('.room-column').forEach(room => {
        const roomId = room.dataset.room;
        Array.from(room.children).forEach(card => {
            if (card.dataset.id) {
                sortingData[card.dataset.id] = roomId;
            }
        });
    });

    const count = Object.keys(sortingData).length;
    if (count === 0) return showToast("ยังไม่ได้จัดห้องเรียน", "error");

    const confirm = await Swal.fire({
        title: 'บันทึกการจัดห้อง?',
        text: `คุณกำลังจะอัปเดตห้องเรียนนักเรียน ${count} คน`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'บันทึกข้อมูล'
    });

    if (!confirm.isConfirmed) return;

    try {
        btn.innerText = "กำลังบันทึก...";
        btn.disabled = true;

        // อัปเดตไปที่กิ่ง students/{id}/classID
        const updates = {};
        for (let id in sortingData) {
            updates[`students/${id}/classID`] = sortingData[id];
        }

        await fetch(`${dbURL}.json?auth=${CONFIG.fbSecret}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });

        // ส่งไป Google Sheet (Sync)
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

        // อัปเดตค่าในตัวแปรหลักด้วย
        for (let id in sortingData) {
            const sIdx = students.findIndex(s => s.id === id);
            if (sIdx !== -1) students[sIdx].classID = sortingData[id];
        }

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


// --- [DEV TOOLS] ฟังก์ชันสำหรับสุ่มคะแนนนักเรียนทุกคน ---
async function devGenerateScores() {
    const confirm = await Swal.fire({
        title: 'สุ่มคะแนนนักเรียนทุกคน?',
        text: "ระบบจะสร้างคะแนน Pretest แบบสุ่ม (15-55 คะแนน) ให้กับนักเรียนทุกคนในฐานข้อมูล",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'เริ่มสุ่มคะแนน',
        cancelButtonText: 'ยกเลิก'
    });

    if (!confirm.isConfirmed) return;

    Swal.fire({ title: 'กำลังสุ่มคะแนน...', didOpen: () => Swal.showLoading() });

    try {
        const updates = {};
        students.forEach(s => {
            // สุ่มคะแนนรายวิชาตาม Limit จริง
            const p = Math.floor(Math.random() * 16); // 0-15
            const c = Math.floor(Math.random() * 16); // 0-15
            const b = Math.floor(Math.random() * 7);  // 0-6
            const d = Math.floor(Math.random() * 13); // 0-12
            const m = Math.floor(Math.random() * 13); // 0-12
            const total = p + c + b + d + m;

            updates[`scores/${s.id}/pretest`] = {
                physic: p,
                chemistry: c,
                biology: b,
                introdent: d,
                intromed: m,
                total: total,
                recordedBy: "System Debug",
                timestamp: new Date().toISOString()
            };
        });

        // ส่งข้อมูลไป Firebase (ใช้ PATCH เพื่ออัปเดตหลายจุดพร้อมกัน)
        await fetch(`${CONFIG.firebaseURL}.json?auth=${CONFIG.fbSecret}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });

        await Swal.fire('สุ่มคะแนนสำเร็จ!', 'กรุณารอสักครู่ ระบบกำลังรีโหลดข้อมูลใหม่', 'success');
        location.reload(); // รีโหลดเพื่อให้ข้อมูลในตัวแปร students อัปเดตตาม Firebase
    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'ไม่สามารถสุ่มคะแนนได้', 'error');
    }
}

// --- [DEV TOOLS] ฟังก์ชันสำหรับล้างคะแนน Pretest ทั้งหมด ---
async function devClearScores() {
    const confirm = await Swal.fire({
        title: 'ล้างคะแนนทั้งหมด?',
        text: "คะแนน Pretest ของนักเรียนทุกคนจะหายไปจากระบบถาวร",
        icon: 'danger',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'ยืนยันลบทั้งหมด',
        cancelButtonText: 'ยกเลิก'
    });

    if (!confirm.isConfirmed) return;

    Swal.fire({ title: 'กำลังล้างข้อมูล...', didOpen: () => Swal.showLoading() });

    try {
        const updates = {};
        students.forEach(s => {
            updates[`scores/${s.id}/pretest`] = null; // ตั้งค่าเป็น null เพื่อลบออก
        });

        await fetch(`${CONFIG.firebaseURL}.json?auth=${CONFIG.fbSecret}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });

        await Swal.fire('ล้างข้อมูลสำเร็จ!', 'คะแนน Pretest ถูกลบทั้งหมดแล้ว', 'success');
        location.reload();
    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'ไม่สามารถล้างข้อมูลได้', 'error');
    }
}