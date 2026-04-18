// ฟังก์ชันช่วยสร้าง Session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// --- [1] Login สำหรับนักเรียน (ID, House, Nickname) ---
async function loginStudent(id, house, nickname) {
    try {
        const response = await fetch(`${CONFIG.firebaseURL}students/${id}.json?auth=${CONFIG.fbSecret}`);
        const student = await response.json();

        if (student && student.house.toString() === house.toString() && student.nickname.trim() === nickname.trim()) {

            const newSessionId = generateSessionId();

            // อัปเดต Session ล่าสุดลง Firebase (ทับของเก่าทันที = เข้าได้เครื่องเดียว)
            await fetch(`${CONFIG.firebaseURL}active_logins/${id}.json?auth=${CONFIG.fbSecret}`, {
                method: "PUT",
                body: JSON.stringify({
                    sessions: [newSessionId],
                    lastLogin: Date.now()
                })
            });

            const sessionData = { ...student, userType: 'student', sessionId: newSessionId };
            localStorage.setItem("userSession", JSON.stringify(sessionData));
            return { success: true, data: sessionData };
        } else {
            return { success: false, message: "ข้อมูลไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เชื่อมต่อล้มเหลว" };
    }
}

// --- [2] Login สำหรับสตาฟ (StudentID, Password) ---
async function loginStaff(studentID, password) {
    try {
        const response = await fetch(`${CONFIG.firebaseURL}staff/${studentID}.json?auth=${CONFIG.fbSecret}`);
        const staff = await response.json();

        if (staff && staff.password === password) {
            const newSessionId = generateSessionId();
            const isStaff = staff.role === 'Admin' || staff.role === 'Staff';

            if (isStaff) {
                // ดึงรายการ Session เดิมของสตาฟ
                const loginResp = await fetch(`${CONFIG.firebaseURL}active_logins/${studentID}.json?auth=${CONFIG.fbSecret}`);
                const loginData = await loginResp.json();
                let sessions = (loginData && loginData.sessions) ? loginData.sessions : [];

                // ถ้าเกิน 2 เครื่อง ให้เอาเครื่องเก่าที่สุดออก (FIFO)
                sessions.push(newSessionId);
                if (sessions.length > 2) {
                    sessions.shift();
                }

                await fetch(`${CONFIG.firebaseURL}active_logins/${studentID}.json?auth=${CONFIG.fbSecret}`, {
                    method: "PUT",
                    body: JSON.stringify({ sessions: sessions, lastLogin: Date.now() })
                });
            }

            const sessionData = { ...staff, userType: 'staff', sessionId: newSessionId };
            localStorage.setItem("userSession", JSON.stringify(sessionData));
            return { success: true, data: sessionData };
        } else {
            return { success: false, message: "รหัสผ่านไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เชื่อมต่อล้มเหลว" };
    }
}

// --- [3] ฟังก์ชันตรวจสอบ Session ปัจจุบัน (สำหรับทุกหน้า) ---
async function validateCurrentSession() {
    const session = JSON.parse(localStorage.getItem("userSession"));

    // 1. ถ้าไม่มี Session ในเครื่องเลย
    if (!session) return false;

    // 2. ถ้าเป็น Admin ให้ผ่านตลอด (ตามโจทย์)
    if (session.role === 'Admin') return true;

    try {
        const id = session.id || session.studentID;
        const response = await fetch(`${CONFIG.firebaseURL}active_logins/${id}.json?auth=${CONFIG.fbSecret}`);
        const loginData = await response.json();

        // 3. ตรวจสอบว่า sessionId ในเครื่อง ยังอยู่ในลิสต์ที่ Firebase ยอมรับหรือไม่
        if (loginData && loginData.sessions && loginData.sessions.includes(session.sessionId)) {
            return true;
        }
        return false; // ถูกเตะ (เพราะมีคนอื่น Login ทับ)
    } catch (e) {
        return true; // ถ้าเน็ตหลุดชั่วคราวให้ผ่านไปก่อน
    }
}

// --- [4] เปลี่ยนรหัสผ่านสตาฟ ---
async function resetStaffPassword(id, name, nick, year, faculty, newPassword) {
    try {
        // 1. ตรวจสอบตัวตนสตาฟจาก Firebase ก่อน
        const response = await fetch(`${CONFIG.firebaseURL}staff/${id}.json?auth=${CONFIG.fbSecret}`);
        const staff = await response.json();

        if (staff &&
            staff.fullName === name &&
            staff.nickname === nick &&
            staff.year.toString() === year.toString() &&
            staff.faculty === faculty) {

            // 2. อัปเดตที่ Firebase
            await fetch(`${CONFIG.firebaseURL}staff/${id}/password.json?auth=${CONFIG.fbSecret}`, {
                method: "PUT",
                body: JSON.stringify(newPassword)
            });

            // 3. (จุดสำคัญ) อัปเดตกลับไปที่ Google Sheet ผ่าน Apps Script
            // เราจะรอให้การ Fetch สำเร็จเพื่อความชัวร์
            await fetch(CONFIG.appscriptUrl, {
                method: "POST",
                mode: "no-cors", // สำคัญมาก: ป้องกันปัญหา CORS
                headers: {
                    "Content-Type": "text/plain",
                },
                body: JSON.stringify({
                    action: "updateStaffPassword",
                    key: CONFIG.syncKey,
                    id: id.toString().trim(),
                    newPassword: newPassword.toString().trim()
                })
            });

            return { success: true };
        } else {
            return { success: false, message: "ข้อมูลยืนยันตัวตนไม่ถูกต้อง" };
        }
    } catch (e) {
        console.error("Sync Error:", e);
        return { success: false, message: "เกิดข้อผิดพลาดในการเชื่อมต่อ" };
    }
}

// --- [5] ฟังก์ชันตรวจสอบ Session ---
function checkAuth() {
    const session = localStorage.getItem("userSession");
    return session ? JSON.parse(session) : null;
}

// --- [6] ฟังก์ชัน Logout ---
function logout() {
    localStorage.removeItem("userSession");
    window.location.href = (window.location.pathname.includes('pages/')) ? 'login.html' : 'pages/login.html';
}