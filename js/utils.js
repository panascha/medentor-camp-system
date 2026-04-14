// ฟังก์ชันช่วยแสดงแจ้งเตือน (Toast) แทน Alert เพื่อความสวยงาม
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-5 right-5 px-6 py-3 rounded-lg text-white font-bold z-50 transition-opacity duration-500 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'}`;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
}

// ระบบ Fuzzy Search สำหรับค้นหานักเรียน
function setupFuzzySearch(studentList) {
    const options = {
        keys: ['fullName', 'nickname', 'id'],
        threshold: 0.3 // ยิ่งน้อยยิ่งต้องแม่นยำ (0.0 - 1.0)
    };
    return new Fuse(studentList, options);
}