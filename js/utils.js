// js/utils.js
import { goOnline, goOffline, getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

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

    try {
        const id = session.id || session.studentID;
        const response = await fetch(`${CONFIG.firebaseURL}active_logins/${id}.json?auth=${CONFIG.fbSecret}`);
        const loginData = await response.json();

        if (loginData && loginData.sessions && loginData.sessions.includes(session.sessionId)) {
            return true;
        }
        return false;
    } catch (e) {
        return true; // ถ้าเน็ตหลุดให้ยอมให้เล่นต่อก่อน
    }
}

// ระบบตรวจสอบการเชื่อมต่อ (Online/Offline)
function startSessionListener() {
    const session = JSON.parse(localStorage.getItem("userSession"));

    const id = session.id || session.studentID;
    // ใช้ db จาก window ที่ classroom-logic.js สร้างไว้ หรือสร้างใหม่ถ้ายังไม่มี
    const database = window.db || getDatabase();
    const loginRef = ref(database, `active_logins/${id}`);

    // ฟังการเปลี่ยนแปลงข้อมูลกิ่งนี้
    onValue(loginRef, async (snapshot) => {
        const data = snapshot.val();

        // ถ้ามีข้อมูลใน Firebase แต่ไม่มี Session ID ปัจจุบันของเราอยู่ในลิสต์
        if (data && data.sessions && !data.sessions.includes(session.sessionId)) {

            // ปิดการดักฟังเพื่อไม่ให้รันซ้ำ
            // (onValue จะหยุดทำงานเมื่อเราเปลี่ยนหน้าหรือ logout)

            localStorage.removeItem("userSession");

            await Swal.fire({
                title: 'เซสชั่นหมดอายุ',
                text: 'มีการเข้าสู่ระบบจากอุปกรณ์อื่น บัญชีของคุณในเครื่องนี้จะถูกออกจากระบบ',
                icon: 'error',
                confirmButtonText: 'ตกลง',
                allowOutsideClick: false
            });

            // ดีดกลับหน้า Login
            window.location.href = window.location.pathname.includes('pages/') ? 'login.html' : 'pages/login.html';
        }
    });
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

    // ตรวจสอบความถูกต้องของ Session กับ Firebase
    startSessionListener();

};

// รันการตรวจสอบทันทีเมื่อโหลดหน้าจอ
protectPage();

// ตรวจสอบซ้ำทุก 1 นาที
