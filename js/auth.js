// ตั้งค่า Firebase URL (ดึงจาก config ที่คุณตั้งไว้)
const firebaseDbUrl = "https://medentor-response-project-default-rtdb.asia-southeast1.firebasedatabase.app/";

// --- [1] Login สำหรับนักเรียน (ID, House, Nickname) ---
async function loginStudent(id, house, nickname) {
    try {
        const response = await fetch(`${firebaseDbUrl}students/${id}.json`);
        const student = await response.json();

        if (student && 
            student.house.toString() === house.toString() && 
            student.nickname.trim() === nickname.trim()) {
            
            const sessionData = { ...student, userType: 'student' };
            localStorage.setItem("userSession", JSON.stringify(sessionData));
            return { success: true, data: sessionData };
        } else {
            return { success: false, message: "รหัส, บ้าน หรือชื่อเล่นไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เชื่อมต่อฐานข้อมูลล้มเหลว" };
    }
}

// --- [2] Login สำหรับสตาฟ (StudentID, Password) ---
async function loginStaff(studentID, password) {
    try {
        const response = await fetch(`${firebaseDbUrl}staff/${studentID}.json`);
        const staff = await response.json();

        if (staff && staff.password === password) {
            const sessionData = { ...staff, userType: 'staff' };
            localStorage.setItem("userSession", JSON.stringify(sessionData));
            return { success: true, data: sessionData };
        } else {
            return { success: false, message: "รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เชื่อมต่อฐานข้อมูลล้มเหลว" };
    }
}

// --- [3] เปลี่ยนรหัสผ่านสตาฟ ---
async function resetStaffPassword(id, name, nick, year, faculty, newPassword) {
    try {
        const response = await fetch(`${firebaseDbUrl}staff/${id}.json`);
        const staff = await response.json();

        if (staff && 
            staff.fullName === name && 
            staff.nickname === nick && 
            staff.year.toString() === year.toString() && 
            staff.faculty === faculty) {
            
            await fetch(`${firebaseDbUrl}staff/${id}/password.json`, {
                method: "PUT",
                body: JSON.stringify(newPassword)
            });
            return { success: true };
        } else {
            return { success: false, message: "ข้อมูลยืนยันตัวตนไม่ถูกต้อง" };
        }
    } catch (e) {
        return { success: false, message: "เกิดข้อผิดพลาด" };
    }
}

// --- [4] ฟังก์ชันตรวจสอบ Session ---
function checkAuth() {
    const session = localStorage.getItem("userSession");
    return session ? JSON.parse(session) : null;
}

function logout() {
    localStorage.removeItem("userSession");
    window.location.href = "login.html";
}