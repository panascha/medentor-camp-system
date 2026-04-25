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

    // 1. ตรวจสอบว่ามี Session หรือไม่
    if (!sessionStr) {
        console.log("[Session] No userSession found.");
        return;
    }

    const currentLocal = JSON.parse(sessionStr);
    const id = currentLocal.id || currentLocal.studentID;
    const sessionId = currentLocal.sessionId;
    const loginTime = currentLocal.loginTime;

    // ตั้งค่าเวลา (ปรับเป็น TEN_SECONDS ได้หากต้องการทดสอบ)
    const SESSION_LIMIT = 20 * 60 * 60 * 1000;

    // 2. ฟังก์ชันช่วยสำหรับการเตะออก (Force Logout)
    const forceLogout = (title, reason) => {
        // ป้องกันการเรียกซ้ำถ้าถูกเตะออกไปแล้ว
        if (!localStorage.getItem("userSession")) return;

        console.warn(`[Session] Kicking out: ${reason}`);
        localStorage.removeItem("userSession");

        Swal.fire({
            title: title,
            text: reason,
            icon: 'warning',
            confirmButtonText: 'ตกลง',
            allowOutsideClick: false
        }).then(() => {
            const isInsidePages = window.location.pathname.includes('pages/');
            window.location.href = isInsidePages ? 'login.html' : 'pages/login.html';
        });
    };

    // 3. ตรวจสอบข้อมูลเบื้องต้น
    if (!id || !sessionId || !loginTime) {
        console.error("[Session] Session data is incomplete.");
        return;
    }

    // 4. ระบบคำนวณเวลานับถอยหลัง (เพื่อให้เตะออกทันทีแม้ไม่ได้ขยับหน้าจอ)
    const timeElapsed = Date.now() - loginTime;
    const timeRemaining = SESSION_LIMIT - timeElapsed;

    if (timeRemaining <= 0) {
        forceLogout('เซสชั่นหมดอายุ', 'คุณอยู่ในระบบนานเกินกำหนด กรุณาเข้าสู่ระบบใหม่เพื่อความปลอดภัย');
        return;
    } else {
        // สั่งให้ทำงานอัตโนมัติเมื่อครบเวลาที่เหลือพอดี
        setTimeout(() => {
            forceLogout('เซสชั่นหมดอายุ', 'หมดระยะเวลาใช้งาน 20 ชั่วโมงแล้ว กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
        }, timeRemaining);

        console.log(`[Session] ระบบจะเตะออกอัตโนมัติในอีก ${Math.round(timeRemaining / 1000)} วินาที`);
    }

    console.log(`[Session] START Monitoring for ID: ${id} (SID: ${sessionId})`);

    // 5. ฟังข้อมูลจาก Firebase (เพื่อดูการ Login ซ้ำซ้อน)
    const loginRef = ref(db, `active_logins/${id}`);
    onValue(loginRef, (snapshot) => {
        const data = snapshot.val();

        if (data && data.sessions) {
            // ตรวจสอบว่า sessionId ยังคง valid หรือไม่ (ถูกคนอื่นเตะหรือไม่)
            const isStillValid = data.sessions.includes(sessionId);

            if (!isStillValid) {
                forceLogout('เซสชั่นซ้ำซ้อน', 'มีการเข้าสู่ระบบจากอุปกรณ์อื่น (ระบบอนุญาตให้ใช้อุปกรณ์ล่าสุดเท่านั้น)');
            } else {
                console.log("[Session] Connection is still valid.");
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