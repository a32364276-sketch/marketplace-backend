require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt'); // added for password hashing

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test DB connection route
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      success: true,
      serverTime: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Basic homepage
app.get('/', (req, res) => {
  res.send('Marketplace backend running');
});

// Setup all tables route (run once)
app.get('/setup-tables', async (req, res) => {
  try {
    // 1️⃣ Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        password VARCHAR(255),
        role VARCHAR(20) NOT NULL, -- 'admin' or 'merchant'
        nzbn VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 2️⃣ Customers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        oauth_provider VARCHAR(20),
        oauth_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 3️⃣ Deals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        commission_percentage NUMERIC(5,2) DEFAULT 25,
        merchant_id INT NOT NULL,
        image_url TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (merchant_id) REFERENCES users(id)
      )
    `);

    // 4️⃣ Orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INT NOT NULL,
        deal_id INT NOT NULL,
        total_price NUMERIC(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (deal_id) REFERENCES deals(id)
      )
    `);

    // 5️⃣ Vouchers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        order_id INT NOT NULL,
        deal_id INT NOT NULL,
        redeemed BOOLEAN DEFAULT FALSE,
        redeemed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (deal_id) REFERENCES deals(id)
      )
    `);

    // 6️⃣ Categories table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    res.send('All tables created successfully ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// 🔐 Admin login route
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2',
      [email, 'admin']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const admin = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, admin.password);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Successfully logged in
    res.json({
      success: true,
      message: 'Admin logged in successfully',
      admin: { id: admin.id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add a new deal (admin only)
app.post('/admin/add-deal', async (req, res) => {
  const { title, description, price, commission_percentage, merchant_id, image_url } = req.body;

  if (!title || !price || !merchant_id) {
    return res.status(400).json({ success: false, message: 'Title, price, and merchant_id are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO deals 
        (title, description, price, commission_percentage, merchant_id, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description || '', price, commission_percentage || 25, merchant_id, image_url || '']
    );

    res.json({
      success: true,
      message: 'Deal added successfully',
      deal: result.rows[0]
    });
  } catch (err) {
    console.error('Add deal error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// Listen on port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));