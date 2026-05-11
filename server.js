// ================= CÁC THƯ VIỆN CẦN DÙNG =================
const path = require('node:path')
const fastify = require('fastify')({ logger: true })
const bcrypt = require('bcrypt')
const { ObjectId } = require('mongodb')


// ================= CÁC PLUGINS CẦN DÙNG =================
// Cho phép đọc dữ liệu từ form (method POST)
fastify.register(require('@fastify/formbody'))

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


// ================= MIDDLEWARESIDDLEWARES(Hàm chạy trước khi vào chương trình chính)=================

// Middleware kiểm tra đăng nhập
async function auth(req, reply) {
  try {
    // Lấy token từ cookie
    const token = req.cookies.token  //khai báo biến token lấy dữ liệu từ cookie

    // Xác thực token → nếu hợp lệ sẽ decode ra thông tin user
    req.user = fastify.jwt.verify(token)  //là hàm dùng để xác thực (verify) và giải mã JWT token.

  } catch (err) {
    // Nếu lỗi → chưa đăng nhập → chuyển về login
    return reply.redirect('/login')  //redirect dùng để chuyển hướng người dùng sang trang khác
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


// ================= ROUTES HỆ THỐNG =================

// Trang gốc → chuyển về login
//async giúp bạn xử lý các tác vụ gọi database , hash password,verify JWT,đọc file...một cách hiệu quả mà không làm block server, đảm bảo server luôn phản hồi nhanh chóng ngay cả khi có nhiều yêu cầu đến cùng lúc
fastify.get('/', async (req, reply) => {  
  reply.redirect('/login')
})


// ================= ĐĂNG KÝ =================

// Hiển thị form đăng ký
fastify.get('/register', async (req, reply) => {
  return reply.view('register.pug')
})

// Xử lý đăng ký

fastify.post('/register', async (req, reply) => {
  const { username, password } = req.body;

  // Kiểm tra xem username đã tồn tại chưa
  const existingUser = await fastify.mongo.db.collection('users').findOne({ username });
  if (existingUser) {
    return reply.view('register.pug', { error: 'Tên đăng nhập đã tồn tại!' }); //[cite: 2, 3]
  }

  const hash = await bcrypt.hash(password, 10); //
  
  const userResult = await fastify.mongo.db.collection('users').insertOne({
    username, 
    password: hash,
    role: 'user'
  }); //[cite: 3]

  await fastify.mongo.db.collection('employees').insertOne({
    userId: userResult.insertedId,
    name: username,
    role: 'Chưa cập nhật',
    department: 'Chưa cập nhật'
  }); //[cite: 3]

  reply.redirect('/login');
});

// ================= ĐĂNG NHẬP =================

// Hiển thị form login
////async giúp bạn xử lý các tác vụ gọi database , hash password,verify JWT,đọc file...một cách hiệu quả mà không làm block server, đảm bảo server luôn phản hồi nhanh chóng ngay cả khi có nhiều yêu cầu đến cùng lúc
fastify.get('/login', async (req, reply) => { 
  return reply.view('login.pug') // trả về view login.pug để hiển thị form đăng nhập
})

// Xử lý login
fastify.post('/login', async (req, reply) => {
  const { username, password } = req.body;

  const user = await fastify.mongo.db.collection('users').findOne({ username });

  // Thay vì reply.send, hãy trả về view kèm thông báo lỗi để giữ người dùng ở lại trang
  if (!user) {
    return reply.view('login.pug', { error: 'Tài khoản không tồn tại' }); //
  }

  const match = await bcrypt.compare(password, user.password); //[cite: 3]
  if (!match) {
    return reply.view('login.pug', { error: 'Mật khẩu không chính xác' }); //[cite: 1, 3]
  }

  const token = fastify.jwt.sign({
    id: user._id,
    username: user.username,
    role: user.role
  }); //[cite: 3]

  // Thiết lập cookie an toàn hơn (HttpOnly)
  reply.setCookie('token', token, {
    path: '/',
    httpOnly: true, // Chống XSS lấy cắp token
    maxAge: 3600 * 24 // 1 ngày
  }).redirect('/dashboard'); //[cite: 3]
}); 

// ================= ĐĂNG XUẤT =================
//reply.clearCookie('token'):Xóa cookie có tên token trên trình duyệt người dùng
fastify.get('/logout', async (req, reply) => {
  reply.clearCookie('token').redirect('/login') //xóa cookie token để đăng xuất → chuyển về login
})


// ================= DASHBOARD =================
// Trang chính sau khi đăng nhập thành công
fastify.get('/dashboard', { preHandler: [auth] }, async (req, reply) => {
  return reply.view('dashboard.pug', { user: req.user })  //{ user: req.user }Đây là dữ liệu gửi sang Pug để hiển thị thông tin user trên giao diện dashboard, vd: chào mừng username, hiển thị nút quản lý lương nếu là admin...
})


// ================= QUẢN LÝ NHÂN VIÊN =================
// Xem danh sách nhân viên // tất cả user đều xem được 
//.find() Lấy dữ liệu từ collection,Không có điều kiện → nghĩa là:lấy tất cả nhân viên
//.toArray() là một phương thức trong MongoDB (Node.js driver) dùng để chuyển kết quả truy vấn (cursor) thành một mảng (array).
//await:Vì .find().toArray() là async (trả về Promise)await giúp lấy kết quả thật thay vì Promise
fastify.get('/employees', { preHandler: [auth] }, async (req, reply) => { //kiểm tra đăng nhập trước khi hiển thị danh sách nhân viên
  const employees = await fastify.mongo.db.collection('employees').find().toArray() //lấy tất cả nhân viên từ DB
  return reply.view('employees.pug', { employees, user: req.user })  // trả về view employees.pug và truyền dữ liệu nhân viên và thông tin user đang đăng nhập
})

// Thêm nhân viên (admin)//hiển thị form thêm nhân viên
fastify.get('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {   //kiểm tra đăng nhập và quyền admin trước khi hiển thị form
  return reply.view('add.pug') // trả về view add.pug để hiển thị form thêm nhân viên
})
// Xử lý thêm nhân viên
fastify.post('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {  //kiểm tra đăng nhập và quyền admin trước khi xử lý thêm nhân viên
  await fastify.mongo.db.collection('employees').insertOne(req.body) //thêm 1 nhân viên mới vào DB với dữ liệu từ form (req.body)
  reply.redirect('/employees')  //sau khi thêm xong → chuyển về trang danh sách nhân viên để thấy kết quả
})

// Sửa nhân viên
fastify.get('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {  //kiểm tra đăng nhập và quyền admin trước khi hiển thị form sửa nhân viên
  const emp = await fastify.mongo.db.collection('employees')   
    .findOne({ _id: new ObjectId(req.params.id) }) //tìm nhân viên cần sửa theo id từ URL và lấy thông tin nhân viên đó từ DB

  return reply.view('edit.pug', { emp }) 
  // trả về view edit.pug để hiển thị form sửa nhân viên và truyền dữ liệu nhân viên cần sửa
  //{ emp } Là dữ liệu truyền sang view để hiển thị thông tin nhân viên cần sửa trên form, vd: điền sẵn tên, phòng ban, vai trò... để người dùng dễ sửa
})
// Xử lý sửa nhân viên
fastify.post('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {  //kiểm tra đăng nhập và quyền admin trước khi xử lý sửa nhân viên
  await fastify.mongo.db.collection('employees').updateOne(
    { _id: new ObjectId(req.params.id) },  //tìm nhân viên cần sửa theo id từ URL
    { $set: req.body }  //$set Là toán tử update của MongoDB
  )
  reply.redirect('/employees') //sau khi sửa xong → chuyển về trang danh sách nhân viên để thấy kết quả
})

// Xóa nhân viên
fastify.get('/employees/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {  //kiểm tra đăng nhập và quyền admin trước khi xử lý xóa nhân viên
  await fastify.mongo.db.collection('employees')  //tìm nhân viên cần xóa theo id từ URL và xóa nhân viên đó khỏi DB
    .deleteOne({ _id: new ObjectId(req.params.id) }) //xóa nhân viên khỏi DB theo id từ URL

  reply.redirect('/employees') //sau khi xóa xong → chuyển về trang danh sách nhân viên để thấy kết quả
})


// ================= QUẢN LÝ PHÒNG BAN =================
// Xem danh sách phòng ban // tất cả user đều xem được
//.find() Lấy dữ liệu từ collection,Không có điều kiện → nghĩa là:lấy tất cả phòng ban
//.toArray() là một phương thức trong MongoDB (Node.js driver) dùng để chuyển kết quả truy vấn (cursor) thành một mảng (array).
//await:Vì .find().toArray() là async (trả về Promise)await giúp lấy kết quả thật thay vì Promise
//fastify.mongo.db.collection('departments')Truy cập vào collection (bảng) tên là departments
fastify.get('/departments', { preHandler: [auth] }, async (req, reply) => {  //kiểm tra đăng nhập trước khi hiển thị danh sách phòng ban
  const departments = await fastify.mongo.db.collection('departments').find().toArray() //lấy tất cả phòng ban từ DB
  return reply.view('departments.pug', { departments, user: req.user }) // trả về view departments.pug và truyền dữ liệu phòng ban và thông tin user đang đăng nhập
})

// Thêm phòng ban (admin) // hiển thị form thêm phòng ban 
fastify.get('/departments/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('add_dept.pug', { user: req.user }); // Thêm user: req.user
});

// Xử lý thêm phòng ban
//fastify.mongo.db.collection('departments')Truy cập vào collection (bảng) tên là departments để thêm 1 phòng ban
fastify.post('/departments/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {  //kiểm tra đăng nhập và quyền admin trước khi xử lý thêm phòng ban
  await fastify.mongo.db.collection('departments').insertOne(req.body) //fastify.mongo.db.collection('departments')Truy cập vào collection (bảng) tên là departments để thêm 1 phòng ban mới vào DB với dữ liệu từ form (req.body)
  reply.redirect('/departments') //sau khi thêm xong → chuyển về trang danh sách phòng ban để thấy kết quả
})
// Sửa phòng ban
fastify.get('/departments/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const dept = await fastify.mongo.db.collection('departments')
    .findOne({ _id: new ObjectId(req.params.id) });

  return reply.view('edit_dept.pug', { dept, user: req.user }); // Thêm user: req.user
});

// Xử lý sửa phòng ban
fastify.post('/departments/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => { //kiểm tra đăng nhập và quyền admin trước khi xử lý sửa phòng ban
  //cập nhật thông tin phòng ban với dữ liệu mới từ form (req.body) theo id từ URL
  await fastify.mongo.db.collection('departments').updateOne(  //tìm phòng ban cần sửa theo id từ URL
    //new ObjectId(req.params.id) là MongoDB lưu _id dưới dạng ObjectId
    { _id: new ObjectId(req.params.id) },//dùng để truy vấn trong MongoDB ,req.params.id Là id lấy từ URL
   //$set = gán giá trị mới cho field
   //req.body Là dữ liệu người dùng gửi từ form / API
    { $set: req.body } //$set Là toán tử update của MongoDB để cập nhật thông tin phòng ban với dữ liệu mới từ form (req.body
    
  )
  //sau khi sửa xong → chuyển về trang danh sách phòng ban để thấy kết quả
  reply.redirect('/departments')
})
// Xóa phòng ban
fastify.get('/departments/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('departments') // Truy cập vào collection (bảng) tên là departments để xóa phòng ban theo id từ URL
    .deleteOne({ _id: new ObjectId(req.params.id) }) //xóa phòng ban khỏi DB theo id từ URL

  reply.redirect('/departments') //sau khi xóa xong → chuyển về trang danh sách phòng ban để thấy kết quả
})

// ================= QUẢN LÝ CHỨC VỤ =================
// Xem danh sách chức vụ
fastify.get('/positions', { preHandler: [auth] }, async (req, reply) => {
  const positions = await fastify.mongo.db.collection('positions').find().toArray()
  return reply.view('positions.pug', { positions, user: req.user })
})

// Thêm chức vụ (admin)
fastify.get('/positions/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  // QUAN TRỌNG: Phải truyền { user: req.user } để Sidebar không bị lỗi
  return reply.view('add_pos.pug', { user: req.user }) 
})

// Xử lý thêm chức vụ
fastify.post('/positions/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions').insertOne(req.body)
  reply.redirect('/positions')
})

// Sửa chức vụ
fastify.get('/positions/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const pos = await fastify.mongo.db.collection('positions')
    .findOne({ _id: new ObjectId(req.params.id) })
  // Phải có { pos, user: req.user } để Sidebar hoạt động
  return reply.view('edit_pos.pug', { pos, user: req.user }) 
})

// Xử lý sửa chức vụ
fastify.post('/positions/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body }
  )
  reply.redirect('/positions')
})

// Xóa chức vụ
fastify.get('/positions/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('positions')
    .deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/positions')
})

// ================= HỆ THỐNG LƯƠNG =================
// Xem lương (admin xem tất cả, user chỉ xem của mình)
fastify.get('/salary', { preHandler: [auth] }, async (req, reply) => { 

  const month = req.query.month || new Date().toISOString().slice(0, 7) //lấy tháng từ query string (vd: /salary?month=2024-06), nếu không có thì mặc định là tháng hiện tại (vd: 2024-06)

  let salaries //let dùng để khai báo biến salaries có thể thay đổi giá trị sau này, vì admin sẽ lấy tất cả lương còn user chỉ lấy lương của mình nên cần let để gán giá trị khác nhau
  let employees = [] //let dùng để khai báo biến employees có thể thay đổi giá trị sau này, vì admin sẽ lấy tất cả nhân viên để hiển thị tên nhân viên trên bảng lương còn user không cần nên để rỗng

  if (req.user.role === 'admin') {
    // Admin xem tất cả
    salaries = await fastify.mongo.db.collection('salaries') //Truy cập vào collection (bảng) tên là salaries để lấy tất cả lương theo tháng đã chọn
      .find({ month: month }) //lọc lương theo tháng đã chọn để hiển thị trên giao diện, nếu không có thì mặc định là tháng hiện tại
      .toArray() //chuyển kết quả truy vấn (cursor) thành một mảng (array) để dễ dàng xử lý và hiển thị trên giao diện

    employees = await fastify.mongo.db.collection('employees') //Truy cập vào collection (bảng) tên là employees để lấy tất cả nhân viên để hiển thị tên nhân viên trên bảng lương, vì mỗi bản ghi lương đã lưu sẵn tên nhân viên nên không cần join với bảng nhân viên nữa, nhưng vẫn lấy để hiển thị danh sách nhân viên trên giao diện nếu muốn
      .find() //lấy tất cả nhân viên từ DB để hiển thị tên nhân viên trên bảng lương, vì mỗi bản ghi lương đã lưu sẵn tên nhân viên nên không cần join với bảng nhân viên nữa, nhưng vẫn lấy để hiển thị danh sách nhân viên trên giao diện nếu muốn
      .toArray() //chuyển kết quả truy vấn (cursor) thành một mảng (array) để dễ dàng xử lý và hiển thị trên giao diện

  } else {
    // User chỉ xem lương của mình
    //.find({ month: month, userId: new ObjectId(req.user.id) })Lọc lương theo tháng đã chọn và theo userId của người dùng đang đăng nhập để chỉ lấy lương của mình, nếu không có thì mặc định là tháng hiện tại
    salaries = await fastify.mongo.db.collection('salaries') //Truy cập vào collection (bảng) tên là salaries để lấy lương của user đó theo tháng đã chọn
      .find({
        month: month, //lọc lương theo tháng đã chọn để hiển thị trên giao diện, nếu không có thì mặc định là tháng hiện tại
        userId: new ObjectId(req.user.id) //lọc lương theo userId của người dùng đang đăng nhập để chỉ lấy lương của mình, vì trong bảng lương đã lưu userId nên có thể lọc trực tiếp mà không cần join với bảng nhân viên nữa
      })
      .toArray() //chuyển kết quả truy vấn (cursor) thành một mảng (array) để dễ dàng xử lý và hiển thị trên giao diện
  }

  return reply.view('salary_list.pug', {  // trả về view salary_list.pug để hiển thị danh sách lương và truyền dữ liệu lương, nhân viên và tháng hiện tại
    salaries, //dữ liệu lương để hiển thị trên giao diện, nếu là admin thì là tất cả lương theo tháng đã chọn, nếu là user thì chỉ là lương của mình theo tháng đã chọn
    employees,//dữ liệu nhân viên để hiển thị tên nhân viên trên bảng lương, nếu là admin thì là tất cả nhân viên, nếu là user thì không cần nên để rỗng
    currentMonth: month, //tháng hiện tại để hiển thị trên giao diện và làm mặc định cho form chọn tháng, nếu không có thì mặc định là tháng hiện tại
    user: req.user //thông tin user đang đăng nhập để hiển thị trên giao diện, vd: chào mừng username, hiển thị nút quản lý lương nếu là admin...
  })
})
// ================= TÍNH LƯƠNG =================

// Form tính lương (admin)
fastify.get('/salary/manage/:empId', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const emp = await fastify.mongo.db.collection('employees')
    .findOne({ _id: new ObjectId(req.params.empId) });

  return reply.view('salary_manage.pug', { 
    emp, 
    user: req.user // QUAN TRỌNG: Phải có dòng này
  });
});

// Lưu lương
fastify.post('/salary/manage/:empId', { preHandler: [auth, isAdmin] }, async (req, reply) => { //kiểm tra đăng nhập và quyền admin trước khi xử lý lưu lương cho nhân viên cụ thể theo empId từ URL

  const { month, baseSalary, bonus, allowance, advance, raise } = req.body //lấy dữ liệu lương từ form (req.body) để tính toán tổng thu nhập và lương thực nhận
//month :tháng ,basesalary:lương cơ bản , bonus :thưởng , allowance :phụ cấp , advance :tạm ứng , raise :tăng ca
  // Tổng thu nhập 
  // Cộng tất cả các khoản: lương cơ bản + thưởng + phụ cấp + tăng ca
  const totalEarned =
  //parseFloat(...) → chuyển từ chuỗi → số thực (number)
    parseFloat(baseSalary) +  
    parseFloat(bonus) + 
    parseFloat(allowance) +
    parseFloat(raise) 

  // Lương thực nhận
  // Trừ đi tạm ứng (nếu có) để ra lương thực nhận
  const finalSalary = totalEarned - parseFloat(advance)

  // Lấy nhân viên 
  const emp = await fastify.mongo.db.collection('employees') //Truy cập vào collection (bảng) tên là employees để tìm nhân viên cần lưu lương theo empId từ URL và lấy thông tin nhân viên đó từ DB để lưu vào bảng lương
    .findOne({ _id: new ObjectId(req.params.empId) }) //lọc 1 nhân viên cần lưu lương theo empId từ URL và lấy thông tin nhân viên đó từ DB để lưu vào bảng lương

  // Upsert (có thì update, chưa có thì tạo mới)
  await fastify.mongo.db.collection('salaries').updateOne(  //Truy cập vào collection (bảng) tên là salaries để cập nhật hoặc tạo mới lương của nhân viên đó theo tháng đã chọn
    { userId: emp.userId, month: month }, //tìm lương của nhân viên đó theo tháng đã chọn để cập nhật, nếu chưa có thì tạo mới
    {
      $set: { //$set là toán tử update của MongoDB để cập nhật hoặc tạo mới lương của nhân viên đó theo tháng đã chọn
        employeeName: emp.name, //lưu tên nhân viên vào bảng lương để hiển thị trên giao diện mà không cần join với bảng nhân viên, vì mỗi tháng sẽ lưu một bản ghi lương mới nên nếu sau này có sửa tên nhân viên thì cũng không ảnh hưởng đến lương đã lưu trước đó
        baseSalary: parseFloat(baseSalary), //lưu lương cơ bản, parseFloat để chuyển từ chuỗi sang số thực
        bonus: parseFloat(bonus), //lưu thưởng, parseFloat để chuyển từ chuỗi sang số thực
        allowance: parseFloat(allowance), //lưu phụ cấp, parseFloat để chuyển từ chuỗi sang số thực
        advance: parseFloat(advance), //lưu tạm ứng, parseFloat để chuyển từ chuỗi sang số thực
        raise: parseFloat(raise), //lưu tăng ca, parseFloat để chuyển từ chuỗi sang số thực
        finalSalary: finalSalary, //lưu lương thực nhận đã tính toán ở trên
        employeeId: emp._id //lưu id nhân viên để có thể tìm kiếm và liên kết sau này nếu cần, mặc dù hiện tại không dùng đến nhưng lưu để sau này có thể mở rộng tính năng (vd: xem lịch sử lương của một nhân viên)
      }
    },
    { upsert: true }  
    //upsert là update và insert kết hợp, nghĩa là nếu tìm thấy lương của nhân viên đó theo tháng đã chọn thì cập nhật, nếu không tìm thấy thì tạo mới một bản ghi lương mới cho nhân viên đó theo tháng đã chọn
    //upsert: true → nếu tìm thấy lương của nhân viên đó theo tháng đã chọn thì cập nhật, nếu không tìm thấy thì tạo mới một bản ghi lương mới cho nhân viên đó theo tháng đã chọn
  )

  reply.redirect('/salary') //sau khi lưu xong → chuyển về trang danh sách lương để thấy kết quả
})


// ================= QUẢN LÝ HỢP ĐỒNG =================

// 1. Xem danh sách hợp đồng
fastify.get('/contracts', { preHandler: [auth] }, async (req, reply) => {
  const contracts = await fastify.mongo.db.collection('contracts').find().toArray();
  return reply.view('contracts.pug', { contracts, user: req.user });
});

// 2. Form thêm hợp đồng (Admin)
fastify.get('/contracts/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('add_contract.pug', { employees, user: req.user });
});

// 3. Xử lý thêm hợp đồng
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

// Hiển thị form edit
fastify.get('/contracts/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const contract = await fastify.mongo.db.collection('contracts').findOne({ _id: new ObjectId(req.params.id) });
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('edit_contract.pug', { contract, employees, user: req.user });
});

// Xử lý lưu dữ liệu
fastify.post('/contracts/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { contractNumber, signDate, contractType, duration, employeeId } = req.body;
  await fastify.mongo.db.collection('contracts').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { contractNumber, signDate, contractType, duration, employeeId: new ObjectId(employeeId) } }
  );
  reply.redirect('/contracts');
});

// 6. Xóa hợp đồng
fastify.get('/contracts/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('contracts').deleteOne({ _id: new ObjectId(req.params.id) });
  reply.redirect('/contracts');
});

// ================= QUẢN LÝ CHẤM CÔNG =================
// 1. Xem danh sách chấm công
fastify.get('/attendance', { preHandler: [auth] }, async (req, reply) => {
  const attendance = await fastify.mongo.db.collection('attendance').find().toArray();
  return reply.view('attendance.pug', { attendance, user: req.user });
});
// 2. Form thêm chấm công (Admin)
fastify.get('/attendance/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('add_attendance.pug', { employees, user: req.user });
});
// 3. Xử lý thêm chấm công
fastify.post('/attendance/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { employeeId, date, status, overtime } = req.body;
  await fastify.mongo.db.collection('attendance').insertOne({
    employeeId: new ObjectId(employeeId),
    date: new Date(date),
    status,
    overtime: Boolean(overtime),
    createdAt: new Date()
  });
  reply.redirect('/attendance');
});
// 4. Hiển thị form edit
fastify.get('/attendance/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const attendance = await fastify.mongo.db.collection('attendance').findOne({ _id: new ObjectId(req.params.id) });
  const employees = await fastify.mongo.db.collection('employees').find().toArray();
  return reply.view('edit_attendance.pug', { attendance, employees, user: req.user });
});
// 5. Xóa chấm công
fastify.get('/attendance/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('attendance').deleteOne({ _id: new ObjectId(req.params.id) });
  reply.redirect('/attendance');
});

// 6. Xử lý lưu dữ liệu
fastify.post('/attendance/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { employeeId, date, status } = req.body;
  await fastify.mongo.db.collection('attendance').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { employeeId: new ObjectId(employeeId), date, status } }
  );
  reply.redirect('/attendance');
});


// ================= CHẠY SERVER =================

fastify.listen({ port: 3000 }, err => {
  if (err) throw err
  console.log('Server đang chạy tại http://localhost:3000')
})