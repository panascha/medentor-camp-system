import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { goOnline, goOffline, getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

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
    if (!session) return;

    // หมายเหตุ: ถ้าไม่ต้องการให้ Admin โดนเตะ ให้ใส่บรรทัดนี้:
    // if (session.role === 'Admin') return;

    const id = session.id || session.studentID;
    const loginRef = ref(db, `active_logins/${id}`);

    // ฟังการเปลี่ยนแปลงข้อมูลกิ่งนี้
    onValue(loginRef, (snapshot) => {
        const data = snapshot.val();
        // ดึงข้อมูล session ปัจจุบันในเครื่องมาเทียบอีกครั้ง
        const currentLocal = JSON.parse(localStorage.getItem("userSession"));

        if (data && data.sessions && currentLocal) {
            // ถ้า sessionId ของเครื่องเรา ไม่อยู่ในรายชื่อที่ Firebase อนุญาตแล้ว
            if (!data.sessions.includes(currentLocal.sessionId)) {

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
            }
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