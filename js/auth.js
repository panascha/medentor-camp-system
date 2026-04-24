// ฟังก์ชันช่วยสร้าง Session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// --- [1] Login สำหรับนักเรียน (ให้เข้าได้แค่เครื่องเดียว) ---
window.loginStudent = async function (id, house, nickname) {
    try {
        const response = await fetch(`${CONFIG.firebaseURL}students/${id}.json?auth=${CONFIG.fbSecret}`);
        const student = await response.json();

        if (student && student.house.toString() === house.toString() && student.nickname.trim() === nickname.trim()) {
            const newSessionId = generateSessionId();
            const loginTime = Date.now();

            // อัปเดต Firebase: บังคับให้เหลือ Session เดียว (Array มีค่าเดียว)
            // เมื่อค่านี้เปลี่ยน เครื่องเก่าที่ "ฟัง" อยู่จะรู้ทันทีว่า Session ตัวเองไม่อยู่ใน List แล้ว
            await fetch(`${CONFIG.firebaseURL}active_logins/${id}.json?auth=${CONFIG.fbSecret}`, {
                method: "PUT",
                body: JSON.stringify({
                    sessions: [newSessionId],
                    lastLogin: Date.now()
                })
            });

            const sessionData = { ...student, userType: 'student', sessionId: newSessionId, loginTime: loginTime };
            localStorage.setItem("userSession", JSON.stringify(sessionData));
            return { success: true, data: sessionData };
        } else {
            return { success: false, message: "ข้อมูลไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เชื่อมต่อล้มเหลว" };
    }
}

// --- [2] Login สำหรับสตาฟ (ให้เข้าได้สูงสุด 2 เครื่อง) ---
window.loginStaff = async function (studentID, password) {
    try {
        const response = await fetch(`${CONFIG.firebaseURL}staff/${studentID}.json?auth=${CONFIG.fbSecret}`);
        const staff = await response.json();

        if (staff && staff.password === password) {
            const newSessionId = generateSessionId();
            const loginTime = Date.now();

            const loginResp = await fetch(`${CONFIG.firebaseURL}active_logins/${studentID}.json?auth=${CONFIG.fbSecret}`);
            const loginData = await loginResp.json();
            let sessions = (loginData && loginData.sessions) ? loginData.sessions : [];

            sessions.push(newSessionId);

            // ถ้าเกิน 2 เครื่อง (Browser) ให้เตะเครื่องที่เก่าที่สุดออก (FIFO)
            if (sessions.length > 2) {
                sessions.shift();
            }

            await fetch(`${CONFIG.firebaseURL}active_logins/${studentID}.json?auth=${CONFIG.fbSecret}`, {
                method: "PUT",
                body: JSON.stringify({
                    sessions: sessions,
                    lastLogin: Date.now(),
                })
            });

            const sessionData = { ...staff, userType: 'staff', sessionId: newSessionId, loginTime: loginTime };
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
window.validateCurrentSession = async function () {
    const session = JSON.parse(localStorage.getItem("userSession"));

    if (!session) return false;

    const TWENTY_HOURS = 20 * 60 * 60 * 1000;
    if (Date.now() - session.loginTime > TWENTY_HOURS) {
        console.warn("Session expired (20 hours limit)");
        return false;
    }

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
window.resetStaffPassword = async function (id, name, nick, year, faculty, newPassword) {
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
window.checkAuth = function () {
    const session = localStorage.getItem("userSession");
    return session ? JSON.parse(session) : null;
}

// --- [6] ฟังก์ชัน Logout ---
window.logout = function () {
    localStorage.removeItem("userSession");
    window.location.href = (window.location.pathname.includes('pages/')) ? 'login.html' : 'pages/login.html';
}