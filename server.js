// ================= CÁC THƯ VIỆN CẦN DÙNG =================
const path = require('node:path')
const fs = require('node:fs') // Thư viện Node.js quản lý tệp tin (Được thêm để lưu ảnh)
const fastify = require('fastify')({ logger: true })
const bcrypt = require('bcrypt')
const { ObjectId } = require('mongodb')

// NOTE: Cấu hình tọa độ check-in của công ty nằm ở đây.
// Khi cần đổi địa điểm chấm công, chỉ cần sửa companyLatitude, companyLongitude và allowedRadiusMeters.
// Có thể đổi trực tiếp giá trị mặc định bên dưới hoặc truyền qua biến môi trường COMPANY_LATITUDE, COMPANY_LONGITUDE, ATTENDANCE_RADIUS_METERS.
const ATTENDANCE_SETTINGS = {
  companyName: process.env.COMPANY_NAME || 'SPS System',
  companyLatitude: Number(process.env.COMPANY_LATITUDE || '21.00351'),
  companyLongitude: Number(process.env.COMPANY_LONGITUDE || '105.93781'),
  allowedRadiusMeters: Number(process.env.ATTENDANCE_RADIUS_METERS || '150')
}

const STANDARD_WORK_DAYS = 26

function calculateSalaryByAttendance(baseSalary, attendanceDays, bonus, advance) {
  return Math.round((Number(baseSalary || 0) / STANDARD_WORK_DAYS) * Number(attendanceDays || 0) + Number(bonus || 0) - Number(advance || 0))
}


// ================= CÁC PLUGINS CẦN DÙNG =================
// Cho phép đọc dữ liệu từ form (method POST thông thường)
fastify.register(require('@fastify/formbody'))

// Đăng ký xử lý tải tệp tin (Được thêm để xử lý multipart/form-data)
fastify.register(require('@fastify/multipart'), {
  addToBody: true // Tự động chuyển các trường text thông thường vào req.body để quản lý thuận tiện
})

// Quản lý cookie (lưu token đăng nhập)
fastify.register(require('@fastify/cookie'))

// JWT: tạo và xác thực token đăng nhập
fastify.register(require('@fastify/jwt'), {
  secret: 'secret123' // khóa bí mật để ký token
})

// Kết nối MongoDB (database: company)
fastify.register(require('@fastify/mongodb'), {
  url: 'mongodb://127.0.0.1:27017/company'
})

// Cấu hình template engine Pug để render giao diện
fastify.register(require('@fastify/view'), {
  engine: { pug: require('pug') },
  root: path.join(__dirname, 'views') // thư mục chứa file .pug
})

// Cho phép load file tĩnh (CSS, JS, ảnh)
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/' // truy cập qua /public/...
})


// ================= MIDDLEWARES (Hàm chạy trước khi vào chương trình chính) =================

// Middleware kiểm tra đăng nhập
async function auth(req, reply) {
  try {
    // Lấy token từ cookie
    const token = req.cookies.token

    // Xác thực token → nếu hợp lệ sẽ decode ra thông tin user
    req.user = fastify.jwt.verify(token)

  } catch (err) {
    // Nếu lỗi → chưa đăng nhập → chuyển về login
    return reply.redirect('/login')
  }
}

// Middleware kiểm tra quyền admin
function isAdmin(req, reply, done) {
  // Nếu không phải admin → chặn
  if (req.user.role !== 'admin') {
    return reply.status(403).send('❌ Bạn không có quyền thực hiện hành động này')
  }
  done() // hợp lệ → cho đi tiếp
}

function isAttendanceLocationConfigured() {
  return Number.isFinite(ATTENDANCE_SETTINGS.companyLatitude)
    && Number.isFinite(ATTENDANCE_SETTINGS.companyLongitude)
    && ATTENDANCE_SETTINGS.companyLatitude !== 0
    && ATTENDANCE_SETTINGS.companyLongitude !== 0
}

function toRadians(value) {
  return (value * Math.PI) / 180
}

function calculateDistanceMeters(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const earthRadiusMeters = 6371000
  const latitudeDelta = toRadians(toLatitude - fromLatitude)
  const longitudeDelta = toRadians(toLongitude - fromLongitude)

  const a = Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2)
    + Math.cos(toRadians(fromLatitude))
    * Math.cos(toRadians(toLatitude))
    * Math.sin(longitudeDelta / 2)
    * Math.sin(longitudeDelta / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return Math.round(earthRadiusMeters * c)
}

function normalizeObjectId(value) {
  if (!value) {
    return null
  }

  if (value instanceof ObjectId) {
    return value
  }

  if (ObjectId.isValid(value)) {
    return new ObjectId(value)
  }

  return null
}

function getWorkDate(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10)
}

function getDateRangeForWorkDate(workDate) {
  const startDate = new Date(`${workDate}T00:00:00.000Z`)
  const endDate = new Date(`${workDate}T23:59:59.999Z`)
  return { startDate, endDate }
}

function buildAttendanceRedirect(reply, type, message) {
  return reply.redirect(`/attendance?${type}=${encodeURIComponent(message)}`)
}

// Hàm lưu ảnh chấm công từ base64 thành file thật trong /public/uploads.
// Nếu dữ liệu ảnh không hợp lệ thì trả về chuỗi rỗng để route phía trên tự báo lỗi.
function saveBase64Image(dataUrl, targetFolder) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return ''
  }

  const matchedImage = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!matchedImage) {
    return ''
  }

  const [, mimeType, rawBase64] = matchedImage
  const extensionMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }
  const extension = extensionMap[mimeType] || 'png'
  const uploadDir = path.join(__dirname, 'public', 'uploads', targetFolder)

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true })
  }

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
  const filePath = path.join(uploadDir, filename)
  fs.writeFileSync(filePath, Buffer.from(rawBase64, 'base64'))

  return `/public/uploads/${targetFolder}/${filename}`
}

async function findEmployeeByUserId(userId, username) {
  const normalizedUserId = normalizeObjectId(userId)
  if (!normalizedUserId) {
    return null
  }

  // Bước 1: thử tìm hồ sơ nhân viên đã liên kết chuẩn bằng userId.
  const employeesCollection = fastify.mongo.db.collection('employees')
  const linkedEmployee = await employeesCollection.findOne({ userId: normalizedUserId })

  if (linkedEmployee) {
    return linkedEmployee
  }

  // Bước 2: fallback cho dữ liệu cũ chưa nối userId.
  // Quy ước hiện tại: username của tài khoản nhân viên có thể trùng với employeeCode/code/maNV.
  const normalizedUsername = String(username || '').trim()
  if (!normalizedUsername) {
    return null
  }

  return employeesCollection.findOne({
    $or: [
      { employeeCode: normalizedUsername },
      { code: normalizedUsername },
      { maNV: normalizedUsername }
    ]
  })
}

async function enrichAttendanceRecords(records) {
  // Hàm này dùng để bổ sung tên nhân viên, workDate và text hiển thị cho bảng chấm công.
  // Mục tiêu là view không phải tự suy luận lại dữ liệu thô từ DB.
  const employeeIds = records
    .map(record => normalizeObjectId(record.employeeId))
    .filter(Boolean)

  const uniqueEmployeeIds = [...new Map(employeeIds.map(id => [id.toString(), id])).values()]
  const employees = uniqueEmployeeIds.length > 0
    ? await fastify.mongo.db.collection('employees').find({ _id: { $in: uniqueEmployeeIds } }).toArray()
    : []

  const employeeMap = new Map(employees.map(employee => [employee._id.toString(), employee]))

  return records.map(record => {
    const employeeId = normalizeObjectId(record.employeeId)
    const employee = employeeId ? employeeMap.get(employeeId.toString()) : null
    const workDate = record.workDate || (record.date instanceof Date
      ? getWorkDate(record.date)
      : String(record.date || ''))

    return {
      ...record,
      employeeName: record.employeeName || employee?.name || 'Chưa rõ nhân viên',
      workDate,
      checkInDisplay: record.checkInAt ? new Date(record.checkInAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'Chưa check-in',
      checkOutDisplay: record.checkOutAt ? new Date(record.checkOutAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'Chưa check-out',
      distanceDisplay: record.location?.distanceMeters != null ? `${record.location.distanceMeters} m` : 'N/A'
    }
  })
}


// ================= ROUTES HỆ THỐNG =================
// Các route bên dưới đang đi theo mô hình "một file quản lý toàn bộ hệ thống".
// Khi sửa một khối lớn, nên kiểm tra luôn các khối có dùng chung helper như salary, attendance, employees.

// Trang gốc → chuyển về login
fastify.get('/', async (req, reply) => {  
  reply.redirect('/login')
})


// ================= ĐĂNG KÝ (Chuyển thành Admin tạo tài khoản) =================
// Luồng hiện tại:
// - Chỉ admin được tạo tài khoản.
// - Sau khi tạo user, hệ thống vẫn tạo thêm 1 employee placeholder.
// - Đây là điểm cần lưu ý vì dễ tạo dữ liệu tạm như name = username.

// 1. Hiển thị form đăng ký - Chỉ Admin mới vào được
fastify.get('/register', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('register.pug', { user: req.user }) 
})

// 2. Xử lý đăng ký - Chỉ Admin mới có quyền thực thi
fastify.post('/register', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { username, password } = req.body;

  const existingUser = await fastify.mongo.db.collection('users').findOne({ username });
  if (existingUser) {
    return reply.view('register.pug', { 
      error: 'Tên đăng nhập đã tồn tại!', 
      user: req.user 
    }); 
  }

  const hash = await bcrypt.hash(password, 10); 
  
  const userResult = await fastify.mongo.db.collection('users').insertOne({
    username, 
    password: hash,
    role: 'user'
  }); 

  await fastify.mongo.db.collection('employees').insertOne({
    userId: userResult.insertedId,
    name: username,
    role: 'Nhân viên mới',
    department: 'Chưa cập nhật'
  }); 

  reply.redirect('/accounts'); 
});

// ================= ĐĂNG NHẬP =================

fastify.get('/login', async (req, reply) => { 
  return reply.view('login.pug')
})

fastify.post('/login', async (req, reply) => {
  const { username, password } = req.body;
  const user = await fastify.mongo.db.collection('users').findOne({ username });

  if (!user) {
    return reply.view('login.pug', { error: 'Tài khoản không tồn tại' });
  }

  const storedPassword = user.password || '';
  const isHashedPassword = typeof storedPassword === 'string' && storedPassword.startsWith('$2');
  const match = isHashedPassword
    ? await bcrypt.compare(password, storedPassword)
    : password === storedPassword;

  if (!match) {
    return reply.view('login.pug', { error: 'Mật khẩu không chính xác' });
  }

  if (!isHashedPassword) {
    const hashedPassword = await bcrypt.hash(password, 10);
    await fastify.mongo.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } }
    );
  }

  const token = fastify.jwt.sign({
    id: user._id,
    username: user.username,
    role: user.role
  });

  reply.setCookie('token', token, {
    path: '/',
    httpOnly: true,
    maxAge: 3600 * 24
  }).redirect('/dashboard');
}); 

// ================= ĐĂNG XUẤT =================
fastify.get('/logout', async (req, reply) => {
  reply.clearCookie('token').redirect('/login')
})


// ================= DASHBOARD =================
// Dashboard admin lấy số tổng hợp thật từ MongoDB.
// Dashboard user không dùng số tổng hợp toàn hệ thống, chỉ hiển thị giao diện cá nhân hóa nhẹ hơn.
fastify.get('/dashboard', { preHandler: [auth] }, async (req, reply) => {
  let dashboardStats = null

  if (req.user.role === 'admin') {
    const [employeeCount, departmentCount, pendingSalaryCount] = await Promise.all([
      fastify.mongo.db.collection('employees').countDocuments({ employeeCode: { $exists: true, $ne: '' } }),
      fastify.mongo.db.collection('departments').countDocuments({}),
      fastify.mongo.db.collection('provisional_salaries').countDocuments({ status: 'pending' })
    ])

    dashboardStats = {
      employeeCount,
      departmentCount,
      pendingSalaryCount
    }
  }

  return reply.view('dashboard.pug', { user: req.user, dashboardStats })
})

fastify.get('/accounts', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  // Màn hình accounts chỉ dành cho admin.
  // Dữ liệu ở đây đang cố gắng nối tài khoản với hồ sơ nhân viên theo 2 cách:
  // 1. userId -> employee
  // 2. username -> employeeCode/code/maNV
  const users = await fastify.mongo.db.collection('users').find().toArray()
  const employees = await fastify.mongo.db.collection('employees').find().toArray()
  const normalizeEmployeeCode = (value) => String(value || '').trim().toUpperCase()
  const employeeByUserId = new Map(
    employees
      .filter(employee => employee.userId)
      .map(employee => [employee.userId.toString(), employee])
  )
  const employeeByCode = new Map(
    employees.flatMap(employee => {
      const codes = [employee.employeeCode, employee.code, employee.maNV]
        .map(normalizeEmployeeCode)
        .filter(Boolean)

      return codes.map(code => [code, employee])
    })
  )

  const accounts = users.map(account => {
    const linkedEmployeeByUserId = employeeByUserId.get(account._id.toString())
    const linkedEmployeeByCode = employeeByCode.get(normalizeEmployeeCode(account.username))
    const linkedEmployee = linkedEmployeeByUserId?.employeeCode
      ? linkedEmployeeByUserId
      : linkedEmployeeByCode || linkedEmployeeByUserId
    const linkedEmployeeCode = linkedEmployee?.employeeCode || linkedEmployee?.code || linkedEmployee?.maNV

    return {
      ...account,
      linkedEmployeeName: linkedEmployee?.name || 'Chưa liên kết',
      linkedEmployeeCode: linkedEmployeeCode || 'Chưa có mã NV',
      passwordStatus: typeof account.password === 'string' && account.password.startsWith('$2')
        ? 'Đã mã hóa'
        : 'Mật khẩu thường'
    }
  })

  return reply.view('accounts.pug', { accounts, user: req.user })
})


// ================= QUẢN LÝ NHÂN VIÊN =================
// Quy tắc quyền hiện tại:
// - admin: xem danh sách, thêm, sửa, xóa toàn bộ hồ sơ.
// - user: không xem danh sách chung, vào /employees sẽ bị chuyển sang hồ sơ cá nhân.
fastify.get('/employees', { preHandler: [auth] }, async (req, reply) => {
  if (req.user.role !== 'admin') {
    const employee = await findEmployeeByUserId(req.user.id, req.user.username)

    if (!employee) {
      return reply.status(403).send('❌ Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên.')
    }

    return reply.redirect(`/employees/detail/${employee._id}`)
  }

  const employees = await fastify.mongo.db.collection('employees').find({
    employeeCode: { $exists: true, $ne: '' }
  }).toArray()
  return reply.view('employees.pug', { employees, user: req.user })
})

fastify.get('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('add.pug', { user: req.user })
})

// ĐÃ CẬP NHẬT: Xử lý nhận file ảnh tải lên và lưu trữ thông tin nhân viên
fastify.post('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    // Route này vừa nhận file ảnh, vừa nhận text fields trong multipart/form-data.
    // basicSalary được ép sang Number ngay từ đầu để tránh lỗi ở phần tính lương về sau.
    const data = await req.file()
    let avatarPath = ''

    // Nếu có file ảnh được tải lên từ máy tính
    if (data && data.file) {
      const filename = Date.now() + '-' + data.filename
      const uploadDir = path.join(__dirname, 'public', 'uploads')
      
      // Tạo tự động thư mục "uploads" nếu chưa có cấu trúc này trong dự án
      if (!fs.existsSync(uploadDir)){
          fs.mkdirSync(uploadDir, { recursive: true })
      }

      const saveTo = path.join(uploadDir, filename)
      
      // Tiến hành đưa luồng dữ liệu file ghi vào ổ đĩa cứng
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(saveTo)
        data.file.pipe(writeStream)
        data.file.on('end', resolve)
        data.file.on('error', reject)
      })

      // Đường dẫn ảo dùng để hiển thị trên trình duyệt (qua cấu hình static)
      avatarPath = `/public/uploads/${filename}`
    }

    // Đọc các trường dữ liệu text thông thường gửi kèm trong form
    const employeeData = {}
    for (const key in data.fields) {
      const fieldValue = data.fields[key].value
      employeeData[key] = key === 'basicSalary'
        ? Number(fieldValue || 0)
        : fieldValue
    }

    // Gán đường dẫn lưu trữ file ảnh vào thuộc tính avatar của nhân viên
    employeeData.avatar = avatarPath

    await fastify.mongo.db.collection('employees').insertOne(employeeData)
    reply.redirect('/employees')

  } catch (err) {
    fastify.log.error(err)
    return reply.status(500).send('❌ Đã xảy ra lỗi hệ thống trong quá trình upload ảnh!')
  }
})

fastify.get('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
  return reply.view('edit.pug', { emp, user: req.user })
})

fastify.post('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const data = await req.file()
    if (!data) {
      return reply.status(400).send('❌ Không nhận được dữ liệu form gửi lên!')
    }
    
    // Lấy thông tin nhân viên cũ để giữ lại ảnh cũ nếu user không tải ảnh mới
    const oldEmp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
    let avatarPath = oldEmp ? oldEmp.avatar : ''

    // Nếu người dùng có chọn file ảnh mới để thay đổi
    if (data && data.file && data.filename) {
      const filename = Date.now() + '-' + data.filename
      const uploadDir = path.join(__dirname, 'public', 'uploads')
      
      if (!fs.existsSync(uploadDir)){
          fs.mkdirSync(uploadDir, { recursive: true })
      }

      const saveTo = path.join(uploadDir, filename)
      
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(saveTo)
        data.file.pipe(writeStream)
        data.file.on('end', resolve)
        data.file.on('error', reject)
      })

      avatarPath = `/public/uploads/${filename}`
    }

    // Khởi tạo object chứa dữ liệu được cập nhật sạch sẽ
    const updatedEmployeeData = {}
    
    // Duyệt và chuẩn hóa dữ liệu từ các trường text của form gửi lên
    for (const key in data.fields) {
      const fieldValue = data.fields[key].value
      
      // Ép kiểu dữ liệu số cho lương cứng để phục vụ tính toán tự động sau này
      if (key === 'basicSalary') {
        updatedEmployeeData[key] = Number(fieldValue || 0)
      } else {
        updatedEmployeeData[key] = fieldValue
      }
    }

    // Gán đường dẫn ảnh đại diện (giữ cũ hoặc dùng cái mới vừa upload)
    updatedEmployeeData.avatar = avatarPath

    // Tiến hành cập nhật vào Cơ sở dữ liệu MongoDB
    await fastify.mongo.db.collection('employees').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updatedEmployeeData }
    )
    
    return reply.redirect('/employees')

  } catch (err) {
    fastify.log.error(err)
    return reply.status(500).send('❌ Đã xảy ra lỗi trong quá trình cập nhật hồ sơ nhân viên!')
  }
})

fastify.get('/employees/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('employees').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/employees')
})

// Xem chi tiết nhân viên (Cả Admin và User thường đều có quyền xem)
fastify.get('/employees/detail/:id', { preHandler: [auth] }, async (req, reply) => {
  try {
    // User thường chỉ được mở đúng hồ sơ của mình, không được mở hồ sơ người khác bằng URL trực tiếp.
    const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) });
    if (!emp) {
      return reply.code(404).send('Không tìm thấy nhân viên');
    }

    if (req.user.role !== 'admin') {
      const employee = await findEmployeeByUserId(req.user.id, req.user.username)

      if (!employee || employee._id.toString() !== emp._id.toString()) {
        return reply.code(403).send('❌ Bạn không có quyền xem hồ sơ nhân viên khác');
      }
    }

    return reply.view('detail.pug', { emp, user: req.user });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send('Lỗi máy chủ');
  }
});

// ================= QUẢN LÝ CHẤM CÔNG =================
// Nhánh chấm công có 2 kiểu dữ liệu:
// - gps-checkin: user tự check-in/check-out bằng GPS + ảnh.
// - admin-manual: admin thêm/sửa thủ công.
// Đây là lý do record attendance có field source.
fastify.get('/attendance', { preHandler: [auth] }, async (req, reply) => {
  const attendanceCollection = fastify.mongo.db.collection('attendance')
  const employee = await findEmployeeByUserId(req.user.id, req.user.username)
  const workDate = getWorkDate()

  const filter = req.user.role === 'admin'
    ? {}
    : employee
      ? { employeeId: employee._id }
      : { _id: null }

  const attendanceRecords = await attendanceCollection
    .find(filter)
    .sort({ workDate: -1, checkInAt: -1, createdAt: -1 })
    .toArray()

  const enrichedAttendance = await enrichAttendanceRecords(attendanceRecords)
  const todayAttendance = employee
    ? enrichedAttendance.find(record => record.employeeId?.toString() === employee._id.toString() && record.workDate === workDate)
    : null

  return reply.view('attendance.pug', {
    attendance: enrichedAttendance,
    user: req.user,
    employee,
    todayAttendance,
    attendanceSettings: {
      ...ATTENDANCE_SETTINGS,
      isConfigured: isAttendanceLocationConfigured()
    },
    error: req.query.error,
    success: req.query.success
  })
})

fastify.post('/attendance/checkin', { preHandler: [auth] }, async (req, reply) => {
  // Điều kiện check-in thành công:
  // 1. tài khoản phải nối được employee
  // 2. công ty phải có tọa độ hợp lệ
  // 3. client gửi GPS hợp lệ
  // 4. có ảnh check-in
  // 5. chưa check-in trong ngày
  // 6. khoảng cách nằm trong bán kính cho phép
  const employee = await findEmployeeByUserId(req.user.id, req.user.username)
  if (!employee) {
    return buildAttendanceRedirect(reply, 'error', 'Tài khoản này chưa được liên kết với hồ sơ nhân viên để chấm công.')
  }

  if (!isAttendanceLocationConfigured()) {
    return buildAttendanceRedirect(reply, 'error', 'Chưa cấu hình tọa độ công ty. Hãy cập nhật COMPANY_LATITUDE và COMPANY_LONGITUDE trong server.')
  }

  const latitude = Number(req.body.latitude)
  const longitude = Number(req.body.longitude)
  const accuracy = Number(req.body.accuracy || 0)
  const photoData = req.body.photoData

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return buildAttendanceRedirect(reply, 'error', 'Không nhận được GPS hợp lệ từ thiết bị của bạn.')
  }

  const photoPath = saveBase64Image(photoData, 'attendance')
  if (!photoPath) {
    return buildAttendanceRedirect(reply, 'error', 'Bạn cần chụp ảnh check-in trước khi gửi chấm công.')
  }

  const workDate = getWorkDate()
  const attendanceCollection = fastify.mongo.db.collection('attendance')
  const existingAttendance = await attendanceCollection.findOne({
    employeeId: employee._id,
    workDate
  })

  if (existingAttendance?.checkInAt) {
    return buildAttendanceRedirect(reply, 'error', 'Bạn đã check-in hôm nay rồi.')
  }

  const distanceMeters = calculateDistanceMeters(
    latitude,
    longitude,
    ATTENDANCE_SETTINGS.companyLatitude,
    ATTENDANCE_SETTINGS.companyLongitude
  )

  if (distanceMeters > ATTENDANCE_SETTINGS.allowedRadiusMeters) {
    return buildAttendanceRedirect(
      reply,
      'error',
      `Bạn đang cách công ty ${distanceMeters} m, vượt quá phạm vi cho phép ${ATTENDANCE_SETTINGS.allowedRadiusMeters} m.`
    )
  }

  const now = new Date()
  const attendancePayload = {
    employeeId: employee._id,
    employeeName: employee.name,
    userId: normalizeObjectId(req.user.id),
    workDate,
    date: now,
    status: 'present',
    overtime: false,
    checkInAt: now,
    updatedAt: now,
    location: {
      latitude,
      longitude,
      accuracy,
      distanceMeters,
      companyName: ATTENDANCE_SETTINGS.companyName,
      companyLatitude: ATTENDANCE_SETTINGS.companyLatitude,
      companyLongitude: ATTENDANCE_SETTINGS.companyLongitude
    },
    checkInPhoto: photoPath,
    source: 'gps-checkin'
  }

  if (existingAttendance) {
    await attendanceCollection.updateOne(
      { _id: existingAttendance._id },
      { $set: attendancePayload, $setOnInsert: { createdAt: now } }
    )
  } else {
    await attendanceCollection.insertOne({
      ...attendancePayload,
      createdAt: now
    })
  }

  return buildAttendanceRedirect(reply, 'success', 'Check-in thành công, ảnh và vị trí đã được xác thực.')
})

fastify.post('/attendance/checkout', { preHandler: [auth] }, async (req, reply) => {
  // Checkout đơn giản hơn checkin: chỉ cần đã có check-in hôm nay và chưa checkout trước đó.
  const employee = await findEmployeeByUserId(req.user.id, req.user.username)
  if (!employee) {
    return buildAttendanceRedirect(reply, 'error', 'Tài khoản này chưa được liên kết với hồ sơ nhân viên để check-out.')
  }

  const workDate = getWorkDate()
  const attendanceCollection = fastify.mongo.db.collection('attendance')
  const existingAttendance = await attendanceCollection.findOne({
    employeeId: employee._id,
    workDate
  })

  if (!existingAttendance?.checkInAt) {
    return buildAttendanceRedirect(reply, 'error', 'Bạn chưa check-in hôm nay nên không thể check-out.')
  }

  if (existingAttendance.checkOutAt) {
    return buildAttendanceRedirect(reply, 'error', 'Bạn đã check-out hôm nay rồi.')
  }

  await attendanceCollection.updateOne(
    { _id: existingAttendance._id },
    {
      $set: {
        checkOutAt: new Date(),
        updatedAt: new Date()
      }
    }
  )

  return buildAttendanceRedirect(reply, 'success', 'Check-out thành công.')
})

fastify.get('/attendance/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees').find().sort({ name: 1 }).toArray()
  return reply.view('add_attendance.pug', { employees, user: req.user })
})

fastify.post('/attendance/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { employeeId, date, status } = req.body
  const employee = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(employeeId) })

  if (!employee) {
    return reply.code(400).send('Không tìm thấy nhân viên để chấm công.')
  }

  const workDate = date || getWorkDate()
  const { startDate } = getDateRangeForWorkDate(workDate)
  const now = new Date()

  await fastify.mongo.db.collection('attendance').updateOne(
    { employeeId: employee._id, workDate },
    {
      $set: {
        employeeId: employee._id,
        employeeName: employee.name,
        userId: employee.userId || null,
        workDate,
        date: startDate,
        status,
        overtime: Boolean(req.body.overtime),
        updatedAt: now,
        source: 'admin-manual'
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  )

  reply.redirect('/attendance')
})

fastify.get('/attendance/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const attendance = await fastify.mongo.db.collection('attendance').findOne({ _id: new ObjectId(req.params.id) })
  const employees = await fastify.mongo.db.collection('employees').find().sort({ name: 1 }).toArray()

  if (!attendance) {
    return reply.code(404).send('Không tìm thấy bản ghi chấm công.')
  }

  const normalizedAttendance = {
    ...attendance,
    workDate: attendance.workDate || (attendance.date instanceof Date ? getWorkDate(attendance.date) : String(attendance.date || ''))
  }

  return reply.view('edit_attendance.pug', { attendance: normalizedAttendance, employees, user: req.user })
})

fastify.post('/attendance/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { employeeId, date, status } = req.body
  const employee = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(employeeId) })

  if (!employee) {
    return reply.code(400).send('Không tìm thấy nhân viên để cập nhật chấm công.')
  }

  const workDate = date || getWorkDate()
  const { startDate } = getDateRangeForWorkDate(workDate)

  await fastify.mongo.db.collection('attendance').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        employeeId: employee._id,
        employeeName: employee.name,
        userId: employee.userId || null,
        workDate,
        date: startDate,
        status,
        overtime: Boolean(req.body.overtime),
        updatedAt: new Date(),
        source: 'admin-manual'
      }
    }
  )

  reply.redirect('/attendance')
})

fastify.get('/attendance/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('attendance').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/attendance')
})

// ================= QUẢN LÝ PHÒNG BAN =================
// Đây là nhóm master data nội bộ.
// Hiện đã khóa admin-only để user không xem cấu hình tổ chức của toàn công ty.
fastify.get('/departments', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const departments = await fastify.mongo.db.collection('departments').find().toArray()
  return reply.view('departments.pug', { departments, user: req.user })
})

fastify.get('/departments/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('add_dept.pug', { user: req.user });
});

fastify.post('/departments/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('departments').insertOne(req.body)
  reply.redirect('/departments')
})

fastify.get('/departments/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const dept = await fastify.mongo.db.collection('departments').findOne({ _id: new ObjectId(req.params.id) });
  return reply.view('edit_dept.pug', { dept, user: req.user });
});

fastify.post('/departments/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('departments').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body }
  )
  reply.redirect('/departments')
})

fastify.get('/departments/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('departments').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/departments')
})

// ================= QUẢN LÝ CHỨC VỤ =================
// Tương tự phòng ban: CRUD đơn giản, ít phụ thuộc, rất phù hợp tách file riêng nếu cần refactor.
fastify.get('/positions', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const positions = await fastify.mongo.db.collection('positions').find().toArray()
  return reply.view('positions.pug', { positions, user: req.user })
})

fastify.get('/positions/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('add_pos.pug', { user: req.user }) 
})

fastify.post('/positions/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions').insertOne(req.body)
  reply.redirect('/positions')
})

fastify.get('/positions/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const pos = await fastify.mongo.db.collection('positions').findOne({ _id: new ObjectId(req.params.id) })
  return reply.view('edit_pos.pug', { pos, user: req.user }) 
})

fastify.post('/positions/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body }
  )
  reply.redirect('/positions')
})

fastify.get('/positions/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/positions')
})

// ================= HỆ THỐNG LƯƠNG (ĐÃ CẬP NHẬT TÌM THEO MÃ TỰ NHẬP VÀ ROUTE TÍNH LƯƠNG) =================
// Luồng lương hiện tại:
// - Admin tra mã nhân viên hoặc xem lương toàn tháng.
// - Admin tạo phiếu tạm ở provisional_salaries.
// - Admin duyệt để ghi sang salaries.
// - User chỉ xem phiếu lương của chính mình.
fastify.get('/salary', { preHandler: [auth] }, async (req, reply) => { 
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  const searchEmpId = req.query.employeeId ? req.query.employeeId.trim() : ''
  
  let salaries = []
  let searchedEmployee = null
  let searchedEmployeeSummary = null
  let errorMsg = null

  if (req.user.role === 'admin') {
    // Nhánh admin có thêm chức năng tìm theo mã nhân viên.
    // Hệ thống vẫn phải fallback nhiều field mã do dữ liệu cũ chưa thống nhất hoàn toàn.
    if (searchEmpId) {
      try {
        // TÌM KIẾM THEO MÃ NHÂN VIÊN (Ví dụ trường trong DB tên là employeeCode hoặc code)
        searchedEmployee = await fastify.mongo.db.collection('employees').findOne({ 
          $or: [
            { employeeCode: searchEmpId },
            { code: searchEmpId },
            { maNV: searchEmpId } 
          ]
        })
        
        if (searchedEmployee) {
          const employeeCode = searchedEmployee.employeeCode || searchedEmployee.code || searchedEmployee.maNV || 'Chưa xếp mã'
          const attendanceCount = await fastify.mongo.db.collection('attendance').countDocuments({
            employeeId: searchedEmployee._id,
            workDate: { $regex: `^${month}` },
            status: 'present'
          })

          searchedEmployeeSummary = {
            name: searchedEmployee.name || 'Chưa cập nhật',
            employeeCode,
            basicSalary: Number(searchedEmployee.basicSalary || 0),
            role: searchedEmployee.role || 'Chưa cập nhật',
            attendanceDays: attendanceCount
          }

          // Khi đã tìm thấy nhân viên bằng Mã tự nhập, lấy lương dựa trên _id hệ thống của họ
          salaries = await fastify.mongo.db.collection('salaries').find({ 
            employeeId: searchedEmployee._id,
            month: month 
          }).toArray()
        } else {
          errorMsg = `❌ Không tìm thấy nhân viên nào có mã: ${searchEmpId}`
        }
      } catch (err) {
        fastify.log.error(err)
        errorMsg = '❌ Có lỗi xảy ra trong quá trình tìm kiếm!'
      }
    } else {
      // Nếu không nhập mã, hiển thị tất cả bảng lương của tháng đó
      salaries = await fastify.mongo.db.collection('salaries').find({ month: month }).toArray()
    }
  } else {
    // Đối với tài khoản User thường:
    // chỉ lấy phiếu lương thỏa 1 trong 2 điều kiện:
    // - đúng userId tài khoản
    // - đúng employeeId đã liên kết
    const employee = await findEmployeeByUserId(req.user.id, req.user.username)
    const userSalaryFilter = employee
      ? {
          $or: [
            { userId: new ObjectId(req.user.id) },
            { employeeId: employee._id }
          ]
        }
      : { userId: new ObjectId(req.user.id) }

    salaries = await fastify.mongo.db.collection('salaries')
      .find(userSalaryFilter)
      .sort({ month: -1 })
      .toArray()
  }

  return reply.view('salary_list.pug', {
    salaries,
    searchedEmployee,
    searchedEmployeeSummary,
    searchEmpId,
    errorMsg,
    currentMonth: month,
    user: req.user
  })
})

// [BỔ SUNG] 1. Hiển thị form thiết lập lương cho nhân viên cụ thể khi click nút
fastify.get('/salary/manage/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const salaryMonth = req.query.month || new Date().toISOString().slice(0, 7)
    const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
    if (!emp) {
      return reply.status(404).send('❌ Không tìm thấy thông tin nhân viên này!')
    }

    const attendanceDays = await fastify.mongo.db.collection('attendance').countDocuments({
      employeeId: emp._id,
      workDate: { $regex: `^${salaryMonth}` },
      status: 'present'
    })

    const salarySummary = {
      month: salaryMonth,
      name: emp.name || 'Chưa cập nhật',
      employeeCode: emp.employeeCode || emp.code || emp.maNV || 'Chưa xếp mã',
      baseSalary: Number(emp.basicSalary || 0),
      role: emp.role || 'Chưa cập nhật',
      attendanceDays,
      standardWorkDays: STANDARD_WORK_DAYS
    }

    return reply.view('salary_manage.pug', { emp, salarySummary, salaryMonth, user: req.user })
  } catch (err) {
    fastify.log.error(err)
    return reply.status(500).send('❌ Đã xảy ra lỗi khi tải trang thiết lập lương!')
  }
})

// ================= ROUTE 1: LƯU LƯƠNG VÀO DANH SÁCH CHỜ DUYỆT =================
// Tạm tính lương được lưu vào provisional_salaries trước; chưa ghi thẳng vào salaries.
fastify.post('/salary/manage/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const employeeId = req.params.id;
    const { month, bonus, allowance, raise, advance } = req.body;
    
    // Tìm thông tin gốc của nhân viên để lấy lương cơ bản, phòng ban, mã số...
    const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(employeeId) });
    if (!emp) {
      return reply.status(404).send('❌ Không tìm thấy thông tin nhân viên này!');
    }

    const baseSalary = Number(emp.basicSalary || 0);
    const numBonus = Number(bonus || 0);
    const numAllowance = Number(allowance || 0);
    const numRaise = Number(raise || 0);
    const numAdvance = Number(advance || 0);
    const attendanceDays = await fastify.mongo.db.collection('attendance').countDocuments({
      employeeId: emp._id,
      workDate: { $regex: `^${month}` },
      status: 'present'
    });

    // Công thức mới: (LCB / công chuẩn) * số công + thưởng - tạm ứng
    const finalSalary = calculateSalaryByAttendance(baseSalary, attendanceDays, numBonus, numAdvance);

    // Lưu đè hoặc tạo mới vào bảng provisional_salaries kèm trạng thái 'pending'
    await fastify.mongo.db.collection('provisional_salaries').updateOne(
      { employeeId: new ObjectId(employeeId), month: month },
      {
        $set: {
          employeeId: emp._id,
          userId: emp.userId || null,
          month,
          employeeCode: emp.employeeCode || emp.code || emp.maNV || 'Chưa xếp mã',
          employeeName: emp.name || 'Nhân viên',
          role: emp.role || 'Chưa cập nhật',
          department: emp.department || 'Chưa cập nhật',
          baseSalary,
          standardWorkDays: STANDARD_WORK_DAYS,
          attendanceDays,
          bonus: numBonus,
          allowance: numAllowance,
          raise: numRaise,
          advance: numAdvance,
          finalSalary,
          status: 'pending', // 🌟 Trạng thái chờ duyệt
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    // Chuyển hướng về trang danh sách lương tạm tính để Admin kiểm tra và duyệt
    reply.redirect('/salary/provisional');
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send('❌ Đã xảy ra lỗi khi tạo phiếu lương chờ duyệt!');
  }
});


// ================= ROUTE 2: HIỂN THỊ DANH SÁCH LƯƠNG CHỜ DUYỆT =================
// Chỉ lấy các phiếu pending theo tháng để admin duyệt, không lẫn phiếu đã approved.
fastify.get('/salary/provisional', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const currentMonth = req.query.month || new Date().toISOString().slice(0, 7);

    // Chỉ lấy ra những bản ghi của tháng yêu cầu và đang ở trạng thái chờ duyệt ('pending')
    const provisionalSalaryDocs = await fastify.mongo.db.collection('provisional_salaries')
      .find({ month: currentMonth, status: 'pending' }).toArray();

    const provisionalSalaries = provisionalSalaryDocs.map((item) => ({
      ...item,
      standardWorkDays: item.standardWorkDays || STANDARD_WORK_DAYS,
      finalSalary: calculateSalaryByAttendance(
        item.baseSalary,
        item.attendanceDays,
        item.bonus,
        item.advance
      )
    }))

    return reply.view('salary_provisional.pug', {
      provisionalSalaries,
      currentMonth,
      user: req.user
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send('❌ Đã xảy ra lỗi khi tải danh sách lương tạm tính!');
  }
});


// ================= ROUTE 3: CHỨC NĂNG DUYỆT LẺ TỪNG NHÂN VIÊN =================
// Duyệt lẻ = copy 1 phiếu từ provisional_salaries sang salaries rồi đánh dấu approved.
fastify.post('/salary/provisional/approve/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const provisionalId = req.params.id;
    
    // Tìm bản ghi tạm tính
    const provSalary = await fastify.mongo.db.collection('provisional_salaries').findOne({ _id: new ObjectId(provisionalId) });
    if (!provSalary) {
      return reply.status(404).send('❌ Không tìm thấy bản ghi lương tạm tính hoặc phiếu đã được duyệt trước đó!');
    }

    // 1. Ghi đè hoặc tạo mới sang bảng lương chính thức (salaries)
    const finalSalary = calculateSalaryByAttendance(
      provSalary.baseSalary,
      provSalary.attendanceDays,
      provSalary.bonus,
      provSalary.advance
    )

    await fastify.mongo.db.collection('salaries').updateOne(
      { employeeId: provSalary.employeeId, month: provSalary.month },
      {
        $set: {
          employeeId: provSalary.employeeId,
          userId: provSalary.userId || null,
          month: provSalary.month,
          employeeCode: provSalary.employeeCode,
          employeeName: provSalary.employeeName,
          department: provSalary.department,
          role: provSalary.role,
          baseSalary: provSalary.baseSalary,
          attendanceDays: provSalary.attendanceDays || 0,
          bonus: provSalary.bonus,
          allowance: provSalary.allowance,
          raise: provSalary.raise,
          advance: provSalary.advance,
          standardWorkDays: provSalary.standardWorkDays || STANDARD_WORK_DAYS,
          finalSalary,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    // 2. Chuyển trạng thái bản ghi tạm tính thành 'approved' để lưu vết lịch sử (hoặc dùng .deleteOne nếu muốn xóa hẳn)
    await fastify.mongo.db.collection('provisional_salaries').updateOne(
      { _id: new ObjectId(provisionalId) },
      { $set: { status: 'approved', approvedAt: new Date() } }
    );

    reply.redirect('/salary/provisional?month=' + provSalary.month);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send('❌ Lỗi hệ thống khi duyệt phiếu lương!');
  }
});


// ================= ROUTE 4: CHỨC NĂNG DUYỆT TOÀN BỘ DANH SÁCH =================
// Duyệt toàn bộ = lặp từng phiếu pending của tháng, ghi từng dòng sang salaries rồi updateMany trạng thái.
fastify.post('/salary/provisional/approve-all', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  try {
    const targetMonth = req.body.month || new Date().toISOString().slice(0, 7);
    
    // Lấy toàn bộ danh sách đang 'pending' của tháng đó
    const pendingList = await fastify.mongo.db.collection('provisional_salaries')
      .find({ month: targetMonth, status: 'pending' }).toArray();

    if (pendingList.length === 0) {
      return reply.redirect('/salary/provisional?month=' + targetMonth);
    }

    // Tiến hành duyệt đồng loạt bằng vòng lặp
    for (const item of pendingList) {
      const finalSalary = calculateSalaryByAttendance(
        item.baseSalary,
        item.attendanceDays,
        item.bonus,
        item.advance
      )

      await fastify.mongo.db.collection('salaries').updateOne(
        { employeeId: item.employeeId, month: targetMonth },
        {
          $set: {
            employeeId: item.employeeId,
            userId: item.userId || null,
            month: targetMonth,
            employeeCode: item.employeeCode,
            employeeName: item.employeeName,
            department: item.department,
            role: item.role,
            baseSalary: item.baseSalary,
            attendanceDays: item.attendanceDays || 0,
            bonus: item.bonus,
            allowance: item.allowance,
            raise: item.raise,
            advance: item.advance,
            standardWorkDays: item.standardWorkDays || STANDARD_WORK_DAYS,
            finalSalary,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    // Cập nhật trạng thái hàng loạt bên bảng tạm
    await fastify.mongo.db.collection('provisional_salaries').updateMany(
      { month: targetMonth, status: 'pending' },
      { $set: { status: 'approved', approvedAt: new Date() } }
    );

    // Duyệt xong chuyển hẳn sang bảng lương chính thức để xem thành quả
    reply.redirect('/salary?month=' + targetMonth);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send('❌ Gặp lỗi khi duyệt toàn bộ bảng lương!');
  }
});

// ================= QUẢN LÝ HỢP ĐỒNG =================
// Quy tắc quyền:
// - admin: xem toàn bộ hợp đồng và CRUD đầy đủ.
// - user: chỉ xem hợp đồng gắn với employee của mình, không có quyền sửa.
fastify.get('/contracts', { preHandler: [auth] }, async (req, reply) => {
  let contracts = [];

  if (req.user.role === 'admin') {
    contracts = await fastify.mongo.db.collection('contracts').find().toArray();
  } else {
    const employee = await findEmployeeByUserId(req.user.id, req.user.username)
    contracts = employee
      ? await fastify.mongo.db.collection('contracts').find({ employeeId: employee._id }).toArray()
      : []
  }

  return reply.view('contracts.pug', { contracts, user: req.user });
});

fastify.get('/contracts/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('add_contract.pug', { employees, user: req.user });
});

fastify.post('/contracts/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { contractNumber, signDate, contractType, duration, employeeId } = req.body;
  await fastify.mongo.db.collection('contracts').insertOne({
    contractNumber,
    signDate,
    contractType,
    duration,
    employeeId: new ObjectId(employeeId),
    createdAt: new Date()
  });
  reply.redirect('/contracts');
});

fastify.get('/contracts/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const contract = await fastify.mongo.db.collection('contracts').findOne({ _id: new ObjectId(req.params.id) });
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('edit_contract.pug', { contract, employees, user: req.user });
});

fastify.post('/contracts/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { contractNumber, signDate, contractType, duration, employeeId } = req.body;
  await fastify.mongo.db.collection('contracts').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { contractNumber, signDate, contractType, duration, employeeId: new ObjectId(employeeId) } }
  );
  reply.redirect('/contracts');
});

fastify.get('/contracts/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('contracts').deleteOne({ _id: new ObjectId(req.params.id) });
  reply.redirect('/contracts');
});

// ================= CHẠY SERVER =================
fastify.listen({ port: 3000 }, err => {
  if (err) throw err
  console.log('Server đang chạy tại http://localhost:3000')
})
