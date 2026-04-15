// ต้องมีบรรทัด import นี้ที่หัวไฟล์
import { goOnline, goOffline } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// แนบฟังก์ชันไว้กับ window เพื่อให้ scoring-logic.js มองเห็น
window.setupConnectionManager = function (db) {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            goOnline(db);
            console.log("⚡ Connection: Active");
        } else {
            goOffline(db);
            console.log("💤 Connection: Offline (Quota Saved)");
        }
    });
};

// แนบฟังก์ชันอื่นๆ ไว้กับ window ด้วย
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

window.setupFuzzySearch = function (studentList) {
    const options = {
        keys: ['fullName', 'nickname', 'id'],
        threshold: 0.3
    };
    return new Fuse(studentList, options);
};