// ฟังก์ชันช่วยแสดงแจ้งเตือน (Toast) แทน Alert เพื่อความสวยงาม
function showToast(message, type = 'success') {
    const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        didOpen: (toast) => {
            toast.addEventListener('mouseenter', Swal.stopTimer)
            toast.addEventListener('mouseleave', Swal.resumeTimer)
        }
    });

    Toast.fire({
        icon: type,
        title: message
    });
}

// ระบบ Fuzzy Search สำหรับค้นหานักเรียน
function setupFuzzySearch(studentList) {
    const options = {
        keys: ['fullName', 'nickname', 'id'],
        threshold: 0.3 // ยิ่งน้อยยิ่งต้องแม่นยำ (0.0 - 1.0)
    };
    return new Fuse(studentList, options);
}