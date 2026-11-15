// Đọc file Excel (.xlsx) chứa danh sách sản phẩm và chuẩn hóa thành các dòng dữ liệu hợp lệ.
// Module này KHÔNG đụng tới database: chỉ đọc + kiểm tra dữ liệu, việc ghi DB do server.js làm.
const ExcelJS = require('exceljs')

const MAX_ROWS = 2000

// Bỏ dấu, hạ chữ thường, bỏ ký tự đặc biệt: "Bảo hành (tháng)" -> "baohanhthang"
function norm(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// Tên cột chấp nhận cho từng trường (đã chuẩn hóa bằng norm)
const COLUMN_ALIASES = {
  name: ['tensanpham', 'tensp', 'ten', 'name'],
  brand: ['hang', 'thuonghieu', 'brand'],
  category: ['danhmuc', 'category'],
  stockQty: ['tonkho', 'soluongtonkho', 'soluong', 'sl'],
  productType: ['loai', 'loaihang', 'tinhtrang'],
  warrantyMonths: ['baohanhthang', 'baohanh', 'thoigianbaohanh'],
  color: ['mau', 'mausac']
}

// Giá trị 1 ô -> chuỗi (xử lý ô công thức, rich text, hyperlink, ngày...)
function cellText(cell) {
  let v = cell ? cell.value : null
  if (v === null || v === undefined) return ''
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map(part => part.text).join('')
    else if ('result' in v) v = v.result
    else if ('text' in v) v = v.text
    else v = ''
  }
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim()
}

// Tìm giá trị hợp lệ trong danh sách, không phân biệt hoa/thường và dấu. Trả về giá trị chuẩn hoặc null.
function matchOption(text, options) {
  const key = norm(text)
  return options.find(opt => norm(opt) === key) || null
}

// Số nguyên không âm từ chuỗi; trả về null nếu không hợp lệ
function parseWholeNumber(text) {
  const n = Number(String(text).replace(',', '.'))
  return Number.isInteger(n) && n >= 0 ? n : null
}

// Đọc workbook từ buffer.
// options: { brands, categories, types } = danh sách giá trị hợp lệ của hệ thống.
// Trả về { rows: [{ rowNumber, data }], errors: [{ rowNumber, message }], totalRows, fatal }
async function parseProductsWorkbook(buffer, options) {
  const { brands, categories, types } = options
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const sheet = workbook.worksheets[0]
  if (!sheet) return { rows: [], errors: [], totalRows: 0, fatal: 'File Excel không có trang tính nào.' }

  // Tìm dòng tiêu đề trong 5 dòng đầu (dòng có cột "Tên sản phẩm")
  let headerRowNumber = 0
  let columns = {}
  for (let r = 1; r <= Math.min(5, sheet.rowCount); r++) {
    const found = {}
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = norm(cellText(cell))
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (!(field in found) && aliases.includes(key)) found[field] = colNumber
      }
    })
    if ('name' in found) {
      headerRowNumber = r
      columns = found
      break
    }
  }
  if (!headerRowNumber) {
    return { rows: [], errors: [], totalRows: 0, fatal: 'Không tìm thấy cột "Tên sản phẩm" trong file. Hãy dùng file mẫu.' }
  }

  const rows = []
  const errors = []
  let totalRows = 0
  const lastRow = sheet.actualRowCount ? sheet.rowCount : headerRowNumber

  for (let r = headerRowNumber + 1; r <= lastRow; r++) {
    const row = sheet.getRow(r)
    const get = field => (field in columns ? cellText(row.getCell(columns[field])) : '')

    const raw = {}
    for (const field of Object.keys(COLUMN_ALIASES)) raw[field] = get(field)
    // Bỏ qua dòng trống hoàn toàn
    if (Object.values(raw).every(v => v === '')) continue

    totalRows++
    if (totalRows > MAX_ROWS) {
      return { rows, errors, totalRows: MAX_ROWS, fatal: `File có quá ${MAX_ROWS} dòng dữ liệu. Vui lòng tách thành nhiều file.` }
    }

    if (!raw.name) {
      errors.push({ rowNumber: r, message: 'Thiếu tên sản phẩm' })
      continue
    }

    const data = { name: raw.name }
    let rowError = ''

    if (raw.brand) data.brand = matchOption(raw.brand, brands) || 'Khác'

    if (raw.category) {
      const category = matchOption(raw.category, categories)
      if (!category) rowError = `Danh mục "${raw.category}" không hợp lệ (chọn: ${categories.join(', ')})`
      else data.category = category
    }

    if (!rowError && raw.productType) {
      const type = matchOption(raw.productType, types)
      if (!type) rowError = `Loại "${raw.productType}" không hợp lệ (chọn: ${types.join(', ')})`
      else data.productType = type
    }

    if (!rowError && raw.stockQty !== '') {
      const stock = parseWholeNumber(raw.stockQty)
      if (stock === null) rowError = `Tồn kho "${raw.stockQty}" phải là số nguyên từ 0 trở lên`
      else data.stockQty = stock
    }

    if (!rowError && raw.warrantyMonths !== '') {
      const months = parseWholeNumber(raw.warrantyMonths)
      if (months === null) rowError = `Bảo hành "${raw.warrantyMonths}" phải là số tháng nguyên từ 0 trở lên`
      else data.warrantyMonths = months
    }

    if (raw.color) data.color = raw.color

    if (rowError) errors.push({ rowNumber: r, message: rowError })
    else rows.push({ rowNumber: r, data })
  }

  return { rows, errors, totalRows, fatal: '' }
}

// File mẫu để người dùng tải về điền dữ liệu
async function buildProductTemplate({ brands, categories, types }) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sản phẩm')
  sheet.columns = [
    { header: 'Tên sản phẩm', key: 'name', width: 34 },
    { header: 'Hãng', key: 'brand', width: 14 },
    { header: 'Danh mục', key: 'category', width: 22 },
    { header: 'Tồn kho', key: 'stockQty', width: 10 },
    { header: 'Loại', key: 'productType', width: 24 },
    { header: 'Bảo hành (tháng)', key: 'warrantyMonths', width: 18 },
    { header: 'Màu', key: 'color', width: 18 }
  ]
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.addRow({ name: 'iPhone 15 Pro Max 256GB', brand: brands[0], category: categories[0], stockQty: 10, productType: types[0], warrantyMonths: 12, color: 'Titan tự nhiên' })
  sheet.addRow({ name: 'Ốp lưng Galaxy S24', brand: 'Samsung', category: categories[3], stockQty: 50, productType: types[0], warrantyMonths: 0, color: 'Đen' })

  const guide = workbook.addWorksheet('Hướng dẫn')
  guide.columns = [{ width: 24 }, { width: 80 }]
  const lines = [
    ['Cột bắt buộc', 'Chỉ "Tên sản phẩm" là bắt buộc.'],
    ['Mã SP', 'Không cần nhập: hệ thống tự sinh mã cho sản phẩm mới.'],
    ['Sản phẩm trùng', 'Hệ thống so khớp theo Tên sản phẩm + Màu; trùng thì CẬP NHẬT, không trùng thì thêm mới.'],
    ['Hãng', `${brands.join(', ')} (không khớp sẽ lưu là "Khác")`],
    ['Danh mục', categories.join(', ')],
    ['Loại', types.join(', ')],
    ['Tồn kho', 'Số nguyên từ 0. Là số tồn MỚI (thay thế số cũ), không cộng dồn.'],
    ['Bảo hành (tháng)', 'Số nguyên từ 0. Để trống: sản phẩm mới mặc định 12 tháng.'],
    ['Ô để trống', 'Với sản phẩm đã có, ô trống sẽ giữ nguyên giá trị cũ (không xóa dữ liệu).']
  ]
  lines.forEach(line => guide.addRow(line))
  guide.getColumn(1).font = { bold: true }

  return workbook.xlsx.writeBuffer()
}

module.exports = { parseProductsWorkbook, buildProductTemplate, MAX_ROWS }
