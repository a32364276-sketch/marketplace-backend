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

// Get all deals (admin)
app.get('/admin/deals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, description, price, commission_percentage, merchant_id, image_url, active, created_at
      FROM deals
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      deals: result.rows
    });
  } catch (err) {
    console.error('Get deals error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Listen on port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));