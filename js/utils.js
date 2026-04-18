import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { goOnline, goOffline, getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

if (typeof CONFIG === 'undefined') {
    console.log("CONFIG is not defined. Make sure firebase-config.js is loaded before utils.js");
}

console.log("[System] Utils.js Loaded & Firebase Initialized");

const app = initializeApp({ databaseURL: CONFIG.firebaseURL });
const db = getDatabase(app);

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

// ระบบตรวจสอบการเชื่อมต่อ (Online/Offline)
function startSessionListener() {
    const sessionStr = localStorage.getItem("userSession");

    // ถ้าไม่มี Session ในเครื่อง ให้หยุดทำงานทันที
    if (!sessionStr) {
        console.log("[Session] No userSession found in localStorage.");
        return;
    }

    const currentLocal = JSON.parse(sessionStr);
    const id = currentLocal.id || currentLocal.studentID;

    if (!id || !currentLocal.sessionId) {
        console.error("[Session] Session data is incomplete:", currentLocal);
        return;
    }

    console.log(`[Session] START Monitoring for ID: ${id} (SID: ${currentLocal.sessionId})`);

    const loginRef = ref(db, `active_logins/${id}`);

    // ดึงข้อมูล Real-time
    onValue(loginRef, (snapshot) => {
        const data = snapshot.val();
        console.log("[Session] Data received from Firebase:", data);

        if (data && data.sessions) {
            const isStillValid = data.sessions.includes(currentLocal.sessionId);

            if (!isStillValid) {
                console.warn("[Session] INVALID SESSION! Kicking out...");

                localStorage.removeItem("userSession");

                Swal.fire({
                    title: 'เซสชั่นหมดอายุ',
                    text: 'มีการเข้าสู่ระบบจากอุปกรณ์อื่น (จำกัด 1 เครื่องสำหรับน้อง / 2 เครื่องสำหรับพี่)',
                    icon: 'warning',
                    confirmButtonText: 'ตกลง',
                    allowOutsideClick: false
                }).then(() => {
                    const isInsidePages = window.location.pathname.includes('pages/');
                    window.location.href = isInsidePages ? 'login.html' : 'pages/login.html';
                });
            } else {
                console.log("[Session] Session is still valid.");
            }
        }
    }, (error) => {
        console.error("[Session] Firebase Listener Error:", error);
    });
}

// [4] ฟังก์ชันป้องกันหน้า (Protect Page)
window.protectPage = async function () {
    const session = JSON.parse(localStorage.getItem("userSession"));
    const isLoginPage = window.location.pathname.includes('login.html');

    if (!session) {
        if (!isLoginPage) {
            const isInsidePages = window.location.pathname.includes('pages/');
            window.location.href = isInsidePages ? 'login.html' : 'pages/login.html';
        }
        return;
    }

    if (isLoginPage && session) {
        window.location.href = '../index.html';
        return;
    }

    // เริ่มการดักฟังการ Login ซ้ำซ้อนทันทีที่โหลดหน้า
    startSessionListener();
};

// รันการตรวจสอบทันทีเมื่อโหลดหน้าจอ
protectPage();

window.db = db;