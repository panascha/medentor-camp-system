// js/utils.js
import { goOnline, goOffline } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// [1] ระบบจัดการ Connection (Quota Saved)
window.setupConnectionManager = function (db) {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            goOnline(db);
        } else {
            goOffline(db);
        }
    });
};

// [2] ระบบ Toast Notification
window.showToast = function (message, type = 'success') {
    const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true
    });
    Toast.fire({ icon: type, title: message });
};

// [3] ระบบตรวจสอบ Concurrent Login (เตะเครื่องเก่า)
async function validateCurrentSession() {
    const session = JSON.parse(localStorage.getItem("userSession"));
    if (!session) return false;
    if (session.role === 'Admin') return true; // Admin เข้าได้ไม่จำกัด

    try {
        const id = session.id || session.studentID;
        // ใช้ fetch ตรงไปที่ Firebase (firebaseDbUrl และ fbSecret ต้องถูกประกาศใน auth.js หรือเป็น Global)
        const response = await fetch(`${firebaseDbUrl}active_logins/${id}.json?auth=${fbSecret}`);
        const loginData = await response.json();

        if (loginData && loginData.sessions && loginData.sessions.includes(session.sessionId)) {
            return true;
        }
        return false;
    } catch (e) {
        return true; // ถ้าเน็ตหลุดให้ยอมให้เล่นต่อก่อน
    }
}

// [4] ฟังก์ชันป้องกันหน้า (Protect Page)
window.protectPage = async function () {
    const session = JSON.parse(localStorage.getItem("userSession"));
    const isLoginPage = window.location.pathname.includes('login.html');

    if (!session) {
        if (!isLoginPage) {
            window.location.href = window.location.pathname.includes('pages/') ? 'login.html' : 'pages/login.html';
        }
        return;
    }

    if (isLoginPage && session) {
        window.location.href = '../index.html';
        return;
    }

    // ตรวจสอบว่าโดน Login ซ้อนไหม
    const isValid = await validateCurrentSession();
    if (!isValid) {
        await Swal.fire({
            title: 'ถูกออกจากระบบ',
            text: 'บัญชีนี้มีการเข้าสู่ระบบจากอุปกรณ์อื่น',
            icon: 'warning',
            confirmButtonText: 'ตกลง'
        });
        logout(); // ฟังก์ชัน logout() จาก auth.js
    }
};

// รันการตรวจสอบทันทีเมื่อโหลดหน้าจอ
protectPage();

// ตรวจสอบซ้ำทุก 1 นาที
setInterval(async () => {
    if (!window.location.pathname.includes('login.html')) {
        const isValid = await validateCurrentSession();
        if (!isValid) {
            window.location.reload(); // ให้ protectPage ทำงานตอนรีโหลด
        }
    }
}, 10000); // ทุก 10 วินาที