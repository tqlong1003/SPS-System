const path = require('node:path')
const fastify = require('fastify')({ logger: true })
const bcrypt = require('bcrypt')
const { ObjectId } = require('mongodb')

// ================= PLUGINS =================
fastify.register(require('@fastify/formbody'))

fastify.register(require('@fastify/cookie'))

fastify.register(require('@fastify/jwt'), {
  secret: 'secret123'
})

fastify.register(require('@fastify/mongodb'), {
  url: 'mongodb://127.0.0.1:27017/company'
})

fastify.register(require('@fastify/view'), {
  engine: { pug: require('pug') },
  root: path.join(__dirname, 'views')
})

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/'
})

// ================= HẰNG SỐ NGHIỆP VỤ =================
const PRODUCT_BRANDS = ['Apple', 'Samsung', 'Xiaomi', 'Oppo', 'Vivo', 'Realme', 'Nokia', 'Khác']
const PRODUCT_CATEGORIES = ['Điện thoại', 'Máy tính bảng', 'Đồng hồ thông minh', 'Phụ kiện']
const PRODUCT_TYPES = ['Mới 100% (chính hãng)', 'Like new', 'Cũ đã qua sử dụng', 'Hàng trưng bày']
const ACTIVITY_TYPES = ['Gọi điện tư vấn', 'Nhắn tin/Zalo', 'Gặp trực tiếp', 'Hỗ trợ bảo hành', 'Khác']
const LOW_STOCK_THRESHOLD = 5

// Trạng thái công việc nhắc lịch chăm sóc khách hàng (reminders)
const REMINDER_STATUSES = ['Chờ thực hiện', 'Đã hoàn thành']

// Lịch chăm sóc sau bán hàng TỰ ĐỘNG tạo khi nhân viên xác nhận đơn (tính từ ngày xác nhận)
const AFTER_SALES_FOLLOWUPS = [
  { days: 7, label: '7 ngày', prompt: 'hỏi khách dùng máy có ổn không, cần hỗ trợ cài đặt gì không' },
  { days: 30, label: '1 tháng', prompt: 'hỏi mức độ hài lòng, nhắc phụ kiện / quyền lợi bảo hành' }
]
// Tự tạo lịch nhắc khi bảo hành còn <= N ngày sẽ hết hạn
const WARRANTY_EXPIRY_REMIND_DAYS = 30
// Chu kỳ quét bảo hành sắp hết hạn (ngoài lần quét khi khởi động server)
const AUTO_REMINDER_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000

// --- Nhân viên (hồ sơ nhân sự - khác với tài khoản đăng nhập "users") ---
// Chỉ có 1 chức vụ duy nhất cho mọi nhân viên (không phân biệt bán hàng, kỹ thuật, thu ngân, ...)
const EMPLOYEE_POSITION = 'Nhân viên'
const EMPLOYEE_GENDERS = ['Nam', 'Nữ', 'Khác']
const EMPLOYEE_STATUSES = ['Đang làm việc', 'Ngưng làm việc']

// --- Vai trò tài khoản (collection users) ---
const STAFF_ROLES = ['admin', 'user']            // nội bộ cửa hàng
const ALL_ROLES = ['admin', 'user', 'customer']  // thêm khách hàng

// ================= HELPERS =================

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Tạo regex "chứa" (case-insensitive) từ từ khóa tìm kiếm, trả về null nếu rỗng
function buildContainsRegex(keyword) {
  const trimmed = String(keyword || '').trim()
  if (!trimmed) return null
  return new RegExp(escapeRegex(trimmed), 'i')
}

// Chuyển chuỗi thành ObjectId hợp lệ, trả về null nếu không hợp lệ
function normalizeObjectId(value) {
  if (!value) return null
  if (value instanceof ObjectId) return value
  const str = typeof value === 'object' && value.value ? value.value : value
  return ObjectId.isValid(str) ? new ObjectId(str) : null
}

// Luôn trả về mảng, kể cả khi form chỉ gửi 1 giá trị (không phải mảng)
function toArrayField(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function formatDate(value) {
  if (!value) return 'Chưa cập nhật'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('vi-VN')
}

// Định dạng yyyy-mm-dd cho thuộc tính value của <input type="date">
function toDateInputValue(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function daysUntil(dateValue) {
  if (!dateValue) return null
  const target = new Date(dateValue)
  if (Number.isNaN(target.getTime())) return null
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffMs = target.getTime() - startOfToday.getTime()
  return Math.round(diffMs / (1000 * 60 * 60 * 24))
}

// Trạng thái bảo hành THỰC TẾ, luôn tính từ expiryDate thay vì tin vào giá trị "status" nhập
// tay (tránh trường hợp phiếu đã hết hạn theo ngày nhưng status vẫn ghi "Còn bảo hành" vì
// nhân viên quên cập nhật). "Đã bảo hành xong" là trạng thái duy nhất nhân viên cần tự set
// tay (khi đã xử lý xong 1 lượt bảo hành/sửa chữa cho khách).
function warrantyEffectiveStatus(w) {
  if (w.status === 'Đã bảo hành xong') return 'Đã bảo hành xong'
  const days = daysUntil(w.expiryDate)
  if (days !== null && days < 0) return 'Hết hạn'
  return 'Còn bảo hành'
}

// Tính thâm niên (VD: "2 năm 3 tháng") từ ngày vào làm, trả về '' nếu ngày không hợp lệ
function formatSeniority(dateValue) {
  if (!dateValue) return ''
  const start = new Date(dateValue)
  if (Number.isNaN(start.getTime())) return ''
  const now = new Date()
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) return ''
  const years = Math.floor(months / 12)
  const restMonths = months % 12
  if (years === 0 && restMonths === 0) return 'dưới 1 tháng'
  return [years ? `${years} năm` : '', restMonths ? `${restMonths} tháng` : ''].filter(Boolean).join(' ')
}

// Kiểm tra sinh nhật (ngày sinh dạng MM-DD hoặc YYYY-MM-DD) có rơi vào tháng hiện tại không
// -> dùng để nhắc nhở chăm sóc/chúc mừng sinh nhật khách hàng
function isBirthdayThisMonth(birthDate) {
  if (!birthDate) return false
  const parts = String(birthDate).split('-')
  const month = parts.length === 3 ? Number(parts[1]) : Number(parts[0])
  if (!month) return false
  return month === (new Date().getMonth() + 1)
}

// Cộng thêm N tháng vào một ngày (dạng YYYY-MM-DD), trả về chuỗi YYYY-MM-DD
function addMonths(dateStr, months) {
  const d = dateStr ? new Date(dateStr) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  d.setMonth(d.getMonth() + Number(months || 0))
  return d.toISOString().slice(0, 10)
}

// Định dạng yyyy-mm-dd theo GIỜ ĐỊA PHƯƠNG (toISOString dùng UTC nên ở VN trước 7h sáng sẽ lệch 1 ngày)
function toLocalDateString(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Ngày (yyyy-mm-dd) sau hôm nay N ngày
function addDaysFromToday(days) {
  const d = new Date()
  d.setDate(d.getDate() + Number(days || 0))
  return toLocalDateString(d)
}

// Lấy giá trị thực từ 1 field khi request là multipart (mỗi field đến dạng { value, fieldname, ... })
function fieldValue(field) {
  if (field === undefined || field === null) return ''
  return typeof field === 'object' && 'value' in field ? field.value : field
}

// Đọc & chuẩn hóa thông tin sản phẩm từ form (dùng chung cho thêm / sửa).
// Chỉ gồm: mã SP, tên SP, hãng, danh mục, tồn kho + chi tiết (loại hàng, bảo hành, màu).
function parseProductFields(body) {
  const text = key => String(fieldValue(body[key])).trim()
  const warrantyRaw = text('warrantyMonths')

  return {
    sku: text('sku'),
    name: text('name'),
    brand: text('brand') || 'Khác',
    category: text('category') || 'Điện thoại',
    stockQty: Number(text('stockQty')) || 0,
    // --- Chi tiết sản phẩm ---
    productType: text('productType') || PRODUCT_TYPES[0],
    warrantyMonths: warrantyRaw === '' ? 12 : (Number(warrantyRaw) || 0),
    color: text('color')
  }
}

// Bộ lọc phân quyền: admin thấy tất cả, sales chỉ thấy dữ liệu được giao (assignedTo)
function scopeFilter(req, field = 'assignedTo') {
  if (req.user.role === 'admin') return {}
  return { [field]: normalizeObjectId(req.user.id) }
}

// Admin luôn được thao tác. Nhân viên (role='user') chỉ được thao tác trên bản ghi đang
// gán cho chính mình (assignedTo) - áp dụng cho đơn hàng/phiếu bảo hành, tương tự cách
// /customers/detail đã kiểm tra, để tránh nhân viên A sửa được dữ liệu của nhân viên B.
function canActOnRecord(req, record) {
  if (!record) return false
  if (req.user.role === 'admin') return true
  return record.assignedTo && record.assignedTo.toString() === String(req.user.id)
}

// Riêng cho khách hàng: khác canActOnRecord ở chỗ khách hàng CHƯA được phân công (assignedTo
// rỗng) vẫn xem/thao tác được (để nhân viên có thể nhận chăm sóc khách mới) - chỉ chặn khi
// khách đã được gán cho MỘT nhân viên khác.
function canAccessCustomer(req, customer) {
  if (req.user.role === 'admin') return true
  return !customer.assignedTo || customer.assignedTo.toString() === String(req.user.id)
}

// Trừ / cộng lại tồn kho theo danh sách items của đơn hàng
async function adjustStock(items, sign) {
  if (!items || !items.length) return
  const productsCol = fastify.mongo.db.collection('products')
  for (const item of items) {
    if (!item.productId) continue
    await productsCol.updateOne(
      { _id: item.productId },
      { $inc: { stockQty: sign * Number(item.quantity || 0) } }
    )
  }
}

// Giữ chỗ (trừ) tồn kho một cách NGUYÊN TỬ: chỉ trừ khi stockQty >= số lượng cần mua.
// Nhờ điều kiện nằm ngay trong câu lệnh update nên 2 nhân viên cùng chốt đơn 1 sản phẩm
// cuối cùng cũng không thể làm kho bị âm. Nếu 1 dòng thất bại -> hoàn lại các dòng đã trừ.
// items: [{ productId, productName, quantity }] (mỗi sản phẩm chỉ xuất hiện 1 lần)
async function reserveStock(items) {
  const productsCol = fastify.mongo.db.collection('products')
  const reserved = []
  for (const item of items) {
    const result = await productsCol.updateOne(
      { _id: item.productId, stockQty: { $gte: item.quantity } },
      { $inc: { stockQty: -item.quantity } }
    )
    if (result.modifiedCount === 0) {
      await adjustStock(reserved, 1)
      return { ok: false, failedItem: item }
    }
    reserved.push(item)
  }
  return { ok: true }
}

// Chủ sở hữu một đơn hàng / phiếu bảo hành PHẢI đi theo nhân viên phụ trách khách hàng đó
// (không phải người vừa bấm nút tạo). Nếu không, khi admin tạo hộ đơn cho khách của nhân
// viên A, đơn sẽ "biến mất" khỏi danh sách của A vì bị gán nhầm cho admin.
async function resolveOwner(db, customerId, fallbackUserId) {
  if (customerId) {
    const customer = await db.collection('customers').findOne({ _id: normalizeObjectId(customerId) })
    if (customer && customer.assignedTo) return customer.assignedTo
  }
  return normalizeObjectId(fallbackUserId)
}

// Ghi lịch sử chăm sóc khách hàng (activities). Đây là điểm khác biệt cốt lõi của CRM:
// mọi mốc quan trọng trong vòng đời khách hàng (mua hàng, xác nhận đơn...) đều
// phải để lại dấu vết trên hồ sơ khách hàng, thay vì chỉ nằm rời rạc trong từng đơn hàng.
async function logActivity(db, { customerId, type, note, orderId, userId }) {
  if (!customerId) return
  await db.collection('activities').insertOne({
    customerId: normalizeObjectId(customerId),
    orderId: orderId ? normalizeObjectId(orderId) : null,
    type,
    note: note || '',
    createdBy: userId ? normalizeObjectId(userId) : null,
    createdAt: new Date()
  })
}

// Tạo lịch nhắc chăm sóc TỰ ĐỘNG, không bao giờ tạo trùng.
// Mỗi lịch có 1 autoKey duy nhất (VD: "after-sales:<orderId>:7d"). Khóa được ghi vào collection
// "auto_reminder_keys" (dùng _id làm khóa duy nhất) TRƯỚC khi tạo reminder. Nhờ vậy:
//   - bấm xác nhận đơn 2 lần / quét bảo hành nhiều lần cũng không sinh lịch trùng;
//   - nhân viên đã xóa một lịch tự động thì hệ thống KHÔNG tự tạo lại nó.
// Trả về true nếu vừa tạo mới, false nếu đã từng tạo (hoặc thiếu khách hàng).
async function createAutoReminder(db, { autoKey, customerId, dueDate, note, assignedTo, source, orderId, warrantyId }) {
  const cid = normalizeObjectId(customerId)
  if (!cid || !autoKey || !dueDate) return false

  try {
    await db.collection('auto_reminder_keys').insertOne({ _id: autoKey, createdAt: new Date() })
  } catch (err) {
    if (err && err.code === 11000) return false // đã tạo trước đó
    throw err
  }

  try {
    await db.collection('reminders').insertOne({
      customerId: cid,
      dueDate,
      note: note || '',
      status: REMINDER_STATUSES[0],
      assignedTo: normalizeObjectId(assignedTo),
      createdBy: null, // do hệ thống tạo
      auto: true,
      source,
      autoKey,
      orderId: orderId ? normalizeObjectId(orderId) : null,
      warrantyId: warrantyId ? normalizeObjectId(warrantyId) : null,
      createdAt: new Date()
    })
    return true
  } catch (err) {
    // Tạo reminder lỗi -> gỡ khóa để lần sau còn tạo lại được
    await db.collection('auto_reminder_keys').deleteOne({ _id: autoKey }).catch(() => {})
    throw err
  }
}

// Quét các phiếu bảo hành sắp hết hạn (trong WARRANTY_EXPIRY_REMIND_DAYS ngày tới) và tạo lịch nhắc
// cho nhân viên đang phụ trách khách. Khóa có kèm expiryDate: nếu sau này gia hạn / sửa ngày hết hạn
// thì phiếu đó được nhắc lại theo hạn mới.
async function generateWarrantyExpiryReminders() {
  try {
    const db = fastify.mongo.db
    const today = toLocalDateString(new Date())
    const limit = addDaysFromToday(WARRANTY_EXPIRY_REMIND_DAYS)

    // expiryDate lưu dạng chuỗi yyyy-mm-dd nên so sánh chuỗi cho kết quả đúng thứ tự thời gian
    const warranties = await db.collection('warranties')
      .find({ expiryDate: { $gte: today, $lte: limit }, customerId: { $ne: null } })
      .toArray()
    if (!warranties.length) return 0

    const customers = await db.collection('customers')
      .find({ _id: { $in: warranties.map(w => w.customerId) } })
      .toArray()
    const customerById = new Map(customers.map(c => [c._id.toString(), c]))

    let created = 0
    for (const w of warranties) {
      if (warrantyEffectiveStatus(w) !== 'Còn bảo hành') continue
      const customer = customerById.get(w.customerId.toString())
      if (!customer) continue

      const days = daysUntil(w.expiryDate)
      const when = days === 0 ? 'hôm nay' : `còn ${days} ngày`
      const ok = await createAutoReminder(db, {
        autoKey: `warranty-expiry:${w._id}:${w.expiryDate}`,
        customerId: w.customerId,
        dueDate: today,
        note: `Bảo hành ${w.warrantyCode} (${w.productName}) hết hạn ngày ${formatDate(w.expiryDate)} (${when}) - liên hệ khách kiểm tra máy / giới thiệu dịch vụ.`,
        // Ưu tiên người đang phụ trách khách hiện tại (tránh nhắc nhầm nhân viên cũ)
        assignedTo: customer.assignedTo || w.assignedTo,
        source: 'warranty-expiry',
        orderId: w.orderId,
        warrantyId: w._id
      })
      if (ok) created++
    }

    if (created) console.log(`Đã tự tạo ${created} lịch nhắc bảo hành sắp hết hạn`)
    return created
  } catch (err) {
    fastify.log.error(err)
    return 0
  }
}

// ---------- LỊCH NHẮC SINH NHẬT KHÁCH HÀNG (TỰ ĐỘNG) ----------
// Khách hàng có sinh nhật trong THÁNG HIỆN TẠI sẽ được tự tạo 1 lịch nhắc chăm sóc (mỗi khách / mỗi tháng / mỗi năm
// chỉ 1 lịch, dùng cùng cơ chế chống trùng createAutoReminder). Ngày hẹn = đúng ngày sinh nhật trong tháng này;
// nếu ngày sinh nhật đã qua thì hẹn hôm nay (chúc mừng muộn). Người nhận nhắc = nhân viên phụ trách khách.
function buildBirthdayReminderData(customer) {
  if (!customer || !customer.birthDate || !isBirthdayThisMonth(customer.birthDate)) return null
  const parts = String(customer.birthDate).split('-').map(Number)
  const hasYear = parts.length === 3
  const month = hasYear ? parts[1] : parts[0]
  const rawDay = hasYear ? parts[2] : parts[1]
  if (!month || !rawDay) return null

  const now = new Date()
  const year = now.getFullYear()
  const day = Math.min(rawDay, new Date(year, month, 0).getDate()) // 29/02 -> 28/02 ở năm không nhuận
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  const birthdayStr = `${year}-${mm}-${dd}`
  const today = toLocalDateString(now)
  const passed = birthdayStr < today
  const age = hasYear && parts[0] ? year - parts[0] : null

  const note = `🎂 Sinh nhật khách hàng ${customer.name || ''} ngày ${dd}/${mm}` +
    `${age ? ` (tròn ${age} tuổi)` : ''}${passed ? ' - đã qua ngày sinh nhật, hãy chúc mừng muộn' : ''}` +
    ' - gọi/nhắn Zalo chúc mừng, gửi ưu đãi sinh nhật.'

  return {
    autoKey: `birthday:${customer._id}:${year}-${mm}`,
    dueDate: passed ? today : birthdayStr,
    note
  }
}

async function createBirthdayReminder(db, customer) {
  const data = buildBirthdayReminderData(customer)
  if (!data) return false
  return createAutoReminder(db, {
    autoKey: data.autoKey,
    customerId: customer._id,
    dueDate: data.dueDate,
    note: data.note,
    assignedTo: customer.assignedTo,
    source: 'birthday'
  })
}

// Quét toàn bộ khách hàng có sinh nhật tháng này và tạo lịch nhắc còn thiếu
async function generateBirthdayReminders() {
  try {
    const db = fastify.mongo.db
    const customers = await db.collection('customers')
      .find({ birthDate: { $exists: true, $nin: ['', null] } })
      .toArray()

    let created = 0
    for (const customer of customers) {
      if (!isBirthdayThisMonth(customer.birthDate)) continue
      if (await createBirthdayReminder(db, customer)) created++
    }
    if (created) console.log(`Đã tự tạo ${created} lịch nhắc sinh nhật khách hàng`)
    return created
  } catch (err) {
    fastify.log.error(err)
    return 0
  }
}

// Gọi sau khi thêm/sửa khách hàng (đổi ngày sinh, đổi người phụ trách) để lịch nhắc cập nhật ngay,
// không phải chờ lần quét định kỳ.
async function syncCustomerBirthdayReminder(customerId) {
  try {
    const db = fastify.mongo.db
    const cid = normalizeObjectId(customerId)
    const customer = cid ? await db.collection('customers').findOne({ _id: cid }) : null
    if (!customer) return

    const data = buildBirthdayReminderData(customer)
    if (data) {
      const created = await createBirthdayReminder(db, customer)
      if (!created) {
        // Lịch đã có -> chỉ cập nhật nếu còn "Chờ thực hiện" (đổi ngày sinh / đổi nhân viên phụ trách)
        await db.collection('reminders').updateMany(
          { autoKey: data.autoKey, status: REMINDER_STATUSES[0] },
          { $set: { dueDate: data.dueDate, note: data.note, assignedTo: customer.assignedTo || null } }
        )
      }
    } else {
      // Ngày sinh không còn rơi vào tháng này (hoặc đã xóa) -> gỡ lịch nhắc sinh nhật đang chờ
      const now = new Date()
      const prefix = `birthday:${customer._id}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const del = await db.collection('reminders').deleteMany({ autoKey: prefix, status: REMINDER_STATUSES[0] })
      if (del.deletedCount) await db.collection('auto_reminder_keys').deleteOne({ _id: prefix })
    }
  } catch (err) {
    fastify.log.error(err)
  }
}

// Tự động khởi tạo hồ sơ nhân viên khi cấp tài khoản đăng nhập cho Nhân viên (role = 'user').
// Thông tin ban đầu có thể chưa đầy đủ (chỉ có tên, SĐT) - admin sẽ vào
// mục "Nhân viên" để bổ sung/sửa thêm sau (năm sinh, giới tính, chức vụ chi tiết, ...).
// Liên kết 2 chiều: users.employeeId <-> employees.userId, để dễ tra cứu và tránh tạo trùng.
async function createEmployeeForUserAccount(accountId, { name, phone }) {
  const employeeResult = await fastify.mongo.db.collection('employees').insertOne({
    employeeCode: `NV-${Date.now().toString().slice(-6)}`,
    name: name || 'Chưa cập nhật',
    birthYear: null,
    gender: 'Nam',
    phone: phone || '',
    email: '',
    position: EMPLOYEE_POSITION,
    startDate: new Date().toISOString().slice(0, 10),
    // Trạng thái làm việc tự động theo đăng nhập/đăng xuất: mặc định "Ngưng làm việc",
    // chuyển thành "Đang làm việc" khi nhân viên đăng nhập.
    status: 'Ngưng làm việc',
    address: '',
    note: 'Hồ sơ được tạo tự động khi cấp tài khoản đăng nhập - vui lòng bổ sung thêm thông tin.',
    userId: accountId,
    createdAt: new Date()
  })

  await fastify.mongo.db.collection('users').updateOne(
    { _id: accountId },
    { $set: { employeeId: employeeResult.insertedId } }
  )

  return employeeResult.insertedId
}

// ================= TRẠNG THÁI LÀM VIỆC (TỰ ĐỘNG THEO ĐĂNG NHẬP / ĐĂNG XUẤT) =================
// Nhân viên (role = 'user') đăng nhập -> "Đang làm việc"; đăng xuất -> "Ngưng làm việc".
// Không còn đếm giờ: hệ thống chỉ lưu trạng thái hiện tại trong employees.status.

// Đặt trạng thái làm việc cho hồ sơ nhân viên liên kết với tài khoản đăng nhập.
async function setWorkStatusForAccount(accountId, status) {
  const id = normalizeObjectId(accountId)
  if (!id) return

  const employeesCol = fastify.mongo.db.collection('employees')
  const result = await employeesCol.updateOne({ userId: id }, { $set: { status } })

  // Dự phòng: một số hồ sơ cũ có thể thiếu/lệch trường userId -> tra ngược qua employeeId trên tài khoản
  if (result.matchedCount === 0) {
    const account = await fastify.mongo.db.collection('users').findOne({ _id: id }, { projection: { employeeId: 1 } })
    const employeeId = account ? normalizeObjectId(account.employeeId) : null
    if (employeeId) {
      await employeesCol.updateOne({ _id: employeeId }, { $set: { status } })
    }
  }
}

// Đồng bộ hồ sơ nhân viên cũ (chức vụ như "Nhân viên bán hàng", "Thu ngân", ...) về chức vụ duy nhất.
// Chạy 1 lần mỗi khi khởi động server; nếu không còn hồ sơ nào lệch thì không làm gì.
async function migrateEmployeePositions() {
  try {
    const result = await fastify.mongo.db.collection('employees').updateMany(
      { position: { $ne: EMPLOYEE_POSITION } },
      { $set: { position: EMPLOYEE_POSITION } }
    )
    if (result.modifiedCount) {
      console.log(`Đã chuẩn hóa chức vụ "${EMPLOYEE_POSITION}" cho ${result.modifiedCount} hồ sơ nhân viên`)
    }
  } catch (err) {
    fastify.log.error(err)
  }
}

// ================= HELPERS CHO KHÁCH HÀNG (CỔNG KHÁCH HÀNG) =================

// Hồ sơ khách hàng gắn với tài khoản customer đang đăng nhập (null nếu chưa liên kết)
async function getMyCustomer(req) {
  const userId = normalizeObjectId(req.user.id)
  if (!userId) return null
  return fastify.mongo.db.collection('customers').findOne({ userId })
}

// Khách hàng chỉ nhận được các trường cần thiết - KHÔNG lộ ghi chú nội bộ, nhân viên phụ trách...
function orderForCustomerView(o) {
  return {
    orderCode: o.orderCode,
    status: o.status,
    itemSummary: (o.items || []).map(i => `${i.productName} x${i.quantity}`).join(', '),
    createdAtText: formatDate(o.createdAt)
  }
}

function warrantyForCustomerView(w) {
  const effectiveStatus = warrantyEffectiveStatus(w)
  return {
    warrantyCode: w.warrantyCode,
    productName: w.productName,
    purchaseDate: w.purchaseDate,
    expiryDate: w.expiryDate,
    warrantyMonths: w.warrantyMonths,
    effectiveStatus,
    daysLeft: effectiveStatus === 'Còn bảo hành' ? daysUntil(w.expiryDate) : null
  }
}

// Dữ liệu trang chủ của khách hàng
async function buildCustomerPortalData(req) {
  const db = fastify.mongo.db
  const customer = await getMyCustomer(req)
  if (!customer) return { user: req.user, customer: null, stats: null, recentOrders: [] }

  const [orders, warranties] = await Promise.all([
    db.collection('orders').find({ customerId: customer._id }).sort({ createdAt: -1 }).toArray(),
    db.collection('warranties').find({ customerId: customer._id }).toArray()
  ])

  const warrantyViews = warranties.map(warrantyForCustomerView)
  const activeWarranties = warrantyViews.filter(w => w.effectiveStatus === 'Còn bảo hành')
  const expiringWarranties = activeWarranties
    .filter(w => w.daysLeft !== null && w.daysLeft >= 0 && w.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft)

  return {
    user: req.user,
    customer,
    isBirthdayMonth: isBirthdayThisMonth(customer.birthDate),
    stats: {
      orderCount: orders.length,
      openOrderCount: orders.filter(o => o.status === 'open').length,
      activeWarrantyCount: activeWarranties.length,
      expiringWarranties
    },
    recentOrders: orders.slice(0, 5).map(orderForCustomerView)
  }
}

// Nhân viên chăm sóc (đang phụ trách khách hàng) - hiển thị trong sidebar của khách hàng.
// Chỉ trả về Tên, Mã NV, SĐT, Email (chỉ để khách xem). Không lộ năm sinh, địa chỉ, ghi chú nội bộ...
async function getSupportStaff(userId) {
  try {
    const db = fastify.mongo.db
    const id = normalizeObjectId(userId)
    if (!id) return null

    const customer = await db.collection('customers').findOne({ userId: id }, { projection: { assignedTo: 1 } })
    const staffId = customer ? normalizeObjectId(customer.assignedTo) : null
    if (!staffId) return null

    const account = await db.collection('users').findOne({ _id: staffId, role: { $in: STAFF_ROLES } })
    if (!account) return null
    const employee = await db.collection('employees').findOne({ userId: account._id })

    return {
      name: (employee && employee.name) || account.name || account.username,
      // Admin phụ trách thì không có hồ sơ nhân viên -> không có mã NV
      employeeCode: (employee && employee.employeeCode) || '',
      phone: (employee && employee.phone) || account.phone || '',
      email: (employee && employee.email) || ''
    }
  } catch (err) {
    fastify.log.error(err)
    return null // lỗi truy vấn không được làm hỏng cả trang
  }
}

// sidebar.pug được include ở mọi trang nên cần biến "supportStaff" ở mọi view của khách hàng.
// Thay vì sửa từng route, bọc reply.view: khi view có user.role = 'customer' thì tự nạp
// supportStaff vào dữ liệu render (view nào tự truyền supportStaff thì giữ nguyên).
fastify.addHook('onRequest', async (req, reply) => {
  const originalView = reply.view
  if (typeof originalView !== 'function') return

  reply.view = async function (template, data, opts) {
    let ctx = data || {}
    if (ctx.user && ctx.user.role === 'customer') {
      const extra = {}
      if (ctx.supportStaff === undefined) extra.supportStaff = await getSupportStaff(ctx.user.id)
      // Số thông báo chưa đọc -> hiện huy hiệu trên menu (view nào tự truyền thì giữ nguyên)
      if (ctx.unreadAnnouncementCount === undefined) extra.unreadAnnouncementCount = await getUnreadAnnouncementCount(ctx.user.id)
      ctx = { ...ctx, ...extra }
    }
    return originalView.call(this, template, ctx, opts)
  }
})

// ================= MIDDLEWARES =================
async function auth(req, reply) {
  try {
    const token = req.cookies.token
    req.user = fastify.jwt.verify(token)
  } catch (err) {
    return reply.redirect('/login')
  }
}

function isAdmin(req, reply, done) {
  if (req.user.role !== 'admin') {
    return reply.status(403).send('❌ Bạn không có quyền thực hiện hành động này')
  }
  done()
}

// Chặn tài khoản KHÁCH HÀNG khỏi mọi chức năng nội bộ (quản lý khách hàng, đơn hàng, bảo hành...).
// Dùng: { preHandler: staff }  (= đã đăng nhập + không phải khách hàng)
function staffOnly(req, reply, done) {
  if (req.user.role === 'customer') {
    return reply.status(403).send('❌ Tài khoản khách hàng không có quyền truy cập chức năng này')
  }
  done()
}

// Chỉ tài khoản KHÁCH HÀNG mới vào được cổng khách hàng (/my/...)
function customerOnly(req, reply, done) {
  if (req.user.role !== 'customer') {
    return reply.status(403).send('❌ Chức năng này dành cho tài khoản khách hàng')
  }
  done()
}

const staff = [auth, staffOnly]

// ================= TRANG GỐC =================
fastify.get('/', async (req, reply) => {
  reply.redirect('/login')
})

// ================= ĐĂNG NHẬP / ĐĂNG XUẤT =================
fastify.get('/login', async (req, reply) => {
  return reply.view('login.pug')
})

fastify.post('/login', async (req, reply) => {
  const { username, password } = req.body
  const user = await fastify.mongo.db.collection('users').findOne({ username })

  if (!user) {
    return reply.view('login.pug', { error: 'Tài khoản không tồn tại' })
  }

  const storedPassword = user.password || ''
  const isHashedPassword = typeof storedPassword === 'string' && storedPassword.startsWith('$2')
  const match = isHashedPassword
    ? await bcrypt.compare(password, storedPassword)
    : password === storedPassword

  if (!match) {
    return reply.view('login.pug', { error: 'Mật khẩu không chính xác' })
  }

  if (!isHashedPassword) {
    const hashedPassword = await bcrypt.hash(password, 10)
    await fastify.mongo.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } }
    )
  }

  const token = fastify.jwt.sign({
    id: user._id,
    username: user.username,
    role: user.role,
    name: user.name || user.username
  })

  // Nhân viên đăng nhập -> tự động chuyển trạng thái thành "Đang làm việc"
  if (user.role === 'user') {
    await setWorkStatusForAccount(user._id, 'Đang làm việc')
  }

  reply.setCookie('token', token, {
    path: '/',
    httpOnly: true,
    maxAge: 3600 * 24
  }).redirect('/dashboard')
})

fastify.get('/logout', async (req, reply) => {
  // Nhân viên đăng xuất -> tự động chuyển trạng thái thành "Ngưng làm việc"
  try {
    if (req.cookies && req.cookies.token) {
      const decoded = fastify.jwt.verify(req.cookies.token)
      if (decoded && decoded.role === 'user') {
        await setWorkStatusForAccount(decoded.id, 'Ngưng làm việc')
      }
    }
  } catch (err) {
    // token không hợp lệ/hết hạn -> bỏ qua, vẫn tiến hành đăng xuất bình thường
  }
  reply.clearCookie('token').redirect('/login')
})

// ================= CẤP TÀI KHOẢN =================
// ADMIN và NHÂN VIÊN đều được cấp tài khoản, nhưng phạm vi khác nhau:
//   - Admin: cấp được cả 2 loại
//       + Nhân viên (role = 'user')      -> tự tạo hồ sơ nhân sự trong "employees"
//       + Khách hàng (role = 'customer') -> liên kết với 1 hồ sơ trong "customers"
//   - Nhân viên (role = 'user'): CHỈ cấp được tài khoản KHÁCH HÀNG, và chỉ cho khách
//       do chính mình phụ trách (assignedTo = mình). Hồ sơ khách mới tạo qua form này
//       tự động gán cho nhân viên đó. Không thể cấp tài khoản Nhân viên/Admin.
//   Với khách hàng: chọn hồ sơ có sẵn (chưa có tài khoản) hoặc để trống để tạo hồ sơ mới.

async function loadRegisterData(req) {
  const db = fastify.mongo.db
  // userId: null khớp cả hồ sơ chưa có trường userId lẫn userId rỗng => khách chưa có tài khoản
  // Nhân viên chỉ thấy khách hàng do mình phụ trách; admin thấy tất cả.
  const linkableFilter = { userId: null, ...scopeFilter(req, 'assignedTo') }
  const [staffList, linkableCustomers] = await Promise.all([
    db.collection('users').find({ role: { $in: STAFF_ROLES } }).sort({ name: 1 }).toArray(),
    db.collection('customers').find(linkableFilter).sort({ name: 1 }).toArray()
  ])
  return { staffList, linkableCustomers }
}

fastify.get('/register', { preHandler: staff }, async (req, reply) => {
  // Admin + Nhân viên được vào; tài khoản khách hàng bị chặn bởi middleware "staff"

  // /register?customerId=... : mở sẵn form cấp tài khoản cho 1 khách hàng có sẵn (nút "Cấp TK" ở danh sách KH)
  const prefillCustomerId = normalizeObjectId(req.query.customerId)

  return reply.view('register.pug', {
    user: req.user,
    error: null,
    form: {},
    prefillCustomerId: prefillCustomerId ? String(prefillCustomerId) : '',
    ...(await loadRegisterData(req))
  })
})

fastify.post('/register', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const body = req.body || {}
  const isAdminUser = req.user.role === 'admin'
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const name = String(body.name || '').trim()
  const phone = String(body.phone || '').trim()
  // Nhân viên bị ép role = 'customer' ở phía server (không tin dữ liệu từ form)
  const role = isAdminUser ? body.role : 'customer'

  const fail = async message => reply.view('register.pug', {
    user: req.user,
    error: message,
    form: body,
    prefillCustomerId: '',
    ...(await loadRegisterData(req))
  })

  // Chỉ cấp tài khoản Nhân viên hoặc Khách hàng (Admin không cấp qua form này)
  if (role !== 'user' && role !== 'customer') {
    return reply.status(400).send('❌ Vai trò tài khoản không hợp lệ')
  }

  if (username.length < 3) return fail('Tên đăng nhập phải có ít nhất 3 ký tự!')
  if (password.length < 6) return fail('Mật khẩu phải có ít nhất 6 ký tự!')

  const existingUser = await db.collection('users').findOne({ username })
  if (existingUser) return fail('Tên đăng nhập đã tồn tại!')

  // ----- Xác định hồ sơ khách hàng (nếu cấp tài khoản khách hàng) -----
  let linkedCustomer = null
  if (role === 'customer') {
    const linkId = normalizeObjectId(body.customerId)
    if (linkId) {
      linkedCustomer = await db.collection('customers').findOne({ _id: linkId })
      if (!linkedCustomer) return fail('Không tìm thấy hồ sơ khách hàng đã chọn!')
      if (linkedCustomer.userId) return fail('Khách hàng này đã có tài khoản đăng nhập!')
      // Nhân viên chỉ được cấp tài khoản cho khách hàng do chính mình phụ trách
      if (!isAdminUser && !canActOnRecord(req, linkedCustomer)) {
        return reply.status(403).send('❌ Bạn chỉ được cấp tài khoản cho khách hàng do bạn phụ trách')
      }
    } else if (!name) {
      return fail('Vui lòng nhập họ tên khách hàng!')
    }
  } else if (!name) {
    return fail('Vui lòng nhập họ tên nhân viên!')
  }

  const displayName = name || (linkedCustomer && linkedCustomer.name) || username
  const displayPhone = phone || (linkedCustomer && linkedCustomer.phone) || ''
  const hash = await bcrypt.hash(password, 10)

  const userDoc = {
    username,
    password: hash,
    // admin = Quản trị viên | user = Nhân viên | customer = Khách hàng
    role,
    name: displayName,
    phone: displayPhone,
    createdBy: normalizeObjectId(req.user.id),
    createdAt: new Date()
  }

  const { insertedId: accountId } = await db.collection('users').insertOne(userDoc)

  if (role === 'user') {
    // Cấp tài khoản Nhân viên -> tự động khởi tạo hồ sơ nhân viên tương ứng
    await createEmployeeForUserAccount(accountId, { name: displayName, phone: displayPhone })
  } else {
    // Cấp tài khoản Khách hàng -> liên kết (hoặc tạo mới) hồ sơ khách hàng
    let customerDocId
    if (linkedCustomer) {
      customerDocId = linkedCustomer._id
      await db.collection('customers').updateOne({ _id: customerDocId }, { $set: { userId: accountId } })
    } else {
      const created = await db.collection('customers').insertOne({
        customerCode: String(body.customerCode || '').trim() || `KH-${Date.now().toString().slice(-6)}`,
        name: displayName,
        phone: displayPhone,
        email: String(body.email || '').trim(),
        address: String(body.address || '').trim(),
        birthDate: body.birthDate || '',
        // Nhân viên tạo hồ sơ mới -> tự phụ trách; admin được chọn người phụ trách
        assignedTo: isAdminUser ? normalizeObjectId(body.assignedTo) : normalizeObjectId(req.user.id),
        note: 'Hồ sơ được tạo tự động khi cấp tài khoản đăng nhập cho khách hàng.',
        userId: accountId,
        createdAt: new Date()
      })
      customerDocId = created.insertedId
    }
    await db.collection('users').updateOne({ _id: accountId }, { $set: { customerId: customerDocId } })
    await syncCustomerBirthdayReminder(customerDocId)
  }

  // Admin xem được danh sách tài khoản; nhân viên không vào được /accounts -> về danh sách khách hàng
  reply.redirect(isAdminUser ? '/accounts' : '/customers')
})

// ================= QUẢN LÝ TÀI KHOẢN =================
// ================= DANH SÁCH TÀI KHOẢN (chỉ Admin) =================
// Hiển thị cả 3 loại: Admin, Nhân viên, Khách hàng. Lọc bằng ?role=admin|user|customer

fastify.get('/accounts', { preHandler: [auth] }, async (req, reply) => {

  if (req.user.role !== 'admin') {
    return reply.status(403).send(
      '❌ Bạn không có quyền xem danh sách tài khoản'
    )
  }

  const roleFilter = ALL_ROLES.includes(req.query.role) ? req.query.role : ''

  const accounts = await fastify.mongo.db
    .collection('users')
    .find({ role: roleFilter || { $in: ALL_ROLES } })
    .sort({ name: 1 })
    .toArray()

  const accountsView = accounts.map(a => ({
    ...a,
    passwordStatus:
      typeof a.password === 'string' &&
      a.password.startsWith('$2')
        ? 'Đã mã hóa'
        : 'Mật khẩu thường'
  }))

  return reply.view('accounts.pug', {
    accounts: accountsView,
    user: req.user,
    roleFilter
  })
})

// ================= SỬA TÀI KHOẢN =================
// Admin sửa được mọi tài khoản. Nhân viên chỉ sửa được tài khoản của chính mình.
// Khách hàng không vào được đây (sửa thông tin cá nhân qua /profile/edit).

fastify.get('/accounts/edit/:id', { preHandler: staff }, async (req, reply) => {

  const accountId = normalizeObjectId(req.params.id)
  const account = accountId
    ? await fastify.mongo.db.collection('users').findOne({ _id: accountId })
    : null

  if (!account) {
    return reply.status(404).send('❌ Không tìm thấy tài khoản')
  }

  if (req.user.role === 'user' && String(account._id) !== String(req.user.id)) {
    return reply.status(403).send('❌ Nhân viên chỉ được sửa tài khoản của chính mình')
  }

  return reply.view('account_edit.pug', {
    account,
    user: req.user,
    error: null
  })
})


fastify.post('/accounts/edit/:id', { preHandler: staff }, async (req, reply) => {

  const { name, phone } = req.body

  const accountId = normalizeObjectId(req.params.id)
  const account = accountId
    ? await fastify.mongo.db.collection('users').findOne({ _id: accountId })
    : null

  if (!account) {
    return reply.status(404).send('❌ Không tìm thấy tài khoản')
  }

  if (req.user.role === 'user' && String(account._id) !== String(req.user.id)) {
    return reply.status(403).send('❌ Nhân viên chỉ được sửa tài khoản của chính mình')
  }

  // Thông tin được phép sửa (vai trò không đổi được qua form)
  const updateData = {
    name: name || account.name,
    phone: phone || ''
  }

  await fastify.mongo.db
    .collection('users')
    .updateOne({ _id: accountId }, { $set: updateData })

  // Tài khoản khách hàng: đồng bộ tên / SĐT sang hồ sơ khách hàng liên kết
  if (account.role === 'customer') {
    await fastify.mongo.db
      .collection('customers')
      .updateOne(
        { userId: accountId },
        { $set: { name: updateData.name, phone: updateData.phone } }
      )
  }

  // Nhân viên tự sửa tài khoản của mình không vào được /accounts (chỉ Admin) -> quay về hồ sơ
  reply.redirect(req.user.role === 'admin' ? '/accounts' : '/profile')
})

// ================= XÓA TÀI KHOẢN =================
// CHỈ ADMIN ĐƯỢC XÓA

fastify.get('/accounts/delete/:id', { preHandler: [auth] }, async (req, reply) => {

  if (req.user.role !== 'admin') {
    return reply.status(403).send(
      '❌ Chỉ Admin mới có quyền xóa tài khoản'
    )
  }

  if (req.params.id === String(req.user.id)) {
    return reply.status(400).send(
      '❌ Không thể tự xóa tài khoản đang đăng nhập'
    )
  }

  const accountId = normalizeObjectId(req.params.id)
  if (!accountId) {
    return reply.status(400).send('❌ Mã tài khoản không hợp lệ')
  }

  await fastify.mongo.db
    .collection('users')
    .deleteOne({ _id: accountId })

  // Nhân viên bị xóa -> các khách hàng họ phụ trách chuyển về "chưa phân công"
  await fastify.mongo.db
    .collection('customers')
    .updateMany(
      { assignedTo: accountId },
      { $set: { assignedTo: null } }
    )

  // Tài khoản khách hàng bị xóa -> GIỮ hồ sơ khách hàng (đơn hàng, bảo hành...), chỉ gỡ liên kết
  await fastify.mongo.db
    .collection('customers')
    .updateMany(
      { userId: accountId },
      { $unset: { userId: '' } }
    )

  reply.redirect('/accounts')
})

// ================= QUẢN LÝ NHÂN VIÊN (HỒ SƠ NHÂN SỰ) =================
// Lưu ý: khác với "users" (tài khoản đăng nhập hệ thống). Đây là hồ sơ nhân sự
// dùng để kiểm soát số lượng nhân viên và trạng thái làm việc (đang làm / đã nghỉ).
// Chỉ Admin được xem và thao tác.

fastify.get('/employees', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees')
    .find({})
    .sort({ createdAt: -1 })
    .toArray()

  const totalCount = employees.length
  const activeCount = employees.filter(e => e.status === 'Đang làm việc').length
  const inactiveCount = totalCount - activeCount

  return reply.view('employees.pug', {
    employees,
    user: req.user,
    totalCount,
    activeCount,
    inactiveCount
  })
})


// Chi tiết nhân viên: toàn bộ thông tin hồ sơ + tài khoản đăng nhập liên kết
fastify.get('/employees/detail/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employeeId = normalizeObjectId(req.params.id)
  const employee = employeeId
    ? await fastify.mongo.db.collection('employees').findOne({ _id: employeeId })
    : null
  if (!employee) return reply.status(404).send('❌ Không tìm thấy nhân viên')

  const accountId = normalizeObjectId(employee.userId)

  const usersCol = fastify.mongo.db.collection('users')
  const accountById = accountId ? await usersCol.findOne({ _id: accountId }) : null
  // Dự phòng: hồ sơ cũ có thể thiếu userId -> tra ngược qua users.employeeId
  const account = accountById || await usersCol.findOne({ employeeId: employee._id })

  const startDateText = employee.startDate ? formatDate(employee.startDate) : ''
  const seniority = formatSeniority(employee.startDate)

  const info = {
    birthYearText: employee.birthYear
      ? `${employee.birthYear} (${new Date().getFullYear() - Number(employee.birthYear)} tuổi)`
      : '',
    startDateText: startDateText && seniority ? `${startDateText} (thâm niên ${seniority})` : startDateText,
    createdAtText: employee.createdAt ? new Date(employee.createdAt).toLocaleString('vi-VN') : '',
    accountRoleText: account ? (account.role === 'admin' ? 'Quản trị viên' : 'Nhân viên') : '',
    accountCreatedAtText: account && account.createdAt ? new Date(account.createdAt).toLocaleString('vi-VN') : ''
  }

  return reply.view('employee_detail.pug', { employee, account, info, user: req.user })
})

fastify.get('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employee = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
  if (!employee) return reply.status(404).send('❌ Không tìm thấy nhân viên')

  return reply.view('employee_edit.pug', {
    employee,
    user: req.user,
    genders: EMPLOYEE_GENDERS,
    statuses: EMPLOYEE_STATUSES
  })
})

fastify.post('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const body = req.body || {}
  const name = fieldValue(body.name)
  const birthYear = fieldValue(body.birthYear)
  const gender = fieldValue(body.gender)
  const phone = fieldValue(body.phone)
  const email = fieldValue(body.email)
  const startDate = fieldValue(body.startDate)
  const status = fieldValue(body.status)
  const address = fieldValue(body.address)
  const note = fieldValue(body.note)

  const employee = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
  if (!employee) return reply.status(404).send('❌ Không tìm thấy nhân viên')

  await fastify.mongo.db.collection('employees').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        name,
        birthYear: birthYear ? Number(birthYear) : null,
        gender: gender || 'Nam',
        phone: phone || '',
        email: email || '',
        // Chức vụ cố định là "Nhân viên", không nhận giá trị từ form
        position: EMPLOYEE_POSITION,
        startDate: startDate || '',
        address: address || '',
        note: note || '',
        // Trạng thái thường tự động theo đăng nhập/đăng xuất; admin vẫn chỉnh tay được
        // (VD: nhân viên tắt trình duyệt mà chưa đăng xuất nên bị kẹt "Đang làm việc")
        status: EMPLOYEE_STATUSES.includes(status) ? status : employee.status
      }
    }
  )

  reply.redirect('/employees')
})

// Chuyển nhanh trạng thái Đang làm việc / Ngưng làm việc ngay trên danh sách (admin)
fastify.get('/employees/toggle-status/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employee = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
  if (!employee) return reply.status(404).send('❌ Không tìm thấy nhân viên')

  const newStatus = employee.status === 'Đang làm việc' ? 'Ngưng làm việc' : 'Đang làm việc'
  await fastify.mongo.db.collection('employees').updateOne({ _id: employee._id }, { $set: { status: newStatus } })
  reply.redirect('/employees')
})

fastify.get('/employees/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('employees').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/employees')
})

// ================= DASHBOARD =================
fastify.get('/dashboard', { preHandler: [auth] }, async (req, reply) => {
  // Khách hàng có trang chủ riêng (không thấy số liệu nội bộ của cửa hàng)
  if (req.user.role === 'customer') {
    return reply.view('portal_home.pug', await buildCustomerPortalData(req))
  }

  const customerScope = scopeFilter(req, 'assignedTo')
  const orderScope = scopeFilter(req, 'assignedTo')

  const db = fastify.mongo.db
  const [customerCount, openOrderCount, warranties, productCount, lowStockProducts, employeeCount, activeEmployeeCount] = await Promise.all([
    db.collection('customers').countDocuments(customerScope),
    db.collection('orders').countDocuments({ ...orderScope, status: 'open' }),
    db.collection('warranties').find(req.user.role === 'admin' ? {} : { assignedTo: normalizeObjectId(req.user.id) }).toArray(),
    db.collection('products').countDocuments({}),
    db.collection('products').find({ stockQty: { $lte: LOW_STOCK_THRESHOLD } }).sort({ stockQty: 1 }).limit(5).toArray(),
    db.collection('employees').countDocuments({}),
    db.collection('employees').countDocuments({ status: 'Đang làm việc' })
  ])

  const expiringWarranties = warranties
    .map(w => {
      const days = daysUntil(w.expiryDate)
      if (days === null || days < 0 || days > 30) return null
      return { ...w, daysUntilExpiration: days }
    })
    .filter(Boolean)
    .sort((a, b) => a.daysUntilExpiration - b.daysUntilExpiration)

  const dashboardStats = {
    customerCount,
    openOrderCount,
    warrantyCount: warranties.length,
    expiringWarranties,
    productCount,
    lowStockProducts,
    employeeCount,
    activeEmployeeCount
  }

  return reply.view('dashboard.pug', { user: req.user, dashboardStats })
})



// ================= KHÁCH HÀNG (CUSTOMERS) =================
fastify.get('/customers', { preHandler: staff }, async (req, reply) => {
  const searchKeyword = String(req.query.keyword || '').trim()
  const searchRegex = buildContainsRegex(searchKeyword)
  const showBirthdayOnly = req.query.filter === 'birthday'

  const filter = { ...scopeFilter(req, 'assignedTo') }
  if (searchRegex) {
    filter.$or = [
      { name: searchRegex },
      { customerCode: searchRegex },
      { phone: searchRegex },
      { email: searchRegex }
    ]
  }

  let customers = await fastify.mongo.db.collection('customers')
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray()

  if (showBirthdayOnly) customers = customers.filter(c => isBirthdayThisMonth(c.birthDate))

  const staffIds = customers.filter(c => c.assignedTo).map(c => c.assignedTo)
  const staffList = staffIds.length
    ? await fastify.mongo.db.collection('users').find({ _id: { $in: staffIds } }).toArray()
    : []
  const staffNameById = new Map(staffList.map(s => [s._id.toString(), s.name || s.username]))

  const customersView = customers.map(c => ({
    ...c,
    assignedToName: c.assignedTo ? (staffNameById.get(c.assignedTo.toString()) || 'Chưa rõ') : 'Chưa phân công',
    isBirthdayMonth: isBirthdayThisMonth(c.birthDate)
  }))

  return reply.view('customers.pug', {
    customers: customersView, user: req.user, searchKeyword,
    showBirthdayOnly
  })
})

fastify.get('/customers/add', { preHandler: staff }, async (req, reply) => {
  const staffList = await fastify.mongo.db.collection('users').find({ role: { $in: STAFF_ROLES } }).sort({ name: 1 }).toArray()
  return reply.view('customer_add.pug', {
    user: req.user, staffList
  })
})

fastify.post('/customers/add', { preHandler: staff }, async (req, reply) => {
  const { customerCode, name, phone, email, address, birthDate, assignedTo, note } = req.body

  const inserted = await fastify.mongo.db.collection('customers').insertOne({
    customerCode: customerCode || `KH-${Date.now().toString().slice(-6)}`,
    name,
    phone: phone || '',
    email: email || '',
    address: address || '',
    birthDate: birthDate || '',
    assignedTo: assignedTo ? normalizeObjectId(assignedTo) : normalizeObjectId(req.user.id),
    note: note || '',
    createdAt: new Date()
  })

  // Khách mới có sinh nhật trong tháng này -> tạo lịch nhắc ngay
  await syncCustomerBirthdayReminder(inserted.insertedId)

  reply.redirect('/customers')
})

fastify.get('/customers/edit/:id', { preHandler: staff }, async (req, reply) => {
  const customer = await fastify.mongo.db.collection('customers').findOne({ _id: new ObjectId(req.params.id) })
  if (!customer) return reply.status(404).send('❌ Không tìm thấy khách hàng')
  const staffList = await fastify.mongo.db.collection('users').find({ role: { $in: STAFF_ROLES } }).sort({ name: 1 }).toArray()
  return reply.view('customer_edit.pug', {
    customer, staffList, user: req.user
  })
})

fastify.post('/customers/edit/:id', { preHandler: staff }, async (req, reply) => {
  const { customerCode, name, phone, email, address, birthDate, assignedTo, note } = req.body

  await fastify.mongo.db.collection('customers').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        customerCode, name, phone: phone || '', email: email || '',
        address: address || '', birthDate: birthDate || '',
        assignedTo: assignedTo ? normalizeObjectId(assignedTo) : null,
        note: note || ''
      }
    }
  )

  // Đổi ngày sinh / người phụ trách -> cập nhật lịch nhắc sinh nhật
  await syncCustomerBirthdayReminder(req.params.id)

  reply.redirect('/customers')
})

fastify.get('/customers/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const customerId = new ObjectId(req.params.id)
  const customerDoc = await fastify.mongo.db.collection('customers').findOne({ _id: customerId })
  if (customerDoc && customerDoc.userId) {
    // Khách hàng bị xóa thì tài khoản đăng nhập của họ cũng không còn ý nghĩa
    await fastify.mongo.db.collection('users').deleteOne({ _id: customerDoc.userId, role: 'customer' })
  }
  await fastify.mongo.db.collection('customers').deleteOne({ _id: customerId })
  await fastify.mongo.db.collection('reminders').deleteMany({ customerId })
  await fastify.mongo.db.collection('orders').deleteMany({ customerId })
  await fastify.mongo.db.collection('warranties').deleteMany({ customerId })
  await fastify.mongo.db.collection('activities').deleteMany({ customerId })
  await fastify.mongo.db.collection('complaints').deleteMany({ customerId })
  await fastify.mongo.db.collection('announcement_recipients').deleteMany({ customerId })
  reply.redirect('/customers')
})

fastify.get('/customers/detail/:id', { preHandler: staff }, async (req, reply) => {
  const customerId = new ObjectId(req.params.id)
  const customer = await fastify.mongo.db.collection('customers').findOne({ _id: customerId })
  if (!customer) return reply.status(404).send('❌ Không tìm thấy khách hàng')

  if (!canAccessCustomer(req, customer)) {
    return reply.status(403).send('❌ Bạn không có quyền xem khách hàng này')
  }

  const [orders, activities, warranties, reminders, assignedStaff] = await Promise.all([
    fastify.mongo.db.collection('orders').find({ customerId }).sort({ createdAt: -1 }).toArray(),
    fastify.mongo.db.collection('activities').find({ customerId }).sort({ createdAt: -1 }).toArray(),
    fastify.mongo.db.collection('warranties').find({ customerId }).sort({ purchaseDate: -1 }).toArray(),
    fastify.mongo.db.collection('reminders').find({ customerId }).sort({ dueDate: 1 }).toArray(),
    customer.assignedTo ? fastify.mongo.db.collection('users').findOne({ _id: customer.assignedTo }) : null
  ])

  const staffIds = [...new Set(activities.filter(a => a.createdBy).map(a => a.createdBy.toString()))]
  const staffList = staffIds.length
    ? await fastify.mongo.db.collection('users').find({ _id: { $in: staffIds.map(id => new ObjectId(id)) } }).toArray()
    : []
  const staffNameById = new Map(staffList.map(s => [s._id.toString(), s.name || s.username]))

  const activitiesView = activities.map(a => ({
    ...a,
    createdAtText: formatDate(a.createdAt),
    createdByName: a.createdBy ? (staffNameById.get(a.createdBy.toString()) || 'Nhân viên') : 'Hệ thống'
  }))

  const ordersView = orders.map(o => ({ ...o, createdAtText: formatDate(o.createdAt) }))

  const warrantiesView = warranties.map(w => ({ ...w, effectiveStatus: warrantyEffectiveStatus(w) }))

  const remindersView = reminders.map(r => ({
    ...r,
    dueDateText: formatDate(r.dueDate),
    isOverdue: r.status !== 'Đã hoàn thành' && daysUntil(r.dueDate) !== null && daysUntil(r.dueDate) < 0
  }))

  return reply.view('customer_detail.pug', {
    customer, orders: ordersView, activities: activitiesView, warranties: warrantiesView,
    reminders: remindersView,
    assignedStaffName: assignedStaff ? (assignedStaff.name || assignedStaff.username) : 'Chưa phân công',
    activityTypes: ACTIVITY_TYPES,
    user: req.user
  })
})

// Ghi 1 hoạt động chăm sóc khách hàng THỦ CÔNG (gọi điện, nhắn Zalo, gặp trực tiếp...).
// Trước đây hệ thống chỉ tự sinh log khi có sự kiện đơn hàng/bảo hành - nhân viên không có
// cách nào ghi lại việc mình vừa tư vấn/chăm sóc khách, dù đây là chức năng lõi của CRM.
fastify.post('/customers/:id/activities', { preHandler: staff }, async (req, reply) => {
  const customerId = normalizeObjectId(req.params.id)
  const customer = customerId ? await fastify.mongo.db.collection('customers').findOne({ _id: customerId }) : null
  if (!customer) return reply.status(404).send('❌ Không tìm thấy khách hàng')

  if (!canAccessCustomer(req, customer)) {
    return reply.status(403).send('❌ Bạn không có quyền thao tác trên khách hàng này')
  }

  const { type, note } = req.body
  if (String(note || '').trim()) {
    await logActivity(fastify.mongo.db, {
      customerId,
      type: ACTIVITY_TYPES.includes(type) ? type : 'Khác',
      note: String(note).trim(),
      userId: req.user.id
    })
  }

  reply.redirect(`/customers/detail/${req.params.id}`)
})

// ================= NHẮC LỊCH CHĂM SÓC KHÁCH HÀNG (REMINDERS) =================
// Trước đây "nhắc lịch chăm sóc sau bán hàng" chỉ là 1 dòng chữ trong activity, không có
// ngày hẹn, không có trạng thái xong/chưa xong, không hiện nhắc việc ở đâu cả. Nay thêm hẳn
// 1 collection "reminders" để nhân viên đặt lịch gọi lại/chăm sóc khách và được nhắc đúng hạn.

fastify.post('/customers/:id/reminders', { preHandler: staff }, async (req, reply) => {
  const customerId = normalizeObjectId(req.params.id)
  const customer = customerId ? await fastify.mongo.db.collection('customers').findOne({ _id: customerId }) : null
  if (!customer) return reply.status(404).send('❌ Không tìm thấy khách hàng')

  if (!canAccessCustomer(req, customer)) {
    return reply.status(403).send('❌ Bạn không có quyền thao tác trên khách hàng này')
  }

  const { dueDate, note } = req.body
  if (dueDate) {
    const owner = customer.assignedTo || normalizeObjectId(req.user.id)
    await fastify.mongo.db.collection('reminders').insertOne({
      customerId,
      dueDate,
      note: note || '',
      status: REMINDER_STATUSES[0],
      assignedTo: owner,
      createdBy: normalizeObjectId(req.user.id),
      createdAt: new Date()
    })
  }

  reply.redirect(`/customers/detail/${req.params.id}`)
})

// Danh sách nhắc việc: mặc định "Chờ thực hiện" và sắp xếp theo ngày hẹn gần nhất trước
fastify.get('/reminders', { preHandler: staff }, async (req, reply) => {
  const showDone = req.query.filter === 'done'
  const filter = { ...scopeFilter(req, 'assignedTo') }
  filter.status = showDone ? 'Đã hoàn thành' : 'Chờ thực hiện'

  const reminders = await fastify.mongo.db.collection('reminders')
    .find(filter)
    .sort({ dueDate: 1 })
    .toArray()

  const customerIds = reminders.filter(r => r.customerId).map(r => r.customerId)
  const customers = customerIds.length
    ? await fastify.mongo.db.collection('customers').find({ _id: { $in: customerIds } }).toArray()
    : []
  const customerById = new Map(customers.map(c => [c._id.toString(), c]))

  const remindersView = reminders.map(r => {
    const days = daysUntil(r.dueDate)
    return {
      ...r,
      dueDateText: formatDate(r.dueDate),
      customer: r.customerId ? customerById.get(r.customerId.toString()) : null,
      isOverdue: r.status !== 'Đã hoàn thành' && days !== null && days < 0
    }
  })

  return reply.view('reminders.pug', { reminders: remindersView, user: req.user, showDone })
})

fastify.get('/reminders/done/:id', { preHandler: staff }, async (req, reply) => {
  await fastify.mongo.db.collection('reminders').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: 'Đã hoàn thành', completedAt: new Date() } }
  )
  reply.redirect('/reminders')
})

fastify.get('/reminders/delete/:id', { preHandler: staff }, async (req, reply) => {
  await fastify.mongo.db.collection('reminders').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/reminders')
})

// ================= SẢN PHẨM / KHO ĐIỆN THOẠI (PRODUCTS) =================
// Danh sách hiển thị: Mã SP, Tên SP, Hãng, Danh mục, Tồn kho, Chi tiết.
// Trang "Chi tiết" hiển thị: tên SP, mã SP, bảo hành, loại, hãng, màu.
fastify.get('/products', { preHandler: [auth] }, async (req, reply) => {
  const searchKeyword = String(req.query.keyword || '').trim()
  const searchRegex = buildContainsRegex(searchKeyword)
  const filter = {}
  if (searchRegex) {
    filter.$or = [{ name: searchRegex }, { sku: searchRegex }, { brand: searchRegex }, { category: searchRegex }]
  }
  // Bộ lọc "sắp hết hàng" là thông tin nội bộ -> không áp dụng cho khách hàng
  const showLowStockOnly = req.query.filter === 'lowstock' && req.user.role !== 'customer'
  if (showLowStockOnly) filter.stockQty = { $lte: LOW_STOCK_THRESHOLD }

  const products = await fastify.mongo.db.collection('products').find(filter).sort({ createdAt: -1 }).toArray()

  return reply.view('products.pug', { products, user: req.user, searchKeyword, showLowStockOnly })
})

fastify.get('/products/detail/:id', { preHandler: [auth] }, async (req, reply) => {
  const productId = normalizeObjectId(req.params.id)
  const product = productId ? await fastify.mongo.db.collection('products').findOne({ _id: productId }) : null
  if (!product) return reply.status(404).send('❌ Không tìm thấy sản phẩm')
  return reply.view('product_detail.pug', { product, user: req.user })
})

fastify.get('/products/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('product_add.pug', { user: req.user, brands: PRODUCT_BRANDS, categories: PRODUCT_CATEGORIES, productTypes: PRODUCT_TYPES })
})

fastify.post('/products/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const body = req.body || {}
  const data = parseProductFields(body)

  await fastify.mongo.db.collection('products').insertOne({
    ...data,
    sku: data.sku || `SP-${Date.now().toString().slice(-6)}`,
    createdAt: new Date()
  })
  reply.redirect('/products')
})

fastify.get('/products/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const productId = normalizeObjectId(req.params.id)
  const product = productId ? await fastify.mongo.db.collection('products').findOne({ _id: productId }) : null
  if (!product) return reply.status(404).send('❌ Không tìm thấy sản phẩm')
  return reply.view('product_edit.pug', { product, user: req.user, brands: PRODUCT_BRANDS, categories: PRODUCT_CATEGORIES, productTypes: PRODUCT_TYPES })
})

fastify.post('/products/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const body = req.body || {}
  const updateSet = parseProductFields(body)
  // Không ghi đè mã SP bằng chuỗi rỗng
  if (!updateSet.sku) delete updateSet.sku

  await fastify.mongo.db.collection('products').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: updateSet,
      // Đã bỏ mục "Trạng thái" -> dọn trường status cũ (nếu có) khỏi dữ liệu
      $unset: { status: '' }
    }
  )
  reply.redirect('/products')
})

fastify.get('/products/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('products').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/products')
})

// ================= ĐƠN HÀNG BÁN (ORDERS) - trước là "deals" =================
fastify.get('/orders', { preHandler: staff }, async (req, reply) => {
  const searchKeyword = String(req.query.keyword || '').trim()
  const searchRegex = buildContainsRegex(searchKeyword)
  const filter = { ...scopeFilter(req, 'assignedTo') }
  if (searchRegex) filter.orderCode = searchRegex

  const orders = await fastify.mongo.db.collection('orders').find(filter).sort({ createdAt: -1 }).toArray()

  const customers = await fastify.mongo.db.collection('customers').find().toArray()
  const customerNameById = new Map(customers.map(c => [c._id.toString(), c.name]))

  const ordersView = orders.map(o => ({
    ...o,
    customerName: o.customerId ? (customerNameById.get(o.customerId.toString()) || 'Chưa rõ') : 'Chưa rõ',
    itemSummary: (o.items || []).map(i => `${i.productName} x${i.quantity}`).join(', '),
    createdAtText: formatDate(o.createdAt)
  }))

  return reply.view('orders.pug', { orders: ordersView, user: req.user, searchKeyword })
})

// Chi tiết đơn hàng (dùng cho cả đơn đang xử lý lẫn đã xác nhận)
fastify.get('/orders/detail/:id', { preHandler: staff }, async (req, reply) => {
  const orderId = normalizeObjectId(req.params.id)
  const order = orderId ? await fastify.mongo.db.collection('orders').findOne({ _id: orderId }) : null
  if (!order) return reply.status(404).send('❌ Không tìm thấy đơn hàng')
  if (!canActOnRecord(req, order)) return reply.status(403).send('❌ Bạn không có quyền xem đơn hàng này')

  const db = fastify.mongo.db
  const productIds = (order.items || []).map(i => i.productId).filter(Boolean)
  const [customer, assignedStaff, products, warranties, activities] = await Promise.all([
    order.customerId ? db.collection('customers').findOne({ _id: order.customerId }) : null,
    order.assignedTo ? db.collection('users').findOne({ _id: order.assignedTo }) : null,
    productIds.length ? db.collection('products').find({ _id: { $in: productIds } }).toArray() : [],
    db.collection('warranties').find({ orderId: order._id }).sort({ purchaseDate: -1 }).toArray(),
    db.collection('activities').find({ orderId: order._id }).sort({ createdAt: -1 }).toArray()
  ])

  const productById = new Map(products.map(p => [p._id.toString(), p]))
  const itemsView = (order.items || []).map(i => {
    const p = i.productId ? productById.get(i.productId.toString()) : null
    return {
      productName: i.productName,
      quantity: i.quantity,
      sku: p ? p.sku : '',
      brand: p ? p.brand : '',
      productId: p ? p._id : null
    }
  })

  const staffIds = [...new Set(activities.filter(a => a.createdBy).map(a => a.createdBy.toString()))]
  const staffList = staffIds.length
    ? await db.collection('users').find({ _id: { $in: staffIds.map(id => new ObjectId(id)) } }).toArray()
    : []
  const staffNameById = new Map(staffList.map(s => [s._id.toString(), s.name || s.username]))
  const activitiesView = activities.map(a => ({
    ...a,
    createdAtText: formatDate(a.createdAt),
    createdByName: a.createdBy ? (staffNameById.get(a.createdBy.toString()) || 'Nhân viên') : 'Hệ thống'
  }))
  const warrantiesView = warranties.map(w => ({ ...w, effectiveStatus: warrantyEffectiveStatus(w) }))

  return reply.view('order_detail.pug', {
    order: {
      ...order,
      createdAtText: formatDate(order.createdAt),
      confirmedAtText: order.confirmedAt ? formatDate(order.confirmedAt) : ''
    },
    customer,
    assignedStaffName: assignedStaff ? (assignedStaff.name || assignedStaff.username) : 'Chưa phân công',
    items: itemsView,
    totalQuantity: itemsView.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    warranties: warrantiesView,
    activities: activitiesView,
    user: req.user
  })
})

fastify.get('/orders/add', { preHandler: staff }, async (req, reply) => {
  const [customers, products] = await Promise.all([
    fastify.mongo.db.collection('customers').find(scopeFilter(req, 'assignedTo')).sort({ name: 1 }).toArray(),
    fastify.mongo.db.collection('products').find().sort({ name: 1 }).toArray()
  ])
  return reply.view('order_add.pug', { customers, products, user: req.user, error: null, form: null })
})

fastify.post('/orders/add', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const { customerId, note } = req.body
  const productIds = toArrayField(req.body.productId)
  const quantities = toArrayField(req.body.quantity)

  // Hiển thị lại form tạo đơn kèm thông báo lỗi, giữ nguyên dữ liệu nhân viên đã nhập
  const renderError = async message => {
    const [customers, products] = await Promise.all([
      db.collection('customers').find(scopeFilter(req, 'assignedTo')).sort({ name: 1 }).toArray(),
      db.collection('products').find().sort({ name: 1 }).toArray()
    ])
    return reply.view('order_add.pug', {
      customers, products, user: req.user, error: message,
      form: {
        customerId: String(customerId || ''),
        note: note || '',
        rows: productIds.map((pid, i) => ({ productId: String(pid || ''), quantity: quantities[i] || 1 }))
      }
    })
  }

  // Gộp các dòng trùng sản phẩm (VD: chọn iPhone 15 ở 2 dòng) để kiểm tra kho theo TỔNG số lượng
  const merged = new Map()
  for (let i = 0; i < productIds.length; i++) {
    const pid = normalizeObjectId(productIds[i])
    const qty = Math.floor(Number(quantities[i]) || 0)
    if (!pid || qty <= 0) continue
    const key = pid.toString()
    if (merged.has(key)) {
      merged.get(key).quantity += qty
    } else {
      const product = await db.collection('products').findOne({ _id: pid })
      if (!product) continue
      merged.set(key, { product, quantity: qty })
    }
  }

  if (merged.size === 0) {
    return renderError('Vui lòng chọn ít nhất một sản phẩm và số lượng hợp lệ.')
  }

  // ----- Kiểm tra tồn kho trước khi tạo đơn -----
  const problems = []
  for (const { product, quantity } of merged.values()) {
    const available = Math.max(0, Number(product.stockQty) || 0)
    if (available <= 0) {
      problems.push(`"${product.name}" đã hết hàng`)
    } else if (quantity > available) {
      problems.push(`"${product.name}" chỉ còn ${available} sản phẩm (bạn chọn ${quantity})`)
    }
  }
  if (problems.length) {
    return renderError(`Đơn hàng này hiện không có sẵn: ${problems.join('; ')}.`)
  }

  const items = [...merged.values()].map(({ product, quantity }) => ({
    productId: product._id,
    productName: product.name,
    quantity
  }))

  // Trừ kho nguyên tử TRƯỚC khi tạo đơn (chặn trường hợp 2 người cùng mua món cuối cùng)
  const reservation = await reserveStock(items)
  if (!reservation.ok) {
    return renderError(`Đơn hàng này hiện không có sẵn: "${reservation.failedItem.productName}" vừa hết hàng hoặc không đủ số lượng.`)
  }

  const orderCode = `DH-${Date.now().toString().slice(-6)}`
  const owner = await resolveOwner(db, customerId, req.user.id)

  let insertedId
  try {
    const result = await db.collection('orders').insertOne({
      orderCode,
      customerId: normalizeObjectId(customerId),
      items,
      assignedTo: owner,
      note: note || '',
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date()
    })
    insertedId = result.insertedId
  } catch (err) {
    // Tạo đơn lỗi -> hoàn lại kho đã trừ để không bị hụt hàng oan
    await adjustStock(items, 1)
    throw err
  }

  await logActivity(db, {
    customerId,
    orderId: insertedId,
    type: 'Đơn hàng',
    note: `Tạo đơn ${orderCode} - ${items.length} sản phẩm`,
    userId: req.user.id
  })

  reply.redirect('/orders')
})

fastify.get('/orders/edit/:id', { preHandler: staff }, async (req, reply) => {
  const order = await fastify.mongo.db.collection('orders').findOne({ _id: new ObjectId(req.params.id) })
  if (!order) return reply.status(404).send('❌ Không tìm thấy đơn hàng')
  if (!canActOnRecord(req, order)) return reply.status(403).send('❌ Bạn không có quyền sửa đơn hàng này')
  const customers = await fastify.mongo.db.collection('customers').find().sort({ name: 1 }).toArray()
  return reply.view('order_edit.pug', { order, customers, user: req.user })
})

// Lưu ý: danh sách sản phẩm trong đơn không chỉnh sửa được ở đây để tránh sai lệch tồn kho.
// Muốn thay đổi sản phẩm/số lượng, xóa đơn (admin, tự hoàn kho nếu đang xử lý) rồi tạo đơn mới.
fastify.post('/orders/edit/:id', { preHandler: staff }, async (req, reply) => {
  const existingOrder = await fastify.mongo.db.collection('orders').findOne({ _id: new ObjectId(req.params.id) })
  if (!existingOrder) return reply.status(404).send('❌ Không tìm thấy đơn hàng')
  if (!canActOnRecord(req, existingOrder)) return reply.status(403).send('❌ Bạn không có quyền sửa đơn hàng này')

  const { customerId, note } = req.body
  const owner = await resolveOwner(fastify.mongo.db, customerId, req.user.id)
  await fastify.mongo.db.collection('orders').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        customerId: normalizeObjectId(customerId),
        assignedTo: owner,
        note: note || '',
        updatedAt: new Date()
      }
    }
  )
  reply.redirect('/orders')
})

// Xác nhận đơn hàng: đây là CRM nên chỉ ghi nhận nhân viên đã xác nhận đơn với khách,
// không theo dõi quá trình giao dịch thực tế (hoàn tất / hủy). Tồn kho đã trừ lúc tạo đơn nên giữ nguyên.
fastify.get('/orders/confirm/:id', { preHandler: staff }, async (req, reply) => {
  const order = await fastify.mongo.db.collection('orders').findOne({ _id: new ObjectId(req.params.id) })
  if (!order) return reply.status(404).send('❌ Không tìm thấy đơn hàng')
  if (!canActOnRecord(req, order)) return reply.status(403).send('❌ Bạn không có quyền thao tác trên đơn hàng này')
  if (order.status !== 'open') return reply.redirect('/orders')
  await fastify.mongo.db.collection('orders').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: 'confirmed', confirmedAt: new Date(), updatedAt: new Date() } }
  )

  // Tự tạo lịch chăm sóc sau bán hàng (7 ngày, 1 tháng) cho nhân viên phụ trách khách.
  // Lỗi ở bước này không được làm hỏng việc xác nhận đơn (đơn đã được cập nhật ở trên).
  let followupLabels = []
  if (order.customerId) {
    try {
      const db = fastify.mongo.db
      const owner = await resolveOwner(db, order.customerId, req.user.id)
      const itemSummary = (order.items || []).map(i => `${i.productName} x${i.quantity}`).join(', ')
      for (const f of AFTER_SALES_FOLLOWUPS) {
        const created = await createAutoReminder(db, {
          autoKey: `after-sales:${order._id}:${f.days}d`,
          customerId: order.customerId,
          dueDate: addDaysFromToday(f.days),
          note: `Chăm sóc sau bán hàng (${f.label}) - đơn ${order.orderCode} (${itemSummary}): ${f.prompt}.`,
          assignedTo: owner,
          source: 'after-sales',
          orderId: order._id
        })
        if (created) followupLabels.push(f.label)
      }
    } catch (err) {
      fastify.log.error(err)
    }
  }

  await logActivity(fastify.mongo.db, {
    customerId: order.customerId,
    orderId: order._id,
    type: 'Đơn hàng',
    note: followupLabels.length
      ? `Xác nhận đơn ${order.orderCode}. Đã tự tạo lịch chăm sóc sau bán hàng: ${followupLabels.join(', ')}.`
      : `Xác nhận đơn ${order.orderCode}.`,
    userId: req.user.id
  })
  reply.redirect('/orders')
})

// CHỈ ADMIN được xóa đơn hàng (trước đây mọi nhân viên đều xóa được, kể cả đơn đã hoàn tất,
// và không hề để lại dấu vết - rủi ro che giấu doanh thu). Nay giới hạn quyền + ghi log.
fastify.get('/orders/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const order = await fastify.mongo.db.collection('orders').findOne({ _id: new ObjectId(req.params.id) })
  if (order && order.status === 'open') {
    await adjustStock(order.items, 1)
  }
  await fastify.mongo.db.collection('orders').deleteOne({ _id: new ObjectId(req.params.id) })
  if (order) {
    // Đơn đã xóa thì không còn lý do nhắc chăm sóc sau bán hàng cho đơn đó
    await fastify.mongo.db.collection('reminders').deleteMany({
      orderId: order._id, auto: true, status: 'Chờ thực hiện'
    })
    await logActivity(fastify.mongo.db, {
      customerId: order.customerId,
      orderId: order._id,
      type: 'Đơn hàng',
      note: `Đã XÓA đơn ${order.orderCode} (bởi quản trị viên).`,
      userId: req.user.id
    })
  }
  reply.redirect('/orders')
})

// ================= PHIẾU BẢO HÀNH (WARRANTIES) - trước là "contracts" =================
fastify.get('/warranties', { preHandler: staff }, async (req, reply) => {
  const searchKeyword = String(req.query.keyword || '').trim()
  const searchRegex = buildContainsRegex(searchKeyword)
  const filter = { ...scopeFilter(req, 'assignedTo') }
  if (searchRegex) filter.warrantyCode = searchRegex

  let warranties = await fastify.mongo.db.collection('warranties').find(filter).sort({ purchaseDate: -1 }).toArray()

  const showExpiringOnly = req.query.filter === 'expiring'
  if (showExpiringOnly) {
    warranties = warranties.filter(w => {
      const days = daysUntil(w.expiryDate)
      return days !== null && days >= 0 && days <= 30
    })
  }

  const customers = await fastify.mongo.db.collection('customers').find().toArray()
  const customerNameById = new Map(customers.map(c => [c._id.toString(), c.name]))

  // Lấy mã đơn hàng cho từng phiếu (nhiều phiếu có thể cùng thuộc 1 đơn)
  const orderIds = [...new Set(warranties.filter(w => w.orderId).map(w => String(w.orderId)))].map(id => new ObjectId(id))
  const orderDocs = orderIds.length
    ? await fastify.mongo.db.collection('orders').find({ _id: { $in: orderIds } }, { projection: { orderCode: 1 } }).toArray()
    : []
  const orderCodeById = new Map(orderDocs.map(o => [o._id.toString(), o.orderCode]))

  const warrantiesView = warranties.map(w => ({
    ...w,
    customerName: w.customerId ? (customerNameById.get(w.customerId.toString()) || 'Chưa rõ') : 'Chưa rõ',
    orderCode: w.orderId ? (orderCodeById.get(w.orderId.toString()) || null) : null,
    effectiveStatus: warrantyEffectiveStatus(w)
  }))

  return reply.view('warranties.pug', { warranties: warrantiesView, user: req.user, searchKeyword, showExpiringOnly })
})

fastify.get('/warranties/add', { preHandler: staff }, async (req, reply) => {
  const orderId = req.query.orderId ? normalizeObjectId(req.query.orderId) : null
  let order = null
  let orderCustomer = null
  if (orderId) {
    order = await fastify.mongo.db.collection('orders').findOne({ _id: orderId })
    if (order && order.customerId) {
      orderCustomer = await fastify.mongo.db.collection('customers').findOne({ _id: order.customerId })
    }
  }
  // Phiếu bảo hành chỉ được tạo từ đơn hàng (nút "Tạo bảo hành" ở mục đơn hàng bán)
  if (!order) return reply.redirect('/orders')
  const [customers, products] = await Promise.all([
    fastify.mongo.db.collection('customers').find(scopeFilter(req, 'assignedTo')).sort({ name: 1 }).toArray(),
    fastify.mongo.db.collection('products').find().sort({ name: 1 }).toArray()
  ])
  const defaultPurchaseDate = order ? toDateInputValue(order.createdAt) : ''

  // Mỗi sản phẩm trong 1 đơn chỉ được tạo bảo hành 1 lần: loại các sản phẩm đã có phiếu khỏi danh sách chọn
  let availableItems = []
  let warrantiedItems = []
  if (order) {
    const existing = await fastify.mongo.db.collection('warranties')
      .find({ orderId: order._id }, { projection: { productId: 1 } }).toArray()
    const warrantiedIds = new Set(existing.filter(w => w.productId).map(w => String(w.productId)))
    const items = order.items || []
    availableItems = items.filter(i => i.productId && !warrantiedIds.has(String(i.productId)))
    warrantiedItems = items.filter(i => i.productId && warrantiedIds.has(String(i.productId)))
  }
  return reply.view('warranty_add.pug', { customers, products, order, orderCustomer, defaultPurchaseDate, availableItems, warrantiedItems, user: req.user })
})

fastify.post('/warranties/add', { preHandler: staff }, async (req, reply) => {
  const { customerId, productId, purchaseDate, warrantyMonths, status, note, orderId } = req.body
  if (!orderId) return reply.status(400).send('❌ Phiếu bảo hành phải được tạo từ một đơn hàng')
  const months = Number(warrantyMonths) || 12
  const purchase = purchaseDate || new Date().toISOString().slice(0, 10)

  // Nếu tạo từ một đơn hàng, lấy đúng tên sản phẩm đã bán trong đơn (dữ liệu gốc, đáng tin
  // hơn việc tra lại kho vì sản phẩm trong kho có thể đã đổi tên/bị xóa sau khi bán).
  let productName = 'Chưa rõ sản phẩm'
  const resolvedProductId = productId ? normalizeObjectId(productId) : null
  if (orderId) {
    const orderObjectId = normalizeObjectId(orderId)
    const order = await fastify.mongo.db.collection('orders').findOne({ _id: orderObjectId })
    const item = order && (order.items || []).find(i => i.productId && String(i.productId) === String(productId))
    if (!item) return reply.status(400).send('❌ Sản phẩm này không thuộc đơn hàng đã chọn')

    // Mỗi sản phẩm trong mỗi đơn hàng chỉ được tạo bảo hành 1 lần
    const duplicate = await fastify.mongo.db.collection('warranties').findOne({
      orderId: orderObjectId,
      productId: resolvedProductId
    })
    if (duplicate) {
      return reply.status(400).send(`❌ Sản phẩm "${item.productName}" trong đơn hàng này đã có phiếu bảo hành ${duplicate.warrantyCode}, không thể tạo thêm`)
    }
    productName = item.productName
  } else if (resolvedProductId) {
    const product = await fastify.mongo.db.collection('products').findOne({ _id: resolvedProductId })
    if (product) productName = product.name
  }

  const owner = await resolveOwner(fastify.mongo.db, customerId, req.user.id)
  const warrantyCode = `BH-${Date.now().toString().slice(-6)}`

  await fastify.mongo.db.collection('warranties').insertOne({
    warrantyCode,
    customerId: normalizeObjectId(customerId),
    orderId: orderId ? normalizeObjectId(orderId) : null,
    productId: resolvedProductId,
    productName,
    purchaseDate: purchase,
    warrantyMonths: months,
    expiryDate: addMonths(purchase, months),
    status: status || 'Còn bảo hành',
    assignedTo: owner,
    note: note || '',
    createdAt: new Date()
  })

  await logActivity(fastify.mongo.db, {
    customerId,
    orderId: orderId || null,
    type: 'Bảo hành',
    note: `Tạo phiếu bảo hành ${warrantyCode} cho ${productName}`,
    userId: req.user.id
  })

  reply.redirect('/warranties')
})

fastify.get('/warranties/edit/:id', { preHandler: staff }, async (req, reply) => {
  const warranty = await fastify.mongo.db.collection('warranties').findOne({ _id: new ObjectId(req.params.id) })
  if (!warranty) return reply.status(404).send('❌ Không tìm thấy phiếu bảo hành')
  if (!canActOnRecord(req, warranty)) return reply.status(403).send('❌ Bạn không có quyền sửa phiếu bảo hành này')
  const [customers, products] = await Promise.all([
    fastify.mongo.db.collection('customers').find().sort({ name: 1 }).toArray(),
    fastify.mongo.db.collection('products').find().sort({ name: 1 }).toArray()
  ])
  return reply.view('warranty_edit.pug', { warranty, customers, products, user: req.user })
})

fastify.post('/warranties/edit/:id', { preHandler: staff }, async (req, reply) => {
  const { customerId, productId, purchaseDate, warrantyMonths, status, note } = req.body
  const existing = await fastify.mongo.db.collection('warranties').findOne({ _id: new ObjectId(req.params.id) })
  if (!existing) return reply.status(404).send('❌ Không tìm thấy phiếu bảo hành')
  if (!canActOnRecord(req, existing)) return reply.status(403).send('❌ Bạn không có quyền sửa phiếu bảo hành này')
  const product = productId ? await fastify.mongo.db.collection('products').findOne({ _id: normalizeObjectId(productId) }) : null
  if (existing.orderId && product) {
    const duplicate = await fastify.mongo.db.collection('warranties').findOne({
      orderId: existing.orderId,
      productId: product._id,
      _id: { $ne: existing._id }
    })
    if (duplicate) {
      return reply.status(400).send(`❌ Sản phẩm "${product.name}" trong đơn hàng này đã có phiếu bảo hành ${duplicate.warrantyCode}, không thể trùng`)
    }
  }
  const months = Number(warrantyMonths) || 12
  const purchase = purchaseDate || ''
  const newStatus = status || 'Còn bảo hành'
  const owner = await resolveOwner(fastify.mongo.db, customerId, req.user.id)

  await fastify.mongo.db.collection('warranties').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        customerId: normalizeObjectId(customerId),
        productId: product ? product._id : null,
        productName: product ? product.name : 'Chưa rõ sản phẩm',
        purchaseDate: purchase,
        warrantyMonths: months,
        expiryDate: addMonths(purchase, months),
        status: newStatus,
        assignedTo: owner,
        note: note || ''
      }
    }
  )

  if (existing && existing.status !== newStatus) {
    await logActivity(fastify.mongo.db, {
      customerId,
      orderId: existing.orderId,
      type: 'Bảo hành',
      note: `Cập nhật bảo hành ${existing.warrantyCode}: ${existing.status} → ${newStatus}`,
      userId: req.user.id
    })
  }

  reply.redirect('/warranties')
})

fastify.get('/warranties/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('warranties').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/warranties')
})

// ================= CỔNG KHÁCH HÀNG (role = 'customer') =================
// Khách hàng chỉ XEM đơn hàng / bảo hành của CHÍNH MÌNH (lọc theo hồ sơ khách hàng gắn với tài khoản).
// Mọi truy vấn đều lấy customerId từ DB theo tài khoản đang đăng nhập, KHÔNG nhận từ URL/form
// => khách này không thể xem dữ liệu của khách khác.

fastify.get('/my/orders', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const customer = await getMyCustomer(req)
  const orders = customer
    ? await fastify.mongo.db.collection('orders').find({ customerId: customer._id }).sort({ createdAt: -1 }).toArray()
    : []

  return reply.view('my_orders.pug', {
    user: req.user,
    customer,
    orders: orders.map(orderForCustomerView)
  })
})

fastify.get('/my/warranties', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const customer = await getMyCustomer(req)
  const warranties = customer
    ? await fastify.mongo.db.collection('warranties').find({ customerId: customer._id }).sort({ purchaseDate: -1 }).toArray()
    : []

  return reply.view('my_warranties.pug', {
    user: req.user,
    customer,
    warranties: warranties.map(warrantyForCustomerView)
  })
})

// ================= KHIẾU NẠI KHÁCH HÀNG (COMPLAINTS) =================
// Luồng trạng thái:
//   Mới gửi -> Đã xác nhận -> Đang xử lý -> Hoàn thành -> Đã đóng
// - KHÁCH HÀNG: tạo khiếu nại; chỉ SỬA / XÓA được khi trạng thái còn "Mới gửi"
//   (nhân viên chưa xác nhận). Điều kiện nằm ngay trong câu lệnh update/delete nên
//   nếu nhân viên vừa bấm xác nhận thì thao tác của khách sẽ bị từ chối (không bị lệch).
// - NHÂN VIÊN PHỤ TRÁCH / ADMIN: nhận (khiếu nại mới hiện sẵn trong danh sách) -> xem ->
//   xác nhận -> xử lý -> hoàn thành -> đóng. Mỗi bước chỉ đi đúng thứ tự, ghi vào
//   "history" của khiếu nại và vào lịch sử chăm sóc (activities) của khách hàng.

const COMPLAINT_STATUS = {
  NEW: 'Mới gửi',
  ACK: 'Đã xác nhận',
  PROCESSING: 'Đang xử lý',
  DONE: 'Hoàn thành',
  CLOSED: 'Đã đóng'
}
const COMPLAINT_STATUS_LIST = Object.values(COMPLAINT_STATUS)
const COMPLAINT_CATEGORIES = [
  'Chất lượng sản phẩm',
  'Bảo hành / sửa chữa',
  'Thái độ phục vụ',
  'Giao hàng',
  'Thanh toán / giá',
  'Khác'
]
const COMPLAINT_TITLE_MAX = 150
const COMPLAINT_CONTENT_MAX = 2000
const COMPLAINT_NOTE_MAX = 1000

// Các bước xử lý của nhân viên: mỗi bước chỉ chạy được khi khiếu nại đang ở đúng trạng thái "from"
const COMPLAINT_ACTIONS = {
  confirm: { from: COMPLAINT_STATUS.NEW, to: COMPLAINT_STATUS.ACK, label: 'Xác nhận khiếu nại', requireNote: false },
  process: { from: COMPLAINT_STATUS.ACK, to: COMPLAINT_STATUS.PROCESSING, label: 'Bắt đầu xử lý', requireNote: false },
  complete: { from: COMPLAINT_STATUS.PROCESSING, to: COMPLAINT_STATUS.DONE, label: 'Hoàn thành xử lý', requireNote: true },
  close: { from: COMPLAINT_STATUS.DONE, to: COMPLAINT_STATUS.CLOSED, label: 'Đóng khiếu nại', requireNote: false }
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN')
}

// Nhân viên thấy khiếu nại của khách mình phụ trách + khiếu nại chưa có người phụ trách
// (để có người nhận). Admin thấy tất cả.
function complaintStaffFilter(req) {
  if (req.user.role === 'admin') return {}
  return { $or: [{ assignedTo: normalizeObjectId(req.user.id) }, { assignedTo: null }] }
}

function canStaffAccessComplaint(req, complaint) {
  if (req.user.role === 'admin') return true
  return !complaint.assignedTo || complaint.assignedTo.toString() === String(req.user.id)
}

function complaintView(c, orderCode) {
  return {
    ...c,
    orderCode: orderCode || '',
    createdAtText: formatDateTime(c.createdAt),
    updatedAtText: formatDateTime(c.updatedAt),
    history: (c.history || []).map(h => ({ ...h, atText: formatDateTime(h.at) }))
  }
}

async function complaintsWithOrderCode(db, complaints) {
  const orderIds = [...new Set(complaints.filter(c => c.orderId).map(c => String(c.orderId)))]
    .map(id => new ObjectId(id))
  const orders = orderIds.length
    ? await db.collection('orders').find({ _id: { $in: orderIds } }, { projection: { orderCode: 1 } }).toArray()
    : []
  const codeById = new Map(orders.map(o => [o._id.toString(), o.orderCode]))
  return complaints.map(c => complaintView(c, c.orderId ? codeById.get(String(c.orderId)) : ''))
}

// Đơn hàng đã xác nhận của khách (để khách chọn đơn liên quan khi khiếu nại)
async function getComplaintOrderOptions(db, customer) {
  const orders = await db.collection('orders')
    .find({ customerId: customer._id, status: 'confirmed' })
    .sort({ createdAt: -1 }).toArray()
  return orders.map(o => ({
    _id: o._id,
    label: `${o.orderCode} - ${(o.items || []).map(i => `${i.productName} x${i.quantity}`).join(', ')}`
  }))
}

// Đọc + kiểm tra dữ liệu form của khách. Trả về { data } hoặc { error, form }.
async function parseComplaintForm(db, customer, body) {
  const form = {
    category: COMPLAINT_CATEGORIES.includes(body.category) ? body.category : 'Khác',
    orderId: String(body.orderId || ''),
    title: String(body.title || '').trim(),
    content: String(body.content || '').trim()
  }
  if (!form.title) return { error: 'Vui lòng nhập tiêu đề khiếu nại!', form }
  if (form.title.length > COMPLAINT_TITLE_MAX) return { error: `Tiêu đề tối đa ${COMPLAINT_TITLE_MAX} ký tự!`, form }
  if (!form.content) return { error: 'Vui lòng mô tả nội dung khiếu nại!', form }
  if (form.content.length > COMPLAINT_CONTENT_MAX) return { error: `Nội dung tối đa ${COMPLAINT_CONTENT_MAX} ký tự!`, form }

  // Đơn hàng liên quan (không bắt buộc) phải là đơn của CHÍNH khách này
  let orderId = null
  if (form.orderId) {
    const oid = normalizeObjectId(form.orderId)
    const order = oid ? await db.collection('orders').findOne({ _id: oid, customerId: customer._id }) : null
    if (!order) return { error: 'Đơn hàng được chọn không hợp lệ!', form }
    orderId = order._id
  }
  return { data: { category: form.category, orderId, title: form.title, content: form.content } }
}

// ---------- PHÍA KHÁCH HÀNG ----------
const NO_CUSTOMER_MSG = '❌ Tài khoản chưa được liên kết với hồ sơ khách hàng. Vui lòng liên hệ cửa hàng.'

fastify.get('/my/complaints', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const customer = await getMyCustomer(req)
  const complaints = customer
    ? await db.collection('complaints').find({ customerId: customer._id }).sort({ createdAt: -1 }).toArray()
    : []
  return reply.view('complaints.pug', {
    user: req.user,
    customer,
    complaints: await complaintsWithOrderCode(db, complaints),
    NEW_STATUS: COMPLAINT_STATUS.NEW
  })
})

fastify.get('/my/complaints/add', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const customer = await getMyCustomer(req)
  if (!customer) return reply.status(404).send(NO_CUSTOMER_MSG)
  return reply.view('complaint_form.pug', {
    user: req.user, isEdit: false, complaint: null, error: null, form: {},
    categories: COMPLAINT_CATEGORIES,
    orders: await getComplaintOrderOptions(fastify.mongo.db, customer),
    titleMax: COMPLAINT_TITLE_MAX, contentMax: COMPLAINT_CONTENT_MAX
  })
})

fastify.post('/my/complaints/add', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const customer = await getMyCustomer(req)
  if (!customer) return reply.status(404).send(NO_CUSTOMER_MSG)

  const parsed = await parseComplaintForm(db, customer, req.body || {})
  if (parsed.error) {
    return reply.view('complaint_form.pug', {
      user: req.user, isEdit: false, complaint: null, error: parsed.error, form: parsed.form,
      categories: COMPLAINT_CATEGORIES,
      orders: await getComplaintOrderOptions(db, customer),
      titleMax: COMPLAINT_TITLE_MAX, contentMax: COMPLAINT_CONTENT_MAX
    })
  }

  const now = new Date()
  const complaintCode = `KN-${Date.now().toString().slice(-6)}`
  const result = await db.collection('complaints').insertOne({
    complaintCode,
    customerId: customer._id,
    ...parsed.data,
    status: COMPLAINT_STATUS.NEW,
    // Giao cho nhân viên đang phụ trách khách; chưa có thì để trống cho nhân viên nào nhận cũng được
    assignedTo: customer.assignedTo || null,
    history: [{ status: COMPLAINT_STATUS.NEW, note: 'Khách hàng gửi khiếu nại', byName: customer.name, byRole: 'customer', at: now }],
    createdAt: now,
    updatedAt: now
  })

  await logActivity(db, {
    customerId: customer._id,
    orderId: parsed.data.orderId,
    type: 'Khiếu nại',
    note: `Khách hàng gửi khiếu nại ${complaintCode}: ${parsed.data.title}`,
    userId: req.user.id
  })
  reply.redirect(`/my/complaints/${result.insertedId}`)
})

// Lấy khiếu nại của CHÍNH khách đang đăng nhập (customerId lấy từ DB, không nhận từ URL/form)
async function findMyComplaint(req) {
  const customer = await getMyCustomer(req)
  const id = normalizeObjectId(req.params.id)
  if (!customer || !id) return { customer, complaint: null }
  const complaint = await fastify.mongo.db.collection('complaints').findOne({ _id: id, customerId: customer._id })
  return { customer, complaint }
}

fastify.get('/my/complaints/edit/:id', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const { customer, complaint } = await findMyComplaint(req)
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')
  if (complaint.status !== COMPLAINT_STATUS.NEW) {
    return reply.status(403).send('❌ Nhân viên đã xác nhận khiếu nại này nên không thể sửa nữa')
  }
  return reply.view('complaint_form.pug', {
    user: req.user, isEdit: true, complaint, error: null,
    form: {
      category: complaint.category, orderId: complaint.orderId ? String(complaint.orderId) : '',
      title: complaint.title, content: complaint.content
    },
    categories: COMPLAINT_CATEGORIES,
    orders: await getComplaintOrderOptions(fastify.mongo.db, customer),
    titleMax: COMPLAINT_TITLE_MAX, contentMax: COMPLAINT_CONTENT_MAX
  })
})

fastify.post('/my/complaints/edit/:id', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const { customer, complaint } = await findMyComplaint(req)
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')

  const parsed = await parseComplaintForm(db, customer, req.body || {})
  if (parsed.error) {
    return reply.view('complaint_form.pug', {
      user: req.user, isEdit: true, complaint, error: parsed.error, form: parsed.form,
      categories: COMPLAINT_CATEGORIES,
      orders: await getComplaintOrderOptions(db, customer),
      titleMax: COMPLAINT_TITLE_MAX, contentMax: COMPLAINT_CONTENT_MAX
    })
  }

  // Điều kiện status = "Mới gửi" nằm trong chính câu lệnh update (chống lệch khi NV vừa xác nhận)
  const now = new Date()
  const result = await db.collection('complaints').updateOne(
    { _id: complaint._id, customerId: customer._id, status: COMPLAINT_STATUS.NEW },
    {
      $set: { ...parsed.data, updatedAt: now },
      $push: { history: { status: COMPLAINT_STATUS.NEW, note: 'Khách hàng chỉnh sửa nội dung khiếu nại', byName: customer.name, byRole: 'customer', at: now } }
    }
  )
  if (result.matchedCount === 0) {
    return reply.status(409).send('❌ Nhân viên vừa xác nhận khiếu nại này nên không thể sửa nữa')
  }

  await logActivity(db, {
    customerId: customer._id, orderId: parsed.data.orderId, type: 'Khiếu nại',
    note: `Khách hàng sửa khiếu nại ${complaint.complaintCode}`, userId: req.user.id
  })
  reply.redirect(`/my/complaints/${complaint._id}`)
})

fastify.post('/my/complaints/delete/:id', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const { customer, complaint } = await findMyComplaint(req)
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')

  const result = await db.collection('complaints').deleteOne({
    _id: complaint._id, customerId: customer._id, status: COMPLAINT_STATUS.NEW
  })
  if (result.deletedCount === 0) {
    return reply.status(409).send('❌ Nhân viên đã xác nhận khiếu nại này nên không thể xóa')
  }

  await logActivity(db, {
    customerId: customer._id, orderId: complaint.orderId, type: 'Khiếu nại',
    note: `Khách hàng đã xóa khiếu nại ${complaint.complaintCode} (${complaint.title})`, userId: req.user.id
  })
  reply.redirect('/my/complaints')
})

fastify.get('/my/complaints/:id', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const { customer, complaint } = await findMyComplaint(req)
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')
  const [view] = await complaintsWithOrderCode(fastify.mongo.db, [complaint])
  return reply.view('complaint_detail.pug', {
    user: req.user, customer, complaint: view, canModify: complaint.status === COMPLAINT_STATUS.NEW
  })
})

// ---------- PHÍA NHÂN VIÊN PHỤ TRÁCH / ADMIN ----------
fastify.get('/complaints', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const scope = complaintStaffFilter(req)
  const statusFilter = COMPLAINT_STATUS_LIST.includes(req.query.status) ? req.query.status : ''
  const filter = { ...scope }
  if (statusFilter) filter.status = statusFilter

  const [complaints, countRows] = await Promise.all([
    db.collection('complaints').find(filter).sort({ createdAt: -1 }).toArray(),
    db.collection('complaints').aggregate([
      { $match: scope },
      { $group: { _id: '$status', n: { $sum: 1 } } }
    ]).toArray()
  ])
  const counts = Object.fromEntries(countRows.map(r => [r._id, r.n]))

  const customerIds = complaints.map(c => c.customerId).filter(Boolean)
  const customers = customerIds.length
    ? await db.collection('customers').find({ _id: { $in: customerIds } }).toArray()
    : []
  const customerNameById = new Map(customers.map(c => [c._id.toString(), c.name]))

  const view = (await complaintsWithOrderCode(db, complaints)).map(c => ({
    ...c,
    customerName: c.customerId ? (customerNameById.get(c.customerId.toString()) || 'Chưa rõ') : 'Chưa rõ'
  }))

  return reply.view('complaints.pug', {
    user: req.user, complaints: view, statusFilter, counts, statuses: COMPLAINT_STATUS_LIST
  })
})

fastify.get('/complaints/detail/:id', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const id = normalizeObjectId(req.params.id)
  const complaint = id ? await db.collection('complaints').findOne({ _id: id }) : null
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')
  if (!canStaffAccessComplaint(req, complaint)) {
    return reply.status(403).send('❌ Bạn không có quyền xem khiếu nại này')
  }

  const [customer, assignedStaff] = await Promise.all([
    complaint.customerId ? db.collection('customers').findOne({ _id: complaint.customerId }) : null,
    complaint.assignedTo ? db.collection('users').findOne({ _id: complaint.assignedTo }) : null
  ])
  const [view] = await complaintsWithOrderCode(db, [complaint])

  // Bước tiếp theo hợp lệ ứng với trạng thái hiện tại (null khi đã đóng)
  const entry = Object.entries(COMPLAINT_ACTIONS).find(([, rule]) => rule.from === complaint.status)
  const nextAction = entry ? { key: entry[0], ...entry[1] } : null

  return reply.view('complaint_detail.pug', {
    user: req.user,
    complaint: view,
    customer,
    assignedStaffName: assignedStaff ? (assignedStaff.name || assignedStaff.username) : 'Chưa phân công',
    nextAction,
    noteMax: COMPLAINT_NOTE_MAX
  })
})

// Một route xử lý cả 4 bước: confirm | process | complete | close
fastify.post('/complaints/:id/:action', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const rule = COMPLAINT_ACTIONS[req.params.action]
  if (!rule) return reply.status(404).send('❌ Thao tác không hợp lệ')

  const id = normalizeObjectId(req.params.id)
  const complaint = id ? await db.collection('complaints').findOne({ _id: id }) : null
  if (!complaint) return reply.status(404).send('❌ Không tìm thấy khiếu nại')
  if (!canStaffAccessComplaint(req, complaint)) {
    return reply.status(403).send('❌ Bạn không có quyền xử lý khiếu nại này')
  }

  const note = String((req.body && req.body.note) || '').trim().slice(0, COMPLAINT_NOTE_MAX)
  if (rule.requireNote && !note) {
    return reply.status(400).send('❌ Vui lòng nhập kết quả xử lý trước khi hoàn thành khiếu nại')
  }

  const now = new Date()
  const set = { status: rule.to, updatedAt: now }
  if (req.params.action === 'confirm') {
    set.acknowledgedAt = now
    set.acknowledgedBy = normalizeObjectId(req.user.id)
    // Khiếu nại chưa có người phụ trách -> người xác nhận nhận luôn
    if (!complaint.assignedTo) set.assignedTo = normalizeObjectId(req.user.id)
  }
  if (req.params.action === 'complete') { set.resolution = note; set.resolvedAt = now }
  if (req.params.action === 'close') set.closedAt = now

  // Chỉ chuyển trạng thái nếu khiếu nại vẫn đang ở đúng bước trước đó
  // (2 người cùng bấm / khách vừa xóa khiếu nại thì không bị ghi đè).
  const result = await db.collection('complaints').updateOne(
    { _id: complaint._id, status: rule.from },
    {
      $set: set,
      $push: { history: { status: rule.to, note, byName: req.user.name || req.user.username, byRole: req.user.role, at: now } }
    }
  )
  if (result.matchedCount === 0) {
    return reply.status(409).send('❌ Khiếu nại vừa được cập nhật bởi người khác hoặc khách hàng đã xóa. Vui lòng tải lại trang.')
  }

  await logActivity(db, {
    customerId: complaint.customerId, orderId: complaint.orderId, type: 'Khiếu nại',
    note: `Khiếu nại ${complaint.complaintCode}: ${complaint.status} → ${rule.to}${note ? ` (${note})` : ''}`,
    userId: req.user.id
  })
  reply.redirect(`/complaints/detail/${complaint._id}`)
})

// ================= THÔNG BÁO TỚI KHÁCH HÀNG (ANNOUNCEMENTS) =================
// Admin / Nhân viên soạn thông báo (chương trình tri ân, khuyến mãi, sản phẩm mới...) và gửi
// tới khách hàng. Dữ liệu gồm 2 collection:
//   - announcements:           nội dung thông báo (1 bản ghi / lần gửi)
//   - announcement_recipients: mỗi khách nhận 1 bản ghi (readAt = null khi chưa đọc), nhờ vậy
//                              khách thấy "chưa đọc" và người gửi thống kê được số khách đã đọc.
// Phạm vi gửi (do SERVER ép theo vai trò, không tin dữ liệu từ form):
//   - Admin:     toàn bộ khách hàng.
//   - Nhân viên: chỉ khách hàng do mình phụ trách.
// Chỉ khách hàng ĐÃ CÓ TÀI KHOẢN đăng nhập (customers.userId) mới nhận được thông báo.

const ANNOUNCEMENT_TYPES = ['Chương trình tri ân', 'Khuyến mãi', 'Sản phẩm mới', 'Thông báo chung']
const ANNOUNCEMENT_AUDIENCES = ['all', 'birthday'] // all = toàn bộ trong phạm vi quyền | birthday = sinh nhật tháng này
const ANNOUNCEMENT_TITLE_MAX = 150
const ANNOUNCEMENT_CONTENT_MAX = 3000

async function ensureAnnouncementIndexes() {
  try {
    const col = fastify.mongo.db.collection('announcement_recipients')
    // Mỗi khách chỉ nhận 1 bản ghi cho mỗi thông báo
    await col.createIndex({ announcementId: 1, customerId: 1 }, { unique: true })
    await col.createIndex({ customerId: 1, createdAt: -1 })
  } catch (err) {
    fastify.log.error(err)
  }
}

// Số thông báo chưa đọc của khách (hiển thị trên menu bên trái, nạp trong hook reply.view)
async function getUnreadAnnouncementCount(userId) {
  try {
    const db = fastify.mongo.db
    const id = normalizeObjectId(userId)
    if (!id) return 0
    const customer = await db.collection('customers').findOne({ userId: id }, { projection: { _id: 1 } })
    if (!customer) return 0
    return await db.collection('announcement_recipients').countDocuments({ customerId: customer._id, readAt: null })
  } catch (err) {
    fastify.log.error(err)
    return 0 // lỗi truy vấn không được làm hỏng cả trang
  }
}

function announcementAudienceText(req, audience) {
  const scope = req.user.role === 'admin' ? 'Tất cả khách hàng' : 'Khách hàng tôi phụ trách'
  return audience === 'birthday' ? `${scope} có sinh nhật tháng ${new Date().getMonth() + 1}` : scope
}

function announcementFormData(req, form, error) {
  return {
    user: req.user,
    error: error || null,
    form: form || {},
    types: ANNOUNCEMENT_TYPES,
    audienceOptions: [
      { value: 'all', label: announcementAudienceText(req, 'all') },
      { value: 'birthday', label: announcementAudienceText(req, 'birthday') }
    ],
    titleMax: ANNOUNCEMENT_TITLE_MAX,
    contentMax: ANNOUNCEMENT_CONTENT_MAX,
    minDate: toLocalDateString(new Date())
  }
}

function announcementView(a) {
  return {
    ...a,
    createdAtText: formatDateTime(a.createdAt),
    validUntilText: a.validUntil ? formatDate(a.validUntil) : '',
    expired: !!a.validUntil && a.validUntil < toLocalDateString(new Date())
  }
}

// Admin xem/xóa mọi thông báo; nhân viên chỉ thao tác trên thông báo do chính mình gửi
function canManageAnnouncement(req, announcement) {
  if (req.user.role === 'admin') return true
  return !!announcement.createdBy && announcement.createdBy.toString() === String(req.user.id)
}

// ---------- PHÍA NHÂN VIÊN / ADMIN ----------
fastify.get('/announcements', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const filter = req.user.role === 'admin' ? {} : { createdBy: normalizeObjectId(req.user.id) }
  const announcements = await db.collection('announcements').find(filter).sort({ createdAt: -1 }).toArray()

  // Thống kê số khách đã nhận / đã đọc cho từng thông báo
  const statRows = announcements.length
    ? await db.collection('announcement_recipients').aggregate([
        { $match: { announcementId: { $in: announcements.map(a => a._id) } } },
        { $group: { _id: '$announcementId', total: { $sum: 1 }, read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } } } }
      ]).toArray()
    : []
  const statById = new Map(statRows.map(r => [r._id.toString(), r]))

  return reply.view('announcements.pug', {
    user: req.user,
    announcements: announcements.map(a => {
      const stat = statById.get(a._id.toString())
      return { ...announcementView(a), total: stat ? stat.total : 0, readCount: stat ? stat.read : 0 }
    })
  })
})

fastify.get('/announcements/add', { preHandler: staff }, async (req, reply) => {
  return reply.view('announcement_form.pug', announcementFormData(req, { type: ANNOUNCEMENT_TYPES[0], audience: 'all' }))
})

fastify.post('/announcements/add', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const body = req.body || {}
  const form = {
    type: ANNOUNCEMENT_TYPES.includes(body.type) ? body.type : ANNOUNCEMENT_TYPES[0],
    audience: ANNOUNCEMENT_AUDIENCES.includes(body.audience) ? body.audience : 'all',
    title: String(body.title || '').trim(),
    content: String(body.content || '').trim(),
    validUntil: String(body.validUntil || '').trim()
  }
  const fail = message => reply.view('announcement_form.pug', announcementFormData(req, form, message))

  if (!form.title) return fail('Vui lòng nhập tiêu đề thông báo!')
  if (form.title.length > ANNOUNCEMENT_TITLE_MAX) return fail(`Tiêu đề tối đa ${ANNOUNCEMENT_TITLE_MAX} ký tự!`)
  if (!form.content) return fail('Vui lòng nhập nội dung thông báo!')
  if (form.content.length > ANNOUNCEMENT_CONTENT_MAX) return fail(`Nội dung tối đa ${ANNOUNCEMENT_CONTENT_MAX} ký tự!`)
  if (form.validUntil) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validUntil)) return fail('Hạn áp dụng không hợp lệ!')
    if (form.validUntil < toLocalDateString(new Date())) return fail('Hạn áp dụng không được nằm trong quá khứ!')
  }

  // Xác định khách nhận: phạm vi theo vai trò (admin: tất cả, nhân viên: khách mình phụ trách)
  const scopedCustomers = await db.collection('customers').find({ ...scopeFilter(req, 'assignedTo') }).toArray()
  const targets = form.audience === 'birthday'
    ? scopedCustomers.filter(c => isBirthdayThisMonth(c.birthDate))
    : scopedCustomers
  const receivers = targets.filter(c => c.userId)
  const skippedNoAccount = targets.length - receivers.length

  if (receivers.length === 0) {
    return fail(targets.length === 0
      ? 'Không có khách hàng nào thuộc đối tượng nhận này!'
      : `Có ${targets.length} khách hàng thuộc đối tượng này nhưng chưa ai có tài khoản đăng nhập nên chưa thể nhận thông báo.`)
  }

  const now = new Date()
  const { insertedId } = await db.collection('announcements').insertOne({
    title: form.title,
    content: form.content,
    type: form.type,
    audience: form.audience,
    audienceText: announcementAudienceText(req, form.audience),
    validUntil: form.validUntil || '',
    recipientCount: receivers.length,
    skippedNoAccount,
    createdBy: normalizeObjectId(req.user.id),
    createdByName: req.user.name || req.user.username,
    createdAt: now
  })

  try {
    await db.collection('announcement_recipients').insertMany(
      receivers.map(c => ({ announcementId: insertedId, customerId: c._id, readAt: null, createdAt: now }))
    )
  } catch (err) {
    // Gửi lỗi giữa chừng -> gỡ thông báo để không còn bản ghi "ma"
    await db.collection('announcement_recipients').deleteMany({ announcementId: insertedId }).catch(() => {})
    await db.collection('announcements').deleteOne({ _id: insertedId }).catch(() => {})
    throw err
  }

  // Để lại dấu vết trên hồ sơ từng khách hàng (giống các mốc chăm sóc khác của CRM)
  await db.collection('activities').insertMany(receivers.map(c => ({
    customerId: c._id,
    orderId: null,
    type: 'Thông báo',
    note: `Đã gửi thông báo "${form.title}" (${form.type})`,
    createdBy: normalizeObjectId(req.user.id),
    createdAt: now
  })))

  reply.redirect(`/announcements/detail/${insertedId}`)
})

fastify.get('/announcements/detail/:id', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const id = normalizeObjectId(req.params.id)
  const announcement = id ? await db.collection('announcements').findOne({ _id: id }) : null
  if (!announcement) return reply.status(404).send('❌ Không tìm thấy thông báo')
  if (!canManageAnnouncement(req, announcement)) {
    return reply.status(403).send('❌ Bạn chỉ xem được thông báo do chính mình gửi')
  }

  const recipients = await db.collection('announcement_recipients').find({ announcementId: id }).toArray()
  const customers = recipients.length
    ? await db.collection('customers').find({ _id: { $in: recipients.map(r => r.customerId) } }).toArray()
    : []
  const customerById = new Map(customers.map(c => [c._id.toString(), c]))

  const recipientsView = recipients.map(r => {
    const c = customerById.get(r.customerId.toString())
    return {
      customerId: r.customerId,
      customerName: c ? c.name : 'Khách hàng đã bị xóa',
      customerPhone: c ? c.phone : '',
      isRead: !!r.readAt,
      readAtText: formatDateTime(r.readAt)
    }
  }).sort((a, b) => Number(a.isRead) - Number(b.isRead) || a.customerName.localeCompare(b.customerName, 'vi'))

  return reply.view('announcement_detail.pug', {
    user: req.user,
    announcement: announcementView(announcement),
    recipients: recipientsView,
    readCount: recipientsView.filter(r => r.isRead).length
  })
})

// Thu hồi (xóa) thông báo: khách sẽ không còn thấy thông báo này nữa
fastify.post('/announcements/delete/:id', { preHandler: staff }, async (req, reply) => {
  const db = fastify.mongo.db
  const id = normalizeObjectId(req.params.id)
  const announcement = id ? await db.collection('announcements').findOne({ _id: id }) : null
  if (!announcement) return reply.status(404).send('❌ Không tìm thấy thông báo')
  if (!canManageAnnouncement(req, announcement)) {
    return reply.status(403).send('❌ Bạn chỉ xóa được thông báo do chính mình gửi')
  }

  await db.collection('announcement_recipients').deleteMany({ announcementId: id })
  await db.collection('announcements').deleteOne({ _id: id })
  reply.redirect('/announcements')
})

// ---------- PHÍA KHÁCH HÀNG ----------
fastify.get('/my/announcements', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const customer = await getMyCustomer(req)
  const recipients = customer
    ? await db.collection('announcement_recipients').find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(100).toArray()
    : []
  const announcements = recipients.length
    ? await db.collection('announcements').find({ _id: { $in: recipients.map(r => r.announcementId) } }).toArray()
    : []
  const announcementById = new Map(announcements.map(a => [a._id.toString(), a]))

  const items = recipients
    .map(r => {
      const a = announcementById.get(r.announcementId.toString())
      return a ? { ...announcementView(a), isRead: !!r.readAt } : null
    })
    .filter(Boolean)

  return reply.view('announcements.pug', { user: req.user, customer, announcements: items })
})

// Mở thông báo = đánh dấu đã đọc. Chỉ xem được thông báo ĐÃ GỬI CHO CHÍNH MÌNH (kiểm tra qua bản ghi recipient).
fastify.get('/my/announcements/:id', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const db = fastify.mongo.db
  const customer = await getMyCustomer(req)
  const id = normalizeObjectId(req.params.id)
  if (!customer || !id) return reply.status(404).send('❌ Không tìm thấy thông báo')

  const recipient = await db.collection('announcement_recipients').findOne({ announcementId: id, customerId: customer._id })
  const announcement = recipient ? await db.collection('announcements').findOne({ _id: id }) : null
  if (!announcement) return reply.status(404).send('❌ Không tìm thấy thông báo')

  if (!recipient.readAt) {
    await db.collection('announcement_recipients').updateOne(
      { _id: recipient._id, readAt: null },
      { $set: { readAt: new Date() } }
    )
  }

  // Cập nhật lại số chưa đọc trên menu: trang này tự tính lại sau khi đã đánh dấu đọc
  return reply.view('announcement_detail.pug', {
    user: req.user,
    announcement: announcementView(announcement),
    unreadAnnouncementCount: await getUnreadAnnouncementCount(req.user.id)
  })
})

// ================= THÔNG TIN TÀI KHOẢN (PROFILE) =================
fastify.get('/profile', { preHandler: [auth] }, async (req, reply) => {
  const account = await fastify.mongo.db.collection('users').findOne({ _id: new ObjectId(req.user.id) })

  // Khách hàng: hiển thị hồ sơ khách hàng + số đơn / số phiếu bảo hành của mình
  if (req.user.role === 'customer') {
    const customer = await getMyCustomer(req)
    const [myOrderCount, myWarrantyCount] = customer
      ? await Promise.all([
          fastify.mongo.db.collection('orders').countDocuments({ customerId: customer._id }),
          fastify.mongo.db.collection('warranties').countDocuments({ customerId: customer._id })
        ])
      : [0, 0]
    return reply.view('profile.pug', { user: req.user, account, customer, myOrderCount, myWarrantyCount })
  }

  const myCustomerCount = await fastify.mongo.db.collection('customers').countDocuments({ assignedTo: new ObjectId(req.user.id) })
  const myOrderCount = await fastify.mongo.db.collection('orders').countDocuments({ assignedTo: new ObjectId(req.user.id), status: 'open' })
  return reply.view('profile.pug', { user: req.user, account, myCustomerCount, myOrderCount })
})

// Khách hàng tự cập nhật thông tin liên hệ của mình
fastify.get('/profile/edit', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const customer = await getMyCustomer(req)
  if (!customer) {
    return reply.status(404).send('❌ Tài khoản chưa được liên kết với hồ sơ khách hàng. Vui lòng liên hệ cửa hàng.')
  }
  return reply.view('profile_edit.pug', { user: req.user, customer, error: null })
})

fastify.post('/profile/edit', { preHandler: [auth, customerOnly] }, async (req, reply) => {
  const customer = await getMyCustomer(req)
  if (!customer) {
    return reply.status(404).send('❌ Tài khoản chưa được liên kết với hồ sơ khách hàng. Vui lòng liên hệ cửa hàng.')
  }

  const body = req.body || {}
  const name = String(body.name || '').trim()
  const phone = String(body.phone || '').trim()
  const email = String(body.email || '').trim()
  const address = String(body.address || '').trim()
  const birthDate = String(body.birthDate || '').trim()

  if (!name) {
    return reply.view('profile_edit.pug', {
      user: req.user,
      customer: { ...customer, name, phone, email, address, birthDate },
      error: 'Họ và tên không được để trống!'
    })
  }

  // Khách hàng chỉ sửa được thông tin liên hệ; mã KH, người phụ trách, ghi chú nội bộ do cửa hàng quản lý
  await fastify.mongo.db.collection('customers').updateOne(
    { _id: customer._id },
    { $set: { name, phone, email, address, birthDate } }
  )
  await syncCustomerBirthdayReminder(customer._id)
  await fastify.mongo.db.collection('users').updateOne(
    { _id: normalizeObjectId(req.user.id) },
    { $set: { name, phone } }
  )

  // Cấp lại token để tên hiển thị trên thanh trên cùng cập nhật ngay
  const token = fastify.jwt.sign({
    id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    name
  })

  reply.setCookie('token', token, {
    path: '/',
    httpOnly: true,
    maxAge: 3600 * 24
  }).redirect('/profile')
})

// ================= ĐỔI MẬT KHẨU =================
fastify.get('/change-password', { preHandler: [auth] }, async (req, reply) => {
  return reply.view('change_password.pug', { user: req.user, error: null, success: null })
})

fastify.post('/change-password', { preHandler: [auth] }, async (req, reply) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body

    if (!currentPassword || !newPassword || !confirmPassword) {
      return reply.view('change_password.pug', { user: req.user, error: 'Vui lòng nhập đầy đủ thông tin!', success: null })
    }
    if (newPassword !== confirmPassword) {
      return reply.view('change_password.pug', { user: req.user, error: 'Mật khẩu xác nhận không khớp!', success: null })
    }

    const user = await fastify.mongo.db.collection('users').findOne({ _id: new ObjectId(req.user.id) })
    if (!user) {
      return reply.view('change_password.pug', { user: req.user, error: 'Không tìm thấy tài khoản!', success: null })
    }

    const match = await bcrypt.compare(currentPassword, user.password)
    if (!match) {
      return reply.view('change_password.pug', { user: req.user, error: 'Mật khẩu hiện tại không đúng!', success: null })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await fastify.mongo.db.collection('users').updateOne({ _id: user._id }, { $set: { password: hashedPassword } })

    // Đổi mật khẩu sẽ đăng xuất tài khoản -> nhân viên chuyển về "Ngưng làm việc"
    if (req.user.role === 'user') {
      await setWorkStatusForAccount(req.user.id, 'Ngưng làm việc')
    }

    return reply.clearCookie('token').redirect('/login')
  } catch (err) {
    fastify.log.error(err)
    return reply.view('change_password.pug', { user: req.user, error: '❌ Đã xảy ra lỗi hệ thống!', success: null })
  }
})


// ================= CHẠY SERVER =================
fastify.listen({ port: 3000, host: '0.0.0.0' }, err => {
  if (err) throw err
  console.log('CRM Cửa Hàng Điện Thoại đang chạy tại http://localhost:3000')
  migrateEmployeePositions()
  ensureAnnouncementIndexes()

  // Quét bảo hành sắp hết hạn -> tự tạo lịch nhắc (chạy ngay khi khởi động rồi lặp lại định kỳ)
  generateWarrantyExpiryReminders()
  setInterval(generateWarrantyExpiryReminders, AUTO_REMINDER_SCAN_INTERVAL_MS).unref()

  // Quét khách hàng có sinh nhật tháng này -> tự tạo lịch nhắc chăm sóc sinh nhật (qua tháng mới sẽ tự tạo tiếp)
  generateBirthdayReminders()
  setInterval(generateBirthdayReminders, AUTO_REMINDER_SCAN_INTERVAL_MS).unref()
})
