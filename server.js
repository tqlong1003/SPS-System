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


// ================= ROUTES HỆ THỐNG =================

// Trang gốc → chuyển về login
fastify.get('/', async (req, reply) => {  
  reply.redirect('/login')
})


// ================= ĐĂNG KÝ (Chuyển thành Admin tạo tài khoản) =================

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

  reply.redirect('/employees'); 
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

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return reply.view('login.pug', { error: 'Mật khẩu không chính xác' });
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
fastify.get('/dashboard', { preHandler: [auth] }, async (req, reply) => {
  return reply.view('dashboard.pug', { user: req.user })
})


// ================= QUẢN LÝ NHÂN VIÊN =================
fastify.get('/employees', { preHandler: [auth] }, async (req, reply) => {
  const employees = await fastify.mongo.db.collection('employees').find().toArray()
  return reply.view('employees.pug', { employees, user: req.user })
})

fastify.get('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  return reply.view('add.pug', { user: req.user })
})

fastify.post('/employees/add', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('employees').insertOne(req.body)
  reply.redirect('/employees')
})

fastify.get('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.id) })
  return reply.view('edit.pug', { emp, user: req.user })
})

fastify.post('/employees/edit/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('employees').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body }
  )
  reply.redirect('/employees')
})

fastify.get('/employees/delete/:id', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  await fastify.mongo.db.collection('employees').deleteOne({ _id: new ObjectId(req.params.id) })
  reply.redirect('/employees')
})


// ================= QUẢN LÝ PHÒNG BAN =================
fastify.get('/departments', { preHandler: [auth] }, async (req, reply) => {
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
fastify.get('/positions', { preHandler: [auth] }, async (req, reply) => {
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

// ================= HỆ THỐNG LƯƠNG =================
fastify.get('/salary', { preHandler: [auth] }, async (req, reply) => { 
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  let salaries
  let employees = []

  if (req.user.role === 'admin') {
    salaries = await fastify.mongo.db.collection('salaries').find({ month: month }).toArray()
    employees = await fastify.mongo.db.collection('employees').find().toArray()
  } else {
    salaries = await fastify.mongo.db.collection('salaries')
      .find({ userId: new ObjectId(req.user.id) })
      .sort({ month: -1 })
      .toArray()
  }

  return reply.view('salary_list.pug', {
    salaries,
    employees,
    currentMonth: month,
    user: req.user
  })
})

fastify.get('/salary/manage/:empId', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.empId) });
  return reply.view('salary_manage.pug', { emp, user: req.user });
});

fastify.post('/salary/manage/:empId', { preHandler: [auth, isAdmin] }, async (req, reply) => {
  const { month, baseSalary, bonus, allowance, advance, raise } = req.body 
  const totalEarned = parseFloat(baseSalary) + parseFloat(bonus) + parseFloat(allowance) + parseFloat(raise) 
  const finalSalary = totalEarned - parseFloat(advance)

  const emp = await fastify.mongo.db.collection('employees').findOne({ _id: new ObjectId(req.params.empId) })

  await fastify.mongo.db.collection('salaries').updateOne(
    { userId: emp.userId, month: month }, 
    {
      $set: { 
        employeeName: emp.name, 
        baseSalary: parseFloat(baseSalary), 
        bonus: parseFloat(bonus), 
        allowance: parseFloat(allowance), 
        advance: parseFloat(advance), 
        raise: parseFloat(raise), 
        finalSalary: finalSalary, 
        employeeId: emp._id 
      }
    },
    { upsert: true }  
  )
  reply.redirect('/salary') 
})


// ================= QUẢN LÝ HỢP ĐỒNG =================
fastify.get('/contracts', { preHandler: [auth] }, async (req, reply) => {
  const contracts = await fastify.mongo.db.collection('contracts').find().toArray();
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